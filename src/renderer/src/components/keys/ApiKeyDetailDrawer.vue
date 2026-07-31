<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { message } from 'ant-design-vue'
import {
  CheckCircleFilled,
  CopyOutlined,
  DownloadOutlined,
  EyeInvisibleOutlined,
  EyeOutlined,
  GlobalOutlined,
  SendOutlined,
  SwapOutlined,
  SyncOutlined
} from '@ant-design/icons-vue'
import RegionSelect from '@/components/common/RegionSelect.vue'
import { useKeysStore } from '@/stores/keys'
import { useSettingsStore } from '@/stores/settings'
import { copyText } from '@/utils/ui'
import { displayEmail as maskedEmail } from '@/utils/display'
import { formatCreditsPair, formatDateTime } from '@/utils/format'
import { regionLabel } from '@shared/regions'
import type { KeyEntry } from '@shared/types'

const props = defineProps<{ keyEntry: KeyEntry | null }>()
const emit = defineEmits<{ close: []; test: [KeyEntry]; edit: [KeyEntry]; select: [KeyEntry] }>()
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
/** 邮箱跟随全局隐私打码；上游未返回时占位 */
const emailText = computed(() => {
  const value = entry.value?.email
  return value ? maskedEmail(value, settingsStore.settings.privacyMode) : '-'
})
const maskedKey = computed(() => {
  const key = entry.value?.key || ''
  if (!key) return '-'
  if (!settingsStore.settings.privacyMode || showSecret.value) return key
  return `${key.slice(0, 8)}${'•'.repeat(24)}${key.slice(-8)}`
})
const isCurrent = computed(() => entry.value?.id === keysStore.data.activeKeyId)

watch(
  () => [props.keyEntry?.id, settingsStore.settings.privacyMode],
  () => { showSecret.value = false }
)

/** 切换逻辑复用卡片：交给父级 KeysView 处理（含网关未开启时的开启+冲突+重启流程） */
function onSwitch(): void {
  const target = entry.value
  if (!target || isCurrent.value) return
  emit('select', target)
}

// ============ 换区 ============
const regionOpen = ref(false)
const regionValue = ref('')
const savingRegion = ref(false)

function openRegion(): void {
  regionValue.value = entry.value?.region || ''
  regionOpen.value = true
}

async function submitRegion(): Promise<void> {
  const target = entry.value
  if (!target) return
  const next = regionValue.value.trim()
  if (!next) return void message.warning('请选择或填写区域')
  if (next === target.region) {
    regionOpen.value = false
    return
  }
  savingRegion.value = true
  try {
    const error = await keysStore.setRegion(target.id, next)
    if (error) return void message.error(error)
    regionOpen.value = false
    message.success(`区域已改为 ${next}，已重新同步额度`)
  } finally {
    savingRegion.value = false
  }
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
    <template v-if="entry" #footer>
      <a-button
        block
        :type="isCurrent ? 'default' : 'primary'"
        :style="isCurrent ? { color: '#52c41a', borderColor: '#52c41a' } : undefined"
        :disabled="isCurrent || !!busy"
        @click="onSwitch"
      >
        <template #icon>
          <CheckCircleFilled v-if="isCurrent" />
          <SwapOutlined v-else />
        </template>
        {{ isCurrent ? '当前使用' : '切换到该 Key' }}
      </a-button>
    </template>

    <template v-if="entry">
      <a-space style="margin-bottom: 16px" wrap>
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

      <a-alert
        message="API Key 可直接调用 Kiro 官方服务，请勿分享给他人。"
        type="warning"
        show-icon
        style="margin-bottom: 16px"
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
      <a-descriptions :column="1" size="small" bordered style="margin-bottom: 18px">
        <a-descriptions-item label="完整凭证">
          <div class="cell-row">
            <span class="mono cell-key" :title="showSecret || !settingsStore.settings.privacyMode ? entry.key : undefined">
              {{ maskedKey }}
            </span>
            <a-button type="link" size="small" class="cell-action" @click="copyKey">
              <template #icon><CopyOutlined /></template>
              复制
            </a-button>
          </div>
        </a-descriptions-item>
        <a-descriptions-item label="邮箱">{{ emailText }}</a-descriptions-item>
      </a-descriptions>

      <div class="section-title">基本信息</div>
      <a-descriptions :column="1" size="small" bordered style="margin-bottom: 18px">
        <a-descriptions-item label="状态">
          <a-tag :color="entry.lastError ? 'red' : entry.lastCheckedAt ? 'green' : 'default'">
            {{ entry.lastError ? '异常' : entry.lastCheckedAt ? '正常' : '未检查' }}
          </a-tag>
          <a-tag v-if="entry.id === keysStore.data.activeKeyId" color="green">当前使用</a-tag>
        </a-descriptions-item>
        <a-descriptions-item label="备注">{{ entry.note || '-' }}</a-descriptions-item>
        <a-descriptions-item label="区域">
          <div class="cell-row">
            <span>{{ regionLabel(entry.region) }}</span>
            <a-button type="link" size="small" class="cell-action" @click="openRegion">
              <template #icon><GlobalOutlined /></template>
              修改
            </a-button>
          </div>
        </a-descriptions-item>
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

      <a-modal
        v-model:open="regionOpen"
        title="修改所属区域"
        centered
        :confirm-loading="savingRegion"
        @ok="submitRegion"
      >
        <a-form layout="vertical">
          <a-form-item label="区域" required>
            <RegionSelect v-model:value="regionValue" />
          </a-form-item>
        </a-form>
        <a-alert
          type="warning"
          show-icon
          message="换区后该 Key 已缓存的订阅、额度与积分历史会被清空，需要重新同步。"
        />
      </a-modal>
    </template>
  </a-drawer>
</template>

<style scoped>
.section-title { display: flex; align-items: center; margin: 4px 0 8px; font-weight: 600; }
/* 表格单元格里值占满、右侧操作按钮对齐（区域与凭证复用同一布局） */
.cell-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.cell-key { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cell-action { flex: 0 0 auto; padding: 0; height: auto; }
.mono { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; font-size: 12px; }
.muted { color: var(--kal-muted); }
</style>
