// Kiro IDE settings.json 读写层
//
// 仅保留通用设置读写及旧版网关端点的安全还原，不再接管或守护 IDE 端点。
//
// 本应用位于 IDE 进程之外，无法使用 vscode API 获取当前 profile，
// 因此按平台默认路径定位 <userData>/User/settings.json，并对 profile 进行兜底扫描。
import * as fs from 'fs/promises'
import { existsSync } from 'fs'
import * as path from 'path'
import * as os from 'os'
import { URL } from 'url'

/** Kiro IDE 用户数据根目录（跨平台） */
function kiroUserDataDir(): string {
  const home = os.homedir()
  if (process.platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'Kiro')
  }
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'Kiro')
  }
  // Linux 及其它
  return path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), 'Kiro')
}

/**
 * 定位当前生效的 settings.json。
 * 默认返回 <userData>/User/settings.json；若该文件不存在但存在 profile 目录，
 * 则退而取第一个 profile 的 settings.json（多数用户用默认 profile，直接命中第一条）。
 */
export function kiroSettingsPath(): string {
  const base = path.join(kiroUserDataDir(), 'User')
  const defaultPath = path.join(base, 'settings.json')
  if (existsSync(defaultPath)) return defaultPath

  // profile 场景兜底
  const profilesDir = path.join(base, 'profiles')
  if (existsSync(profilesDir)) {
    try {
      const entries = require('fs').readdirSync(profilesDir) as string[]
      for (const name of entries) {
        const p = path.join(profilesDir, name, 'settings.json')
        if (existsSync(p)) return p
      }
    } catch {
      /* ignore */
    }
  }
  return defaultPath
}

/** Kiro IDE 是否已安装（存在用户数据目录） */
export function isKiroInstalled(): boolean {
  return existsSync(kiroUserDataDir())
}

const KRS_KEY = 'codewhisperer.config.krsEndpoints'
const CPS_KEY = 'codewhisperer.config.cpsEndpoints'

export interface EndpointEntry {
  region: string
  endpoint: string
}

export interface EndpointSnapshot {
  krs: EndpointEntry[]
  cps: EndpointEntry[]
}

/**
 * 解析可能带注释 / 尾逗号的 JSONC（VSCode 系 settings.json 允许注释）。
 * 简单粗暴地剥掉 // 与 /* *\/ 注释和尾逗号后再 JSON.parse。
 */
function parseJsonc(raw: string): Record<string, unknown> {
  const text = String(raw || '').replace(/^\uFEFF/, '')
  const stripped = text
    .replace(/\\"|"(?:\\"|[^"])*"|(\/\/[^\n\r]*|\/\*[\s\S]*?\*\/)/g, (m, c) => (c ? '' : m))
    .replace(/,(\s*[}\]])/g, '$1')
  return JSON.parse(stripped || '{}')
}

async function readSettings(file: string): Promise<Record<string, unknown>> {
  try {
    const raw = await fs.readFile(file, 'utf-8')
    return parseJsonc(raw)
  } catch {
    return {}
  }
}

/** 原子写回 settings.json（保留一份 .kiroluker.bak 首次备份，并识别历史备份） */
async function writeSettings(file: string, obj: Record<string, unknown>): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true })
  const backup = file + '.kiroluker.bak'
  const legacyBackups = [file + '.kiroluler.bak', file + '.kiro-manager.bak']
  if (existsSync(file) && !existsSync(backup) && !legacyBackups.some(existsSync)) {
    await fs.copyFile(file, backup).catch(() => undefined)
  }
  const tmp = file + '.kiroluker.tmp'
  const text = JSON.stringify(obj, null, 2) + '\n'
  await fs.writeFile(tmp, text, 'utf-8')
  try {
    await fs.rename(tmp, file)
  } catch {
    await fs.writeFile(file, text, 'utf-8')
    await fs.unlink(tmp).catch(() => undefined)
  }
}

/**
 * 供其它模块复用的 settings.json 读写（如「自动同意所有 Shell 命令」需要改 kiroAgent.* 键）。
 * 统一走同一套 JSONC 解析 + 首次备份 + 原子写，避免出现第二套实现。
 */
export async function readKiroSettingsObject(
  file = kiroSettingsPath()
): Promise<Record<string, unknown>> {
  return readSettings(file)
}

export async function writeKiroSettingsObject(
  obj: Record<string, unknown>,
  file = kiroSettingsPath()
): Promise<void> {
  return writeSettings(file, obj)
}

/** 只识别本应用历史端口上的本机端点，不能误删其它工具或远程服务的配置。 */
function isRetiredEndpoint(entry: unknown, port: number): boolean {
  if (!entry || typeof entry !== 'object' || !Number.isInteger(port) || port < 1 || port > 65535) {
    return false
  }
  const endpoint = (entry as Record<string, unknown>).endpoint
  if (typeof endpoint !== 'string') return false
  try {
    const url = new URL(endpoint)
    return (
      ['http:', 'https:'].includes(url.protocol) &&
      ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) &&
      Number(url.port || (url.protocol === 'https:' ? 443 : 80)) === port &&
      url.pathname === '/' && !url.search && !url.hash && !url.username && !url.password
    )
  } catch {
    return false
  }
}

function restoreRetiredEntries(current: unknown[], original: EndpointEntry[], port: number): unknown[] {
  const owned = current.filter((entry) => isRetiredEndpoint(entry, port))
  const remaining = current.filter((entry) => !isRetiredEndpoint(entry, port))
  const backup = original.filter((entry) => !isRetiredEndpoint(entry, port))
  // 整列仍由旧网关占用时恢复原快照，包括原先不在接管区域列表中的条目。
  if (!remaining.length) return backup

  // 用户或其它工具已部分改写：只恢复仍由我们占用的区域，保留后来改过的值。
  const ownedRegions = new Set(owned.map((entry) => (entry as EndpointEntry).region))
  const keptRegions = new Set(remaining.map((entry) =>
    entry && typeof entry === 'object' ? (entry as EndpointEntry).region : undefined
  ))
  return [
    ...remaining,
    ...backup.filter((entry) => ownedRegions.has(entry.region) && !keptRegions.has(entry.region))
  ]
}

/**
 * 移除网关功能后的单次兼容清理。只有仍指向历史端口的条目才会还原。
 * 读取/解析失败必须抛出，由调用方保留恢复快照重试，不能拿空对象覆盖用户设置。
 */
export async function restoreLegacyGatewayEndpoints(
  original: EndpointSnapshot | undefined,
  ports: { krs: number; cps: number },
  file = kiroSettingsPath()
): Promise<{ changed: boolean; settingsPath: string }> {
  let raw: string
  try {
    raw = await fs.readFile(file, 'utf-8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { changed: false, settingsPath: file }
    }
    throw error
  }
  const obj = parseJsonc(raw)
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    throw new Error('Kiro settings.json 必须是 JSON 对象，已保留旧网关恢复快照')
  }
  let changed = false
  for (const [key, service] of [[KRS_KEY, 'krs'], [CPS_KEY, 'cps']] as const) {
    const current = obj[key]
    if (!Array.isArray(current) || !current.some((entry) => isRetiredEndpoint(entry, ports[service]))) {
      continue
    }
    const snapshot = Array.isArray(original?.[service]) ? original[service] : []
    obj[key] = restoreRetiredEntries(current, snapshot, ports[service])
    changed = true
  }
  if (changed) await writeSettings(file, obj)
  return { changed, settingsPath: file }
}
