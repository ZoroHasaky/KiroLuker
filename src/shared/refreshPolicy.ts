// 账号用量 / 积分刷新共用的跳过策略，避免手动刷新与自动刷新判定不一致。
//
// 判定原则：只跳过「重试也不会变好」的确定性失败，临时故障一律继续刷。
// 详见 isPermanentFailure 的说明。
import { isPermanentFailure } from './errors'
import type { Account } from './types'

/**
 * 该账号是否应跳过用量 / 积分刷新。
 *
 * banned 是服务端明确的封禁，expired 表示 refreshToken 已被拒，
 * 两者都要重新登录才能恢复。status 为 error 时再看错误内容：
 * 网络、限流、5xx 这类临时故障必须继续刷，否则一次抖动就永久停刷。
 */
export function shouldSkipAccountUsageRefresh(
  account: Pick<Account, 'status' | 'lastError'>
): boolean {
  if (account.status === 'banned' || account.status === 'expired') return true
  return account.status === 'error' && isPermanentFailure(account.lastError || '')
}

/**
 * 该账号是否达到指定用量百分比阈值并跳过刷新。
 *
 * @param account 待检测的账号
 * @param enabled 是否开启跳过功能
 * @param thresholdPercent 阈值百分比（1-100）
 */
export function shouldSkipAccountUsageByPercent(
  account: { usage?: { limit?: number; percentUsed?: number } | null },
  enabled: boolean,
  thresholdPercent: number
): boolean {
  if (!enabled || !account.usage) return false
  const limit = account.usage.limit ?? 0
  // limit 未设置或为 0 说明用量数据尚未拉取或无额度定义，不根据百分比跳过
  if (limit <= 0) return false
  const percent = (account.usage.percentUsed ?? 0) * 100
  return percent >= thresholdPercent
}

