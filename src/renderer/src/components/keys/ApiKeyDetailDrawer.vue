<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { message } from 'ant-design-vue'
import {
  CheckCircleFilled,
  CopyOutlined,
  DownloadOutlined,
  EyeInvisibleOutlined,
  EyeOutlined,
  SendOutlined,
  SwapOutlined,
  SyncOutlined
} from '@ant-design/icons-vue'
import { useKeysStore } from '@/stores/keys'
import { useSettingsStore } from '@/stores/settings'
import { confirmUseApiKey, copyText } from '@/utils/ui'
import { formatCreditsPair, formatDateTime, usageColor } from '@/utils/format'
import { regionLabel } from '@shared/regions'
import type { KeyEntry } from '@shared/types'

const props = defineProps<{ keyEntry: KeyEntry | null }>()
const emit = defineEmits<{ close: []; test: [KeyEntry]; edit: [KeyEntry] }>()
const keysStore = useKeysStore()
const settingsStore = useSettingsStore()
const showSecret = ref(false)
const busy = ref('')

const entry = computed(() =>
  props.keyEntry
    ? keysStore.data.keys.find((item) => item.id === props.keyEntry?.id) ?? props.keyEntry
    : null
)
const precision = computed(() => settingsStore.settings.usagePrecision)
const ratio = computed(() => {
  const target = entry.value
  if (!target?.totalCredits) return 0
  return Math.min(1, Math.max(0, (target.usedCredits || 0) / target.totalCredits))
})
const maskedKey = computed(() => {
  const key = entry.value?.key || ''
  if (!key) return '-'
  if (!settingsStore.settings.privacyMode || showSecret.value) return key
  return `${key.slice(0, 8)}${'•'.repeat(24)}${key.slice(-8)}`
})
const confirmationKey = computed(() => {
  const key = entry.value?.key || ''
  if (!key) return '-'
  return settingsStore.settings.privacyMode
    ? `${key.slice(0, 8)}${'•'.repeat(24)}${key.slice(-8)}`
    : key
})
const isCurrent = computed(() => entry.value?.id === keysStore.data.activeKeyId)

watch(
  () => [props.keyEntry?.id, settingsStore.settings.privacyMode],
  () => { showSecret.value = false }
)

async function applyCurrentSelection(target: KeyEntry): Promise<void> {
  if (busy.value) return
  busy.value = 'select'
  try {
    const error = await keysStore.select(target.id)
    if (error) return void message.error(error)
    message.success('已切换到该 API Key')
  } finally {
    busy.value = ''
  }
}

function toggleCurrent(): void {
  const target = entry.value
  if (!target || isCurrent.value || busy.value) return
  confirmUseApiKey(confirmationKey.value, () => applyCurrentSelection(target))
}

async function sync(): Promise<void> {
  const target = entry.value
  if (!target || busy.value) return
  busy.value = 'sync'
  try {
    const error = await keysStore.sync(target.id)
    if (error) return void message.error(error)
    message.success('订阅与额度已更新')
  } finally {
    busy.value = ''
  }
}

function copyKey(): void {
  const target = entry.value
  if (target) copyText(target.key, '完整 API Key 已复制')
}

async function exportKey(): Promise<void> {
  const target = entry.value
  if (!target) return
  const result = await window.api.exportToFile(target.key + '\n', `kiro-api-key-${target.id}.txt`)
  if (!result.success) message.error(result.error || '导出失败')
  else if (result.data?.saved) message.success('已导出')
}

function subscriptionColor(tier?: string): string {
  if (tier === 'power') return 'gold'
  if (tier === 'pro+') return 'purple'
  if (tier === 'pro') return 'blue'
  if (tier === 'free') return 'default'
  return 'cyan'
}
</script>

<template>
  <a-drawer
    :open="!!entry"
    :title="entry?.note || 'API Key 详情'"
    width="560"
    placement="right"
    @close="emit('close')"
  >
    <template v-if="entry">
      <a-space style="margin-bottom: 16px" wrap>
        <a-button
          :type="isCurrent ? 'default' : 'primary'"
          :style="isCurrent ? { color: '#52c41a', borderColor: '#52c41a' } : undefined"
          :loading="busy === 'select'"
          :disabled="isCurrent || (!!busy && busy !== 'select')"
          @click="toggleCurrent"
        >
          <template #icon>
            <CheckCircleFilled v-if="isCurrent" />
            <SwapOutlined v-else />
          </template>
          {{ isCurrent ? '当前使用' : '切换到该 Key' }}
        </a-button>
        <a-button
          :loading="busy === 'sync'"
          :disabled="!!busy && busy !== 'sync'"
          @click="sync"
        >
          <template #icon><SyncOutlined /></template>刷新用量
        </a-button>
        <a-button @click="emit('test', entry)">
          <template #icon><SendOutlined /></template>在线测活
        </a-button>
        <a-button @click="emit('edit', entry)">修改备注</a-button>
        <a-button @click="exportKey">
          <template #icon><DownloadOutlined /></template>导出
        </a-button>
      </a-space>

      <a-alert
        v-if="entry.lastError"
        type="error"
        show-icon
        :message="entry.lastError"
        style="margin-bottom: 16px"
      />

      <div class="section-title">基本信息</div>
      <a-descriptions :column="1" size="small" bordered style="margin-bottom: 18px">
        <a-descriptions-item label="状态">
          <a-tag :color="entry.lastError ? 'red' : entry.lastCheckedAt ? 'green' : 'default'">
            {{ entry.lastError ? '异常' : entry.lastCheckedAt ? '正常' : '未检查' }}
          </a-tag>
          <a-tag v-if="entry.id === keysStore.data.activeKeyId" color="green">当前使用</a-tag>
        </a-descriptions-item>
        <a-descriptions-item label="备注">{{ entry.note || '-' }}</a-descriptions-item>
        <a-descriptions-item label="区域">{{ regionLabel(keysStore.data.region) }}</a-descriptions-item>
        <a-descriptions-item label="添加时间">{{ formatDateTime(entry.createdAt) }}</a-descriptions-item>
        <a-descriptions-item label="最后同步">{{ formatDateTime(entry.lastCheckedAt) }}</a-descriptions-item>
      </a-descriptions>

      <div class="section-title">订阅与积分</div>
      <a-descriptions :column="1" size="small" bordered style="margin-bottom: 12px">
        <a-descriptions-item label="套餐">
          <a-tag :color="subscriptionColor(entry.tier)">{{ entry.subscription || '未知' }}</a-tag>
        </a-descriptions-item>
        <a-descriptions-item label="额度">
          {{ formatCreditsPair(entry.usedCredits, entry.totalCredits, precision) }}
        </a-descriptions-item>
      </a-descriptions>
      <a-progress
        :percent="Math.round(ratio * 10000) / 100"
        :stroke-color="usageColor(ratio)"
        style="margin-bottom: 18px"
      />

      <div class="section-title">
        API Key
        <a-button
          v-if="settingsStore.settings.privacyMode"
          type="link"
          size="small"
          @click="showSecret = !showSecret"
        >
          <template #icon>
            <EyeInvisibleOutlined v-if="showSecret" />
            <EyeOutlined v-else />
          </template>
          {{ showSecret ? '隐藏' : '显示' }}
        </a-button>
      </div>
      <div class="secret-head">
        <span class="muted">完整凭证</span>
        <a-button type="link" size="small" @click="copyKey">
          <template #icon><CopyOutlined /></template>复制
        </a-button>
      </div>
      <div class="token-box mono">{{ maskedKey }}</div>
      <a-alert
        message="API Key 可直接调用 Kiro 官方服务，请勿分享给他人。"
        type="warning"
        show-icon
        style="margin-top: 12px"
      />
    </template>
  </a-drawer>
</template>

<style scoped>
.section-title { display: flex; align-items: center; margin: 4px 0 8px; font-weight: 600; }
.secret-head { display: flex; align-items: center; justify-content: space-between; font-size: 12px; }
.token-box { padding: 10px 12px; border-radius: 8px; background: var(--kal-code-bg); overflow-wrap: anywhere; }
.mono { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; font-size: 12px; }
.muted { color: var(--kal-muted); }
</style>
