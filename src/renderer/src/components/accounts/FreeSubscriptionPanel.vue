<script lang="ts">
import { ref as sessionRef } from 'vue'
import type { Account, IpcResult } from '@shared/types'
import type { SubscriptionRenewalInfo, SwitchSubscriptionToFreeResult } from '@shared/subscriptionFree'
import {
  canSwitchSubscription, loadSubscriptionRecords, needsSubscriptionCheck, saveSubscriptionRecords,
  type SubscriptionOperation as Operation, type SubscriptionRecords, type SubscriptionRowStatus as RowStatus
} from '@/utils/subscriptionRecords'

let savedRecords: SubscriptionRecords = Object.create(null)
let initialStorageError = ''
try {
  savedRecords = loadSubscriptionRecords(localStorage)
} catch {
  initialStorageError = '无法读取本机订阅记录，请先重新只读检查；未检查的账号不能切换。'
}
// Shared locks survive navigation. Only whitelisted status/timing fields are persisted.
const freeSession = {
  working: sessionRef(false),
  operation: sessionRef<Operation>('check'),
  completed: sessionRef(0),
  total: sessionRef(0),
  results: sessionRef<SubscriptionRecords>(savedRecords),
  storageError: sessionRef(initialStorageError)
}
</script>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { InfoCircleOutlined, ReloadOutlined, SearchOutlined } from '@ant-design/icons-vue'
import type { CheckboxChangeEvent } from 'ant-design-vue/es/checkbox/interface'
import VirtualList from '@/components/common/VirtualList.vue'
import { useAccountsStore } from '@/stores/accounts'
import { useSettingsStore } from '@/stores/settings'
import { displayEmail, displayName } from '@/utils/display'
import { toPlain } from '@/utils/ipc'
import { isSubscriptionAuthError } from '@shared/subscriptionBatch'
import {
  filterSubscriptionAccounts, subscriptionPlanOptions, subscriptionArrangementOptions,
  type SubscriptionPlanFilter, type SubscriptionArrangementFilter
} from '@/utils/subscriptionFilters'

const props = defineProps<{ accounts: Account[]; disabled?: boolean }>()
const emit = defineEmits<{ busy: [value: boolean] }>()
const accountsStore = useAccountsStore()
const settingsStore = useSettingsStore()
const search = ref('')
const planFilter = ref<SubscriptionPlanFilter>('all')
const arrangementFilter = ref<SubscriptionArrangementFilter>('all')
const activeFilterCount = computed(() => Number(planFilter.value !== 'all') + Number(arrangementFilter.value !== 'all'))
const listFiltered = computed(() => !!search.value.trim() || activeFilterCount.value > 0)
const contentRef = ref<{ scrollToTop: () => void } | null>(null)
const selectedIds = ref<string[]>([])
const { working, operation, completed, total, results, storageError } = freeSession
let disposed = false

// Always expose all accounts; selection here is independent of the accounts page.
const availableAccounts = computed(() => [...new Map(props.accounts.map((a) => [a.id, a])).values()])
const visibleAccounts = computed(() => filterSubscriptionAccounts(availableAccounts.value, results.value, {
  search: search.value, plan: planFilter.value, arrangement: arrangementFilter.value
}))
const selectedSet = computed(() => new Set(selectedIds.value))
const selectedAccounts = computed(() => availableAccounts.value.filter((a) => selectedSet.value.has(a.id)))
const locked = computed(() => !!props.disabled || working.value)
const visibleSelectedCount = computed(() => visibleAccounts.value.filter((a) => selectedSet.value.has(a.id)).length)
const allSelected = computed(() => visibleAccounts.value.length > 0 && visibleSelectedCount.value === visibleAccounts.value.length)
const uncheckedCount = computed(() => availableAccounts.value.filter((a) => !results.value[a.id]).length)
const remainingAccounts = computed(() => availableAccounts.value.filter((a) => needsSubscriptionCheck(results.value[a.id])))
const selectedSwitchable = computed(() => selectedAccounts.value.filter((a) => !switchBlocked(a.id)))
const needsCheckCount = computed(() => availableAccounts.value.filter((a) => results.value[a.id]?.needsCheck).length)
const selectedSkippedCount = computed(() => selectedAccounts.value.length - selectedSwitchable.value.length)

watch([search, planFilter, arrangementFilter], () => contentRef.value?.scrollToTop())
watch(() => availableAccounts.value.map((a) => a.id), (ids) => {
  const allowed = new Set(ids)
  selectedIds.value = selectedIds.value.filter((id) => allowed.has(id))
})
watch(working, (value) => emit('busy', value), { flush: 'sync', immediate: true })
onBeforeUnmount(() => {
  // Do not emit idle here: a submitted IPC call may still be running.
  disposed = true
})

const stateLabels: Record<SubscriptionRenewalInfo['state'], string> = {
  paid: '付费订阅',
  free: '门户已为 Free',
  'scheduled-free': '已安排转为 Free',
  canceling: '取消中（尚非 Free）'
}
const switchLabels: Record<SwitchSubscriptionToFreeResult['status'], string> = {
  'already-free': '门户已为 Free，无需修改',
  'already-scheduled': '已安排转为 Free，无需重复提交',
  'wont-renew': '已停止续费，请以门户显示的生效时间为准',
  switched: '门户确认已转为 Free',
  scheduled: '已安排转为 Free，可能在当前计费周期结束后生效',
  unverified: '已提交切换请求，但结果不确定；只能先只读复查，请勿重复提交'
}
const rowColors: Record<RowStatus, string> = {
  pending: 'default', running: 'processing', success: 'green', warning: 'orange', error: 'red'
}
const rowLabels: Record<RowStatus, string> = {
  pending: '等待', running: '执行中', success: '完成', warning: '需关注', error: '失败'
}

function switchBlocked(id: string): boolean {
  return !canSwitchSubscription(results.value[id])
}
function persistRecords(): boolean {
  try {
    saveSubscriptionRecords(localStorage, results.value)
    storageError.value = ''
    return true
  } catch {
    storageError.value = '本机订阅记录保存失败，重启后可能丢失本次结果。暂不允许切换，请先检查并确认记录保存成功。'
    return false
  }
}
function toggleAccount(id: string, checked: boolean): void {
  if (locked.value) return
  const next = new Set(selectedIds.value)
  if (checked) next.add(id)
  else next.delete(id)
  selectedIds.value = [...next]
}
function resetFilters(): void {
  planFilter.value = 'all'
  arrangementFilter.value = 'all'
}
function toggleAll(checked: boolean): void {
  if (locked.value) return
  const next = new Set(selectedIds.value)
  for (const account of visibleAccounts.value) {
    if (checked) next.add(account.id)
    else next.delete(account.id)
  }
  selectedIds.value = [...next]
}
function resultHint(id: string): string {
  const row = results.value[id]
  return row ? [row.message, row.warning].filter(Boolean).join(' · ') : '尚未检查订阅'
}
function accountItemKey(account: Account): string { return account.id }
function shortDate(timestamp?: number): string {
  return timestamp ? new Date(timestamp).toLocaleDateString('zh-CN') : '未提供'
}
function formatTime(timestamp?: number): string {
  if (timestamp === undefined || !Number.isFinite(timestamp)) return '门户未提供'
  const date = new Date(timestamp)
  return Number.isNaN(date.getTime()) ? '时间无效' : date.toLocaleString('zh-CN', { hour12: false })
}
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
function currentAccount(id: string): Account {
  const account = accountsStore.get(id)
  if (!account) throw new Error('账号已不存在，未继续请求')
  return account
}
async function refreshAccount(id: string): Promise<Account> {
  const result = await accountsStore.refreshToken(id)
  if (!result.ok) throw new Error(result.error || '凭证刷新失败')
  return currentAccount(id)
}
async function prepareAccount(id: string): Promise<{ account: Account; refreshed: boolean }> {
  const account = currentAccount(id)
  if (!account.credentials.accessToken || account.credentials.expiresAt <= Date.now() + 60_000) {
    return { account: await refreshAccount(id), refreshed: true }
  }
  return { account, refreshed: false }
}

async function checkOne(id: string): Promise<void> {
  const row = results.value[id]
  try {
    const prepared = await prepareAccount(id)
    if (disposed) {
      row.status = 'warning'
      row.message = '检查未执行：页面已离开'
      return
    }
    let result: IpcResult<SubscriptionRenewalInfo> = await window.api.checkSubscriptionRenewal(toPlain(prepared.account))
    // Only this read-only operation may retry, after at most one credential refresh.
    if (!result.success && !prepared.refreshed && isSubscriptionAuthError(result.error)) {
      const refreshed = await refreshAccount(id)
      if (disposed) {
        row.status = 'warning'
        row.message = '检查未完成：页面已离开，未继续重试'
        return
      }
      result = await window.api.checkSubscriptionRenewal(toPlain(refreshed))
    }
    if (!result.success || !result.data) throw new Error(result.error || '门户未返回续费信息')
    row.renewal = result.data
    row.status = 'success'
    row.message = `只读检查完成：${stateLabels[result.data.state]}`
    row.needsCheck = false
    row.settled = result.data.state !== 'paid'
    row.warning = undefined
    row.previousPlan = undefined
  } catch (error) {
    row.status = 'error'
    row.message = `只读检查失败：${errorText(error)}`
    // Failed reads must not unlock a possibly submitted billing request.
  } finally {
    row.lastCheckAt = Date.now()
  }
}

async function switchOne(id: string): Promise<void> {
  const row = results.value[id]
  let submitted = false
  try {
    const { account } = await prepareAccount(id)
    if (disposed) {
      row.status = 'warning'
      row.message = '未提交切换请求：页面已离开'
      return
    }
    // Set the guard before IPC: even a rejected/failed response can follow a real write.
    row.needsCheck = true
    if (!persistRecords()) throw new Error('本机记录未保存，未提交订阅变更')
    submitted = true
    const result = await window.api.switchSubscriptionToFree(toPlain(account))
    if (!result.success || !result.data) throw new Error(result.error || '门户未返回切换结果')
    const data = result.data
    row.previousPlan = data.previousPlan
    row.renewal = data.renewal
    row.message = switchLabels[data.status]
    row.warning = data.warning
    row.needsCheck = data.status === 'unverified'
    row.settled = data.status !== 'unverified'
    row.status = row.needsCheck || data.warning ? 'warning' : 'success'
  } catch (error) {
    row.status = submitted ? 'warning' : 'error'
    row.message = submitted
      ? `切换请求未获确认，可能已提交：${errorText(error)}。请先只读复查；不会自动重试。`
      : `未提交切换请求：${errorText(error)}`
  }
}

async function requestSwitch(): Promise<void> {
  if (locked.value || storageError.value || !selectedSwitchable.value.length) return
  // Snapshot only selected, verified paid accounts. runBatch locks synchronously before its first await.
  const targets = selectedSwitchable.value.map((account) => account.id)
  await runBatch('switch', targets)
}
async function runBatch(mode: Operation, ids: string[]): Promise<void> {
  if (working.value || props.disabled || disposed) return
  if (mode === 'switch' && storageError.value) return
  const targets = [...new Set(ids)].filter((id) => availableAccounts.value.some((a) => a.id === id))
  if (!targets.length || (mode === 'switch' && targets.some(switchBlocked))) return
  working.value = true
  operation.value = mode
  completed.value = 0
  total.value = targets.length
  for (const id of targets) {
    results.value[id] = {
      ...results.value[id], operation: mode, status: 'pending', message: '等待顺序执行'
    }
  }
  persistRecords()
  try {
    for (let index = 0; index < targets.length; index++) {
      if (disposed) break
      const id = targets[index]
      const row = results.value[id]
      row.status = 'running'
      row.attemptedAt = Date.now()
      row.message = mode === 'check' ? '正在只读检查订阅…' : '正在提交转为 Free 请求…'
      persistRecords()
      if (mode === 'check') await checkOne(id)
      else await switchOne(id)
      row.completedAt = Date.now()
      persistRecords()
      completed.value++
      // No parallel billing requests and no automatic write retries.
      if (index < targets.length - 1 && !disposed) await new Promise((resolve) => setTimeout(resolve, 350))
    }
  } finally {
    if (disposed) {
      for (const id of targets) {
        const row = results.value[id]
        if (row.status === 'pending') {
          row.status = 'warning'
          row.message = '未执行：页面已离开，已取消剩余队列'
        }
      }
    }
    persistRecords()
    // Only completion of the actual operation releases the shared request lock.
    working.value = false
  }
}
</script>

<template>
  <section class="free-panel" aria-label="订阅管理">
    <header class="subscription-header">
      <div class="toolbar account-toolbar">
        <a-input v-model:value="search" allow-clear placeholder="搜索邮箱 / 昵称 / 账号 ID"
          class="search-input" data-testid="subscription-search" aria-label="搜索订阅账号">
          <template #prefix><SearchOutlined /></template>
        </a-input>
        <div class="toolbar-actions">
          <a-button type="primary" :disabled="locked || !availableAccounts.length" data-testid="check-all"
            @click="runBatch('check', availableAccounts.map((a) => a.id))">
            <template #icon><ReloadOutlined /></template>全部检查（{{ availableAccounts.length }}）
          </a-button>
          <a-button :disabled="locked || !selectedAccounts.length" data-testid="check-selected"
            @click="runBatch('check', selectedIds)">选中检查（{{ selectedAccounts.length }}）</a-button>
          <a-button :disabled="locked || !remainingAccounts.length" data-testid="check-remaining"
            @click="runBatch('check', remainingAccounts.map((a) => a.id))">检查未切换至 Free（{{ remainingAccounts.length }}）</a-button>
          <a-button danger :loading="working && operation === 'switch'" data-testid="switch-selected" title="点击后直接修改所选可切换账号的真实订阅，不再弹出确认窗口；可能在周期末转为 Free，不代表退款"
            :disabled="locked || !!storageError || !selectedSwitchable.length" @click="requestSwitch">
            切换选中至 Free（{{ selectedSwitchable.length }}）
          </a-button>
        </div>
      </div>
      <div class="meta-bar">
        <a-checkbox :checked="allSelected" :indeterminate="visibleSelectedCount > 0 && !allSelected"
          :disabled="locked || !visibleAccounts.length" data-testid="select-all"
          @change="(event: CheckboxChangeEvent) => toggleAll(event.target.checked)">全选{{ listFiltered ? '筛选结果' : '' }}</a-checkbox>
        <span class="count-text">{{ listFiltered ? '显示 ' + visibleAccounts.length + ' / ' : '共 ' }}{{ availableAccounts.length }} 个账号</span>
        <template v-if="selectedAccounts.length">
          <span class="count-text">已选 {{ selectedAccounts.length }}<span v-if="selectedAccounts.length > visibleSelectedCount">（隐藏 {{ selectedAccounts.length - visibleSelectedCount }}）</span></span>
          <a-button type="link" size="small" :disabled="locked" data-testid="clear-selection" @click="selectedIds = []">清空</a-button>
        </template>
        <a-divider type="vertical" style="margin: 0 2px" />
        <a-tag v-if="uncheckedCount" :bordered="false">未检查 {{ uncheckedCount }}</a-tag>
        <a-tag color="green" :bordered="false">Free / 已安排 {{ availableAccounts.length - remainingAccounts.length }}</a-tag>
        <a-tag v-if="needsCheckCount" color="orange" :bordered="false">待复核 {{ needsCheckCount }}</a-tag>
        <span class="toolbar-spacer" />
        <div class="filter-controls">
          <div class="filter-item">
            <span class="muted">当前订阅</span>
            <a-select v-model:value="planFilter" :options="subscriptionPlanOptions" size="small"
              class="plan-filter" data-testid="subscription-plan-filter" aria-label="按当前订阅类型筛选" />
          </div>
          <div class="filter-item">
            <span class="muted">续费安排</span>
            <a-select v-model:value="arrangementFilter" :options="subscriptionArrangementOptions" size="small"
              class="arrangement-filter" data-testid="subscription-arrangement-filter" aria-label="按续费安排筛选" />
          </div>
          <a-button v-if="activeFilterCount" type="link" size="small" data-testid="reset-filters" @click="resetFilters">重置筛选</a-button>
        </div>
        <a-tooltip placement="bottomRight" title="检查为只读操作。全部检查、检查未切换至 Free 均覆盖全部账号，不受搜索或筛选限制；后者跳过已确认 Free / 已安排转 Free，仍检查未检查、失败、待复核及仅取消续费的账号。订阅类型优先使用最近门户套餐，无结果时参考本地套餐；续费安排按已记录状态筛选，待复核单独归类。失败时保留的旧快照仅供参考。每次检查状态在本机保存，重启后保留。点击切换将直接修改真实订阅，不再弹出确认窗口，仅处理检查确认可切换的付费账号；安排周期末转 Free 不会伪改当前套餐。">
          <a-button type="text" size="small"><template #icon><InfoCircleOutlined /></template>操作说明</a-button>
        </a-tooltip>
      </div>
      <p v-if="selectedSkippedCount" class="selection-note muted">所选 {{ selectedSkippedCount }} 个账号未检查、待复核或已处理，切换时自动跳过。</p>
      <a-alert v-if="storageError" type="error" show-icon class="storage-alert" :message="storageError" />
      <div v-if="working" class="batch-progress" aria-live="polite">
        <span class="muted">{{ operation === 'check' ? '正在检查订阅' : '正在切换至 Free' }} · {{ completed }} / {{ total }} · 顺序执行</span>
        <a-progress :percent="Math.round(completed / total * 100)" size="small" />
      </div>
    </header>

    <VirtualList v-if="visibleAccounts.length" ref="contentRef" class="account-list" :items="visibleAccounts"
      :item-key="accountItemKey" :row-height="88" :buffer-rows="8">
      <template #default="{ item: account }">
        <article class="account-row" :class="{ 'is-selected': selectedSet.has(account.id) }" :data-account-id="account.id"
          @click="toggleAccount(account.id, !selectedSet.has(account.id))">
          <div class="select-cell">
            <a-checkbox :checked="selectedSet.has(account.id)" :disabled="locked" @click.stop
              :aria-label="'选择 ' + displayEmail(account.email, settingsStore.settings.privacyMode)"
              @change="(event: CheckboxChangeEvent) => toggleAccount(account.id, event.target.checked)" />
          </div>
          <div class="identity-cell">
            <strong class="email" :title="displayEmail(account.email, settingsStore.settings.privacyMode)">{{ displayEmail(account.email, settingsStore.settings.privacyMode) || displayName(account, settingsStore.settings.privacyMode) || '未命名账号' }}</strong>
            <span class="muted small ellipsis">{{ account.nickname ? displayName(account, settingsStore.settings.privacyMode) + ' · ' : '' }}{{ account.idp }}</span>
            <span v-if="results[account.id]?.status === 'error' || results[account.id]?.status === 'warning' || results[account.id]?.needsCheck"
              class="row-error small ellipsis" :title="resultHint(account.id)">{{ resultHint(account.id) }}</span>
          </div>
          <div class="detail-cell plan-cell">
            <span class="muted small">{{ results[account.id]?.renewal ? results[account.id].status === 'success' ? '当前套餐' : '上次确认套餐' : '本地套餐 · 未确认' }}</span>
            <span class="plan-name ellipsis" :title="results[account.id]?.renewal?.planName || account.subscription.title || account.subscription.type">{{ results[account.id]?.renewal?.planName || account.subscription.title || account.subscription.type }}</span>
          </div>
          <div class="detail-cell renewal-cell">
            <span class="muted small">续费安排</span>
            <a-tag v-if="results[account.id]?.renewal" :bordered="false"
              :color="results[account.id].status !== 'success' ? 'default' : results[account.id].renewal!.state === 'free' ? 'green' : results[account.id].renewal!.state === 'paid' ? 'blue' : 'orange'"
              :title="resultHint(account.id)">{{ stateLabels[results[account.id].renewal!.state] }}</a-tag>
            <span v-else class="muted small">尚未确认</span>
            <span v-if="results[account.id]?.renewal?.transitionAt" class="muted small" :title="formatTime(results[account.id].renewal!.transitionAt)">预计 {{ shortDate(results[account.id].renewal!.transitionAt) }}</span>
            <span v-else-if="results[account.id]?.renewal?.currentPeriodEnd" class="muted small" :title="formatTime(results[account.id].renewal!.currentPeriodEnd)">周期至 {{ shortDate(results[account.id].renewal!.currentPeriodEnd) }}</span>
          </div>
          <div class="detail-cell check-cell" :title="resultHint(account.id)">
            <div class="status-tags">
              <a-tag v-if="results[account.id]" :color="rowColors[results[account.id].status]" :bordered="false">{{ rowLabels[results[account.id].status] }}</a-tag>
              <a-tag v-else :bordered="false">未检查</a-tag>
              <a-tag v-if="results[account.id]?.needsCheck" color="orange" :bordered="false">待复核</a-tag>
            </div>
            <span class="muted small">最近检查</span>
            <time class="muted small">{{ results[account.id]?.lastCheckAt ? formatTime(results[account.id].lastCheckAt) : '尚未检查' }}</time>
          </div>
          <div class="row-actions" @click.stop>
            <a-button size="small" :disabled="locked" @click="runBatch('check', [account.id])">检查</a-button>
          </div>
        </article>
      </template>
    </VirtualList>
    <div v-else class="grid-placeholder">
      <a-empty :description="availableAccounts.length ? '没有匹配的账号' : '暂无账号，请先在账户管理中添加'" />
    </div>
  </section>

</template>

<style scoped>
/* Match account management: fixed two-row toolbar and a full-height, independently scrolling list. */
.free-panel { display: flex; flex-direction: column; height: 100%; min-height: 0; }
.subscription-header { flex: 0 0 auto; background: var(--kal-body-bg); }
.account-toolbar { display: flex; flex-wrap: wrap; gap: 10px; align-items: flex-start; justify-content: space-between; margin-bottom: 10px; }
.search-input { flex: 1 1 220px; width: auto; min-width: 200px; max-width: 360px; }
.account-toolbar :deep(.ant-input-affix-wrapper), .account-toolbar :deep(.ant-btn) { height: 34px; font-size: 13px; }
.account-toolbar :deep(.ant-btn) { padding-inline: 12px; }
.toolbar-actions { display: flex; flex: 0 1 auto; flex-wrap: wrap; justify-content: flex-end; gap: 8px; }
.meta-bar { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; min-height: 30px; margin-bottom: 12px; font-size: 13px; }
.meta-bar :deep(.ant-btn-sm) { height: 28px; padding-inline: 10px; }
.meta-bar :deep(.ant-tag) { line-height: 24px; }
.count-text { color: var(--kal-muted); white-space: nowrap; }
.toolbar-spacer { flex: 1; }
.filter-controls, .filter-item { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.filter-item { flex-wrap: nowrap; white-space: nowrap; }
.plan-filter { width: 110px; }
.arrangement-filter { width: 166px; }
.filter-controls :deep(.ant-select-sm) { height: 28px; font-size: 12px; }
.selection-note { margin: -4px 0 10px; font-size: 12px; }
.storage-alert { margin-bottom: 12px; }
.batch-progress { display: flex; align-items: center; gap: 16px; margin: 0 0 10px; font-size: 12px; }
.batch-progress > span { white-space: nowrap; }
.batch-progress :deep(.ant-progress) { flex: 1; margin: 0; }
.account-list { flex: 1 1 auto; min-height: 0; border: 1px solid var(--kal-border); border-radius: 12px; background: var(--kal-card-bg); }
.account-row { display: grid; grid-template-columns: 28px minmax(200px, 1.6fr) minmax(120px, 1fr) minmax(150px, 1.1fr) 155px 60px; align-items: center; gap: 8px; width: 100%; min-width: 792px; height: 100%; padding: 7px 10px; box-sizing: border-box; border-bottom: 1px solid var(--kal-border); cursor: pointer; }
.account-row:hover { background: var(--kal-block-bg); }
.account-row.is-selected { background: color-mix(in srgb, var(--kal-primary) 8%, var(--kal-card-bg)); }
.select-cell { display: flex; align-items: center; justify-content: center; }
.identity-cell, .detail-cell { display: flex; flex-direction: column; align-items: flex-start; gap: 3px; min-width: 0; }
.email { max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; font-weight: 600; }
.ellipsis { max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.plan-name { font-size: 13px; font-weight: 500; }
.row-error { color: #d46b08; }
.detail-cell :deep(.ant-tag) { margin-inline-end: 0; font-size: 11px; line-height: 18px; }
.status-tags { display: flex; align-items: center; gap: 4px; }
.row-actions :deep(.ant-btn-sm) { height: 28px; font-size: 12px; padding-inline: 10px; }
.grid-placeholder { flex: 1 1 auto; min-height: 0; display: grid; place-items: center; }
.muted { color: var(--kal-muted); }
.small { font-size: 11px; }
@media (max-width: 1100px) {
  .search-input { max-width: none; }
  .toolbar-actions { justify-content: flex-start; }
}
</style>
