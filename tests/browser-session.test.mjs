import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import vm from 'node:vm'
import { EventEmitter } from 'node:events'
import { isIP } from 'node:net'
import { randomUUID, randomBytes } from 'node:crypto'
import ts from 'typescript'

const sources = new Map(await Promise.all([
  ['browserSession', '../src/main/browserSession.ts'],
  ['browserPolicy', '../src/main/browserPolicy.ts'],
  ['portalLocale', '../src/shared/portalLocale.ts']
].map(async ([name, path]) => {
  const source = await fs.readFile(new URL(path, import.meta.url), 'utf8')
  return [name, ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText]
})))
const forbidden = () => { throw new Error('Real network, Electron, accounts and default sessions are forbidden') }
function load(name, imports, globals = {}) {
  const exports = {}
  vm.runInNewContext(sources.get(name), {
    exports, URL, Buffer, AbortController, Uint8Array, fetch: forbidden,
    require(id) {
      assert.ok(Object.hasOwn(imports, id), `Unexpected real dependency: ${id}`)
      return imports[id]
    }, ...globals
  }, { filename: `${name}.ts` })
  return exports
}
const locale = load('portalLocale', {})
const plain = (value) => structuredClone(value)
function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
async function until(predicate, description = 'expected fake operation to start') {
  for (let turn = 0; turn < 100 && !predicate(); turn++) await Promise.resolve()
  assert.ok(predicate(), description)
}

class Clock {
  now = 1_788_768_000_000
  active = new Map()
  history = []
  setTimeout = (callback, milliseconds) => {
    const timer = { callback, milliseconds, due: this.now + milliseconds }
    this.active.set(timer, timer)
    this.history.push(timer)
    return timer
  }
  clearTimeout = (timer) => { this.active.delete(timer) }
  advance(milliseconds) {
    this.now += milliseconds
    for (const [timer, value] of this.active) {
      if (value.due <= this.now) { this.active.delete(timer); value.callback() }
    }
  }
}

function traceResponse(chunks = ['ip=203.0.113.7\nloc=CN\n'], options = {}) {
  const values = chunks.map((value) => Buffer.isBuffer(value) ? value : Buffer.from(value))
  const state = { reads: 0, cancels: 0, releases: 0, bytes: 0 }
  const reader = {
    async read() {
      const index = state.reads++
      if (options.read) return options.read(index)
      const value = values[index]
      if (!value) return { done: true }
      state.bytes += value.length
      return { done: false, value }
    },
    async cancel() { state.cancels++; return options.cancel?.() },
    releaseLock() { state.releases++ }
  }
  return {
    state, reader,
    response: { ok: options.ok ?? true, status: options.status ?? 200, body: options.noBody ? null : { getReader: () => reader } }
  }
}
function browserConfig({ enabled = true, ...overrides } = {}) {
  return {
    proxy: { enabled, host: 'proxy.fixture.invalid', port: 1080, username: `fixture-${randomBytes(6).toString('hex')}`, password: randomBytes(16).toString('hex') },
    fingerprint: { userAgent: '', language: 'zh-CN', timezone: '', width: 1280, height: 900 },
    ...overrides
  }
}

function harness(hooks = {}) {
  const clock = new Clock()
  const events = []
  const partitions = []
  const sessions = []
  const bridges = []
  const configureCalls = []
  const responses = []
  const FakeDate = class extends Date { static now() { return clock.now } }
  const policy = load('browserPolicy', { 'node:net': { isIP } }, { Date: FakeDate })
  function step(name, ses, args) {
    events.push({ name, session: ses, args })
    return hooks[name]?.(ses, args)
  }
  class FakeSession extends EventEmitter {
    constructor(partition) {
      super()
      this.partition = partition
      this.proxyCalls = []
      this.fetchCalls = []
      this.cleanupCalls = new Map()
      this.requestHandlers = []
      this.headerHandlers = new Map()
      this.webRequest = {
        onHeadersReceived: (handler) => { this.headerHandlers.set('received', handler) },
        onBeforeSendHeaders: (handler) => { this.headerHandlers.set('sending', handler) },
        onBeforeRequest: (handler) => {
          step('requestGate', this)
          this.requestBlocker = handler
          this.requestHandlers.push(handler)
        }
      }
    }
    setProxy(options) {
      this.proxyCalls.push(plain(options))
      return Promise.resolve(step('setProxy', this, options)).then(() => step('proxyReady', this))
    }
    setSpellCheckerEnabled(value) { step('spellcheck', this, value); this.spellcheck = value }
    setPermissionRequestHandler(handler) { step('permissionRequest', this); this.permissionRequest = handler }
    setPermissionCheckHandler(handler) { step('permissionCheck', this); this.permissionCheck = handler }
    on(name, handler) {
      if (name === 'will-download') step('downloadHandler', this)
      return super.on(name, handler)
    }
    fetch(url, options) {
      this.fetchCalls.push({ url, options, receiver: this })
      // Exercise the installed Electron request hook, not just its registration.
      if (requestDecision(this, url, { resourceType: 'other', webContentsId: 0 }).cancel) {
        return Promise.reject(new Error('Synthetic request blocked by Session gate'))
      }
      const result = step('fetch', this, { url, options })
      if (hooks.fetch) return result
      const fixture = traceResponse()
      responses.push(fixture)
      return Promise.resolve(fixture.response)
    }
    cleanup(name) {
      this.cleanupCalls.set(name, (this.cleanupCalls.get(name) || 0) + 1)
      return Promise.resolve(step(name, this))
    }
    closeAllConnections() { return this.cleanup('closeAllConnections') }
    clearStorageData() { return this.cleanup('clearStorageData') }
    clearCache() { return this.cleanup('clearCache') }
    clearAuthCache() { return this.cleanup('clearAuthCache') }
  }
  async function bridgeFactory(proxy) {
    await step('createBridge', undefined, proxy)
    const bridge = {
      proxyRules: `http://127.0.0.1:${43100 + bridges.length}`,
      closeCalls: 0,
      close() { this.closeCalls++; return Promise.resolve(step('closeBridge', undefined, this)) }
    }
    bridges.push(bridge)
    return bridge
  }
  const electron = {
    session: {
      get defaultSession() { return forbidden() },
      fromPartition(partition, options) {
        const ses = new FakeSession(partition)
        partitions.push({ partition, options: plain(options) })
        sessions.push(ses)
        step('fromPartition', ses, options)
        return ses
      }
    }
  }
  const api = load('browserSession', {
    'node:crypto': { randomUUID }, electron,
    '../shared/portalLocale': locale,
    './kiroPortalSession': { configurePortalSession(ses, options) {
      configureCalls.push({ session: ses, options: plain(options) })
      step('configure', ses, options)
    } },
    './browserProxy': { createBrowserProxyBridge: bridgeFactory },
    './browserPolicy': policy
  }, { Date: FakeDate, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout })
  return { api, clock, events, partitions, sessions, bridges, configureCalls, responses, FakeSession, bridgeFactory }
}
const cleanupNames = ['closeAllConnections', 'clearStorageData', 'clearCache', 'clearAuthCache']
function requestDecision(ses, url, details = {}) {
  assert.equal(typeof ses.requestBlocker, 'function', 'Session request gate must already be installed')
  let result
  let callbacks = 0
  ses.requestBlocker({ url, ...details }, (value) => { callbacks++; result = value })
  assert.equal(callbacks, 1, 'each request receives exactly one decision')
  return plain(result)
}
function assertClean(ses, count = 1) {
  for (const name of cleanupNames) assert.equal(ses.cleanupCalls.get(name), count, name)
  assert.equal(ses.headerHandlers.get('received'), null)
  assert.equal(ses.headerHandlers.get('sending'), null)
  // A non-probe URL was already blocked at startup. Check the formerly allowed
  // probe too, otherwise an unchanged startup handler could look like cleanup.
  for (const url of [ses.fetchCalls[0]?.url || 'https://www.cloudflare.com/cdn-cgi/trace',
    'https://fixture.invalid/', 'http://127.0.0.1:44123/trace', 'about:blank']) {
    assert.deepEqual(requestDecision(ses, url), { cancel: true })
  }
}
function redactedFailure(error, secrets, prefix = '[代理检测]') {
  assert.ok(error.message.startsWith(prefix), error.message)
  assert.match(error.message, /未回退直连/)
  for (const secret of secrets) {
    assert.equal(error.message.includes(secret), false)
    assert.equal(error.stack.includes(secret), false)
  }
  assert.equal(error.cause, undefined)
  return true
}

test('proxy sessions use fixed_servers and <-loopback>; every security setting precedes the same-session probe', async () => {
  const h = harness()
  const config = browserConfig()
  config.fingerprint.userAgent = 'fixture Chrome/134'
  config.fingerprint.language = 'ja-JP'
  const resource = await h.api.createBrowserSession(config)
  const ses = h.sessions[0]
  assert.equal(resource.session, ses)
  assert.deepEqual(h.partitions[0].options, { cache: false })
  assert.match(h.partitions[0].partition, /^browser-web-/)
  assert.equal(h.partitions[0].partition.startsWith('persist:'), false)
  assert.deepEqual(ses.proxyCalls, [{ mode: 'fixed_servers', proxyRules: h.bridges[0].proxyRules, proxyBypassRules: '<-loopback>' }])
  assert.equal(h.events.find((event) => event.name === 'createBridge').args, config.proxy)
  assert.equal(h.configureCalls[0].session, ses)
  assert.deepEqual(h.configureCalls[0].options, { userAgent: config.fingerprint.userAgent, acceptLanguage: locale.acceptLanguageFor('ja-JP') })
  const names = h.events.map((event) => event.name)
  assert.deepEqual(names.slice(0, 3), ['fromPartition', 'spellcheck', 'requestGate'])
  assert.ok(names.indexOf('requestGate') < names.indexOf('createBridge'))
  for (const before of ['requestGate', 'proxyReady', 'configure', 'spellcheck', 'permissionRequest', 'permissionCheck', 'downloadHandler']) {
    assert.ok(names.indexOf(before) < names.indexOf('fetch'), `${before} must precede fetch`)
  }
  assert.equal(ses.spellcheck, false)
  let permission
  ses.permissionRequest({}, 'geolocation', (allowed) => { permission = allowed }, {})
  assert.equal(permission, false)
  assert.equal(ses.permissionCheck({}, 'camera', 'https://fixture.invalid/', {}), false)
  let prevented = false
  ses.emit('will-download', { preventDefault() { prevented = true } })
  assert.equal(prevented, true)
  assert.equal(ses.fetchCalls.length, 1)
  assert.equal(ses.fetchCalls[0].receiver, resource.session)
  assert.equal(ses.fetchCalls[0].url, h.api.BROWSER_IP_CHECK_URL)
  const options = ses.fetchCalls[0].options
  assert.equal(options.credentials, 'omit')
  assert.equal(options.redirect, 'error')
  assert.deepEqual(plain(options.headers), { 'Cache-Control': 'no-store' })
  assert.ok(options.signal instanceof AbortSignal)
  assert.equal(options.signal.aborted, false)
  assert.equal(h.clock.history[0].milliseconds, 20000)
  assert.equal(h.clock.active.size, 0)
  assert.deepEqual(plain(resource.check), { ip: '203.0.113.7', country: 'CN', checkedAt: h.clock.now, latencyMs: 0 })
  await resource.close()
  assertClean(ses)
})

test('setProxy is awaited before fingerprint setup or probing; bridge override is honored', async () => {
  const ready = deferred()
  const h = harness({ setProxy: () => ready.promise, createBridge: forbidden })
  const custom = { proxyRules: 'http://127.0.0.1:44123', closed: 0, close() { this.closed++; return Promise.resolve() } }
  let bridgeArguments
  const config = browserConfig()
  const opening = h.api.createBrowserSession(config, {
    probeUrl: 'https://check.fixture.invalid/trace', bridge: async (proxy) => { bridgeArguments = proxy; return custom }
  })
  await until(() => h.sessions[0]?.proxyCalls.length === 1)
  assert.equal(h.configureCalls.length, 0)
  assert.equal(h.sessions[0].fetchCalls.length, 0)
  assert.equal(h.clock.active.size, 0)
  ready.resolve()
  const resource = await opening
  assert.equal(bridgeArguments, config.proxy)
  assert.equal(h.bridges.length, 0)
  assert.equal(resource.session.fetchCalls[0].url, 'https://check.fixture.invalid/trace')
  assert.equal(resource.session.proxyCalls[0].proxyRules, custom.proxyRules)
  await resource.close()
  assert.equal(custom.closed, 1)
})

test('each attempt has a fresh nonpersistent partition/bridge, independent language, and isolated cleanup', async () => {
  const h = harness()
  const first = browserConfig(), second = browserConfig()
  second.fingerprint.language = 'en-US'
  const [one, two] = await Promise.all([h.api.createBrowserSession(first), h.api.createBrowserSession(second)])
  assert.notEqual(one.session, two.session)
  assert.equal(new Set(h.partitions.map((entry) => entry.partition)).size, 2)
  assert.equal(h.partitions.every((entry) => !entry.partition.startsWith('persist:')), true)
  assert.equal(h.bridges.length, 2)
  assert.notEqual(one.session.proxyCalls[0].proxyRules, two.session.proxyCalls[0].proxyRules)
  assert.equal(h.configureCalls.find((call) => call.session === one.session).options.userAgent, undefined)
  assert.equal(h.configureCalls.find((call) => call.session === two.session).options.acceptLanguage, locale.acceptLanguageFor('en-US'))
  await one.close()
  assertClean(one.session)
  assert.equal(two.session.cleanupCalls.size, 0)
  assert.deepEqual(requestDecision(two.session, h.api.BROWSER_IP_CHECK_URL), { cancel: false })
  assert.equal(two.session.requestHandlers.length, 1)
  await two.close()
  assertClean(two.session)
})

test('disabled proxy explicitly uses system settings, creates no bridge/probe, and still secures and cleans its session', async () => {
  const h = harness({ createBridge: forbidden, fetch: forbidden })
  const resource = await h.api.createBrowserSession(browserConfig({ enabled: false }))
  assert.deepEqual(resource.session.proxyCalls, [{ mode: 'system' }])
  assert.equal(resource.check, undefined)
  assert.equal(h.bridges.length, 0)
  assert.equal(h.clock.history.length, 0)
  assert.equal(h.configureCalls.length, 1)
  await resource.close()
  assertClean(resource.session)
})

for (const stage of ['createBridge', 'setProxy']) {
  test(`${stage} failure rejects/redacts and cleans the new partition without system/DIRECT fallback or probe`, async () => {
    const config = browserConfig()
    const h = harness({ [stage]: () => Promise.reject(new Error(`fixture ${config.proxy.username}:${config.proxy.password}`)) })
    await assert.rejects(h.api.createBrowserSession(config), (error) => redactedFailure(error, [config.proxy.username, config.proxy.password], '[代理连接]'))
    const ses = h.sessions[0]
    assertClean(ses)
    assert.equal(ses.fetchCalls.length, 0)
    assert.equal(h.configureCalls.length, 0)
    assert.equal(ses.proxyCalls.every((call) => call.mode === 'fixed_servers'), true)
    assert.equal(h.bridges.length, stage === 'createBridge' ? 0 : 1)
    if (h.bridges.length) assert.equal(h.bridges[0].closeCalls, 1)
    assert.equal(h.clock.active.size, 0)
  })
}

for (const stage of ['configure', 'spellcheck', 'permissionRequest', 'permissionCheck', 'downloadHandler']) {
  test(`a ${stage} setup failure never probes or returns a usable session and closes acquired resources`, async () => {
    const h = harness({ [stage]: () => { throw new Error('synthetic setup failure') } })
    await assert.rejects(h.api.createBrowserSession(browserConfig()))
    assertClean(h.sessions[0])
    assert.equal(h.bridges.length, stage === 'spellcheck' ? 0 : 1)
    if (h.bridges.length) assert.equal(h.bridges[0].closeCalls, 1)
    assert.equal(h.sessions[0].fetchCalls.length, 0)
    assert.equal(h.sessions[0].proxyCalls.length, stage === 'spellcheck' ? 0 : 1)
    assert.equal(h.clock.active.size, 0)
  })
}

test('probeBrowserProxy uses the exact supplied Session, handles split UTF-8 chunks, and exposes no trace extras', async () => {
  const marker = randomBytes(16).toString('hex')
  const content = Buffer.from(`ip=2001:db8::8\nloc=JP\nuag=界🙂${marker}\n`)
  const fixture = traceResponse([...content].map((byte) => Buffer.from([byte])))
  const h = harness()
  const ses = { calls: [], fetch(url, options) {
    assert.equal(this, ses)
    this.calls.push({ url, options })
    h.clock.advance(123)
    return Promise.resolve(fixture.response)
  } }
  const parsed = await h.api.probeBrowserProxy(ses, 'https://check.fixture.invalid/custom')
  assert.deepEqual(plain(parsed), { ip: '2001:db8::8', country: 'JP', checkedAt: h.clock.now, latencyMs: 123 })
  assert.equal(ses.calls[0].url, 'https://check.fixture.invalid/custom')
  assert.equal(ses.calls.length, 1)
  assert.equal(h.sessions.length, 0, 'probing must not create a second Session')
  assert.equal(h.clock.active.size, 0)
  assert.equal(JSON.stringify(parsed).includes(marker), false)
})

for (const failure of ['fetch', 'http-status', 'empty-body', 'reader', 'invalid-trace']) {
  test(`${failure} probe failure has a fixed redacted error, clears timer and closes all session resources`, async () => {
    const config = browserConfig()
    const secret = config.proxy.password
    const fixture = traceResponse([`uag=${secret}\n`], {
      ok: failure !== 'http-status', status: failure === 'http-status' ? 503 : 200,
      noBody: failure === 'empty-body',
      ...(failure === 'reader' ? { read: () => { throw new Error(secret) } } : {})
    })
    const h = harness({ fetch: () => failure === 'fetch' ? Promise.reject(new Error(secret)) : Promise.resolve(fixture.response) })
    await assert.rejects(h.api.createBrowserSession(config), (error) => redactedFailure(error, [secret]))
    assertClean(h.sessions[0])
    assert.equal(h.bridges[0].closeCalls, 1)
    assert.equal(h.sessions[0].fetchCalls.length, 1)
    assert.equal(h.sessions[0].proxyCalls.length, 1)
    assert.equal(h.sessions[0].proxyCalls[0].mode, 'fixed_servers')
    assert.equal(h.clock.active.size, 0)
  })
}

test('probe accepts exactly 16 KiB, with the byte bound enforced across chunks', async () => {
  const prefix = Buffer.from('ip=203.0.113.7\nloc=CN\n')
  const fixture = traceResponse([prefix, Buffer.alloc(16384 - prefix.length, 120)])
  const h = harness({ fetch: () => Promise.resolve(fixture.response) })
  const resource = await h.api.createBrowserSession(browserConfig())
  assert.equal(resource.check.ip, '203.0.113.7')
  assert.equal(fixture.state.bytes, 16384)
  assert.equal(fixture.state.cancels, 0)
  assert.equal(h.clock.active.size, 0)
  await resource.close()
})

for (const shape of ['one-chunk', 'many-chunks', 'utf8-bytes', 'cancel-rejects']) {
  test(`oversized ${shape} trace is cancelled before further reads, redacted and cleaned up`, async () => {
    const marker = randomBytes(16).toString('hex')
    const base = 'ip=203.0.113.7\nloc=CN\n'
    const chunks = shape === 'many-chunks'
      ? [base, 'x'.repeat(8192), 'y'.repeat(8192), marker]
      : [base + (shape === 'utf8-bytes' ? '界'.repeat(6000) : 'x'.repeat(16384)), marker]
    const fixture = traceResponse(chunks, shape === 'cancel-rejects' ? { cancel: () => Promise.reject(new Error(marker)) } : {})
    const h = harness({ fetch: () => Promise.resolve(fixture.response) })
    await assert.rejects(h.api.createBrowserSession(browserConfig()), (error) => redactedFailure(error, [marker]))
    assert.equal(fixture.state.cancels, 1)
    assert.equal(fixture.state.reads, shape === 'many-chunks' ? 3 : 1)
    assert.equal(h.clock.active.size, 0)
    assertClean(h.sessions[0])
    assert.equal(h.bridges[0].closeCalls, 1)
  })
}

for (const phase of ['fetch', 'stream']) {
  test(`the 20s deadline aborts a stalled ${phase}, never retries, and cleans up without real timers or requests`, async () => {
    let signal
    let waiting = false
    const h = harness({ fetch: (_ses, { options }) => {
      signal = options.signal
      const stalled = () => {
        waiting = true
        return new Promise((_resolve, reject) => {
          if (signal.aborted) { reject(new Error('fixture aborted')); return }
          signal.addEventListener('abort', () => reject(new Error('fixture aborted')), { once: true })
        })
      }
      return phase === 'fetch' ? stalled() : Promise.resolve(traceResponse([], { read: stalled }).response)
    } })
    const opening = h.api.createBrowserSession(browserConfig())
    const rejection = assert.rejects(opening, (error) => redactedFailure(error, ['fixture aborted']))
    await until(() => waiting)
    h.clock.advance(19999)
    assert.equal(signal.aborted, false)
    assert.equal(h.sessions[0].cleanupCalls.size, 0)
    h.clock.advance(1)
    assert.equal(signal.aborted, true)
    await rejection
    assert.equal(h.sessions[0].fetchCalls.length, 1)
    assert.equal(h.clock.active.size, 0)
    assertClean(h.sessions[0])
    assert.equal(h.bridges[0].closeCalls, 1)
  })
}

test('close first blocks all requests, awaits every cleanup, and repeated/concurrent calls share one promise', async () => {
  const gates = new Map(['closeBridge', ...cleanupNames].map((name) => [name, deferred()]))
  const h = harness(Object.fromEntries([...gates].map(([name, gate]) => [name, () => gate.promise])))
  const resource = await h.api.createBrowserSession(browserConfig())
  const start = h.events.length
  const first = resource.close()
  const second = resource.close()
  assert.equal(first, second)
  assert.equal(h.events[start].name, 'requestGate')
  // Closing now deliberately stops sockets before clearing headers/storage.
  await new Promise(setImmediate)
  assert.equal(resource.session.cleanupCalls.get('closeAllConnections'), 1)
  gates.get('closeBridge').resolve()
  gates.get('closeAllConnections').resolve()
  await new Promise(setImmediate)
  assertClean(resource.session)
  assert.equal(resource.session.requestHandlers.length, 2)
  assert.equal(h.bridges[0].closeCalls, 1)
  let completed = false
  first.then(() => { completed = true })
  for (const [name, gate] of gates) if (name !== 'clearAuthCache') gate.resolve()
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(completed, false)
  gates.get('clearAuthCache').resolve()
  await first
  assert.equal(completed, true)
  assert.equal(resource.close(), first)
  assert.equal(resource.session.requestHandlers.length, 2)
  assertClean(resource.session)
  assert.equal(h.bridges[0].closeCalls, 1)
})

test('asynchronous cleanup failures do not short-circuit other cleanup or break close idempotence', async () => {
  const h = harness(Object.fromEntries(['closeBridge', ...cleanupNames].map((name) => [name, () => Promise.reject(new Error(`fixture ${name}`))])))
  const resource = await h.api.createBrowserSession(browserConfig())
  const closed = resource.close()
  await assert.doesNotReject(closed)
  assertClean(resource.session)
  assert.equal(h.bridges[0].closeCalls, 1)
  assert.equal(resource.close(), closed)
})

test('cleanup rejections during a setup failure do not replace the sanitized original failure', async () => {
  const secret = randomBytes(16).toString('hex')
  const h = harness({
    setProxy: () => Promise.reject(new Error(secret)),
    ...Object.fromEntries(['closeBridge', ...cleanupNames].map((name) => [name, () => Promise.reject(new Error(secret))]))
  })
  await assert.rejects(h.api.createBrowserSession(browserConfig()), (error) => redactedFailure(error, [secret], '[代理连接]'))
  assertClean(h.sessions[0])
  assert.equal(h.bridges[0].closeCalls, 1)
  assert.equal(h.clock.active.size, 0)
})

for (const probeUrl of [undefined, 'http://127.0.0.1:44123/custom-trace?run=fixture']) {
  test(`startup gate allows only the exact ${probeUrl ? 'custom' : 'default'} probe, before bridge/proxy setup begins`, async () => {
    const bridgeReady = deferred()
    const h = harness({ createBridge: () => bridgeReady.promise })
    const opening = h.api.createBrowserSession(browserConfig(), probeUrl ? { probeUrl } : {})
    await until(() => h.events.some((event) => event.name === 'createBridge'))
    const ses = h.sessions[0]
    const allowed = probeUrl || h.api.BROWSER_IP_CHECK_URL
    assert.equal(ses.spellcheck, false)
    assert.equal(ses.requestHandlers.length, 1)
    assert.deepEqual(h.events.slice(0, 3).map((event) => event.name), ['fromPartition', 'spellcheck', 'requestGate'])
    assert.equal(ses.proxyCalls.length, 0)
    assert.equal(ses.fetchCalls.length, 0)
    assert.equal(h.clock.active.size, 0)
    for (const resourceType of ['other', 'mainFrame', 'subFrame', 'xhr', 'script']) {
      assert.deepEqual(requestDecision(ses, allowed, { resourceType, webContentsId: 0 }), { cancel: false })
    }
    const rejected = [
      'https://redirector.gvt1.com/edgedl/chrome/dict/en-us-10-1.bdic',
      'https://update.googleapis.com/service/update2', 'https://portal.fixture.invalid/',
      'http://127.0.0.1:44123/not-the-probe', 'about:blank',
      allowed + '&extra=1', allowed + '/', allowed + '#fragment',
      'https://www.cloudflare.com.fixture.invalid/cdn-cgi/trace',
      'http://www.cloudflare.com/cdn-cgi/trace'
    ]
    if (probeUrl) rejected.push(h.api.BROWSER_IP_CHECK_URL)
    for (const url of rejected) {
      assert.deepEqual(requestDecision(ses, url, { resourceType: 'other', webContentsId: 0 }), { cancel: true }, url)
    }
    bridgeReady.resolve()
    const resource = await opening
    assert.equal(ses.fetchCalls.length, 1)
    assert.equal(ses.fetchCalls[0].url, allowed)
    assert.deepEqual(requestDecision(ses, allowed), { cancel: false })
    assert.deepEqual(requestDecision(ses, 'https://portal.fixture.invalid/'), { cancel: true })
    await resource.close()
    assertClean(ses)
    assert.deepEqual(requestDecision(ses, allowed), { cancel: true })
  })
}

test('close replaces a later manager-owned request handler and remains idempotent', async () => {
  const h = harness()
  const resource = await h.api.createBrowserSession(browserConfig())
  const ses = resource.session
  assert.equal(ses.requestHandlers.length, 1)
  // Model manager ownership only; real WebContentsView/CDP behavior belongs to the runtime harness.
  ses.webRequest.onBeforeRequest((_details, callback) => callback({ cancel: false }))
  assert.deepEqual(requestDecision(ses, 'https://portal.fixture.invalid/'), { cancel: false })
  const close = resource.close()
  assert.equal(resource.close(), close)
  await close
  assertClean(ses)
  assert.equal(ses.requestHandlers.length, 3)
  assert.equal(h.bridges[0].closeCalls, 1)
})

test('failure installing the initial request gate still cleans the newly created partition', async () => {
  let attempts = 0
  const h = harness({ requestGate: () => { if (++attempts === 1) throw new Error('Synthetic request-gate failure') } })
  await assert.rejects(h.api.createBrowserSession(browserConfig()))
  assertClean(h.sessions[0])
  assert.equal(h.bridges.length, 0)
  assert.equal(h.sessions[0].proxyCalls.length, 0)
  assert.equal(h.sessions[0].fetchCalls.length, 0)
  assert.equal(h.clock.active.size, 0)
})

test('pre-aborted startup allocates no session or bridge', async () => {
  const h = harness()
  const controller = new AbortController()
  controller.abort('fixture-private-reason')
  await assert.rejects(h.api.createBrowserSession(browserConfig(), { signal: controller.signal }), /浏览器操作已中断/)
  assert.equal(h.sessions.length, 0)
  assert.equal(h.bridges.length, 0)
})

test('abort while bridge factory is pending cleans the session and closes a late bridge', async () => {
  const gate = deferred()
  const h = harness({ createBridge: () => gate.promise })
  const controller = new AbortController()
  const opening = h.api.createBrowserSession(browserConfig(), { signal: controller.signal })
  const rejected = assert.rejects(opening, /浏览器操作已中断/)
  await until(() => h.events.some((event) => event.name === 'createBridge'))
  controller.abort('fixture-private-reason')
  await rejected
  assertClean(h.sessions[0])
  assert.equal(h.sessions[0].fetchCalls.length, 0)
  gate.resolve()
  await until(() => h.bridges.length === 1 && h.bridges[0].closeCalls === 1)
  assert.equal(h.sessions[0].proxyCalls.length, 0)
})

test('abort cancels a noncooperative late fetch response without leaking its body', async () => {
  const gate = deferred()
  const h = harness({ fetch: () => gate.promise })
  const controller = new AbortController()
  const opening = h.api.createBrowserSession(browserConfig(), { signal: controller.signal })
  const rejected = assert.rejects(opening, /浏览器操作已中断/)
  await until(() => h.sessions[0]?.fetchCalls.length === 1)
  controller.abort()
  await rejected
  assertClean(h.sessions[0])
  let cancelled = 0
  gate.resolve({ ok: true, body: { cancel() { cancelled++; return Promise.resolve() } } })
  await until(() => cancelled === 1)
  assert.equal(h.clock.active.size, 0)
})

test('abort during a noncooperative body read cancels/releases its reader and clears listeners', async () => {
  const gate = deferred()
  const fixture = traceResponse([], { read: () => gate.promise })
  const h = harness({ fetch: () => Promise.resolve(fixture.response) })
  const controller = new AbortController()
  const opening = h.api.createBrowserSession(browserConfig(), { signal: controller.signal })
  const rejected = assert.rejects(opening, /浏览器操作已中断/)
  await until(() => fixture.state.reads === 1)
  controller.abort()
  await rejected
  assert.equal(fixture.state.cancels, 1)
  assert.equal(fixture.state.releases, 1)
  assertClean(h.sessions[0])
  gate.reject(new Error('fixture-late-private-error'))
  await new Promise(setImmediate)
  assert.equal(h.clock.active.size, 0)
})
