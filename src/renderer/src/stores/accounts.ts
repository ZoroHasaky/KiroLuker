import { acceptHMRUpdate, defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { message } from 'ant-design-vue'
import { v4 as uuidv4 } from 'uuid'
import {
  DEFAULT_SETTINGS,
  type Account,
  type AccountExportData,
  type AccountImportItem,
  type AccountSnapshot,
  type AccountStatus,
  type AccountStoreData,
  type BatchResult,
  type IdpType,
  type OnlineLoginCredentials,
  type SubscriptionType,
  type SwitchAccountResult,
  type VerifyCredentialsInput
} from '@shared/types'
import { errorMessage } from '@shared/errors'
import { DEFAULT_REGION } from '@shared/regions'
import { runPool } from '@/utils/format'
import { toPlain } from '@/utils/ipc'
import { isSocialIdp, normalizeIdp } from '@/utils/transfer'
import { useSettingsStore } from './settings'

export interface AccountFilter {
  search: string
  statuses: AccountStatus[]
  subscriptions: SubscriptionType[]
  idps: IdpType[]
  /** 订阅剩余天数下限（含） */
  daysRemainingMin?: number
  /** 订阅剩余天数上限（含），用于「即将到期」快捷筛选 */
  daysRemainingMax?: number
  /** 用量占比下限（0-1），用于「额度告急」快捷筛选 */
  usageMin?: number
  /** 用量占比上限（0-1） */
  usageMax?: number
}

/** 批量任务的进度状态，全局单例，同一时间只跑一件事 */
interface TaskState {
  running: boolean
  label: string
  total: number
  done: number
}

function authMethodOf(idp: IdpType): 'IdC' | 'social' {
  return isSocialIdp(idp) ? 'social' : 'IdC'
}

function emptyUsage(): Account['usage'] {
  return { current: 0, limit: 0, percentUsed: 0, lastUpdated: 0 }
}

/** 统计里「即将重置」的天数阈值 */
const EXPIRING_SOON_DAYS = 7
/** 自动刷新密钥只处理这个时间窗内即将过期的账号 */
const AUTO_REFRESH_WINDOW_MS = 30 * 60_000
/** 接口没给 expiresIn 时的兜底有效期（秒） */
const DEFAULT_EXPIRES_IN = 3600

export const useAccountsStore = defineStore('accounts', () => {
  const settingsStore = useSettingsStore()

  const accounts = ref<Account[]>([])
  const activeAccountId = ref<string | null>(null)
  const selectedIds = ref<string[]>([])
  const loading = ref(false)
  const task = ref<TaskState>({ running: false, label: '', total: 0, done: 0 })
  const filter = ref<AccountFilter>({ search: '', statuses: [], subscriptions: [], idps: [] })

  // ============ 持久化 ============

  let saveTimer: ReturnType<typeof setTimeout> | null = null

  function snapshotForStore(): AccountStoreData {
    return {
      version: 1,
      accounts: accounts.value,
      activeAccountId: activeAccountId.value
    }
  }

  function persist(immediate = false): void {
    if (saveTimer) clearTimeout(saveTimer)
    const write = (): void => {
      saveTimer = null
      void window.api.saveAccounts(toPlain(snapshotForStore()))
    }
    if (immediate) write()
    else saveTimer = setTimeout(write, 600)
  }

  async function load(): Promise<void> {
    loading.value = true
    try {
      const res = await window.api.loadAccounts()
      if (res.success && res.data) {
        accounts.value = res.data.accounts ?? []
        activeAccountId.value = res.data.activeAccountId ?? null
      }
      await syncActiveFromIde()
    } finally {
      loading.value = false
    }
  }

  // ============ 查询 ============

  const byId = computed(() => new Map(accounts.value.map((a) => [a.id, a])))

  function get(id: string): Account | undefined {
    return byId.value.get(id)
  }

  const activeAccount = computed(() => accounts.value.find((a) => a.isActive) ?? null)

  const filtered = computed(() => {
    const {
      search,
      statuses,
      subscriptions,
      idps,
      daysRemainingMin,
      daysRemainingMax,
      usageMin,
      usageMax
    } = filter.value
    const keyword = search.trim().toLowerCase()
    return accounts.value.filter((a) => {
      if (keyword) {
        const haystack = `${a.email} ${a.nickname ?? ''} ${a.note ?? ''}`.toLowerCase()
        if (!haystack.includes(keyword)) return false
      }
      if (statuses.length && !statuses.includes(a.status)) return false
      if (subscriptions.length && !subscriptions.includes(a.subscription.type)) return false
      if (idps.length && !idps.includes(a.idp)) return false
      const days = a.subscription.daysRemaining
      if (daysRemainingMax !== undefined && (days ?? Number.POSITIVE_INFINITY) > daysRemainingMax) {
        return false
      }
      if (daysRemainingMin !== undefined && (days ?? Number.NEGATIVE_INFINITY) < daysRemainingMin) {
        return false
      }
      const used = a.usage.percentUsed || 0
      if (usageMin !== undefined && used < usageMin) return false
      if (usageMax !== undefined && used > usageMax) return false
      return true
    })
  })

  /** 覆盖式设置筛选条件（首页告警跳转用） */
  function applyFilter(patch: Partial<AccountFilter>): void {
    filter.value = {
      search: '',
      statuses: [],
      subscriptions: [],
      idps: [],
      daysRemainingMin: undefined,
      daysRemainingMax: undefined,
      usageMin: undefined,
      usageMax: undefined,
      ...patch
    }
  }

  /** 一次遍历产出各维度计数，界面统计与筛选面板共用 */
  const stats = computed(() => {
    const byStatus: Record<AccountStatus, number> = {
      active: 0,
      expired: 0,
      error: 0,
      banned: 0,
      unknown: 0
    }
    const bySubscription: Record<SubscriptionType, number> = {
      Free: 0,
      Pro: 0,
      Pro_Plus: 0,
      Enterprise: 0,
      Teams: 0
    }
    const byIdp: Record<IdpType, number> = { BuilderId: 0, Github: 0, Google: 0, Enterprise: 0 }
    let expiringSoon = 0

    for (const a of accounts.value) {
      // ?? 0 兜底磁盘上可能存在的旧枚举值，避免出现 NaN
      byStatus[a.status] = (byStatus[a.status] ?? 0) + 1
      bySubscription[a.subscription.type] = (bySubscription[a.subscription.type] ?? 0) + 1
      byIdp[a.idp] = (byIdp[a.idp] ?? 0) + 1
      if ((a.subscription.daysRemaining ?? 99) <= EXPIRING_SOON_DAYS) expiringSoon++
    }

    return { total: accounts.value.length, byStatus, bySubscription, byIdp, expiringSoon }
  })

  // ============ 增删改 ============

  function exists(email?: string, userId?: string, idp?: IdpType): boolean {
    return accounts.value.some((a) => {
      if (userId && a.userId && a.userId === userId) return true
      if (email && a.email === email && a.idp === idp) return true
      return false
    })
  }

  /** 用校验结果拼出完整账号对象 */
  type BuildInput = VerifyCredentialsInput & {
    password?: string
    nickname?: string
    note?: string
    startUrl?: string
    profileArn?: string
  }

  function buildAccount(snapshot: AccountSnapshot, input: BuildInput): Account {
    const now = Date.now()
    const idp = (input.provider || 'BuilderId') as IdpType
    const profileArn = snapshot.profileArn || input.profileArn
    return {
      id: uuidv4(),
      email: snapshot.email,
      password: input.password,
      nickname: input.nickname,
      note: input.note,
      idp,
      userId: snapshot.userId,
      profileArn,
      credentials: {
        accessToken: snapshot.accessToken || '',
        refreshToken: snapshot.refreshToken || input.refreshToken,
        clientId: input.clientId,
        clientSecret: input.clientSecret,
        region: input.region || DEFAULT_REGION,
        startUrl: input.startUrl,
        expiresAt: now + (snapshot.expiresIn ?? DEFAULT_EXPIRES_IN) * 1000,
        authMethod: authMethodOf(idp),
        provider: idp,
        profileArn
      },
      subscription: snapshot.subscription,
      usage: snapshot.usage,
      status: 'active',
      isActive: false,
      createdAt: now,
      lastUsedAt: now,
      lastCheckedAt: now
    }
  }

  /** 校验凭证并添加单个账号 */
  async function addByCredentials(
    input: BuildInput
  ): Promise<{ ok: boolean; error?: string; account?: Account }> {
    const res = await window.api.verifyCredentials(input)
    if (!res.success || !res.data) return { ok: false, error: res.error || '校验失败' }

    const idp = (input.provider || 'BuilderId') as IdpType
    if (exists(res.data.email, res.data.userId, idp)) {
      return { ok: false, error: `${res.data.email} 已存在` }
    }

    const account = buildAccount(res.data, input)
    accounts.value = [...accounts.value, account]
    // 入库时记一条基线，之后的变化才有对比对象
    void window.api.recordUsagePoint(account.id, toPlain(account.usage))
    persist()
    return { ok: true, account }
  }

  /** 在线登录成功后拉取账号信息并入库 */
  async function addByOnlineLogin(
    credentials: OnlineLoginCredentials,
    extra?: { nickname?: string; note?: string }
  ): Promise<{ ok: boolean; error?: string; account?: Account }> {
    return addByCredentials({
      refreshToken: credentials.refreshToken,
      clientId: credentials.clientId,
      clientSecret: credentials.clientSecret,
      region: credentials.region,
      authMethod: credentials.authMethod,
      provider: credentials.provider,
      startUrl: credentials.startUrl,
      profileArn: credentials.profileArn,
      nickname: extra?.nickname
    })
  }

  function updateAccount(id: string, patch: Partial<Account>): void {
    const index = accounts.value.findIndex((a) => a.id === id)
    if (index === -1) return
    // 整体换引用触发一次更新即可，避免先改元素再换数组产生两次写入
    const next = accounts.value.slice()
    next[index] = { ...next[index], ...patch }
    accounts.value = next
    persist()
  }

  function removeAccounts(ids: string[]): number {
    const set = new Set(ids)
    const before = accounts.value.length
    accounts.value = accounts.value.filter((a) => !set.has(a.id))
    selectedIds.value = selectedIds.value.filter((id) => !set.has(id))
    if (activeAccountId.value && set.has(activeAccountId.value)) activeAccountId.value = null
    persist(true)
    return before - accounts.value.length
  }

  // ============ 批量导入 ============

  async function importItems(items: AccountImportItem[]): Promise<BatchResult> {
    const result: BatchResult = { success: 0, failed: 0, skipped: 0, messages: [] }
    const valid = items.filter((i) => i.refreshToken)
    if (valid.length === 0) {
      result.messages.push('没有解析到有效的 refreshToken')
      return result
    }

    task.value = { running: true, label: '批量导入校验中', total: valid.length, done: 0 }
    const created: Account[] = []
    // 本批已入队的 email|idp，用 Set 查重避免逐个线性扫描（几千条时是 O(n²)）
    const createdKeys = new Set<string>()
    // 导入并发独立于批量刷新的并发，单独设置更好控速；上下限由 runPool 兜底
    const limit = settingsStore.settings.importConcurrency || DEFAULT_SETTINGS.importConcurrency

    try {
      await runPool(valid, limit, async (item, index) => {
        const idp = normalizeIdp(item.provider)
        try {
          const res = await window.api.verifyCredentials({
            refreshToken: item.refreshToken,
            clientId: item.clientId,
            clientSecret: item.clientSecret,
            region: item.region || DEFAULT_REGION,
            authMethod: authMethodOf(idp),
            provider: idp
          })
          if (!res.success || !res.data) {
            result.failed++
            result.messages.push(`#${index + 1} ${item.email || ''} 校验失败：${res.error}`)
            return
          }
          const email = res.data.email || item.email || ''
          const key = `${email}|${idp}`
          if (exists(email, res.data.userId, idp) || createdKeys.has(key)) {
            result.skipped++
            result.messages.push(`#${index + 1} ${email} 已存在，跳过`)
            return
          }
          createdKeys.add(key)
          created.push(
            buildAccount(
              { ...res.data, email },
              {
                refreshToken: item.refreshToken,
                clientId: item.clientId,
                clientSecret: item.clientSecret,
                region: item.region,
                provider: idp,
                password: item.password,
                nickname: item.nickname
              }
            )
          )
          result.success++
        } catch (e) {
          result.failed++
          result.messages.push(`#${index + 1} 异常：${errorMessage(e)}`)
        } finally {
          task.value.done++
        }
      })
    } finally {
      if (created.length) {
        accounts.value = [...accounts.value, ...created]
        for (const account of created) {
          void window.api.recordUsagePoint(account.id, toPlain(account.usage))
        }
        persist(true)
      }
      // 同上：running 一定要复位，否则会把后续的自动刷新全部挡掉
      task.value.running = false
    }
    return result
  }

  /** 恢复完整导出文件（保留用量、订阅等快照） */
  function importFullData(data: AccountExportData): BatchResult {
    const result: BatchResult = { success: 0, failed: 0, skipped: 0, messages: [] }
    const created: Account[] = []
    // 与 importItems 一致，用 Set 查重避免逐条线性扫描
    const createdKeys = new Set<string>()

    for (const raw of data.accounts ?? []) {
      if (!raw?.credentials?.refreshToken) {
        result.failed++
        continue
      }
      const idp = normalizeIdp(raw.idp)
      const key = `${raw.email}|${idp}`
      if (exists(raw.email, raw.userId, idp) || createdKeys.has(key)) {
        result.skipped++
        continue
      }
      createdKeys.add(key)
      created.push({
        ...raw,
        id: raw.id || uuidv4(),
        idp,
        isActive: false,
        usage: raw.usage ?? emptyUsage(),
        subscription: raw.subscription ?? { type: 'Free' },
        status: raw.status ?? 'unknown',
        createdAt: raw.createdAt ?? Date.now(),
        lastUsedAt: raw.lastUsedAt ?? Date.now()
      })
      result.success++
    }

    if (created.length) {
      accounts.value = [...accounts.value, ...created]
      persist(true)
    }
    if (result.skipped) result.messages.push(`跳过 ${result.skipped} 个已存在的账号`)
    return result
  }

  // ============ 刷新 Token ============

  function applySnapshot(id: string, snapshot: AccountSnapshot): void {
    const account = get(id)
    if (!account) return
    // 积分变化日志由主进程去重：没变化的刷新不会落记录
    void window.api.recordUsagePoint(id, toPlain(snapshot.usage))
    updateAccount(id, {
      email: snapshot.email || account.email,
      userId: snapshot.userId ?? account.userId,
      subscription: snapshot.subscription,
      usage: snapshot.usage,
      status: 'active',
      lastError: undefined,
      lastCheckedAt: Date.now(),
      credentials: snapshot.accessToken
        ? {
            ...account.credentials,
            accessToken: snapshot.accessToken,
            refreshToken: snapshot.refreshToken || account.credentials.refreshToken,
            expiresAt: Date.now() + (snapshot.expiresIn ?? DEFAULT_EXPIRES_IN) * 1000
          }
        : account.credentials
    })
  }

  async function refreshToken(id: string): Promise<{ ok: boolean; error?: string; syncedToIde?: boolean }> {
    const account = get(id)
    if (!account) return { ok: false, error: '账号不存在' }

    const res = await window.api.refreshAccountToken(toPlain(account))
    if (!res.success || !res.data) {
      updateAccount(id, { status: 'error', lastError: res.error, lastCheckedAt: Date.now() })
      return { ok: false, error: res.error }
    }

    updateAccount(id, {
      credentials: {
        ...account.credentials,
        accessToken: res.data.accessToken,
        refreshToken: res.data.refreshToken,
        expiresAt: Date.now() + res.data.expiresIn * 1000
      },
      status: 'active',
      lastError: undefined
    })
    return { ok: true, syncedToIde: res.data.syncedToIde }
  }

  async function checkStatus(id: string): Promise<{ ok: boolean; error?: string }> {
    const account = get(id)
    if (!account) return { ok: false, error: '账号不存在' }

    const res = await window.api.checkAccountStatus(toPlain(account))
    if (!res.success || !res.data) {
      updateAccount(id, {
        status: res.banned ? 'banned' : 'error',
        lastError: res.error,
        lastCheckedAt: Date.now()
      })
      return { ok: false, error: res.error }
    }
    applySnapshot(id, res.data)
    return { ok: true }
  }

  /**
   * 批量刷新密钥或用量。ids 决定入队顺序（并发执行，完成顺序不保证），
   * 调用方按界面排序传入即可让靠前的账号先开始。
   * onProgress 用于实时反馈进度，不传则静默执行。
   */
  async function runBatch(
    ids: string[],
    kind: 'refresh' | 'check',
    onProgress?: (done: number, total: number) => void
  ): Promise<BatchResult> {
    const result: BatchResult = { success: 0, failed: 0, skipped: 0, messages: [] }
    if (ids.length === 0) return result

    task.value = {
      running: true,
      label: kind === 'refresh' ? '批量刷新密钥' : '批量刷新用量',
      total: ids.length,
      done: 0
    }

    // running 必须在 finally 里复位：池子里任何一个任务抛异常都会让整个 runPool reject，
    // 一旦这里漏掉复位，task.running 会永久为 true，之后所有自动刷新都会被静默跳过
    try {
      await runPool(ids, settingsStore.settings.concurrency, async (id) => {
        const res = kind === 'refresh' ? await refreshToken(id) : await checkStatus(id)
        if (res.ok) result.success++
        else {
          result.failed++
          result.messages.push(`${get(id)?.email ?? id}：${res.error}`)
        }
        task.value.done++
        onProgress?.(task.value.done, ids.length)
      })
    } finally {
      task.value.running = false
      persist(true)
    }
    return result
  }

  // ============ 切号 / IDE 同步 ============

  async function switchTo(
    id: string
  ): Promise<{ ok: boolean; error?: string; result?: SwitchAccountResult }> {
    const account = get(id)
    if (!account) return { ok: false, error: '账号不存在' }

    const res = await window.api.switchAccount({
      accountId: id,
      accessToken: account.credentials.accessToken,
      refreshToken: account.credentials.refreshToken,
      clientId: account.credentials.clientId,
      clientSecret: account.credentials.clientSecret,
      region: account.credentials.region,
      startUrl: account.credentials.startUrl,
      authMethod: authMethodOf(account.idp),
      provider: account.idp,
      profileArn: account.profileArn || account.credentials.profileArn
    })
    if (!res.success || !res.data) return { ok: false, error: res.error }

    const result = res.data
    accounts.value = accounts.value.map((a) =>
      a.id === id
        ? {
            ...a,
            isActive: true,
            lastUsedAt: Date.now(),
            status: 'active',
            lastError: undefined,
            // 记住主进程实测可用的 profileArn，下次切号少试一轮
            profileArn: result.profileArn || a.profileArn,
            credentials: {
              ...a.credentials,
              accessToken: result.accessToken,
              refreshToken: result.refreshToken,
              expiresAt: Date.now() + result.expiresIn * 1000
            }
          }
        : { ...a, isActive: false }
    )
    activeAccountId.value = id
    persist(true)
    return { ok: true, result }
  }

  async function restartKiroIde(): Promise<{ ok: boolean; message: string }> {
    const res = await window.api.restartKiroIde()
    if (!res.success || !res.data) {
      return { ok: false, message: res.error || '重启 Kiro IDE 失败' }
    }
    return { ok: res.data.started, message: res.data.message }
  }

  /** 读本地 kiro-auth-token.json，按 refreshToken 反向匹配当前激活账号 */
  async function syncActiveFromIde(): Promise<void> {
    const res = await window.api.getActiveKiroToken()
    const diskRefresh = res.success ? res.data?.refreshToken : undefined
    let matchedId: string | null = null
    if (diskRefresh) {
      matchedId = accounts.value.find((a) => a.credentials.refreshToken === diskRefresh)?.id ?? null
    }
    const changed = accounts.value.some((a) => a.isActive !== (a.id === matchedId))
    if (!changed) {
      activeAccountId.value = matchedId
      return
    }
    accounts.value = accounts.value.map((a) => ({ ...a, isActive: a.id === matchedId }))
    activeAccountId.value = matchedId
    persist()
  }

  async function logoutIde(): Promise<{ ok: boolean; deleted?: number; error?: string }> {
    const res = await window.api.logoutKiro()
    if (!res.success) return { ok: false, error: res.error }
    accounts.value = accounts.value.map((a) => ({ ...a, isActive: false }))
    activeAccountId.value = null
    persist(true)
    return { ok: true, deleted: res.data?.deleted }
  }

  // ============ 自动刷新调度 ============

  // 调度方式：只记「下一轮的绝对到期时间」，再用一个秒级 tick 检查是否越过。
  //
  // 之前是给每条任务开一个 setInterval(间隔分钟数)，实测不按时执行，原因有两个：
  // 1) 窗口最小化到托盘后页面转入后台，Chromium 会节流甚至冻结长间隔定时器，
  //    回调迟迟不来，界面上的倒计时也就一直停在 0 秒；
  // 2) 系统睡眠、进程被挂起期间错过的轮次，setInterval 不会补跑，直接丢掉。
  // 换成到期时间 + 秒级 tick 后，无论被节流或挂起多久，恢复后的第一个 tick 就会补上。
  const AUTO_TICK_MS = 1_000

  let tickTimer: ReturnType<typeof setInterval> | null = null
  /** 自动任务自己的串行锁，两轮同时到期时排队跑，不再互相丢轮 */
  let autoRunning = false

  /** 下一轮密钥 / 用量刷新的时间戳，未启用时为 null，供界面展示 */
  const nextKeyRefreshAt = ref<number | null>(null)
  const nextUsageRefreshAt = ref<number | null>(null)

  // 已生效的间隔（分钟）。设置对象是整体替换的，换主题、折叠侧边栏这类无关改动
  // 也会触发外部的 watch，靠这两个值判断间隔是否真的变了，避免倒计时被无故清零
  let appliedKeyInterval = 0
  let appliedUsageInterval = 0

  const keyIntervalMs = (): number => Math.max(1, settingsStore.settings.keyRefreshInterval) * 60_000
  const usageIntervalMs = (): number =>
    Math.max(1, settingsStore.settings.usageRefreshInterval) * 60_000

  /** 只处理即将过期的账号，避免无谓地轮换 refreshToken */
  async function refreshExpiringKeys(): Promise<void> {
    const soon = accounts.value
      .filter(
        (a) => a.status !== 'banned' && a.credentials.expiresAt - Date.now() < AUTO_REFRESH_WINDOW_MS
      )
      .map((a) => a.id)
    if (!soon.length) {
      console.info('[AutoRefresh] 本轮没有即将过期的账号，跳过密钥刷新')
      return
    }
    const res = await runBatch(soon, 'refresh')
    if (res.success) message.success(`自动刷新密钥完成：成功 ${res.success}，失败 ${res.failed}`)
  }

  /** 覆盖全部非封禁账号，成功时保持静默，避免定时弹通知打扰 */
  async function refreshAllUsage(): Promise<void> {
    const ids = accounts.value.filter((a) => a.status !== 'banned').map((a) => a.id)
    if (!ids.length) return
    const res = await runBatch(ids, 'check')
    if (res.failed) console.warn('[AutoRefresh] 用量刷新部分失败：', res.messages)
  }

  /** 每秒检查两条任务是否到期；到期就跑，跑完从当前时间重新计时 */
  async function autoTick(): Promise<void> {
    if (autoRunning) return
    const at = Date.now()
    const keyDue = nextKeyRefreshAt.value !== null && at >= nextKeyRefreshAt.value
    const usageDue = nextUsageRefreshAt.value !== null && at >= nextUsageRefreshAt.value
    if (!keyDue && !usageDue) return
    // 手动批量操作正占用着全局任务状态：本轮不丢，等它结束后的下一个 tick 立刻补跑
    if (task.value.running) return

    autoRunning = true
    try {
      // 到期时间先往后推一轮再执行：中途异常也不会卡在「一直到期」的状态里反复重试
      if (keyDue) {
        nextKeyRefreshAt.value = at + keyIntervalMs()
        await refreshExpiringKeys()
        nextKeyRefreshAt.value = Date.now() + keyIntervalMs()
      }
      if (usageDue) {
        nextUsageRefreshAt.value = Date.now() + usageIntervalMs()
        await refreshAllUsage()
        nextUsageRefreshAt.value = Date.now() + usageIntervalMs()
      }
    } catch (e) {
      console.error('[AutoRefresh] 本轮自动刷新异常：', e)
    } finally {
      autoRunning = false
    }
  }

  function ensureTick(): void {
    if (tickTimer) return
    tickTimer = setInterval(() => void autoTick(), AUTO_TICK_MS)
  }

  function stopTick(): void {
    if (tickTimer) clearInterval(tickTimer)
    tickTimer = null
  }

  /**
   * 密钥刷新整轮从现在开始重新计时。
   * 手动全量刷新完也调它，避免刚刷完又马上被自动任务刷一次。
   */
  function scheduleKeyRefresh(): void {
    appliedKeyInterval = settingsStore.settings.keyRefreshInterval
    if (!settingsStore.settings.autoRefresh) {
      nextKeyRefreshAt.value = null
      return
    }
    nextKeyRefreshAt.value = Date.now() + keyIntervalMs()
    ensureTick()
  }

  /** 用量刷新整轮重新计时，同上 */
  function scheduleUsageRefresh(): void {
    appliedUsageInterval = settingsStore.settings.usageRefreshInterval
    if (!settingsStore.settings.autoRefreshUsage) {
      nextUsageRefreshAt.value = null
      return
    }
    nextUsageRefreshAt.value = Date.now() + usageIntervalMs()
    ensureTick()
  }

  /**
   * 按当前设置对齐两条任务：开关刚打开或间隔真的改了才重新计时，
   * 其余设置改动（主题、侧边栏、隐私模式……）不影响已经在跑的倒计时。
   */
  function startAutoRefresh(): void {
    const { autoRefresh, autoRefreshUsage, keyRefreshInterval, usageRefreshInterval } =
      settingsStore.settings
    if (!autoRefresh) nextKeyRefreshAt.value = null
    else if (nextKeyRefreshAt.value === null || appliedKeyInterval !== keyRefreshInterval) {
      scheduleKeyRefresh()
    }
    if (!autoRefreshUsage) nextUsageRefreshAt.value = null
    else if (nextUsageRefreshAt.value === null || appliedUsageInterval !== usageRefreshInterval) {
      scheduleUsageRefresh()
    }

    if (nextKeyRefreshAt.value === null && nextUsageRefreshAt.value === null) stopTick()
    else ensureTick()
  }

  function stopAutoRefresh(): void {
    stopTick()
    nextKeyRefreshAt.value = null
    nextUsageRefreshAt.value = null
  }

  return {
    // 状态
    accounts,
    activeAccount,
    selectedIds,
    loading,
    task,
    filter,
    // 查询
    filtered,
    stats,
    get,
    applyFilter,
    // 增删改
    load,
    addByCredentials,
    addByOnlineLogin,
    updateAccount,
    removeAccounts,
    importItems,
    importFullData,
    // 刷新 / 切号
    refreshToken,
    checkStatus,
    runBatch,
    switchTo,
    restartKiroIde,
    syncActiveFromIde,
    logoutIde,
    nextKeyRefreshAt,
    nextUsageRefreshAt,
    scheduleKeyRefresh,
    scheduleUsageRefresh,
    startAutoRefresh,
    stopAutoRefresh
  }
})

// setup 风格的 store 默认不参与 HMR，改完 store 后运行中的实例会缺少新增方法
if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useAccountsStore, import.meta.hot))
}
