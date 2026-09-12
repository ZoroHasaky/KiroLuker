<script lang="ts">
import { ref as sessionRef } from 'vue'
import type { KiroSubscriptionPlan } from '@shared/types'

type SubscriptionLinkStatus = 'pending' | 'loading' | 'success' | 'error'

interface SubscriptionLinkRow {
  accountId: string
  email: string
  status: SubscriptionLinkStatus
  url?: string
  error?: string
  generatedAt?: number
}

const batchSession = {
  links: sessionRef<SubscriptionLinkRow[]>([]),
  selectedLinkIds: sessionRef<string[]>([]),
  availablePlans: sessionRef<KiroSubscriptionPlan[]>([]),
  selectedPlanType: sessionRef(''),
  disclaimer: sessionRef<string[]>([]),
  accountPickIds: sessionRef<string[]>([])
}
</script>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { message } from 'ant-design-vue'
import {
  CheckOutlined,
  CopyOutlined,
  DeleteOutlined,
  DownloadOutlined,
  LinkOutlined,
  ReloadOutlined,
  SafetyCertificateOutlined,
  SelectOutlined
} from '@ant-design/icons-vue'
import type { Account } from '@shared/types'
import {
  classifySubscriptionEligibility,
  preferredSubscriptionPlan,
  isSubscriptionAuthError
} from '@shared/subscriptionBatch'
import { useAccountsStore } from '@/stores/accounts'
import { toPlain } from '@/utils/ipc'

const props = withDefaults(
  defineProps<{ accounts: Account[]; disabled?: boolean }>(),
  { disabled: false }
)

const accountsStore = useAccountsStore()
const search = ref('')
const loadingPlans = ref(false)
const generating = ref(false)
const concurrency = ref(2)
const disposed = ref(false)

const { links, selectedLinkIds, availablePlans, selectedPlanType, disclaimer, accountPickIds } = batchSession
const uniqueAccounts = computed(() => [...new Map(props.accounts.map((account) => [account.id, account])).values()])

const preflightReport = computed(() => {
  const eligible: Account[] = []
  for (const account of uniqueAccounts.value) {
    const result = classifySubscriptionEligibility(account)
    if (result.eligible) eligible.push(account)
  }
  return { eligible, total: uniqueAccounts.value.length }
})
const eligibleIds = computed(() => new Set(preflightReport.value.eligible.map((account) => account.id)))
const filteredEligibleAccounts = computed(() => {
  const query = search.value.trim().toLowerCase()
  if (!query) return preflightReport.value.eligible
  return preflightReport.value.eligible.filter((account) =>
    [account.email, account.nickname, account.id].some((value) => value?.toLowerCase().includes(query))
  )
})
const targetAccounts = computed(() => {
  if (accountPickIds.value.length === 0) return preflightReport.value.eligible
  const picked = new Set(accountPickIds.value)
  return preflightReport.value.eligible.filter((account) => picked.has(account.id))
})
const selectedLinks = computed(() => {
  const selected = new Set(selectedLinkIds.value)
  return links.value.filter((link) => selected.has(link.accountId) && link.url && link.status === 'success')
})
const successfulLinks = computed(() => links.value.filter((link) => link.status === 'success' && link.url))
const failedLinks = computed(() => links.value.filter((link) => link.status === 'error'))
const pendingCount = computed(() => links.value.filter((link) => link.status === 'pending' || link.status === 'loading').length)
const completedCount = computed(() => links.value.filter((link) => ['success', 'error'].includes(link.status)).length)
const progressPercent = computed(() => links.value.length ? Math.round((completedCount.value / links.value.length) * 100) : 0)
const allLinksSelected = computed(() => links.value.length > 0 && selectedLinkIds.value.length === links.value.length)

watch(() => uniqueAccounts.value.map((account) => account.id), (ids) => {
  const allowed = new Set(ids)
  accountPickIds.value = accountPickIds.value.filter((id) => allowed.has(id))
  selectedLinkIds.value = selectedLinkIds.value.filter((id) => links.value.some((link) => link.accountId === id))
})
watch(eligibleIds, (ids) => {
  accountPickIds.value = accountPickIds.value.filter((id) => ids.has(id))
})
onBeforeUnmount(() => { disposed.value = true })

function errorText(error: unknown): string { return error instanceof Error ? error.message : String(error) }
function getAccount(id: string): Account | undefined {
  return accountsStore.get(id) || uniqueAccounts.value.find((account) => account.id === id)
}
async function prepareAccount(account: Account): Promise<Account> {
  const current = getAccount(account.id) || account
  if (current.credentials.accessToken && current.credentials.expiresAt > Date.now() + 60_000) return current
  if (!current.credentials.refreshToken) throw new Error('缺少 Refresh Token')
  const refreshed = await accountsStore.refreshToken(current.id)
  if (!refreshed.ok) throw new Error(refreshed.error || '凭证刷新失败')
  return getAccount(current.id) || current
}
function updateLink(accountId: string, patch: Partial<SubscriptionLinkRow>): void {
  links.value = links.value.map((link) => link.accountId === accountId ? { ...link, ...patch } : link)
}

async function generateOne(account: Account, planType: string): Promise<void> {
  updateLink(account.id, { status: 'loading', error: undefined })
  try {
    const prepared = await prepareAccount(account)
    if (disposed.value) return
    const result = await window.api.createSubscriptionLink(toPlain(prepared), planType)
    if (!result.success || !result.data?.url) throw new Error(result.error || '未返回有效的订阅链接')
    const url = result.data.url
    // 提链成功即写入账号数据，避免用户还要再手动复制保存。
    accountsStore.updateAccount(account.id, { paymentLink: url })
    updateLink(account.id, { status: 'success', url, error: undefined, generatedAt: Date.now() })
  } catch (error) {
    const detail = errorText(error)
    updateLink(account.id, {
      status: 'error',
      error: isSubscriptionAuthError(detail) ? `${detail}；请先刷新账号凭证` : detail
    })
  }
}

async function loadPlans(): Promise<void> {
  if (loadingPlans.value) return
  const candidate = preflightReport.value.eligible[0]
  if (!candidate) return void message.warning('没有待提链账号')
  loadingPlans.value = true
  try {
    const account = await prepareAccount(candidate)
    const result = await window.api.getSubscriptionPlans(toPlain(account))
    if (!result.success || !result.data?.plans?.length) throw new Error(result.error || 'Kiro 未返回可用订阅计划')
    availablePlans.value = result.data.plans
    disclaimer.value = result.data.disclaimer || []
    selectedPlanType.value = preferredSubscriptionPlan(result.data.plans)?.qSubscriptionType || result.data.plans[0].qSubscriptionType
    message.success(`已加载 ${result.data.plans.length} 个订阅计划`)
  } catch (error) {
    message.error(`加载订阅计划失败：${errorText(error)}`)
  } finally { loadingPlans.value = false }
}

async function fetchLinks(): Promise<void> {
  if (generating.value) return
  const targets = targetAccounts.value
  if (!targets.length) return void message.warning('没有待提链账号')
  if (!selectedPlanType.value) return void message.warning('请先加载并选择订阅计划')
  generating.value = true
  links.value = targets.map((account) => ({ accountId: account.id, email: account.email || account.nickname || account.id, status: 'pending' }))
  selectedLinkIds.value = []
  let cursor = 0
  const worker = async (): Promise<void> => {
    while (cursor < targets.length && !disposed.value) await generateOne(targets[cursor++], selectedPlanType.value)
  }
  try {
    const workerCount = Math.min(Math.max(1, Number(concurrency.value) || 1), targets.length)
    await Promise.all(Array.from({ length: workerCount }, () => worker()))
    message.success(`提链完成：${successfulLinks.value.length} 成功，${failedLinks.value.length} 失败`)
  } finally { generating.value = false }
}

async function regenerateLink(link: SubscriptionLinkRow): Promise<void> {
  const account = getAccount(link.accountId)
  if (!account) return updateLink(link.accountId, { status: 'error', error: '账号已不存在' })
  if (!selectedPlanType.value) return void message.warning('请先选择订阅计划')
  await generateOne(account, selectedPlanType.value)
}
function selectAllAccounts(): void { accountPickIds.value = preflightReport.value.eligible.map((account) => account.id) }
function clearAccountSelection(): void { accountPickIds.value = [] }
function toggleAccount(id: string): void {
  const allIds = preflightReport.value.eligible.map((account) => account.id)
  const next = new Set(accountPickIds.value.length ? accountPickIds.value : allIds)
  if (next.has(id)) next.delete(id); else next.add(id)
  accountPickIds.value = [...next]
}
function toggleLink(accountId: string): void {
  const next = new Set(selectedLinkIds.value)
  if (next.has(accountId)) next.delete(accountId); else next.add(accountId)
  selectedLinkIds.value = [...next]
}
function toggleAllLinks(): void { selectedLinkIds.value = allLinksSelected.value ? [] : links.value.map((link) => link.accountId) }
function clearLinks(): void { links.value = []; selectedLinkIds.value = [] }
function removeSelectedLinks(): void {
  const selected = new Set(selectedLinkIds.value)
  links.value = links.value.filter((link) => !selected.has(link.accountId)); selectedLinkIds.value = []
}
function removeFailedLinks(): void {
  const failed = new Set(failedLinks.value.map((link) => link.accountId))
  links.value = links.value.filter((link) => !failed.has(link.accountId))
  selectedLinkIds.value = selectedLinkIds.value.filter((id) => !failed.has(id))
}
function copyText(text: string, successMessage: string): void { if (text) { window.api.writeClipboard(text); message.success(successMessage) } }
function copyLinks(target: SubscriptionLinkRow[]): void { copyText(target.map((link) => link.url).filter(Boolean).join('\n'), `已复制 ${target.length} 个链接`) }
async function openLinks(target: SubscriptionLinkRow[]): Promise<void> {
  let failed = 0
  for (const link of target) {
    if (!link.url) continue
    const result = await window.api.openExternal(link.url, { privateMode: true })
    if (!result.success) failed++
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  if (failed) message.warning(`${failed} 个链接打开失败`)
  else if (target.length) message.success(`已打开 ${target.length} 个链接`)
}
function statusLabel(link: SubscriptionLinkRow): string {
  if (link.status === 'pending') return '等待'
  if (link.status === 'loading') return '提取中'
  return link.status === 'success' ? '成功' : '失败'
}
function statusColor(link: SubscriptionLinkRow): string {
  if (link.status === 'success') return 'green'
  if (link.status === 'loading') return 'processing'
  if (link.status === 'pending') return 'default'
  return 'red'
}
function formatPlanPrice(plan: KiroSubscriptionPlan): string {
  const amount = Number(plan.pricing.amount)
  if (!Number.isFinite(amount)) return '价格未知'
  const interval = plan.description.billingInterval ? `/${plan.description.billingInterval}` : ''
  return `${plan.pricing.currency} ${(amount / 100).toFixed(2)}${interval}`
}
</script>

<template>
  <div class="subscription-link-panel">
    <div class="panel-header">
      <div>
        <h2 class="section-title">提链</h2>
        <p class="muted header-hint">仅显示 Free 且未使用额度、未降级的账号；成功提取后会自动写入账号的“支付链接”。</p>
      </div>
      <a-tag color="purple">待提链 {{ preflightReport.eligible.length }}</a-tag>
    </div>

    <a-alert v-if="disclaimer.length" class="panel-alert" type="info" show-icon :message="disclaimer.join('；')" />

    <a-card size="small" class="preflight-card">
      <template #title><SafetyCertificateOutlined /> 待提链账号</template>
      <div class="preflight-summary">
        <a-tag color="green">可提链 {{ preflightReport.eligible.length }}</a-tag>
        <span class="muted">扫描 {{ preflightReport.total }} 个账号</span>
      </div>
    </a-card>

    <a-card size="small" class="plan-card">
      <template #title><LinkOutlined /> 订阅计划</template>
      <div class="plan-toolbar">
        <a-button type="primary" :loading="loadingPlans" :disabled="props.disabled || !preflightReport.eligible.length" @click="loadPlans">
          <ReloadOutlined /> {{ availablePlans.length ? '重新加载计划' : '手动加载计划' }}
        </a-button>
        <a-select v-if="availablePlans.length" v-model:value="selectedPlanType" class="plan-select" :disabled="generating" placeholder="选择订阅计划">
          <a-select-option v-for="plan in availablePlans" :key="plan.qSubscriptionType" :value="plan.qSubscriptionType">
            {{ plan.description.title || plan.name }} · {{ formatPlanPrice(plan) }}
          </a-select-option>
        </a-select>
        <span v-else class="muted">先手动加载，再选择订阅计划</span>
      </div>
      <div v-if="availablePlans.length" class="plan-cards">
        <button v-for="plan in availablePlans" :key="plan.qSubscriptionType" type="button" class="plan-option" :class="{ selected: selectedPlanType === plan.qSubscriptionType }" :disabled="generating" @click="selectedPlanType = plan.qSubscriptionType">
          <strong>{{ plan.description.title || plan.name }}</strong>
          <span>{{ formatPlanPrice(plan) }}</span>
          <small v-if="plan.description.features.length">{{ plan.description.features.slice(0, 2).join(' · ') }}</small>
        </button>
      </div>
    </a-card>

    <a-card size="small" class="accounts-card">
      <template #title><SelectOutlined /> 选择账号</template>
      <template #extra><span class="muted">{{ accountPickIds.length ? `已选 ${targetAccounts.length}` : `不选则全部 ${targetAccounts.length}` }}</span></template>
      <div class="account-toolbar">
        <a-input v-model:value="search" allow-clear placeholder="搜索邮箱 / 昵称" class="search-input" />
        <a-button size="small" :disabled="generating || !preflightReport.eligible.length" @click="selectAllAccounts">全选</a-button>
        <a-button size="small" :disabled="generating || !accountPickIds.length" @click="clearAccountSelection">清空</a-button>
      </div>
      <div v-if="filteredEligibleAccounts.length" class="account-pick-list">
        <a-checkbox v-for="account in filteredEligibleAccounts" :key="account.id" :checked="accountPickIds.length ? accountPickIds.includes(account.id) : true" :disabled="generating" class="account-pick-item" @change="toggleAccount(account.id)">
          <span class="account-email">{{ account.email || account.nickname || account.id }}</span>
          <span class="muted account-plan">{{ account.subscription.title || account.subscription.type }}</span>
        </a-checkbox>
      </div>
      <a-empty v-else description="没有待提链账号" />
    </a-card>

    <a-card size="small" class="operation-card">
      <div class="operation-toolbar">
        <a-button type="primary" :loading="generating" :disabled="props.disabled || !targetAccounts.length || !selectedPlanType" @click="fetchLinks">
          <LinkOutlined /> 提取订阅链接（{{ targetAccounts.length }}）
        </a-button>
        <span class="muted">并发</span>
        <a-input-number v-model:value="concurrency" :min="1" :max="10" :disabled="generating" size="small" />
        <a-button danger type="text" :disabled="generating || !links.length" @click="clearLinks"><DeleteOutlined /> 清空结果</a-button>
      </div>
      <a-progress v-if="generating || links.length" :percent="progressPercent" :status="generating ? 'active' : undefined" :format="() => `${completedCount}/${links.length}`" />
      <span v-if="pendingCount" class="muted">剩余 {{ pendingCount }} 个账号正在等待提链</span>
    </a-card>

    <a-card v-if="links.length" size="small" class="links-card">
      <template #title>提链结果 <span class="muted">（成功 {{ successfulLinks.length }}，失败 {{ failedLinks.length }}）</span></template>
      <template #extra>
        <a-space wrap>
          <a-button size="small" :disabled="!links.length" @click="toggleAllLinks"><CheckOutlined /> {{ allLinksSelected ? '取消全选' : '全选' }}</a-button>
          <a-button size="small" :disabled="!selectedLinkIds.length" @click="removeSelectedLinks"><DeleteOutlined /> 移除选中</a-button>
          <a-button size="small" :disabled="!failedLinks.length" @click="removeFailedLinks">移除失败</a-button>
          <a-button size="small" :disabled="!selectedLinks.length" @click="copyLinks(selectedLinks)"><CopyOutlined /> 复制选中</a-button>
          <a-button size="small" :disabled="!successfulLinks.length" @click="copyLinks(successfulLinks)"><DownloadOutlined /> 复制全部</a-button>
        </a-space>
      </template>
      <div class="link-list">
        <div v-for="link in links" :key="link.accountId" class="link-row" :class="{ selected: selectedLinkIds.includes(link.accountId) }">
          <a-checkbox :checked="selectedLinkIds.includes(link.accountId)" @change="toggleLink(link.accountId)" />
          <div class="link-main">
            <strong :title="link.email">{{ link.email }}</strong>
            <span v-if="link.url" class="link-url" :title="link.url">{{ link.url }}</span>
            <span v-if="link.error" class="link-error" :title="link.error">{{ link.error }}</span>
          </div>
          <a-tag :color="statusColor(link)">{{ statusLabel(link) }}</a-tag>
          <a-space v-if="link.url" size="small">
            <a-button size="small" type="link" @click="copyText(link.url!, '链接已复制')"><CopyOutlined /></a-button>
            <a-button size="small" type="link" @click="openLinks([link])">打开</a-button>
          </a-space>
          <a-button v-else-if="link.status === 'error'" size="small" type="link" @click="regenerateLink(link)"><ReloadOutlined /> 重试</a-button>
        </div>
      </div>
    </a-card>
  </div>
</template>

<style scoped>
.subscription-link-panel { display: flex; flex-direction: column; gap: 12px; height: 100%; min-height: 0; overflow: auto; padding-bottom: 8px; }
.panel-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
.section-title { margin: 0 0 4px; }
.header-hint { margin: 0; font-size: 12px; }
.panel-alert { flex: 0 0 auto; }
.preflight-card :deep(.ant-card-head-title), .plan-card :deep(.ant-card-head-title), .accounts-card :deep(.ant-card-head-title) { display: flex; align-items: center; gap: 6px; }
.preflight-summary, .plan-toolbar, .account-toolbar, .operation-toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.plan-select { min-width: 300px; max-width: 520px; }
.plan-cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 8px; margin-top: 12px; }
.plan-option { display: flex; flex-direction: column; align-items: flex-start; gap: 4px; padding: 10px 12px; border: 1px solid var(--kal-border); border-radius: 8px; background: var(--kal-card-bg); color: inherit; text-align: left; cursor: pointer; }
.plan-option:hover, .plan-option.selected { border-color: var(--kal-primary); background: color-mix(in srgb, var(--kal-primary) 7%, var(--kal-card-bg)); }
.account-pick-list, .link-list { display: flex; flex-direction: column; gap: 6px; max-height: 260px; overflow: auto; margin-top: 12px; }
.account-pick-item, .link-row { display: flex; align-items: center; gap: 8px; padding: 7px 8px; border: 1px solid var(--kal-border); border-radius: 8px; }
.account-pick-item :deep(.ant-checkbox + span) { display: flex; flex: 1; justify-content: space-between; gap: 8px; min-width: 0; }
.account-email, .link-main { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.account-plan { flex: 0 0 auto; }
.link-row.selected { border-color: var(--kal-primary); background: color-mix(in srgb, var(--kal-primary) 6%, var(--kal-card-bg)); }
.link-main { display: flex; flex: 1; flex-direction: column; gap: 2px; }
.link-url, .link-error { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; }
.link-url { color: var(--kal-primary); }
.link-error { color: #ff4d4f; }
</style>
