// IDE 主动续期（Proactive Token Renewal）
//
// 设计要点：
//  - 仅对「当前 IDE 激活账号」维护一个 timer（最多 1 个 in-flight timer，开销极小）
//  - 在 token 剩余 LEAD_MS（15 分钟）时抢先 refresh + 写盘，早于 Kiro IDE 自身的
//    ~10 分钟阈值，让 IDE 永远拿到剩余时间充足的 token，IDE 内部 refresh loop 不会
//    被触发，彻底消除 IDE 与账号管理器同时 refresh 撞车导致 refreshToken 作废的可能。
//  - schedule 之前总是 clear，确保 timer 不会泄漏（切号 / 关闭功能 / 登出都会 clear）
//  - 续期成功后基于新 token 的 expiresAt 自动调度下一次
//  - 续期若未能写入 IDE（账号已非当前激活账号）或失败，则停止调度，交给 IDE 自身兜底
import type { BrowserWindow } from 'electron'
import { refreshAccountToken } from './accountService'
import { getAccountData, getSettings, setAccountData } from './store'
import { sendToRenderer } from './utils'

/** token 剩余多久时触发续期，15 分钟 > Kiro IDE 的 ~10 分钟阈值，确保抢先 */
const LEAD_MS = 15 * 60 * 1000

let timer: NodeJS.Timeout | null = null
let getWindow: () => BrowserWindow | null = () => null

export function initProactiveRenewal(windowGetter: () => BrowserWindow | null): void {
  getWindow = windowGetter
}

export function clearProactiveRenewal(reason?: string): void {
  if (timer) {
    clearTimeout(timer)
    timer = null
    if (reason) console.log(`[ProactiveRenewal] Timer cleared: ${reason}`)
  }
}

/**
 * 在 token 剩余 LEAD_MS 时触发续期。
 * 调用方需传入准确的 expiresAtMs（来自 OIDC 真实 expiresIn 或账号 credentials.expiresAt）。
 */
export function scheduleProactiveRenewal(accountId: string, expiresAtMs: number): void {
  clearProactiveRenewal()
  if (!getSettings().proactiveRenewalEnabled) return
  if (!accountId || !expiresAtMs) return

  // 已进入续期窗口（含已过期）时立刻续期
  const delay = Math.max(expiresAtMs - Date.now() - LEAD_MS, 0)
  console.log(
    `[ProactiveRenewal] Scheduled in ${Math.round(delay / 1000)}s for account ${accountId} ` +
      `(token expiresAt ${new Date(expiresAtMs).toISOString()})`
  )
  timer = setTimeout(() => {
    timer = null
    void runProactiveRenewal(accountId)
  }, delay)
}

/** 启动时或开启功能时，按当前激活账号自动调度 */
export function scheduleForActiveAccount(): void {
  clearProactiveRenewal()
  if (!getSettings().proactiveRenewalEnabled) return
  const data = getAccountData()
  const activeId = data.activeAccountId
  if (!activeId) {
    console.log('[ProactiveRenewal] No active account recorded, will schedule after next switch')
    return
  }
  const account = data.accounts.find((a) => a.id === activeId)
  const expiresAt = account?.credentials.expiresAt
  if (typeof expiresAt === 'number' && expiresAt > 0) {
    scheduleProactiveRenewal(activeId, expiresAt)
  } else {
    console.log('[ProactiveRenewal] Active account has no valid expiresAt, skip until next refresh')
  }
}

async function runProactiveRenewal(accountId: string): Promise<void> {
  if (!getSettings().proactiveRenewalEnabled) return

  const data = getAccountData()
  const index = data.accounts.findIndex((a) => a.id === accountId)
  if (index === -1) {
    console.log(`[ProactiveRenewal] Account ${accountId} no longer exists, stop`)
    return
  }
  const account = data.accounts[index]
  if (!account.credentials.refreshToken) {
    console.log(`[ProactiveRenewal] Account ${accountId} has no refreshToken, stop`)
    return
  }

  console.log(`[ProactiveRenewal] Renewing token for IDE active account ${account.email || accountId}...`)

  let result
  try {
    result = await refreshAccountToken(account)
  } catch (e) {
    console.warn('[ProactiveRenewal] refresh threw, stop scheduling; IDE will fall back:', e)
    return
  }

  // 未能写入 IDE：说明该账号已不是 IDE 当前激活账号，停止续期，交给 IDE 自身兜底
  if (!result.syncedToIde) {
    console.log(
      `[ProactiveRenewal] Skipped disk sync (${result.syncSkipReason || 'not active'}), stop scheduling`
    )
    return
  }

  const newExpiresAt = Date.now() + result.expiresIn * 1000

  // 更新持久化的账号凭证，保证 store 与 IDE 磁盘一致
  data.accounts[index] = {
    ...account,
    credentials: {
      ...account.credentials,
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
      expiresAt: newExpiresAt
    },
    status: 'active',
    lastError: undefined
  }
  try {
    await setAccountData(data)
  } catch (e) {
    console.warn('[ProactiveRenewal] Failed to persist renewed credentials:', e)
  }

  // 通知渲染进程同步内存 store，UI 立即刷新
  sendToRenderer(getWindow(), 'proactive-renewal:done', {
    accountId,
    accessToken: result.accessToken,
    refreshToken: result.refreshToken,
    expiresIn: result.expiresIn
  })

  console.log(
    `[ProactiveRenewal] Renewed OK for ${account.email || accountId}, ` +
      `next in ${Math.round((result.expiresIn - LEAD_MS / 1000) / 60)}min`
  )

  // 调度下一次
  scheduleProactiveRenewal(accountId, newExpiresAt)
}
