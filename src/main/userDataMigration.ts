import { copyFileSync, cpSync, existsSync, mkdirSync } from 'fs'
import { join } from 'path'

const LEGACY_USER_DATA_DIRS = ['KiroLuler', 'kiro-account-lite', 'Kiro Manager Lite'] as const
const PRESERVED_FILES = [
  'kiroluler.json',
  'kiro-account-lite.json',
  'kiro-usage-history.json',
  'kiro-gateway-history.json',
  'key-gateway-machine-id'
] as const
const PRESERVED_DIRS = ['backups', 'logs'] as const

/**
 * 复制改名前的必要数据；目标已存在时绝不覆盖，旧目录也不会被删除。
 * 按最近一次旧名到最早上游名的顺序迁移，优先保留较新数据。
 * Chromium 缓存和登录会话不属于持久业务数据，因此不迁移。
 */
export function migrateLegacyUserData(appDataDir: string, targetDir: string): string[] {
  const copied: string[] = []
  mkdirSync(targetDir, { recursive: true })

  for (const legacyName of LEGACY_USER_DATA_DIRS) {
    const legacyDir = join(appDataDir, legacyName)
    if (!existsSync(legacyDir) || legacyDir === targetDir) continue

    for (const name of PRESERVED_FILES) {
      const source = join(legacyDir, name)
      const target = join(targetDir, name)
      if (!existsSync(source) || existsSync(target)) continue
      copyFileSync(source, target)
      copied.push(name)
    }
    for (const name of PRESERVED_DIRS) {
      const source = join(legacyDir, name)
      const target = join(targetDir, name)
      if (!existsSync(source) || existsSync(target)) continue
      cpSync(source, target, { recursive: true })
      copied.push(name)
    }
  }
  return copied
}
