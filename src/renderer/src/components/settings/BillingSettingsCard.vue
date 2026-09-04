<script setup lang="ts">
import { computed, h, onMounted, reactive, ref } from 'vue'
import { ExclamationCircleOutlined } from '@ant-design/icons-vue'
import { message, Modal } from 'ant-design-vue'
import type {
  BillingPublicConfig,
  BillingReasoningEffort,
  BillingRendererApi,
  BillingSecretName,
  BillingSecretPatch
} from '@shared/billing'

const api = window.api as typeof window.api & BillingRendererApi
const config = ref<BillingPublicConfig | null>(null)
const loading = ref(false)
const saving = ref(false)
const error = ref('')

const draft = reactive({
  aiUrl: '',
  aiModel: '',
  reasoningEffort: '' as BillingReasoningEffort,
  amapKey: '',
  baiduKey: '',
  aiKey: ''
})

const reasoningOptions: { value: BillingReasoningEffort; label: string }[] = [
  { value: '', label: '不传' },
  { value: 'low', label: 'low' },
  { value: 'medium', label: 'medium' },
  { value: 'high', label: 'high' }
]

const configuredMapText = computed(() => {
  if (config.value?.hasAmapKey && config.value?.hasBaiduKey) return '高德优先，百度回退'
  if (config.value?.hasAmapKey) return '仅高德地图'
  if (config.value?.hasBaiduKey) return '仅百度地图'
  return '未配置'
})

function applyConfig(value: BillingPublicConfig): void {
  config.value = value
  draft.aiUrl = value.aiUrl
  draft.aiModel = value.aiModel
  draft.reasoningEffort = value.reasoningEffort
}

async function load(): Promise<void> {
  loading.value = true
  error.value = ''
  try {
    const response = await api.getBillingConfig()
    if (!response.success || !response.data) {
      error.value = response.error || '读取账单服务配置失败'
      return
    }
    applyConfig(response.data)
  } finally {
    loading.value = false
  }
}

async function save(): Promise<void> {
  saving.value = true
  error.value = ''
  try {
    const baseResponse = await api.saveBillingConfig({
      aiUrl: draft.aiUrl.trim(),
      aiModel: draft.aiModel.trim(),
      reasoningEffort: draft.reasoningEffort
    })
    if (!baseResponse.success || !baseResponse.data) {
      error.value = baseResponse.error || '保存账单服务配置失败'
      return
    }
    applyConfig(baseResponse.data)

    const secrets: BillingSecretPatch = {}
    if (draft.amapKey.trim()) secrets.amap = draft.amapKey.trim()
    if (draft.baiduKey.trim()) secrets.baidu = draft.baiduKey.trim()
    if (draft.aiKey.trim()) secrets.ai = draft.aiKey.trim()
    if (Object.keys(secrets).length) {
      const secretResponse = await api.replaceBillingSecrets(secrets)
      if (!secretResponse.success || !secretResponse.data) {
        error.value = secretResponse.error || '非敏感配置已保存，但 API Key 保存失败'
        return
      }
      applyConfig(secretResponse.data)
    }
    draft.amapKey = ''
    draft.baiduKey = ''
    draft.aiKey = ''
    message.success('账单服务配置已保存')
  } finally {
    saving.value = false
  }
}

function secretConfigured(name: BillingSecretName): boolean {
  if (name === 'amap') return Boolean(config.value?.hasAmapKey)
  if (name === 'baidu') return Boolean(config.value?.hasBaiduKey)
  return Boolean(config.value?.hasAiKey)
}

function clearSecret(name: BillingSecretName, label: string): void {
  Modal.confirm({
    title: `清除${label}`,
    icon: () => h(ExclamationCircleOutlined),
    content: `将从本机存储中删除已保存的${label}，该操作不可撤销。`,
    okText: '确认清除',
    okType: 'danger',
    cancelText: '取消',
    async onOk() {
      const response = await api.clearBillingSecrets([name])
      if (!response.success || !response.data) {
        message.error(response.error || `清除${label}失败`)
        return Promise.reject(new Error(response.error || 'clear failed'))
      }
      applyConfig(response.data)
      if (name === 'amap') draft.amapKey = ''
      else if (name === 'baidu') draft.baiduKey = ''
      else draft.aiKey = ''
      message.success(`${label}已清除`)
    }
  })
}

function clearAll(): void {
  Modal.confirm({
    title: '清除账单服务配置',
    icon: () => h(ExclamationCircleOutlined),
    content: '将删除地图与 AI 的全部配置和 API Key，该操作不可撤销。',
    okText: '全部清除',
    okType: 'danger',
    cancelText: '取消',
    async onOk() {
      const response = await api.clearBillingConfig()
      if (!response.success || !response.data) {
        message.error(response.error || '清除账单服务配置失败')
        return Promise.reject(new Error(response.error || 'clear failed'))
      }
      applyConfig(response.data)
      draft.amapKey = ''
      draft.baiduKey = ''
      draft.aiKey = ''
      message.success('账单服务配置已全部清除')
    }
  })
}

onMounted(load)
</script>

<template>
  <a-card size="small" title="账单服务" :loading="loading" style="margin-bottom: 16px">
    <a-alert
      v-if="error"
      type="error"
      show-icon
      :message="error"
      closable
      style="margin-bottom: 16px"
      @close="error = ''"
    />
    <a-alert
      v-if="config?.storageWarning"
      type="warning"
      show-icon
      :message="config.storageWarning"
      style="margin-bottom: 16px"
    />

    <a-form
      layout="horizontal"
      :disabled="!config"
      :label-col="{ flex: '0 0 130px' }"
      :wrapper-col="{ flex: '1 1 auto' }"
    >
      <a-form-item label="地图状态">
        <a-tag :color="config?.hasAmapKey || config?.hasBaiduKey ? 'green' : 'default'">
          {{ configuredMapText }}
        </a-tag>
        <span class="muted field-note">地址查询固定按“高德优先、百度失败回退”执行</span>
      </a-form-item>

      <a-form-item label="高德 API Key">
        <div class="secret-row">
          <a-input-password
            v-model:value="draft.amapKey"
            autocomplete="new-password"
            :placeholder="config?.hasAmapKey ? '已配置；留空保持不变' : '输入高德 Web 服务 Key'"
          />
          <a-button
            danger
            :disabled="!secretConfigured('amap')"
            @click="clearSecret('amap', '高德 API Key')"
          >清除</a-button>
        </div>
      </a-form-item>

      <a-form-item label="百度 API Key">
        <div class="secret-row">
          <a-input-password
            v-model:value="draft.baiduKey"
            autocomplete="new-password"
            :placeholder="config?.hasBaiduKey ? '已配置；留空保持不变' : '输入百度地图服务端 AK'"
          />
          <a-button
            danger
            :disabled="!secretConfigured('baidu')"
            @click="clearSecret('baidu', '百度 API Key')"
          >清除</a-button>
        </div>
      </a-form-item>

      <a-divider orientation="left" plain>邮政编码 AI 推断</a-divider>

      <a-form-item label="服务完整 URL">
        <a-input
          v-model:value="draft.aiUrl"
          placeholder="例如 https://api.example.com/v1/chat/completions"
        />
      </a-form-item>

      <a-form-item label="API Key">
        <div class="secret-row">
          <a-input-password
            v-model:value="draft.aiKey"
            autocomplete="new-password"
            :placeholder="config?.hasAiKey ? '已配置；留空保持不变' : '输入 AI 服务 API Key'"
          />
          <a-button
            danger
            :disabled="!secretConfigured('ai')"
            @click="clearSecret('ai', 'AI API Key')"
          >清除</a-button>
        </div>
      </a-form-item>

      <a-form-item label="模型名称">
        <a-input v-model:value="draft.aiModel" placeholder="例如 gpt-4.1-mini" />
      </a-form-item>

      <a-form-item label="思考等级">
        <a-select
          v-model:value="draft.reasoningEffort"
          :options="reasoningOptions"
          style="width: 180px"
        />
        <span class="muted field-note">选择“不传”可兼容不支持 reasoning_effort 的服务</span>
      </a-form-item>

      <a-form-item :wrapper-col="{ flex: '1 1 auto', offset: 0 }" class="actions-item">
        <a-space>
          <a-button type="primary" :loading="saving" :disabled="!config" @click="save">保存配置</a-button>
          <a-button danger :disabled="!config" @click="clearAll">清除全部账单配置</a-button>
        </a-space>
      </a-form-item>
    </a-form>
  </a-card>
</template>

<style scoped>
.secret-row {
  display: flex;
  align-items: center;
  gap: 8px;
  max-width: 680px;
}

.secret-row :deep(.ant-input-password) {
  flex: 1 1 auto;
  min-width: 0;
}

.field-note {
  margin-left: 8px;
  font-size: 12px;
}

.actions-item {
  margin-bottom: 0;
}
</style>
