<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { message } from 'ant-design-vue'
import { CopyOutlined, GlobalOutlined, ReloadOutlined, SafetyOutlined } from '@ant-design/icons-vue'
import type { WebControlPublicConfig } from '@shared/webControl'

const config = ref<WebControlPublicConfig | null>(null)
const loading = ref(false)
const password = ref('')

async function load(): Promise<void> {
  const result = await window.api.getWebControlConfig()
  if (result.success && result.data) config.value = result.data
  else message.error(result.error || '读取 Web 服务配置失败')
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
    if (!result.success || !result.data) return void message.error(result.error || '保存 Web 服务配置失败')
    config.value = result.data
    message.success(config.value.running ? 'Web 服务配置已保存并已启动' : 'Web 服务配置已保存')
  } finally { loading.value = false }
}

async function setPassword(): Promise<void> {
  if (password.value.length < 10) return void message.warning('请输入至少 10 位管理员密码')
  loading.value = true
  try {
    const result = await window.api.setWebControlPassword(password.value)
    if (!result.success || !result.data) return void message.error(result.error || '设置管理员密码失败')
    password.value = ''; config.value = result.data; message.success('管理员密码已保存，旧 Web 会话已失效')
  } finally { loading.value = false }
}

async function toggleService(): Promise<void> {
  loading.value = true
  try {
    const result = config.value?.running ? await window.api.stopWebControl() : await window.api.startWebControl()
    if (!result.success || !result.data) return void message.error(result.error || 'Web 服务状态切换失败')
    config.value = result.data; message.success(config.value.running ? 'Web 服务已启动' : 'Web 服务已停止')
  } finally { loading.value = false }
}

function copyUrl(): void {
  if (!config.value?.url) return
  window.api.writeClipboard(config.value.url)
  message.success('Web 面板地址已复制')
}

onMounted(load)
</script>

<template>
  <a-card size="small" title="Web 控制面板与对外 API" style="margin-bottom: 16px">
    <template #extra><a-tag :color="config?.running ? 'green' : 'default'">{{ config?.running ? '运行中' : '未运行' }}</a-tag></template>
    <a-alert type="warning" show-icon style="margin-bottom: 14px" message="公网访问必须经 HTTPS 反向代理" description="应用不自动开放防火墙；管理员面板使用 HttpOnly 会话，外部程序应通过 API Key 调用。账户凭证不会由 Web API 返回。" />
    <a-form v-if="config" layout="horizontal" :label-col="{ flex: '0 0 130px' }" :wrapper-col="{ flex: '1 1 auto' }">
      <a-form-item label="启用服务"><a-switch v-model:checked="config.enabled" checked-children="开启" un-checked-children="关闭" /></a-form-item>
      <a-form-item label="监听地址"><a-input v-model:value="config.host" placeholder="127.0.0.1 / 0.0.0.0 / ::1" /></a-form-item>
      <a-form-item label="监听端口"><a-input-number v-model:value="config.port" :min="1024" :max="65535" style="width: 160px" /></a-form-item>
      <a-form-item label="公网 HTTPS 地址"><a-input v-model:value="config.publicUrl" placeholder="https://panel.example.com（可留空，仅本地访问）" /></a-form-item>
      <a-form-item label="可信代理"><a-input v-model:value="config.trustedProxies" placeholder="127.0.0.1, ::1 或代理 CIDR；未使用代理可留空" /></a-form-item>
      <a-form-item label="管理员密码" class="password-row"><a-input-password v-model:value="password" autocomplete="new-password" placeholder="至少 10 位；只保存 scrypt 哈希" /><a-button :loading="loading" @click="setPassword"><template #icon><SafetyOutlined /></template>重设密码</a-button></a-form-item>
      <a-form-item label="服务地址"><a-space v-if="config.url"><code>{{ config.url }}</code><a-button size="small" @click="copyUrl"><template #icon><CopyOutlined /></template>复制</a-button></a-space><span v-else class="muted">保存并启动后显示</span></a-form-item>
      <a-form-item><a-space><a-button type="primary" :loading="loading" @click="save"><template #icon><ReloadOutlined /></template>保存并应用</a-button><a-button :disabled="!config.passwordConfigured" :loading="loading" @click="toggleService"><template #icon><GlobalOutlined /></template>{{ config.running ? '停止服务' : '启动服务' }}</a-button></a-space></a-form-item>
    </a-form>
    <a-alert v-if="config?.error" type="error" show-icon :message="config.error" />
  </a-card>
</template>

<style scoped>
.password-row :deep(.ant-form-item-control-input-content) { display: flex; gap: 8px; }
.password-row :deep(.ant-input-affix-wrapper) { min-width: 0; }
</style>
