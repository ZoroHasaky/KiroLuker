// 用量 / 积分刷新的跳过策略：主进程与渲染进程共用的单一真源
//
// 手动全量刷新、自动定时刷新分散在四个调用点（主进程 keyService、
// 渲染层 KeysView / AccountsView / accounts store），如果各写一遍判定，
// 迟早会漂移成「手动跳过了、自动还在刷」这类不一致。这里统一收口。
//
// 判定原则：只跳过「重试也不会变好」的确定性失败，临时故障一律继续刷。
// 详见 isPermanentFailure 的说明。
import { isPermanentFailure } from './errors'
import type { Account, KeyEntry } from './types'

/** API Key 的异常原因：管理面同步错误与对话测活错误取并集 */
export function keyIssueOf(entry: Pick<KeyEntry, 'lastError' | 'lastChatError'>): string | undefined {
  return entry.lastError || entry.lastChatError
}

/**
 * 该 API Key 是否应跳过用量 / 积分刷新。
 *
 * 只跳确定性失败（凭证被拒、403、账号封禁），这些要换 Key 才能解决。
 * 从没查过的 Key 没有 issue，自然不会被跳过。
 */
export function shouldSkipKeyUsageRefresh(
  entry: Pick<KeyEntry, 'lastError' | 'lastChatError'>
): boolean {
  const issue = keyIssueOf(entry)
  return !!issue && isPermanentFailure(issue)
}

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
