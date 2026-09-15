// 提链代理池：生成订阅支付链接前，从池接口批量取一次性出口 IP，逐链接消费
//
// 池接口按来源 IP 做白名单鉴权，拉取动作本身必须经用户配置的可信 HTTP 代理发出；
// 取到的 IP:port 是短期有效的一次性代理端点。会话粘滞的池在同一窗口内反复单取
// 会一直返回同一个 IP（实测同一出口连续提链会被 Kiro 403），所以改为批量提取
// （num=N 一次返回 N 个互不相同的端点）+ 队列逐链接消费，绝不复用最近用过的 IP。
// 获取与去重历史全程串行：并发提链时依次取 IP，既避免撞到重复 IP，也避免触发池方限流。
import { isIP } from 'node:net'
import { ProxyAgent, request } from 'undici'
import Store from 'electron-store'
import { httpRequest, normalizeProxyUrl } from './net'
import { MAX_USES_PER_IP, countRecentUsage } from './poolUsageStore'
import type { AppSettings } from '../shared/types'

const API_RESPONSE_LIMIT = 4096
const API_TIMEOUT_MS = 20_000
const HISTORY_SIZE_MAX = 100
const BATCH_SIZE_MAX = 20

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

/** 历史记录里端点的键（与代理 URL 的 host:port 表示一致）。 */
function poolEndpointKey(endpoint: PoolEndpoint): string {
  return poolProxyUrl(endpoint).replace('http://', '')
}

/** 一次提链出口的完整路由：请求经可信代理中转后从池 IP 发出。 */
export interface PoolProxyRoute {
  /** 池 IP 出口代理（请求最终经它发出） */
  proxyUrl: string
  /** 到池 IP 需先经过的可信代理（池端点按来源 IP 白名单鉴权）；空串表示池 IP 可直连 */
  viaUrl: string
  /** 该端点的真实出口 IP（探测所得）：池端点 IP ≠ 实际出口，计次按它算 */
  exitIp: string
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
  const key = poolEndpointKey(endpoint)
  if (historyList.includes(key)) return null
  return { key, history: [key, ...historyList].slice(0, Math.max(1, size)) }
}

// ============ 配置（由 applyRuntimeSettings 推送，与 net.ts 的 setProxyConfig 同一套范式） ============

let enabled = false
let apiUrl = ''
let apiProxy = ''
let historySize = 10
let batchSize = 5

export function setProxyPoolConfig(settings: AppSettings): void {
  apiUrl = (settings.proxyPoolApiUrl || '').trim()
  enabled = !!settings.proxyPoolEnabled && !!apiUrl
  apiProxy = normalizeProxyUrl(settings.proxyPoolApiProxy || '')
  const size = Number(settings.proxyPoolHistorySize)
  historySize = Number.isFinite(size) ? Math.min(HISTORY_SIZE_MAX, Math.max(1, Math.round(size))) : 10
  const batch = Number(settings.proxyPoolBatchSize)
  batchSize = Number.isFinite(batch) ? Math.min(BATCH_SIZE_MAX, Math.max(1, Math.round(batch))) : 5
  // 窗口改小时立即收紧内存里的历史，下次落盘就是裁剪后的
  if (historyCache) historyCache = historyCache.slice(0, historySize)
  console.log(
    `[ProxyPool] ${enabled ? `enabled → ${apiUrl} via ${apiProxy || 'direct'} (history ${historySize}, batch ${batchSize})` : 'disabled'}`
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

// ============ 池接口请求（批量提取） ============

/**
 * 严格解析批量响应：每行恰好一个 IP:port，任何一行非法（错误页、空行以外
 * 的垃圾内容）都整体拒绝，避免把半截结果当可用端点。
 */
export function parsePoolEndpoints(body: string): PoolEndpoint[] {
  const lines = body.trim().split(/\r?\n/).filter(Boolean)
  if (!lines.length) throw new Error('invalid endpoint')
  return lines.map((line) => parsePoolEndpoint(line))
}

async function fetchPoolEndpoints(): Promise<PoolEndpoint[]> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), API_TIMEOUT_MS)
  // 一次性 agent：池接口按来源 IP 鉴权，必须强制经可信代理；用完即关，不进全局连接缓存
  const dispatcher = apiProxy ? new ProxyAgent(apiProxy) : undefined
  try {
    // 批量提取：一次拿一批互不相同的端点，逐链接消费，避免每条链接都撞上会话粘滞
    const url = new URL(apiUrl)
    url.searchParams.set('num', String(batchSize))
    const response = await request(url, {
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
    return parsePoolEndpoints(Buffer.concat(chunks).toString('utf8'))
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

export type PoolFetcher = () => Promise<PoolEndpoint[]>

/** 队列里缓存的批量端点；time 参数决定有效期，过期弃用 */
interface QueuedEndpoint {
  endpoint: PoolEndpoint
  fetchedAt: number
}

let endpointQueue: QueuedEndpoint[] = []

/** 池 URL 里 time 参数（分钟）决定的端点有效期；留 1 分钟安全余量 */
function endpointTtlMs(): number {
  let minutes = 10
  try {
    const parsed = Number(new URL(apiUrl).searchParams.get('time'))
    if (Number.isFinite(parsed) && parsed > 0) minutes = parsed
  } catch {
    // URL 无效时真正的请求会失败，这里先按默认估
  }
  return Math.max(1_000, minutes * 60_000 - 60_000)
}

/** 从队列头部取一个未用过且未过期的端点；顺手清掉过期条目 */
function popFreshEndpoint(used: readonly string[]): PoolEndpoint | null {
  const now = Date.now()
  const ttl = endpointTtlMs()
  endpointQueue = endpointQueue.filter((item) => now - item.fetchedAt < ttl)
  while (endpointQueue.length) {
    const item = endpointQueue.shift()!
    if (!used.includes(poolEndpointKey(item.endpoint))) return item.endpoint
  }
  return null
}

/** 批量提取最多重试次数：每次尝试都消耗池的提取配额，见好就收 */
const MAX_BATCH_ATTEMPTS = 2
/** 出口探测超时；探测打到 ipify，不打 Kiro、不占提链计次 */
const EXIT_PROBE_TIMEOUT_MS = 15_000

/** 端点 → 真实出口缓存：同一端点会话期内只探测一次，避免重复打 ipify */
const exitIpCache = new Map<string, { ip: string; at: number }>()

/** 经池端点两跳链探测真实出口 IP */
async function probeExitIp(proxyUrl: string): Promise<string> {
  let body = ''
  try {
    const response = await httpRequest('https://api.ipify.org/', {
      ...(apiProxy ? { proxyViaUrl: apiProxy } : {}),
      proxyUrl,
      timeoutMs: EXIT_PROBE_TIMEOUT_MS
    })
    body = (await response.text()).trim()
    if (response.status === 200 && isIP(body)) return body
    throw new Error(`探测服务返回异常（HTTP ${response.status}）`)
  } catch (e) {
    const cause = (e as { cause?: unknown }).cause
    const detail = cause instanceof Error ? cause.message : e instanceof Error ? e.message : ''
    throw new Error(`无法确认池出口 IP${detail ? `：${detail}` : ''}`)
  }
}

async function resolveExitIp(endpoint: PoolEndpoint): Promise<string> {
  const key = poolEndpointKey(endpoint)
  const cached = exitIpCache.get(key)
  if (cached && Date.now() - cached.at < endpointTtlMs()) return cached.ip
  const ip = await probeExitIp(poolProxyUrl(endpoint))
  exitIpCache.set(key, { ip, at: Date.now() })
  return ip
}

async function acquireOnce(fetcher: PoolFetcher): Promise<PoolProxyRoute> {
  const used = loadHistory()
  const exhaustedExits = new Set<string>()
  let probeFailed = false

  /** 出口探测与计次检查：探测失败（端点过期/出口不稳）或出口用满都弃用该端点，换下一个 */
  const tryEndpoint = async (endpoint: PoolEndpoint): Promise<PoolProxyRoute | null> => {
    let exitIp: string
    try {
      exitIp = await resolveExitIp(endpoint)
    } catch (e) {
      probeFailed = true
      console.warn(`[ProxyPool] ${poolEndpointKey(endpoint)} 出口探测失败（${e instanceof Error ? e.message : e}），换下一个端点`)
      return null
    }
    if (countRecentUsage(exitIp) >= MAX_USES_PER_IP) {
      exhaustedExits.add(exitIp)
      console.warn(
        `[ProxyPool] 出口 ${exitIp} 24 小时内已提链 ${MAX_USES_PER_IP} 次，弃用端点 ${poolEndpointKey(endpoint)}`
      )
      return null
    }
    return recordAndRoute(used, endpoint, exitIp)
  }

  while (true) {
    const endpoint = popFreshEndpoint(used)
    if (!endpoint) break
    const route = await tryEndpoint(endpoint)
    if (route) return route
  }

  for (let attempt = 1; attempt <= MAX_BATCH_ATTEMPTS; attempt++) {
    const endpoints = await fetcher()
    let fresh = 0
    for (const endpoint of endpoints) {
      if (used.includes(poolEndpointKey(endpoint))) continue
      endpointQueue.push({ endpoint, fetchedAt: Date.now() })
      fresh++
    }
    console.info(
      `[ProxyPool] 批量取得 ${endpoints.length} 个端点，其中 ${fresh} 个未用过${apiProxy ? `（经 ${apiProxy} 中转）` : ''}`
    )
    while (true) {
      const endpoint = popFreshEndpoint(used)
      if (!endpoint) break
      const route = await tryEndpoint(endpoint)
      if (route) return route
    }
    console.warn(`[ProxyPool] 第 ${attempt}/${MAX_BATCH_ATTEMPTS} 次批量提取的端点全部不可用（重复、出口已用满或探测失败），重试`)
  }
  if (exhaustedExits.size) {
    throw new Error(
      `代理池未能提供 24 小时内未超额的出口 IP（已用满的出口：${[...exhaustedExits].join('、')}），请稍后重试`
    )
  }
  if (probeFailed) {
    throw new Error('代理池端点均无法确认可用出口（探测失败或会话过期），请稍后重试')
  }
  // 不复用最近用过的 IP：实测同一出口连续提链会被 Kiro 403，宁可失败也不撞
  throw new Error('代理池未能提供未用过的 IP（会话未轮换），请稍后重试或调大每次提取数量')
}

function recordAndRoute(used: readonly string[], endpoint: PoolEndpoint, exitIp: string): PoolProxyRoute {
  const accepted = acceptPoolEndpoint(used, endpoint, historySize)
  if (!accepted) throw new Error('代理池未能提供未用过的 IP，请稍后重试')
  persistHistory(accepted.history)
  console.info(`[ProxyPool] 取得出口 ${accepted.key}（实际出口 ${exitIp}）${apiProxy ? `（经 ${apiProxy} 中转）` : ''}`)
  return { proxyUrl: poolProxyUrl(endpoint), viaUrl: apiProxy, exitIp }
}

let acquireChain: Promise<unknown> = Promise.resolve()

/**
 * 取一个池出口路由。全程串行，任何失败直接抛错——
 * 池不可用时提链明确报错，绝不静默回退直连暴露本机出口。
 */
export function acquirePoolProxy(fetcher: PoolFetcher = fetchPoolEndpoints): Promise<PoolProxyRoute> {
  if (!enabled) return Promise.reject(new Error('代理池未启用'))
  const run = acquireChain.then(() => acquireOnce(fetcher))
  acquireChain = run.then(
    () => undefined,
    () => undefined
  )
  return run
}
