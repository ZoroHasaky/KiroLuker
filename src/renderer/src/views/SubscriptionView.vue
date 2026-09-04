<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import {
  CheckCircleOutlined,
  CopyOutlined,
  CreditCardOutlined,
  ExclamationCircleOutlined,
  ExportOutlined,
  LinkOutlined,
  QrcodeOutlined,
  ReloadOutlined
} from '@ant-design/icons-vue'
import { message } from 'ant-design-vue'
import { useAccountsStore } from '@/stores/accounts'
import { useSettingsStore } from '@/stores/settings'
import { toPlain } from '@/utils/ipc'
import {
  classifySubscriptionEligibility,
  isPaidSubscriptionPlan,
  isSubscriptionAuthError,
  isUnsuitableFreeReason,
  preferredSubscriptionPlan,
  type SubscriptionEligibilityReason
} from '@shared/subscriptionBatch'
import type {
  Account,
  IpcResult,
  KiroSubscriptionPlan,
  SubscriptionLinkResult,
  SubscriptionPlansResult
} from '@shared/types'

type LinkStatus = 'pending' | 'loading' | 'success' | 'error'

interface LinkRow {
  accountId: string
  email: string
  status: LinkStatus
  url?: string
  upstreamStatus?: string
  error?: string
  generatedAt?: number
}

const accountsStore = useAccountsStore()
const settingsStore = useSettingsStore()

const useAllAccounts = ref(false)
const excludeUnsuitableFree = ref(
  localStorage.getItem('subscription-exclude-unsuitable-free') !== 'off'
)
const selectedAccountIds = ref<string[]>([])
const plans = ref<KiroSubscriptionPlan[]>([])
const selectedPlanType = ref('')
const disclaimer = ref<string[]>([])
const loadingPlans = ref(false)
const running = ref(false)
const concurrency = ref(2)
const rows = ref<LinkRow[]>([])
const selectedResultIds = ref<string[]>([])
const qrRow = ref<LinkRow | null>(null)

watch(excludeUnsuitableFree, (value) => {
  localStorage.setItem('subscription-exclude-unsuitable-free', value ? 'on' : 'off')
})

const sourceAccounts = computed(() => {
  if (accountsStore.selectedIds.length && !useAllAccounts.value) {
    const ids = new Set(accountsStore.selectedIds)
    return accountsStore.accounts.filter((account) => ids.has(account.id))
  }
  return accountsStore.accounts
})

const classifiedAccounts = computed(() =>
  sourceAccounts.value.map((account) => ({
    account,
    check: classifySubscriptionEligibility(account)
  }))
)

function effectiveEligible(reason: SubscriptionEligibilityReason, eligible: boolean): boolean {
  return eligible || (!excludeUnsuitableFree.value && isUnsuitableFreeReason(reason))
}

const eligibleAccounts = computed(() =>
  classifiedAccounts.value
    .filter(({ check }) => effectiveEligible(check.reason, check.eligible))
    .map(({ account }) => account)
)

const blockedAccounts = computed(() =>
  classifiedAccounts.value.filter(
    ({ check }) => !effectiveEligible(check.reason, check.eligible)
  )
)

const reasonText: Record<SubscriptionEligibilityReason, string> = {
  ok: '可订阅',
  'no-credentials': '缺少凭证',
  'already-paid': '已订阅',
  banned: '已封禁',
  expired: '凭证失效',
  'cannot-upgrade': '不可升级',
  'unknown-tier': '档位未知',
  'downgraded-free': '有订阅历史',
  'used-free': '已使用积分'
}

const blockedStats = computed(() => {
  const counts = new Map<SubscriptionEligibilityReason, number>()
  for (const { check } of blockedAccounts.value) {
    counts.set(check.reason, (counts.get(check.reason) || 0) + 1)
  }
  return [...counts.entries()].map(([reason, count]) => ({ reason, count }))
})

let selectionInitialized = false
watch(
  () => eligibleAccounts.value.map((account) => account.id),
  (ids, previous = []) => {
    const current = new Set(selectedAccountIds.value)
    const previouslyAll = previous.length > 0 && previous.every((id) => current.has(id))
    const firstAccountsLoaded = previous.length === 0 && current.size === 0 && ids.length > 0
    if (!selectionInitialized || previouslyAll || firstAccountsLoaded) {
      selectedAccountIds.value = [...ids]
      selectionInitialized = true
      return
    }
    const allowed = new Set(ids)
    selectedAccountIds.value = selectedAccountIds.value.filter((id) => allowed.has(id))
  },
  { immediate: true }
)

watch(useAllAccounts, () => {
  selectedAccountIds.value = eligibleAccounts.value.map((account) => account.id)
  selectionInitialized = true
})

const selectedAccountSet = computed(() => new Set(selectedAccountIds.value))
const selectedAccounts = computed(() =>
  eligibleAccounts.value.filter((account) => selectedAccountSet.value.has(account.id))
)
const allEligibleSelected = computed(
  () =>
    eligibleAccounts.value.length > 0 &&
    eligibleAccounts.value.every((account) => selectedAccountSet.value.has(account.id))
)
const someEligibleSelected = computed(
  () => selectedAccountIds.value.length > 0 && !allEligibleSelected.value
)

function toggleAllAccounts(checked: boolean): void {
  selectedAccountIds.value = checked ? eligibleAccounts.value.map((account) => account.id) : []
}

function toggleAccount(accountId: string, checked: boolean): void {
  const next = new Set(selectedAccountIds.value)
  if (checked) next.add(accountId)
  else next.delete(accountId)
  selectedAccountIds.value = [...next]
}

async function callWithTokenRefresh<T>(
  accountId: string,
  invoke: (account: Account) => Promise<IpcResult<T>>
): Promise<IpcResult<T>> {
  let account = accountsStore.get(accountId)
  if (!account) return { success: false, error: '账号不存在' }

  if (!account.credentials.accessToken || account.credentials.expiresAt <= Date.now() + 60_000) {
    const refreshed = await accountsStore.refreshToken(accountId)
    if (!refreshed.ok) return { success: false, error: refreshed.error || 'Token 刷新失败' }
    account = accountsStore.get(accountId)
    if (!account) return { success: false, error: '账号不存在' }
  }

  let result = await invoke(toPlain(account))
  if (!result.success && isSubscriptionAuthError(result.error)) {
    const refreshed = await accountsStore.refreshToken(accountId)
    if (!refreshed.ok) return result
    account = accountsStore.get(accountId)
    if (!account) return { success: false, error: '账号不存在' }
    result = await invoke(toPlain(account))
  }
  return result
}

async function loadPlans(): Promise<void> {
  const account = selectedAccounts.value[0]
  if (!account) return void message.info('请先选择至少一个可订阅账号')

  loadingPlans.value = true
  try {
    const result = await callWithTokenRefresh<SubscriptionPlansResult>(account.id, (current) =>
      window.api.getSubscriptionPlans(current)
    )
    if (!result.success || !result.data) {
      return void message.error(`读取订阅计划失败：${result.error || '未知错误'}`)
    }
    const paidPlans = result.data.plans.filter(isPaidSubscriptionPlan)
    if (!paidPlans.length) return void message.warning('Kiro 当前没有返回可购买的付费计划')
    plans.value = paidPlans
    selectedPlanType.value = preferredSubscriptionPlan(paidPlans)?.qSubscriptionType || ''
    disclaimer.value = result.data.disclaimer || []
    message.success(`已读取 ${paidPlans.length} 个可用计划`)
  } finally {
    loadingPlans.value = false
  }
}

function planLabel(plan: KiroSubscriptionPlan): string {
  const amount = (plan.pricing.amount / 100).toFixed(2)
  const interval = plan.description.billingInterval
  return `${plan.description.title} · ${plan.pricing.currency} ${amount}${interval ? ` / ${interval}` : ''}`
}

const currentPlan = computed(() =>
  plans.value.find((plan) => plan.qSubscriptionType === selectedPlanType.value)
)

function updateRow(accountId: string, patch: Partial<LinkRow>): void {
  rows.value = rows.value.map((row) =>
    row.accountId === accountId ? { ...row, ...patch } : row
  )
}

async function generateOne(accountId: string): Promise<void> {
  updateRow(accountId, { status: 'loading', error: undefined })
  const result = await callWithTokenRefresh<SubscriptionLinkResult>(accountId, (account) =>
    window.api.createSubscriptionLink(account, selectedPlanType.value)
  )
  if (!result.success || !result.data) {
    updateRow(accountId, {
      status: 'error',
      error: result.error || '生成订阅链接失败'
    })
    return
  }
  updateRow(accountId, {
    status: 'success',
    url: result.data.url,
    upstreamStatus: result.data.status,
    generatedAt: Date.now(),
    error: undefined
  })
  if (!selectedResultIds.value.includes(accountId)) {
    selectedResultIds.value = [...selectedResultIds.value, accountId]
  }
}

function jitterDelay(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 100 + Math.random() * 100))
}

async function generateBatch(): Promise<void> {
  if (!selectedPlanType.value) return void message.info('请先读取并选择订阅计划')
  const targets = [...selectedAccounts.value]
  if (!targets.length) return void message.info('请先选择至少一个可订阅账号')

  rows.value = targets.map((account) => ({
    accountId: account.id,
    email: account.email,
    status: 'pending'
  }))
  selectedResultIds.value = []
  running.value = true

  let cursor = 0
  const worker = async (): Promise<void> => {
    while (cursor < targets.length) {
      const index = cursor++
      const account = targets[index]
      if (!account) continue
      await generateOne(account.id)
      if (cursor < targets.length) await jitterDelay()
    }
  }

  try {
    const workerCount = Math.min(Math.max(1, concurrency.value), targets.length)
    await Promise.all(Array.from({ length: workerCount }, () => worker()))
    const failed = rows.value.filter((row) => row.status === 'error').length
    const success = rows.value.filter((row) => row.status === 'success').length
    if (failed) message.warning(`批量订阅链接生成完成：成功 ${success}，失败 ${failed}`)
    else message.success(`已生成 ${success} 个订阅链接`)
  } finally {
    running.value = false
  }
}

async function regenerate(row: LinkRow): Promise<void> {
  if (!selectedPlanType.value) return void message.info('请先选择订阅计划')
  await generateOne(row.accountId)
}

const successfulRows = computed(() =>
  rows.value.filter((row): row is LinkRow & { url: string } => row.status === 'success' && !!row.url)
)
const selectedResultSet = computed(() => new Set(selectedResultIds.value))
const selectedSuccessfulRows = computed(() =>
  successfulRows.value.filter((row) => selectedResultSet.value.has(row.accountId))
)
const completedCount = computed(
  () => rows.value.filter((row) => row.status === 'success' || row.status === 'error').length
)
const progressPercent = computed(() =>
  rows.value.length ? Math.round((completedCount.value / rows.value.length) * 100) : 0
)

function toggleResult(accountId: string, checked: boolean): void {
  const next = new Set(selectedResultIds.value)
  if (checked) next.add(accountId)
  else next.delete(accountId)
  selectedResultIds.value = [...next]
}

function toggleAllResults(checked: boolean): void {
  selectedResultIds.value = checked ? successfulRows.value.map((row) => row.accountId) : []
}

function copyLink(url: string): void {
  window.api.writeClipboard(url)
  message.success('订阅链接已复制')
}

function copyRows(targets: Array<LinkRow & { url: string }>, label: string): void {
  if (!targets.length) return void message.info('没有可复制的订阅链接')
  window.api.writeClipboard(targets.map((row) => row.url).join('\n'))
  message.success(`${label}已复制，共 ${targets.length} 条`)
}

async function openPrivate(url: string): Promise<boolean> {
  const browserOptions = {
    privateMode: true,
    requirePrivate: true,
    browserPath: settingsStore.settings.privateBrowserPath || undefined
  }
  let result = await window.api.openExternal(url, browserOptions)
  if (result.success) return true
  if (!result.error?.includes('PRIVATE_BROWSER_REQUIRED')) {
    message.error(result.error || '无痕打开失败')
    return false
  }

  const selection = await window.api.choosePrivateBrowser()
  if (!selection.success || !selection.data?.selected || !selection.data.path) {
    message.warning(selection.error || '未选择浏览器，已取消打开')
    return false
  }
  await settingsStore.update({ privateBrowserPath: selection.data.path })
  result = await window.api.openExternal(url, {
    ...browserOptions,
    browserPath: selection.data.path
  })
  if (!result.success) message.error(result.error || '无痕打开失败')
  return result.success
}

async function openRows(targets: Array<LinkRow & { url: string }>): Promise<void> {
  if (!targets.length) return void message.info('没有可打开的订阅链接')
  let success = 0
  for (const row of targets) {
    if (await openPrivate(row.url)) success++
    else break
  }
  if (success) message.success(`已无痕打开 ${success} 个订阅链接`)
}
</script>

<template>
  <div class="subscription-page">
    <div class="page-header">
      <div>
        <h2><CreditCardOutlined /> 批量订阅</h2>
        <p>批量获取 Kiro 官方订阅计划，并为 Free 账号生成 Stripe 支付链接。</p>
      </div>
      <a-tag color="blue" :bordered="false">链接由 Kiro 官方接口生成</a-tag>
    </div>

    <a-alert
      type="warning"
      show-icon
      message="这里只生成订阅支付链接，不会自动扣款"
      description="支付链接通常具有时效性，请生成后尽快复制、扫码或在无痕窗口中打开。"
    />

    <div class="setup-grid">
      <a-card size="small" title="1. 账号预检" class="setup-card">
        <template #extra>
          <a-tag color="green">可订阅 {{ eligibleAccounts.length }}</a-tag>
        </template>

        <div class="option-row">
          <span>
            {{ accountsStore.selectedIds.length && !useAllAccounts
              ? `沿用账户管理已选的 ${accountsStore.selectedIds.length} 个账号`
              : `检查全部 ${accountsStore.accounts.length} 个账号` }}
          </span>
          <a-switch
            v-if="accountsStore.selectedIds.length"
            v-model:checked="useAllAccounts"
            checked-children="全部账号"
            un-checked-children="已选账号"
          />
        </div>

        <div class="option-row">
          <div>
            <div>排除不适合订阅的 Free 账号</div>
            <div class="muted small">默认排除已用积分或存在历史订阅记录的账号</div>
          </div>
          <a-switch v-model:checked="excludeUnsuitableFree" />
        </div>

        <div v-if="blockedStats.length" class="blocked-tags">
          <a-tag v-for="item in blockedStats" :key="item.reason" color="orange">
            {{ reasonText[item.reason] }} {{ item.count }}
          </a-tag>
        </div>

        <div class="account-list-head">
          <a-checkbox
            :checked="allEligibleSelected"
            :indeterminate="someEligibleSelected"
            :disabled="!eligibleAccounts.length || running"
            @change="(event: any) => toggleAllAccounts(event.target.checked)"
          >
            全选可订阅账号
          </a-checkbox>
          <span class="muted">已选 {{ selectedAccountIds.length }}</span>
        </div>

        <div v-if="eligibleAccounts.length" class="account-list">
          <label v-for="account in eligibleAccounts" :key="account.id" class="account-row">
            <a-checkbox
              :checked="selectedAccountSet.has(account.id)"
              :disabled="running"
              @change="(event: any) => toggleAccount(account.id, event.target.checked)"
            />
            <span class="account-email">{{ account.email }}</span>
            <a-tag :color="account.status === 'active' ? 'green' : 'default'">
              {{ account.status }}
            </a-tag>
            <span class="muted usage-text">已用 {{ account.usage.current }}</span>
          </label>
        </div>
        <a-empty v-else :image="undefined" description="当前范围内没有可订阅的 Free 账号" />
      </a-card>

      <a-card size="small" title="2. 选择计划并生成" class="setup-card">
        <a-form layout="vertical">
          <a-form-item label="Kiro 订阅计划">
            <div class="plan-line">
              <a-select
                v-model:value="selectedPlanType"
                class="plan-select"
                placeholder="请先读取可用计划"
                :disabled="loadingPlans || running"
              >
                <a-select-option
                  v-for="plan in plans"
                  :key="plan.qSubscriptionType"
                  :value="plan.qSubscriptionType"
                >
                  {{ planLabel(plan) }}
                </a-select-option>
              </a-select>
              <a-button :loading="loadingPlans" :disabled="running" @click="loadPlans">
                <template #icon><ReloadOutlined /></template>
                读取计划
              </a-button>
            </div>
          </a-form-item>

          <div v-if="currentPlan" class="plan-detail">
            <strong>{{ currentPlan.description.title }}</strong>
            <span class="muted">{{ currentPlan.qSubscriptionType }}</span>
            <ul v-if="currentPlan.description.features.length">
              <li v-for="feature in currentPlan.description.features.slice(0, 4)" :key="feature">
                {{ feature }}
              </li>
            </ul>
          </div>

          <a-alert
            v-if="disclaimer.length"
            type="info"
            show-icon
            :message="disclaimer.join(' ')"
            class="disclaimer"
          />

          <a-form-item label="并发数">
            <a-input-number
              v-model:value="concurrency"
              :min="1"
              :max="5"
              :disabled="running"
            />
            <span class="muted concurrency-tip">建议 1–2，降低触发 Kiro / Stripe 风控的概率</span>
          </a-form-item>

          <a-button
            type="primary"
            block
            :loading="running"
            :disabled="!selectedAccountIds.length || !selectedPlanType"
            @click="generateBatch"
          >
            <template #icon><LinkOutlined /></template>
            为 {{ selectedAccountIds.length }} 个账号生成订阅链接
          </a-button>
        </a-form>
      </a-card>
    </div>

    <a-card v-if="rows.length" size="small" title="3. 生成结果" class="results-card">
      <template #extra>
        <div class="result-actions">
          <a-button
            size="small"
            :disabled="!selectedSuccessfulRows.length || running"
            @click="copyRows(selectedSuccessfulRows, '选中链接')"
          >
            <template #icon><CopyOutlined /></template>
            复制选中（{{ selectedSuccessfulRows.length }}）
          </a-button>
          <a-button
            size="small"
            :disabled="!successfulRows.length || running"
            @click="copyRows(successfulRows, '全部链接')"
          >
            复制全部（{{ successfulRows.length }}）
          </a-button>
          <a-button
            size="small"
            :disabled="!selectedSuccessfulRows.length || running"
            @click="openRows(selectedSuccessfulRows)"
          >
            <template #icon><ExportOutlined /></template>
            无痕打开选中
          </a-button>
        </div>
      </template>

      <a-progress v-if="running" :percent="progressPercent" size="small" />

      <div class="result-head result-grid">
        <a-checkbox
          :checked="successfulRows.length > 0 && selectedSuccessfulRows.length === successfulRows.length"
          :indeterminate="selectedSuccessfulRows.length > 0 && selectedSuccessfulRows.length < successfulRows.length"
          :disabled="running || !successfulRows.length"
          @change="(event: any) => toggleAllResults(event.target.checked)"
        />
        <span>账号</span>
        <span>状态</span>
        <span>操作</span>
      </div>

      <div class="result-list">
        <div v-for="row in rows" :key="row.accountId" class="result-row result-grid">
          <a-checkbox
            :checked="selectedResultSet.has(row.accountId)"
            :disabled="row.status !== 'success' || running"
            @change="(event: any) => toggleResult(row.accountId, event.target.checked)"
          />
          <span class="account-email">{{ row.email }}</span>
          <span>
            <a-tag v-if="row.status === 'pending'">等待中</a-tag>
            <a-tag v-else-if="row.status === 'loading'" color="processing">生成中</a-tag>
            <a-tooltip v-else-if="row.status === 'error'" :title="row.error">
              <a-tag color="error"><ExclamationCircleOutlined /> 失败</a-tag>
            </a-tooltip>
            <a-tag v-else color="success"><CheckCircleOutlined /> 成功</a-tag>
          </span>
          <span class="row-actions">
            <template v-if="row.status === 'success' && row.url">
              <a-button type="link" size="small" @click="copyLink(row.url)">
                <CopyOutlined /> 复制
              </a-button>
              <a-button type="link" size="small" @click="qrRow = row">
                <QrcodeOutlined /> 二维码
              </a-button>
              <a-button type="link" size="small" @click="openPrivate(row.url)">
                <ExportOutlined /> 无痕打开
              </a-button>
            </template>
            <a-button v-else-if="row.status === 'error'" type="link" size="small" @click="regenerate(row)">
              <ReloadOutlined /> 重试
            </a-button>
          </span>
        </div>
      </div>
    </a-card>

    <a-modal
      :open="!!qrRow"
      title="订阅链接二维码"
      :footer="null"
      width="480px"
      @cancel="qrRow = null"
    >
      <div v-if="qrRow?.url" class="qr-wrap">
        <a-qrcode :value="qrRow.url" :size="240" error-level="M" />
        <strong>{{ qrRow.email }}</strong>
        <a-typography-paragraph :ellipsis="{ rows: 2, tooltip: qrRow.url }" class="qr-url">
          {{ qrRow.url }}
        </a-typography-paragraph>
        <div class="qr-actions">
          <a-button @click="copyLink(qrRow.url)"><CopyOutlined /> 复制链接</a-button>
          <a-button type="primary" @click="openPrivate(qrRow.url)">
            <ExportOutlined /> 无痕打开
          </a-button>
        </div>
      </div>
    </a-modal>
  </div>
</template>

<style scoped>
.subscription-page {
  height: 100%;
  overflow: auto;
  padding-right: 4px;
}

.page-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 14px;
}

.page-header h2 {
  margin: 0 0 4px;
  font-size: 22px;
}

.page-header p {
  margin: 0;
  color: var(--kal-muted);
}

.setup-grid {
  display: grid;
  grid-template-columns: minmax(420px, 1.2fr) minmax(360px, 0.8fr);
  gap: 14px;
  margin-top: 14px;
}

.setup-card {
  min-width: 0;
}

.option-row,
.account-list-head,
.plan-line,
.result-actions,
.qr-actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.option-row {
  min-height: 42px;
  padding: 8px 0;
  border-bottom: 1px solid var(--kal-border);
}

.blocked-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding: 10px 0 4px;
}

.account-list-head {
  margin-top: 8px;
  padding: 8px 0;
}

.account-list {
  max-height: 270px;
  overflow: auto;
  border: 1px solid var(--kal-border);
  border-radius: 8px;
}

.account-row {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto auto;
  align-items: center;
  gap: 10px;
  padding: 9px 10px;
  border-bottom: 1px solid var(--kal-border);
  cursor: pointer;
}

.account-row:last-child {
  border-bottom: 0;
}

.account-row:hover,
.result-row:hover {
  background: var(--kal-block-bg);
}

.account-email {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.usage-text {
  white-space: nowrap;
}

.plan-select {
  min-width: 0;
  flex: 1 1 auto;
}

.plan-detail {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin: -4px 0 14px;
  padding: 12px;
  border: 1px solid var(--kal-border);
  border-radius: 8px;
  background: var(--kal-block-bg);
}

.plan-detail ul {
  margin: 2px 0 0;
  padding-left: 20px;
}

.disclaimer {
  margin-bottom: 14px;
}

.concurrency-tip {
  margin-left: 10px;
}

.results-card {
  margin-top: 14px;
}

.result-actions {
  flex-wrap: wrap;
  justify-content: flex-end;
}

.result-grid {
  display: grid;
  grid-template-columns: 28px minmax(220px, 1fr) 110px minmax(250px, auto);
  align-items: center;
  gap: 10px;
}

.result-head {
  padding: 10px 8px;
  color: var(--kal-muted);
  font-size: 12px;
  font-weight: 600;
  border-bottom: 1px solid var(--kal-border);
}

.result-list {
  max-height: 360px;
  overflow: auto;
}

.result-row {
  min-height: 48px;
  padding: 6px 8px;
  border-bottom: 1px solid var(--kal-border);
}

.result-row:last-child {
  border-bottom: 0;
}

.row-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  white-space: nowrap;
}

.qr-wrap {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
}

.qr-url {
  width: 100%;
  margin: 0 !important;
  text-align: center;
  word-break: break-all;
}

.muted {
  color: var(--kal-muted);
}

.small {
  margin-top: 2px;
  font-size: 12px;
}

@media (max-width: 1120px) {
  .setup-grid {
    grid-template-columns: 1fr;
  }

  .result-grid {
    grid-template-columns: 28px minmax(180px, 1fr) 90px minmax(230px, auto);
  }
}
</style>
