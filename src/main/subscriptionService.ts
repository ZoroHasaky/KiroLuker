import { randomUUID } from 'crypto'
import { resolveProfileArn } from './kiroAuth'
import {
  AWS_SINGLE_ATTEMPT_HEADERS,
  awsInvocationId,
  kiroSubscriptionAmzUserAgent,
  kiroSubscriptionUserAgent,
  qEndpoint
} from './kiroEndpoints'
import { httpRequest } from './net'
import { acquirePoolProxy, isProxyPoolEnabled, type PoolProxyRoute } from './proxyPool'
import { recordUsage } from './poolUsageStore'
import {
  normalizeSubscriptionLink,
  normalizeSubscriptionPlans
} from '../shared/subscriptionBatch'
import type {
  Account,
  SubscriptionLinkResult,
  SubscriptionPlansResult
} from '../shared/types'

export function subscriptionProfileArn(account: Account): string {
  return resolveProfileArn({
    profileArn: account.profileArn || account.credentials.profileArn,
    authMethod: account.credentials.authMethod,
    provider: account.credentials.provider || account.idp,
    region: account.credentials.region
  })
}

function requestHeaders(account: Account): Record<string, string> {
  const accessToken = account.credentials.accessToken
  if (!accessToken) throw new Error('账号缺少 Access Token，请先刷新密钥')
  return {
    Authorization: `Bearer ${accessToken}`,
    'content-type': 'application/json',
    'user-agent': kiroSubscriptionUserAgent(),
    'x-amz-user-agent': kiroSubscriptionAmzUserAgent(),
    'amz-sdk-invocation-id': awsInvocationId(),
    ...AWS_SINGLE_ATTEMPT_HEADERS
  }
}

function upstreamMessage(input: unknown): string {
  if (!input || typeof input !== 'object') return ''
  const data = input as Record<string, unknown>
  for (const key of ['message', 'error', 'errorMessage', '__type']) {
    if (typeof data[key] === 'string' && data[key]) return data[key].slice(0, 240)
  }
  return ''
}

async function postSubscription(
  account: Account,
  operation: 'listAvailableSubscriptions' | 'CreateSubscriptionToken',
  payload: Record<string, string>,
  route?: PoolProxyRoute
): Promise<unknown> {
  let response: Awaited<ReturnType<typeof httpRequest>>
  try {
    response = await httpRequest(`${qEndpoint(account.credentials.region)}/${operation}`, {
      method: 'POST',
      headers: requestHeaders(account),
      body: JSON.stringify(payload),
      ...(route ? { proxyUrl: route.proxyUrl, proxyViaUrl: route.viaUrl || undefined } : {})
    })
  } catch (e) {
    // undici 把底层错误包成 "fetch failed"，真实原因在 cause 链里；摊平让账号错误可读
    const cause = (e as { cause?: unknown }).cause
    const detail = cause instanceof Error ? cause.message : ''
    throw new Error(
      `${e instanceof Error ? e.message : String(e)}${detail ? `：${detail}` : ''}${
        route ? '（经提链代理池出口）' : ''
      }`
    )
  }
  // 拿到 HTTP 状态码即说明请求已到达 Kiro（成功或 4xx 均算）：该出口已被服务端看到，计一次
  if (route) recordUsage(route.exitIp)
  const data = await response.json<unknown>().catch(() => null)
  console.debug(`[Subscription] ${operation} → ${response.status}`)
  if (!response.ok) {
    const detail = upstreamMessage(data)
    throw new Error(`HTTP ${response.status}${detail ? `: ${detail}` : ''}`)
  }
  return data
}

/** 读取当前账号可购买的 Kiro 订阅计划。 */
export async function getSubscriptionPlans(account: Account): Promise<SubscriptionPlansResult> {
  const raw = await postSubscription(account, 'listAvailableSubscriptions', {
    profileArn: subscriptionProfileArn(account)
  })
  const plans = normalizeSubscriptionPlans(raw)
  if (!plans.length) throw new Error('Kiro 未返回可用订阅计划')

  const data = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const disclaimer = Array.isArray(data.disclaimer)
    ? data.disclaimer.filter((item): item is string => typeof item === 'string' && !!item.trim())
    : undefined
  return { plans, ...(disclaimer?.length ? { disclaimer } : {}) }
}

/** 为单个账号和计划生成 Kiro/Stripe 官方订阅支付链接。 */
export async function createSubscriptionLink(
  account: Account,
  subscriptionType: string
): Promise<SubscriptionLinkResult> {
  const normalizedType = subscriptionType.trim()
  if (!/^[A-Za-z0-9_+.-]{2,100}$/.test(normalizedType)) {
    throw new Error('订阅计划参数无效')
  }
  // 缺 token / 参数无效时直接失败，别浪费一次池 IP 配额
  if (!account.credentials.accessToken) throw new Error('账号缺少 Access Token，请先刷新密钥')

  let poolRoute: PoolProxyRoute | undefined
  if (isProxyPoolEnabled()) {
    try {
      poolRoute = await acquirePoolProxy()
    } catch (e) {
      throw new Error(`代理池获取 IP 失败：${e instanceof Error ? e.message : '未知错误'}`)
    }
  }

  const raw = await postSubscription(
    account,
    'CreateSubscriptionToken',
    {
      clientToken: randomUUID(),
      provider: 'STRIPE',
      profileArn: subscriptionProfileArn(account),
      subscriptionType: normalizedType
    },
    poolRoute
  )
  const result = normalizeSubscriptionLink(raw)
  if (!result) throw new Error(upstreamMessage(raw) || 'Kiro 未返回有效的订阅链接')
  return result
}

/** 开启或关闭已订阅账号的超额付费偏好。 */
export async function setSubscriptionOverage(
  account: Account,
  overageStatus: 'ENABLED' | 'DISABLED'
): Promise<{ success: boolean }> {
  const profileArn = subscriptionProfileArn(account)
  const response = await httpRequest(`${qEndpoint(account.credentials.region)}/setUserPreference`, {
    method: 'POST',
    headers: requestHeaders(account),
    body: JSON.stringify({
      overageConfiguration: { overageStatus },
      ...(profileArn ? { profileArn } : {})
    })
  })
  const data = await response.json<unknown>().catch(() => null)
  console.debug(`[Subscription] setUserPreference(${overageStatus}) → ${response.status}`)
  if (!response.ok) {
    const detail = upstreamMessage(data)
    throw new Error(`HTTP ${response.status}${detail ? `: ${detail}` : ''}`)
  }
  return { success: true }
}
