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

function loadProxyPool(requestImpl, opts = {}) {
  const logs = []
  const probeCalls = []
  // 假出口探测：默认返回固定 IP，可用 opts.probe 定制（返回 ipify 风格响应或抛错）
  const probeImpl = opts.probe ?? (async (url, init) => {
    probeCalls.push(String(init?.proxyUrl))
    return { status: 200, text: async () => '203.0.113.7' }
  })
  // 假计次库：默认全部计 0，可用 opts.usageCounts（Map）定制
  const usageCounts = opts.usageCounts ?? new Map()
  const exports = {}
  vm.runInNewContext(source, {
    exports,
    Buffer,
    URL,
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
      if (id === './net') return { normalizeProxyUrl: fakeNormalizeProxyUrl, httpRequest: probeImpl }
      if (id === './poolUsageStore') {
        return { MAX_USES_PER_IP: 2, countRecentUsage: (ip) => usageCounts.get(ip) ?? 0 }
      }
      throw new Error(`Unexpected real dependency: ${id}`)
    }
  }, { filename: 'proxyPool.ts' })
  return { pool: exports, logs, probeCalls }
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

test('parsePoolEndpoints accepts CRLF-separated endpoints and rejects any bad line', () => {
  const { pool } = loadProxyPool(async () => fakeResponse(200, ['unused']))
  const list = pool.parsePoolEndpoints('1.2.3.4:80\r\n[2001:db8::1]:90\r\n')
  assert.deepEqual(
    [...list.map((item) => `${item.host}:${item.port}`)],
    ['1.2.3.4:80', '2001:db8::1:90']
  )
  assert.throws(() => pool.parsePoolEndpoints('1.2.3.4:80\r\ngarbage'), { message: 'invalid endpoint' })
  assert.throws(() => pool.parsePoolEndpoints(''), { message: 'invalid endpoint' })
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
  // 批量提取会重写 num 参数（默认 5）；传给 request 的是 URL 对象
  assert.equal(String(calls[0].url), 'https://pool.example/api?num=5')
  // 池接口请求必须经可信代理发出（一次性 agent，不进全局缓存）
  assert.equal(calls[0].dispatcher, FakeProxyAgent.created[0])
  assert.equal(FakeProxyAgent.created[0].uri, 'http://127.0.0.1:7899')
  assert.equal(FakeProxyAgent.created[0].closed, true)
  const store = FakeStore.instances.at(-1)
  assert.deepEqual(store.get('history'), ['107.150.11.23:23402'])
})

test('one batch acquisition serves multiple link requests without refetching', async () => {
  let fetched = 0
  const { pool } = loadProxyPool(async () => {
    fetched++
    return fakeResponse(200, ['1.1.1.1:10\r\n2.2.2.2:20\r\n3.3.3.3:30'])
  })
  pool.setProxyPoolConfig(enabledSettings())
  assert.equal((await pool.acquirePoolProxy()).proxyUrl, 'http://1.1.1.1:10')
  assert.equal((await pool.acquirePoolProxy()).proxyUrl, 'http://2.2.2.2:20')
  assert.equal((await pool.acquirePoolProxy()).proxyUrl, 'http://3.3.3.3:30')
  assert.equal(fetched, 1, '一批端点应被逐链接消费，不该每条都打池接口')
})

test('queued endpoints expire after the time window', async () => {
  let fetched = 0
  const { pool } = loadProxyPool(async () => {
    fetched++
    return fakeResponse(200, ['1.1.1.1:10\r\n2.2.2.2:20'])
  })
  // time=0.05 分钟 → TTL 落到 1 秒下限
  pool.setProxyPoolConfig(enabledSettings({ proxyPoolApiUrl: 'https://pool.example/api?time=0.05' }))
  await pool.acquirePoolProxy()
  assert.equal(fetched, 1)
  await new Promise((resolve) => setTimeout(resolve, 1_200))
  await pool.acquirePoolProxy()
  assert.equal(fetched, 2, '队列里的端点过期后应重新批量提取')
})

test('acquirePoolProxy retries duplicate endpoints and records both distinct IPs', async () => {
  const bodies = ['1.1.1.1:10', '1.1.1.1:10', '2.2.2.2:20']
  const { pool, logs } = loadProxyPool(async () => fakeResponse(200, [bodies.shift()]))
  pool.setProxyPoolConfig(enabledSettings())

  assert.equal((await pool.acquirePoolProxy()).proxyUrl, 'http://1.1.1.1:10')
  assert.equal((await pool.acquirePoolProxy()).proxyUrl, 'http://2.2.2.2:20')
  const store = FakeStore.instances.at(-1)
  assert.deepEqual(store.get('history'), ['2.2.2.2:20', '1.1.1.1:10'])
  assert.ok(logs.some((line) => line.includes('全部不可用')))
})

test('duplicate-only batches fail instead of reusing a recent IP', async () => {
  const { pool, logs } = loadProxyPool(async () => fakeResponse(200, ['9.9.9.9:99']))
  pool.setProxyPoolConfig(enabledSettings())
  await pool.acquirePoolProxy()
  // 会话粘滞时池只会重复给同一个 IP：宁可失败也不复用（同一出口连续提链会被 Kiro 403）
  await assert.rejects(pool.acquirePoolProxy(), /未能提供未用过的 IP/)
  assert.ok(logs.some((line) => line.includes('全部不可用')))
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

test('探测失败的端点（如会话过期）被跳过并换下一个', async () => {
  const { pool, logs } = loadProxyPool(async () => fakeResponse(200, ['1.1.1.1:10\r\n2.2.2.2:20']), {
    probe: async (_url, init) => {
      if (String(init?.proxyUrl).includes('1.1.1.1')) throw new Error('fetch failed：代理池出口无法连接目标')
      return { status: 200, text: async () => '198.51.100.2' }
    }
  })
  pool.setProxyPoolConfig(enabledSettings())
  const route = await pool.acquirePoolProxy()
  assert.equal(route.proxyUrl, 'http://2.2.2.2:20')
  assert.equal(route.exitIp, '198.51.100.2')
  assert.ok(logs.some((line) => line.includes('出口探测失败')))
})

// ============ 出口 IP 计次（同 IP 24h 内最多提链 2 次） ============

test('acquirePoolProxy 探测真实出口并随路由返回', async () => {
  const { pool, probeCalls } = loadProxyPool(async () => fakeResponse(200, ['1.1.1.1:10']))
  pool.setProxyPoolConfig(enabledSettings())
  const route = await pool.acquirePoolProxy()
  assert.equal(route.exitIp, '203.0.113.7')
  assert.deepEqual(probeCalls, ['http://1.1.1.1:10'], '探测必须经池端点发出')
})

test('出口 24 小时内用满的端点被弃用并自动换下一个', async () => {
  const exits = ['198.51.100.1', '198.51.100.2']
  const usageCounts = new Map([['198.51.100.1', 2]])
  const { pool, logs } = loadProxyPool(
    async () => fakeResponse(200, ['1.1.1.1:10\r\n2.2.2.2:20']),
    { usageCounts, probe: async (_url, init) => ({ status: 200, text: async () => exits.shift() }) }
  )
  pool.setProxyPoolConfig(enabledSettings())
  const route = await pool.acquirePoolProxy()
  assert.equal(route.proxyUrl, 'http://2.2.2.2:20')
  assert.equal(route.exitIp, '198.51.100.2')
  assert.ok(logs.some((line) => line.includes('已提链 2 次')))
})

test('全部出口用满时明确报错并列出出口', async () => {
  const usageCounts = new Map([['203.0.113.7', 2]])
  const { pool } = loadProxyPool(async () => fakeResponse(200, ['1.1.1.1:10']), { usageCounts })
  pool.setProxyPoolConfig(enabledSettings())
  await assert.rejects(pool.acquirePoolProxy(), /24 小时内未超额的出口 IP.*203\.0\.113\.7/)
})

test('出口探测失败时获取失败', async () => {
  const { pool } = loadProxyPool(async () => fakeResponse(200, ['1.1.1.1:10']), {
    probe: async () => ({ status: 503, text: async () => 'oops' })
  })
  pool.setProxyPoolConfig(enabledSettings())
  await assert.rejects(pool.acquirePoolProxy(), /均无法确认可用出口/)
})

test('同一端点的出口探测结果被缓存，重复遇到不再探测', async () => {
  const probeCounts = new Map()
  const bodies = ['1.1.1.1:10', '1.1.1.1:10\r\n2.2.2.2:20']
  // e1 的出口用满：第一批只有它（弃用、不入端点历史），第二批又给出它 → 应命中缓存
  const usageCounts = new Map([['198.51.100.9', 2]])
  const { pool } = loadProxyPool(async () => fakeResponse(200, [bodies.shift()]), {
    usageCounts,
    probe: async (_url, init) => {
      const proxy = String(init?.proxyUrl)
      probeCounts.set(proxy, (probeCounts.get(proxy) ?? 0) + 1)
      return { status: 200, text: async () => (proxy.includes('1.1.1.1') ? '198.51.100.9' : '198.51.100.10') }
    }
  })
  pool.setProxyPoolConfig(enabledSettings({ proxyPoolHistorySize: 5 }))
  const route = await pool.acquirePoolProxy()
  assert.equal(route.exitIp, '198.51.100.10')
  assert.equal(probeCounts.get('http://1.1.1.1:10'), 1, '同一端点会话期内只允许探测一次')
})
