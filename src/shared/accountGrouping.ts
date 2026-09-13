import type { AccountSubscription, AccountUsage } from './types'

export type AccountGroup = 'unused' | 'pending' | 'subscribed' | 'deprecated'

export interface AccountGroupingInput {
  subscription: Pick<AccountSubscription, 'type' | 'title' | 'managementTarget'>
  usage?: Pick<AccountUsage, 'current' | 'percentUsed'> | null
  hasPaymentLink: boolean
}

export interface AccountGroupingThresholds {
  absoluteCurrent: number
  percent: number
}

function isFree(subscription: AccountGroupingInput['subscription']): boolean {
  const type = String(subscription.type || '').toUpperCase()
  const title = String((subscription as { title?: string }).title || '').toUpperCase()
  return type === 'FREE' || title.includes('FREE')
}

export function classifyAccountGroup(
  account: AccountGroupingInput,
  thresholds: AccountGroupingThresholds = { absoluteCurrent: 0, percent: 100 }
): AccountGroup {
  const free = isFree(account.subscription)
  const current = Number(account.usage?.current ?? 0)
  const percent = Number(account.usage?.percentUsed ?? 0)
  const absoluteThreshold = Number(thresholds.absoluteCurrent)
  const percentThreshold = Number(thresholds.percent)
  const downgraded = free && String(account.subscription.managementTarget || '').toUpperCase() === 'MANAGE'
  const hitAbsolute = absoluteThreshold > 0 && current >= absoluteThreshold
  const hitPercent = percentThreshold > 0 && percent * 100 >= percentThreshold

  if (downgraded || hitAbsolute || hitPercent) return 'deprecated'
  if (!free || current > 0) return 'subscribed'
  if (account.hasPaymentLink) return 'pending'
  return 'unused'
}
