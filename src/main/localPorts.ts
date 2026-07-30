// 本地端口占用探测与释放
//
// 强制接管 Kiro IDE 时，除了改写 settings.json 端点，还要把仍在监听旧端点的
// 其它本地网关进程停掉，否则用户会看到「已切换但对话仍走旧工具」的中间状态。
// 只处理 127.0.0.1 上的监听进程，且绝不动本应用自身的进程。
import { execFile } from 'child_process'
import { log } from './logger'
import { sleep } from './utils'
import type { KeyGatewayReleaseResult } from '../shared/types'

/** execFile 的 promise 版：只关心 stdout，失败不抛 */
function run(cmd: string, args: string[], timeout = 8000): Promise<{ ok: boolean; stdout: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, windowsHide: true }, (error, stdout) => {
      resolve({ ok: !error, stdout: String(stdout ?? '') })
    })
  })
}

function parsePids(text: string): number[] {
  const pids = new Set<number>()
  for (const raw of String(text || '').split(/\r?\n/)) {
    const pid = Number(raw.trim())
    // 本应用自身也可能监听同一端口（例如端点区域不匹配导致的冲突），必须排除，
    // 否则强制接管会把管理器自己杀掉。
    if (Number.isInteger(pid) && pid > 1 && pid !== process.pid) pids.add(pid)
  }
  return [...pids]
}

/** Windows 上从 netstat 输出里挑出监听指定端口的 PID */
function parseWindowsPids(stdout: string, port: number): number[] {
  const pids = new Set<number>()
  for (const line of String(stdout || '').split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/)
    if (parts.length < 5) continue
    const [, local, , state, pidText] = parts
    if (!/^LISTENING$/i.test(state)) continue
    if (!new RegExp(`[:.]${port}$`).test(local)) continue
    const pid = Number(pidText)
    if (Number.isInteger(pid) && pid > 1 && pid !== process.pid) pids.add(pid)
  }
  return [...pids]
}

/** 查询正在监听某个本地端口的进程（不含本应用自身） */
export async function listListeningPids(port: number): Promise<number[]> {
  if (process.platform === 'win32') {
    const res = await run('netstat', ['-ano', '-p', 'tcp'])
    return parseWindowsPids(res.stdout, port)
  }
  const res = await run('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'])
  return parsePids(res.stdout)
}

async function terminate(pid: number, force: boolean): Promise<void> {
  if (process.platform === 'win32') {
    const args = force ? ['/F', '/T', '/PID', String(pid)] : ['/T', '/PID', String(pid)]
    await run('taskkill', args)
    return
  }
  try {
    process.kill(pid, force ? 'SIGKILL' : 'SIGTERM')
  } catch {
    // 进程可能已经退出，或没有权限；由后续端口复查给出结论
  }
}

/**
 * 释放单个本地端口：先优雅终止，未退出再强杀。
 * 端口上没有其它进程时直接视为已释放。
 */
export async function releasePort(port: number): Promise<KeyGatewayReleaseResult> {
  const pids = await listListeningPids(port)
  if (!pids.length) {
    return { port, pids: [], stopped: true, message: `端口 ${port} 没有其它进程占用` }
  }

  for (const pid of pids) await terminate(pid, false)
  let remaining = pids
  for (let attempt = 0; attempt < 10 && remaining.length; attempt++) {
    await sleep(200)
    remaining = await listListeningPids(port)
  }
  if (remaining.length) {
    for (const pid of remaining) await terminate(pid, true)
    for (let attempt = 0; attempt < 10 && remaining.length; attempt++) {
      await sleep(200)
      remaining = await listListeningPids(port)
    }
  }

  const stopped = remaining.length === 0
  const pidText = pids.join('、')
  return {
    port,
    pids,
    stopped,
    message: stopped
      ? `端口 ${port} 已释放（原进程 PID ${pidText}）`
      : `端口 ${port} 仍被 PID ${remaining.join('、')} 占用，可能需要手动关闭该程序`
  }
}

/** 依次释放多个端口，逐个记录结果，不因单个失败中断 */
export async function releasePorts(ports: number[]): Promise<KeyGatewayReleaseResult[]> {
  const results: KeyGatewayReleaseResult[] = []
  for (const port of [...new Set(ports)]) {
    const result = await releasePort(port)
    log(result.stopped ? 'info' : 'warn', `[KeyGateway] ${result.message}`)
    results.push(result)
  }
  return results
}
