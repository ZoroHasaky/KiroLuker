import type {
  Account,
  KiroSubscriptionPlan,
  SubscriptionLinkResult
} from './types'

export type SubscriptionEligibilityReason =
  | 'ok'
  | 'no-credentials'
  | 'already-paid'
  | 'banned'
  | 'expired'
  | 'cannot-upgrade'
  | 'unknown-tier'
  | 'downgraded-free'
  | 'used-free'

export interface SubscriptionEligibility {
  eligible: boolean
  reason: SubscriptionEligibilityReason
  detail?: string
}

function recordOf(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function textOf(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * 按参考项目的预检口径分类账号。降级 Free / 已用积分单独标出，
 * 是否排除由界面开关决定，避免把策略写死在数据层。
 */
export function classifySubscriptionEligibility(account: Account): SubscriptionEligibility {
  if (!account.credentials.accessToken && !account.credentials.refreshToken) {
    return { eligible: false, reason: 'no-credentials' }
  }

  const type = account.subscription.type.toUpperCase()
  const title = (account.subscription.title || '').toUpperCase()
  const isFree = type === 'FREE' || title.includes('FREE')
  const isPaid =
    type !== 'FREE' ||
    ['PRO', 'POWER', 'TEAMS', 'ENTERPRISE'].some((name) => title.includes(name))

  if (isPaid) {
    return {
      eligible: false,
      reason: 'already-paid',
      detail: account.subscription.title || account.subscription.type
    }
  }
  if (!isFree) {
    return {
      eligible: false,
      reason: 'unknown-tier',
      detail: account.subscription.title || account.subscription.type
    }
  }

  const lastError = (account.lastError || '').toLowerCase()
  if (
    account.status === 'banned' ||
    lastError.includes('suspended') ||
    lastError.includes('封禁') ||
    lastError.includes('temporarily')
  ) {
    return { eligible: false, reason: 'banned', detail: account.lastError }
  }
  if (account.status === 'expired') {
    return { eligible: false, reason: 'expired', detail: account.lastError }
  }

  const upgradeCapability = account.subscription.upgradeCapability || ''
  if (upgradeCapability.toUpperCase().includes('NOT')) {
    return { eligible: false, reason: 'cannot-upgrade', detail: upgradeCapability }
  }

  if ((account.subscription.managementTarget || '').toUpperCase() === 'MANAGE') {
    return { eligible: false, reason: 'downgraded-free' }
  }
  if ((account.usage.current || 0) > 0) {
    return { eligible: false, reason: 'used-free', detail: String(account.usage.current) }
  }

  return { eligible: true, reason: 'ok' }
}

export function isUnsuitableFreeReason(reason: SubscriptionEligibilityReason): boolean {
  return reason === 'downgraded-free' || reason === 'used-free'
}

/** 把上游松散 JSON 收敛成渲染层使用的稳定计划结构。 */
export function normalizeSubscriptionPlans(input: unknown): KiroSubscriptionPlan[] {
  const root = recordOf(input)
  const rawPlans = Array.isArray(root?.subscriptionPlans)
    ? root.subscriptionPlans
    : Array.isArray(root?.plans)
      ? root.plans
      : []

  const plans: KiroSubscriptionPlan[] = []
  for (const raw of rawPlans) {
    const plan = recordOf(raw)
    if (!plan) continue
    const name = textOf(plan.name)
    const qSubscriptionType = textOf(plan.qSubscriptionType)
    if (!qSubscriptionType) continue

    const description = recordOf(plan.description)
    const pricing = recordOf(plan.pricing)
    const amount = Number(pricing?.amount)
    const features = Array.isArray(description?.features)
      ? description.features.map(textOf).filter(Boolean)
      : []

    plans.push({
      name: name || qSubscriptionType,
      qSubscriptionType,
      description: {
        title: textOf(description?.title) || name || qSubscriptionType,
        billingInterval: textOf(description?.billingInterval),
        featureHeader: textOf(description?.featureHeader),
        features
      },
      pricing: {
        amount: Number.isFinite(amount) ? amount : 0,
        currency: textOf(pricing?.currency) || 'USD'
      }
    })
  }
  return plans
}

export function isPaidSubscriptionPlan(plan: KiroSubscriptionPlan): boolean {
  return !plan.qSubscriptionType.toUpperCase().includes('FREE')
}

export function preferredSubscriptionPlan(
  plans: KiroSubscriptionPlan[]
): KiroSubscriptionPlan | undefined {
  const paid = plans.filter(isPaidSubscriptionPlan)
  return (
    paid.find((plan) =>
      /(?:^|_)PRO$/.test(plan.qSubscriptionType.toUpperCase())
    ) ?? paid[0]
  )
}

export function isHttpSubscriptionUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return (url.protocol === 'http:' || url.protocol === 'https:') && !!url.hostname
  } catch {
    return false
  }
}

/** CreateSubscriptionToken 的链接字段在不同版本中可能叫 url 或 encodedVerificationUrl。 */
export function normalizeSubscriptionLink(input: unknown): SubscriptionLinkResult | null {
  const data = recordOf(input)
  if (!data) return null
  const url = textOf(data.encodedVerificationUrl) || textOf(data.url)
  if (!isHttpSubscriptionUrl(url)) return null
  const status = textOf(data.status)
  return { url, ...(status ? { status } : {}) }
}

export function isSubscriptionAuthError(error?: string): boolean {
  return !!error && /\b401\b|invalid\s+(?:bearer\s+)?token|token\s+(?:is\s+)?expired/i.test(error)
}
