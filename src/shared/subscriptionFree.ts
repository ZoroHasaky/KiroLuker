/** Stripe 门户实际状态；不能用下期 Free 覆盖当前 Kiro 订阅档位。 */
export interface SubscriptionRenewalInfo {
  state: 'paid' | 'free' | 'scheduled-free' | 'canceling'
  planName: string
  subscriptionId: string
  /** 时间戳统一使用毫秒。 */
  currentPeriodEnd?: number
  transitionAt?: number
  checkedAt: number
}

export interface SwitchSubscriptionToFreeResult {
  status:
    | 'already-free'
    | 'already-scheduled'
    | 'wont-renew'
    | 'switched'
    | 'scheduled'
    | 'unverified'
  previousPlan: string
  renewal?: SubscriptionRenewalInfo
  /** 提交结果不确定时只读复查，不可自动重试。 */
  warning?: string
}
