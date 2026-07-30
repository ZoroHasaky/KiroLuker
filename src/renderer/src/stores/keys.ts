import { acceptHMRUpdate, defineStore } from 'pinia'
import { computed, ref } from 'vue'
import {
  DEFAULT_KEY_GATEWAY_DATA,
  type KeyGatewayConflict,
  type KeyGatewayData,
  type KeyGatewayStatus,
  type KeyModelInfo,
  type KeyTestResult
} from '@shared/types'
import { useSettingsStore } from '@/stores/settings'

export const useKeysStore = defineStore('keys', () => {
  const settingsStore = useSettingsStore()
  const data = ref<KeyGatewayData>({
    ...DEFAULT_KEY_GATEWAY_DATA,
    keys: [],
    ports: { ...DEFAULT_KEY_GATEWAY_DATA.ports }
  })
  const status = ref<KeyGatewayStatus | null>(null)
  const loading = ref(false)
  const detecting = ref(false)
  const syncRunning = ref(false)
  const usageTask = ref({
    running: false,
    type: 'api-key-usage-refresh' as const,
    total: 0,
    done: 0
  })
  const nextUsageRefreshAt = ref<number | null>(null)

  const activeKey = computed(() =>
    data.value.enabled
      ? data.value.keys.find((entry) => entry.id === data.value.activeKeyId)
      : undefined
  )
  const effectiveKey = computed(() => {
    const current = status.value
    if (!current?.observedInCurrentSession || !current.lastForwardedKeyId) return undefined
    return data.value.keys.find((entry) => entry.id === current.lastForwardedKeyId)
  })
  const count = computed(() => data.value.keys.length)

  let statusRevision = 0

  function replace(next: KeyGatewayData): void {
    data.value = {
      ...next,
      activeKeyId: next.enabled ? (next.activeKeyId ?? null) : null,
      keys: [...next.keys],
      ports: { ...next.ports }
    }
  }

  function applyStatus(next: KeyGatewayStatus): void {
    statusRevision++
    status.value = next
    data.value.enabled = next.enabled
    data.value.activeKeyId = next.enabled ? next.activeKeyId : null
  }

  async function load(): Promise<void> {
    const revisionAtStart = statusRevision
    const [keysRes, statusRes] = await Promise.all([
      window.api.loadKeys(),
      window.api.getKeyGatewayStatus()
    ])
    if (keysRes.success && keysRes.data) replace(keysRes.data)
    // 加载期间若收到主进程推送，保留更新的推送状态，避免旧快照回写覆盖。
    if (statusRes.success && statusRes.data && statusRevision === revisionAtStart) {
      applyStatus(statusRes.data)
    } else if (status.value) {
      data.value.enabled = status.value.enabled
      data.value.activeKeyId = status.value.enabled ? status.value.activeKeyId : null
    }
  }

  async function add(key: string, note?: string): Promise<string | null> {
    const res = await window.api.addKey(key, note)
    if (!res.success || !res.data) return res.error || '添加失败'
    replace(res.data)
    return null
  }

  async function importText(text: string): Promise<{
    error?: string
    added?: number
    skipped?: number
    invalid?: number
  }> {
    const res = await window.api.importKeys(text)
    if (!res.success || !res.data) return { error: res.error || '导入失败' }
    replace(res.data.data)
    return res.data
  }

  async function update(id: string, note: string): Promise<string | null> {
    const res = await window.api.updateKey(id, note)
    if (!res.success || !res.data) return res.error || '保存失败'
    replace(res.data)
    return null
  }

  async function remove(id: string): Promise<string | null> {
    const res = await window.api.deleteKey(id)
    if (!res.success || !res.data) return res.error || '删除失败'
    replace(res.data)
    return null
  }

  async function select(id: string): Promise<string | null> {
    const res = await window.api.selectKey(id)
    if (!res.success || !res.data) return res.error || '切换失败'
    replace(res.data.data)
    applyStatus(res.data.status)
    return null
  }

  async function listModels(id: string): Promise<{ error?: string; data?: KeyModelInfo[] }> {
    const res = await window.api.listKeyModels(id)
    return res.success && res.data ? { data: res.data } : { error: res.error || '模型列表获取失败' }
  }

  async function test(id: string): Promise<{ error?: string; data?: KeyTestResult }> {
    const res = await window.api.testKey(id)
    return res.success && res.data ? { data: res.data } : { error: res.error || '测试失败' }
  }

  async function sync(id: string): Promise<string | null> {
    const res = await window.api.syncKey(id)
    if (!res.success || !res.data) {
      // 主进程失败时仍会保存 lastError；重新载入以保留旧额度并展示错误。
      const latest = await window.api.loadKeys()
      if (latest.success && latest.data) replace(latest.data)
      return res.error || '同步失败'
    }
    replace(res.data)
    return null
  }

  async function syncAll(
    showProgress = true
  ): Promise<{ error?: string; success?: number; failed?: number }> {
    if (syncRunning.value) return { error: 'API Key 用量正在同步，请稍候' }
    syncRunning.value = true
    const total = data.value.keys.length
    if (showProgress) usageTask.value = { running: true, type: 'api-key-usage-refresh', total, done: 0 }
    try {
      const res = await window.api.syncAllKeys(settingsStore.settings.apiKeyRefreshConcurrency)
      if (!res.success || !res.data) return { error: res.error || '批量同步失败' }
      replace(res.data.data)
      return { success: res.data.success, failed: res.data.failed }
    } finally {
      if (showProgress) {
        usageTask.value.done = total
        usageTask.value.running = false
      }
      syncRunning.value = false
    }
  }

  /** 手动批量刷新，逐个完成时更新页头进度。 */
  async function syncMany(
    ids: string[]
  ): Promise<{ error?: string; success?: number; failed?: number }> {
    if (syncRunning.value) return { error: 'API Key 用量正在同步，请稍候' }
    if (!ids.length) return { success: 0, failed: 0 }

    syncRunning.value = true
    usageTask.value = {
      running: true,
      type: 'api-key-usage-refresh',
      total: ids.length,
      done: 0
    }
    let success = 0
    let failed = 0
    try {
      const concurrency = Math.max(1, settingsStore.settings.apiKeyRefreshConcurrency)
      for (let i = 0; i < ids.length; i += concurrency) {
        await Promise.all(
          ids.slice(i, i + concurrency).map(async (id) => {
            try {
              const error = await sync(id)
              error ? failed++ : success++
            } catch {
              failed++
            } finally {
              usageTask.value.done++
            }
          })
        )
      }
      return { success, failed }
    } finally {
      usageTask.value.running = false
      syncRunning.value = false
    }
  }

  /** 查询 Kiro IDE 是否已被其它本地网关接管；无冲突返回 null。 */
  async function inspectConflict(): Promise<{
    error?: string
    conflict?: KeyGatewayConflict | null
  }> {
    const res = await window.api.inspectKeyGatewayConflict()
    if (!res.success) return { error: res.error || '接管状态检测失败' }
    return { conflict: res.data ?? null }
  }

  async function setEnabled(enabled: boolean, keyId?: string, force = false): Promise<string | null> {
    loading.value = true
    try {
      const res = enabled
        ? await window.api.enableKeyGateway(keyId, force)
        : await window.api.disableKeyGateway()
      if (!res.success || !res.data) return res.error || '操作失败'
      applyStatus(res.data)
      return null
    } finally {
      loading.value = false
    }
  }

  async function configure(region: string, krs: number, cps: number): Promise<string | null> {
    const res = await window.api.configureKeyGateway({ region, ports: { krs, cps } })
    if (!res.success || !res.data) return res.error || '保存配置失败'
    replace(res.data.data)
    applyStatus(res.data.status)
    return null
  }

  async function detectCurrentApiKey(): Promise<string | null> {
    detecting.value = true
    try {
      const res = await window.api.getKeyGatewayStatus()
      if (!res.success || !res.data) return res.error || '检测失败'
      applyStatus(res.data)
      return null
    } catch (error) {
      return error instanceof Error ? error.message : '检测失败'
    } finally {
      detecting.value = false
    }
  }

  // ============ API Key 用量自动刷新 ============
  const AUTO_TICK_MS = 1_000
  const LAST_RUN_STORAGE = 'kal:auto-api-key-usage-refresh-at'
  let tickTimer: ReturnType<typeof setInterval> | null = null
  let autoRunning = false
  let appliedInterval = 0

  function intervalMs(): number {
    return Math.max(1, settingsStore.settings.apiKeyUsageRefreshInterval) * 60_000
  }

  function readLastRun(): number {
    const value = Number(localStorage.getItem(LAST_RUN_STORAGE))
    return Number.isFinite(value) && value > 0 ? value : 0
  }

  function markRan(): void {
    try {
      localStorage.setItem(LAST_RUN_STORAGE, String(Date.now()))
    } catch {
      // localStorage 不可写时退化为每次启动补跑一轮
    }
  }

  async function autoTick(): Promise<void> {
    if (
      autoRunning ||
      syncRunning.value ||
      nextUsageRefreshAt.value === null ||
      Date.now() < nextUsageRefreshAt.value
    ) return
    autoRunning = true
    const next = Date.now() + intervalMs()
    nextUsageRefreshAt.value = next
    try {
      if (data.value.keys.length) {
        const result = await syncAll()
        if (result.error) console.warn(`[ApiKeyAutoRefresh] ${result.error}`)
        else console.info(`[ApiKeyAutoRefresh] 完成：成功 ${result.success}，失败 ${result.failed}`)
      }
      markRan()
      if (Date.now() >= next) nextUsageRefreshAt.value = Date.now() + intervalMs()
    } catch (error) {
      console.error('[ApiKeyAutoRefresh] 本轮刷新异常：', error)
    } finally {
      autoRunning = false
    }
  }

  function ensureTick(): void {
    if (!tickTimer) tickTimer = setInterval(() => void autoTick(), AUTO_TICK_MS)
  }

  function startAutoRefresh(): void {
    const enabled = settingsStore.settings.autoRefreshApiKeyUsage
    const interval = settingsStore.settings.apiKeyUsageRefreshInterval
    if (!enabled) {
      nextUsageRefreshAt.value = null
      if (tickTimer) clearInterval(tickTimer)
      tickTimer = null
      return
    }
    if (nextUsageRefreshAt.value === null || appliedInterval !== interval) {
      appliedInterval = interval
      const due = readLastRun() + intervalMs()
      nextUsageRefreshAt.value = due <= Date.now() ? Date.now() : due
    }
    ensureTick()
  }

  /** 手工全量同步后从现在重新计算下一轮，避免马上重复请求。 */
  function scheduleUsageRefresh(): void {
    appliedInterval = settingsStore.settings.apiKeyUsageRefreshInterval
    if (!settingsStore.settings.autoRefreshApiKeyUsage) {
      nextUsageRefreshAt.value = null
      return
    }
    markRan()
    nextUsageRefreshAt.value = Date.now() + intervalMs()
    ensureTick()
  }

  function stopAutoRefresh(): void {
    if (tickTimer) clearInterval(tickTimer)
    tickTimer = null
    nextUsageRefreshAt.value = null
  }

  return {
    data,
    status,
    loading,
    detecting,
    syncRunning,
    usageTask,
    nextUsageRefreshAt,
    activeKey,
    effectiveKey,
    count,
    load,
    add,
    importText,
    update,
    remove,
    select,
    listModels,
    test,
    sync,
    syncAll,
    syncMany,
    startAutoRefresh,
    scheduleUsageRefresh,
    stopAutoRefresh,
    setEnabled,
    inspectConflict,
    configure,
    detectCurrentApiKey,
    applyStatus
  }
})

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useKeysStore, import.meta.hot))
}
