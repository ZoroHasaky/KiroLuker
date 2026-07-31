<script setup lang="ts">
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import { CheckCircleFilled, ExclamationCircleOutlined } from '@ant-design/icons-vue'
import { message } from 'ant-design-vue'
import { useAccountsStore, type AccountTaskType } from '@/stores/accounts'
import { useKeysStore } from '@/stores/keys'
import { useSettingsStore } from '@/stores/settings'
import { displayEmail, displayKey } from '@/utils/display'

const route = useRoute()
const accountsStore = useAccountsStore()
const keysStore = useKeysStore()
const settingsStore = useSettingsStore()

const title = computed(() => (route.meta.title as string) || '主页')

const accountTaskLabels: Record<AccountTaskType, string> = {
  'import-validation': '批量导入校验中',
  'account-key-refresh': '正在刷新账户密钥',
  'account-usage-refresh': '正在刷新账户用量与积分'
}
const accountTaskLabel = computed(() => accountTaskLabels[accountsStore.task.type])

/** IDE 当前账号只在账户管理页展示，其他页面保持页头干净 */
const showIdeStatus = computed(() => route.name === 'accounts')
const showApiKeyStatus = computed(() => route.name === 'keys')

function keyLabel(entry: { key: string; note?: string }): string {
  const shownKey = displayKey(entry.key, settingsStore.settings.privacyMode)
  return entry.note ? `${entry.note} · ${shownKey}` : shownKey
}

const effectiveKeyLabel = computed(() => {
  const entry = keysStore.effectiveKey
  return entry ? keyLabel(entry) : null
})
const selectedKeyLabel = computed(() => {
  const entry = keysStore.activeKey
  return entry ? keyLabel(entry) : null
})
const gatewayStatusLoaded = computed(() => keysStore.status !== null)
const gatewayEnabled = computed(() => keysStore.status?.enabled ?? keysStore.data.enabled)
/**
 * 接管判定统一用 ideTakenOver：只看 endpointsBound 会在 Kiro IDE 回写清空 settings.json 后
 * 把正常转发误报成异常（IDE 内存里仍持有本地端点，请求照旧走网关）。
 */
const gatewayOwnsIde = computed(() => keysStore.status?.ideTakenOver === true)

async function detectCurrentApiKey(): Promise<void> {
  const error = await keysStore.detectCurrentApiKey()
  if (error) message.error(error)
}

const activeLabel = computed(() => {
  const account = accountsStore.activeAccount
  if (!account) return null
  // 打码时昵称同样会暴露邮箱前缀，所以只显示打码后的邮箱
  if (settingsStore.settings.privacyMode) return displayEmail(account.email, true)
  return account.nickname ? `${account.nickname} · ${account.email}` : account.email
})
</script>

<template>
  <header class="app-titlebar">
    <strong>{{ title }}</strong>

    <div
      v-if="accountsStore.task.running"
      style="display: flex; align-items: center; gap: 8px"
    >
      <a-progress
        :percent="Math.round((accountsStore.task.done / Math.max(1, accountsStore.task.total)) * 100)"
        :show-info="false"
        size="small"
        style="width: 140px; margin: 0"
      />
      <span class="muted" style="font-size: 12px; white-space: nowrap">
        {{ accountTaskLabel }} {{ accountsStore.task.done }}/{{ accountsStore.task.total }}
      </span>
    </div>

    <div
      v-if="keysStore.usageTask.running"
      style="display: flex; align-items: center; gap: 8px"
    >
      <a-progress
        :percent="Math.round((keysStore.usageTask.done / Math.max(1, keysStore.usageTask.total)) * 100)"
        :show-info="false"
        size="small"
        style="width: 140px; margin: 0"
      />
      <span class="muted" style="font-size: 12px; white-space: nowrap">
        正在刷新API Key用量 {{ keysStore.usageTask.done }}/{{ keysStore.usageTask.total }}
      </span>
    </div>

    <span class="toolbar-spacer" />

    <template v-if="showIdeStatus">
      <a-tag v-if="activeLabel" color="green" style="margin: 0">
        <CheckCircleFilled /> IDE 当前：{{ activeLabel }}
      </a-tag>
      <a-tag v-else style="margin: 0">
        <ExclamationCircleOutlined /> IDE 未匹配到已管理账号
      </a-tag>
      <a-button size="small" @click="accountsStore.syncActiveFromIde()">重新检测</a-button>
    </template>

    <template v-if="showApiKeyStatus">
      <a-tag v-if="effectiveKeyLabel" color="green" style="margin: 0">
        <CheckCircleFilled /> 当前 API Key：{{ effectiveKeyLabel }}
      </a-tag>
      <a-tag v-else-if="!gatewayStatusLoaded" style="margin: 0">
        <ExclamationCircleOutlined /> 正在检测 API Key 网关
      </a-tag>
      <a-tag v-else-if="gatewayOwnsIde && selectedKeyLabel" color="gold" style="margin: 0">
        <ExclamationCircleOutlined /> 当前 API Key：{{ selectedKeyLabel }}（等待 IDE 请求确认）
      </a-tag>
      <a-tag v-else-if="gatewayOwnsIde" color="gold" style="margin: 0">
        <ExclamationCircleOutlined /> 网关已接管 IDE，但尚未选择 API Key
      </a-tag>
      <a-tag v-else-if="gatewayEnabled && selectedKeyLabel" color="orange" style="margin: 0">
        <ExclamationCircleOutlined /> 已选择 API Key：{{ selectedKeyLabel }}；IDE 接管状态异常
      </a-tag>
      <a-tag v-else-if="gatewayEnabled" color="orange" style="margin: 0">
        <ExclamationCircleOutlined /> API Key 网关已开启，但 IDE 端点未接管
      </a-tag>
      <a-tag v-else style="margin: 0">
        <ExclamationCircleOutlined /> API Key 网关未开启
      </a-tag>
      <a-button size="small" :loading="keysStore.detecting" @click="detectCurrentApiKey">
        重新检测
      </a-button>
    </template>
  </header>
</template>
