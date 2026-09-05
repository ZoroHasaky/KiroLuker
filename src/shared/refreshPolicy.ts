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
