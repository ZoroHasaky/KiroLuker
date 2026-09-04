// 网络层：统一 fetch + 可选代理
import { ProxyAgent, fetch as undiciFetch, type Dispatcher, type RequestInit as UndiciRequestInit } from 'undici'

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
function normalizeProxyUrl(url: string): string {
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

/** 组装 undici 请求参数，并挂上当前生效的代理 */
function buildInit(
  method: string,
  headers: Record<string, string> | undefined,
  body: string | Buffer | undefined,
  signal: AbortSignal
): UndiciRequestInit {
  const init: UndiciRequestInit = {
    method,
    headers,
    body: body as UndiciRequestInit['body'],
    signal
  }
  const agent = currentAgent()
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
  } = {}
): Promise<HttpResponse> {
  const { method = 'GET', headers, body, timeoutMs = 30_000 } = options
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await undiciFetch(url, buildInit(method, headers, body, controller.signal))
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
