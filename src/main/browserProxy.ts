import { createServer, Socket, type Server as NetServer } from 'node:net'
import { Server as ProxyServer } from 'proxy-chain'
import { validateBrowserProxy } from './browserConfig'
import type { BrowserResolvedConfig } from '../shared/browser'

export interface BrowserProxyBridge {
  proxyRules: string
  close(): Promise<void>
}

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

function closeServer(server: NetServer): Promise<void> {
  return new Promise((resolve) => {
    if (!server.listening) return resolve()
    server.close(() => resolve())
  })
}

/** One window, one loopback HTTP proxy; there is deliberately no DIRECT alternative. */
export async function createBrowserProxyBridge(input: BrowserResolvedConfig['proxy']): Promise<BrowserProxyBridge> {
  const proxy = validateBrowserProxy(input)
  if (!proxy.enabled) throw new Error('Browser proxy bridge requires an enabled upstream proxy')
  let closing = false
  let closePromise: Promise<void> | undefined
  let forward: ProxyServer | undefined
  const sockets = new Set<Socket>()

  function track(socket: Socket): Socket {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
    return socket
  }

  // proxy-chain 3's SOCKS paths do not expose cancellation during the handshake.
  // This byte-transparent relay owns every real upstream socket (including pending
  // DNS/TCP attempts). It implements NO SOCKS protocol and never resolves target DNS.
  const relay = createServer((client) => {
    if (closing) { client.destroy(); return }
    track(client)
    const upstream = track(new Socket())
    const destroyPair = (): void => { client.destroy(); upstream.destroy() }
    client.on('error', destroyPair)
    upstream.on('error', destroyPair)
    client.on('close', destroyPair)
    upstream.on('close', destroyPair)
    // Bound TCP connection establishment; SOCKS negotiation is bounded by the library.
    upstream.setTimeout(15_000, destroyPair)
    upstream.once('connect', () => upstream.setTimeout(0))
    upstream.connect(proxy.port, proxy.host)
    client.pipe(upstream)
    upstream.pipe(client)
  })

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

  relay.on('error', () => { void close() })
  try {
    await listen(relay)
    const address = relay.address()
    if (!address || typeof address === 'string' || closing) throw new Error()
    const credentials = proxy.username || proxy.password
      ? `${encodeURIComponent(proxy.username)}:${encodeURIComponent(proxy.password)}@`
      : ''
    // Official SOCKS support: https://github.com/apify/proxy-chain#socks-support
    // socks5h sends destination hostnames unchanged to the SOCKS server for REMOTE DNS.
    const upstreamProxyUrl = `socks5h://${credentials}127.0.0.1:${address.port}`
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
