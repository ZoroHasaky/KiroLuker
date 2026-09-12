<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { message } from 'ant-design-vue'
import { CopyOutlined, ReloadOutlined } from '@ant-design/icons-vue'
import type { WebControlApiKeyPublic, WebControlPublicConfig } from '@shared/webControl'

const config = ref<WebControlPublicConfig | null>(null)
const mobileApiKey = ref<WebControlApiKeyPublic | null>(null)
const loading = ref(false)
const keyLoading = ref(false)
const keyError = ref('')

const serviceUrl = computed(() => {
  if (!config.value) return ''
  if (config.value.url) return config.value.url
  const host = config.value.host.includes(':') && !config.value.host.startsWith('[')
    ? '[' + config.value.host + ']'
    : config.value.host
  return 'http://' + host + ':' + config.value.port
})

async function loadMobileApiKey(): Promise<void> {
  const result = await window.api.getWebControlMobileApiKey()
  if (result.success) mobileApiKey.value = result.data ?? null
  else keyError.value = result.error || '读取移动 App API Key 状态失败'
}

async function load(): Promise<void> {
  const configResult = await window.api.getWebControlConfig()
  if (configResult.success && configResult.data) config.value = configResult.data
  else message.error(configResult.error || '读取 API 服务配置失败')
  await loadMobileApiKey()
}

async function save(): Promise<void> {
  if (!config.value) return
  loading.value = true
  try {
    const result = await window.api.saveWebControlSettings({
      enabled: config.value.enabled,
      host: config.value.host,
      port: Number(config.value.port),
      // 高级字段不再展示，但继续原样提交，避免覆盖旧配置。
      publicUrl: config.value.publicUrl,
      trustedProxies: config.value.trustedProxies
    })
    if (!result.success || !result.data) return void message.error(result.error || '保存 API 服务配置失败')
    config.value = result.data
    await loadMobileApiKey()
    message.success(config.value.running ? 'API 服务配置已保存并已启动' : 'API 服务配置已保存')
  } finally { loading.value = false }
}

async function stopService(): Promise<void> {
  loading.value = true
  try {
    const result = await window.api.stopWebControl()
    if (!result.success || !result.data) return void message.error(result.error || '停止 API 服务失败')
    config.value = result.data
    message.success('API 服务已停止')
  } finally { loading.value = false }
}

function copyText(value: string, success: string): void {
  if (!value) return
  window.api.writeClipboard(value)
  message.success(success)
}

async function copyMobileApiKey(): Promise<void> {
  keyError.value = ''
  keyLoading.value = true
  try {
    const result = await window.api.copyWebControlMobileApiKey()
    if (!result.success || !result.data?.apiKey) {
      keyError.value = result.error || '复制 API Key 失败'
      return
    }
    window.api.writeClipboard(result.data.apiKey)
    message.success('API Key 已复制')
  } finally { keyLoading.value = false }
}

async function regenerateMobileApiKey(): Promise<void> {
  keyError.value = ''
  keyLoading.value = true
  try {
    const result = await window.api.regenerateWebControlMobileApiKey()
    if (!result.success || !result.data) {
      keyError.value = result.error || '重新创建 API Key 失败'
      return
    }
    mobileApiKey.value = result.data
    message.success('已重新创建 API Key；旧 Key 已立即撤销')
  } finally { keyLoading.value = false }
}

onMounted(() => void load())
</script>

<template>
  <a-card size="small" title="移动 App API 服务" style="margin-bottom: 16px">
    <a-form v-if="config" layout="horizontal" :label-col="{ flex: '0 0 130px' }" :wrapper-col="{ flex: '1 1 auto' }">
      <a-form-item label="启用服务">
        <a-switch v-model:checked="config.enabled" checked-children="开启" un-checked-children="关闭" />
      </a-form-item>
      <a-form-item label="监听地址">
        <a-input v-model:value="config.host" placeholder="127.0.0.1 / 0.0.0.0 / ::1" />
      </a-form-item>
      <a-form-item label="监听端口">
        <a-input-number v-model:value="config.port" :min="1024" :max="65535" style="width: 160px" />
      </a-form-item>
      <a-form-item label="服务地址">
        <a-space v-if="serviceUrl">
          <code>{{ serviceUrl }}</code>
          <a-button size="small" @click="copyText(serviceUrl, '服务地址已复制')">
            <template #icon><CopyOutlined /></template>
            复制
          </a-button>
        </a-space>
      </a-form-item>
      <a-form-item>
        <a-space>
          <a-button type="primary" :loading="loading" @click="save">
            <template #icon><ReloadOutlined /></template>
            保存并应用
          </a-button>
          <a-button v-if="config.running" :loading="loading" @click="stopService">
            停止服务
          </a-button>
        </a-space>
      </a-form-item>
      <a-form-item label="API Key">
        <a-space v-if="mobileApiKey">
          <code>{{ mobileApiKey.prefix }}…</code>
          <a-button type="primary" :loading="keyLoading" @click="copyMobileApiKey">
            <template #icon><CopyOutlined /></template>
            复制
          </a-button>
          <a-popconfirm
            title="重新创建会立即撤销当前 Key，已登录的移动 App 需改用新 Key。确定继续？"
            ok-text="重新创建"
            cancel-text="取消"
            @confirm="regenerateMobileApiKey"
          >
            <a-button danger :loading="keyLoading">
              <template #icon><ReloadOutlined /></template>
              重建
            </a-button>
          </a-popconfirm>
        </a-space>
        <span v-else class="muted">正在生成 API Key…</span>
      </a-form-item>
    </a-form>
    <a-alert v-if="keyError" type="error" show-icon :message="keyError" />
  </a-card>
</template>
