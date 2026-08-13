// 网关自动重试的候选状态码及说明：主进程判定与设置界面文案共用同一份定义
//
// 只列错误状态码。2xx 不在候选里不是遗漏——响应一旦是 2xx 就会开始流式输出，
// 内容已经写给 Kiro IDE，无法撤回重放。
//
// reason 取值来自 kiro-agent 内部枚举（解包 extension.js 得到），
// 用于在 402 / 429 里区分「等一会能恢复」和「本周期额度已用尽」。

export interface RetryStatusOption {
  status: number
  /** 简短标题，如「请求过于频繁」 */
  label: string
  /** 一句话说明成因 */
  desc: string
  /** 重试是否通常有效，用于界面上给出建议标记 */
  recommended: boolean
}

/** 界面上可勾选的状态码，顺序即展示顺序 */
export const RETRYABLE_STATUS_OPTIONS: RetryStatusOption[] = [
  {
    status: 429,
    label: '请求过于频繁',
    desc: 'Kiro 风控限流，就是「Too many requests」那个提示。等一会通常能恢复',
    recommended: true
  },
  {
    status: 500,
    label: '服务端内部错误',
    desc: 'Kiro 后端处理失败，属于偶发故障，重试通常能过',
    recommended: true
  },
  {
    status: 502,
    label: '网关错误',
    desc: 'Kiro 上游网关异常，一般是瞬时的',
    recommended: true
  },
  {
    status: 503,
    label: '服务暂时不可用',
    desc: '后端高负载或临时容量不足，与账号额度无关',
    recommended: true
  },
  {
    status: 504,
    label: '网关超时',
    desc: '上游处理超时，重试有机会成功',
    recommended: true
  },
  {
    status: 408,
    label: '请求超时',
    desc: '服务端未在预期时间内收到完整请求，重试通常有效',
    recommended: true
  },
  {
    status: 402,
    label: '额度已用尽',
    desc: '本周期请求次数用完。重试无效，要等额度重置；勾选后仅对非额度类原因生效',
    recommended: false
  },
  {
    status: 403,
    label: '无权限 / 凭证失效',
    desc: 'Key 失效、被封禁或无该模型权限。需要换 Key 或重新登录，重试基本无效',
    recommended: false
  },
  {
    status: 409,
    label: '资源冲突',
    desc: '并发冲突或状态不匹配，少数情况下重试有效',
    recommended: false
  }
]

/** 本周期额度已用尽，重试只是白等 */
export const QUOTA_EXHAUSTED_REASONS = new Set([
  'HOURLY_REQUEST_COUNT',
  'DAILY_REQUEST_COUNT',
  'WEEKLY_REQUEST_COUNT',
  'MONTHLY_REQUEST_COUNT',
  'USAGE_LIMIT_REACHED',
  'OVERAGE_REQUEST_LIMIT_EXCEEDED',
  'CONVERSATION_LIMIT_EXCEEDED'
])

const VALID_STATUSES = new Set(RETRYABLE_STATUS_OPTIONS.map((o) => o.status))

/** 过滤掉不认识的状态码，避免旧配置或手改数据带进无效值 */
export function normalizeRetryStatuses(list: unknown): number[] {
  if (!Array.isArray(list)) return []
  return [...new Set(list.filter((n): n is number => typeof n === 'number' && VALID_STATUSES.has(n)))]
}

export function retryStatusLabel(status: number): string {
  const hit = RETRYABLE_STATUS_OPTIONS.find((o) => o.status === status)
  return hit ? `${status} ${hit.label}` : String(status)
}
