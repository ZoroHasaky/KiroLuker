<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { storeToRefs } from 'pinia'
import { message, Modal } from 'ant-design-vue'
import {
  CheckCircleFilled,
  CopyOutlined,
  DeleteOutlined,
  DownOutlined,
  DownloadOutlined,
  EditOutlined,
  EyeInvisibleOutlined,
  EyeOutlined,
  KeyOutlined,
  PlusOutlined,
  PoweroffOutlined,
  ReloadOutlined,
  SearchOutlined,
  SettingOutlined,
  SortAscendingOutlined,
  SwapOutlined,
  SyncOutlined,
  ThunderboltOutlined,
  UploadOutlined
} from '@ant-design/icons-vue'
import { useKeysStore } from '@/stores/keys'
import { useSettingsStore } from '@/stores/settings'
import { confirmUseApiKey } from '@/utils/ui'
import { formatCreditsPair, formatDateTime, usageColor } from '@/utils/format'
import RegionSelect from '@/components/common/RegionSelect.vue'
import UsageHistoryModal from '@/components/accounts/UsageHistoryModal.vue'
import ApiKeyDetailDrawer from '@/components/keys/ApiKeyDetailDrawer.vue'
import ApiKeyTestModal from '@/components/keys/ApiKeyTestModal.vue'
import type { KeyEntry } from '@shared/types'

const store = useKeysStore()
const settingsStore = useSettingsStore()
const { data, status, activeKey, loading } = storeToRefs(store)
const precision = computed(() => settingsStore.settings.usagePrecision)
const privacyMode = computed(() => settingsStore.settings.privacyMode)
const search = ref('')

const addOpen = ref(false)
const addValue = ref('')
const addNote = ref('')
const adding = ref(false)
const importOpen = ref(false)
const importText = ref('')
const importing = ref(false)

const editOpen = ref(false)
const editId = ref('')
const editNote = ref('')
const detailTarget = ref<KeyEntry | null>(null)
const testTarget = ref<KeyEntry | null>(null)
const usageTarget = ref<KeyEntry | null>(null)
const selectedIds = ref<string[]>([])
const sortKey = ref<'createdAt' | 'usage' | 'checked' | 'note'>('createdAt')
const configOpen = ref(false)
const configRegion = ref('us-east-1')
const configKrs = ref(19830)
const configCps = ref(19831)
const savingConfig = ref(false)
const syncingAll = ref(false)
const busyActions = ref(new Set<string>())

type RestartPromptReason = 'gateway-enabled' | 'gateway-disabled' | 'key-selected'
interface RestartPrompt {
  reason: RestartPromptReason
  keyId?: string
  needRestart: boolean
}
const restartPrompt = ref<RestartPrompt | null>(null)
const restartingIde = ref(false)
const restartPromptTitle = computed(() => {
  if (restartPrompt.value?.reason === 'gateway-enabled') return 'API Key 接管已开启'
  if (restartPrompt.value?.reason === 'gateway-disabled') return 'API Key 接管已关闭'
  return '当前 API Key 已切换'
})
const restartPromptKeyLabel = computed(() => {
  const keyId = restartPrompt.value?.keyId
  if (!keyId) return undefined
  const entry = data.value.keys.find((item) => item.id === keyId)
  return entry ? keyConfirmationLabel(entry) : undefined
})
const restartPromptMessage = computed(() => {
  const prompt = restartPrompt.value
  if (!prompt) return ''
  const keyLabel = restartPromptKeyLabel.value
  if (prompt.reason === 'key-selected') {
    return `已切换为 ${keyLabel || '新的 API Key'}，后续网关请求会立即使用该 Key。`
  }
  if (prompt.reason === 'gateway-disabled') {
    return prompt.needRestart
      ? 'API Key 网关已关闭。Kiro IDE 需要重启后，才会重新加载恢复后的官方端点。'
      : 'API Key 网关已关闭，Kiro IDE 的官方端点已经恢复。'
  }
  const enabledText = keyLabel
    ? `已开启网关并将 ${keyLabel} 设为当前 API Key。`
    : 'API Key 网关已开启。'
  return prompt.needRestart
    ? `${enabledText} Kiro IDE 需要重启后，才会重新加载本地网关端点。`
    : `${enabledText} 如当前 IDE 会话未重新连接，可重启后继续使用。`
})

const sortOptions = [
  { value: 'createdAt', label: '添加时间' },
  { value: 'usage', label: '用量占比' },
  { value: 'checked', label: '最后同步' },
  { value: 'note', label: '备注' }
] as const
const sortLabel = computed(() => sortOptions.find((item) => item.value === sortKey.value)?.label)

const filteredKeys = computed(() => {
  const needle = search.value.trim().toLowerCase()
  return [...data.value.keys]
    .filter((entry) => {
      if (!needle) return true
      return (entry.note || '').toLowerCase().includes(needle) || entry.key.toLowerCase().includes(needle)
    })
    .sort((a, b) => {
      const active = Number(b.id === data.value.activeKeyId) - Number(a.id === data.value.activeKeyId)
      if (active) return active
      if (sortKey.value === 'usage') return usageRatio(b) - usageRatio(a)
      if (sortKey.value === 'checked') return (b.lastCheckedAt || 0) - (a.lastCheckedAt || 0)
      if (sortKey.value === 'note') return (a.note || '').localeCompare(b.note || '')
      return b.createdAt - a.createdAt
    })
})

const selectedSet = computed(() => new Set(selectedIds.value))
const visibleSelectedCount = computed(() => filteredKeys.value.filter((entry) => selectedSet.value.has(entry.id)).length)
const allVisibleSelected = computed(() => filteredKeys.value.length > 0 && visibleSelectedCount.value === filteredKeys.value.length)
const someVisibleSelected = computed(() => visibleSelectedCount.value > 0 && !allVisibleSelected.value)
const normalCount = computed(() => data.value.keys.filter((entry) => entry.lastCheckedAt && !entry.lastError).length)
const errorCount = computed(() => data.value.keys.filter((entry) => !!entry.lastError).length)

function toggleSelect(id: string, checked: boolean): void {
  const next = new Set(selectedIds.value)
  checked ? next.add(id) : next.delete(id)
  selectedIds.value = [...next]
}

function toggleSelectVisible(checked: boolean): void {
  const next = new Set(selectedIds.value)
  for (const entry of filteredKeys.value) checked ? next.add(entry.id) : next.delete(entry.id)
  selectedIds.value = [...next]
}

function maskKey(key: string): string {
  if (key.length <= 16) return `${key.slice(0, 4)}${'*'.repeat(Math.max(4, key.length - 4))}`
  return `${key.slice(0, 8)}${'*'.repeat(Math.min(16, key.length - 16))}${key.slice(-8)}`
}

function displayKey(key: string): string {
  return privacyMode.value ? maskKey(key) : key
}

function togglePrivacy(): void {
  void settingsStore.update({ privacyMode: !privacyMode.value })
}

const BAR_COUNT = 40

function usageRatio(entry: KeyEntry): number {
  if (!entry.totalCredits || !Number.isFinite(entry.totalCredits)) return 0
  return Math.min(1, Math.max(0, (entry.usedCredits || 0) / entry.totalCredits))
}

function usagePercent(entry: KeyEntry): number {
  return usageRatio(entry) * 100
}

function usagePercentText(entry: KeyEntry): string {
  const value = usagePercent(entry)
  if (value <= 0) return '0'
  if (value >= 100) return '100'
  return value.toFixed(2)
}

function filledBars(entry: KeyEntry): number {
  return Math.round(usageRatio(entry) * BAR_COUNT)
}

function keyUsageColor(entry: KeyEntry): string {
  return usageColor(usageRatio(entry))
}

const usageSubject = computed(() => {
  const entry = usageTarget.value
  if (!entry) return null
  return {
    id: `key:${entry.id}`,
    label: displayKey(entry.key),
    percentUsed: usageRatio(entry),
    noun: 'API Key'
  }
})

function keyStatus(entry: KeyEntry): { color: string; text: string } {
  if (entry.lastError) return { color: 'red', text: '异常' }
  if (entry.lastCheckedAt) return { color: 'green', text: '正常' }
  return { color: 'default', text: '未检查' }
}

function subscriptionColor(entry: KeyEntry): string {
  if (entry.tier === 'power') return 'gold'
  if (entry.tier === 'pro+') return 'purple'
  if (entry.tier === 'pro') return 'blue'
  if (entry.tier === 'free') return 'default'
  return 'cyan'
}

type BusyAction = 'select' | 'sync'

function actionBusy(id: string, action: BusyAction): boolean {
  return busyActions.value.has(`${id}:${action}`)
}

function setBusy(id: string, action: BusyAction, busy: boolean): void {
  const next = new Set(busyActions.value)
  const key = `${id}:${action}`
  busy ? next.add(key) : next.delete(key)
  busyActions.value = next
}

async function submitAdd(): Promise<void> {
  adding.value = true
  try {
    const rawKey = addValue.value.trim()
    const error = await store.add(rawKey, addNote.value)
    if (error) return void message.error(error)
    const added = data.value.keys.find((entry) => entry.key === rawKey)
    const verifyError = added ? await store.sync(added.id) : null
    addOpen.value = false
    addValue.value = ''
    addNote.value = ''
    if (verifyError) message.warning(`Key 已保存，但远端校验失败：${verifyError}`)
    else message.success('API Key 已添加并校验通过')
  } finally {
    adding.value = false
  }
}

async function submitImport(): Promise<void> {
  importing.value = true
  try {
    const result = await store.importText(importText.value)
    if (result.error) return void message.error(result.error)
    const synced = result.added ? await store.syncAll(false) : null
    if (synced && !synced.error) store.scheduleUsageRefresh()
    importOpen.value = false
    importText.value = ''
    const syncText = synced && !synced.error
      ? `；校验成功 ${synced.success}，失败 ${synced.failed}`
      : ''
    message.success(`已添加 ${result.added} 个，重复 ${result.skipped} 个，无效 ${result.invalid} 个${syncText}`)
  } finally {
    importing.value = false
  }
}

function openEdit(entry: KeyEntry): void {
  detailTarget.value = null
  editId.value = entry.id
  editNote.value = entry.note || ''
  editOpen.value = true
}

async function submitEdit(): Promise<void> {
  const error = await store.update(editId.value, editNote.value)
  if (error) return void message.error(error)
  editOpen.value = false
  message.success('备注已保存')
}

function remove(entry: KeyEntry): void {
  const doRemove = async (): Promise<void> => {
    const error = await store.remove(entry.id)
    if (error) return void message.error(error)
    selectedIds.value = selectedIds.value.filter((id) => id !== entry.id)
    if (detailTarget.value?.id === entry.id) detailTarget.value = null
    message.success('已删除')
  }
  if (!settingsStore.settings.confirmBeforeDeleteApiKey) {
    void doRemove()
    return
  }
  Modal.confirm({
    title: '删除 API Key',
    content: `确认删除 ${entry.note || maskKey(entry.key)}？此操作不可撤销。`,
    okText: '删除',
    okType: 'danger',
    cancelText: '取消',
    onOk: doRemove
  })
}

function keyConfirmationLabel(entry: KeyEntry): string {
  const key = displayKey(entry.key)
  return entry.note ? `${entry.note}（${key}）` : key
}

async function applySelection(entry: KeyEntry): Promise<void> {
  if (actionBusy(entry.id, 'select')) return
  setBusy(entry.id, 'select', true)
  try {
    const error = await store.select(entry.id)
    if (error) return void message.error(error)
    restartPrompt.value = {
      reason: 'key-selected',
      keyId: entry.id,
      needRestart: false
    }
  } finally {
    setBusy(entry.id, 'select', false)
  }
}

async function enableGatewayAndSelect(entry: KeyEntry): Promise<void> {
  if (actionBusy(entry.id, 'select')) return
  setBusy(entry.id, 'select', true)
  try {
    const error = await store.setEnabled(true, entry.id)
    if (error) {
      message.error(`开启网关失败：${error}`)
      throw new Error(error)
    }

    restartPrompt.value = {
      reason: 'gateway-enabled',
      keyId: entry.id,
      needRestart: status.value?.needRestart ?? true
    }
  } finally {
    setBusy(entry.id, 'select', false)
  }
}

function confirmEnableGatewayAndSelect(entry: KeyEntry): void {
  const label = keyConfirmationLabel(entry)
  Modal.confirm({
    title: 'API Key 网关未开启',
    content: `切换到 ${label} 前需要先开启网关。开启后会将 Kiro IDE 的 AI 请求端点切换到本地网关。`,
    okText: '开启网关并使用该 API Key',
    okType: 'primary',
    cancelText: '取消',
    onOk: () => enableGatewayAndSelect(entry)
  })
}

function select(entry: KeyEntry): void {
  if (entry.id === data.value.activeKeyId || actionBusy(entry.id, 'select')) return
  if (!data.value.enabled) {
    confirmEnableGatewayAndSelect(entry)
    return
  }
  confirmUseApiKey(keyConfirmationLabel(entry), () => applySelection(entry))
}

async function sync(entry: KeyEntry): Promise<void> {
  setBusy(entry.id, 'sync', true)
  try {
    const error = await store.sync(entry.id)
    if (error) return void message.error(error)
    message.success('订阅与额度已同步')
  } finally {
    setBusy(entry.id, 'sync', false)
  }
}

async function syncAll(): Promise<void> {
  const selected = new Set(selectedIds.value)
  const targets = selected.size
    ? data.value.keys.filter((entry) => selected.has(entry.id))
    : filteredKeys.value
  if (!targets.length) return void message.info('没有可刷新的 API Key')

  syncingAll.value = true
  try {
    const result = await store.syncMany(targets.map((entry) => entry.id))
    if (result.error) return void message.error(result.error)
    if (!selected.size) store.scheduleUsageRefresh()
    const text = `用量刷新完成：成功 ${result.success}，失败 ${result.failed}`
    result.failed ? message.warning(text) : message.success(text)
  } finally {
    syncingAll.value = false
  }
}

function test(entry: KeyEntry): void {
  testTarget.value = entry
}

function removeSelected(): void {
  const ids = [...selectedIds.value]
  if (!ids.length) return void message.info('请先选择 API Key')
  const execute = async (): Promise<void> => {
    let removed = 0
    let failed = 0
    for (const id of ids) {
      const error = await store.remove(id)
      error ? failed++ : removed++
    }
    selectedIds.value = selectedIds.value.filter((id) => data.value.keys.some((entry) => entry.id === id))
    const text = `已删除 ${removed} 个${failed ? `，失败 ${failed} 个` : ''}`
    failed ? message.warning(text) : message.success(text)
  }
  if (!settingsStore.settings.confirmBeforeDeleteApiKey) return void execute()
  Modal.confirm({
    title: `删除 ${ids.length} 个 API Key`,
    content: '删除后无法恢复；正在接管中使用的当前 Key 会被保护，不会删除。',
    okText: '删除',
    okType: 'danger',
    cancelText: '取消',
    onOk: execute
  })
}

function copy(entry: KeyEntry): void {
  window.api.writeClipboard(entry.key)
  message.success('完整 API Key 已复制')
}

function exportKeys(): void {
  const selected = new Set(selectedIds.value)
  const targets = selected.size
    ? data.value.keys.filter((entry) => selected.has(entry.id))
    : filteredKeys.value
  if (!targets.length) return void message.info('没有可导出的 API Key')
  Modal.confirm({
    title: `导出 ${targets.length} 个完整 API Key`,
    content: '导出文件包含可直接使用的完整凭证，请妥善保管。',
    okText: '继续导出',
    cancelText: '取消',
    onOk: async () => {
      const content = targets.map((entry) => entry.key).join('\n') + '\n'
      const result = await window.api.exportToFile(content, `kiro-api-keys-${Date.now()}.txt`)
      if (!result.success) return void message.error(result.error || '导出失败')
      if (result.data?.saved) message.success('已导出')
    }
  })
}

async function toggleGateway(checked: boolean): Promise<void> {
  const targetKey = checked ? data.value.keys[0] : undefined
  if (checked && !targetKey) {
    message.warning('请先添加 API Key')
    return
  }
  const error = await store.setEnabled(checked, targetKey?.id)
  if (error) return void message.error(error)
  if (checked) {
    restartPrompt.value = {
      reason: 'gateway-enabled',
      keyId: targetKey?.id,
      needRestart: status.value?.needRestart ?? true
    }
  } else {
    restartPrompt.value = {
      reason: 'gateway-disabled',
      needRestart: status.value?.needRestart ?? true
    }
  }
}

function confirmToggleGateway(): void {
  const enabling = !data.value.enabled
  const firstKey = data.value.keys[0]
  if (enabling && !firstKey) {
    message.warning('请先添加 API Key')
    return
  }
  Modal.confirm({
    title: enabling ? '开启 API Key 网关' : '关闭 API Key 网关',
    content: enabling
      ? `开启后会将 Kiro IDE 的 AI 请求端点切换到本地网关，并默认使用列表中的第一个 API Key：${firstKey ? keyConfirmationLabel(firstKey) : ''}`
      : '关闭后会停止接管 Kiro IDE 的 AI 请求，并还原官方端点。',
    okText: enabling ? '开启网关' : '关闭网关',
    okType: 'primary',
    okButtonProps: { danger: !enabling },
    cancelText: '取消',
    onOk: () => toggleGateway(enabling)
  })
}

function openConfig(): void {
  configRegion.value = data.value.region
  configKrs.value = data.value.ports.krs
  configCps.value = data.value.ports.cps
  configOpen.value = true
}

async function saveConfig(): Promise<void> {
  savingConfig.value = true
  try {
    const error = await store.configure(configRegion.value, configKrs.value, configCps.value)
    if (error) return void message.error(error)
    configOpen.value = false
    message.success('网关配置已保存')
  } finally {
    savingConfig.value = false
  }
}

async function restartIde(): Promise<boolean> {
  restartingIde.value = true
  try {
    const result = await window.api.restartKiroIde()
    if (!result.success || !result.data) {
      message.error(result.error || '重启 Kiro IDE 失败')
      return false
    }
    if (!result.data.started) {
      message.warning(result.data.message)
      return false
    }
    message.success(result.data.message)
    if (status.value) status.value = { ...status.value, needRestart: false }
    return true
  } catch (cause) {
    message.error(cause instanceof Error ? cause.message : '重启 Kiro IDE 失败')
    return false
  } finally {
    restartingIde.value = false
  }
}

async function confirmRestart(): Promise<void> {
  if (await restartIde()) restartPrompt.value = null
}

onMounted(() => void store.load())
</script>

<template>
  <div class="keys-page">
    <a-card class="gateway-card" :bordered="false">
      <div class="gateway-row">
        <div class="gateway-main">
          <div class="gateway-title">
            <KeyOutlined />
            <strong>API Key 接管</strong>
            <a-tag :color="status?.running && status?.endpointsBound ? 'success' : data.enabled ? 'warning' : 'default'">
              {{ status?.running && status?.endpointsBound ? '运行中' : data.enabled ? '启动中' : '未开启' }}
            </a-tag>
          </div>
          <div class="gateway-desc">
            当前：{{ activeKey?.note || (activeKey ? maskKey(activeKey.key) : '未选择 Key') }}
            · {{ data.region }} · KRS {{ data.ports.krs }} / CPS {{ data.ports.cps }}
          </div>
          <div class="gateway-hint">
            API Key 不会替换 IDE 登录账号；开启后仅将 AI 请求额度切换为当前 Key。
            默认端口为 KRS 19830 / CPS 19831。
          </div>
        </div>
        <a-button
          :type="data.enabled ? 'primary' : 'default'"
          :danger="data.enabled"
          :loading="loading"
          @click="confirmToggleGateway"
        >
          <template #icon><PoweroffOutlined /></template>
          {{ data.enabled ? '关闭网关' : '开启网关' }}
        </a-button>
        <a-tooltip :title="data.enabled ? '关闭接管后才能修改' : 'Region 与本地端口'">
          <a-button :disabled="data.enabled || loading" @click="openConfig">
            <template #icon><SettingOutlined /></template>
          </a-button>
        </a-tooltip>
      </div>
      <a-alert
        v-if="status?.message"
        class="status-message"
        :message="status.message"
        :type="status.enabled ? 'info' : 'warning'"
        show-icon
      />
    </a-card>

    <div class="keys-header">
      <div class="toolbar">
        <a-input v-model:value="search" allow-clear placeholder="搜索备注或 API Key" class="search-input">
          <template #prefix><SearchOutlined /></template>
        </a-input>
        <span class="spacer" />
        <a-button type="primary" @click="addOpen = true">
          <template #icon><PlusOutlined /></template>添加 API Key
        </a-button>
        <a-button @click="importOpen = true"><template #icon><UploadOutlined /></template>导入</a-button>
        <a-button :disabled="!data.keys.length" @click="exportKeys">
          <template #icon><DownloadOutlined /></template>导出
        </a-button>
      </div>

      <div class="meta-bar">
        <span class="count-text">共 {{ filteredKeys.length }} 个 API Key</span>
        <a-tag v-if="normalCount" color="green" :bordered="false">正常 {{ normalCount }}</a-tag>
        <a-tag v-if="errorCount" color="red" :bordered="false">异常 {{ errorCount }}</a-tag>
        <span class="spacer" />

        <a-dropdown>
          <a-button size="small">
            <template #icon><SortAscendingOutlined /></template>
            {{ sortLabel }} <DownOutlined />
          </a-button>
          <template #overlay>
            <a-menu :selected-keys="[sortKey]">
              <a-menu-item v-for="item in sortOptions" :key="item.value" @click="sortKey = item.value">
                {{ item.label }}
              </a-menu-item>
            </a-menu>
          </template>
        </a-dropdown>
        <a-divider type="vertical" style="margin: 0 2px" />
        <a-tooltip :title="selectedIds.length ? '刷新所选 API Key' : '刷新当前全部结果'">
          <a-button size="small" type="text" :loading="syncingAll" @click="syncAll">
            <template #icon><SyncOutlined /></template>
          </a-button>
        </a-tooltip>
        <a-tooltip :title="privacyMode ? '显示完整 API Key' : '隐私打码：隐藏 API Key'">
          <a-button
            size="small"
            :type="privacyMode ? 'primary' : 'text'"
            @click="togglePrivacy"
          >
            <template #icon>
              <EyeInvisibleOutlined v-if="privacyMode" />
              <EyeOutlined v-else />
            </template>
          </a-button>
        </a-tooltip>
        <a-tooltip title="删除所选 API Key">
          <a-button size="small" type="text" danger :disabled="!selectedIds.length" @click="removeSelected">
            <template #icon><DeleteOutlined /></template>
          </a-button>
        </a-tooltip>
        <a-divider type="vertical" style="margin: 0 2px" />
        <a-checkbox
          :checked="allVisibleSelected"
          :indeterminate="someVisibleSelected"
          :disabled="!filteredKeys.length"
          @change="(event: any) => toggleSelectVisible(event.target.checked)"
        >全选</a-checkbox>
        <template v-if="selectedIds.length">
          <span class="count-text">已选 {{ selectedIds.length }}</span>
          <a-button type="link" size="small" @click="selectedIds = []">清空</a-button>
        </template>
      </div>
    </div>

    <div v-if="filteredKeys.length" class="key-grid">
      <a-card
        v-for="entry in filteredKeys"
        :key="entry.id"
        class="key-card"
        :class="{ active: entry.id === data.activeKeyId, selected: selectedSet.has(entry.id) }"
        hoverable
        @click="detailTarget = entry"
      >
        <div class="key-head">
          <div class="key-name">
            <a-checkbox
              :checked="selectedSet.has(entry.id)"
              @click.stop
              @change="(event: any) => toggleSelect(entry.id, event.target.checked)"
            />
            <div class="key-identity">
              <span
                class="key-value mono"
                :title="privacyMode ? undefined : entry.key"
              >{{ displayKey(entry.key) }}</span>
              <span class="key-note muted">备注：{{ entry.note || '-' }}</span>
            </div>
          </div>
        </div>

        <div class="tag-row">
          <a-tag :color="keyStatus(entry).color" class="status-tag">
            {{ keyStatus(entry).text }}
          </a-tag>
          <a-tag :color="subscriptionColor(entry)" :bordered="false">
            {{ entry.subscription || '等级未知' }}
          </a-tag>
        </div>

        <div
          class="usage-block"
          title="点击查看积分变化"
          @click.stop="usageTarget = entry"
        >
          <div class="usage-head">
            <span class="usage-title">
              <span class="muted">使用量</span>
              <span
                class="usage-updated muted"
                :title="entry.lastCheckedAt ? `用量与积分更新于 ${formatDateTime(entry.lastCheckedAt)}` : undefined"
              >
                {{ entry.lastCheckedAt ? formatDateTime(entry.lastCheckedAt) : '尚未同步' }}
              </span>
            </span>
            <strong class="usage-percent" :style="{ color: keyUsageColor(entry) }">
              {{ usagePercentText(entry) }}<small>%</small>
            </strong>
          </div>
          <div
            class="usage-bars"
            :style="{ '--bar-on': keyUsageColor(entry) }"
            role="progressbar"
            aria-valuemin="0"
            aria-valuemax="100"
            :aria-valuenow="Math.round(usagePercent(entry))"
          >
            <span
              v-for="i in BAR_COUNT"
              :key="i"
              class="bar"
              :class="{ on: i <= filledBars(entry) }"
            />
          </div>
          <div class="usage-foot">
            <span class="usage-number">
              {{ formatCreditsPair(entry.usedCredits ?? 0, entry.totalCredits ?? 0, precision) }}
            </span>
            <span class="muted">已用 / 总额度</span>
          </div>
        </div>
        <div class="error-slot">
          <div v-if="entry.lastError" class="error-line" :title="entry.lastError">
            {{ entry.lastError }}
          </div>
        </div>

        <div class="key-actions" @click.stop>
          <div class="key-switch-action">
            <span v-if="entry.id === data.activeKeyId" class="current-key-label">
              <CheckCircleFilled />
              当前使用
            </span>
            <a-button
              v-else
              type="link"
              size="small"
              class="switch-key-btn"
              :loading="actionBusy(entry.id, 'select')"
              @click.stop="select(entry)"
            >
              <template #icon><SwapOutlined /></template>
              切换到该 Key
            </a-button>
          </div>
          <div class="action-row">
            <a-tooltip title="刷新用量与积分">
              <a-button
                type="text"
                size="small"
                class="action-btn"
                :loading="actionBusy(entry.id, 'sync')"
                @click.stop="sync(entry)"
              >
                <template #icon><SyncOutlined /></template>
              </a-button>
            </a-tooltip>
            <a-tooltip title="测活（发一次真实对话）">
              <a-button type="text" size="small" class="action-btn" @click.stop="test(entry)">
                <template #icon><ThunderboltOutlined /></template>
              </a-button>
            </a-tooltip>
            <a-tooltip title="复制完整 API Key">
              <a-button type="text" size="small" class="action-btn" @click.stop="copy(entry)">
                <template #icon><CopyOutlined /></template>
              </a-button>
            </a-tooltip>
            <a-tooltip title="修改备注">
              <a-button type="text" size="small" class="action-btn" @click.stop="openEdit(entry)">
                <template #icon><EditOutlined /></template>
              </a-button>
            </a-tooltip>
            <a-tooltip title="删除">
              <a-button type="text" size="small" class="action-btn" danger @click.stop="remove(entry)">
                <template #icon><DeleteOutlined /></template>
              </a-button>
            </a-tooltip>
          </div>
        </div>
      </a-card>
    </div>
    <a-empty v-else class="empty" :description="data.keys.length ? '没有匹配的 Key' : '还没有 API Key，请先添加'" />

    <a-modal v-model:open="addOpen" title="添加 Kiro API Key" :confirm-loading="adding" @ok="submitAdd">
      <a-form layout="vertical">
        <a-form-item label="API Key" required>
          <a-input-password v-model:value="addValue" placeholder="ksk_..." />
        </a-form-item>
        <a-form-item label="备注">
          <a-input v-model:value="addNote" placeholder="例如：主力 Key" @press-enter="submitAdd" />
        </a-form-item>
      </a-form>
    </a-modal>

    <a-modal v-model:open="importOpen" title="批量导入 API Key" :confirm-loading="importing" @ok="submitImport">
      <a-textarea v-model:value="importText" :rows="10" placeholder="每行一个 ksk_ 开头的 API Key，自动忽略空行和重复项" />
    </a-modal>

    <a-modal v-model:open="editOpen" title="修改备注" @ok="submitEdit">
      <a-input v-model:value="editNote" placeholder="留空表示无备注" @press-enter="submitEdit" />
    </a-modal>

    <ApiKeyDetailDrawer
      :key-entry="detailTarget"
      @close="detailTarget = null"
      @test="(entry) => { detailTarget = null; testTarget = entry }"
      @edit="openEdit"
    />
    <ApiKeyTestModal :key-entry="testTarget" @close="testTarget = null" />
    <UsageHistoryModal :subject="usageSubject" @close="usageTarget = null" />

    <a-modal
      :open="!!restartPrompt"
      width="520px"
      :footer="null"
      :mask-closable="false"
      :closable="!restartingIde"
      @cancel="restartPrompt = null"
    >
      <template #title>
        <span class="restart-title">
          <CheckCircleFilled style="color: #52c41a" />
          {{ restartPromptTitle }}
        </span>
      </template>

      <p v-if="restartPrompt?.reason === 'key-selected'" class="restart-lead">
        当前凭证切换已完成。
      </p>
      <p v-else-if="restartPrompt?.reason === 'gateway-disabled'" class="restart-lead">
        Kiro IDE 的 AI 请求端点已恢复为官方服务。
      </p>
      <p v-else class="restart-lead">
        Kiro IDE 的 AI 请求端点已配置为本地 API Key 网关。
      </p>

      <a-alert
        :type="restartPrompt?.needRestart ? 'warning' : 'success'"
        show-icon
        :message="restartPromptMessage"
        style="margin-bottom: 14px"
      />

      <p class="muted restart-tip">
        {{
          restartPrompt?.reason === 'key-selected'
            ? '网关会实时读取当前 Key；重启可让 IDE 当前会话重新建立连接。'
            : '已经运行的 Kiro IDE 可能仍缓存旧端点，建议现在重启以确保配置完全生效。'
        }}
      </p>

      <a-space style="width: 100%; justify-content: flex-end">
        <a-button :disabled="restartingIde" @click="restartPrompt = null">稍后手动重启</a-button>
        <a-button type="primary" :loading="restartingIde" @click="confirmRestart">
          <template #icon><ReloadOutlined /></template>
          立即重启 Kiro IDE
        </a-button>
      </a-space>
    </a-modal>

    <a-modal v-model:open="configOpen" title="网关配置" :confirm-loading="savingConfig" @ok="saveConfig">
      <a-form layout="vertical">
        <a-form-item label="Region" required>
          <RegionSelect v-model:value="configRegion" :disabled="data.enabled" />
        </a-form-item>
        <div class="port-row">
          <a-form-item label="KRS 生成面端口" required>
            <a-input-number v-model:value="configKrs" :min="1024" :max="65535" />
          </a-form-item>
          <a-form-item label="CPS 控制面端口" required>
            <a-input-number v-model:value="configCps" :min="1024" :max="65535" />
          </a-form-item>
        </div>
      </a-form>
      <a-alert
        message="建议保持默认端口；端口需为 1024–65535 的整数，且 KRS 与 CPS 不能相同。"
        type="info"
        show-icon
      />
    </a-modal>
  </div>
</template>

<style scoped>
.keys-page { display: flex; flex-direction: column; gap: 16px; min-height: 100%; }
.gateway-card { border: 1px solid color-mix(in srgb, var(--kal-primary) 35%, var(--kal-border)); background: color-mix(in srgb, var(--kal-primary) 5%, transparent); }
.gateway-row { display: flex; align-items: center; gap: 12px; }
.gateway-main { flex: 1 1 auto; min-width: 0; }
.gateway-title { display: flex; align-items: center; gap: 9px; font-size: 17px; }
.gateway-desc { margin-top: 7px; font-size: 13px; }
.gateway-hint { margin-top: 4px; color: var(--kal-muted); font-size: 12px; }
.status-message { margin-top: 14px; }
.keys-header { flex: 0 0 auto; }
.toolbar, .meta-bar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.toolbar { margin-bottom: 10px; }
.meta-bar { min-height: 32px; }
.count-text { color: var(--kal-muted); font-size: 12px; }
.search-input { width: 100%; max-width: 480px; }
.spacer { flex: 1 1 auto; }
.key-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(350px, 1fr)); gap: 14px; }
.key-card { border: 1px solid var(--kal-border); overflow: hidden; cursor: pointer; }
.key-card :deep(.ant-card-body) { padding-block: 18px; }
.key-card.selected { border-color: var(--kal-primary); box-shadow: 0 0 0 1px var(--kal-primary) inset; }
.key-card.active { border-color: #52c41a; box-shadow: none; }
.key-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 8px; }
.key-name { display: flex; flex: 1 1 auto; align-items: flex-start; gap: 7px; min-width: 0; }
.key-identity { flex: 1 1 auto; min-width: 0; line-height: 1.4; }
.key-switch-action { display: flex; flex: 1 1 auto; align-items: center; min-width: 0; min-height: 24px; }
.current-key-label { display: inline-flex; align-items: center; gap: 5px; color: #52c41a; font-size: 12px; font-weight: 600; }
.switch-key-btn { height: 24px; padding: 0; font-size: 12px; }
.key-value, .key-note { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.key-value { font-size: 13px; font-weight: 600; }
.key-note { margin-top: 2px; font-size: 12px; }
.status-tag { flex: 0 0 auto; margin: 0; }
.tag-row { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; min-height: 22px; margin-top: 10px; }
.tag-row :deep(.ant-tag) { margin: 0; }
.usage-block { display: flex; flex-direction: column; gap: 4px; height: 105px; margin-top: 12px; padding: 12px; box-sizing: border-box; border-radius: 12px; background: var(--kal-block-bg); cursor: pointer; transition: background 0.16s ease; }
.usage-block:hover { background: var(--kal-code-bg); }
.usage-head, .usage-foot { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; font-size: 12.5px; }
.usage-title { display: flex; align-items: baseline; gap: 6px; min-width: 0; }
.usage-updated { max-width: 150px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11px; }
.usage-percent { flex: 0 0 auto; font-size: 20px; font-weight: 700; line-height: 1; }
.usage-percent small { margin-left: 1px; font-size: 12px; }
.usage-bars { display: flex; align-items: stretch; gap: 2px; height: 14px; margin: 8px 0 10px; }
.bar { flex: 1 1 0; border-radius: 2px; background: var(--kal-bar-off); transition: background 0.2s ease; }
.bar.on { background: var(--bar-on); }
.usage-number { font-weight: 600; }
.error-slot { height: 27px; margin-top: 8px; }
.error-line { padding: 5px 8px; overflow: hidden; color: #ff4d4f; border-radius: 8px; background: rgba(255, 77, 79, 0.08); font-size: 11.5px; text-overflow: ellipsis; white-space: nowrap; }
.key-actions { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-top: 18px; padding: 8px 0 0; border-top: 1px solid var(--kal-border); }
.action-row { display: flex; flex: 0 0 auto; align-items: center; gap: 0; }
.action-btn { width: 24px; min-width: 24px; height: 24px; padding: 0; }
.switch-btn { width: auto; min-width: 0; padding-inline: 8px; gap: 4px; }
.switch-btn.active { color: #52c41a; background: color-mix(in srgb, #52c41a 10%, transparent); }
.empty { margin: 70px 0; }
.test-loading { display: grid; place-items: center; min-height: 220px; }
.model-list { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 16px; max-height: 180px; overflow: auto; }
.test-note { margin-top: 16px; }
.port-row { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
.port-row :deep(.ant-input-number) { width: 100%; }
.restart-title { display: inline-flex; align-items: center; gap: 8px; }
.restart-lead { margin: 0 0 12px; }
.restart-tip { margin: 0 0 14px; font-size: 12px; }
.mono { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; }
.muted { color: var(--kal-muted); }
@media (max-width: 900px) {
  .gateway-row { align-items: flex-start; flex-wrap: wrap; }
  .key-grid { grid-template-columns: 1fr; }
}
</style>
