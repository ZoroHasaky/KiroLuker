// 账号信息的展示口径：邮箱与昵称在打码开关下的统一处理
import { maskEmail, maskNickname } from './format'
import type { Account } from '@shared/types'

type NamedAccount = Pick<Account, 'email' | 'nickname'>

/** 打码开启时显示遮罩邮箱，否则显示原文 */
export function displayEmail(email: string, privacy: boolean): string {
  return privacy ? maskEmail(email) : email
}

/**
 * 账号名：打码时用与邮箱同源的遮罩串，否则取昵称、缺昵称时退回邮箱前缀。
 * 昵称往往就是邮箱前缀，打码时必须一起遮罩，否则等于没打码。
 */
export function displayName(account: NamedAccount, privacy: boolean): string {
  if (privacy) return maskNickname(account.email)
  return account.nickname || account.email.split('@')[0]
}
