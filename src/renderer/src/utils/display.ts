// 账号信息的展示口径：邮箱与昵称在打码开关下的统一处理
import { maskEmail, maskNickname } from './format'
import type { Account } from '@shared/types'

type NamedAccount = Pick<Account, 'email' | 'nickname'>

/** 打码开启时显示遮罩邮箱，否则显示原文 */
export function displayEmail(email: string, privacy: boolean): string {
  return privacy ? maskEmail(email) : email
}

/** API Key 统一展示：仅隐私模式开启时打码。 */
export function maskKey(key: string): string {
  if (key.length <= 16) return `${key.slice(0, 4)}${'*'.repeat(Math.max(4, key.length - 4))}`
  return `${key.slice(0, 8)}${'*'.repeat(Math.min(16, key.length - 16))}${key.slice(-8)}`
}

export function displayKey(key: string, privacy: boolean): string {
  return privacy ? maskKey(key) : key
}

/**
 * 账号名：打码时用与邮箱同源的遮罩串，否则取昵称、缺昵称时退回邮箱前缀。
 * 昵称往往就是邮箱前缀，打码时必须一起遮罩，否则等于没打码。
 */
export function displayName(account: NamedAccount, privacy: boolean): string {
  if (privacy) return maskNickname(account.email)
  return account.nickname || account.email.split('@')[0]
}
