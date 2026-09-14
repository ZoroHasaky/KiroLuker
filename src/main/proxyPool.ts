// 提链代理池：生成订阅支付链接前，从池接口取一个一次性出口 IP
//
// 池接口按来源 IP 做白名单鉴权，拉取动作本身必须经用户配置的可信 HTTP 代理发出；
// 取到的 IP:port 是短期有效的一次性代理端点，只用于单次 Kiro 请求。
// 获取与去重历史全程串行：并发提链时依次取 IP，既避免撞到重复 IP，也避免触发池方限流。
import { isIP } from 'node:net'
import { ProxyAgent, request } from 'undici'
import Store from 'electron-store'
import { normalizeProxyUrl } from './net'
import type { AppSettings } from '../shared/types'

const API_RESPONSE_LIMIT = 4096
const API_TIMEOUT_MS = 20_000
/** 单次获取能容忍的连续重复次数，超过即视为最近 N 个 IP 已耗尽 */
const MAX_FETCH_ATTEMPTS = 5
const HISTORY_SIZE_MAX = 100

export interface PoolEndpoint {
  host: string
  port: number
}

/** 严格解析池接口响应：只接受恰好一个 IP:port，错误页、重定向内容、多行结果一律拒绝。 */
export function parsePoolEndpoint(body: string): PoolEndpoint {
  const value = body.trim()
  const ipv4 = /^(\d{1,3}(?:\.\d{1,3}){3}):(\d{1,5})$/.exec(value)
  const ipv6 = /^\[([0-9a-f:]+)\]:(\d{1,5})$/i.exec(value)
  const match = ipv4 || ipv6
  if (!match || !isIP(match[1])) throw new Error('invalid endpoint')
  const port = Number(match[2])
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('invalid endpoint')
  return { host: match[1], port }
}

/** 端点转为可直连使用的 HTTP 代理地址。 */
export function poolProxyUrl(endpoint: PoolEndpoint): string {
  const host = endpoint.host.includes(':') ? `[${endpoint.host}]` : endpoint.host
  return `http://${host}:${endpoint.port}`
}

/** 一次提链出口的完整路由：请求经可信代理中转后从池 IP 发出。 */
export interface PoolProxyRoute {
  /** 池 IP 出口代理（请求最终经它发出） */
  proxyUrl: string
  /** 到池 IP 需先经过的可信代理（池端点按来源 IP 白名单鉴权）；空串表示池 IP 可直连 */
  viaUrl: string
}

/**
 * 去重决策：候选不在最近用过的历史里则接受，返回新历史（最近优先、已裁剪到 size）；
 * 与历史重复则返回 null，由调用方重试取下一个。
 */
export function acceptPoolEndpoint(
  historyList: readonly string[],
  endpoint: PoolEndpoint,
  size: number
): { key: string; history: string[] } | null {
  const key = poolProxyUrl(endpoint).replace('http://', '')
  if (historyList.includes(key)) return null
  return { key, history: [key, ...historyList].slice(0, Math.max(1, size)) }
}

// ============ 配置（由 applyRuntimeSettings 推送，与 net.ts 的 setProxyConfig 同一套范式） ============

let enabled = false
let apiUrl = ''
let apiProxy = ''
let historySize = 10

export function setProxyPoolConfig(settings: AppSettings): void {
  apiUrl = (settings.proxyPoolApiUrl || '').trim()
  enabled = !!settings.proxyPoolEnabled && !!apiUrl
  apiProxy = normalizeProxyUrl(settings.proxyPoolApiProxy || '')
  const size = Number(settings.proxyPoolHistorySize)
  historySize = Number.isFinite(size) ? Math.min(HISTORY_SIZE_MAX, Math.max(1, Math.round(size))) : 10
  // 窗口改小时立即收紧内存里的历史，下次落盘就是裁剪后的
  if (historyCache) historyCache = historyCache.slice(0, historySize)
  console.log(
    `[ProxyPool] ${enabled ? `enabled → ${apiUrl} via ${apiProxy || 'direct'} (history ${historySize})` : 'disabled'}`
  )
}

export function isProxyPoolEnabled(): boolean {
  return enabled
}

// ============ 去重历史（独立小 store：最近优先，最长 historySize） ============

interface PoolSchema {
  history: string[]
}

let poolStore: Store<PoolSchema> | null = null
let historyCache: string[] | null = null

/** 懒初始化：本模块会被纯 Node 测试经 subscriptionService 间接触达，import 阶段不能要求 Electron 环境。 */
function poolStoreRef(): Store<PoolSchema> {
  poolStore ??= new Store<PoolSchema>({ name: 'proxy-pool', defaults: { history: [] } })
  return poolStore
}

function loadHistory(): string[] {
  if (!historyCache) {
    const raw = poolStoreRef().get('history')
    historyCache = (
      Array.isArray(raw) ? raw.filter((item): item is string => typeof item === 'string') : []
    ).slice(0, historySize)
  }
  return historyCache
}

function persistHistory(next: string[]): void {
  historyCache = next
  poolStoreRef().set('history', next)
}

// ============ 池接口请求 ============

async function fetchPoolEndpoint(): Promise<PoolEndpoint> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), API_TIMEOUT_MS)
  // 一次性 agent：池接口按来源 IP 鉴权，必须强制经可信代理；用完即关，不进全局连接缓存
  const dispatcher = apiProxy ? new ProxyAgent(apiProxy) : undefined
  try {
    const response = await request(apiUrl, {
      ...(dispatcher ? { dispatcher } : {}),
      method: 'GET',
      headersTimeout: API_TIMEOUT_MS,
      bodyTimeout: API_TIMEOUT_MS,
      signal: controller.signal,
      headers: { accept: 'text/plain', 'cache-control': 'no-store' }
    })
    if (response.statusCode !== 200) throw new Error(`unexpected status ${response.statusCode}`)
    const chunks: Buffer[] = []
    let size = 0
    for await (const chunk of response.body) {
      const next = Buffer.from(chunk)
      size += next.length
      if (size > API_RESPONSE_LIMIT) throw new Error('response too large')
      chunks.push(next)
    }
    return parsePoolEndpoint(Buffer.concat(chunks).toString('utf8'))
  } catch (e) {
    // 不把 URL、响应体或代理细节带进用户可见的错误信息
    console.warn('[ProxyPool] 池接口请求失败:', e instanceof Error ? e.message : e)
    throw new Error(apiProxy ? '无法经可信代理访问代理池接口' : '无法访问代理池接口')
  } finally {
    clearTimeout(timer)
    if (dispatcher) await dispatcher.close().catch(() => undefined)
  }
}

// ============ 获取入口 ============

export type PoolFetcher = () => Promise<PoolEndpoint>

async function acquireOnce(fetcher: PoolFetcher): Promise<PoolProxyRoute> {
  const used = loadHistory()
  for (let attempt = 1; attempt <= MAX_FETCH_ATTEMPTS; attempt++) {
    const endpoint = await fetcher()
    const accepted = acceptPoolEndpoint(used, endpoint, historySize)
    if (!accepted) {
      console.warn(`[ProxyPool] 第 ${attempt}/${MAX_FETCH_ATTEMPTS} 次取到最近用过的 IP，重试`)
      continue
    }
    persistHistory(accepted.history)
    return { proxyUrl: poolProxyUrl(endpoint), viaUrl: apiProxy }
  }
  throw new Error(`代理池连续 ${MAX_FETCH_ATTEMPTS} 次返回最近用过的 IP，请稍后重试或调大去重窗口`)
}

let queue: Promise<unknown> = Promise.resolve()

/**
 * 取一个池出口路由。全程串行，任何失败直接抛错——
 * 池不可用时提链明确报错，绝不静默回退直连暴露本机出口。
 */
export function acquirePoolProxy(fetcher: PoolFetcher = fetchPoolEndpoint): Promise<PoolProxyRoute> {
  if (!enabled) return Promise.reject(new Error('代理池未启用'))
  const run = queue.then(() => acquireOnce(fetcher))
  queue = run.then(
    () => undefined,
    () => undefined
  )
  return run
}
