import type { Account } from '@shared/types'

export type AccountGroup = 'unused' | 'pending-payment' | 'subscribed' | 'deprecated'

export interface AccountGroupingThresholds {
  /** 已用绝对额度阈值；小于等于 0 表示关闭。 */
  usageCurrentThreshold?: number
  /** 已用比例阈值（百分比 1-100）；小于等于 0 表示关闭。 */
  usagePercentThreshold?: number
}

export const ACCOUNT_GROUP_META: Record<AccountGroup, { label: string }> = {
  unused: { label: '未使用' },
  'pending-payment': { label: '待支付' },
  subscribed: { label: '已订阅' },
  deprecated: { label: '已废弃' }
}

function isFreeSubscription(account: Pick<Account, 'subscription'>): boolean {
  const subscriptionType = account.subscription.type.toUpperCase()
  const subscriptionTitle = (account.subscription.title || '').toUpperCase()
  return subscriptionType === 'FREE' || subscriptionTitle.includes('FREE')
}

/**
 * 已降级 Free 的账号由上游订阅管理标记识别。MANAGE 表示门户仍存在可管理的历史付费订阅，
 * 在当前账号已是 Free 时即属于已降级账号。
 */
function isDowngradedFree(account: Pick<Account, 'subscription'>): boolean {
  return isFreeSubscription(account) &&
    (account.subscription.managementTarget || '').toUpperCase() === 'MANAGE'
}

export function isAccountDeprecated(
  account: Pick<Account, 'subscription' | 'usage'>,
  thresholds: AccountGroupingThresholds = {}
): boolean {
  if (isDowngradedFree(account)) return true

  const current = Number(account.usage.current)
  const currentThreshold = Number(thresholds.usageCurrentThreshold ?? 0)
  if (currentThreshold > 0 && current >= currentThreshold) return true

  const percentThreshold = Number(thresholds.usagePercentThreshold ?? 0)
  const percentUsed = Number(account.usage.percentUsed) * 100
  return percentThreshold > 0 && percentUsed >= percentThreshold
}

/**
 * Derive the account-management group from live account data. Deprecated accounts
 * have priority over normal subscription groups, even when a payment link remains.
 */
export function getAccountGroup(
  account: Pick<Account, 'paymentLink' | 'subscription' | 'usage'>,
  thresholds: AccountGroupingThresholds = {}
): AccountGroup {
  if (isAccountDeprecated(account, thresholds)) return 'deprecated'

  const isFree = isFreeSubscription(account)
  const used = Number(account.usage.current) > 0

  if (!isFree || used) return 'subscribed'
  return account.paymentLink.trim() ? 'pending-payment' : 'unused'
}
