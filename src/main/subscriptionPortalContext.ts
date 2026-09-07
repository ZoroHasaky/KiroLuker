import { randomUUID } from 'crypto'
import { session as electronSession } from 'electron'
import { encode, decode } from 'cbor-x'
import { configurePortalSession, initializePortalSession, KIRO_PORTAL_ORIGIN } from './kiroPortalSession'
import { getConfiguredProxyUrl } from './net'
import { KIRO_BUILDER_ID_PLACEHOLDER_ARN, KIRO_SOCIAL_PROFILE_ARN } from './kiroAuth'
import type { Account } from '../shared/types'

export type PortalStage = 'session' | 'management' | 'redirect' | 'portal' | 'read' | 'switch' | 'verify'
const STAGES: Record<PortalStage, string> = {
  session: '官网会话初始化', management: '生成管理链接', redirect: '跳转校验',
  portal: '读取 Stripe 门户', read: '读取订阅', switch: '提交变更', verify: '提交后复核'
}
const ALLOWED_ORIGINS = new Set(['https://app.kiro.dev', 'https://kiro.dev', 'https://billing.stripe.com'])
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024

export class SubscriptionPortalError extends Error {
  constructor(public readonly stage: PortalStage, detail: string, public readonly httpStatus?: number, public readonly authExpired = false) {
    super(`[${STAGES[stage]}] ${detail}`)
    this.name = 'SubscriptionPortalError'
  }
}

export function validateManagementUrl(value: string, stage: PortalStage = 'redirect'): URL {
  let url: URL
  try { url = new URL(value) } catch { throw new SubscriptionPortalError(stage, '管理链接格式无效') }
  if (!ALLOWED_ORIGINS.has(url.origin) || url.username || url.password) {
    throw new SubscriptionPortalError(stage, '链接不是允许的 HTTPS Kiro / Stripe 官方地址')
  }
  return url
}

/** 地址可能把 secret 放在任意路径或查询中；只保留固定协议路径段。 */
export function redactedPortalUrl(value: string): string {
  try {
    const url = new URL(value)
    const publicSegments = new Set(['', 'p', 'session', 'v1', 'billing_portal', 'sessions',
      'subscriptions', 'service', 'KiroWebPortalService', 'operation', 'GenerateSubscriptionManagementUrl',
      'GetUserInfo', 'GetUserUsageAndLimits', 'account', 'usage', 'signin'])
    return url.origin + url.pathname.split('/').map(s => publicSegments.has(s) ? s : ':redacted').join('/') +
      (url.search ? '?[redacted]' : '')
  } catch { return '[invalid-url]' }
}

function decodeHtml(value: string): string {
  return value.replace(/&(?:quot|apos|amp|lt|gt|#\d+|#x[\da-f]+);/gi, entity => {
    const named: Record<string, string> = { '&quot;': '"', '&apos;': "'", '&amp;': '&', '&lt;': '<', '&gt;': '>' }
    if (entity[1] !== '#') return named[entity.toLowerCase()] ?? entity
    const hex = entity[2].toLowerCase() === 'x'
    const code = parseInt(entity.slice(hex ? 3 : 2, -1), hex ? 16 : 10)
    return code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : entity
  })
}

export function parsePortalMetadata(html: string): Record<string, string> {
  const result: Record<string, string> = {}
  const allowed = new Set(['csrf-token', 'user-status', 'user-id', 'idp', 'profile-arn'])
  for (const match of html.matchAll(/<meta\b[^>]*>/gi)) {
    const attributes: Record<string, string> = {}
    for (const attr of match[0].matchAll(/([\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
      attributes[attr[1].toLowerCase()] = decodeHtml(attr[2] ?? attr[3])
    }
    if (allowed.has(attributes.name)) result[attributes.name] = attributes.content ?? ''
  }
  return result
}

export interface PortalResponse {
  ok: boolean
  status: number
  headers: { get(name: string): string | null }
  text(): Promise<string>
  json<T = unknown>(): Promise<T>
  arrayBuffer(): Promise<ArrayBuffer>
}
export interface PortalRequestOptions {
  method?: 'GET' | 'POST'
  headers?: Record<string, string>
  body?: string | Uint8Array
  stage?: PortalStage
}
export type ReadOnlyKiroOperation = 'GenerateSubscriptionManagementUrl' | 'GetUserInfo' | 'GetUserUsageAndLimits'
export interface SubscriptionPortalContext {
  request(url: string, options?: PortalRequestOptions): Promise<PortalResponse>
  generateManagementUrl(): Promise<string>
  callKiro<T>(operation: ReadOnlyKiroOperation, body?: Record<string, unknown>): Promise<T>
  close(): Promise<void>
}
interface ContextDependencies {
  createSession: (partition: string) => Electron.Session
  initializeSession: typeof initializePortalSession
  configureSession: typeof configurePortalSession
  proxyUrl: () => string
  timeoutMs: number
}

/** 只跟随无敏感头的页面 GET；接口和写请求永不自动跟随重定向。 */
export async function loadPortalPage(
  context: Pick<SubscriptionPortalContext, 'request'>,
  input: string,
  stage: PortalStage = 'portal'
): Promise<{ response: PortalResponse; url: string }> {
  let url = validateManagementUrl(input, 'redirect').href
  for (let redirects = 0; ; redirects++) {
    const response = await context.request(url, { stage, headers: { accept: 'text/html' } })
    if (!REDIRECT_STATUSES.has(response.status)) return { response, url }
    if (redirects >= 5) throw new SubscriptionPortalError('redirect', '管理链接超过五次跳转')
    const location = response.headers.get('location')
    if (!location) throw new SubscriptionPortalError('redirect', '跳转响应缺少 Location')
    let next: string
    try { next = new URL(location, url).href } catch { throw new SubscriptionPortalError('redirect', '跳转地址格式无效') }
    url = validateManagementUrl(next).href
  }
}

/** 每次操作独立 Cookie jar，绝不占用或重置可见官网窗口的分区。 */
export async function createSubscriptionPortalContext(
  account: Account,
  overrides: Partial<ContextDependencies> = {}
): Promise<SubscriptionPortalContext> {
  if (!account?.id || !account.credentials?.accessToken) {
    throw new SubscriptionPortalError('session', '账号缺少 Access Token，请先刷新密钥')
  }
  const deps: ContextDependencies = {
    createSession: partition => electronSession.fromPartition(partition, { cache: false }),
    initializeSession: initializePortalSession,
    configureSession: configurePortalSession,
    proxyUrl: getConfiguredProxyUrl,
    timeoutMs: 30_000,
    ...overrides
  }
  const operationId = randomUUID()
  const ses = deps.createSession(`kiro-subscription-${operationId}`)
  let metadata: Record<string, string> = {}
  let initializedArn = ''
  let closed = false
  let bootstrapped = false
  const trace = (stage: PortalStage, detail: string): void => {
    console.debug(`[SubscriptionPortal] ${operationId.slice(0, 8)} ${stage} ${detail}`)
  }

  async function close(): Promise<void> {
    if (closed) return
    closed = true
    // 清理失败不能覆盖已成功提交/复核的结果；所有分支都继续清理连接。
    for (const cleanup of [() => ses.clearStorageData(), () => ses.clearCache(), () => ses.closeAllConnections()]) {
      try { await cleanup() } catch { console.warn(`[SubscriptionPortal] ${operationId.slice(0, 8)} cleanup failed`) }
    }
    metadata = {}
  }

  async function request(input: string, options: PortalRequestOptions = {}): Promise<PortalResponse> {
    const stage = options.stage ?? 'read'
    const url = validateManagementUrl(input, stage)
    if (closed) throw new SubscriptionPortalError(stage, '临时会话已关闭，请重新检查')
    const headers = new Headers(options.headers)
    const authorization = headers.get('authorization') || ''
    // Cookies 必须由 Chromium 按域发送，禁止上层手工拼接；身份凭证严格分域。
    if (headers.has('cookie') ||
        (url.origin !== KIRO_PORTAL_ORIGIN && (headers.has('x-csrf-token') || headers.has('x-kiro-profile-arn') || headers.has('x-kiro-idp') || headers.has('tokentype'))) ||
        (authorization && (url.origin === KIRO_PORTAL_ORIGIN
          ? authorization !== `Bearer ${account.credentials.accessToken}`
          : url.origin !== 'https://billing.stripe.com' || !/^Bearer ek_live_[A-Za-z0-9+/=_-]+$/.test(authorization)))) {
      throw new SubscriptionPortalError(stage, '已阻止跨域发送身份凭证')
    }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), deps.timeoutMs)
    try {
      const response = await ses.fetch(url.href, {
        method: options.method ?? 'GET', headers, body: options.body as NonNullable<Parameters<Electron.Session['fetch']>[1]>['body'],
        credentials: 'include', redirect: 'manual', signal: controller.signal
      })
      trace(stage, `HTTP ${response.status} ${redactedPortalUrl(url.href)}`)
      if (Number(response.headers.get('content-length')) > MAX_RESPONSE_BYTES) {
        throw new SubscriptionPortalError(stage, '响应体超过安全大小限制')
      }
      const bytes = await response.arrayBuffer()
      if (bytes.byteLength > MAX_RESPONSE_BYTES) throw new SubscriptionPortalError(stage, '响应体超过安全大小限制')
      return {
        ok: response.ok, status: response.status, headers: response.headers,
        text: async () => new TextDecoder().decode(bytes),
        json: async <T>() => JSON.parse(new TextDecoder().decode(bytes)) as T,
        arrayBuffer: async () => bytes
      }
    } catch (error) {
      if (error instanceof SubscriptionPortalError) throw error
      // 不打印原异常：网络错误可能包含完整的 session URL 或 Header。
      const cause = controller.signal.aborted ? '网络请求超时' : '网络请求失败'
      trace(stage, cause)
      throw new SubscriptionPortalError(stage, cause)
    } finally { clearTimeout(timer) }
  }

  async function bootstrap(): Promise<void> {
    if (bootstrapped) return
    const { response, url } = await loadPortalPage(context, KIRO_PORTAL_ORIGIN, 'session')
    if (new URL(url).origin !== KIRO_PORTAL_ORIGIN) throw new SubscriptionPortalError('session', '官网登录跳转异常')
    if (!response.ok) throw new SubscriptionPortalError('session', `HTTP ${response.status}`)
    metadata = parsePortalMetadata(await response.text())
    if (metadata['user-status'] === 'stale' || metadata['user-status'] === 'anonymous') {
      throw new SubscriptionPortalError('session', 'HTTP 401: 官网会话已过期，请刷新凭证', 401, true)
    }
    if (metadata['user-status'] !== 'active' || !metadata['csrf-token'] || !metadata.idp) {
      throw new SubscriptionPortalError('session', '官网未返回有效登录状态或 CSRF 元数据')
    }
    if (account.userId && metadata['user-id'] && account.userId !== metadata['user-id']) {
      throw new SubscriptionPortalError('session', '官网登录身份与目标账号不一致，已停止操作')
    }
    bootstrapped = true
  }

  async function callKiro<T>(operation: ReadOnlyKiroOperation, body: Record<string, unknown> = {}): Promise<T> {
    await bootstrap()
    const stage: PortalStage = operation === 'GenerateSubscriptionManagementUrl' ? 'management' : 'read'
    const idp = metadata.idp
    const profileArn = ['Google', 'Github'].includes(idp) ? KIRO_SOCIAL_PROFILE_ARN
      : ['BuilderId', 'Internal'].includes(idp) ? KIRO_BUILDER_ID_PLACEHOLDER_ARN
        : metadata['profile-arn'] || initializedArn
    const headers: Record<string, string> = {
      accept: 'application/cbor', 'content-type': 'application/cbor', 'smithy-protocol': 'rpc-v2-cbor',
      'x-csrf-token': metadata['csrf-token'], authorization: `Bearer ${account.credentials.accessToken}`,
      origin: KIRO_PORTAL_ORIGIN, referer: `${KIRO_PORTAL_ORIGIN}/`,
      'amz-sdk-invocation-id': randomUUID(), 'amz-sdk-request': 'attempt=1; max=1'
    }
    if (idp === 'ExternalOIDC') {
      headers['X-Kiro-Idp'] = idp
      headers.TokenType = 'EXTERNAL_IDP'
      if (profileArn) headers['X-Kiro-Profile-Arn'] = profileArn
    }
    const response = await request(`${KIRO_PORTAL_ORIGIN}/service/KiroWebPortalService/operation/${operation}`, {
      stage, method: 'POST', headers,
      body: Buffer.from(encode({ ...body, ...(profileArn ? { profileArn } : {}) }))
    })
    if (!response.ok) {
      let expired = false
      try {
        const errorData = decode(Buffer.from(await response.arrayBuffer())) as { message?: unknown }
        expired = response.status === 401 && typeof errorData.message === 'string' &&
          /token.{0,30}expired|expired.{0,30}token|invalid\s+(?:access\s+|bearer\s+)?token/i.test(errorData.message)
      } catch { /* 不把未解析的响应体写入日志 */ }
      const hint = expired ? '：官网凭证已过期，请刷新凭证'
        : response.status === 401 || response.status === 403 ? '：官网拒绝访问，未确认凭证过期，不会自动重试' : ''
      throw new SubscriptionPortalError(stage, `HTTP ${response.status}${hint}`, response.status, expired)
    }
    try { return decode(Buffer.from(await response.arrayBuffer())) as T }
    catch { throw new SubscriptionPortalError(stage, '官网 CBOR 响应无法解析') }
  }

  const context: SubscriptionPortalContext = {
    request, callKiro, close,
    async generateManagementUrl() {
      let data: { encodedVerificationUrl?: unknown }
      try {
        data = await callKiro('GenerateSubscriptionManagementUrl')
      } catch (error) {
        if (!(error instanceof SubscriptionPortalError) || error.authExpired ||
            (error.httpStatus !== 401 && error.httpStatus !== 403)) throw error
        // 官网套餐和 Stripe 续费安排不是一回事，权限拒绝时仅补充可验证的当前套餐。
        let plan = ''
        try {
          const usage = await callKiro<{ subscriptionInfo?: { subscriptionTitle?: unknown } }>('GetUserUsageAndLimits', { origin: 'KIRO_IDE' })
          const title = usage.subscriptionInfo?.subscriptionTitle
          if (typeof title === 'string' && /^KIRO[ _A-Z+0-9-]{0,40}$/i.test(title)) plan = title
        } catch { /* 只读补充失败不掩盖管理接口的原始错误 */ }
        throw new SubscriptionPortalError('management',
          `HTTP ${error.httpStatus}：官网拒绝提供订阅管理门户${plan ? `；官网当前套餐为 ${plan}` : ''}。Stripe 续费状态未核实，请用同一账号在官网打开 Manage plan 核对。`,
          error.httpStatus)
      }
      if (typeof data?.encodedVerificationUrl !== 'string') {
        throw new SubscriptionPortalError('management', '官网未返回管理链接')
      }
      return validateManagementUrl(data.encodedVerificationUrl, 'management').href
    }
  }
  try {
    const proxy = deps.proxyUrl()
    await ses.setProxy(proxy ? { proxyRules: proxy } : { mode: 'system' })
    deps.configureSession(ses)
    initializedArn = await deps.initializeSession(ses, account)
    return context
  } catch (error) {
    await close()
    if (error instanceof SubscriptionPortalError) throw error
    throw new SubscriptionPortalError('session', '创建独立官网会话失败')
  }
}
