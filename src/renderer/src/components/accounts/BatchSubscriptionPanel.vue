<script lang="ts">
import { ref as sessionRef } from 'vue'
import type { KiroSubscriptionPlan } from '@shared/types'

type SubscriptionLinkStatus = 'pending' | 'loading' | 'success' | 'error' | 'expired'
type BatchSubscriptionTab = 'links' | 'overage'
type OverageStatus = 'pending' | 'loading' | 'success' | 'error'

interface OverageRow {
  accountId: string
  email: string
  status: OverageStatus
  error?: string
}

interface SubscriptionLinkRow {
  accountId: string
  email: string
  status: SubscriptionLinkStatus
  url?: string
  error?: string
  generatedAt?: number
  validated?: boolean
  imported?: boolean
}

const batchSession = {
  links: sessionRef<SubscriptionLinkRow[]>([]),
  selectedLinkIds: sessionRef<string[]>([]),
  availablePlans: sessionRef<KiroSubscriptionPlan[]>([]),
  selectedPlanType: sessionRef(''),
  disclaimer: sessionRef<string[]>([]),
  accountPickIds: sessionRef<string[]>([]),
  activeTab: sessionRef<BatchSubscriptionTab>('links'),
  overageItems: sessionRef<OverageRow[]>([])
}
</script>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { message } from 'ant-design-vue'
import {
  CheckCircleOutlined,
  CheckOutlined,
  CopyOutlined,
  DeleteOutlined,
  DownloadOutlined,
  LinkOutlined,
  ReloadOutlined,
  SafetyCertificateOutlined,
  SelectOutlined,
  ThunderboltOutlined,
  UploadOutlined
} from '@ant-design/icons-vue'
import type { Account } from '@shared/types'
import {
  classifySubscriptionEligibility,
  isHttpSubscriptionUrl,
  isSubscriptionAuthError,
  isSubscriptionLinkStale,
  isUnsuitableFreeReason,
  parseImportedSubscriptionLinks,
  preferredSubscriptionPlan
} from '@shared/subscriptionBatch'
import { useAccountsStore } from '@/stores/accounts'
import { toPlain } from '@/utils/ipc'

const props = withDefaults(
  defineProps<{
    accounts: Account[]
    disabled?: boolean
  }>(),
  { disabled: false }
)

const accountsStore = useAccountsStore()
const search = ref('')
const filterUnsuitable = ref(true)
const loadingPlans = ref(false)
const generating = ref(false)
const validating = ref(false)
const settingOverage = ref(false)
const concurrency = ref(2)
const showImportDialog = ref(false)
const importText = ref('')
const disposed = ref(false)

const {
  links,
  selectedLinkIds,
  availablePlans,
  selectedPlanType,
  disclaimer,
  accountPickIds,
  activeTab,
  overageItems
} = batchSession

const uniqueAccounts = computed(() => [...new Map(props.accounts.map((account) => [account.id, account])).values()])
const selectedPageIds = computed(() => new Set(accountsStore.selectedIds))
const sourceAccounts = computed(() => {
  if (selectedPageIds.value.size === 0) return uniqueAccounts.value
  return uniqueAccounts.value.filter((account) => selectedPageIds.value.has(account.id))
})

const preflightReport = computed(() => {
  const eligible: Account[] = []
  const blocked: Array<{ account: Account; reason: ReturnType<typeof classifySubscriptionEligibility>['reason']; detail?: string }> = []
  for (const account of sourceAccounts.value) {
    const result = classifySubscriptionEligibility(account)
    if (result.eligible || (!filterUnsuitable.value && isUnsuitableFreeReason(result.reason))) {
      eligible.push(account)
    } else {
      blocked.push({ account, reason: result.reason, detail: result.detail })
    }
  }
  return { eligible, blocked, total: sourceAccounts.value.length }
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
const failedLinks = computed(() => links.value.filter((link) => link.status === 'error' || link.status === 'expired'))
const subscribedAccounts = computed(() => sourceAccounts.value.filter((account) => {
  const type = account.subscription.type.toUpperCase()
  const title = (account.subscription.title || '').toUpperCase()
  return !!account.credentials.accessToken && (
    type !== 'FREE' || ['PRO', 'POWER', 'TEAMS', 'ENTERPRISE'].some((name) => title.includes(name))
  )
}))
const overageableAccounts = computed(() => subscribedAccounts.value.filter((account) =>
  (account.subscription.overageCapability || '').toUpperCase().includes('OVERAGE_CAPABLE') &&
  account.usage.resourceDetail?.overageEnabled !== true
))
const enabledOverageAccounts = computed(() => subscribedAccounts.value.filter((account) => account.usage.resourceDetail?.overageEnabled === true))
const overageCompletedCount = computed(() => overageItems.value.filter((item) => item.status === 'success' || item.status === 'error').length)
const overageSuccessCount = computed(() => overageItems.value.filter((item) => item.status === 'success').length)
const overageErrorCount = computed(() => overageItems.value.filter((item) => item.status === 'error').length)
const pendingCount = computed(() => links.value.filter((link) => link.status === 'pending' || link.status === 'loading').length)
const completedCount = computed(() => links.value.filter((link) => ['success', 'error', 'expired'].includes(link.status)).length)
const progressPercent = computed(() => links.value.length ? Math.round((completedCount.value / links.value.length) * 100) : 0)
const allLinksSelected = computed(() => links.value.length > 0 && selectedLinkIds.value.length === links.value.length)
const filteredSelectedCount = computed(() => filteredEligibleAccounts.value.filter((account) => accountPickIds.value.includes(account.id)).length)

watch(
  () => uniqueAccounts.value.map((account) => account.id),
  (ids) => {
    const allowed = new Set(ids)
    accountPickIds.value = accountPickIds.value.filter((id) => allowed.has(id))
    selectedLinkIds.value = selectedLinkIds.value.filter((id) => links.value.some((link) => link.accountId === id))
  }
)
watch(eligibleIds, (ids) => {
  accountPickIds.value = accountPickIds.value.filter((id) => ids.has(id))
})

onBeforeUnmount(() => {
  disposed.value = true
})

const reasonLabels: Record<string, string> = {
  'no-credentials': '缺少凭证',
  'already-paid': '已有付费订阅',
  banned: '账号可能被封禁',
  expired: '账号已过期',
  'cannot-upgrade': '上游禁止升级',
  'unknown-tier': '订阅档位未知',
  'downgraded-free': '付费降级为 Free',
  'used-free': 'Free 已使用额度'
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function getAccount(id: string): Account | undefined {
  return accountsStore.get(id) || uniqueAccounts.value.find((account) => account.id === id)
}

async function prepareAccount(account: Account): Promise<Account> {
  const current = getAccount(account.id) || account
  if (current.credentials.accessToken && current.credentials.expiresAt > Date.now() + 60_000) {
    return current
  }
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
    if (!result.success || !result.data?.url) {
      throw new Error(result.error || '未返回有效的订阅链接')
    }
    updateLink(account.id, {
      status: 'success',
      url: result.data.url,
      error: undefined,
      generatedAt: Date.now(),
      validated: false
    })
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
  if (!candidate) {
    message.warning('没有可用于加载计划的账号')
    return
  }
  loadingPlans.value = true
  try {
    const account = await prepareAccount(candidate)
    const result = await window.api.getSubscriptionPlans(toPlain(account))
    if (!result.success || !result.data?.plans?.length) {
      throw new Error(result.error || 'Kiro 未返回可用订阅计划')
    }
    availablePlans.value = result.data.plans
    disclaimer.value = result.data.disclaimer || []
    selectedPlanType.value = preferredSubscriptionPlan(result.data.plans)?.qSubscriptionType || result.data.plans[0].qSubscriptionType
    message.success(`已加载 ${result.data.plans.length} 个订阅计划`)
  } catch (error) {
    message.error(`加载订阅计划失败：${errorText(error)}`)
  } finally {
    loadingPlans.value = false
  }
}

async function fetchLinks(): Promise<void> {
  if (generating.value) return
  const targets = targetAccounts.value
  if (!targets.length) {
    message.warning('没有可生成链接的账号')
    return
  }
  if (!selectedPlanType.value) {
    message.warning('请先加载并选择订阅计划')
    return
  }

  generating.value = true
  links.value = targets.map((account) => ({
    accountId: account.id,
    email: account.email || account.nickname || account.id,
    status: 'pending'
  }))
  selectedLinkIds.value = []

  let cursor = 0
  const worker = async (): Promise<void> => {
    while (cursor < targets.length && !disposed.value) {
      const index = cursor++
      await generateOne(targets[index], selectedPlanType.value)
    }
  }
  try {
    const workerCount = Math.min(Math.max(1, Number(concurrency.value) || 1), targets.length)
    await Promise.all(Array.from({ length: workerCount }, () => worker()))
    message.success(`批量生成完成：${successfulLinks.value.length} 成功，${failedLinks.value.length} 失败`)
  } finally {
    generating.value = false
  }
}

async function regenerateLink(link: SubscriptionLinkRow): Promise<void> {
  if (link.imported) {
    message.info('导入的外部链接没有对应账号，不能自动重新生成')
    return
  }
  const account = getAccount(link.accountId)
  if (!account) {
    updateLink(link.accountId, { status: 'error', error: '账号已不存在' })
    return
  }
  if (!selectedPlanType.value) {
    message.warning('请先选择订阅计划')
    return
  }
  await generateOne(account, selectedPlanType.value)
}

function selectAllAccounts(): void {
  accountPickIds.value = preflightReport.value.eligible.map((account) => account.id)
}

function clearAccountSelection(): void {
  accountPickIds.value = []
}

function toggleAccount(id: string): void {
  const allIds = preflightReport.value.eligible.map((account) => account.id)
  const next = new Set(accountPickIds.value.length ? accountPickIds.value : allIds)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  accountPickIds.value = [...next]
}

function toggleLink(accountId: string): void {
  const next = new Set(selectedLinkIds.value)
  if (next.has(accountId)) next.delete(accountId)
  else next.add(accountId)
  selectedLinkIds.value = [...next]
}

function toggleAllLinks(): void {
  selectedLinkIds.value = allLinksSelected.value ? [] : links.value.map((link) => link.accountId)
}

function clearLinks(): void {
  links.value = []
  selectedLinkIds.value = []
}

function removeSelectedLinks(): void {
  if (!selectedLinkIds.value.length) return
  const selected = new Set(selectedLinkIds.value)
  links.value = links.value.filter((link) => !selected.has(link.accountId))
  selectedLinkIds.value = []
}

function removeFailedLinks(): void {
  const failed = new Set(failedLinks.value.map((link) => link.accountId))
  links.value = links.value.filter((link) => !failed.has(link.accountId))
  selectedLinkIds.value = selectedLinkIds.value.filter((id) => !failed.has(id))
}

function copyText(text: string, successMessage: string): void {
  if (!text) return
  window.api.writeClipboard(text)
  message.success(successMessage)
}

function copyLinks(target: SubscriptionLinkRow[]): void {
  copyText(target.map((link) => link.url).filter(Boolean).join('\n'), `已复制 ${target.length} 个链接`)
}

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

function validateLinks(): void {
  validating.value = true
  try {
    const now = Date.now()
    links.value = links.value.map((link) => {
      if (!link.url || !isHttpSubscriptionUrl(link.url)) {
        return { ...link, status: 'error', error: '链接不是有效的 HTTP/HTTPS 地址' }
      }
      if (link.status === 'success' && isSubscriptionLinkStale(link.generatedAt, now)) {
        return { ...link, status: 'expired', error: '链接生成超过 15 分钟，请重新生成' }
      }
      if (link.status === 'success') return { ...link, validated: true, error: undefined }
      return link
    })
    message.success('链接有效性检查完成')
  } finally {
    validating.value = false
  }
}

function updateOverageRow(accountId: string, patch: Partial<OverageRow>): void {
  overageItems.value = overageItems.value.map((item) => item.accountId === accountId ? { ...item, ...patch } : item)
}

async function setOverageOne(account: Account, overageStatus: 'ENABLED' | 'DISABLED'): Promise<void> {
  updateOverageRow(account.id, { status: 'loading', error: undefined })
  try {
    const prepared = await prepareAccount(account)
    if (disposed.value) return
    const result = await window.api.setSubscriptionOverage(toPlain(prepared), overageStatus)
    if (!result.success || !result.data?.success) throw new Error(result.error || '上游未确认超额设置')
    const existing = accountsStore.get(account.id)
    if (existing) {
      accountsStore.updateAccount(account.id, {
        usage: {
          ...existing.usage,
          resourceDetail: {
            ...existing.usage.resourceDetail,
            overageEnabled: overageStatus === 'ENABLED'
          }
        }
      })
    }
    updateOverageRow(account.id, { status: 'success' })
  } catch (error) {
    updateOverageRow(account.id, { status: 'error', error: errorText(error) })
  }
}

async function setOverage(
  overageStatus: 'ENABLED' | 'DISABLED',
  mode: 'eligible' | 'all'
): Promise<void> {
  if (settingOverage.value) return
  const targets = overageStatus === 'ENABLED'
    ? (mode === 'eligible' ? overageableAccounts.value : subscribedAccounts.value)
    : (mode === 'eligible' ? enabledOverageAccounts.value : subscribedAccounts.value.filter((account) => account.usage.resourceDetail?.overageEnabled === true))
  if (!targets.length) {
    message.info(overageStatus === 'ENABLED' ? '没有可开启超额的账号' : '没有已开启超额的账号')
    return
  }
  settingOverage.value = true
  overageItems.value = targets.map((account) => ({
    accountId: account.id,
    email: account.email || account.nickname || account.id,
    status: 'pending'
  }))
  let cursor = 0
  const worker = async (): Promise<void> => {
    while (cursor < targets.length && !disposed.value) {
      const index = cursor++
      await setOverageOne(targets[index], overageStatus)
    }
  }
  try {
    const workerCount = Math.min(Math.max(1, Number(concurrency.value) || 1), targets.length)
    await Promise.all(Array.from({ length: workerCount }, () => worker()))
    message.success((overageStatus === 'ENABLED' ? '开启' : '关闭') + '超额完成：' + overageSuccessCount.value + ' 成功，' + overageErrorCount.value + ' 失败')
  } finally {
    settingOverage.value = false
  }
}

function randomId(): string {
  return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`
}

function importLinks(): void {
  const parsed = parseImportedSubscriptionLinks(importText.value)
  if (!parsed.length) {
    message.warning('没有解析到有效的 HTTP/HTTPS 链接')
    return
  }
  const existing = new Set(links.value.map((link) => link.url).filter(Boolean))
  const now = Date.now()
  let sequence = links.value.length
  const imported = parsed.flatMap(({ email, url }) => {
    if (existing.has(url)) return []
    existing.add(url)
    sequence++
    return [{
      accountId: `import-${randomId()}`,
      email: email || `导入链接 #${sequence}`,
      status: 'success' as const,
      url,
      generatedAt: now,
      validated: false,
      imported: true
    }]
  })
  links.value = [...links.value, ...imported]
  importText.value = ''
  showImportDialog.value = false
  message.success(`已导入 ${imported.length} 个链接`)
}

function statusLabel(link: SubscriptionLinkRow): string {
  if (link.status === 'pending') return '等待'
  if (link.status === 'loading') return '生成中'
  if (link.status === 'success') return link.validated ? '已验证' : '成功'
  if (link.status === 'expired') return '已过期'
  return '失败'
}

function statusColor(link: SubscriptionLinkRow): string {
  if (link.status === 'success') return 'green'
  if (link.status === 'loading') return 'processing'
  if (link.status === 'pending') return 'default'
  return link.status === 'expired' ? 'orange' : 'red'
}

function overageStatusLabel(item: OverageRow): string {
  if (item.status === 'pending') return '等待'
  if (item.status === 'loading') return '执行中'
  return item.status === 'success' ? '完成' : '失败'
}

function overageStatusColor(item: OverageRow): string {
  if (item.status === 'success') return 'green'
  if (item.status === 'loading') return 'processing'
  if (item.status === 'pending') return 'default'
  return 'red'
}

function formatPlanPrice(plan: KiroSubscriptionPlan): string {
  const amount = Number(plan.pricing.amount)
  if (!Number.isFinite(amount)) return '价格未知'
  const value = amount / 100
  const interval = plan.description.billingInterval ? `/${plan.description.billingInterval}` : ''
  return `${plan.pricing.currency} ${value.toFixed(2)}${interval}`
}
</script>

<template>
  <div class="batch-subscription-panel">
    <div class="panel-header">
      <div>
        <h2 class="section-title">批量订阅</h2>
        <p class="muted header-hint">
          {{ accountsStore.selectedIds.length ? `使用账户页已选中的 ${accountsStore.selectedIds.length} 个账号` : '未选中账号时使用全部账号' }}；先生成官方订阅链接，再按需打开或复制。
        </p>
      </div>
      <a-tag color="purple">{{ preflightReport.eligible.length }} 个可升级</a-tag>
    </div>

    <div class="inner-tabs">
      <a-button size="small" :type="activeTab === 'links' ? 'primary' : 'default'" @click="activeTab = 'links'">
        <LinkOutlined /> 获取订阅链接
      </a-button>
      <a-button size="small" :type="activeTab === 'overage' ? 'primary' : 'default'" @click="activeTab = 'overage'">
        <ThunderboltOutlined /> 超额设置
      </a-button>
    </div>

    <template v-if="activeTab === 'links'">
      <a-alert
      v-if="disclaimer.length"
      class="panel-alert"
      type="info"
      show-icon
      :message="disclaimer.join('；')"
    />

    <a-card size="small" class="preflight-card">
      <template #title><SafetyCertificateOutlined /> 升级预检</template>
      <template #extra>
        <a-switch v-model:checked="filterUnsuitable" :disabled="generating" />
        <span class="switch-label">排除降级 Free / 已用额度</span>
      </template>
      <div class="preflight-summary">
        <a-tag color="green">可升级 {{ preflightReport.eligible.length }}</a-tag>
        <a-tag v-if="preflightReport.blocked.length" color="orange">已排除 {{ preflightReport.blocked.length }}</a-tag>
        <span class="muted">扫描 {{ preflightReport.total }} 个账号</span>
      </div>
      <div v-if="preflightReport.blocked.length" class="blocked-list">
        <a-tag v-for="item in preflightReport.blocked.slice(0, 12)" :key="item.account.id" color="orange">
          {{ item.account.email || item.account.id }}：{{ reasonLabels[item.reason] || item.reason }}
        </a-tag>
        <span v-if="preflightReport.blocked.length > 12" class="muted">还有 {{ preflightReport.blocked.length - 12 }} 个</span>
      </div>
      <a-alert
        v-if="preflightReport.total && !preflightReport.eligible.length"
        class="inline-alert"
        type="warning"
        show-icon
        message="没有符合条件的账号"
        description="请先在账户管理页刷新账号状态，或关闭“排除降级 Free / 已用额度”后重试。"
      />
    </a-card>

    <a-card size="small" class="plan-card">
      <template #title><ThunderboltOutlined /> 订阅计划</template>
      <div class="plan-toolbar">
        <a-button type="primary" :loading="loadingPlans" :disabled="disabled || !preflightReport.eligible.length" @click="loadPlans">
          <ReloadOutlined /> {{ availablePlans.length ? '重新加载计划' : '加载可用计划' }}
        </a-button>
        <a-select
          v-if="availablePlans.length"
          v-model:value="selectedPlanType"
          class="plan-select"
          :disabled="generating"
          placeholder="选择订阅计划"
        >
          <a-select-option v-for="plan in availablePlans" :key="plan.qSubscriptionType" :value="plan.qSubscriptionType">
            {{ plan.description.title || plan.name }} · {{ formatPlanPrice(plan) }}
          </a-select-option>
        </a-select>
        <span v-else class="muted">点击加载当前账号可购买的计划</span>
      </div>
      <div v-if="availablePlans.length" class="plan-cards">
        <button
          v-for="plan in availablePlans"
          :key="plan.qSubscriptionType"
          type="button"
          class="plan-option"
          :class="{ selected: selectedPlanType === plan.qSubscriptionType }"
          :disabled="generating"
          @click="selectedPlanType = plan.qSubscriptionType"
        >
          <strong>{{ plan.description.title || plan.name }}</strong>
          <span>{{ formatPlanPrice(plan) }}</span>
          <small v-if="plan.description.features.length">{{ plan.description.features.slice(0, 2).join(' · ') }}</small>
        </button>
      </div>
    </a-card>

    <a-card size="small" class="accounts-card">
      <template #title><SelectOutlined /> 选择账号</template>
      <template #extra>
        <span class="muted">{{ accountPickIds.length ? `已选 ${targetAccounts.length}` : `不选则全部 ${targetAccounts.length}` }}</span>
      </template>
      <div class="account-toolbar">
        <a-input v-model:value="search" allow-clear placeholder="搜索邮箱 / 昵称" class="search-input" />
        <a-button size="small" :disabled="generating || !preflightReport.eligible.length" @click="selectAllAccounts">全选</a-button>
        <a-button size="small" :disabled="generating || !accountPickIds.length" @click="clearAccountSelection">清空</a-button>
      </div>
      <div v-if="filteredEligibleAccounts.length" class="account-pick-list">
        <a-checkbox
          v-for="account in filteredEligibleAccounts"
          :key="account.id"
          :checked="accountPickIds.length ? accountPickIds.includes(account.id) : true"
          :disabled="generating"
          class="account-pick-item"
          @change="toggleAccount(account.id)"
        >
          <span class="account-email">{{ account.email || account.nickname || account.id }}</span>
          <span class="muted account-plan">{{ account.subscription.title || account.subscription.type }}</span>
        </a-checkbox>
      </div>
      <a-empty v-else description="没有可升级账号" />
    </a-card>

    <a-card size="small" class="operation-card">
      <div class="operation-toolbar">
        <a-button type="primary" :loading="generating" :disabled="disabled || !targetAccounts.length || !selectedPlanType" @click="fetchLinks">
          <LinkOutlined /> 生成订阅链接（{{ targetAccounts.length }}）
        </a-button>
        <span class="muted">并发</span>
        <a-input-number v-model:value="concurrency" :min="1" :max="10" :disabled="generating" size="small" />
        <a-button :disabled="generating" @click="showImportDialog = true"><UploadOutlined /> 导入链接</a-button>
        <a-button :disabled="generating || !links.length" @click="validateLinks"><ReloadOutlined /> 检测有效性</a-button>
        <a-button danger type="text" :disabled="generating || !links.length" @click="clearLinks"><DeleteOutlined /> 清空</a-button>
      </div>
      <a-progress v-if="generating || links.length" :percent="progressPercent" :status="generating ? 'active' : undefined" :format="() => `${completedCount}/${links.length}`" />
    </a-card>

    <a-card v-if="links.length" size="small" class="links-card">
      <template #title>链接结果 <span class="muted">（成功 {{ successfulLinks.length }}，失败 {{ failedLinks.length }}）</span></template>
      <template #extra>
        <a-space wrap>
          <a-button size="small" :disabled="!links.length" @click="toggleAllLinks">
            <CheckOutlined /> {{ allLinksSelected ? '取消全选' : '全选' }}
          </a-button>
          <a-button size="small" :disabled="!selectedLinkIds.length" @click="removeSelectedLinks"><DeleteOutlined /> 移除选中</a-button>
          <a-button size="small" :disabled="!failedLinks.length" @click="removeFailedLinks">移除失败</a-button>
          <a-button size="small" :disabled="!selectedLinks.length" @click="copyLinks(selectedLinks)"><CopyOutlined /> 复制选中</a-button>
          <a-button size="small" :disabled="!successfulLinks.length" @click="copyLinks(successfulLinks)"><DownloadOutlined /> 复制全部</a-button>
          <a-button size="small" :disabled="!selectedLinks.length" @click="openLinks(selectedLinks)">打开选中</a-button>
          <a-button size="small" :disabled="!successfulLinks.length" @click="openLinks(successfulLinks)">打开全部</a-button>
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
            <a-button size="small" type="link" @click="copyText(link.url, '链接已复制')"><CopyOutlined /></a-button>
            <a-button size="small" type="link" @click="openLinks([link])">打开</a-button>
            <a-button v-if="link.status === 'error' || link.status === 'expired'" size="small" type="link" @click="regenerateLink(link)"><ReloadOutlined /></a-button>
          </a-space>
          <a-button v-else-if="link.status === 'error' || link.status === 'expired'" size="small" type="link" @click="regenerateLink(link)">重试</a-button>
        </div>
      </div>
    </a-card>

    <a-empty v-else class="empty-links" description="尚未生成订阅链接" />

    <a-modal v-model:open="showImportDialog" title="批量导入订阅链接" ok-text="导入" cancel-text="取消" @ok="importLinks">
      <p class="muted">每行一个链接；也支持“邮箱 + 链接”，重复链接会自动跳过。</p>
      <a-textarea v-model:value="importText" :rows="10" placeholder="user@example.com https://...\nhttps://..." />
    </a-modal>
    </template>

    <template v-else>
      <a-card size="small" class="overage-card">
        <template #title><ThunderboltOutlined /> 超额设置</template>
        <template #extra>
          <span class="muted">已订阅 {{ subscribedAccounts.length }} · 可开启 {{ overageableAccounts.length }} · 已开启 {{ enabledOverageAccounts.length }}</span>
        </template>
        <div class="operation-toolbar">
          <a-button type="primary" :loading="settingOverage" :disabled="disabled || !overageableAccounts.length" @click="setOverage('ENABLED', 'eligible')">
            <ThunderboltOutlined /> 一键开启（{{ overageableAccounts.length }}）
          </a-button>
          <a-button :loading="settingOverage" :disabled="disabled || !subscribedAccounts.length" @click="setOverage('ENABLED', 'all')">
            <CheckCircleOutlined /> 全部开启（{{ subscribedAccounts.length }}）
          </a-button>
          <a-button danger :loading="settingOverage" :disabled="disabled || !enabledOverageAccounts.length" @click="setOverage('DISABLED', 'eligible')">
            关闭已开启超额（{{ enabledOverageAccounts.length }}）
          </a-button>
        </div>
        <a-progress
          v-if="overageItems.length"
          :percent="overageItems.length ? Math.round(overageCompletedCount / overageItems.length * 100) : 0"
          :status="settingOverage ? 'active' : undefined"
          :format="() => overageCompletedCount + '/' + overageItems.length"
        />
        <div v-if="overageItems.length" class="overage-result-list">
          <div v-for="item in overageItems" :key="item.accountId" class="overage-result-row">
            <span class="account-email">{{ item.email }}</span>
            <a-tag :color="overageStatusColor(item)">{{ overageStatusLabel(item) }}</a-tag>
            <span v-if="item.error" class="link-error" :title="item.error">{{ item.error }}</span>
          </div>
        </div>
        <a-alert
          v-if="!subscribedAccounts.length"
          class="inline-alert"
          type="info"
          show-icon
          message="没有检测到已订阅账号"
          description="请先在账户管理页刷新账号订阅状态；超额设置只适用于支持超额的付费账号。"
        />
        <div v-else class="overage-overview">
          <div class="overage-overview-head">
            <span>账号</span><span>订阅</span><span>超额能力</span><span>状态</span>
          </div>
          <div v-for="account in subscribedAccounts" :key="account.id" class="overage-overview-row">
            <span class="account-email" :title="account.email">{{ account.email || account.id }}</span>
            <span>{{ account.subscription.title || account.subscription.type }}</span>
            <span>{{ account.subscription.overageCapability || '未提供' }}</span>
            <a-tag :color="account.usage.resourceDetail?.overageEnabled ? 'green' : 'default'">
              {{ account.usage.resourceDetail?.overageEnabled ? '已开启' : '未开启' }}
            </a-tag>
          </div>
        </div>
      </a-card>
    </template>
  </div>
</template>

<style scoped>
.batch-subscription-panel { display: flex; flex-direction: column; gap: 12px; height: 100%; min-height: 0; overflow: auto; padding-bottom: 8px; }
.panel-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
.inner-tabs { display: flex; flex: 0 0 auto; gap: 6px; }
.section-title { margin: 0 0 4px; }
.header-hint { margin: 0; font-size: 12px; }
.panel-alert { flex: 0 0 auto; }
.preflight-card :deep(.ant-card-head-title), .plan-card :deep(.ant-card-head-title), .accounts-card :deep(.ant-card-head-title) { display: flex; align-items: center; gap: 6px; }
.preflight-summary, .blocked-list, .plan-toolbar, .account-toolbar, .operation-toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.switch-label { margin-left: 8px; color: var(--kal-muted); font-size: 12px; }
.blocked-list { margin-top: 10px; max-height: 82px; overflow: auto; }
.inline-alert { margin-top: 10px; }
.plan-select { min-width: 300px; max-width: 520px; }
.plan-cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 8px; margin-top: 12px; }
.plan-option { display: flex; flex-direction: column; align-items: flex-start; gap: 4px; padding: 10px 12px; border: 1px solid var(--kal-border); border-radius: 8px; background: var(--kal-card-bg); color: inherit; text-align: left; cursor: pointer; }
.plan-option:hover, .plan-option.selected { border-color: var(--kal-primary); background: color-mix(in srgb, var(--kal-primary) 7%, var(--kal-card-bg)); }
.plan-option span { color: var(--kal-primary); font-size: 12px; }
.plan-option small { color: var(--kal-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 100%; }
.account-toolbar { margin-bottom: 10px; }
.search-input { width: min(340px, 100%); }
.account-pick-list { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 4px 8px; max-height: 180px; overflow: auto; padding: 4px; border: 1px solid var(--kal-border); border-radius: 8px; }
.account-pick-item { display: flex; min-width: 0; margin: 0; padding: 6px 8px; border-radius: 6px; }
.account-pick-item:hover { background: var(--kal-block-bg); }
.account-email { max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.account-plan { margin-left: auto; padding-left: 8px; white-space: nowrap; font-size: 11px; }
.operation-card :deep(.ant-progress) { margin-top: 10px; margin-bottom: 0; }
.overage-card { min-height: 220px; }
.overage-result-list { display: flex; flex-direction: column; gap: 4px; max-height: 240px; overflow: auto; margin-top: 12px; border: 1px solid var(--kal-border); border-radius: 8px; padding: 4px; }
.overage-result-row { display: flex; align-items: center; gap: 8px; min-height: 34px; padding: 4px 8px; border-bottom: 1px solid var(--kal-border); }
.overage-result-row:last-child { border-bottom: 0; }
.overage-overview { display: flex; flex-direction: column; margin-top: 14px; border: 1px solid var(--kal-border); border-radius: 8px; overflow: auto; }
.overage-overview-head, .overage-overview-row { display: grid; grid-template-columns: minmax(200px, 1.6fr) minmax(120px, 1fr) minmax(150px, 1fr) 90px; align-items: center; gap: 8px; min-width: 620px; padding: 7px 10px; }
.overage-overview-head { color: var(--kal-muted); background: var(--kal-block-bg); font-size: 12px; }
.overage-overview-row { border-top: 1px solid var(--kal-border); font-size: 12px; }
.links-card { min-height: 220px; }
.link-list { display: flex; flex-direction: column; max-height: 360px; overflow: auto; border: 1px solid var(--kal-border); border-radius: 8px; }
.link-row { display: flex; align-items: center; gap: 8px; min-height: 48px; padding: 6px 10px; border-bottom: 1px solid var(--kal-border); }
.link-row:last-child { border-bottom: 0; }
.link-row.selected { background: color-mix(in srgb, var(--kal-primary) 7%, var(--kal-card-bg)); }
.link-main { display: flex; flex: 1 1 auto; min-width: 0; flex-direction: column; gap: 2px; }
.link-main strong, .link-url, .link-error { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.link-main strong { font-size: 13px; }
.link-url { color: var(--kal-muted); font-family: monospace; font-size: 11px; }
.link-error { color: #d46b08; font-size: 11px; }
.empty-links { flex: 1 1 auto; min-height: 100px; display: grid; place-items: center; }
.muted { color: var(--kal-muted); }
@media (max-width: 900px) {
  .plan-select { min-width: 220px; max-width: 100%; }
  .link-row { align-items: flex-start; flex-wrap: wrap; }
}
</style>
