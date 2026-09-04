import type { AccountStoreData } from './types'

const ACCOUNT_BACKUP_FORMAT = 'kiroluker-account-backup'
const ACCOUNT_BACKUP_VERSION = 1

interface AccountBackupEnvelope {
  format: typeof ACCOUNT_BACKUP_FORMAT
  version: typeof ACCOUNT_BACKUP_VERSION
  ciphertext: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isEnvelope(value: unknown): value is AccountBackupEnvelope {
  return (
    isRecord(value) &&
    value.format === ACCOUNT_BACKUP_FORMAT &&
    value.version === ACCOUNT_BACKUP_VERSION &&
    typeof value.ciphertext === 'string' &&
    value.ciphertext.length > 0
  )
}

/**
 * 将完整账号快照包装成只包含密文的 JSON，便于继续使用现有滚动备份文件名与清理逻辑。
 * encrypt 由主进程注入，生产环境使用 Electron safeStorage（Windows DPAPI / macOS Keychain）。
 */
export function encodeEncryptedAccountBackup(
  data: AccountStoreData,
  encrypt: (plaintext: string) => string
): string {
  const ciphertext = encrypt(JSON.stringify(data))
  if (!ciphertext) throw new Error('账号备份加密结果为空')
  const envelope: AccountBackupEnvelope = {
    format: ACCOUNT_BACKUP_FORMAT,
    version: ACCOUNT_BACKUP_VERSION,
    ciphertext
  }
  return JSON.stringify(envelope, null, 2)
}

/** 同时读取新版密文备份与旧版明文 AccountStoreData，供升级迁移和删除净化使用。 */
export function decodeAccountBackup(
  content: string,
  decrypt: (ciphertext: string) => string
): { data: unknown; encrypted: boolean } {
  const parsed = JSON.parse(content) as unknown
  if (!isEnvelope(parsed)) return { data: parsed, encrypted: false }
  return { data: JSON.parse(decrypt(parsed.ciphertext)) as unknown, encrypted: true }
}
