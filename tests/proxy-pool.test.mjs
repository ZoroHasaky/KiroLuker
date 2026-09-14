// 提链代理池：纯逻辑（端点解析、去重决策）与注入式获取流程（经可信代理拉池、
// 重复重试、历史落盘、串行化）的单元测试。
// 模块依赖 electron-store（要求 Electron 运行时）与 undici，全部经沙箱注入假实现。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import vm from 'node:vm'
import { isIP } from 'node:net'
import ts from 'typescript'

const source = ts.transpileModule(
  await fs.readFile(new URL('../src/main/proxyPool.ts', import.meta.url), 'utf8'),
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }
).outputText

/** 与 src/main/net.ts 的 normalizeProxyUrl 同语义的替身：裸 host:port → http://host:port */
function fakeNormalizeProxyUrl(url) {
  const trimmed = (url || '').trim()
  if (!trimmed) return ''
  if (/^[a-z][a-z0-9+\-.]*:\/\//i.test(trimmed)) return trimmed
  const m = trimmed.match(/^([a-z][a-z0-9+\-.]*):(\/*)(.+)$/i)
  if (m) return `${m[1]}://${m[3]}`
  return `http://${trimmed}`
}

class FakeProxyAgent {
  constructor(uri) {
    this.uri = uri
    this.closed = false
    this.constructor.created.push(this)
  }
  async close() {
    this.closed = true
  }
}
FakeProxyAgent.created = []

function fakeResponse(statusCode, chunks) {
  return {
    statusCode,
    body: (async function* () {
      for (const chunk of chunks) yield Buffer.from(chunk)
    })()
  }
}

class FakeStore {
  constructor(options) {
    this.options = options
    this.data = { ...(options.defaults || {}) }
    FakeStore.instances.push(this)
  }
  get(key) {
    return this.data[key]
  }
  set(key, value) {
    this.data[key] = structuredClone(value)
  }
}
FakeStore.instances = []

function loadProxyPool(requestImpl) {
  const logs = []
  const exports = {}
  vm.runInNewContext(source, {
    exports,
    Buffer,
    AbortController,
    setTimeout,
    clearTimeout,
    console: Object.fromEntries(['log', 'debug', 'info', 'warn', 'error'].map((level) => [
      level,
      (...args) => logs.push(`${level}: ${args.join(' ')}`)
    ])),
    require(id) {
      if (id === 'node:net') return { isIP }
      if (id === 'undici') return { ProxyAgent: FakeProxyAgent, request: requestImpl }
      if (id === 'electron-store') return { __esModule: true, default: FakeStore }
      if (id === './net') return { normalizeProxyUrl: fakeNormalizeProxyUrl }
      throw new Error(`Unexpected real dependency: ${id}`)
    }
  }, { filename: 'proxyPool.ts' })
  return { pool: exports, logs }
}

function enabledSettings(overrides = {}) {
  return {
    proxyPoolEnabled: true,
    proxyPoolApiUrl: 'https://pool.example/api?num=1',
    proxyPoolApiProxy: '127.0.0.1:7899',
    proxyPoolHistorySize: 10,
    ...overrides
  }
}

// ============ parsePoolEndpoint ============

test('parsePoolEndpoint accepts exactly one ipv4 or ipv6 endpoint', () => {
  const { pool } = loadProxyPool(async () => fakeResponse(200, ['unused']))
  const ipv4 = pool.parsePoolEndpoint('107.150.11.23:23402')
  assert.equal(ipv4.host, '107.150.11.23')
  assert.equal(ipv4.port, 23402)
  const ipv6 = pool.parsePoolEndpoint('  [2001:db8::1]:8080\n')
  assert.equal(ipv6.host, '2001:db8::1')
  assert.equal(ipv6.port, 8080)
})

test('parsePoolEndpoint rejects error pages, multi-line results and bad ports', () => {
  const { pool } = loadProxyPool(async () => fakeResponse(200, ['unused']))
  const bad = [
    '',
    'ok',
    '<html>quota exceeded</html>',
    '1.2.3.4:80\n5.6.7.8:90',
    '1.2.3.4',
    '1.2.3.4:0',
    '1.2.3.4:70000',
    '1.2.3.4:80:90',
    '256.1.1.1:80',
    'example.com:80'
  ]
  for (const value of bad) assert.throws(() => pool.parsePoolEndpoint(value), { message: 'invalid endpoint' })
})

// ============ acceptPoolEndpoint ============

test('acceptPoolEndpoint dedups against recent history and trims to the window size', () => {
  const { pool } = loadProxyPool(async () => fakeResponse(200, ['unused']))
  const endpoint = { host: '1.2.3.4', port: 80 }

  const accepted = pool.acceptPoolEndpoint(['5.6.7.8:90'], endpoint, 3)
  assert.equal(accepted.key, '1.2.3.4:80')
  assert.deepEqual([...accepted.history], ['1.2.3.4:80', '5.6.7.8:90'])

  // 新端点排最前，超出窗口的旧条目被裁掉
  const grown = pool.acceptPoolEndpoint(['a:1', 'b:2', 'c:3'], endpoint, 3)
  assert.deepEqual([...grown.history], ['1.2.3.4:80', 'a:1', 'b:2'])

  assert.equal(pool.acceptPoolEndpoint(['1.2.3.4:80'], endpoint, 3), null)
  // ipv6 端点的键带方括号，与代理 URL 的 host 表示一致
  assert.equal(pool.acceptPoolEndpoint(['[::1]:80'], { host: '::1', port: 80 }, 3), null)
})

// ============ setProxyPoolConfig ============

test('setProxyPoolConfig enables only with an api url and normalizes the trusted proxy', () => {
  const { pool } = loadProxyPool(async () => fakeResponse(200, ['unused']))
  pool.setProxyPoolConfig(enabledSettings())
  assert.equal(pool.isProxyPoolEnabled(), true)

  pool.setProxyPoolConfig(enabledSettings({ proxyPoolEnabled: true, proxyPoolApiUrl: '  ' }))
  assert.equal(pool.isProxyPoolEnabled(), false)

  pool.setProxyPoolConfig(enabledSettings({ proxyPoolEnabled: false }))
  assert.equal(pool.isProxyPoolEnabled(), false)
})

test('acquirePoolProxy keeps only the last N endpoints in the store', async () => {
  const bodies = ['1.1.1.1:1', '2.2.2.2:2', '3.3.3.3:3']
  const { pool } = loadProxyPool(async () => fakeResponse(200, [bodies.shift()]))
  pool.setProxyPoolConfig(enabledSettings({ proxyPoolHistorySize: 2 }))
  await pool.acquirePoolProxy()
  await pool.acquirePoolProxy()
  await pool.acquirePoolProxy()
  const store = FakeStore.instances.at(-1)
  assert.deepEqual(store.get('history'), ['3.3.3.3:3', '2.2.2.2:2'])
})

// ============ acquirePoolProxy 完整流程 ============

test('acquirePoolProxy fetches through the trusted proxy and persists the endpoint', async () => {
  const calls = []
  FakeProxyAgent.created.length = 0
  const { pool } = loadProxyPool(async (url, init) => {
    calls.push({ url, dispatcher: init?.dispatcher })
    return fakeResponse(200, ['107.150.11.23:23402'])
  })
  pool.setProxyPoolConfig(enabledSettings({ proxyPoolApiProxy: '127.0.0.1:7899' }))

  const route = await pool.acquirePoolProxy()
  assert.equal(route.proxyUrl, 'http://107.150.11.23:23402')
  assert.equal(route.viaUrl, 'http://127.0.0.1:7899')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, 'https://pool.example/api?num=1')
  // 池接口请求必须经可信代理发出（一次性 agent，不进全局缓存）
  assert.equal(calls[0].dispatcher, FakeProxyAgent.created[0])
  assert.equal(FakeProxyAgent.created[0].uri, 'http://127.0.0.1:7899')
  assert.equal(FakeProxyAgent.created[0].closed, true)
  const store = FakeStore.instances.at(-1)
  assert.deepEqual(store.get('history'), ['107.150.11.23:23402'])
})

test('acquirePoolProxy retries duplicate endpoints and records both distinct IPs', async () => {
  const bodies = ['1.1.1.1:10', '1.1.1.1:10', '2.2.2.2:20']
  const { pool, logs } = loadProxyPool(async () => fakeResponse(200, [bodies.shift()]))
  pool.setProxyPoolConfig(enabledSettings())

  assert.equal((await pool.acquirePoolProxy()).proxyUrl, 'http://1.1.1.1:10')
  assert.equal((await pool.acquirePoolProxy()).proxyUrl, 'http://2.2.2.2:20')
  const store = FakeStore.instances.at(-1)
  assert.deepEqual(store.get('history'), ['2.2.2.2:20', '1.1.1.1:10'])
  assert.ok(logs.some((line) => line.includes('最近用过的 IP')))
})

test('acquirePoolProxy fails loudly when the pool keeps returning recent IPs', async () => {
  const { pool } = loadProxyPool(async () => fakeResponse(200, ['9.9.9.9:99']))
  pool.setProxyPoolConfig(enabledSettings())
  // 第一次入历史，之后每次取到的都是它 → 重试耗尽后明确报错
  await pool.acquirePoolProxy()
  await assert.rejects(pool.acquirePoolProxy(), /连续 5 次返回最近用过的 IP/)
})

test('acquirePoolProxy maps pool transport failures to generic errors without leaking details', async () => {
  const scenarios = [
    { impl: async () => fakeResponse(403, ['forbidden']) },
    { impl: async () => fakeResponse(200, ['garbage']) },
    { impl: async () => fakeResponse(200, [Buffer.alloc(8192, 0x61)]) },
    { impl: async () => { throw new Error('ECONNREFUSED proxy down') } }
  ]
  for (const { impl } of scenarios) {
    const { pool, logs } = loadProxyPool(impl)
    pool.setProxyPoolConfig(enabledSettings({ proxyPoolApiProxy: '127.0.0.1:7899' }))
    await assert.rejects(pool.acquirePoolProxy(), { message: '无法经可信代理访问代理池接口' })
    // 细节只进 console，不进异常
    assert.ok(logs.some((line) => line.startsWith('warn: ')))
  }
})

test('acquirePoolProxy reports direct access when no trusted proxy is configured', async () => {
  const { pool } = loadProxyPool(async () => fakeResponse(500, ['boom']))
  pool.setProxyPoolConfig(enabledSettings({ proxyPoolApiProxy: '' }))
  await assert.rejects(pool.acquirePoolProxy(), { message: '无法访问代理池接口' })
})

test('acquirePoolProxy rejects before any request when the pool is disabled', async () => {
  let requested = 0
  const { pool } = loadProxyPool(async () => {
    requested++
    return fakeResponse(200, ['1.1.1.1:1'])
  })
  pool.setProxyPoolConfig(enabledSettings({ proxyPoolEnabled: false }))
  await assert.rejects(pool.acquirePoolProxy(), { message: '代理池未启用' })
  assert.equal(requested, 0)
})

test('acquirePoolProxy serializes concurrent acquisitions', async () => {
  let active = 0
  let maxActive = 0
  let n = 0
  const { pool } = loadProxyPool(async () => {
    active++
    maxActive = Math.max(maxActive, active)
    await new Promise((resolve) => setTimeout(resolve, 20))
    active--
    return fakeResponse(200, [`10.0.0.${++n}:1000`])
  })
  pool.setProxyPoolConfig(enabledSettings({ proxyPoolHistorySize: 5 }))

  await Promise.all([pool.acquirePoolProxy(), pool.acquirePoolProxy()])
  assert.equal(maxActive, 1, '并发获取必须串行执行')
})
