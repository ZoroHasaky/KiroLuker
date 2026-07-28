// Kiro IDE settings.json 读写层
//
// Key 网关要接管 Kiro IDE 的内置对话，靠的是把 IDE 用户设置里的
//   codewhisperer.config.krsEndpoints  （生成面）
//   codewhisperer.config.cpsEndpoints  （控制面）
// 指向本应用起的本地代理，让 kiro-agent 透明地走到我们这里。
//
// 本应用位于 IDE 进程之外，无法使用 vscode API 获取当前 profile，
// 因此按平台默认路径定位 <userData>/User/settings.json，并对 profile 进行兜底扫描。
import * as fs from 'fs/promises'
import {
  existsSync,
  readFileSync,
  writeFileSync,
  renameSync,
  unlinkSync,
  mkdirSync
} from 'fs'
import * as path from 'path'
import * as os from 'os'

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

/** 我们对外声明会重定向的区域；本地代理统一转发到用户配置的实际区域 */
const REDIRECT_REGIONS = ['us-east-1', 'eu-central-1']

export interface EndpointEntry {
  region: string
  endpoint: string
}

export interface EndpointSnapshot {
  krs: EndpointEntry[]
  cps: EndpointEntry[]
}

/** 生成指向本地端口的端点覆盖列表（含当前区域，避免漏掉正在用的那个） */
function endpointOverride(port: number, activeRegion: string): EndpointEntry[] {
  const regions = [...new Set([activeRegion, ...REDIRECT_REGIONS].map((r) => r.trim()).filter(Boolean))]
  return regions.map((region) => ({ region, endpoint: `http://127.0.0.1:${port}` }))
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

/** 原子写回 settings.json（保留一份 .kiro-manager.bak 首次备份） */
async function writeSettings(file: string, obj: Record<string, unknown>): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true })
  const backup = file + '.kiro-manager.bak'
  if (existsSync(file) && !existsSync(backup)) {
    await fs.copyFile(file, backup).catch(() => undefined)
  }
  const tmp = file + '.kiro-manager.tmp'
  const text = JSON.stringify(obj, null, 2) + '\n'
  await fs.writeFile(tmp, text, 'utf-8')
  try {
    await fs.rename(tmp, file)
  } catch {
    await fs.writeFile(file, text, 'utf-8')
    await fs.unlink(tmp).catch(() => undefined)
  }
}

function normalizeList(value: unknown): EndpointEntry[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((e): e is Record<string, unknown> => !!e && typeof e === 'object')
    .map((e) => ({
      region: String(e.region || '').trim(),
      endpoint: String(e.endpoint || '').trim().replace(/\/$/, '')
    }))
    .filter((e) => e.region && e.endpoint)
    .sort((a, b) => a.region.localeCompare(b.region) || a.endpoint.localeCompare(b.endpoint))
}

function listsEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(normalizeList(a)) === JSON.stringify(normalizeList(b))
}

/** 读取当前两个端点，并规范化成可持久化的快照。 */
export async function readEndpointSnapshot(file = kiroSettingsPath()): Promise<EndpointSnapshot> {
  const obj = await readSettings(file)
  return { krs: normalizeList(obj[KRS_KEY]), cps: normalizeList(obj[CPS_KEY]) }
}

/**
 * 开启前互斥检查：只要端点已经指向其它本地地址，就不能覆盖，
 * 避免多个本地网关同时修改同一份 IDE 配置。
 */
export async function endpointConflict(
  krsPort: number,
  cpsPort: number,
  activeRegion: string
): Promise<string | null> {
  const obj = await readSettings(kiroSettingsPath())
  const expectedKrs = endpointOverride(krsPort, activeRegion)
  const expectedCps = endpointOverride(cpsPort, activeRegion)
  const local = [...normalizeList(obj[KRS_KEY]), ...normalizeList(obj[CPS_KEY])]
    .filter((entry) => /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?/i.test(entry.endpoint))
  if (!local.length) return null
  if (listsEqual(obj[KRS_KEY], expectedKrs) && listsEqual(obj[CPS_KEY], expectedCps)) return null
  const endpoints = [...new Set(local.map((entry) => entry.endpoint))].join('、')
  return `Kiro IDE 已被其它本地网关接管（${endpoints}）。请先关闭其它本地网关或同类工具。`
}

/**
 * 把端点指向本地代理。已经是目标值则不重复写。
 * 返回原始端点，关闭时必须原样恢复，而不是武断地清空数组。
 */
export async function applyEndpointOverride(
  krsPort: number,
  cpsPort: number,
  activeRegion: string
): Promise<{ changed: boolean; settingsPath: string; original: EndpointSnapshot }> {
  const file = kiroSettingsPath()
  const obj = await readSettings(file)
  const original = { krs: normalizeList(obj[KRS_KEY]), cps: normalizeList(obj[CPS_KEY]) }
  const krsExpected = endpointOverride(krsPort, activeRegion)
  const cpsExpected = endpointOverride(cpsPort, activeRegion)

  if (listsEqual(obj[KRS_KEY], krsExpected) && listsEqual(obj[CPS_KEY], cpsExpected)) {
    return { changed: false, settingsPath: file, original }
  }
  obj[KRS_KEY] = krsExpected
  obj[CPS_KEY] = cpsExpected
  await writeSettings(file, obj)

  // 写后回读校验，不能把“写文件没抛错”当作接管成功。
  const readBack = await readSettings(file)
  if (!listsEqual(readBack[KRS_KEY], krsExpected) || !listsEqual(readBack[CPS_KEY], cpsExpected)) {
    readBack[KRS_KEY] = original.krs
    readBack[CPS_KEY] = original.cps
    await writeSettings(file, readBack).catch(() => undefined)
    throw new Error(`Kiro 端点写入后校验失败，已恢复原配置：${file}`)
  }
  return { changed: true, settingsPath: file, original }
}

/** 恢复到接管前记录的端点值。 */
export async function restoreEndpointOverride(
  original: EndpointSnapshot = { krs: [], cps: [] },
  file = kiroSettingsPath()
): Promise<{ changed: boolean; settingsPath: string }> {
  const obj = await readSettings(file)
  if (listsEqual(obj[KRS_KEY], original.krs) && listsEqual(obj[CPS_KEY], original.cps)) {
    return { changed: false, settingsPath: file }
  }
  obj[KRS_KEY] = original.krs
  obj[CPS_KEY] = original.cps
  await writeSettings(file, obj)
  return { changed: true, settingsPath: file }
}

/**
 * Electron will-quit 不等待 Promise，退出路径必须同步完成配置还原。
 * 只修改两个端点键，其余设置保留。
 */
export function restoreEndpointOverrideSync(
  original: EndpointSnapshot = { krs: [], cps: [] },
  file = kiroSettingsPath()
): void {
  try {
    const raw = existsSync(file) ? readFileSync(file, 'utf-8') : '{}'
    const obj = parseJsonc(raw)
    obj[KRS_KEY] = original.krs
    obj[CPS_KEY] = original.cps
    mkdirSync(path.dirname(file), { recursive: true })
    const tmp = file + '.kiro-manager.tmp'
    const text = JSON.stringify(obj, null, 2) + '\n'
    writeFileSync(tmp, text, 'utf-8')
    try {
      renameSync(tmp, file)
    } catch {
      writeFileSync(file, text, 'utf-8')
      try {
        unlinkSync(tmp)
      } catch {
        /* ignore */
      }
    }
  } catch {
    // 退出阶段不能抛异常阻断其它清理；主进程下次启动还会再做残留恢复。
  }
}

/** 当前 settings.json 里端点是否已指向指定端口的本地代理 */
export async function isEndpointBound(krsPort: number, cpsPort: number, activeRegion: string): Promise<boolean> {
  const file = kiroSettingsPath()
  const obj = await readSettings(file)
  return (
    listsEqual(obj[KRS_KEY], endpointOverride(krsPort, activeRegion)) &&
    listsEqual(obj[CPS_KEY], endpointOverride(cpsPort, activeRegion))
  )
}
