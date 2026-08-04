<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue'
import { message } from 'ant-design-vue'
import {
  CheckCircleFilled,
  CloseCircleFilled,
  SendOutlined,
  StopOutlined,
  SyncOutlined
} from '@ant-design/icons-vue'
import { useKeysStore } from '@/stores/keys'
import { useSettingsStore } from '@/stores/settings'
import { formatRate } from '@/utils/format'
import { errorMessage } from '@shared/errors'
import type { ChatTestResult, KeyEntry, KeyModelInfo } from '@shared/types'

const props = defineProps<{ keyEntry: KeyEntry | null }>()
const emit = defineEmits<{ close: [] }>()
const keysStore = useKeysStore()
const settingsStore = useSettingsStore()
const DEFAULT_MESSAGE = '你的具体模型名称，以及具体时间，打印出来！'

const models = ref<KeyModelInfo[]>([])
const modelsLoading = ref(false)
const modelsError = ref('')
const modelId = ref('')
const input = ref(DEFAULT_MESSAGE)
const running = ref(false)
const output = ref('')
const result = ref<ChatTestResult | null>(null)
const error = ref('')
const requestId = ref('')

const open = computed(() => !!props.keyEntry)
const label = computed(() => {
  const key = props.keyEntry?.key || ''
  return settingsStore.settings.privacyMode ? mask(key) : key
})
const modelOptions = computed(() =>
  models.value.map((model) => {
    const base = model.name && model.name !== model.id ? `${model.name}（${model.id}）` : model.id
    const rate = formatRate(model.rate)
    return {
      value: model.id,
      // 倍率拼进 label，a-select 搜索时也能按倍率匹配
      label: rate ? `${base} ${rate}` : base
    }
  })
)
const ready = computed(() => !modelsLoading.value && !modelsError.value && models.value.length > 0)

function mask(key: string): string {
  return key ? `${key.slice(0, 8)}…${key.slice(-6)}` : ''
}

const offChunk = window.api.onKeyChatChunk(({ requestId: id, delta }) => {
  if (id === requestId.value) output.value += delta
})
onUnmounted(() => {
  if (running.value && requestId.value) void window.api.cancelKeyChatTest(requestId.value)
  offChunk()
})

async function loadModels(): Promise<void> {
  const target = props.keyEntry
  if (!target) return
  const loadingId = target.id
  modelsLoading.value = true
  modelsError.value = ''
  models.value = []
  try {
    const response = await keysStore.listModels(target.id)
    if (props.keyEntry?.id !== loadingId) return
    if (response.data?.length) {
      models.value = response.data
      if (!modelOptions.value.some((option) => option.value === modelId.value)) {
        modelId.value = modelOptions.value[0]?.value || ''
      }
    } else {
      modelsError.value = response.error || '官方没有返回任何可用模型'
    }
  } catch (cause) {
    modelsError.value = errorMessage(cause)
  } finally {
    if (props.keyEntry?.id === loadingId) modelsLoading.value = false
  }
}

watch(
  () => props.keyEntry?.id,
  (id) => {
    if (!id) return
    output.value = ''
    result.value = null
    error.value = ''
    input.value = DEFAULT_MESSAGE
    modelId.value = ''
    void loadModels()
  },
  { immediate: true }
)

async function start(): Promise<void> {
  const target = props.keyEntry
  const text = input.value.trim()
  if (!target) return
  if (!text) return void message.warning('请输入要发送的内容')
  if (!modelId.value) return void message.warning('请选择模型')

  running.value = true
  output.value = ''
  result.value = null
  error.value = ''
  requestId.value = `key-${target.id}-${Date.now()}`
  const currentRequest = requestId.value
  try {
    const response = await window.api.keyChatTest(currentRequest, {
      keyId: target.id,
      modelId: modelId.value,
      message: text
    })
    if (requestId.value !== currentRequest) return
    // 测活结论同步到卡片：主进程已落库，这里更新本地状态让卡片立即反映
    if (response.success && response.data) {
      result.value = response.data
      keysStore.applyChatResult(target.id)
    } else {
      error.value = response.error || '测试失败'
      keysStore.applyChatResult(target.id, error.value)
    }
  } catch (cause) {
    error.value = errorMessage(cause)
    keysStore.applyChatResult(target.id, error.value)
  } finally {
    if (requestId.value === currentRequest) running.value = false
  }
}

function cancel(): void {
  if (requestId.value) void window.api.cancelKeyChatTest(requestId.value)
}

function close(): void {
  if (running.value) cancel()
  emit('close')
}

const resultSummary = computed(() => {
  const value = result.value
  if (!value) return ''
  const parts = [
    `API Key 可用：${value.endpoint}`,
    `首字 ${value.firstByteMs} ms`,
    `总耗时 ${value.totalMs} ms`,
    `共 ${value.text.length} 字`
  ]
  if (value.thinkingChars) parts.push(`思考 ${value.thinkingChars} 字`)
  return parts.join(' · ')
})

const modelNote = computed(() => {
  if (!result.value) return ''
  if (result.value.modelId) {
    return result.value.modelId === modelId.value
      ? `请求模型 ${modelId.value}，后端回报一致`
      : `请求模型 ${modelId.value}，后端实际使用 ${result.value.modelId}`
  }
  return `请求模型 ${modelId.value}（响应流未回报实际模型）`
})
</script>

<template>
  <a-modal :open="open" width="640px" :footer="null" @cancel="close">
    <template #title>
      <span class="title"><SendOutlined />API Key 在线测活</span>
    </template>

    <a-alert
      type="info"
      show-icon
      :message="`当前 API Key：${label}`"
      style="margin-bottom: 16px"
    />

    <div v-if="modelsLoading" class="stage">
      <a-spin size="large" />
      <span class="muted">正在从 Kiro 官方拉取该 Key 可用的模型…</span>
    </div>
    <div v-else-if="modelsError" class="stage">
      <a-result status="error" title="模型列表拉取失败" :sub-title="modelsError">
        <template #extra>
          <a-space>
            <a-button @click="close">关闭</a-button>
            <a-button type="primary" @click="loadModels">
              <template #icon><SyncOutlined /></template>重试
            </a-button>
          </a-space>
        </template>
      </a-result>
    </div>

    <template v-else>
      <a-form layout="vertical">
        <a-form-item label="模型">
          <div class="model-row">
            <a-select
              v-model:value="modelId"
              :options="modelOptions"
              show-search
              placeholder="选择模型"
              style="flex: 1 1 auto"
            />
            <a-tooltip title="重新拉取模型列表">
              <a-button :disabled="running" @click="loadModels"><template #icon><SyncOutlined /></template></a-button>
            </a-tooltip>
          </div>
        </a-form-item>
        <a-form-item label="发送内容">
          <a-textarea v-model:value="input" :rows="3" :disabled="running" />
        </a-form-item>
      </a-form>

      <div class="output-box">
        <div v-if="output" class="output-text">{{ output }}</div>
        <div v-else-if="running" class="muted">等待模型返回…</div>
        <div v-else class="muted">点击“开始测试”后，这里会实时显示流式回复</div>
        <span v-if="running" class="cursor" />
      </div>

      <a-alert
        v-if="result"
        type="success"
        show-icon
        style="margin-top: 12px"
        :message="resultSummary"
        :description="modelNote"
      ><template #icon><CheckCircleFilled /></template></a-alert>
      <a-alert
        v-else-if="error"
        type="error"
        show-icon
        style="margin-top: 12px"
        :message="`测试失败：${error}`"
        description="Key 失效、额度耗尽或模型无权限都会在真实对话中暴露。"
      ><template #icon><CloseCircleFilled /></template></a-alert>

      <a-space style="width: 100%; justify-content: flex-end; margin-top: 16px">
        <a-button @click="close">关闭</a-button>
        <a-button v-if="running" danger @click="cancel"><template #icon><StopOutlined /></template>中止</a-button>
        <a-button v-else type="primary" :disabled="!ready" @click="start">
          <template #icon><SendOutlined /></template>开始测试
        </a-button>
      </a-space>
    </template>
  </a-modal>
</template>

<style scoped>
.title { display: inline-flex; align-items: center; gap: 8px; }
.model-row { display: flex; gap: 8px; }
.stage { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 14px; min-height: 300px; }
.stage :deep(.ant-result) { padding: 0; }
.output-box { min-height: 120px; max-height: 260px; overflow: auto; padding: 10px 12px; border-radius: 10px; background: var(--kal-block-bg); font-size: 13px; line-height: 1.8; }
.output-text { white-space: pre-wrap; word-break: break-word; }
.cursor { display: inline-block; width: 7px; height: 14px; vertical-align: text-bottom; background: var(--kal-primary); animation: blink 1s steps(2, start) infinite; }
.muted { color: var(--kal-muted); }
@keyframes blink { to { visibility: hidden; } }
</style>
