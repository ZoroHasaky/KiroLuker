import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import vm from 'node:vm'
import * as net from 'node:net'
import http from 'node:http'
import https from 'node:https'
import tls from 'node:tls'
import { randomBytes } from 'node:crypto'
import { once } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
import * as proxyChain from 'proxy-chain'
import ts from 'typescript'
import { startBrowserProxyFixture } from './helpers/browser-proxy-fixture.cjs'

const sources = new Map(await Promise.all(['browserConfig', 'browserProxy'].map(async (name) => {
  const source = await fs.readFile(new URL(`../src/main/${name}.ts`, import.meta.url), 'utf8')
  return [name, ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true }
  }).outputText]
})))
const forbidden = () => { throw new Error('Real Electron/account access is forbidden') }
function loadModule(name, imports) {
  const exports = {}
  vm.runInNewContext(sources.get(name), {
    exports, Buffer, Intl, process,
    require(id) {
      assert.ok(Object.hasOwn(imports, id), `Unexpected dependency: ${id}`)
      return imports[id]
    }
  }, { filename: `${name}.ts` })
  return exports
}
const config = loadModule('browserConfig', {
  'electron-store': forbidden, electron: { safeStorage: {} }, 'node:net': net,
  './store': { getSettings: forbidden }
})
function loadBridge(Socket = net.Socket, configureForward = () => {}) {
  const relayServers = []
  const proxyServers = []
  const api = loadModule('browserProxy', {
    './browserConfig': config,
    'node:net': { ...net, Socket, createServer(...args) {
      const server = net.createServer(...args)
      relayServers.push(server)
      return server
    } },
    'proxy-chain': { Server: class extends proxyChain.Server {
      constructor(options) { super(options); configureForward(this); proxyServers.push(this) }
    } }
  })
  return { ...api, relayServers, proxyServers }
}
const freshCredentials = () => ({
  username: `fixture:@/%?#界-${randomBytes(6).toString('hex')}`,
  password: `test-only:@/%?#🙂-${randomBytes(12).toString('hex')}`
})

// Synthetic localhost-only TEST certificate/key, generated for this fixture; never used by production.
const LOCAL_TEST_TLS = {
  key: `-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQDCFA1h5ZzqcwIu
flvKPLhK5lRvqETOvgdSSxChbE+FEL5pA08/LRpQvBXrFSNgqHaF6ag73lVgcTJE
sKT1HLO5YH/CJnH9N9F6ZX262c/CdvEGcfWDlmdSszKzAJAodJnAQuK1YsiWkdr+
XVGaQ7QNleZ0Ujn/FbDsLfZ51A6DUklxF4BFwdWTJ3+SabQX9L8VBOxv/f4LW6Fu
a3ZG6jZNGPC9lyggE4egItwTc2R0UPnYPe7P0GFzbPXpht2NvLG0CF0yCSfFTnAn
3ch7+8omzJEJ/d4idfUKJ5XUautD5+7VPwSEchz0oh2Icnub+09AbfIX1iaZAqYY
NkAwGcA9AgMBAAECggEAO9udaQU9iV3hXV+hhdWGbatufWWjmzQm4+28+lyChiLs
50ybA3wwspfgFrpVR/mNXK39MkHXiUBAZckph2PL1q/5l3LuE1BE7oAg8CE/n9W5
buh09ZnM0kfsqiLRU3jq9s5qR9Fo1m+z4GH9yht5i/sgsd2uf4s8HwvqChcqRrvv
vLkkxXLYik8tKBAEQ+13hlH8nAE3CR9s4mHY7c28umtJr/fNF1XXzM9k3F+Y/Y31
DHMzNc6dHlXvwE/XSE7wkPn2d95ai3WjvIl0HQ/WZKIb3i5fj6J8I8e6II9OGQz0
qArrsOWhrw9ljHGm3+M17EWD5xrhH1jkZitk6nJ2jQKBgQDp8XwFO49Jwv/rA74z
1iGXijxGiO0FXtvyuYRbwksTDxEiSuBiKCUlZWIap3aj2JYvb02tTY79UBGVQJYV
gOQKJ9iOS+e7y/dy6+myZPWcq/R93jFP2JICzghZWfejTcIBXhFnEHDr7lW/dm5A
zRNJ3McAmhLmtEL5FgLxn7jwqwKBgQDUYGBt+X87yv2nIk4UNjOececsAD8sV91X
ROVW1XEk1gy4GoVDvnhrShnB6zCfxAfc6JMLgTGcgt0n6sQuF1SImFnqASKEthku
UmtBvXUBG6WMIccjbtV/iURVYxCmRi2oMzW5Xo77mClT+nG3MrtQypA1DULfglcx
Gt/rLs0itwKBgQDnaZTAqFXpJRd6Jk2zgRHhkUBmlXPAaEEyLQkcq2kQBUtxnJex
AP0drNgKfbUCBnEpovQ3hgz3zohWF3le9AyfbyLsP3GPdwfjijG14eCDhiVnjK9C
yHxGggAIQtKPm49ZQu/7/2t0NmJj7obJWxLFcbr4gXBI/e9x7bAjy1dp2QKBgFsn
Vpw9RzgBw2dWGQ8hyHwMRX2kSXkd6VnIr2rax+pYmTL35xURjpv2PSH3cXJRcFKH
3H1GoWWc4ZF9eWCTEOxj/8upWwh9JEe2hmS8DZlBJYgFA3UY4DgSUasYjw/e9T/J
YxjCFjq0r6Bk0SQheTaPCuBKZdaLGiNwdoV6G//3AoGAB3VYTBG4+MT8xvy64Q6Q
vgQuUky9GkPZgG9+PztH5W9VOX0/8RtOCS3Tp+CBA2Qgl0Cd7yezTYNKwJQ3OdN3
rTvEaWFmmx1HnywEyKKukaOgopxYnKaO4QkWcIh628yfA/1li2paS41KYHAC9hmK
hk1+7Pl2n5iT/mRK9nluxwM=
-----END PRIVATE KEY-----`,
  cert: `-----BEGIN CERTIFICATE-----
MIIC/TCCAeWgAwIBAgIISjn7rYVOcFQwDQYJKoZIhvcNAQELBQAwIjEgMB4GA1UE
AxMXcmVtb3RlLWRucy1vbmx5LmludmFsaWQwHhcNMjAwMTAxMDAwMDAwWhcNNDAw
MTAxMDAwMDAwWjAiMSAwHgYDVQQDExdyZW1vdGUtZG5zLW9ubHkuaW52YWxpZDCC
ASIwDQYJKoZIhvcNAQEBBQADggEPADCCAQoCggEBAMIUDWHlnOpzAi5+W8o8uErm
VG+oRM6+B1JLEKFsT4UQvmkDTz8tGlC8FesVI2CodoXpqDveVWBxMkSwpPUcs7lg
f8Imcf030XplfbrZz8J28QZx9YOWZ1KzMrMAkCh0mcBC4rViyJaR2v5dUZpDtA2V
5nRSOf8VsOwt9nnUDoNSSXEXgEXB1ZMnf5JptBf0vxUE7G/9/gtboW5rdkbqNk0Y
8L2XKCATh6Ai3BNzZHRQ+dg97s/QYXNs9emG3Y28sbQIXTIJJ8VOcCfdyHv7yibM
kQn93iJ19QonldRq60Pn7tU/BIRyHPSiHYhye5v7T0Bt8hfWJpkCphg2QDAZwD0C
AwEAAaM3MDUwIgYDVR0RBBswGYIXcmVtb3RlLWRucy1vbmx5LmludmFsaWQwDwYD
VR0TAQH/BAUwAwEB/zANBgkqhkiG9w0BAQsFAAOCAQEARrkkZ4okict3WbsJJQQf
AhpiYVYT0mk/Ga1N9ZHjV5kdQVNW/EFg1YxMt4cjtrObvayn6k4JNGg6uEx/y9PP
ZZOhQqj1sam0B2t/jlOF/nhGCdJvu1ys2Zfp1nQv2Bfnvnuy+I1vpe9/SvqoojX7
5usPkm1QcNGK+JOK7ADYU1MUMqiDBY4c2Ry08/nv7zIiAQyjqXckLA2sVCObeEI9
sni7XyBJnMMs5oJD5DqVVIuKEACZPHqrCf1Dw8JvLBJxoYoEiFXgPUxFAtu/ivy6
xSLXXZiFcnFlQRkWsoxEkfRHiSCX3wOM1BCsOgcpaznJob5l1244H7acECjUBVLw
0A==
-----END CERTIFICATE-----`
}

async function waitFor(predicate, message, milliseconds = 2500) {
  const deadline = Date.now() + milliseconds
  while (!predicate()) {
    assert.ok(Date.now() < deadline, message)
    await delay(10)
  }
}
async function serve(t, server) {
  const sockets = new Set()
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
    socket.on('error', () => {})
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  let closing
  const stop = () => closing ??= new Promise((resolve) => {
    for (const socket of sockets) socket.destroy()
    server.close(() => resolve())
  })
  t.after(stop)
  return { server, sockets, stop, port: server.address().port }
}

async function socksFixture(t, { ports, credentials = freshCredentials(), mode = 'normal' }) {
  const fixture = await startBrowserProxyFixture({ allowedTargetPorts: ports, credentials, mode })
  t.after(async () => { await fixture.close(); assert.deepEqual(fixture.state.failures, []) })
  return fixture
}
async function targetFixture(t, secure = false) {
  const requests = []
  const handler = (request, response) => {
    requests.push({ url: request.url, headers: request.headers })
    response.writeHead(200, { 'content-type': 'text/plain' })
    response.write(`${secure ? 'secure' : 'plain'}-target:${request.url}`)
    if (request.url !== '/hold') response.end()
  }
  // Standard TLS and an explicitly trusted test-only certificate also work in Electron/BoringSSL.
  const server = secure
    ? https.createServer(LOCAL_TEST_TLS, handler)
    : http.createServer(handler)
  return { ...await serve(t, server), requests, cert: LOCAL_TEST_TLS.cert }
}
async function bridgeFixture(t, socks, loader = loadBridge(), overrides = {}) {
  const bridge = await loader.createBrowserProxyBridge({
    enabled: true, host: '127.0.0.1', port: socks.port, ...socks.credentials, ...overrides
  })
  t.after(() => bridge.close())
  const url = new URL(bridge.proxyRules)
  assert.equal(url.protocol, 'http:')
  assert.equal(url.hostname, '127.0.0.1')
  assert.equal(url.username, '')
  assert.equal(url.password, '')
  assert.ok(Number(url.port) > 0)
  assert.equal(bridge.proxyRules.includes('DIRECT'), false)
  const forward = loader.proxyServers.find((server) => server.port === Number(url.port))
  const upstream = new URL((await forward.prepareRequestFunction({})).upstreamProxyUrl)
  assert.equal(upstream.protocol, 'socks5h:')
  const relayPort = Number(upstream.port)
  const relay = loader.relayServers.find((server) => server.address()?.port === relayPort)
  assert.equal(relay.address().address, '127.0.0.1')
  assert.equal(forward.server.address().address, '127.0.0.1')
  assert.equal(forward.verbose, false)
  return { bridge, port: Number(url.port), relayPort, relay, forward }
}
function httpThrough(port, target, path = '/plain', host = 'remote-dns-only.invalid') {
  return new Promise((resolve) => {
    const request = http.get({
      hostname: '127.0.0.1', port, path: `http://${host}:${target.port}${path}`,
      headers: { connection: 'close' }, agent: false
    }, (response) => {
      let body = ''
      response.setEncoding('utf8')
      response.on('data', (chunk) => { body += chunk })
      response.on('end', () => resolve({ status: response.statusCode, body, headers: response.headers }))
      response.on('error', (error) => resolve({ status: 0, body: error.message }))
    })
    request.setTimeout(3500, () => request.destroy(new Error('Local proxy test timeout')))
    request.on('error', (error) => resolve({ status: 0, body: error.message }))
  })
}
function connectThrough(port, target, host = 'remote-dns-only.invalid') {
  return new Promise((resolve) => {
    const request = http.request({ hostname: '127.0.0.1', port, method: 'CONNECT', path: `${host}:${target.port}`, agent: false })
    request.on('connect', (response, socket, head) => {
      socket.setTimeout(0)
      socket.on('error', () => {})
      if (head.length) socket.unshift(head)
      if (response.statusCode !== 200) socket.destroy()
      resolve({ status: response.statusCode, socket, body: response.statusMessage })
    })
    request.setTimeout(3500, () => request.destroy(new Error('Local CONNECT test timeout')))
    request.on('error', (error) => resolve({ status: 0, body: error.message }))
    request.end()
  })
}
async function httpsThrough(port, target, path = '/secure') {
  const tunnel = await connectThrough(port, target)
  assert.equal(tunnel.status, 200, tunnel.body)
  const socket = tls.connect({
    socket: tunnel.socket, ca: target.cert, servername: 'remote-dns-only.invalid'
  })
  try {
    await once(socket, 'secureConnect')
    assert.equal(socket.encrypted, true)
    assert.equal(socket.authorized, true, 'the HTTPS target certificate is actually verified')
    const response = new Promise((resolve, reject) => {
      let body = ''
      socket.setEncoding('utf8')
      socket.on('data', (chunk) => { body += chunk })
      socket.on('end', () => resolve(body))
      socket.on('error', reject)
    })
    socket.write(`GET ${path} HTTP/1.1\r\nHost: remote-dns-only.invalid\r\nConnection: close\r\n\r\n`)
    return await response
  } finally { socket.destroy() }
}
async function assertPortReleased(t, port) {
  const replacement = net.createServer()
  await new Promise((resolve, reject) => {
    replacement.once('error', reject)
    replacement.listen(port, '127.0.0.1', resolve)
  })
  t.after(() => new Promise((resolve) => replacement.close(resolve)))
  await new Promise((resolve) => replacement.close(resolve))
}
function assertRedacted(result, credentials) {
  const visible = JSON.stringify(result, (key, value) => key === 'socket' ? undefined : value)
  for (const secret of Object.values(credentials)) {
    assert.equal(visible.includes(secret), false)
    assert.equal(visible.includes(encodeURIComponent(secret)), false)
  }
}

test('real authenticated SOCKS5h forwards HTTP and TLS-encrypted HTTPS with remote DNS and URL-encoded credentials', { timeout: 10000 }, async (t) => {
  const plainTarget = await targetFixture(t)
  const secureTarget = await targetFixture(t, true)
  const socks = await socksFixture(t, { ports: [plainTarget.port, secureTarget.port] })
  const { port, bridge } = await bridgeFixture(t, socks)
  const [plain, secure] = await Promise.all([httpThrough(port, plainTarget, '/query?a=1'), httpsThrough(port, secureTarget)])
  assert.equal(plain.status, 200)
  assert.equal(plain.body, 'plain-target:/query?a=1')
  assert.match(secure, /^HTTP\/1\.1 200/)
  assert.match(secure, /secure-target:\/secure/)
  assert.equal(socks.state.requests.length, 2)
  for (const request of socks.state.requests) {
    assert.equal(request.host, 'remote-dns-only.invalid')
    assert.equal(request.addressType, 3, 'upstream receives domain, not locally resolved IP')
  }
  for (const auth of socks.state.authentications) assert.deepEqual(auth, socks.credentials)
  for (const request of [...plainTarget.requests, ...secureTarget.requests]) assert.equal(request.headers['proxy-authorization'], undefined)
  assertRedacted({ bridge: bridge.proxyRules, plain, secure }, socks.credentials)
})

test('SOCKS auth supports the exact 255-byte UTF-8 limit over real sockets', { timeout: 10000 }, async (t) => {
  const target = await targetFixture(t)
  const credentials = { username: '界'.repeat(85), password: '界'.repeat(85) }
  const socks = await socksFixture(t, { ports: [target.port], credentials })
  const { port } = await bridgeFixture(t, socks)
  assert.equal((await httpThrough(port, target)).status, 200)
  const tunnel = await connectThrough(port, target)
  assert.equal(tunnel.status, 200)
  tunnel.socket.destroy()
  assert.deepEqual(socks.state.authentications, [credentials, credentials])
})

for (const failure of ['wrong-credentials', 'drop', 'refuse', 'offline']) {
  test(`${failure}: HTTP and CONNECT fail closed even for directly reachable targets, without secret errors`, { timeout: 10000 }, async (t) => {
    const target = await targetFixture(t)
    const socks = await socksFixture(t, { ports: [target.port], mode: failure === 'drop' || failure === 'refuse' ? failure : 'normal' })
    if (failure === 'offline') await socks.stop()
    const overrides = failure === 'wrong-credentials' ? { password: `wrong-${randomBytes(12).toString('hex')}` } : {}
    const { port } = await bridgeFixture(t, socks, loadBridge(), overrides)
    const results = await Promise.all([httpThrough(port, target, '/must-not-bypass', '127.0.0.1'), connectThrough(port, target, '127.0.0.1')])
    for (const result of results) {
      assert.ok(result.status === 0 || result.status >= 400, `must not return success: ${result.status}`)
      assertRedacted(result, { ...socks.credentials, ...overrides })
    }
    assert.equal(target.requests.length, 0)
    assert.equal(target.sockets.size, 0)
    assert.equal(socks.state.destinations.size, 0)
  })
}

test('concurrent per-window bridges isolate credentials, ports and close lifecycle', { timeout: 10000 }, async (t) => {
  const target = await targetFixture(t)
  const a = await socksFixture(t, { ports: [target.port] })
  const b = await socksFixture(t, { ports: [target.port] })
  const loader = loadBridge()
  const [one, two] = await Promise.all([bridgeFixture(t, a, loader), bridgeFixture(t, b, loader)])
  assert.notEqual(one.port, two.port)
  assert.notEqual(one.relayPort, two.relayPort)
  const responses = await Promise.all(Array.from({ length: 8 }, (_, i) => httpThrough(i % 2 ? one.port : two.port, target, `/window-${i % 2}`)))
  assert.equal(responses.every((response) => response.status === 200), true)
  for (const auth of a.state.authentications) assert.deepEqual(auth, a.credentials)
  for (const auth of b.state.authentications) assert.deepEqual(auth, b.credentials)
  assert.equal(a.state.authentications.length, 4)
  assert.equal(b.state.authentications.length, 4)
  await one.bridge.close()
  assert.equal((await httpThrough(two.port, target, '/still-running')).status, 200)
  assert.equal((await httpThrough(one.port, target, '/closed')).status, 0)
})

test('close destroys established CONNECT streams and releases both loopback ports; it is idempotent', { timeout: 10000 }, async (t) => {
  const target = await targetFixture(t)
  const socks = await socksFixture(t, { ports: [target.port] })
  const { port, relayPort, bridge } = await bridgeFixture(t, socks)
  const tunnel = await connectThrough(port, target)
  assert.equal(tunnel.status, 200)
  const firstData = once(tunnel.socket, 'data')
  tunnel.socket.write('GET /hold HTTP/1.1\r\nHost: local-fixture\r\n\r\n')
  await firstData
  assert.equal(target.requests.length, 1)
  const clientClosed = once(tunnel.socket, 'close')
  const one = bridge.close()
  const two = bridge.close()
  assert.equal(one, two)
  await one
  await clientClosed
  await waitFor(() => socks.sockets.size === 0 && socks.state.destinations.size === 0 && target.sockets.size === 0, 'all established sockets should close')
  await bridge.close()
  await assertPortReleased(t, port)
  await assertPortReleased(t, relayPort)
})

for (const mode of ['stall-greeting', 'stall-connect']) {
  for (const method of ['HTTP', 'CONNECT']) {
    test(`close cancels ${method} during ${mode} without waiting for SOCKS timeout or leaving connections`, { timeout: 10000 }, async (t) => {
      const target = await targetFixture(t)
      const socks = await socksFixture(t, { ports: [target.port], mode })
      const { port, relayPort, bridge } = await bridgeFixture(t, socks)
      const pending = method === 'HTTP' ? httpThrough(port, target) : connectThrough(port, target)
      await waitFor(() => mode === 'stall-greeting' ? socks.state.greetings.length > 0 : socks.state.requests.length > 0, 'SOCKS attempt must actually reach the stalled stage')
      const start = performance.now()
      await bridge.close()
      assert.ok(performance.now() - start < 1000, 'close must not wait for the library\'s 30s SOCKS timeout')
      const result = await pending
      assert.ok(result.status === 0 || result.status >= 400)
      assertRedacted(result, socks.credentials)
      await waitFor(() => socks.sockets.size === 0 && socks.state.destinations.size === 0, 'pending upstream sockets must close')
      assert.equal(target.requests.length, 0)
      await assertPortReleased(t, port)
      await assertPortReleased(t, relayPort)
    })
  }
}

test('close cancels a pending upstream DNS/TCP attempt and a late lookup cannot reopen a connection', { timeout: 10000 }, async (t) => {
  const target = await targetFixture(t)
  const socks = await socksFixture(t, { ports: [target.port] })
  const pendingLookups = []
  class PendingSocket extends net.Socket {
    connect(port, host) {
      return super.connect({ port, host, lookup(_hostname, options, callback) {
        pendingLookups.push(() => options.all ? callback(null, [{ address: '127.0.0.1', family: 4 }]) : callback(null, '127.0.0.1', 4))
      } })
    }
  }
  const { port, bridge } = await bridgeFixture(t, socks, loadBridge(PendingSocket), { host: 'pending-upstream.invalid' })
  const pending = connectThrough(port, target)
  await waitFor(() => pendingLookups.length > 0, 'upstream TCP attempt should be waiting on DNS')
  await bridge.close()
  for (const release of pendingLookups) release()
  const result = await pending
  assert.ok(result.status === 0 || result.status >= 400)
  await delay(50)
  assert.equal(socks.state.accepted, 0)
  assert.equal(target.requests.length, 0)
})

test('dropping an established upstream destroys its tunnel and later requests never bypass', { timeout: 10000 }, async (t) => {
  const target = await targetFixture(t)
  const socks = await socksFixture(t, { ports: [target.port] })
  const { port } = await bridgeFixture(t, socks)
  const tunnel = await connectThrough(port, target, '127.0.0.1')
  assert.equal(tunnel.status, 200)
  const firstData = once(tunnel.socket, 'data')
  tunnel.socket.write('GET /hold HTTP/1.1\r\nHost: local-fixture\r\n\r\n')
  await firstData
  const closed = once(tunnel.socket, 'close')
  tunnel.socket.resume()
  socks.state.mode = 'drop'
  for (const socket of socks.sockets) socket.destroy()
  await closed
  const result = await httpThrough(port, target, '/no-bypass-after-drop', '127.0.0.1')
  assert.ok(result.status === 0 || result.status >= 400)
  assert.equal(target.requests.length, 1)
})

test('invalid/disabled proxy inputs are rejected before any listener or connection is created, without echoing secrets', async () => {
  const loader = loadBridge()
  const credentials = freshCredentials()
  const base = { enabled: true, host: '127.0.0.1', port: 1080, ...credentials }
  for (const override of [{ enabled: false }, { host: 'socks5://user:password@host' }, { port: 0 }, { password: credentials.password + '\r\n' }, { username: '界'.repeat(86) }]) {
    await assert.rejects(loader.createBrowserProxyBridge({ ...base, ...override }), (error) => {
      assertRedacted({ message: error.message, stack: error.stack }, credentials)
      return true
    })
  }
  assert.equal(loader.relayServers.length, 0)
  assert.equal(loader.proxyServers.length, 0)
})

test('close destroys an established forward HTTP response without leaving upstream/target sockets', { timeout: 10000 }, async (t) => {
  const target = await targetFixture(t)
  const socks = await socksFixture(t, { ports: [target.port] })
  const { port, bridge } = await bridgeFixture(t, socks)
  const request = http.get({ hostname: '127.0.0.1', port, path: `http://remote-dns-only.invalid:${target.port}/hold`, agent: false })
  request.on('error', () => {})
  t.after(() => request.destroy())
  const [response] = await once(request, 'response')
  response.on('error', () => {})
  const firstChunk = await once(response, 'data')
  assert.match(firstChunk[0].toString(), /plain-target:\/hold/)
  const closed = new Promise((resolve) => response.once('close', resolve))
  await bridge.close()
  await closed
  await waitFor(() => socks.sockets.size === 0 && socks.state.destinations.size === 0 && target.sockets.size === 0, 'forward HTTP sockets should be destroyed')
})

test('an actual HTTP listener bind failure cleans the already-started relay and returns only a redacted error', { timeout: 10000 }, async (t) => {
  const occupied = await serve(t, net.createServer())
  const loader = loadBridge(net.Socket, (server) => { server.port = occupied.port })
  const credentials = freshCredentials()
  await assert.rejects(loader.createBrowserProxyBridge({ enabled: true, host: '127.0.0.1', port: occupied.port, ...credentials }), (error) => {
    assert.equal(error.message, 'Could not start browser proxy bridge')
    assertRedacted({ message: error.message, stack: error.stack }, credentials)
    assert.equal(error.cause, undefined)
    return true
  })
  assert.equal(loader.relayServers.length, 1)
  assert.equal(loader.relayServers[0].listening, false)
  assert.equal(loader.proxyServers[0].getConnectionIds().length, 0)
  assert.equal(occupied.server.listening, true, 'unrelated existing listener is untouched')
})
