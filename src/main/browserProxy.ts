import { createServer, isIP, Socket, type Server as NetServer } from 'node:net'
import { Server as ProxyServer } from 'proxy-chain'
import { ProxyAgent, request } from 'undici'
import { validateBrowserProxy } from './browserConfig'
import type { BrowserResolvedConfig } from '../shared/browser'

export interface BrowserProxyBridge {
  proxyRules: string
  close(): Promise<void>
}

interface DynamicProxyEndpoint {
  host: string
  port: number
}

const API_RESPONSE_LIMIT = 4096
const CONNECT_HEADER_LIMIT = 16_384
const CONNECT_TIMEOUT_MS = 15_000
const API_TIMEOUT_MS = 20_000

function listen(server: NetServer): Promise<void> {
  return new Promise((resolve, reject) => {
    const failed = (): void => { reject(new Error('Could not start browser proxy bridge')) }
    server.once('error', failed)
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', failed)
      resolve()
    })
  })
}

function closeServer(server: NetServer | undefined): Promise<void> {
  return new Promise((resolve) => {
    if (!server?.listening) return resolve()
    server.close(() => resolve())
  })
}

function authority(host: string, port: number): string {
  return isIP(host) === 6 ? `[${host}]:${port}` : `${host}:${port}`
}

function parseDynamicEndpoint(body: string): DynamicProxyEndpoint {
  const value = body.trim()
  const ipv4 = /^(\d{1,3}(?:\.\d{1,3}){3}):(\d{1,5})$/.exec(value)
  const ipv6 = /^\[([0-9a-f:]+)\]:(\d{1,5})$/i.exec(value)
  const match = ipv4 || ipv6
  if (!match || !isIP(match[1])) throw new Error('invalid endpoint')
  const port = Number(match[2])
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('invalid endpoint')
  return { host: match[1], port }
}

/**
 * Fetch the one-time endpoint strictly through the configured local HTTP proxy. The
 * whitelist API response is deliberately parsed as exactly one IP:port; error pages,
 * redirects and arbitrary proxy URLs are never accepted or exposed.
 */
async function fetchDynamicEndpoint(proxy: BrowserResolvedConfig['proxy']): Promise<DynamicProxyEndpoint> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), API_TIMEOUT_MS)
  const dispatcher = new ProxyAgent(`http://${authority(proxy.apiProxyHost, proxy.apiProxyPort)}`)
  try {
    const response = await request(proxy.apiUrl, {
      dispatcher,
      method: 'GET',
      // undici request does not follow redirects unless a redirect interceptor is installed.
      headersTimeout: CONNECT_TIMEOUT_MS,
      bodyTimeout: CONNECT_TIMEOUT_MS,
      signal: controller.signal,
      headers: { accept: 'text/plain', 'cache-control': 'no-store' }
    })
    if (response.statusCode !== 200) throw new Error('unexpected status')
    const chunks: Buffer[] = []
    let size = 0
    for await (const chunk of response.body) {
      const next = Buffer.from(chunk)
      size += next.length
      if (size > API_RESPONSE_LIMIT) throw new Error('response too large')
      chunks.push(next)
    }
    return parseDynamicEndpoint(Buffer.concat(chunks).toString('utf8'))
  } catch {
    // Do not include URLs, response bodies or dispatcher errors: all may contain credentials.
    throw new Error('无法通过本机 HTTP 代理获取动态代理地址')
  } finally {
    clearTimeout(timer)
    await dispatcher.close().catch(() => undefined)
  }
}

/** One window, one loopback HTTP proxy; there is deliberately no DIRECT alternative. */
export async function createBrowserProxyBridge(input: BrowserResolvedConfig['proxy']): Promise<BrowserProxyBridge> {
  const proxy = validateBrowserProxy(input)
  if (!proxy.enabled) throw new Error('Browser proxy bridge requires an enabled upstream proxy')

  // Resolve before opening listeners so a failed/blocked whitelist API cannot leave a
  // half-started local proxy behind. Its HTTP request is forced through apiProxyHost.
  const dynamicEndpoint = proxy.mode === 'dynamic-http' ? await fetchDynamicEndpoint(proxy) : undefined
  let closing = false
  let closePromise: Promise<void> | undefined
  let relay: NetServer | undefined
  let forward: ProxyServer | undefined
  const sockets = new Set<Socket>()

  function track(socket: Socket): Socket {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
    return socket
  }

  function close(): Promise<void> {
    if (closePromise) return closePromise
    closing = true
    closePromise = (async () => {
      const relayClosed = closeServer(relay)
      const forwardClosed = forward ? forward.close(true).catch(() => undefined) : Promise.resolve()
      // Wait for close events, not just destroy(): outgoing sockets are not counted
      // by net.Server.close(), and the returned promise is a real cleanup boundary.
      const socketsClosed = [...sockets].map((socket) => new Promise<void>((resolve) => {
        socket.once('close', () => resolve())
        socket.destroy()
      }))
      await Promise.all([relayClosed, forwardClosed, ...socketsClosed])
    })()
    return closePromise
  }

  function bindPair(client: Socket, upstream: Socket): () => void {
    const destroyPair = (): void => { client.destroy(); upstream.destroy() }
    client.on('error', destroyPair)
    upstream.on('error', destroyPair)
    client.on('close', destroyPair)
    upstream.on('close', destroyPair)
    return destroyPair
  }

  /**
   * Make the required two-hop chain before proxy-chain sends any browser request:
   * browser -> loopback forward proxy -> this relay -> local HTTP proxy -> dynamic
   * HTTP proxy -> website. The relay is byte-transparent only after its CONNECT 200.
   */
  function relayThroughLocalHttpProxy(client: Socket, endpoint: DynamicProxyEndpoint): void {
    const upstream = track(new Socket())
    const destroyPair = bindPair(client, upstream)
    let header = Buffer.alloc(0)
    const onHandshakeData = (chunk: Buffer): void => {
      header = Buffer.concat([header, chunk])
      if (header.length > CONNECT_HEADER_LIMIT) return destroyPair()
      const end = header.indexOf('\r\n\r\n')
      if (end === -1) return
      upstream.off('data', onHandshakeData)
      const firstLine = header.subarray(0, end).toString('latin1').split('\r\n', 1)[0]
      if (!/^HTTP\/1\.[01]\s+200(?:\s|$)/i.test(firstLine)) return destroyPair()
      upstream.setTimeout(0)
      const remainder = header.subarray(end + 4)
      if (remainder.length) client.write(remainder)
      if (closing) return destroyPair()
      client.pipe(upstream)
      upstream.pipe(client)
    }
    upstream.on('data', onHandshakeData)
    upstream.setTimeout(CONNECT_TIMEOUT_MS, destroyPair)
    upstream.once('connect', () => {
      if (closing) return destroyPair()
      const target = authority(endpoint.host, endpoint.port)
      upstream.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\nProxy-Connection: keep-alive\r\n\r\n`)
    })
    upstream.connect(proxy.apiProxyPort, proxy.apiProxyHost)
  }

  try {
    // proxy-chain 3's SOCKS paths do not expose cancellation during the handshake.
    // The SOCKS branch owns every real upstream socket (including pending DNS/TCP
    // attempts). The dynamic branch first CONNECTs via the configured local proxy.
    relay = createServer((client) => {
      if (closing) { client.destroy(); return }
      track(client)
      if (dynamicEndpoint) {
        relayThroughLocalHttpProxy(client, dynamicEndpoint)
        return
      }
      const upstream = track(new Socket())
      const destroyPair = bindPair(client, upstream)
      upstream.setTimeout(CONNECT_TIMEOUT_MS, destroyPair)
      upstream.once('connect', () => upstream.setTimeout(0))
      upstream.connect(proxy.port, proxy.host)
      client.pipe(upstream)
      upstream.pipe(client)
    })
    relay.on('error', () => { void close() })
    await listen(relay)
    const address = relay.address()
    if (!address || typeof address === 'string' || closing) throw new Error()

    const credentials = proxy.username || proxy.password
      ? `${encodeURIComponent(proxy.username)}:${encodeURIComponent(proxy.password)}@`
      : ''
    // socks5h sends destination hostnames unchanged to the SOCKS server for REMOTE DNS.
    // Dynamic HTTP endpoints are reached only through the local HTTP relay above.
    const upstreamProxyUrl = dynamicEndpoint
      ? `http://127.0.0.1:${address.port}`
      : `socks5h://${credentials}127.0.0.1:${address.port}`
    forward = new ProxyServer({
      host: '127.0.0.1', port: 0, verbose: false,
      prepareRequestFunction: () => {
        if (closing) throw new Error('Browser proxy bridge is closed')
        return { upstreamProxyUrl }
      }
    })
    // Never log dependency errors: SocksClient errors carry an options object with creds.
    forward.log = () => undefined
    forward.on('requestFailed', () => undefined)
    await forward.listen()
    // Install after listen: the library's startup error handler must remove its
    // listeners before close() clears its server reference.
    forward.server.on('error', () => { void close() })
    if (closing) throw new Error()
    return { proxyRules: `http://127.0.0.1:${forward.port}`, close }
  } catch {
    await close()
    throw new Error('Could not start browser proxy bridge')
  }
}
