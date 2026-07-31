<script setup lang="ts">
import { computed, type Component } from 'vue'
import {
  CalendarOutlined,
  ClockCircleOutlined,
  CopyOutlined,
  DeleteOutlined,
  EditOutlined,
  InfoCircleOutlined,
  KeyOutlined,
  LoginOutlined,
  LogoutOutlined,
  SyncOutlined,
  ThunderboltOutlined
} from '@ant-design/icons-vue'
import { useSettingsStore } from '@/stores/settings'
import {
  IDP_META,
  STATUS_META,
  SUBSCRIPTION_META,
  formatCheckedAt,
  formatCreditsPair,
  formatDate,
  formatDateTime,
  subscriptionLabel,
  tokenLife,
  usageColor
} from '@/utils/format'
import { displayEmail, displayName } from '@/utils/display'
import { now } from '@/utils/now'
import type { Account } from '@shared/types'

const props = defineProps<{
  account: Account
  selected: boolean
  /** 正在进行中的操作，只让对应按钮转圈 */
  busyAction?: string | null
}>()

const busy = computed(() => !!props.busyAction)

const emit = defineEmits<{
  'toggle-select': [boolean]
  detail: []
  edit: []
  remove: []
  switch: []
  logout: []
  'refresh-key': []
  'refresh-usage': []
  'copy-token': []
  test: []
  /** 点用量区域查看积分变化日志 */
  usage: []
}>()

const settingsStore = useSettingsStore()

const precision = computed(() => settingsStore.settings.usagePrecision)

const privacy = computed(() => settingsStore.settings.privacyMode)

const email = computed(() => displayEmail(props.account.email, privacy.value))
const nickname = computed(() => displayName(props.account, privacy.value))

/** 使用率百分比原始值，用量条与文案各自再做取整 */
const rawPercent = computed(() => (props.account.usage.percentUsed || 0) * 100)

const percent = computed(() => Math.min(100, Math.round(rawPercent.value)))

/** 百分比文案：0 和 100 取整，其间保留两位小数 */
const percentText = computed(() => {
  const value = Math.min(100, Math.max(0, rawPercent.value))
  if (value <= 0) return '0'
  if (value >= 100) return '100'
  return value.toFixed(2)
})

/** 用量与积分的更新时间：当天显示时分秒，跨天补上年月日 */
const usageUpdatedAt = computed(() => formatCheckedAt(props.account.lastCheckedAt, now.value))

/** 分段用量条：固定竖条数量，按使用率点亮相应根数 */
const BAR_COUNT = 40
const filledBars = computed(() => Math.round((percent.value / 100) * BAR_COUNT))
const barColor = computed(() => usageColor(props.account.usage.percentUsed || 0))

const status = computed(() => STATUS_META[props.account.status])
const idp = computed(() => IDP_META[props.account.idp])
const subscription = computed(() => SUBSCRIPTION_META[props.account.subscription.type])
/** 订阅展示名：优先接口给的标题 */
const subscriptionText = computed(() => subscriptionLabel(props.account.subscription))

const daysRemaining = computed(() => props.account.subscription.daysRemaining)

/** 订阅到期时间：优先订阅字段，回退到用量重置日期 */
const expiryDate = computed(() =>
  formatDate(props.account.subscription.expiresAt ?? props.account.usage.nextResetDate)
)

/** 额度明细行：基础 / 试用 / 奖励，各自带到期时间 */
const quotaRows = computed(() => {
  const usage = props.account.usage
  const p = precision.value
  const rows: { key: string; color: string; label: string; value: string; expiry?: string }[] = []
  if (usage.baseLimit) {
    rows.push({
      key: 'base',
      color: '#1677ff',
      label: '基础',
      value: formatCreditsPair(usage.baseCurrent, usage.baseLimit, p),
      expiry: usage.nextResetDate ? formatDate(usage.nextResetDate) : undefined
    })
  }
  if (usage.freeTrialLimit) {
    rows.push({
      key: 'trial',
      color: '#722ed1',
      label: '试用',
      value: formatCreditsPair(usage.freeTrialCurrent, usage.freeTrialLimit, p),
      expiry: usage.freeTrialExpiry ? formatDate(usage.freeTrialExpiry) : undefined
    })
  }
  for (const bonus of usage.bonuses ?? []) {
    rows.push({
      key: `bonus-${bonus.code}`,
      color: '#13c2c2',
      label: bonus.name,
      value: formatCreditsPair(bonus.current, bonus.limit, p),
      expiry: bonus.expiresAt ? formatDate(bonus.expiresAt) : undefined
    })
  }
  return rows
})

/** Access Token 剩余有效期，不足 10 分钟时标黄提醒 */
const tokenState = computed(() => {
  const life = tokenLife(props.account.credentials.expiresAt, 'round')
  switch (life.state) {
    case 'unknown':
      return { text: '未知', warn: true }
    case 'expired':
      return { text: '已过期', warn: true }
    case 'minutes':
      return { text: `${life.minutes} 分钟`, warn: life.minutes < 10 }
    default:
      return { text: `${life.hours} 小时`, warn: false }
  }
})

type ActionKey =
  | 'switch'
  | 'logout'
  | 'refresh-key'
  | 'refresh-usage'
  | 'copy-token'
  | 'test'
  | 'detail'
  | 'edit'
  | 'remove'

interface CardAction {
  key: ActionKey
  title: string
  icon: Component
  danger?: boolean
  color?: string
}

/** 首个按钮随登录状态切换：已登录显示退出登录，未登录显示登录 */
const actions = computed<CardAction[]>(() => [
  props.account.isActive
    ? {
        key: 'logout',
        title: '退出登录（清理 Kiro IDE 凭证）',
        icon: LogoutOutlined,
        color: '#52c41a'
      }
    : { key: 'switch', title: '登录此账号（写入 Kiro IDE）', icon: LoginOutlined },
  { key: 'refresh-key', title: '刷新密钥', icon: KeyOutlined },
  { key: 'refresh-usage', title: '刷新用量与积分', icon: SyncOutlined },
  { key: 'copy-token', title: '复制凭证 JSON', icon: CopyOutlined },
  { key: 'test', title: '测活（发一次真实对话）', icon: ThunderboltOutlined },
  { key: 'detail', title: '查看详情', icon: InfoCircleOutlined },
  { key: 'edit', title: '编辑', icon: EditOutlined },
  { key: 'remove', title: '删除', icon: DeleteOutlined, danger: true }
])

/**
 * 动作按钮统一派发。
 * emit 的重载签名不接受联合类型，这里收窄成「无参事件名」的形态再调用；
 * ActionKey 已经限定了取值范围，不会派发出未声明的事件。
 */
const emitAction = emit as (event: ActionKey) => void

function trigger(key: ActionKey): void {
  emitAction(key)
}
</script>

<template>
  <div
    class="account-card"
    :class="{ 'is-selected': props.selected, 'is-active': props.account.isActive }"
  >
    <div class="card-head">
      <a-checkbox
        :checked="props.selected"
        @change="(e: any) => emit('toggle-select', e.target.checked)"
      />
      <div class="identity" @click="emit('detail')">
        <span class="email" :title="privacy ? undefined : props.account.email">{{ email }}</span>
        <span class="nickname">{{ nickname }}</span>
      </div>
      <a-tag :color="status.color" class="status-tag">{{ status.text }}</a-tag>
    </div>

    <div class="tag-row">
      <a-tag :color="subscription.color" :bordered="false">
        {{ subscriptionText }}
      </a-tag>
      <a-tag :color="idp.color" :bordered="false">{{ idp.text }}</a-tag>
      <a-tag v-if="props.account.isActive" color="green" :bordered="false">当前使用</a-tag>
    </div>

    <div class="usage-block" title="点击查看积分变化" @click="emit('usage')">
      <div class="usage-head">
        <span class="usage-title">
          <span class="muted">使用量</span>
          <span class="usage-updated muted" :title="`用量与积分更新于 ${formatDateTime(props.account.lastCheckedAt)}`">
            {{ usageUpdatedAt }}
          </span>
        </span>
        <strong class="usage-percent" :style="{ color: barColor }">
          {{ percentText }}<small>%</small>
        </strong>
      </div>
      <div class="usage-bars" :style="{ '--bar-on': barColor }">
        <span
          v-for="i in BAR_COUNT"
          :key="i"
          class="bar"
          :class="{ on: i <= filledBars }"
        />
      </div>
      <div class="usage-foot">
        <span class="usage-number">
          {{ formatCreditsPair(props.account.usage.current, props.account.usage.limit, precision) }}
        </span>
        <span class="muted">
          <CalendarOutlined />
          {{ formatDate(props.account.usage.nextResetDate) }} 重置
        </span>
      </div>
    </div>

    <div class="quota-block">
      <div v-for="row in quotaRows" :key="row.key" class="quota-row">
        <span class="dot" :style="{ background: row.color }" />
        <span class="quota-label muted">{{ row.label }}</span>
        <span class="quota-value">{{ row.value }}</span>
        <span v-if="row.expiry" class="quota-expiry muted">至 {{ row.expiry }}</span>
      </div>
      <div class="quota-row">
        <span class="dot" style="background: #fa8c16" />
        <span class="quota-label muted">订阅</span>
        <span class="quota-value">
          {{ daysRemaining !== undefined ? `剩 ${daysRemaining} 天` : '周期未知' }}
        </span>
        <span class="quota-expiry muted">到期 {{ expiryDate }}</span>
      </div>
    </div>

    <a-tooltip v-if="props.account.lastError" placement="topLeft">
      <template #title>
        <span class="error-tip">{{ props.account.lastError }}</span>
      </template>
      <div class="error-line">{{ props.account.lastError }}</div>
    </a-tooltip>

    <div class="card-foot">
      <div class="meta">
        <span :class="tokenState.warn ? 'warn' : 'muted'">
          <ClockCircleOutlined />
          Token {{ tokenState.text }}
        </span>
      </div>
      <div class="action-row">
        <a-tooltip v-for="item in actions" :key="item.key" :title="item.title">
          <a-button
            type="text"
            size="small"
            class="action-btn"
            :danger="item.danger"
            :style="item.color ? { color: item.color } : undefined"
            :loading="props.busyAction === item.key"
            :disabled="busy && props.busyAction !== item.key"
            @click="trigger(item.key)"
          >
            <template #icon><component :is="item.icon" /></template>
          </a-button>
        </a-tooltip>
      </div>
    </div>
  </div>
</template>

<style scoped>
.account-card {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 16px 16px 8px;
  border: 1px solid var(--kal-border);
  border-radius: 16px;
  background: var(--kal-card-bg);
  transition:
    border-color 0.16s ease,
    box-shadow 0.16s ease,
    transform 0.16s ease;
}

.account-card:hover {
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.08);
  transform: translateY(-1px);
}

.account-card.is-selected {
  border-color: var(--kal-primary);
  box-shadow: 0 0 0 1px var(--kal-primary) inset;
}

/* 当前使用的账号：只用绿边标识，背景保持和其它卡片一致 */
.account-card.is-active {
  border-color: #52c41a;
}

.card-head {
  display: flex;
  align-items: flex-start;
  gap: 10px;
}

.identity {
  flex: 1 1 auto;
  min-width: 0;
  cursor: pointer;
  line-height: 1.35;
}

.email,
.nickname {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.email {
  font-weight: 600;
  font-size: 13.5px;
}

.identity:hover .email {
  color: var(--kal-primary);
}

.nickname {
  font-size: 12px;
  color: var(--kal-muted);
}

.status-tag {
  margin: 0;
  flex: 0 0 auto;
}

.tag-row {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 0;
}

.usage-block {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 12px;
  border-radius: 12px;
  background: var(--kal-block-bg);
  cursor: pointer;
  transition: background 0.16s ease;
}

.usage-block:hover {
  background: var(--kal-code-bg);
}

.usage-head,
.usage-foot {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  font-size: 12.5px;
  gap: 8px;
}

.usage-title {
  display: flex;
  align-items: baseline;
  gap: 6px;
  min-width: 0;
}

/* 更新时间是次要信息，字号更小，空间不足时省略 */
.usage-updated {
  font-size: 11px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.usage-percent {
  font-size: 20px;
  font-weight: 700;
  line-height: 1;
  flex: 0 0 auto;
}

.usage-percent small {
  font-size: 12px;
  font-weight: 700;
  margin-left: 1px;
}

/* 分段用量条 */
.usage-bars {
  display: flex;
  align-items: stretch;
  gap: 2px;
  height: 14px;
  margin: 8px 0 10px;
}

.bar {
  flex: 1 1 0;
  border-radius: 2px;
  background: var(--kal-bar-off);
  transition:
    background 0.2s ease,
    opacity 0.2s ease;
}

.bar.on {
  background: var(--bar-on);
}

.usage-number {
  font-weight: 600;
}

.usage-foot span:last-child {
  white-space: nowrap;
}

/* 额度明细 */
.quota-block {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px 12px;
  border-radius: 12px;
  background: var(--kal-block-bg);
}

.quota-row {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11.5px;
  line-height: 1.4;
}

.quota-label {
  flex: 0 0 auto;
  max-width: 90px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.quota-value {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.quota-expiry {
  flex: 0 0 auto;
  white-space: nowrap;
}

.dot {
  flex: 0 0 auto;
  width: 6px;
  height: 6px;
  border-radius: 50%;
}

.error-line {
  font-size: 11.5px;
  color: #ff4d4f;
  background: rgba(255, 77, 79, 0.08);
  border-radius: 8px;
  padding: 5px 8px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  cursor: help;
}

/* 卡片里一行截断，Tooltip 里要能完整换行展示（接口原始返回可能很长） */
.error-tip {
  white-space: pre-wrap;
  word-break: break-all;
}

.card-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  border-top: 1px solid var(--kal-border);
  padding: 6px 0;
  margin-top: auto;
}

.meta {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  flex-wrap: wrap;
  gap: 2px 10px;
  font-size: 11.5px;
  line-height: 1.4;
}

.meta > span {
  white-space: nowrap;
}

.warn {
  color: #fa8c16;
}

.action-row {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 0;
}

.action-btn {
  width: 24px;
  min-width: 24px;
  height: 24px;
  padding: 0;
}

.action-btn :deep(.anticon) {
  font-size: 13px;
}
</style>
