// Adapted from fanxuankai/Kiro-account-manager (AGPL-3.0):
// https://github.com/fanxuankai/Kiro-account-manager/blob/b032d793d69096390e789230287171228f6da064/Kiro-account-manager/src/main/proxy/stripePortal.ts
// Stripe 门户内部协议，并非稳定公开 API；解析不匹配时停止，不猜测订阅或价格。
import {
  createSubscriptionPortalContext,
  loadPortalPage,
  SubscriptionPortalError,
  type PortalStage,
  type SubscriptionPortalContext
} from './subscriptionPortalContext'
import type { Account } from '../shared/types'
import type {
  SubscriptionRenewalInfo,
  SwitchSubscriptionToFreeResult
} from '../shared/subscriptionFree'

const PORTAL_ORIGIN = 'https://billing.stripe.com'
const KIRO_STRIPE_ACCOUNT = 'acct_1RoAWWIHUhwdEnrT'
const KIRO_FREE_PRICE_ID = 'price_1RpBqGIHUhwdEnrTbZ8CIM0l'
type JsonRecord = Record<string, unknown>

interface PortalCredential {
  sessionId: string
  key: string
  url: string
  context: SubscriptionPortalContext
}

interface PortalSubscription {
  info: SubscriptionRenewalInfo
  itemId: string
  hasUpdateScheduled: boolean
}

function record(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonRecord)
    : {}
}

function timestamp(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value * 1000
    : undefined
}

function validId(value: unknown, prefix: string): value is string {
  return typeof value === 'string' && new RegExp(`^${prefix}_[A-Za-z0-9]+$`).test(value)
}

function portalHeaders(credential: PortalCredential): Record<string, string> {
  return {
    accept: 'application/json',
    authorization: `Bearer ${credential.key}`,
    'content-type': 'application/x-www-form-urlencoded',
    referer: credential.url,
    'stripe-account': KIRO_STRIPE_ACCOUNT,
    'stripe-livemode': 'true',
    'stripe-version': '2025-06-30.basil',
    'x-requested-with': 'XMLHttpRequest',
    'x-stripe-csrf-token': 'fake-deprecated-token'
  }
}

export function parsePortalSubscription(raw: unknown, now: number): PortalSubscription {
  const subscriptions = record(raw).data
  if (!Array.isArray(subscriptions) || subscriptions.length === 0) {
    throw new Error('Stripe 门户没有可管理的订阅，请前往官网核实')
  }
  // 不盲取第一条：出现多订阅/多项目时绝不修改可能不相关的订阅。
  if (subscriptions.length !== 1 || record(raw).has_more === true) throw new Error('门户存在多个订阅，请前往官网手动管理')
  const sub = record(subscriptions[0])
  if (!validId(sub.id, 'sub')) throw new Error('Stripe 订阅 ID 格式异常')
  if (sub.status && sub.status !== 'active' && sub.status !== 'trialing') {
    throw new Error('Stripe 订阅不是有效状态，请前往官网核实')
  }
  const items = Array.isArray(sub.items) ? sub.items : record(sub.items).data
  if (!Array.isArray(items) || items.length !== 1 || record(sub.items).has_more === true) {
    throw new Error('Stripe 订阅项目不唯一或无法解析，请前往官网手动管理')
  }
  const item = record(items[0])
  const price = record(item.price_details)
  if (!validId(item.id, 'si') || !validId(price.id, 'price')) {
    throw new Error('Stripe 订阅项目或价格格式异常')
  }
  if (item.quantity !== undefined && item.quantity !== 1) {
    throw new Error('Stripe 订阅数量不是 1，请前往官网手动管理')
  }
  const product = Array.isArray(price.product) ? price.product[0] : price.product
  const name = record(product).name
  const isFree = price.id === KIRO_FREE_PRICE_ID
  if (!isFree && (typeof name !== 'string' || !/^kiro\b/i.test(name))) {
    throw new Error('无法确认是 Kiro 订阅，已停止操作')
  }
  const invoiceLines = record(record(sub.upcoming_invoice).lines).data
  const nextPrice = Array.isArray(invoiceLines) && invoiceLines.length === 1
    ? record(record(invoiceLines[0]).price_details).id
    : undefined
  // $0 发票也可能来自优惠券/余额，只有明确的 Free 价格才算已安排降级。
  const scheduledFree = sub.has_update_scheduled === true && nextPrice === KIRO_FREE_PRICE_ID
  const state: SubscriptionRenewalInfo['state'] = isFree
    ? 'free'
    : scheduledFree ? 'scheduled-free' : sub.cancel_at_period_end === true ? 'canceling' : 'paid'
  return {
    itemId: item.id,
    hasUpdateScheduled: sub.has_update_scheduled === true,
    info: {
      state,
      subscriptionId: sub.id,
      planName: typeof name === 'string' ? name : 'Kiro Free',
      currentPeriodEnd: timestamp(sub.current_period_end),
      transitionAt: scheduledFree
        ? timestamp(sub.transition_at) ?? timestamp(sub.current_period_end)
        : undefined,
      checkedAt: now
    }
  }
}

interface PortalDependencies {
  createContext: typeof createSubscriptionPortalContext
  now: () => number
}

export function createFreeSubscriptionService(dependencies: Partial<PortalDependencies> = {}) {
  const createContext = dependencies.createContext ?? createSubscriptionPortalContext
  const now = dependencies.now ?? Date.now
  const switching = new Set<string>()

  async function loadCredential(context: SubscriptionPortalContext): Promise<PortalCredential> {
    const managementUrl = await context.generateManagementUrl()
    const { response, url } = await loadPortalPage(context, managementUrl)
    if (new URL(url).origin !== PORTAL_ORIGIN) {
      throw new SubscriptionPortalError('redirect', '管理链接未到达 Stripe 门户，请前往官网核实')
    }
    if (!response.ok) throw new SubscriptionPortalError('portal', `HTTP ${response.status}`)
    const html = await response.text()
    const sessionId = html.match(/bps_[A-Za-z0-9]+/)?.[0]
    const key = html.match(/ek_live_[A-Za-z0-9+/=_-]+/)?.[0]
    if (!sessionId || !key) {
      throw new SubscriptionPortalError('portal', 'Stripe 会话已失效或页面结构已变化，请重新检查续费或前往官网')
    }
    if (!html.includes(KIRO_STRIPE_ACCOUNT)) {
      throw new SubscriptionPortalError('portal', '无法确认 Kiro 商户身份，已停止操作')
    }
    return { sessionId, key, url, context }
  }

  function subscriptionUrl(credential: PortalCredential): string {
    return `${PORTAL_ORIGIN}/v1/billing_portal/sessions/${credential.sessionId}/subscriptions`
  }

  async function readSubscription(
    credential: PortalCredential,
    stage: PortalStage = 'read'
  ): Promise<PortalSubscription> {
    const response = await credential.context.request(`${subscriptionUrl(credential)}?expand%5B%5D=data.items.price_details.product`, {
      headers: portalHeaders(credential), stage
    })
    if (!response.ok) throw new SubscriptionPortalError(stage, `Stripe HTTP ${response.status}，请重新检查续费`)
    const raw = await response.json<unknown>().catch(() => null)
    try { return parsePortalSubscription(raw, now()) }
    catch (error) {
      throw new SubscriptionPortalError(stage, error instanceof Error ? error.message : 'Stripe 订阅响应无法解析')
    }
  }

  async function checkSubscriptionRenewal(account: Account): Promise<SubscriptionRenewalInfo> {
    const context = await createContext(account)
    try {
      const credential = await loadCredential(context)
      return (await readSubscription(credential)).info
    } finally { await context.close() }
  }

  async function switchSubscriptionToFree(account: Account): Promise<SwitchSubscriptionToFreeResult> {
    if (!account?.id) throw new Error('账号不存在')
    if (switching.has(account.id)) throw new Error('此账号正在切换订阅，请勿重复提交')
    switching.add(account.id)
    let context: SubscriptionPortalContext | undefined
    try {
      context = await createContext(account)
      const credential = await loadCredential(context)
      const subscription = await readSubscription(credential)
      const before = subscription.info
      const base = { previousPlan: before.planName, renewal: before }
      if (before.state === 'free') return { status: 'already-free', ...base }
      if (before.state === 'scheduled-free') return { status: 'already-scheduled', ...base }
      if (before.state === 'canceling') return { status: 'wont-renew', ...base }
      if (subscription.hasUpdateScheduled) {
        throw new SubscriptionPortalError('switch', '已有其他周期末计划变更，为避免覆盖已停止操作，请前往官网核实')
      }
      const uncertain = (warning: string): SwitchSubscriptionToFreeResult => ({
        status: 'unverified', previousPlan: before.planName, warning
      })
      let response: Awaited<ReturnType<SubscriptionPortalContext['request']>>
      try {
        response = await context.request(`${subscriptionUrl(credential)}/${before.subscriptionId}`, {
          method: 'POST',
          headers: { ...portalHeaders(credential), origin: PORTAL_ORIGIN },
          body: new URLSearchParams({
            'recurring_items[0][id]': subscription.itemId,
            'recurring_items[0][quantity]': '1',
            'recurring_items[0][price]': KIRO_FREE_PRICE_ID
          }).toString(),
          stage: 'switch'
        })
      } catch {
        // 网络超时不代表未提交；不把它包装成可自动重试的普通失败。
        return uncertain('[提交变更] 切换请求的结果不确定，可能已生效；请先检查续费，勿重复提交。')
      }
      // 消费响应体以释放连接；结果以随后只读查询为准，不把响应中的秘密写入日志。
      await response.text().catch(() => '')
      if (!response.ok) {
        if (response.status >= 500 || response.status === 408) {
          return uncertain(`[提交变更] Stripe 返回 HTTP ${response.status}，切换结果不确定；请先检查续费，勿重复提交。`)
        }
        throw new SubscriptionPortalError('switch', `Stripe HTTP ${response.status}，请检查续费或前往官网处理`)
      }
      // 必须读回真实状态；POST 200 不足以证明已切换，也不假设一律周期末生效。
      try {
        const after = (await readSubscription(credential, 'verify')).info
        if (after.subscriptionId !== before.subscriptionId) {
          return uncertain('[提交后复核] 提交后订阅标识发生变化，无法确认结果；请先检查续费或前往官网。')
        }
        if (after.state === 'free') return { status: 'switched', previousPlan: before.planName, renewal: after }
        if (after.state === 'scheduled-free') return { status: 'scheduled', previousPlan: before.planName, renewal: after }
        return uncertain('[提交后复核] 已提交，但尚未确认 Free 变更；请稍后检查续费，不要立即重复提交。')
      } catch {
        return uncertain('[提交后复核] 已提交，但复核失败；请先检查续费，勿重复提交。')
      }
    } finally {
      try { await context?.close() } finally { switching.delete(account.id) }
    }
  }

  return { checkSubscriptionRenewal, switchSubscriptionToFree }
}

export const { checkSubscriptionRenewal, switchSubscriptionToFree } = createFreeSubscriptionService()
