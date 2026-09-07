import type { Account, SubscriptionType } from '@shared/types'
import type { SubscriptionRenewalInfo } from '@shared/subscriptionFree'
import type { SubscriptionRecord, SubscriptionRecords } from './subscriptionRecords'

export type SubscriptionPlanFilter = 'all' | SubscriptionType | 'unknown'
export type SubscriptionArrangementFilter = 'all' | SubscriptionRenewalInfo['state'] | 'unknown' | 'needs-check'
export interface SubscriptionListFilters {
  search: string
  plan: SubscriptionPlanFilter
  arrangement: SubscriptionArrangementFilter
}

export const subscriptionPlanOptions: { value: SubscriptionPlanFilter; label: string }[] = [
  { value: 'all', label: '全部类型' },
  { value: 'Free', label: 'Free' },
  { value: 'Pro', label: 'Pro' },
  { value: 'Pro_Plus', label: 'Pro+' },
  { value: 'Pro_Max', label: 'Pro Max' },
  { value: 'Power', label: 'Power' },
  { value: 'Teams', label: 'Teams' },
  { value: 'unknown', label: '未知类型' }
]
export const subscriptionArrangementOptions: { value: SubscriptionArrangementFilter; label: string }[] = [
  { value: 'all', label: '全部安排' },
  { value: 'paid', label: '付费订阅' },
  { value: 'free', label: '已为 Free' },
  { value: 'scheduled-free', label: '已安排转为 Free' },
  { value: 'canceling', label: '取消中（尚非 Free）' },
  { value: 'unknown', label: '尚未确认' },
  { value: 'needs-check', label: '待复核' }
]

/** Filter the latest known current plan, never the scheduled next-period Free plan. */
export function currentSubscriptionType(account: Account, record?: SubscriptionRecord): Exclude<SubscriptionPlanFilter, 'all'> {
  const portalPlan = record?.renewal?.planName.trim()
  if (!portalPlan) {
    const local = account.subscription.type
    return subscriptionPlanOptions.some((option) => option.value === local) ? local : 'unknown'
  }
  // Unknown future products must not inherit the general normalizer's default Free classification.
  const name = portalPlan.replace(/^kiro[\s_-]+/i, '').replace(/[\s_-]+/g, '').toLowerCase()
  switch (name) {
    case 'free': return 'Free'
    case 'pro': return 'Pro'
    case 'pro+':
    case 'proplus': return 'Pro_Plus'
    case 'promax': return 'Pro_Max'
    case 'power': return 'Power'
    case 'teams': return 'Teams'
    default: return 'unknown'
  }
}

export function subscriptionArrangement(record?: SubscriptionRecord): Exclude<SubscriptionArrangementFilter, 'all'> {
  // An uncertain write is a separate bucket even if an earlier portal snapshot still exists.
  if (record?.needsCheck) return 'needs-check'
  return record?.renewal?.state ?? 'unknown'
}

export function filterSubscriptionAccounts(
  accounts: Account[], records: SubscriptionRecords, filters: SubscriptionListFilters
): Account[] {
  const query = filters.search.trim().toLocaleLowerCase()
  return accounts.filter((account) => {
    const record = records[account.id]
    if (filters.plan !== 'all' && currentSubscriptionType(account, record) !== filters.plan) return false
    if (filters.arrangement !== 'all' && subscriptionArrangement(record) !== filters.arrangement) return false
    return !query || [account.email, account.nickname, account.id]
      .some((value) => value?.toLocaleLowerCase().includes(query))
  })
}
