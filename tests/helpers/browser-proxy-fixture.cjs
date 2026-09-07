'use strict'

const assert = require('node:assert/strict')
const net = require('node:net')
const { once } = require('node:events')
const { randomBytes } = require('node:crypto')

// TEST-ONLY SOCKS protocol server. All outgoing connections are restricted to loopback.
class Reader {
  buffer = Buffer.alloc(0)
  pending
  failure
  constructor(socket) {
    this.socket = socket
    this.onData = (data) => { this.buffer = Buffer.concat([this.buffer, data]); this.flush() }
    this.onClose = () => { this.failure = new Error('Local fixture socket closed'); this.flush() }
    socket.on('data', this.onData)
    socket.on('close', this.onClose)
    socket.on('error', this.onClose)
  }
  flush() {
    if (!this.pending) return
    const { count, resolve, reject } = this.pending
    if (this.buffer.length >= count) {
      this.pending = undefined
      const value = this.buffer.subarray(0, count)
      this.buffer = this.buffer.subarray(count)
      resolve(value)
    } else if (this.failure) {
      this.pending = undefined
      reject(this.failure)
    }
  }
  read(count) {
    assert.equal(this.pending, undefined)
    return new Promise((resolve, reject) => { this.pending = { count, resolve, reject }; this.flush() })
  }
  release() {
    this.socket.removeListener('data', this.onData)
    this.socket.removeListener('close', this.onClose)
    this.socket.removeListener('error', this.onClose)
    return this.buffer
  }
}

/**
 * Reusable, authenticated, strictly LOCAL SOCKS5 fixture (no Electron imports).
 *
 * await startBrowserProxyFixture({
 *   credentials: { username, password }, // generated defaults if omitted
 *   routes: { 'remote-dns-only.invalid': { host: '127.0.0.1', port: localHttpPort } }
 * })
 *
 * Routing priority: mapDestination({host, port, addressType}), routes['host:port'],
 * routes[host], allowedTargetPorts (same port at 127.0.0.1); otherwise SOCKS refusal.
 * routes may be an object or Map. mapDestination is synchronous and may return null.
 * Every mapped destination must be 127.0.0.1 or ::1 with a valid port.
 *
 * Modes: normal, drop (immediate), reject-auth, stall-greeting, stall-auth,
 * stall-connect, refuse (SOCKS connection refused). setMode affects subsequent stages.
 * acceptCredentials({username,password}) optionally overrides the exact-pair check.
 * No request, credential, or error is logged. Close is idempotent and kills all sockets.
 */
async function startBrowserProxyFixture(options = {}) {
  let credentials = { ...(options.credentials || {
    username: `fixture:@/%?#界-${randomBytes(6).toString('hex')}`,
    password: `test-only:@/%?#🙂-${randomBytes(12).toString('hex')}`
  }) }
  const sockets = new Set()
  const state = {
    mode: options.mode || 'normal', accepted: 0, greetings: [],
    authentications: [], requests: [], destinations: new Set(), failures: []
  }
  let closing = false
  let closePromise
  const reply = (code) => Buffer.from([5, code, 0, 1, 127, 0, 0, 1, 0, 0])
  function routeFor(request) {
    if (options.mapDestination) return options.mapDestination({ ...request })
    const routes = options.routes
    for (const key of [`${request.host}:${request.port}`, request.host]) {
      if (routes instanceof Map && routes.has(key)) return routes.get(key)
      if (routes && Object.hasOwn(routes, key)) return routes[key]
    }
    if (options.allowedTargetPorts?.includes(request.port)) return { host: '127.0.0.1', port: request.port }
    return null
  }
  const server = net.createServer((socket) => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
    socket.on('error', () => {})
    if (closing) { socket.destroy(); return }
    state.accepted++
    if (state.mode === 'drop') { socket.destroy(); return }
    const reader = new Reader(socket)
    void (async () => {
      const greeting = await reader.read(2)
      assert.equal(greeting[0], 5)
      const methods = [...await reader.read(greeting[1])]
      state.greetings.push(methods)
      if (!methods.includes(2)) { socket.end(Buffer.from([5, 255])); return }
      if (state.mode === 'stall-greeting') return
      socket.write(Buffer.from([5, 2]))
      const auth = await reader.read(2)
      assert.equal(auth[0], 1)
      const username = (await reader.read(auth[1])).toString('utf8')
      const passwordLength = (await reader.read(1))[0]
      const password = (await reader.read(passwordLength)).toString('utf8')
      state.authentications.push({ username, password })
      if (state.mode === 'stall-auth') return
      const accepted = options.acceptCredentials
        ? options.acceptCredentials({ username, password })
        : username === credentials.username && password === credentials.password
      if (state.mode === 'reject-auth' || !accepted) { socket.end(Buffer.from([1, 1])); return }
      socket.write(Buffer.from([1, 0]))
      const header = await reader.read(4)
      assert.equal(header[0], 5)
      assert.equal(header[1], 1)
      let host
      if (header[3] === 3) host = (await reader.read((await reader.read(1))[0])).toString('utf8')
      else if (header[3] === 1) host = [...await reader.read(4)].join('.')
      else if (header[3] === 4) {
        const bytes = await reader.read(16)
        host = Array.from({ length: 8 }, (_, index) => bytes.readUInt16BE(index * 2).toString(16)).join(':')
      } else throw new Error('Unsupported fixture address type')
      const port = (await reader.read(2)).readUInt16BE()
      const request = { host, port, addressType: header[3] }
      state.requests.push(request)
      if (state.mode === 'stall-connect') return
      if (state.mode === 'refuse') { socket.end(reply(5)); return }
      const route = routeFor(request)
      if (!route) { socket.end(reply(4)); return }
      const address = route.host || '127.0.0.1'
      assert.ok(address === '127.0.0.1' || address === '::1', 'SOCKS test targets must be loopback')
      assert.ok(Number.isInteger(route.port) && route.port > 0 && route.port <= 65535, 'Invalid local target port')
      if (closing || socket.destroyed) return
      const destination = net.createConnection({ host: address, port: route.port })
      state.destinations.add(destination)
      destination.on('error', () => socket.destroy())
      destination.on('close', () => { state.destinations.delete(destination); socket.destroy() })
      socket.on('close', () => destination.destroy())
      await once(destination, 'connect')
      socket.write(reply(0))
      const buffered = reader.release()
      if (buffered.length) destination.write(buffered)
      socket.pipe(destination)
      destination.pipe(socket)
    })().catch((error) => {
      if (error.code === 'ERR_ASSERTION') state.failures.push(error)
      socket.destroy()
    })
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  function dropConnections() {
    for (const socket of [...sockets, ...state.destinations]) socket.destroy()
  }
  function close() {
    if (closePromise) return closePromise
    closing = true
    closePromise = (async () => {
      const closed = [...sockets, ...state.destinations].map((socket) => new Promise((resolve) => socket.once('close', resolve)))
      const stopped = new Promise((resolve) => server.close(resolve))
      dropConnections()
      await Promise.all([stopped, ...closed])
    })()
    return closePromise
  }
  return {
    port: server.address().port, host: '127.0.0.1', server, sockets, state,
    get credentials() { return { ...credentials } },
    observedDestinations: state.requests,
    observedAuthentications: state.authentications,
    setMode(mode) { state.mode = mode },
    setCredentials(value) { credentials = { ...value } },
    dropConnections, close, stop: close
  }
}

module.exports = { startBrowserProxyFixture }
