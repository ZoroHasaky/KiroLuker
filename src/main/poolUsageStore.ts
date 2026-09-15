// 提链出口 IP 使用记录（node:sqlite，零新增依赖）
//
// 池端点 IP ≠ 真实出口 IP（同主机相邻端口各走不同上游出口，已实测），
// 计次必须按真实出口算。同一出口 IP 24 小时内最多用于 2 次提链，
// 超额端点在获取阶段就被弃用，只有真正到达 Kiro 的请求才计次。
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'

/** 同一出口 IP 在窗口内的最大提链次数 */
export const MAX_USES_PER_IP = 2
/** 计次窗口：24 小时 */
export const USAGE_WINDOW_MS = 24 * 60 * 60 * 1000

let db: DatabaseSync | null = null

/** 打开（或复用）数据库；首次打开即建表并清理 48h 前的旧记录 */
function open(target?: string): DatabaseSync {
  if (!db) {
    // electron 仅在生产路径触达；沙箱测试注入的是假模块，不会走到这里
    const path = target || join((require('electron') as typeof import('electron')).app.getPath('userData'), 'pool-exit-usage.db')
    db = new DatabaseSync(path)
    db.exec(`
      CREATE TABLE IF NOT EXISTS exit_ip_usage (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        exit_ip TEXT NOT NULL,
        used_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_exit_ip_used_at ON exit_ip_usage (exit_ip, used_at);
    `)
    db.prepare('DELETE FROM exit_ip_usage WHERE used_at < ?').run(Date.now() - 48 * 60 * 60 * 1000)
  }
  return db
}

/** 测试入口：用 :memory: 或临时文件初始化 */
export function _initForTests(target = ':memory:'): void {
  open(target)
}

/** 该出口 IP 自 sinceMs 起的使用次数 */
export function countRecentUsage(exitIp: string, sinceMs: number = USAGE_WINDOW_MS): number {
  const row = open().prepare('SELECT COUNT(*) AS c FROM exit_ip_usage WHERE exit_ip = ? AND used_at >= ?')
    .get(exitIp, Date.now() - sinceMs) as { c: number }
  return row.c
}

/** 记一次使用（到达 Kiro 的提链请求） */
export function recordUsage(exitIp: string): void {
  open().prepare('INSERT INTO exit_ip_usage (exit_ip, used_at) VALUES (?, ?)').run(exitIp, Date.now())
}

/** 删除早于 ms 的记录 */
export function pruneOlderThan(ms: number): void {
  open().prepare('DELETE FROM exit_ip_usage WHERE used_at < ?').run(Date.now() - ms)
}
