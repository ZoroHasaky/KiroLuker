import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { retireLegacyKeyGateway } from '../src/main/legacyKeyGateway.ts'
import { restoreLegacyGatewayEndpoints } from '../src/main/kiroSettings.ts'

const KRS = 'codewhisperer.config.krsEndpoints'
const CPS = 'codewhisperer.config.cpsEndpoints'
const ports = { krs: 19830, cps: 19831 }
const entry = (endpoint, region = 'us-east-1') => ({ region, endpoint })
const originalEndpoints = {
  krs: [entry('https://runtime.example'), entry('https://eu.example', 'eu-west-1')],
  cps: [entry('https://management.example')]
}

async function withSettings(run) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kiroluker-retired-gateway-'))
  const file = path.join(root, 'settings.json')
  try {
    await run(file)
  } finally {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()))
    assert.ok(path.basename(root).startsWith('kiroluker-retired-gateway-'))
    await fs.rm(root, { recursive: true, force: true })
  }
}

function repository(file, overrides = {}) {
  let data = {
    version: 1,
    keys: [{ id: 'saved-key', key: 'ksk_test_only', region: 'us-east-1', createdAt: 1 }],
    enabled: true,
    activeKeyId: 'saved-key',
    region: 'us-east-1',
    ports,
    originalEndpoints,
    settingsPath: file,
    ...overrides
  }
  let restores = 0
  return {
    load: () => structuredClone(data),
    save: (next) => { data = structuredClone(next) },
    restore: async (snapshot) => {
      restores++
      return restoreLegacyGatewayEndpoints(snapshot.originalEndpoints, snapshot.ports, snapshot.settingsPath)
    },
    get restores() { return restores }
  }
}

test('旧网关退役还原真实设置文件，保留 Key 和其它设置，重复运行不再写入', async () => {
  await withSettings(async (file) => {
    const raw = `{
      // 用户原有注释与无关设置需要在首次备份里保留
      "editor.fontSize": 16,
      "${KRS}": [{"region":"us-east-1","endpoint":"http://127.0.0.1:19830"}],
      "${CPS}": [{"region":"us-east-1","endpoint":"http://localhost:19831/"}],
    }`
    await fs.writeFile(file, raw)
    const repo = repository(file)
    const keys = repo.load().keys
    assert.equal(await retireLegacyKeyGateway(repo), true)
    assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), {
      'editor.fontSize': 16,
      [KRS]: originalEndpoints.krs,
      [CPS]: originalEndpoints.cps
    })
    assert.equal(await fs.readFile(file + '.kiroluker.bak', 'utf8'), raw)
    assert.deepEqual(repo.load().keys, keys)
    assert.equal(repo.load().enabled, false)
    assert.equal(repo.load().activeKeyId, null)
    assert.equal(repo.load().originalEndpoints, undefined)
    assert.equal(repo.load().settingsPath, undefined)
    const after = await fs.readFile(file, 'utf8')
    assert.equal(await retireLegacyKeyGateway(repo), false)
    assert.equal(repo.restores, 1)
    assert.equal(await fs.readFile(file, 'utf8'), after)
  })
})

test('从未启用网关时不访问 IDE 配置，也不删除历史 Key', async () => {
  const repo = repository(undefined, { enabled: false, activeKeyId: null, originalEndpoints: undefined })
  const before = repo.load()
  assert.equal(await retireLegacyKeyGateway(repo), false)
  assert.equal(repo.restores, 0)
  assert.deepEqual(repo.load(), before)
})

test('端点已被其它工具修改时原样保留，不用旧快照覆盖', async () => {
  await withSettings(async (file) => {
    const raw = JSON.stringify({
      [KRS]: [entry('http://127.0.0.1:9999')],
      [CPS]: [entry('https://custom.example')],
      'custom.setting': ['keep']
    })
    await fs.writeFile(file, raw)
    await retireLegacyKeyGateway(repository(file))
    assert.equal(await fs.readFile(file, 'utf8'), raw)
    await assert.rejects(fs.access(file + '.kiroluker.bak'), { code: 'ENOENT' })
  })
})

test('部分接管残留只替换本应用端点，保留同区域的新配置和其它区域', async () => {
  await withSettings(async (file) => {
    const retained = [entry('https://new.example'), entry('http://127.0.0.1:9999', 'eu-west-1')]
    await fs.writeFile(file, JSON.stringify({
      [KRS]: [entry('http://127.0.0.1:19830'), ...retained],
      [CPS]: [entry('http://[::1]:19831'), entry('https://asia.example', 'ap-northeast-1')]
    }))
    await retireLegacyKeyGateway(repository(file))
    const next = JSON.parse(await fs.readFile(file, 'utf8'))
    assert.deepEqual(next[KRS], retained)
    assert.deepEqual(next[CPS], [entry('https://asia.example', 'ap-northeast-1'), ...originalEndpoints.cps])
  })
})

test('没有恢复快照时仅移除已记录端口，不恢复仍指向已退役端口的旧快照', async () => {
  await withSettings(async (file) => {
    await fs.writeFile(file, JSON.stringify({
      [KRS]: [entry('http://127.0.0.1:19830')],
      [CPS]: [entry('http://127.0.0.1:19831')],
      keep: true
    }))
    await retireLegacyKeyGateway(repository(file, {
      originalEndpoints: { krs: [entry('http://127.0.0.1:19830')], cps: [] }
    }))
    assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), { [KRS]: [], [CPS]: [], keep: true })
    await fs.writeFile(file, JSON.stringify({ [KRS]: [entry('http://127.0.0.1:19830')] }))
    await retireLegacyKeyGateway(repository(file, { originalEndpoints: undefined }))
    assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), { [KRS]: [] })
  })
})

test('解析失败不覆盖用户文件，并保留停用后的恢复信息供下次重试', async () => {
  await withSettings(async (file) => {
    const raw = '{ "editor.fontSize": 16, broken json }'
    await fs.writeFile(file, raw)
    const repo = repository(file)
    const keys = repo.load().keys
    await assert.rejects(retireLegacyKeyGateway(repo), SyntaxError)
    assert.equal(await fs.readFile(file, 'utf8'), raw)
    assert.equal(repo.load().enabled, false)
    assert.deepEqual(repo.load().originalEndpoints, originalEndpoints)
    assert.equal(repo.load().settingsPath, file)
    assert.deepEqual(repo.load().keys, keys)
    await fs.writeFile(file, JSON.stringify({ [KRS]: [entry('http://127.0.0.1:19830')] }))
    assert.equal(await retireLegacyKeyGateway(repo), true)
    assert.equal(repo.load().originalEndpoints, undefined)
  })
})

test('非对象设置文件不被覆盖；丢失的配置文件不被重新创建', async () => {
  await withSettings(async (file) => {
    for (const raw of ['null', '[]', '42']) {
      await fs.writeFile(file, raw)
      await assert.rejects(retireLegacyKeyGateway(repository(file)), /JSON 对象/)
      assert.equal(await fs.readFile(file, 'utf8'), raw)
    }
    const missing = path.join(path.dirname(file), 'missing', 'settings.json')
    await retireLegacyKeyGateway(repository(missing))
    await assert.rejects(fs.access(missing), { code: 'ENOENT' })
  })
})

test('相似域名、其它路径及不同端口不算本应用端点', async () => {
  await withSettings(async (file) => {
    const raw = JSON.stringify({ [KRS]: [
      entry('http://127.0.0.1.example:19830'),
      entry('http://127.0.0.1:19830/custom'),
      entry('http://127.0.0.1:19830/?different=service'),
      entry('http://127.0.0.1:19832')
    ] })
    await fs.writeFile(file, raw)
    await retireLegacyKeyGateway(repository(file))
    assert.equal(await fs.readFile(file, 'utf8'), raw)
  })
})
