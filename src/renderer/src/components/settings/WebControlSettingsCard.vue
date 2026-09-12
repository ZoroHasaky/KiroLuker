<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { message } from 'ant-design-vue'
import { CopyOutlined, GlobalOutlined, ReloadOutlined } from '@ant-design/icons-vue'
import type { WebControlApiKeyPublic, WebControlPublicConfig } from '@shared/webControl'

const config = ref<WebControlPublicConfig | null>(null)
const mobileApiKey = ref<WebControlApiKeyPublic | null>(null)
const loading = ref(false)
const keyLoading = ref(false)
const keyError = ref('')

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
      publicUrl: config.value.publicUrl,
      trustedProxies: config.value.trustedProxies
    })
    if (!result.success || !result.data) return void message.error(result.error || '保存 API 服务配置失败')
    config.value = result.data
    await loadMobileApiKey()
    message.success(config.value.running ? 'API 服务配置已保存并已启动' : 'API 服务配置已保存')
  } finally { loading.value = false }
}

async function toggleService(): Promise<void> {
  loading.value = true
  try {
    const result = config.value?.running ? await window.api.stopWebControl() : await window.api.startWebControl()
    if (!result.success || !result.data) return void message.error(result.error || 'API 服务状态切换失败')
    config.value = result.data
    await loadMobileApiKey()
    message.success(config.value.running ? 'API 服务已启动' : 'API 服务已停止')
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
      keyError.value = result.error || '复制 API Key 失败；请先启动 API 服务'
      return
    }
    // 明文只在本次用户主动复制时短暂经过 Renderer，绝不渲染到页面。
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
    <template #extra><a-tag :color="config?.running ? 'green' : 'default'">{{ config?.running ? '运行中' : '未运行' }}</a-tag></template>
    <a-alert type="warning" show-icon style="margin-bottom: 14px" message="公网访问必须经 HTTPS 反向代理" description="应用不会自动开放防火墙，也不会忽略 TLS 证书错误。默认移动 App API Key 在服务首次启动时自动生成，使用系统安全存储保护；账号列表不返回凭证或完整支付链接。" />
    <a-form v-if="config" layout="horizontal" :label-col="{ flex: '0 0 130px' }" :wrapper-col="{ flex: '1 1 auto' }">
      <a-form-item label="启用服务"><a-switch v-model:checked="config.enabled" checked-children="开启" un-checked-children="关闭" /></a-form-item>
      <a-form-item label="监听地址"><a-input v-model:value="config.host" placeholder="127.0.0.1 / 0.0.0.0 / ::1" /></a-form-item>
      <a-form-item label="监听端口"><a-input-number v-model:value="config.port" :min="1024" :max="65535" style="width: 160px" /></a-form-item>
      <a-form-item label="公网 HTTPS 地址"><a-input v-model:value="config.publicUrl" placeholder="https://api.example.com（可留空，仅本地访问）" /></a-form-item>
      <a-form-item label="可信代理"><a-input v-model:value="config.trustedProxies" placeholder="127.0.0.1, ::1 或代理 CIDR；未使用代理可留空" /></a-form-item>
      <a-form-item label="服务地址"><a-space v-if="config.url"><code>{{ config.url }}</code><a-button size="small" @click="copyText(config.url!, '服务地址已复制')"><template #icon><CopyOutlined /></template>复制</a-button></a-space><span v-else class="muted">保存并启动后显示</span></a-form-item>
      <a-form-item><a-space><a-button type="primary" :loading="loading" @click="save"><template #icon><ReloadOutlined /></template>保存并应用</a-button><a-button :loading="loading" @click="toggleService"><template #icon><GlobalOutlined /></template>{{ config.running ? '停止服务' : '启动服务' }}</a-button></a-space></a-form-item>
    </a-form>
    <a-alert v-if="config?.error" type="error" show-icon :message="config.error" />

    <a-divider orientation="left" plain>移动 App 登录 API Key</a-divider>
    <a-alert type="info" show-icon style="margin-bottom: 14px" message="默认 Key 已拥有全部移动 App 权限" description="Key 不在页面显示明文，且不会经 HTTP API 返回。可随时复制；重新创建会立即撤销旧 Key。" />
    <a-alert v-if="keyError" type="error" show-icon style="margin-bottom: 14px" :message="keyError" />
    <a-empty v-if="!mobileApiKey" description="启动 API 服务后会自动生成默认 API Key" />
    <a-descriptions v-else size="small" bordered :column="1">
      <a-descriptions-item label="状态"><a-tag color="green">已安全保存</a-tag></a-descriptions-item>
      <a-descriptions-item label="标识"><code>{{ mobileApiKey.prefix }}…</code></a-descriptions-item>
      <a-descriptions-item label="权限">全部移动 App 权限</a-descriptions-item>
      <a-descriptions-item label="创建时间">{{ new Date(mobileApiKey.createdAt).toLocaleString() }}</a-descriptions-item>
      <a-descriptions-item label="操作"><a-space><a-button type="primary" :loading="keyLoading" @click="copyMobileApiKey"><template #icon><CopyOutlined /></template>复制 API Key</a-button><a-popconfirm title="重新创建会立即撤销当前 Key，已登录的移动 App 需改用新 Key。确定继续？" ok-text="重新创建" cancel-text="取消" @confirm="regenerateMobileApiKey"><a-button :loading="keyLoading" danger><template #icon><ReloadOutlined /></template>重新创建</a-button></a-popconfirm></a-space></a-descriptions-item>
    </a-descriptions>
  </a-card>
</template>
