// 网络层：统一 fetch + 可选代理
import { isIPv6, Socket } from 'node:net'
import tls from 'node:tls'
import { Agent, ProxyAgent, fetch as undiciFetch, type Dispatcher, type RequestInit as UndiciRequestInit } from 'undici'

let proxyEnabled = false
let proxyUrl = ''

/**
 * 已创建的 ProxyAgent 缓存。
 * ProxyAgent 内部维护连接池，每个请求都新建一个等于放弃 keep-alive，
 * 批量刷新几百个账号时会退化成每次请求都重新握手。按目标地址复用即可。
 */
const agentCache = new Map<string, Dispatcher | null>()

/**
 * 规范化代理 URL，容错常见的手写格式：
 *   127.0.0.1:7890        → http://127.0.0.1:7890
 *   http:127.0.0.1:7890   → http://127.0.0.1:7890
 *   http:/127.0.0.1:7890  → http://127.0.0.1:7890
 */
export function normalizeProxyUrl(url: string): string {
  const trimmed = (url || '').trim()
  if (!trimmed) return ''
  if (/^[a-z][a-z0-9+\-.]*:\/\//i.test(trimmed)) return trimmed
  const m = trimmed.match(/^([a-z][a-z0-9+\-.]*):(\/*)(.+)$/i)
  if (m) return `${m[1]}://${m[3]}`
  return `http://${trimmed}`
}

/** 当前对外请求实际使用的代理地址，供自动更新器复用。 */
export function getEffectiveProxyUrl(): string {
  if (proxyEnabled && proxyUrl) return proxyUrl
  return normalizeProxyUrl(
    process.env.HTTPS_PROXY
      || process.env.https_proxy
      || process.env.HTTP_PROXY
      || process.env.http_proxy
      || ''
  )
}

/** 后台官网会话：仅显式应用代理覆盖 Chromium 系统代理。 */
export function getConfiguredProxyUrl(): string {
  return proxyEnabled ? proxyUrl : ''
}

export function setProxyConfig(enabled: boolean, url: string): void {
  proxyEnabled = enabled
  proxyUrl = normalizeProxyUrl(url)
  // 配置变了就丢弃旧连接池，下一次请求按新地址重建
  for (const agent of agentCache.values()) void agent?.close?.()
  agentCache.clear()
  console.log(`[Net] proxy ${enabled ? `enabled → ${proxyUrl}` : 'disabled'}`)
}

/** 取（或按需创建）指定代理地址的 agent，地址非法时缓存 null 避免反复重试。入参需已规范化 */
function agentFor(target: string): Dispatcher | undefined {
  if (!target) return undefined

  const cached = agentCache.get(target)
  if (cached !== undefined) return cached ?? undefined

  try {
    const agent = new ProxyAgent(target)
    agentCache.set(target, agent)
    return agent
  } catch (e) {
    console.warn('[Net] invalid proxy url:', target, e)
    agentCache.set(target, null)
    return undefined
  }
}

/** 优先用设置里的代理，未配置时回退系统环境变量 */
function currentAgent(): Dispatcher | undefined {
  return agentFor(getEffectiveProxyUrl())
}

/**
 * 单请求指定代理（提链代理池）的 agent 缓存。
 * 池 IP 是几分钟级的一次性端点，不能像全局代理那样随用随缓存不清理，
 * 用有界 FIFO：超出上限就关掉最旧条目，只保留少量以支持同 IP 重试的 keep-alive。
 */
const POOL_AGENT_CACHE_LIMIT = 8
const poolAgentCache = new Map<string, Dispatcher | null>()

/** 链式 CONNECT 的握手上限与超时，与 browserProxy 的桥接参数一致 */
const CHAIN_CONNECT_TIMEOUT_MS = 15_000
const CHAIN_HEADER_LIMIT = 16_384

/**
 * 在已连出的 socket 上发一次 CONNECT 并等 200（暂停模式读应答）。
 * 应答后的多余字节塞回流头，交给下一层（第二个 CONNECT 或 TLS）继续读。
 */
function connectThrough(
  socket: Socket,
  target: string,
  timeoutMs: number,
  onDone: (err: Error | null) => void
): void {
  let header = Buffer.alloc(0)
  let settled = false
  const finish = (err: Error | null): void => {
    if (settled) return
    settled = true
    clearTimeout(timer)
    socket.removeListener('readable', onReadable)
    socket.removeListener('error', onError)
    if (err) socket.destroy()
    onDone(err)
  }
  const timer = setTimeout(() => finish(new Error('chained connect timeout')), timeoutMs)
  const onReadable = (): void => {
    while (true) {
      const chunk = socket.read()
      if (chunk === null) return
      header = Buffer.concat([header, chunk])
      const end = header.indexOf('\r\n\r\n')
      if (end === -1) {
        if (header.length > CHAIN_HEADER_LIMIT) finish(new Error('chained connect header too large'))
        return
      }
      const firstLine = header.subarray(0, end).toString('latin1').split('\r\n', 1)[0]
      if (!/^HTTP\/1\.[01]\s+200(?:\s|$)/i.test(firstLine)) {
        finish(new Error(`代理拒绝 CONNECT（${target}）：${firstLine.slice(0, 120)}`))
        return
      }
      const remainder = header.subarray(end + 4)
      if (remainder.length) socket.unshift(remainder)
      finish(null)
      return
    }
  }
  const onError = (err: Error): void => finish(err)
  socket.on('readable', onReadable)
  socket.on('error', onError)
  socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\nProxy-Connection: keep-alive\r\n\r\n`)
}

/**
 * 池代理的链式 connector：socket 层自己完成「可信代理 → 池 IP → 目标」两跳 CONNECT，
 * https 目标再自行 TLS 包装后交还。整条流程与手工验证过的链路完全一致，
 * 不经过 undici ProxyAgent 的内层 Client（其对注入 socket 的消费存在不可靠的移交窗口）。
 */
function tunneledPoolConnector(viaUrl: string, poolHost: string, poolPort: number) {
  const via = new URL(viaUrl)
  const viaPort = Number(via.port) || (via.protocol === 'https:' ? 443 : 80)
  return (
    options: { hostname: string; port: string | number; protocol: string; servername?: string | null },
    callback: (err: Error | null, socket?: unknown) => void
  ): void => {
    const targetHost = isIPv6(options.hostname) ? `[${options.hostname}]` : options.hostname
    const target = `${targetHost}:${options.port || (options.protocol === 'https:' ? 443 : 80)}`
    const socket = new Socket()
    const fail = (err: Error): void => {
      socket.destroy()
      callback(err, undefined)
    }
    socket.once('connect', () => {
      // 第一跳：可信代理 → 池 IP（池端点按来源 IP 白名单鉴权，必须经可信代理中转）
      connectThrough(socket, `${isIPv6(poolHost) ? `[${poolHost}]` : poolHost}:${poolPort}`, CHAIN_CONNECT_TIMEOUT_MS, (err1) => {
        if (err1) return fail(err1)
        // 第二跳：池 IP → 目标
        connectThrough(socket, target, CHAIN_CONNECT_TIMEOUT_MS, (err2) => {
          if (err2) return fail(err2)
          if (options.protocol !== 'https:') {
            callback(null, socket)
            return
          }
          const tlsSocket = tls.connect({
            socket,
            host: options.hostname,
            port: Number(options.port) || 443,
            servername: options.servername || options.hostname,
            ALPNProtocols: ['http/1.1']
          })
          // 与 buildConnector 一致：回调只结一次，之后到达的 error 交给 undici 自己的挂接处理
          let tlsSettled = false
          tlsSocket.once('secureConnect', () => {
            if (tlsSettled) return
            tlsSettled = true
            callback(null, tlsSocket)
          })
          tlsSocket.on('error', (err3) => {
            if (tlsSettled) return
            tlsSettled = true
            // 池代理会在 CONNECT 回 200 后、出口连不上目标时再推送一段明文 HTTP 错误
            // （msg: connect proxy error）并断开：TLS 把它当握手包解析就报 wrong version
            // number。这里归因成可读的中文，别让用户看到莫名其妙的 fetch failed。
            const code = (err3 as NodeJS.ErrnoException).code
            if (code === 'ERR_SSL_WRONG_VERSION_NUMBER' || /disconnected before secure TLS/i.test(err3.message)) {
              callback(
                new Error('代理池出口无法连接目标（池在隧道建立后返回了错误应答）；请尝试更换池接口的区域参数（如 region=US）或稍后重试'),
                undefined
              )
              return
            }
            callback(err3, undefined)
          })
        })
      })
    })
    socket.once('error', (err) => fail(err as Error))
    socket.connect(viaPort, via.hostname)
  }
}

/** 造一个「经可信代理到池 IP」两跳出口的 Agent；每个池 IP 一个，由有界缓存管理生命周期 */
function tunneledPoolAgent(poolUrl: string, viaUrl: string): Dispatcher {
  const pool = new URL(poolUrl)
  return new Agent({
    connect: tunneledPoolConnector(viaUrl, pool.hostname, Number(pool.port) || 80) as never
  })
}

function poolAgentFor(target: string, viaUrl?: string): Dispatcher | undefined {
  const normalized = normalizeProxyUrl(target)
  if (!normalized) return undefined
  const via = viaUrl ? normalizeProxyUrl(viaUrl) : ''
  const cacheKey = via ? `${normalized}|${via}` : normalized

  const cached = poolAgentCache.get(cacheKey)
  if (cached !== undefined) return cached ?? undefined

  try {
    const agent = via ? tunneledPoolAgent(normalized, via) : new ProxyAgent(normalized)
    poolAgentCache.set(cacheKey, agent)
    if (poolAgentCache.size > POOL_AGENT_CACHE_LIMIT) {
      const oldest = poolAgentCache.keys().next().value
      if (oldest !== undefined && oldest !== cacheKey) {
        const dropped = poolAgentCache.get(oldest)
        poolAgentCache.delete(oldest)
        void dropped?.close?.()
      }
    }
    return agent
  } catch (e) {
    console.warn('[Net] invalid proxy url:', normalized, e)
    poolAgentCache.set(cacheKey, null)
    return undefined
  }
}

/** 组装 undici 请求参数：指定 proxyUrl 时强制走该代理（可再经 proxyViaUrl 中转），否则用全局代理 */
function buildInit(
  method: string,
  headers: Record<string, string> | undefined,
  body: string | Buffer | undefined,
  signal: AbortSignal,
  proxyUrl?: string,
  proxyViaUrl?: string
): UndiciRequestInit {
  const init: UndiciRequestInit = {
    method,
    headers,
    body: body as UndiciRequestInit['body'],
    signal
  }
  const agent = proxyUrl ? poolAgentFor(proxyUrl, proxyViaUrl) : currentAgent()
  if (agent) init.dispatcher = agent
  return init
}

export interface HttpResponse {
  ok: boolean
  status: number
  /** 跟随重定向后的最终地址，更新检查可据此解析最新 Release tag。 */
  url: string
  text: () => Promise<string>
  json: <T = unknown>() => Promise<T>
  arrayBuffer: () => Promise<ArrayBuffer>
}

export interface HttpStreamResponse {
  ok: boolean
  status: number
  /** 跟随重定向后的最终地址。 */
  url: string
  /** 服务端声明的响应体大小；未知时为 0。 */
  contentLength: number
  /** 响应体的字节流，调用方自己按协议解析（如 AWS event-stream） */
  body: ReadableStream<Uint8Array> | null
  text: () => Promise<string>
}

/**
 * 流式请求：不缓冲响应体，直接把字节流交给调用方。
 * 超时只约束「建立连接 + 首个响应头」，长连接读流阶段不设总时限，
 * 由调用方通过 signal 主动取消。
 */
export async function httpStream(
  url: string,
  options: {
    method?: string
    headers?: Record<string, string>
    body?: string | Buffer
    signal?: AbortSignal
    connectTimeoutMs?: number
  } = {}
): Promise<HttpStreamResponse> {
  const { method = 'POST', headers, body, signal, connectTimeoutMs = 30_000 } = options
  const controller = new AbortController()
  const onAbort = (): void => controller.abort(signal?.reason)
  if (signal) {
    if (signal.aborted) controller.abort(signal.reason)
    else signal.addEventListener('abort', onAbort, { once: true })
  }
  const timer = setTimeout(() => controller.abort(new Error('连接超时')), connectTimeoutMs)
  let bodyHandedOff = false
  const cleanup = (): void => {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
  }

  try {
    const res = await undiciFetch(url, buildInit(method, headers, body, controller.signal))
    // 响应头已到，后续读流不该再被连接超时打断
    clearTimeout(timer)
    const source = res.body as ReadableStream<Uint8Array> | null
    let responseBody: ReadableStream<Uint8Array> | null = null
    if (source) {
      const reader = source.getReader()
      bodyHandedOff = true
      // 把外部 signal 的监听保留到流读完，确保下载过程中仍可取消；
      // 同时在完成、报错或主动 cancel 后摘掉监听，避免长期泄漏。
      responseBody = new ReadableStream<Uint8Array>({
        async pull(streamController) {
          try {
            const chunk = await reader.read()
            if (chunk.done) {
              cleanup()
              streamController.close()
            } else {
              streamController.enqueue(chunk.value)
            }
          } catch (error) {
            cleanup()
            streamController.error(error)
          }
        },
        async cancel(reason) {
          cleanup()
          await reader.cancel(reason)
        }
      })
    }
    const readText = async (): Promise<string> => {
      if (!responseBody) return ''
      const streamReader = responseBody.getReader()
      const decoder = new TextDecoder()
      let result = ''
      while (true) {
        const chunk = await streamReader.read()
        if (chunk.done) break
        result += decoder.decode(chunk.value, { stream: true })
      }
      return result + decoder.decode()
    }
    return {
      ok: res.ok,
      status: res.status,
      url: res.url,
      contentLength: Number.parseInt(res.headers.get('content-length') || '0', 10) || 0,
      body: responseBody,
      text: readText
    }
  } catch (e) {
    cleanup()
    throw e
  } finally {
    if (!bodyHandedOff) cleanup()
  }
}

/** 带超时和代理的通用请求 */
export async function httpRequest(
  url: string,
  options: {
    method?: string
    headers?: Record<string, string>
    body?: string | Buffer
    timeoutMs?: number
    /** 敏感门户请求禁止自动重定向，避免临时凭证流向其他地址。 */
    redirect?: 'follow' | 'error' | 'manual'
    /** 强制本请求走指定代理（如提链代理池取到的池 IP），不回退全局代理。 */
    proxyUrl?: string
    /** 到指定代理需先经过的可信代理（池端点按来源 IP 白名单鉴权时的中转跳）。 */
    proxyViaUrl?: string
  } = {}
): Promise<HttpResponse> {
  const {
    method = 'GET',
    headers,
    body,
    timeoutMs = 30_000,
    redirect = 'follow',
    proxyUrl,
    proxyViaUrl
  } = options
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await undiciFetch(url, {
      ...buildInit(method, headers, body, controller.signal, proxyUrl, proxyViaUrl),
      redirect
    })
    return {
      ok: res.ok,
      status: res.status,
      url: res.url,
      text: () => res.text(),
      json: <T>() => res.json() as Promise<T>,
      arrayBuffer: () => res.arrayBuffer()
    }
  } finally {
    clearTimeout(timer)
  }
}
