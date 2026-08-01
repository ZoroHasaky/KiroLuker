// Kiro API Key 网关（ksk_ 反向代理）
//
// 本地启动两个反向代理服务器，把 Kiro IDE 发来的请求凭证换成用户的 API Key
//（ksk_），剥离 profileArn，并转发到 Kiro 官方网关：
//   - runtime.{region}.kiro.dev     生成面（KRS：generateAssistantResponse 等）
//   - management.{region}.kiro.dev  控制面（CPS：模型列表、用量等）
// 认证方式：Authorization: Bearer ksk_...  +  tokentype: API_KEY，且请求体
// 不能带 profileArn（那属于 IDE 的 OAuth 登录，会让 ksk_ 被 403）。
//
// 本地代理默认使用 KRS 19830 / CPS 19831。
import * as http from 'http'
import * as https from 'https'
import * as fs from 'fs'
import * as path from 'path'
import * as crypto from 'crypto'
import { URL } from 'url'
import { app } from 'electron'
import { log } from './logger'

const HEALTH_PATH = '/__kiro_key_health'
const HEALTH_MARKER = 'kiro-manager-key-ok'
const HOP_BY_HOP = [
  'connection',
  'keep-alive',
  'transfer-encoding',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'upgrade'
]

// 对齐 Kiro IDE 的签名，上游只在 UA 带 KiroIDE 标记时才放行生成请求
const KIRO_VERSION = '0.9.2'
const KIRO_SYSTEM = 'darwin#24.6.0'
const KIRO_NODE = '22.21.1'

let _machineId = ''
/** 稳定的 64 位机器标识（持久化到 userData，跨重启不变） */
function machineId(): string {
  if (_machineId) return _machineId
  try {
    const file = path.join(app.getPath('userData'), 'key-gateway-machine-id')
    if (fs.existsSync(file)) {
      _machineId = fs.readFileSync(file, 'utf-8').trim()
    }
    if (!_machineId) {
      _machineId = crypto.randomBytes(32).toString('hex')
      fs.writeFileSync(file, _machineId, 'utf-8')
    }
  } catch {
    _machineId = crypto.randomBytes(32).toString('hex')
  }
  return _machineId
}

function kiroUserAgent(): string {
  return `aws-sdk-js/1.0.34 ua/2.1 os/${KIRO_SYSTEM} lang/js md/nodejs#${KIRO_NODE} api/codewhispererstreaming#1.0.34 m/E KiroIDE-${KIRO_VERSION}-${machineId()}`
}
function kiroXAmzUserAgent(): string {
  return `aws-sdk-js/1.0.34 KiroIDE-${KIRO_VERSION}-${machineId()}`
}

function runtimeBase(region: string): string {
  return `https://runtime.${region}.kiro.dev`
}
function managementBase(region: string): string {
  return `https://management.${region}.kiro.dev`
}

function maskKey(k: string): string {
  if (!k) return '(empty)'
  if (k.length <= 12) return k.slice(0, 4) + '***'
  return k.slice(0, 8) + '…' + k.slice(-4)
}

function stripHopByHop(headers: http.IncomingHttpHeaders): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {}
  for (const [k, v] of Object.entries(headers || {})) {
    if (HOP_BY_HOP.includes(k.toLowerCase())) continue
    if (v !== undefined) out[k] = v as string | string[]
  }
  return out
}

// ---- profileArn 剥离 ----
function scrubProfileArn(node: unknown): boolean {
  if (!node || typeof node !== 'object') return false
  let changed = false
  if (Array.isArray(node)) {
    for (const item of node) if (scrubProfileArn(item)) changed = true
    return changed
  }
  const obj = node as Record<string, unknown>
  if (Object.prototype.hasOwnProperty.call(obj, 'profileArn')) {
    delete obj.profileArn
    changed = true
  }
  for (const k of Object.keys(obj)) if (scrubProfileArn(obj[k])) changed = true
  return changed
}
function stripProfileArnFromBody(bodyBuf: Buffer): Buffer {
  if (!bodyBuf || !bodyBuf.length) return bodyBuf
  let j: unknown
  try {
    j = JSON.parse(bodyBuf.toString('utf8'))
  } catch {
    return bodyBuf
  }
  if (scrubProfileArn(j)) return Buffer.from(JSON.stringify(j), 'utf8')
  return bodyBuf
}

/** 构造转发到上游的请求头：保留原头，强制换成 API Key 凭证与标记 */
function injectAuthHeaders(
  incoming: http.IncomingHttpHeaders,
  targetHost: string,
  key: string
): Record<string, string | string[]> {
  const headers: Record<string, string | string[]> = {}
  for (const [k, v] of Object.entries(incoming || {})) {
    const lk = k.toLowerCase()
    if (lk === 'host' || lk === 'authorization' || lk === 'content-length' || lk === 'tokentype') continue
    if (HOP_BY_HOP.includes(lk)) continue
    if (v !== undefined) headers[k] = v as string | string[]
  }
  headers['host'] = targetHost
  headers['authorization'] = 'Bearer ' + key
  headers['tokentype'] = 'API_KEY'
  const has = (name: string): boolean => Object.keys(headers).some((h) => h.toLowerCase() === name)
  if (!has('x-amzn-kiro-agent-mode')) headers['x-amzn-kiro-agent-mode'] = 'vibe'
  const uaKey = Object.keys(headers).find((h) => h.toLowerCase() === 'user-agent')
  if (!uaKey || !/KiroIDE/i.test(String(headers[uaKey] || ''))) {
    headers[uaKey || 'user-agent'] = kiroUserAgent()
  }
  if (!has('x-amz-user-agent')) headers['x-amz-user-agent'] = kiroXAmzUserAgent()
  if (!has('x-amzn-codewhisperer-optout')) headers['x-amzn-codewhisperer-optout'] = 'true'
  return headers
}

// ---------------------------------------------------------------------------
// 直连 API 调用（测活 / 拉模型 / 查用量）
// ---------------------------------------------------------------------------
interface ApiResponse {
  statusCode: number
  body: string
}
function apiGet(base: string, urlPath: string, key: string): Promise<ApiResponse> {
  return new Promise((resolve, reject) => {
    let target: URL
    try {
      target = new URL(base + urlPath)
    } catch (e) {
      return reject(e as Error)
    }
    const req = https.request(
      {
        method: 'GET',
        hostname: target.hostname,
        port: 443,
        path: target.pathname + target.search,
        headers: {
          Accept: 'application/json',
          Authorization: 'Bearer ' + key,
          tokentype: 'API_KEY',
          'x-amzn-kiro-agent-mode': 'vibe',
          'user-agent': kiroUserAgent()
        },
        timeout: 30000
      },
      (res) => {
        const c: Buffer[] = []
        res.on('data', (d) => c.push(d))
        res.on('end', () => resolve({ statusCode: res.statusCode || 0, body: Buffer.concat(c).toString('utf8') }))
      }
    )
    req.on('error', reject)
    req.on('timeout', () => req.destroy(new Error('timeout')))
    req.end()
  })
}

export interface FetchedModels {
  defaultModel: string
  models: { id: string; name?: string; rate?: number }[]
}
export async function fetchModels(region: string, key: string): Promise<FetchedModels> {
  const res = await apiGet(managementBase(region), '/List-Available-Models?origin=AI_EDITOR&maxResults=200', key)
  if (res.statusCode < 200 || res.statusCode >= 300) {
    throw new Error('HTTP ' + res.statusCode + ': ' + res.body.slice(0, 200))
  }
  const data = JSON.parse(res.body)
  const rawModels = Array.isArray(data.models) ? [...data.models] : []
  const defaultModel = data?.defaultModel
  if (defaultModel?.modelId && !rawModels.some((model) => model?.modelId === defaultModel.modelId)) {
    rawModels.unshift(defaultModel)
  }
  return {
    defaultModel: defaultModel?.modelId || '',
    models: rawModels.map((m: Record<string, unknown>) => ({
      id: m.modelId as string,
      name: m.modelName as string,
      rate: m.rateMultiplier as number
    }))
  }
}
async function fetchUsageRaw(region: string, key: string): Promise<Record<string, unknown>> {
  const res = await apiGet(
    managementBase(region),
    // isEmailRequired=true 时上游会在 userInfo.email 里带上该 Key 绑定的注册邮箱
    '/Get-Usage-Limits?origin=AI_EDITOR&resourceType=AGENTIC_REQUEST&isEmailRequired=true',
    key
  )
  if (res.statusCode < 200 || res.statusCode >= 300) {
    throw new Error('HTTP ' + res.statusCode + ': ' + res.body.slice(0, 200))
  }
  return JSON.parse(res.body)
}

function pickNum(obj: Record<string, unknown> | null, keys: string[]): number | null {
  if (!obj || typeof obj !== 'object') return null
  for (const k of keys) {
    const v = obj[k]
    if (typeof v === 'number' && !Number.isNaN(v)) return v
    if (typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v))) return Number(v)
  }
  return null
}
function collectUsagePairs(node: unknown, out: { used: number | null; limit: number | null }[]): void {
  if (!node || typeof node !== 'object') return
  if (Array.isArray(node)) {
    for (const item of node) collectUsagePairs(item, out)
    return
  }
  const obj = node as Record<string, unknown>
  const used = pickNum(obj, ['currentUsageWithPrecision', 'currentUsage', 'usedCredits', 'used'])
  const limit = pickNum(obj, ['usageLimitWithPrecision', 'usageLimit', 'totalCredits', 'limit'])
  if (used != null || limit != null) out.push({ used, limit })
  for (const k of Object.keys(obj)) collectUsagePairs(obj[k], out)
}
export function tierFromTitle(title: string): string {
  const t = String(title || '').toLowerCase()
  if (!t) return ''
  if (t.includes('power')) return 'power'
  if (t.includes('pro+') || t.includes('pro plus') || t.includes('promax') || t.includes('pro max')) return 'pro+'
  if (t.includes('pro')) return 'pro'
  if (t.includes('free')) return 'free'
  return 'other'
}
export interface AccountInfo {
  subscriptionTitle: string
  tier: string
  used: number | null
  total: number | null
  /** 该 Key 绑定的注册邮箱，仅在上游返回时有值 */
  email: string | null
  /** 账号唯一标识，形如 d-<目录ID>.<用户UUID> */
  userId: string | null
  /** 额度下次重置时间戳（ms），上游未返回时为 null */
  nextResetAt: number | null
}

/**
 * 解析上游的额度重置时间。
 * 与账号侧同一个 Get-Usage-Limits 字段：数字按秒级 Unix 时间戳，字符串按日期串。
 */
function parseResetAt(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value * 1000
  if (typeof value === 'string' && value.trim()) {
    const parsed = new Date(value).getTime()
    return Number.isNaN(parsed) ? null : parsed
  }
  return null
}
export async function fetchAccountInfo(region: string, key: string): Promise<AccountInfo> {
  const data = await fetchUsageRaw(region, key)
  const sub = data?.subscriptionInfo as Record<string, unknown> | undefined
  const title = String(sub?.subscriptionTitle || sub?.subscriptionType || '')
  const user = data?.userInfo as Record<string, unknown> | undefined
  const email = typeof user?.email === 'string' && user.email.trim() ? user.email.trim() : null
  const userId = typeof user?.userId === 'string' && user.userId.trim() ? user.userId.trim() : null
  const pairs: { used: number | null; limit: number | null }[] = []
  collectUsagePairs(data, pairs)
  let used: number | null = null
  let total: number | null = null
  for (const p of pairs) {
    if (p.used != null) used = (used || 0) + p.used
    if (p.limit != null) total = (total || 0) + p.limit
  }
  return {
    subscriptionTitle: title,
    tier: tierFromTitle(title),
    used,
    total,
    email,
    userId,
    nextResetAt: parseResetAt(data?.nextDateReset)
  }
}

// ---------------------------------------------------------------------------
// 本地代理服务器
// ---------------------------------------------------------------------------
interface KeyCredential {
  id: string
  key: string
}
type KeyProvider = () => KeyCredential | null
type RegionProvider = () => string

export interface KeyGatewayObservation {
  lastForwardedKeyId: string | null
  lastForwardedAt?: number
}
type ObservationChanged = (observation: KeyGatewayObservation) => void | Promise<void>

let observation: KeyGatewayObservation = { lastForwardedKeyId: null }
let observationChanged: ObservationChanged | null = null

function clearObservation(): void {
  observation = { lastForwardedKeyId: null }
}

function recordForwarded(credential: KeyCredential): void {
  const keyChanged = observation.lastForwardedKeyId !== credential.id
  observation = {
    lastForwardedKeyId: credential.id,
    lastForwardedAt: Date.now()
  }
  if (!keyChanged || !observationChanged) return
  try {
    void Promise.resolve(observationChanged(getGatewayObservation())).catch((error) => {
      log('warn', `[KeyGateway] observation callback failed: ${error instanceof Error ? error.message : String(error)}`)
    })
  } catch (error) {
    log('warn', `[KeyGateway] observation callback failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}

export function getGatewayObservation(): KeyGatewayObservation {
  return { ...observation }
}

function forwardGeneric(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  label: string,
  baseFn: (region: string) => string,
  credential: KeyCredential,
  getRegion: RegionProvider
): void {
  const chunks: Buffer[] = []
  req.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)))
  req.on('error', () => undefined)
  req.on('end', () => {
    const bodyBuf = stripProfileArnFromBody(Buffer.concat(chunks))
    const region = getRegion()
    let target: URL
    try {
      target = new URL(baseFn(region) + req.url)
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ message: 'bad target url: ' + (e as Error).message }))
      return
    }
    const headers = injectAuthHeaders(req.headers, target.host, credential.key)
    if (bodyBuf.length) headers['content-length'] = String(Buffer.byteLength(bodyBuf))
    const keyTag = 'key (' + maskKey(credential.key) + ')'
    log('info', `[KeyGateway] -> [${label}] ${keyTag} ${req.method} ${(req.url || '').split('?')[0]} region=${region}`)

    // 到这里凭证已经注入即将发往上游，记录本次真实转发使用的不可变快照。
    recordForwarded(credential)
    const upReq = https.request(
      {
        method: req.method,
        hostname: target.hostname,
        port: 443,
        path: target.pathname + target.search,
        headers,
        timeout: 300000
      },
      (upRes) => {
        const status = upRes.statusCode || 0
        const okStatus = status >= 200 && status < 300
        log(okStatus ? 'info' : 'warn', `[KeyGateway] <- [${label}] ${keyTag} HTTP ${status}`)
        res.writeHead(status || 502, stripHopByHop(upRes.headers))
        upRes.pipe(res)
        upRes.on('error', () => {
          try {
            res.end()
          } catch {
            /* ignore */
          }
        })
      }
    )
    upReq.on('error', (e) => {
      log('error', `[KeyGateway] !! [${label}] upstream error: ${e.message}`)
      if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'application/json' })
      try {
        res.end(JSON.stringify({ message: 'upstream error: ' + e.message }))
      } catch {
        /* ignore */
      }
    })
    upReq.on('timeout', () => upReq.destroy(new Error('upstream timeout')))
    if (bodyBuf.length) upReq.write(bodyBuf)
    upReq.end()
  })
}

function makeGenericHandler(
  label: string,
  baseFn: (region: string) => string,
  getCredential: KeyProvider,
  getRegion: RegionProvider
): http.RequestListener {
  return function handle(req, res) {
    if (req.url === HEALTH_PATH) {
      res.writeHead(200, { 'Content-Type': 'text/plain' })
      res.end(HEALTH_MARKER)
      return
    }
    const credential = getCredential()
    if (!credential) {
      res.writeHead(401, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ message: 'Key 网关：未配置 API Key' }))
      return
    }
    forwardGeneric(req, res, label, baseFn, credential, getRegion)
  }
}

/** CPS 控制面：模型列表 / 用量可能以 awsJson（POST / + x-amz-target）方式请求，
 *  直接透传会 UnknownOperation 导致模型列表为空，这里显式识别并用 GET 应答。 */
function makeCpsHandler(getCredential: KeyProvider, getRegion: RegionProvider): http.RequestListener {
  return function handle(req, res) {
    if (req.url === HEALTH_PATH) {
      res.writeHead(200, { 'Content-Type': 'text/plain' })
      res.end(HEALTH_MARKER)
      return
    }
    // CPS 特例和普通透传共享同一份请求级凭证快照，不能在分支内二次读取。
    const credential = getCredential()
    if (!credential) {
      res.writeHead(401, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ message: 'Key 网关：未配置 API Key' }))
      return
    }
    const region = getRegion()
    const clean = (req.url || '/').split('?')[0]
    const amzTarget = String(req.headers['x-amz-target'] || req.headers['x-amzn-target'] || '')
    const norm = (s: string): string => String(s).replace(/[^a-z0-9]/gi, '').toLowerCase()
    const key = norm(clean) + '|' + norm(amzTarget)
    const isModels = key.includes('availablemodels')
    const isUsage = key.includes('usagelimit')
    const contentType = amzTarget ? 'application/x-amz-json-1.0' : 'application/json'

    if (isModels || isUsage) {
      req.resume()
      const upPath = isModels
        ? '/List-Available-Models?origin=AI_EDITOR&maxResults=200'
        : '/Get-Usage-Limits?origin=AI_EDITOR&resourceType=AGENTIC_REQUEST'
      const label = isModels ? 'ListAvailableModels' : 'GetUsageLimits'
      recordForwarded(credential)
      apiGet(managementBase(region), upPath, credential.key)
        .then((r) => {
          const okStatus = r.statusCode >= 200 && r.statusCode < 300
          log('info', `[KeyGateway] <- [CPS] ${label} HTTP ${r.statusCode}`)
          res.writeHead(okStatus ? 200 : r.statusCode, { 'Content-Type': contentType })
          res.end(r.body)
        })
        .catch((e) => {
          log('warn', `[KeyGateway] !! [CPS] ${label} failed: ${e.message}`)
          res.writeHead(200, { 'Content-Type': contentType })
          res.end(JSON.stringify(isModels ? { models: [] } : {}))
        })
      return
    }
    forwardGeneric(req, res, 'CPS', managementBase, credential, getRegion)
  }
}

/** 本地端口绑定器：首次绑定失败立即报错，绝不在端点已经改写后悄悄重试。 */
class ProxyServer {
  private server: http.Server | null = null

  constructor(
    public port: number,
    private handler: http.RequestListener,
    private label: string
  ) {}

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      const srv = http.createServer(this.handler)
      const onError = (error: NodeJS.ErrnoException): void => {
        srv.removeListener('listening', onListening)
        try {
          srv.close()
        } catch {
          /* ignore */
        }
        const detail = error.code === 'EADDRINUSE'
          ? `端口 ${this.port} 已被其它程序或本地网关占用`
          : `${this.label} 监听失败：${error.message}`
        log('error', `[KeyGateway] ${detail}`)
        reject(new Error(detail))
      }
      const onListening = (): void => {
        srv.removeListener('error', onError)
        // 绑定成功后仍保留运行期错误监听，避免未处理异常导致主进程退出
        srv.on('error', (error) => log('error', `[KeyGateway] [${this.label}] ${error.message}`))
        this.server = srv
        log('info', `[KeyGateway] [${this.label}] listening on 127.0.0.1:${this.port}`)
        resolve()
      }
      srv.once('error', onError)
      srv.once('listening', onListening)
      srv.listen(this.port, '127.0.0.1')
    })
  }

  isListening(): boolean {
    return !!this.server?.listening
  }

  stop(): void {
    if (!this.server) return
    try {
      this.server.close()
    } catch {
      /* ignore */
    }
    this.server = null
  }
}

// ---------------------------------------------------------------------------
// 网关生命周期：由 keyService 驱动
// ---------------------------------------------------------------------------
let krsServer: ProxyServer | null = null
let cpsServer: ProxyServer | null = null

/**
 * 先把两个端口都绑定成功，调用方才允许改写 settings.json。
 * 任意一个失败都会关闭另一个，保证不会留下半启动状态。
 */
export async function startGateway(
  krsPort: number,
  cpsPort: number,
  getCredential: KeyProvider,
  getRegion: RegionProvider,
  onObservationChanged?: ObservationChanged
): Promise<void> {
  if (krsPort === cpsPort) throw new Error('KRS 与 CPS 端口不能相同')
  if (gatewayRunning() && krsServer?.port === krsPort && cpsServer?.port === cpsPort) return
  stopGateway()
  clearObservation()
  observationChanged = onObservationChanged ?? null

  krsServer = new ProxyServer(
    krsPort,
    makeGenericHandler('KRS', runtimeBase, getCredential, getRegion),
    'KRS'
  )
  cpsServer = new ProxyServer(cpsPort, makeCpsHandler(getCredential, getRegion), 'CPS')
  try {
    // 顺序绑定可保证失败时没有仍在异步 listen 的“游离”服务器。
    await krsServer.start()
    await cpsServer.start()
  } catch (error) {
    stopGateway()
    throw error
  }
}

export function stopGateway(): void {
  if (krsServer) {
    krsServer.stop()
    krsServer = null
    log('info', '[KeyGateway] [KRS] stopped')
  }
  if (cpsServer) {
    cpsServer.stop()
    cpsServer = null
    log('info', '[KeyGateway] [CPS] stopped')
  }
  clearObservation()
  observationChanged = null
}

export function gatewayRunning(): boolean {
  return !!krsServer?.isListening() && !!cpsServer?.isListening()
}
