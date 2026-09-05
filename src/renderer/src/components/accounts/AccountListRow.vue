<script setup lang="ts">
import { computed } from 'vue'
import {
  CalendarOutlined,
  ClockCircleOutlined,
  CopyOutlined,
  TagsOutlined,
  WarningOutlined
} from '@ant-design/icons-vue'
import AccountActions from '@/components/accounts/AccountActions.vue'
import { useSettingsStore } from '@/stores/settings'
import { displayEmail } from '@/utils/display'
import {
  STATUS_META,
  formatCreditsPair,
  formatDate,
  subscriptionLabel,
  subscriptionMeta,
  tokenLife,
  usageColor
} from '@/utils/format'
import { copyText } from '@/utils/ui'
import type { Account, AccountTag } from '@shared/types'

const props = defineProps<{
  account: Account
  tags: AccountTag[]
  selected: boolean
  busyAction?: string | null
}>()

const emit = defineEmits<{
  'toggle-select': [boolean]
  detail: []
  edit: []
  remove: []
  logout: []
  'refresh-key': []
  'refresh-usage': []
  'copy-oidc': []
  'assign-tags': []
  'payment-link': []
  test: []
  portal: []
  usage: []
}>()

const settingsStore = useSettingsStore()
const privacy = computed(() => settingsStore.settings.privacyMode)
const precision = computed(() => settingsStore.settings.usagePrecision)

const email = computed(() => displayEmail(props.account.email, privacy.value))
const status = computed(() => STATUS_META[props.account.status])
const subscription = computed(() => subscriptionMeta(props.account.subscription.type))
const subscriptionText = computed(() => subscriptionLabel(props.account.subscription))

const accountTags = computed(() => {
  const selected = new Set(props.account.tagIds ?? [])
  return props.tags.filter((tag) => selected.has(tag.id))
})
const visibleTags = computed(() => accountTags.value.slice(0, 2))
const hiddenTagCount = computed(() => Math.max(0, accountTags.value.length - visibleTags.value.length))

const rawPercent = computed(() => Math.min(100, Math.max(0, (props.account.usage.percentUsed || 0) * 100)))
const percent = computed(() => Math.round(rawPercent.value))
const percentText = computed(() => {
  if (rawPercent.value <= 0) return '0'
  if (rawPercent.value >= 100) return '100'
  return rawPercent.value.toFixed(2)
})
const barColor = computed(() => usageColor(props.account.usage.percentUsed || 0))
const usageText = computed(() =>
  formatCreditsPair(props.account.usage.current, props.account.usage.limit, precision.value)
)

const expiryDate = computed(() =>
  formatDate(props.account.subscription.expiresAt ?? props.account.usage.nextResetDate)
)

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

function copyEmail(): void {
  copyText(props.account.email, '账号邮箱已复制')
}
</script>

<template>
  <div
    class="account-list-row"
    :class="{ 'is-selected': props.selected, 'is-active': props.account.isActive }"
    @click="emit('toggle-select', !props.selected)"
  >
    <div class="select-cell">
      <a-checkbox
        :checked="props.selected"
        @click.stop
        @change="(event: any) => emit('toggle-select', event.target.checked)"
      />
    </div>

    <div class="account-state-cell">
      <a-tag :color="status.color">{{ status.text }}</a-tag>
      <a-tag :color="subscription.color" :bordered="false">{{ subscriptionText }}</a-tag>
    </div>

    <div class="identity-cell">
      <div class="identity-line">
        <button
          class="email email-detail"
          type="button"
          :title="privacy ? '查看账号详情' : props.account.email"
          @click.stop="emit('detail')"
        >
          {{ email }}
        </button>
        <a-tooltip title="复制账号邮箱">
          <button class="copy-email" type="button" aria-label="复制账号邮箱" @click.stop="copyEmail">
            <CopyOutlined />
          </button>
        </a-tooltip>
      </div>
      <AccountActions
        class="identity-actions"
        :active="props.account.isActive"
        :busy-action="props.busyAction"
        @logout="emit('logout')"
        @refresh-key="emit('refresh-key')"
        @refresh-usage="emit('refresh-usage')"
        @copy-oidc="emit('copy-oidc')"
        @payment-link="emit('payment-link')"
        @test="emit('test')"
        @portal="emit('portal')"
        @edit="emit('edit')"
        @remove="emit('remove')"
      />
    </div>

    <div class="labels-cell">
      <div class="account-flags">
        <a-tag v-if="props.account.isActive" color="green" :bordered="false">当前使用</a-tag>
        <a-tooltip v-if="props.account.lastError" placement="top">
          <template #title><span class="error-tip">{{ props.account.lastError }}</span></template>
          <WarningOutlined class="error-icon" />
        </a-tooltip>
      </div>
      <button class="account-tags" type="button" title="给账号添加或修改标签" @click.stop="emit('assign-tags')">
        <TagsOutlined class="muted" />
        <template v-if="visibleTags.length">
          <a-tag
            v-for="tag in visibleTags"
            :key="tag.id"
            :color="tag.color"
            :bordered="false"
            class="account-tag"
          >
            {{ tag.name }}
          </a-tag>
          <span v-if="hiddenTagCount" class="more-tags muted">+{{ hiddenTagCount }}</span>
        </template>
        <span v-else class="muted">添加标签</span>
      </button>
    </div>

    <div class="usage-cell" title="点击查看积分变化" @click.stop="emit('usage')">
      <div class="usage-summary">
        <strong :style="{ color: barColor }">{{ percentText }}%</strong>
        <span class="usage-number">{{ usageText }}</span>
      </div>
      <div class="usage-progress">
        <span :style="{ width: `${percent}%`, background: barColor }" />
      </div>
    </div>

    <div class="time-cell">
      <span class="time-line" title="用量重置时间">
        <CalendarOutlined /> 重置 {{ formatDate(props.account.usage.nextResetDate) }}
      </span>
      <span class="time-line muted" title="订阅到期时间">
        到期 {{ expiryDate }}
        <template v-if="props.account.subscription.daysRemaining !== undefined">
          · {{ props.account.subscription.daysRemaining }} 天
        </template>
      </span>
      <span class="time-line" :class="tokenState.warn ? 'warn' : 'muted'">
        <ClockCircleOutlined /> Token {{ tokenState.text }}
      </span>
    </div>

  </div>
</template>

<style scoped>
.account-list-row {
  display: grid;
  grid-template-columns: 28px 110px minmax(260px, 1.3fr) 180px minmax(220px, 0.9fr) 170px;
  gap: 10px;
  align-items: center;
  width: 100%;
  min-width: 1020px;
  height: 100%;
  padding: 7px 10px;
  box-sizing: border-box;
  border-bottom: 1px solid var(--kal-border);
  background: var(--kal-card-bg);
  cursor: pointer;
  transition: background 0.15s ease, box-shadow 0.15s ease;
}

.account-list-row:hover {
  background: color-mix(in srgb, var(--kal-primary) 4%, var(--kal-card-bg));
}

.account-list-row.is-selected {
  background: color-mix(in srgb, var(--kal-primary) 8%, var(--kal-card-bg));
  box-shadow: 3px 0 0 var(--kal-primary) inset;
}

.account-list-row.is-active {
  box-shadow: 3px 0 0 #52c41a inset;
}

.account-list-row.is-selected.is-active {
  box-shadow: 3px 0 0 #52c41a inset, 6px 0 0 var(--kal-primary) inset;
}

.select-cell {
  display: flex;
  justify-content: center;
}

.account-state-cell,
.identity-cell,
.labels-cell,
.usage-cell,
.time-cell {
  min-width: 0;
}

.account-state-cell {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 4px;
}

.account-state-cell :deep(.ant-tag) {
  max-width: 100%;
  margin: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}

.identity-cell {
  line-height: 1.35;
}

.identity-line {
  display: flex;
  align-items: center;
  min-width: 0;
}

.email {
  display: block;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
  font-weight: 600;
}

.email-detail {
  padding: 0;
  border: 0;
  background: transparent;
  color: inherit;
  text-align: left;
  cursor: pointer;
}

.email-detail:hover {
  color: var(--kal-primary);
}

.identity-actions {
  margin-top: 2px;
}

.copy-email {
  display: inline-flex;
  flex: 0 0 auto;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  padding: 0;
  border: 0;
  border-radius: 5px;
  background: transparent;
  color: var(--kal-muted);
  cursor: pointer;
}

.copy-email:hover {
  background: color-mix(in srgb, var(--kal-primary) 8%, transparent);
  color: var(--kal-primary);
}

.labels-cell {
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.account-flags,
.account-tags {
  display: flex;
  align-items: center;
  min-width: 0;
  gap: 3px;
  overflow: hidden;
  white-space: nowrap;
}

.account-flags {
  min-height: 20px;
}

.account-flags :deep(.ant-tag),
.account-tags :deep(.ant-tag) {
  height: 20px;
  margin: 0;
  padding-inline: 6px;
  font-size: 11px;
  line-height: 18px;
}

.account-tags {
  width: max-content;
  max-width: 100%;
  height: 22px;
  padding: 0;
  border: 0;
  background: transparent;
  color: inherit;
  font: inherit;
  font-size: 11px;
  cursor: pointer;
}

.account-tag {
  max-width: 86px;
  overflow: hidden;
  text-overflow: ellipsis;
}

.more-tags {
  font-size: 11px;
}

.error-icon {
  flex: 0 0 auto;
  color: #ff4d4f;
}

.error-tip {
  white-space: pre-wrap;
  word-break: break-all;
}

.usage-cell {
  padding: 6px 8px;
  border-radius: 8px;
  background: var(--kal-block-bg);
  cursor: pointer;
}

.usage-cell:hover {
  background: var(--kal-code-bg);
}

.usage-summary {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
}

.usage-summary strong {
  flex: 0 0 auto;
  font-size: 15px;
  line-height: 1.2;
}

.usage-number {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 11.5px;
}

.usage-progress {
  height: 5px;
  margin-top: 6px;
  overflow: hidden;
  border-radius: 3px;
  background: var(--kal-bar-off);
}

.usage-progress span {
  display: block;
  height: 100%;
  max-width: 100%;
  border-radius: inherit;
}

.time-cell {
  display: flex;
  flex-direction: column;
  gap: 2px;
  font-size: 11px;
  line-height: 1.35;
}

.time-line {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.warn {
  color: #fa8c16;
}
</style>
