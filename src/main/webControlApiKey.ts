import { createHash, randomBytes, randomUUID } from 'node:crypto'
import {
  type WebControlApiKeyPublic,
  type WebControlApiKeyRecord,
  type WebControlAuthData,
  WEB_API_SCOPES
} from '../shared/webControl'

export const MOBILE_APP_API_KEY_NAME = '移动 App'

export interface WebControlApiKeyProtector {
  encrypt: (value: string) => string
  decrypt: (value: string) => string
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('base64url')
}

function hasAllScopes(scopes: readonly string[]): boolean {
  return scopes.length === WEB_API_SCOPES.length && WEB_API_SCOPES.every((scope) => scopes.includes(scope))
}

function active(record: WebControlApiKeyRecord): boolean {
  return !record.revokedAt
}

function isUsableMobileKey(record: WebControlApiKeyRecord, protector: WebControlApiKeyProtector): boolean {
  if (!active(record) || record.name !== MOBILE_APP_API_KEY_NAME || !hasAllScopes(record.scopes) || !record.encryptedToken) return false
  try {
    const token = protector.decrypt(record.encryptedToken)
    return token.startsWith('klr_') && sha256(token) === record.hash
  } catch {
    return false
  }
}

function newMobileKey(protector: WebControlApiKeyProtector): WebControlApiKeyRecord {
  const token = `klr_${randomBytes(32).toString('base64url')}`
  return {
    id: randomUUID(),
    name: MOBILE_APP_API_KEY_NAME,
    prefix: token.slice(0, 14),
    hash: sha256(token),
    scopes: [...WEB_API_SCOPES],
    createdAt: Date.now(),
    encryptedToken: protector.encrypt(token)
  }
}

function replaceActiveKey(auth: WebControlAuthData, protector: WebControlApiKeyProtector): WebControlAuthData {
  const replacement = newMobileKey(protector)
  const revokedAt = Date.now()
  return {
    ...auth,
    version: 2,
    // 兼容旧版本保存的多 Key：保留审计记录，但全部立即失效，避免遗留 Key 继续访问移动 API。
    apiKeys: [...auth.apiKeys.map((item) => active(item) ? { ...item, revokedAt } : item), replacement]
  }
}

/**
 * 保证移动登录只有一个当前 Key。旧版可存在多把 Key，但因没有可安全恢复的明文，升级时会被撤销并生成受系统安全存储保护的新 Key。
 */
export function ensureDefaultMobileApiKey(
  auth: WebControlAuthData,
  protector: WebControlApiKeyProtector
): { auth: WebControlAuthData; item: WebControlApiKeyRecord; changed: boolean } {
  const activeKeys = auth.apiKeys.filter(active)
  const current = activeKeys.find((item) => isUsableMobileKey(item, protector))
  if (current && activeKeys.length === 1) {
    const next = auth.version === 2 ? auth : { ...auth, version: 2 as const }
    return { auth: next, item: current, changed: next !== auth }
  }
  const next = replaceActiveKey(auth, protector)
  return { auth: next, item: next.apiKeys.at(-1)!, changed: true }
}

/** 重新创建时立即撤销当前 Key，并生成一把具备全部权限的新 Key。 */
export function regenerateMobileApiKey(
  auth: WebControlAuthData,
  protector: WebControlApiKeyProtector
): { auth: WebControlAuthData; item: WebControlApiKeyRecord } {
  const next = replaceActiveKey(auth, protector)
  return { auth: next, item: next.apiKeys.at(-1)! }
}

/** 仅桌面主进程调用；密文只在请求复制时解密，不会写入 API 响应或列表 IPC。 */
export function readMobileApiKey(auth: WebControlAuthData, protector: WebControlApiKeyProtector): string {
  const current = auth.apiKeys.filter(active).find((item) => isUsableMobileKey(item, protector))
  if (!current?.encryptedToken) throw new Error('移动 App API Key 尚未生成，请先启动 API 服务')
  return protector.decrypt(current.encryptedToken)
}

export function publicApiKey(record: WebControlApiKeyRecord): WebControlApiKeyPublic {
  return {
    id: record.id,
    name: record.name,
    prefix: record.prefix,
    scopes: [...record.scopes],
    createdAt: record.createdAt,
    lastUsedAt: record.lastUsedAt,
    revokedAt: record.revokedAt
  }
}

export function getCurrentMobileApiKey(auth: WebControlAuthData, protector: WebControlApiKeyProtector): WebControlApiKeyPublic | null {
  const current = auth.apiKeys.filter(active).find((item) => isUsableMobileKey(item, protector))
  return current ? publicApiKey(current) : null
}