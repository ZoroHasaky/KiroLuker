// 本地持久化（electron-store，账号数据加密存放）
import Store from 'electron-store'
import { app } from 'electron'
import * as path from 'path'
import * as fs from 'fs/promises'
import {
  DEFAULT_KEY_GATEWAY_DATA,
  DEFAULT_SETTINGS,
  type AccountStoreData,
  type AppSettings,
  type KeyGatewayData
} from '../shared/types'

/** permissions.yaml 开启前的原始状态 */
export interface ShellApproveYamlBackup {
  /** 备份时文件是否存在；false 表示关闭时应删除该文件 */
  existed: boolean
  content: string
}

/** Kiro IDE settings.json 里命令审批相关键的原值 */
export interface ShellApproveSettingsBackup {
  path: string
  /** 原本是否存在该键；false 表示关闭时应删除该键而不是写空数组 */
  hadTrustedCommands: boolean
  trustedCommands?: unknown
  hadCommandDenylist: boolean
  commandDenylist?: unknown
}

/** 开启「自动同意所有 Shell 命令」前的完整配置快照 */
export interface ShellApproveBackup {
  savedAt: number
  yaml?: ShellApproveYamlBackup
  settings?: ShellApproveSettingsBackup
}

interface Schema {
  accountData: AccountStoreData
  settings: AppSettings
  keyData: KeyGatewayData
  shellApproveBackup: ShellApproveBackup | null
}

const EMPTY_DATA: AccountStoreData = { version: 1, accounts: [], activeAccountId: null }

const store = new Store<Schema>({
  name: 'kiro-account-lite',
  encryptionKey: 'kiro-account-lite-local-key',
  defaults: {
    accountData: EMPTY_DATA,
    settings: DEFAULT_SETTINGS,
    keyData: DEFAULT_KEY_GATEWAY_DATA,
    shellApproveBackup: null
  }
})

/** 权限配置备份：仅在开关开启期间存在，关闭还原后清空 */
export function getShellApproveBackup(): ShellApproveBackup | null {
  const raw = store.get('shellApproveBackup') as Record<string, unknown> | null | undefined
  if (!raw || typeof raw !== 'object') return null

  // 1.0.4 之前只备份 permissions.yaml，字段平铺在顶层，这里做一次形状升级
  if (typeof raw.content === 'string' && !raw.yaml && !raw.settings) {
    return {
      savedAt: Number(raw.savedAt) || Date.now(),
      yaml: { existed: raw.existed === true, content: raw.content }
    }
  }
  if (!raw.yaml && !raw.settings) return null
  return raw as unknown as ShellApproveBackup
}

export function setShellApproveBackup(backup: ShellApproveBackup | null): void {
  store.set('shellApproveBackup', backup)
}

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

// ============ Key 网关数据 ============

export function getKeyData(): KeyGatewayData {
  const data = store.get('keyData') as Partial<KeyGatewayData> | undefined
  // 用默认值打底，兼容旧数据缺字段
  const merged: KeyGatewayData = { ...DEFAULT_KEY_GATEWAY_DATA, ...(data ?? {}) }
  if (!Array.isArray(merged.keys)) merged.keys = []
  if (!merged.ports || typeof merged.ports.krs !== 'number' || typeof merged.ports.cps !== 'number') {
    merged.ports = { ...DEFAULT_KEY_GATEWAY_DATA.ports }
  }
  // 当前 Key 只属于已开启的网关；兼容旧版本关闭后仍保留 activeKeyId 的数据。
  if (!merged.enabled || !merged.keys.some((entry) => entry.id === merged.activeKeyId)) {
    merged.activeKeyId = null
  }
  return merged
}

export function setKeyData(data: KeyGatewayData): void {
  store.set('keyData', {
    ...data,
    activeKeyId: data.enabled ? (data.activeKeyId ?? null) : null
  })
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
    console.log(`[Store] 已创建账号备份（共 ${data.accounts.length} 个账号）`)
  } catch (e) {
    console.warn('[Store] backup failed:', e)
  }
}
