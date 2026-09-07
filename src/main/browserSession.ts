import { randomUUID } from 'node:crypto'
import { session, type Session } from 'electron'
import type { BrowserProxyCheck, BrowserResolvedConfig } from '../shared/browser'
import { acceptLanguageFor } from '../shared/portalLocale'
import { configurePortalSession } from './kiroPortalSession'
import { createBrowserProxyBridge } from './browserProxy'
import { parseBrowserProxyTrace } from './browserPolicy'

export interface BrowserSessionResource {
  session: Session
  check?: BrowserProxyCheck
  close(): Promise<void>
}

export const BROWSER_IP_CHECK_URL = 'https://www.cloudflare.com/cdn-cgi/trace'

function interrupted(): Error { return new Error('浏览器操作已中断') }
function checkAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw interrupted()
}

/** Consume late failures too: a dependency may settle after cancellation wins. */
function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const remove = (): void => signal.removeEventListener('abort', onAbort)
    const onAbort = (): void => { remove(); reject(interrupted()) }
    Promise.resolve(work).then((value) => {
      remove()
      if (signal.aborted) reject(interrupted())
      else resolve(value)
    }, (error) => {
      remove()
      reject(signal.aborted ? interrupted() : error)
    })
    if (signal.aborted) onAbort()
    else signal.addEventListener('abort', onAbort, { once: true })
  })
}

/** Cleanup must not leak dependency errors or wait forever for a stream's cancel(). */
function discard(action: () => unknown): void {
  try { void Promise.resolve(action()).catch(() => undefined) } catch { /* Best effort; never expose raw errors. */ }
}
const cleanupTask = (action: () => unknown): Promise<unknown> => Promise.resolve().then(action)

export async function probeBrowserProxy(
  ses: Session,
  url = BROWSER_IP_CHECK_URL,
  signal?: AbortSignal
): Promise<BrowserProxyCheck> {
  checkAborted(signal)
  const started = Date.now()
  const controller = new AbortController()
  const onAbort = (): void => controller.abort()
  signal?.addEventListener('abort', onAbort, { once: true })
  const timer = setTimeout(() => controller.abort(), 20000)
  let cancelBody: (() => unknown) | undefined
  let releaseReader: (() => void) | undefined
  let succeeded = false
  try {
    // Cover an abort during listener registration as well as a pre-aborted caller.
    if (signal?.aborted) controller.abort()
    checkAborted(controller.signal)
    const fetching = Promise.resolve().then(() => {
      checkAborted(controller.signal)
      return ses.fetch(url, {
        credentials: 'omit', headers: { 'Cache-Control': 'no-store' }, redirect: 'error', signal: controller.signal
      })
    }).then((response) => {
      // Claim the body before the awaiting continuation: cancellation can win in
      // that microtask gap, including with a non-cooperative transport.
      cancelBody = () => response.body?.cancel()
      if (controller.signal.aborted) {
        // A non-cooperative fetch may return a body after the operation has ended.
        discard(cancelBody)
        cancelBody = undefined
        throw interrupted()
      }
      return response
    })
    const response = await abortable(fetching, controller.signal)
    cancelBody = () => response.body?.cancel()
    if (!response.ok) throw new Error('status')
    const reader = response.body?.getReader()
    if (!reader) throw new Error('empty')
    cancelBody = () => reader.cancel()
    releaseReader = () => reader.releaseLock()
    const chunks: Uint8Array[] = []
    let size = 0
    for (;;) {
      checkAborted(controller.signal)
      // The deadline also covers a reader that does not react to fetch's signal.
      const { value, done } = await abortable(reader.read(), controller.signal)
      if (done) break
      size += value.length
      if (size > 16384) throw new Error('oversize')
      chunks.push(value)
    }
    checkAborted(controller.signal)
    const result = parseBrowserProxyTrace(Buffer.concat(chunks).toString('utf8'), Date.now() - started)
    succeeded = true
    return result
  } catch {
    controller.abort()
    if (signal?.aborted) throw interrupted()
    throw new Error('[代理检测] 无法通过 SOCKS5 获取出口 IP，请检查代理、认证及网络；未回退直连')
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
    if (!succeeded && cancelBody) discard(cancelBody)
    if (releaseReader) discard(releaseReader)
  }
}

/** A new, non-persistent partition AND proxy bridge for every attempt/window. */
export async function createBrowserSession(
  config: BrowserResolvedConfig,
  options: { probeUrl?: string; bridge?: typeof createBrowserProxyBridge; signal?: AbortSignal } = {}
): Promise<BrowserSessionResource> {
  checkAborted(options.signal)
  const ses = session.fromPartition(`browser-web-${randomUUID()}`, { cache: false })
  const lifetime = new AbortController()
  const probeUrl = options.probeUrl || BROWSER_IP_CHECK_URL
  let bridge: Awaited<ReturnType<typeof createBrowserProxyBridge>> | undefined
  let closing = false
  let closed: Promise<void> | undefined
  const onAbort = (): void => { void close().catch(() => undefined) }
  const close = (): Promise<void> => {
    if (closed) return closed
    closing = true
    options.signal?.removeEventListener('abort', onAbort)
    // Stop admitting requests before cancelling pending work or releasing proxy ports.
    try { ses.webRequest.onBeforeRequest((_details, callback) => callback({ cancel: true })) } catch { /* Still attempt every cleanup. */ }
    lifetime.abort()
    closed = (async () => {
      // Deferring each invocation also isolates synchronous native/provider exceptions.
      await Promise.allSettled([
        cleanupTask(() => bridge?.close()), cleanupTask(() => ses.closeAllConnections())
      ])
      // The manager may have installed closures capturing window/tab records. Remove
      // them only after stopping network; keep the all-deny request gate installed.
      await Promise.allSettled([
        cleanupTask(() => ses.webRequest.onHeadersReceived(null)),
        cleanupTask(() => ses.webRequest.onBeforeSendHeaders(null)),
        cleanupTask(() => ses.clearStorageData()), cleanupTask(() => ses.clearCache()),
        cleanupTask(() => ses.clearAuthCache())
      ])
    })()
    return closed
  }
  options.signal?.addEventListener('abort', onAbort, { once: true })
  try {
    if (options.signal?.aborted) onAbort()
    checkAborted(lifetime.signal)
    ses.setSpellCheckerEnabled(false)
    // During startup only the explicit IP probe may use this session. This does not
    // add popup/request/header gating after the manager takes ownership of the session.
    ses.webRequest.onBeforeRequest((details, callback) => callback({ cancel: details.url !== probeUrl }))
    if (config.proxy.enabled) {
      try {
        const creating = Promise.resolve().then(() => {
          checkAborted(lifetime.signal)
          return (options.bridge || createBrowserProxyBridge)(config.proxy)
        }).then((created) => {
          if (closing || lifetime.signal.aborted) {
            discard(() => created.close())
            throw interrupted()
          }
          // Transfer ownership before the await resumes so an intervening abort
          // always finds this bridge; late arrivals instead take the disposal path.
          bridge = created
          return created
        })
        const ready = await abortable(creating, lifetime.signal)
        checkAborted(lifetime.signal)
        await abortable(ses.setProxy({ mode: 'fixed_servers', proxyRules: ready.proxyRules, proxyBypassRules: '<-loopback>' }), lifetime.signal)
      } catch {
        if (lifetime.signal.aborted) throw interrupted()
        throw new Error('[代理连接] SOCKS5 转接启动失败；未回退直连')
      }
    } else {
      await abortable(ses.setProxy({ mode: 'system' }), lifetime.signal)
    }
    checkAborted(lifetime.signal)
    configurePortalSession(ses, {
      userAgent: config.fingerprint.userAgent || undefined,
      acceptLanguage: acceptLanguageFor(config.fingerprint.language)
    })
    ses.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
    ses.setPermissionCheckHandler(() => false)
    ses.on('will-download', (event) => event.preventDefault())
    const check = config.proxy.enabled ? await probeBrowserProxy(ses, probeUrl, lifetime.signal) : undefined
    checkAborted(lifetime.signal)
    return { session: ses, check, close }
  } catch (error) {
    const wasInterrupted = lifetime.signal.aborted || options.signal?.aborted
    await close()
    if (wasInterrupted || options.signal?.aborted) throw interrupted()
    throw error
  }
}
