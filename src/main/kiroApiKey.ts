// 用账号凭证管理 Kiro API Key（创建 / 列表）
//
// 与 kiroApi.ts 里的用量 / 模型接口不同，这里走的是 management 域名的
// x-amz-target 风格调用：路径固定为根路径，操作名放在头里，参数走 JSON body。
import { errorMessage } from '../shared/errors'
import { refreshAccountToken } from './accountService'
import {
  AWS_SINGLE_ATTEMPT_HEADERS,
  awsInvocationId,
  kiroAmzUserAgent,
  kiroUserAgent,
  serviceRegion
} from './kiroEndpoints'
import { isAuthScopeError, listAvailableProfiles } from './kiroApi'
import {
  isSocialLogin,
  KIRO_BUILDER_ID_PLACEHOLDER_ARN,
  KIRO_SOCIAL_PROFILE_ARN
} from './kiroAuth'
import { httpRequest } from './net'
import { DEFAULT_REGION } from '../shared/regions'
import type {
  Account,
  AccountApiKeyItem,
  AccountApiKeyList,
  CreateApiKeyResult,
  DeleteApiKeyResult,
  RefreshTokenResult
} from '../shared/types'

const SERVICE = 'KiroControlPlaneBearerService'

/** 控制面域名，与网关侧 managementBase 保持同一套区域归并规则 */
function managementBase(region?: string): string {
  return `https://management.${serviceRegion(region)}.kiro.dev`
}

function authHeaders(accessToken: string, target: string): Record<string, string> {
  return {
    Accept: '*/*',
    'Content-Type': 'application/json',
    Authorization: `Bearer ${accessToken}`,
    'x-amz-target': `${SERVICE}.${target}`,
    'User-Agent': kiroUserAgent(),
    'x-amz-user-agent': kiroAmzUserAgent(),
    'amz-sdk-invocation-id': awsInvocationId(),
    ...AWS_SINGLE_ATTEMPT_HEADERS
  }
}

/** 单次控制面调用，失败统一抛出 `HTTP <status>: <body 截断>` */
async function callControlPlane<T>(
  target: string,
  accessToken: string,
  body: Record<string, unknown>,
  region?: string
): Promise<T> {
  const res = await httpRequest(`${managementBase(region)}/`, {
    method: 'POST',
    headers: authHeaders(accessToken, target),
    body: JSON.stringify(body)
  })
  if (!res.ok) {
    const text = (await res.text()).slice(0, 300)
    console.warn(`[KiroApiKey] ${target} → ${res.status}: ${text}`)
    throw new Error(`HTTP ${res.status}: ${text}`)
  }
  console.debug(`[KiroApiKey] ${target} → ${res.status}`)
  return res.json<T>()
}

/**
 * 给出可以依次尝试的 profileArn。
 *
 * 控制面（CreateApiKey / ListApiKeys）把 profileArn 当必填项，不带就回
 * 400 "Value null at 'profileArn' ... must not be null"。所以这里**不能**剥离
 * Builder ID 占位符——实测控制面对 Builder ID 恰恰要带那个占位符才通，
 * 与用量、模型列表接口是同一套口径。
 *
 * 社交账号用后端固定的 social ARN；Enterprise 先问真实 profile，
 * 问不到再退回占位符兜底。
 */
async function arnCandidates(
  account: Account,
  accessToken: string
): Promise<(string | undefined)[]> {
  const { authMethod, provider, region } = account.credentials
  const out: (string | undefined)[] = []
  const push = (arn?: string): void => {
    if (arn && !out.includes(arn)) out.push(arn)
  }

  // 账号已存的 ARN 最可信：来自上游或切号时实测过
  push(account.profileArn || account.credentials.profileArn)

  if (isSocialLogin({ authMethod, provider })) {
    push(KIRO_SOCIAL_PROFILE_ARN)
  } else if (provider === 'Enterprise') {
    const profiles = await listAvailableProfiles(accessToken, region).catch(() => [])
    for (const arn of profiles) push(arn)
    // Enterprise 问不到真实 profile 时，占位符至少能满足「必填」，让上游给出更准的报错
    push(KIRO_BUILDER_ID_PLACEHOLDER_ARN)
  } else {
    // Builder ID / 其它 IdC：控制面认这个硬编码占位符
    push(KIRO_BUILDER_ID_PLACEHOLDER_ARN)
  }

  // 兜底：留一次「不带」的机会，仅用于后端哪天改回可选
  if (!out.length) out.push(undefined)
  return out
}

interface InvokeOutcome<T> {
  payload: T
  region: string
  profileArn?: string
  refreshed?: RefreshTokenResult
}

/**
 * 带账号凭证调用控制面：
 * accessToken 过期（401）时自动刷新一次重试，profileArn 维度报错时换候选重试。
 */
async function invokeWithAccount<T>(
  account: Account,
  target: string,
  extraBody: Record<string, unknown> = {}
): Promise<InvokeOutcome<T>> {
  const region = account.credentials.region || DEFAULT_REGION
  let accessToken = account.credentials.accessToken
  let refreshed: RefreshTokenResult | undefined
  if (!accessToken && !account.credentials.refreshToken) throw new Error('账号缺少凭证')

  const renew = async (): Promise<void> => {
    const result = await refreshAccountToken(account)
    refreshed = result
    accessToken = result.accessToken
  }

  if (!accessToken) await renew()

  const candidates = await arnCandidates(account, accessToken)
  let lastError: unknown
  let retriedWithNewToken = false

  for (const candidate of candidates) {
    const body = { ...extraBody, ...(candidate ? { profileArn: candidate } : {}) }
    try {
      const payload = await callControlPlane<T>(target, accessToken, body, region)
      return { payload, region, profileArn: candidate, refreshed }
    } catch (error) {
      lastError = error
      const msg = errorMessage(error)

      // 凭证过期只值得刷新重试一次，之后仍失败就是别的原因
      if (msg.includes('401') && !retriedWithNewToken && account.credentials.refreshToken) {
        retriedWithNewToken = true
        try {
          await renew()
          const payload = await callControlPlane<T>(target, accessToken, body, region)
          return { payload, region, profileArn: candidate, refreshed }
        } catch (retryError) {
          lastError = retryError
          if (!isAuthScopeError(errorMessage(retryError))) throw retryError
          continue
        }
      }

      // 只有授权维度的错误换 ARN 才有意义，网络或参数问题换了也一样
      if (!isAuthScopeError(msg)) throw error
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error(errorMessage(lastError, '调用 Kiro 控制面失败'))
}

/**
 * 取出创建接口返回的完整明文 Key。
 * 只有 rawKey 是完整值，keyPrefix 之类的字段同样以 ksk_ 开头但只是前缀，
 * 拿它当结果会让用户复制到一个不可用的短串。
 */
function pickRawKey(payload: unknown): string {
  if (!payload || typeof payload !== 'object') return ''
  const record = payload as Record<string, unknown>
  // rawKey 优先；其余是字段改名后的兜底，前缀类字段一律不参与
  for (const field of ['rawKey', 'apiKey', 'apiKeyValue', 'secretKey', 'value']) {
    const value = record[field]
    if (typeof value === 'string' && value.startsWith('ksk_')) return value
  }
  return ''
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined
}

/**
 * createdAt 是以秒为单位的浮点数（形如 1.78685640426E9），
 * 统一换算成毫秒时间戳，界面才能直接格式化。
 */
function toMillis(value: unknown): number {
  const seconds = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(seconds) || seconds <= 0) return 0
  // 已经是毫秒的值不再乘，避免上游改单位后时间跑到几万年后
  return seconds > 1e12 ? Math.round(seconds) : Math.round(seconds * 1000)
}

function normalizeItem(raw: unknown): AccountApiKeyItem | null {
  if (!raw || typeof raw !== 'object') return null
  const record = raw as Record<string, unknown>
  const keyId = asString(record.keyId) ?? asString(record.id)
  const keyPrefix = asString(record.keyPrefix) ?? asString(record.prefix) ?? ''
  if (!keyId && !keyPrefix) return null
  return {
    keyId: keyId ?? keyPrefix,
    label: asString(record.label) ?? '',
    keyPrefix,
    createdAt: toMillis(record.createdAt)
  }
}

/**
 * 为指定账号生成一个新的 Kiro API Key。
 * 返回的 apiKey 是完整明文，上游只在创建时给这一次。
 */
export async function createAccountApiKey(
  account: Account,
  label: string
): Promise<CreateApiKeyResult> {
  const name = String(label || '').trim()
  if (!name) throw new Error('密钥名称不能为空')
  if (name.length > 64) throw new Error('密钥名称不能超过 64 个字符')

  const { payload, region, profileArn, refreshed } = await invokeWithAccount<
    Record<string, unknown>
  >(account, 'CreateApiKey', { label: name })

  const apiKey = pickRawKey(payload)
  if (!apiKey) {
    console.warn('[KiroApiKey] CreateApiKey 返回 200 但未能识别 rawKey 字段')
    throw new Error('上游返回成功但没有可识别的完整 API Key，请稍后重试')
  }
  /*
   * 兜底校验：keyPrefix 同样以 ksk_ 开头，一旦拿它当结果，用户会复制到一个
   * 看起来正常但不可用的短串。宁可报错，也不能把前缀当完整 Key 交出去。
   */
  const prefix = asString(payload.keyPrefix)
  if (prefix && apiKey.length <= prefix.length) {
    console.warn('[KiroApiKey] CreateApiKey 返回的疑似前缀而非完整 Key')
    throw new Error('上游只返回了 Key 前缀，没有完整明文，请稍后重试')
  }
  console.info('[KiroApiKey] 已生成 1 个 API Key')

  return {
    apiKey,
    label: asString(payload.label) ?? name,
    apiKeyId: asString(payload.keyId),
    keyPrefix: asString(payload.keyPrefix),
    createdAt: toMillis(payload.createdAt) || Date.now(),
    region,
    profileArn,
    refreshed
  }
}

/** 删除该账号的一个 API Key，删除后调用方应重新拉列表刷新界面 */
export async function deleteAccountApiKey(
  account: Account,
  keyId: string
): Promise<DeleteApiKeyResult> {
  const id = String(keyId || '').trim()
  if (!id) throw new Error('缺少要删除的 keyId')

  const { refreshed } = await invokeWithAccount<Record<string, unknown>>(account, 'DeleteApiKey', {
    keyId: id
  })
  console.info('[KiroApiKey] 已删除 1 个 API Key')
  return { keyId: id, refreshed }
}

/** 列出该账号已创建的 API Key（只返回前缀，拿不到完整明文） */
export async function listAccountApiKeys(account: Account): Promise<AccountApiKeyList> {
  const { payload, region, refreshed } = await invokeWithAccount<{ keys?: unknown[] }>(
    account,
    'ListApiKeys'
  )
  const keys = (Array.isArray(payload.keys) ? payload.keys : [])
    .map(normalizeItem)
    .filter((item): item is AccountApiKeyItem => item !== null)
    // 新创建的排在最前，与界面上「刚生成的最容易被找」的预期一致
    .sort((a, b) => b.createdAt - a.createdAt)
  return { keys, region, refreshed }
}
