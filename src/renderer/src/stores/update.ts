import { acceptHMRUpdate, defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type { AppUpdateState, UpdateCheckResult } from '@shared/types'

const CACHE_KEY = 'kal:update-check:v1'
const CACHE_TTL_MS = 6 * 60 * 60 * 1000

interface UpdateCache {
  checkedAt: number
  result: UpdateCheckResult
}

function validResult(value: unknown): value is UpdateCheckResult {
  if (!value || typeof value !== 'object') return false
  const item = value as Record<string, unknown>
  return (
    typeof item.current === 'string'
    && typeof item.latest === 'string'
    && typeof item.hasUpdate === 'boolean'
    && typeof item.releaseUrl === 'string'
    && typeof item.name === 'string'
    && typeof item.notes === 'string'
    && typeof item.publishedAt === 'string'
  )
}

function readCache(currentVersion: string): UpdateCache | null {
  try {
    const parsed = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null') as Partial<UpdateCache> | null
    if (!parsed || typeof parsed.checkedAt !== 'number' || !validResult(parsed.result)) return null
    if (parsed.result.current !== currentVersion) return null
    return { checkedAt: parsed.checkedAt, result: parsed.result }
  } catch {
    return null
  }
}

function writeCache(result: UpdateCheckResult): void {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ checkedAt: Date.now(), result }))
  } catch {
    // localStorage 不可写时仍保留本次会话内的检查结果。
  }
}


export const useUpdateStore = defineStore('update', () => {
  const result = ref<UpdateCheckResult | null>(null)
  const checking = ref(false)
  const modalOpen = ref(false)
  const initialized = ref(false)
  const transfer = ref<AppUpdateState>({
    mode: 'manual',
    status: 'idle',
    current: '',
    latest: '',
    percent: 0,
    transferred: 0,
    total: 0,
    bytesPerSecond: 0,
    message: ''
  })
  const actionError = ref('')
  let request: Promise<{ data?: UpdateCheckResult; error?: string }> | null = null
  let offState: (() => void) | null = null

  const hasUpdate = computed(() => result.value?.hasUpdate === true)
  const latestVersion = computed(() => result.value?.latest ?? '')

  function applyTransferState(state: AppUpdateState): void {
    transfer.value = state
    if (state.status !== 'error') actionError.value = ''
  }

  async function fetchLatest(): Promise<{ data?: UpdateCheckResult; error?: string }> {
    if (request) return request
    checking.value = true
    request = (async () => {
      try {
        const response = await window.api.checkUpdate()
        if (!response.success || !response.data) {
          return { error: response.error || '检查更新失败，请稍后再试' }
        }
        result.value = response.data
        writeCache(response.data)
        return { data: response.data }
      } catch (error) {
        return { error: error instanceof Error ? error.message : '检查更新失败，请稍后再试' }
      } finally {
        checking.value = false
        request = null
      }
    })()
    return request
  }

  async function initialize(currentVersion: string): Promise<void> {
    if (initialized.value || !currentVersion) return
    initialized.value = true
    if (!offState) offState = window.api.onUpdateState(applyTransferState)
    const stateResponse = await window.api.getUpdateState()
    if (stateResponse.success && stateResponse.data) applyTransferState(stateResponse.data)
    const cache = readCache(currentVersion)
    if (cache) {
      result.value = cache.result
      if (Date.now() - cache.checkedAt < CACHE_TTL_MS) {
        if (cache.result.hasUpdate) modalOpen.value = true
        return
      }
    }
    const response = await fetchLatest()
    modalOpen.value = response.data?.hasUpdate === true
  }

  async function checkNow(): Promise<{ data?: UpdateCheckResult; error?: string }> {
    const response = await fetchLatest()
    if (response.data) modalOpen.value = response.data.hasUpdate
    return response
  }

  function showModal(): void {
    if (result.value?.hasUpdate) modalOpen.value = true
  }

  function closeModal(): void {
    modalOpen.value = false
  }

  async function download(): Promise<boolean> {
    actionError.value = ''
    const response = await window.api.downloadUpdate()
    if (response.success && response.data) {
      applyTransferState(response.data)
      return true
    }
    actionError.value = response.error || '更新下载失败，请稍后重试'
    return false
  }

  async function cancelDownload(): Promise<void> {
    const response = await window.api.cancelUpdateDownload()
    if (response.success && response.data) applyTransferState(response.data)
    else if (response.error) actionError.value = response.error
  }

  async function applyDownloaded(): Promise<boolean> {
    actionError.value = ''
    const response = await window.api.applyUpdate()
    if (response.success && response.data) {
      applyTransferState(response.data)
      return true
    }
    actionError.value = response.error || '无法启动更新安装程序'
    return false
  }

  return {
    result,
    checking,
    modalOpen,
    initialized,
    transfer,
    actionError,
    hasUpdate,
    latestVersion,
    initialize,
    checkNow,
    showModal,
    closeModal,
    download,
    cancelDownload,
    applyDownloaded
  }
})

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useUpdateStore, import.meta.hot))
}
