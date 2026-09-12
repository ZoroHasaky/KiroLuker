<script lang="ts">
import { ref as sessionRef } from 'vue'
import type { SubscriptionRenewalInfo, SwitchSubscriptionToFreeResult } from '@shared/subscriptionFree'
import {
  canSwitchSubscription, loadSubscriptionRecords, saveSubscriptionRecords,
  type SubscriptionOperation as Operation, type SubscriptionRecords, type SubscriptionRowStatus as RowStatus
} from '@/utils/subscriptionRecords'

let savedRecords: SubscriptionRecords = Object.create(null)
let initialStorageError = ''
try { savedRecords = loadSubscriptionRecords(localStorage) }
catch { initialStorageError = '无法读取本机订阅记录，请先检查本机存储；未确认的账号不会重复提交。' }

const freeSession = {
  working: sessionRef(false),
  operation: sessionRef<Operation>('switch'),
  completed: sessionRef(0),
  total: sessionRef(0),
  results: sessionRef<SubscriptionRecords>(savedRecords),
  storageError: sessionRef(initialStorageError)
}
</script>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { message } from 'ant-design-vue'
import type { Account, IpcResult } from '@shared/types'
import { useAccountsStore } from '@/stores/accounts'
import { toPlain } from '@/utils/ipc'
import { formatCredits } from '@/utils/format'
import { useSettingsStore } from '@/stores/settings'
import { isSubscriptionAuthError } from '@shared/subscriptionBatch'

const props = defineProps<{ accounts: Account[]; disabled?: boolean }>()
const accountsStore = useAccountsStore()
const settingsStore = useSettingsStore()
const precision = computed(() => settingsStore.settings.usagePrecision)
const selectedIds = ref<string[]>([])
const search = ref('')
const { working, operation, completed, total, results, storageError } = freeSession
let disposed = false

const availableAccounts = computed(() => [...new Map(props.accounts.map((a) => [a.id, a])).values()])
function isFreeTier(account: Account): boolean {
  const type = account.subscription.type.toUpperCase()
  const title = (account.subscription.title || '').toUpperCase()
  return type === 'FREE' || title.includes('FREE')
}
function isPendingCandidate(account: Account): boolean {
  if (!account.credentials.accessToken && !account.credentials.refreshToken) return false
  if (account.status === 'banned' || account.status === 'expired') return false
  // 只有 Free 账号的已用额度会阻止提链/切换预检；付费账号即使已有用量，门户仍可能允许切换至 Free。
  if (isFreeTier(account)) return false
  const record = results.value[account.id]
  if (record?.needsCheck) return false
  const state = record?.renewal?.state
  return state !== 'free' && state !== 'scheduled-free' && state !== 'canceling'
}
const pendingAccounts = computed(() => {
  const query = search.value.trim().toLowerCase()
  return availableAccounts.value.filter((account) => isPendingCandidate(account)).filter((account) => {
    if (!query) return true
    return [account.email, account.nickname, account.id].some((value) => value?.toLowerCase().includes(query))
  })
})
const selectedSet = computed(() => new Set(selectedIds.value))
const selectedAccounts = computed(() => pendingAccounts.value.filter((a) => selectedSet.value.has(a.id)))
const allSelected = computed(() => pendingAccounts.value.length > 0 && selectedAccounts.value.length === pendingAccounts.value.length)
const locked = computed(() => !!props.disabled || working.value || !!storageError.value)
const visibleSelectedCount = computed(() => selectedAccounts.value.length)
const completedCount = computed(() => completed.value)
const stateLabels: Record<SubscriptionRenewalInfo['state'], string> = {
  paid: '付费订阅', free: '门户已为 Free', 'scheduled-free': '已安排转为 Free', canceling: '取消中（尚非 Free）'
}
const switchLabels: Record<SwitchSubscriptionToFreeResult['status'], string> = {
  'already-free': '门户已为 Free，无需修改',
  'already-scheduled': '已安排转为 Free，无需重复提交',
  'wont-renew': '已停止续费，请以门户显示的生效时间为准',
  switched: '门户确认已转为 Free',
  scheduled: '已安排转为 Free，可能在当前计费周期结束后生效',
  unverified: '已提交切换请求，但结果不确定；请先只读复查，勿重复提交'
}
const rowColors: Record<RowStatus, string> = { pending: 'default', running: 'processing', success: 'green', warning: 'orange', error: 'red' }
const rowLabels: Record<RowStatus, string> = { pending: '等待', running: '执行中', success: '完成', warning: '需关注', error: '失败' }

watch(() => availableAccounts.value.map((a) => a.id), (ids) => {
  const allowed = new Set(ids)
  selectedIds.value = selectedIds.value.filter((id) => allowed.has(id))
})
watch(() => pendingAccounts.value.map((a) => a.id), (ids) => {
  const allowed = new Set(ids)
  selectedIds.value = selectedIds.value.filter((id) => allowed.has(id))
})
onBeforeUnmount(() => { disposed = true })

function errorText(error: unknown): string { return error instanceof Error ? error.message : String(error) }
function persistRecords(): boolean {
  try { saveSubscriptionRecords(localStorage, results.value); storageError.value = ''; return true }
  catch { storageError.value = '本机订阅记录保存失败，暂不允许提交切Free，请先检查磁盘或存储权限。'; return false }
}
function toggleAll(checked: boolean): void {
  if (locked.value) return
  selectedIds.value = checked ? pendingAccounts.value.map((a) => a.id) : []
}
function toggleAccount(id: string, checked: boolean): void {
  if (locked.value) return
  const next = new Set(selectedIds.value)
  if (checked) next.add(id); else next.delete(id)
  selectedIds.value = [...next]
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
  if (!account.credentials.accessToken || account.credentials.expiresAt <= Date.now() + 60_000) return { account: await refreshAccount(id), refreshed: true }
  return { account, refreshed: false }
}

async function checkOne(id: string): Promise<void> {
  const row = results.value[id] ?? (results.value[id] = { status: 'pending', message: '等待检查' })
  try {
    const prepared = await prepareAccount(id)
    if (disposed) return
    let result: IpcResult<SubscriptionRenewalInfo> = await window.api.checkSubscriptionRenewal(toPlain(prepared.account))
    if (!result.success && !prepared.refreshed && isSubscriptionAuthError(result.error)) {
      const refreshed = await refreshAccount(id)
      if (disposed) return
      result = await window.api.checkSubscriptionRenewal(toPlain(refreshed))
    }
    if (!result.success || !result.data) throw new Error(result.error || '门户未返回续费信息')
    row.renewal = result.data
    row.status = 'success'
    row.message = `只读检查完成：${stateLabels[result.data.state]}`
    row.needsCheck = false
    row.settled = result.data.state !== 'paid'
    row.warning = undefined
  } catch (error) {
    row.status = 'error'
    row.message = `只读检查失败：${errorText(error)}`
  } finally { row.lastCheckAt = Date.now() }
}

async function switchOne(id: string): Promise<void> {
  const row = results.value[id] ?? (results.value[id] = { status: 'pending', message: '等待切换' })
  let submitted = false
  try {
    // 用户点击“切Free”时自动完成一次只读核验；只有确认仍为 paid 才提交真实变更。
    if (!canSwitchSubscription(row)) {
      await checkOne(id)
      if (!canSwitchSubscription(row)) return
    }
    const { account } = await prepareAccount(id)
    if (disposed) return
    row.needsCheck = true
    if (!persistRecords()) throw new Error('本机记录未保存，未提交订阅变更')
    submitted = true
    const result = await window.api.switchSubscriptionToFree(toPlain(account))
    if (!result.success || !result.data) {
      // 主进程已将不确定结果包装为 data.status=unverified；普通失败可安全重试，
      // 不要让这类失败因为前置 guard 永久消失在“待切Free”列表里。
      row.status = 'error'
      row.message = `未提交切换请求：${result.error || '门户未返回切换结果'}`
      row.needsCheck = false
      row.settled = false
      return
    }
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
    row.message = submitted ? `切换请求未获确认，可能已提交：${errorText(error)}。请先只读复查；不会自动重试。` : `未提交切换请求：${errorText(error)}`
  }
}

async function requestSwitch(): Promise<void> {
  if (locked.value || !selectedAccounts.value.length) return
  const targets = selectedAccounts.value.map((account) => account.id)
  await runBatch(targets)
}
async function runBatch(ids: string[]): Promise<void> {
  if (working.value || props.disabled || disposed || storageError.value) return
  const targets = [...new Set(ids)].filter((id) => pendingAccounts.value.some((a) => a.id === id))
  if (!targets.length) return
  working.value = true
  operation.value = 'switch'
  completed.value = 0
  total.value = targets.length
  for (const id of targets) results.value[id] = { ...results.value[id], operation: 'switch', status: 'pending', message: '等待顺序执行' }
  persistRecords()
  try {
    for (let index = 0; index < targets.length; index++) {
      if (disposed) break
      const id = targets[index]
      const row = results.value[id]
      row.status = 'running'; row.attemptedAt = Date.now(); row.message = '正在核验并提交转为 Free 请求…'
      persistRecords()
      await switchOne(id)
      row.completedAt = Date.now(); persistRecords(); completed.value++
      if (index < targets.length - 1 && !disposed) await new Promise((resolve) => setTimeout(resolve, 350))
    }
  } finally {
    persistRecords()
    working.value = false
  }
}
function resultText(id: string): string {
  const row = results.value[id]
  return row ? [row.message, row.warning].filter(Boolean).join(' · ') : '点击按钮后自动检查并切换'
}
</script>

<template>
  <section class="free-panel" aria-label="切Free">
    <header class="subscription-header">
      <div class="panel-title">
        <div>
          <h2 class="section-title">切Free</h2>
          <p class="muted header-hint">仅显示当前非 Free 且尚未切换的账号；已降级 Free 的账号不再显示。勾选后点击按钮，系统会先核验再提交。</p>
        </div>
        <a-tag color="orange">待切Free {{ pendingAccounts.length }}</a-tag>
      </div>
      <div class="toolbar account-toolbar">
        <a-input v-model:value="search" allow-clear placeholder="搜索邮箱 / 昵称 / 账号 ID" class="search-input" />
        <a-button danger :loading="working" data-testid="switch-selected" :disabled="locked || !selectedAccounts.length" @click="requestSwitch">切Free（{{ selectedAccounts.length }}）</a-button>
      </div>
    </header>

    <a-alert v-if="storageError" type="error" show-icon :message="storageError" />
    <div class="meta-bar">
      <a-checkbox :checked="allSelected" :indeterminate="visibleSelectedCount > 0 && !allSelected" :disabled="locked || !pendingAccounts.length" data-testid="select-all" @change="(event: any) => toggleAll(event.target.checked)">
        全选
      </a-checkbox>
      <span class="count-text">显示 {{ pendingAccounts.length }} 个待切Free账号</span>
      <span v-if="selectedAccounts.length" class="count-text">已选 {{ selectedAccounts.length }}</span>
      <a-button v-if="selectedIds.length" type="link" size="small" :disabled="locked" @click="selectedIds = []">清空</a-button>
      <span class="toolbar-spacer" />
      <span class="muted">排除：已降级 Free、已确认切换及结果不确定的账号</span>
    </div>

    <div v-if="pendingAccounts.length" class="account-list">
      <div v-for="account in pendingAccounts" :key="account.id" class="account-row" :data-account-id="account.id">
        <a-checkbox :checked="selectedSet.has(account.id)" :disabled="locked" @change="(event: any) => toggleAccount(account.id, event.target.checked)" />
        <div class="account-main">
          <strong>{{ account.email || account.nickname || '未命名账号' }}</strong>
          <span class="muted">{{ account.nickname || account.subscription.title || account.subscription.type }}</span>
          <span class="account-usage">总额度 {{ formatCredits(account.usage.limit, precision) }} · 已用 {{ formatCredits(account.usage.current, precision) }}</span>
        </div>
        <span class="muted">{{ resultText(account.id) }}</span>
        <a-tag v-if="results[account.id]" :color="rowColors[results[account.id].status]">{{ rowLabels[results[account.id].status] }}</a-tag>
      </div>
    </div>
    <a-empty v-else description="没有待切Free账号" />

    <a-progress v-if="working || total" :percent="total ? Math.round(completedCount / total * 100) : 0" :status="working ? 'active' : undefined" :format="() => `${completedCount}/${total}`" />
  </section>
</template>

<style scoped>
.free-panel { display: flex; flex-direction: column; gap: 12px; height: 100%; min-height: 0; overflow: auto; padding-bottom: 8px; }
.subscription-header, .panel-title, .toolbar, .meta-bar, .account-row { display: flex; align-items: center; gap: 10px; }
.subscription-header { justify-content: space-between; flex-wrap: wrap; }
.panel-title { align-items: flex-start; justify-content: space-between; flex: 1 1 auto; min-width: 280px; }
.section-title { margin: 0 0 4px; }
.header-hint { margin: 0; font-size: 12px; }
.account-toolbar { flex: 0 1 auto; justify-content: flex-end; flex-wrap: wrap; }
.search-input { width: 260px; }
.meta-bar { flex-wrap: wrap; min-height: 32px; padding: 6px 0; }
.count-text { font-size: 12px; color: var(--kal-muted); }
.toolbar-spacer { flex: 1 1 auto; }
.account-list { display: flex; flex-direction: column; gap: 6px; overflow: auto; }
.account-row { padding: 10px 12px; border: 1px solid var(--kal-border); border-radius: 8px; }
.account-main { display: flex; flex: 1 1 240px; flex-direction: column; gap: 3px; min-width: 0; }
.account-main strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.account-usage { color: var(--kal-text); font-size: 12px; }
.account-row > .muted { max-width: 46%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; }
@media (max-width: 720px) { .subscription-header { align-items: stretch; } .account-toolbar, .search-input { width: 100%; } .account-row { align-items: flex-start; flex-wrap: wrap; } .account-row > .muted { max-width: 100%; width: 100%; padding-left: 28px; } }
</style>
