// 系统日志中心：内存环形缓冲 + 分片落盘
//
// 设计要点：
//  - 查询走内存，不读磁盘：界面筛选要即时响应，磁盘只作为重启后的留存与导出来源
//  - 内存用固定容量的环形缓冲，写入 O(1) 且内存占用有上限，不会因为跑一天就吃掉几百 MB
//  - 落盘按条数分片，单个文件写满就换下一个，超过保留份数删最旧的，避免出现巨型日志文件
//  - 写盘批量 flush：日志是高频调用，逐条 appendFile 会把主进程的 IO 拖满
//  - 接管 console：现有代码里到处都是 console.log('[Xxx] ...')，接管后自动入库，
//    不需要逐个改调用点，也不影响终端输出
import { app } from 'electron'
import * as path from 'path'
import * as fs from 'fs/promises'
import { LOG_LEVELS, type LogEntry, type LogLevel, type LogQuery, type LogQueryResult } from '../shared/types'

/** 内存里最多保留多少条，超出丢弃最旧的 */
const MEMORY_CAPACITY = 50_000
/** 单个分片文件最多多少条 */
const LINES_PER_FILE = 5_000
/** 最多保留多少个分片文件 */
const KEEP_FILES = 10
/** 写盘批量间隔 */
const FLUSH_INTERVAL_MS = 800
/** 单条消息最大长度，超长截断，避免个别巨量响应体把内存吃满 */
const MAX_MESSAGE_LENGTH = 4_000

/** 环形缓冲：写满后从头覆盖，entries 的物理顺序不代表时间顺序 */
const buffer: (LogEntry | undefined)[] = new Array(MEMORY_CAPACITY)
let writeIndex = 0
let stored = 0
let nextId = 1

/** 各级别计数，随环形覆盖同步增减，避免每次查询都全量统计 */
const counts: Record<LogLevel, number> = { debug: 0, info: 0, warn: 0, error: 0 }
/** 分类 -> 条数，计数归零即从下拉选项里移除 */
const categoryCounts = new Map<string, number>()

/** 待落盘队列 */
let pending: LogEntry[] = []
let flushTimer: ReturnType<typeof setInterval> | null = null

/** 当前分片文件与已写行数 */
let currentFile: string | null = null
let currentLines = 0

let notify: ((total: number) => void) | null = null

// ============ 磁盘 ============

export function getLogDir(): string {
  return path.join(app.getPath('userData'), 'logs')
}

function newFileName(): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  return path.join(getLogDir(), `app-${stamp}.log`)
}

/** 清掉超出保留份数的旧分片。文件名带 ISO 时间戳，字典序即时间序 */
async function pruneFiles(): Promise<void> {
  try {
    const dir = getLogDir()
    const files = (await fs.readdir(dir)).filter((f) => f.startsWith('app-') && f.endsWith('.log')).sort()
    for (const stale of files.slice(0, Math.max(0, files.length - KEEP_FILES))) {
      await fs.unlink(path.join(dir, stale)).catch(() => undefined)
    }
  } catch {
    // 目录还不存在等情况直接忽略
  }
}

/** 把待落盘队列写出去，按分片上限自动换文件 */
async function flush(): Promise<void> {
  if (pending.length === 0) return
  const batch = pending
  pending = []

  try {
    await fs.mkdir(getLogDir(), { recursive: true })
    let rest = batch
    while (rest.length > 0) {
      if (!currentFile || currentLines >= LINES_PER_FILE) {
        currentFile = newFileName()
        currentLines = 0
        await pruneFiles()
      }
      const room = LINES_PER_FILE - currentLines
      const slice = rest.slice(0, room)
      rest = rest.slice(room)
      const text = slice.map((e) => JSON.stringify(e)).join('\n') + '\n'
      await fs.appendFile(currentFile, text, 'utf-8')
      currentLines += slice.length
    }
  } catch {
    // 写盘失败不能影响主流程，也不能再走 log() 否则可能递归
  }
}

// ============ 写入 ============

/** 从 `[Category] message` 里拆出分类；没有前缀则归到 App */
function splitCategory(raw: string): { category: string; message: string } {
  const match = /^\[([^\]]{1,24})\]\s*(.*)$/s.exec(raw)
  if (!match) return { category: 'App', message: raw }
  return { category: match[1], message: match[2] || raw }
}

function decCategory(category: string): void {
  const left = (categoryCounts.get(category) ?? 1) - 1
  if (left <= 0) categoryCounts.delete(category)
  else categoryCounts.set(category, left)
}

/** 记录一条日志 */
export function log(level: LogLevel, raw: string): void {
  const text = raw.length > MAX_MESSAGE_LENGTH ? `${raw.slice(0, MAX_MESSAGE_LENGTH)}…（已截断）` : raw
  const { category, message } = splitCategory(text)
  const entry: LogEntry = { id: nextId++, at: Date.now(), level, category, message }

  // 覆盖位置上的旧记录要先把它的计数扣掉
  const replaced = buffer[writeIndex]
  if (replaced) {
    counts[replaced.level]--
    decCategory(replaced.category)
  } else {
    stored++
  }
  buffer[writeIndex] = entry
  writeIndex = (writeIndex + 1) % MEMORY_CAPACITY

  counts[level]++
  categoryCounts.set(category, (categoryCounts.get(category) ?? 0) + 1)

  pending.push(entry)
  notify?.(stored)
}

// ============ 查询 ============

/** 按时间升序遍历内存缓冲 */
function forEachChronological(visit: (entry: LogEntry) => void): void {
  // 未写满时 0..stored-1 就是时间序；写满后从 writeIndex 开始才是最旧的
  const start = stored < MEMORY_CAPACITY ? 0 : writeIndex
  for (let i = 0; i < stored; i++) {
    const entry = buffer[(start + i) % MEMORY_CAPACITY]
    if (entry) visit(entry)
  }
}

export function queryLogs(query: LogQuery = {}): LogQueryResult {
  const { keyword, levels, category, since, limit = 1000 } = query
  const needle = keyword?.trim().toLowerCase()
  const levelSet = levels && levels.length ? new Set(levels) : null

  // 只保留最新 limit 条：用定长队列边遍历边淘汰，避免先收集全部再切片
  const hits: LogEntry[] = []
  let matched = 0
  forEachChronological((entry) => {
    if (levelSet && !levelSet.has(entry.level)) return
    if (category && entry.category !== category) return
    if (since !== undefined && entry.at < since) return
    if (needle) {
      const haystack = `${entry.category} ${entry.message}`.toLowerCase()
      if (!haystack.includes(needle)) return
    }
    matched++
    hits.push(entry)
    if (hits.length > limit) hits.shift()
  })

  return {
    entries: hits,
    matched,
    total: stored,
    counts: { ...counts },
    categories: [...categoryCounts.keys()].sort()
  }
}

/** 清空内存与磁盘上的全部日志 */
export async function clearLogs(): Promise<void> {
  buffer.fill(undefined)
  writeIndex = 0
  stored = 0
  pending = []
  for (const level of LOG_LEVELS) counts[level] = 0
  categoryCounts.clear()
  currentFile = null
  currentLines = 0

  try {
    const dir = getLogDir()
    const files = await fs.readdir(dir)
    for (const file of files.filter((f) => f.startsWith('app-') && f.endsWith('.log'))) {
      await fs.unlink(path.join(dir, file)).catch(() => undefined)
    }
  } catch {
    // 目录不存在即无需清理
  }
  notify?.(0)
}

/** 导出为纯文本，供界面下载。不传筛选就是全部 */
export function exportLogs(query: LogQuery = {}): string {
  const { entries } = queryLogs({ ...query, limit: MEMORY_CAPACITY })
  return entries
    .map((e) => `${new Date(e.at).toISOString()} [${e.level.toUpperCase()}] [${e.category}] ${e.message}`)
    .join('\n')
}

// ============ 接管 console ============

type ConsoleMethod = 'debug' | 'log' | 'info' | 'warn' | 'error'

/** console 方法到日志级别的映射 */
const METHOD_LEVEL: Record<ConsoleMethod, LogLevel> = {
  debug: 'debug',
  log: 'info',
  info: 'info',
  warn: 'warn',
  error: 'error'
}

/** 把参数拼成一行文本，Error 取 message，对象走 JSON */
function stringify(args: unknown[]): string {
  return args
    .map((arg) => {
      if (typeof arg === 'string') return arg
      if (arg instanceof Error) return arg.message
      try {
        return JSON.stringify(arg)
      } catch {
        return String(arg)
      }
    })
    .join(' ')
}

let consoleInstalled = false

/**
 * 接管主进程 console：原样输出到终端，同时写入日志中心。
 * 现有代码里的 console.log('[Net] ...') 因此自动进入日志页，无需改调用点。
 */
export function installConsoleBridge(): void {
  if (consoleInstalled) return
  consoleInstalled = true

  for (const method of Object.keys(METHOD_LEVEL) as ConsoleMethod[]) {
    const original = console[method].bind(console)
    console[method] = (...args: unknown[]): void => {
      original(...args)
      try {
        log(METHOD_LEVEL[method], stringify(args))
      } catch {
        // 记录失败绝不能影响业务，也不要再打日志避免递归
      }
    }
  }
}

/** 启动日志中心：登记新日志回调并开始周期落盘 */
export function initLogger(onAppend: (total: number) => void): void {
  notify = onAppend
  if (!flushTimer) flushTimer = setInterval(() => void flush(), FLUSH_INTERVAL_MS)
}

/** 退出前把剩余日志刷出去 */
export async function shutdownLogger(): Promise<void> {
  if (flushTimer) clearInterval(flushTimer)
  flushTimer = null
  await flush()
}
