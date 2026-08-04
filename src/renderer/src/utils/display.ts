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
 * 账号唯一标识（形如 d-9067c98495.d49834d8-80b1-70c0-943f-8fbac18f1c23）的打码。
 *
 * 保留点号前的目录 ID 与 UUID 首段：同一个账号签发的多个 API Key 会共用同一个 userId，
 * 留出这两段用户才能在打码状态下肉眼比对出「这几个 Key 其实是一个号」。
 */
export function maskUserId(value: string): string {
  const dot = value.indexOf('.')
  if (dot <= 0) {
    if (value.length <= 12) return value
    return `${value.slice(0, 8)}${'•'.repeat(12)}${value.slice(-4)}`
  }
  const directory = value.slice(0, dot)
  const rest = value.slice(dot + 1)
  if (rest.length <= 12) return `${directory}.${rest}`
  return `${directory}.${rest.slice(0, 8)}${'•'.repeat(12)}${rest.slice(-4)}`
}

export function displayUserId(value: string, privacy: boolean): string {
  return privacy ? maskUserId(value) : value
}

/**
 * 账号名：打码时用与邮箱同源的遮罩串，否则取昵称、缺昵称时退回邮箱前缀。
 * 昵称往往就是邮箱前缀，打码时必须一起遮罩，否则等于没打码。
 */
export function displayName(account: NamedAccount, privacy: boolean): string {
  if (privacy) return maskNickname(account.email)
  return account.nickname || account.email.split('@')[0]
}
