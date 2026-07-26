// 本地持久化（electron-store，账号数据加密存放）
import Store from 'electron-store'
import { app } from 'electron'
import * as path from 'path'
import * as fs from 'fs/promises'
import { DEFAULT_SETTINGS, type AccountStoreData, type AppSettings } from '../shared/types'

interface Schema {
  accountData: AccountStoreData
  settings: AppSettings
}

const EMPTY_DATA: AccountStoreData = { version: 1, accounts: [], activeAccountId: null }

const store = new Store<Schema>({
  name: 'kiro-account-lite',
  encryptionKey: 'kiro-account-lite-local-key',
  defaults: { accountData: EMPTY_DATA, settings: DEFAULT_SETTINGS }
})

export function getAccountData(): AccountStoreData {
  const data = store.get('accountData') as AccountStoreData | undefined
  if (!data || !Array.isArray(data.accounts)) return EMPTY_DATA
  return data
}

export async function setAccountData(data: AccountStoreData): Promise<void> {
  store.set('accountData', data)
  await writeBackup(data)
}

export function getSettings(): AppSettings {
  return { ...DEFAULT_SETTINGS, ...(store.get('settings') as Partial<AppSettings>) }
}

export function setSettings(settings: Partial<AppSettings>): AppSettings {
  const merged = { ...getSettings(), ...settings }
  store.set('settings', merged)
  return merged
}

export function getStorePath(): string {
  return store.path
}

// ============ 滚动备份：每次保存留一份，防止 store 损坏丢号 ============

/** 备份最短间隔，避免频繁写盘 */
const BACKUP_INTERVAL_MS = 5 * 60 * 1000
/** 最多保留的备份份数 */
const BACKUP_KEEP = 10

export function getBackupDir(): string {
  return path.join(app.getPath('userData'), 'backups')
}

let lastBackupAt = 0

async function writeBackup(data: AccountStoreData): Promise<void> {
  if (Date.now() - lastBackupAt < BACKUP_INTERVAL_MS) return
  lastBackupAt = Date.now()
  try {
    const dir = getBackupDir()
    await fs.mkdir(dir, { recursive: true })
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    await fs.writeFile(
      path.join(dir, `accounts-${stamp}.json`),
      JSON.stringify(data, null, 2),
      'utf-8'
    )

    // 文件名带 ISO 时间戳，字典序即时间序，取前面的就是最旧的
    const files = (await fs.readdir(dir)).filter((f) => f.startsWith('accounts-')).sort()
    for (const stale of files.slice(0, Math.max(0, files.length - BACKUP_KEEP))) {
      await fs.unlink(path.join(dir, stale)).catch(() => undefined)
    }
  } catch (e) {
    console.warn('[Store] backup failed:', e)
  }
}
