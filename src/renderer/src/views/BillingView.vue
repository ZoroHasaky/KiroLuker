<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { message } from 'ant-design-vue'
import {
  CopyOutlined,
  EnvironmentOutlined,
  ReloadOutlined,
  SafetyCertificateOutlined,
  UserOutlined
} from '@ant-design/icons-vue'
import type {
  BillingPublicConfig,
  BillingRendererApi,
  BillingResult
} from '@shared/billing'
import { copyText } from '@/utils/ui'

const api = window.api as typeof window.api & BillingRendererApi
const config = ref<BillingPublicConfig | null>(null)
const result = ref<BillingResult | null>(null)
const loading = ref(false)
const loadError = ref('')
const generationError = ref('')

const configurationReady = computed(() => {
  const current = config.value
  return Boolean(
    current &&
      (current.hasAmapKey || current.hasBaiduKey) &&
      current.hasAiKey &&
      current.aiUrl &&
      current.aiModel
  )
})

async function loadConfig(): Promise<void> {
  loadError.value = ''
  const response = await api.getBillingConfig()
  if (!response.success || !response.data) {
    loadError.value = response.error || '读取账单服务配置失败'
    return
  }
  config.value = response.data
}

async function generate(): Promise<void> {
  loading.value = true
  generationError.value = ''
  try {
    const response = await api.generateBillingInfo()
    if (!response.success || !response.data) {
      generationError.value = response.error || '生成账单信息失败'
      return
    }
    result.value = response.data
    message.success('账单信息已生成')
  } finally {
    loading.value = false
  }
}

function copyField(value: string, label: string): void {
  copyText(value, `${label}已复制`)
}

function copyAll(): void {
  const current = result.value
  if (!current) return
  copyText(
    [
      `中文姓名：${current.chineseName}`,
      `大写拼音：${current.pinyinName}`,
      `详细地址：${current.address}`,
      `邮政编码：${current.postalCode}`
    ].join('\n'),
    '全部账单信息已复制'
  )
}

function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleString('zh-CN', { hour12: false })
}

onMounted(loadConfig)
</script>

<template>
  <div class="billing-view">
    <div class="page-header">
      <div>
        <h2>账单信息</h2>
        <p class="muted">从地图公开地点生成真实地址，并通过 AI 推断对应邮政编码。</p>
      </div>
      <a-button type="primary" :loading="loading" @click="generate">
        <template #icon><ReloadOutlined /></template>
        {{ result ? '重新生成' : '生成' }}
      </a-button>
    </div>

    <a-alert
      v-if="loadError"
      type="error"
      show-icon
      :message="loadError"
      style="margin-bottom: 16px"
    />
    <a-alert
      v-else-if="!configurationReady"
      type="warning"
      show-icon
      message="账单服务尚未配置完整"
      description="请在设置中配置至少一个地图 API Key，以及 AI 服务 URL、API Key 和模型名称。"
      style="margin-bottom: 16px"
    />
    <a-alert
      v-if="generationError"
      type="error"
      show-icon
      :message="generationError"
      description="已保留上一次成功生成的结果。"
      closable
      style="margin-bottom: 16px"
      @close="generationError = ''"
    />

    <a-card v-if="result" size="small" class="result-card">
      <template #title>
        <span class="result-title">生成结果</span>
      </template>
      <template #extra>
        <a-button type="primary" ghost size="small" @click="copyAll">
          <template #icon><CopyOutlined /></template>
          一键复制全部
        </a-button>
      </template>

      <div class="result-grid">
        <div class="result-item">
          <div class="item-icon"><UserOutlined /></div>
          <div class="item-content">
            <span class="item-label">中文姓名</span>
            <strong>{{ result.chineseName }}</strong>
          </div>
          <a-button type="text" size="small" aria-label="复制中文姓名" @click="copyField(result.chineseName, '中文姓名')">
            <CopyOutlined />
          </a-button>
        </div>

        <div class="result-item">
          <div class="item-icon"><UserOutlined /></div>
          <div class="item-content">
            <span class="item-label">大写拼音</span>
            <strong>{{ result.pinyinName }}</strong>
          </div>
          <a-button type="text" size="small" aria-label="复制大写拼音" @click="copyField(result.pinyinName, '大写拼音')">
            <CopyOutlined />
          </a-button>
        </div>

        <div class="result-item result-item-wide">
          <div class="item-icon"><EnvironmentOutlined /></div>
          <div class="item-content">
            <span class="item-label">详细地址</span>
            <strong>{{ result.address }}</strong>
          </div>
          <a-button type="text" size="small" aria-label="复制详细地址" @click="copyField(result.address, '详细地址')">
            <CopyOutlined />
          </a-button>
        </div>

        <div class="result-item">
          <div class="item-icon"><SafetyCertificateOutlined /></div>
          <div class="item-content">
            <span class="item-label">邮政编码 <a-tag color="orange">AI 推断</a-tag></span>
            <strong>{{ result.postalCode }}</strong>
          </div>
          <a-button type="text" size="small" aria-label="复制邮政编码" @click="copyField(result.postalCode, '邮政编码')">
            <CopyOutlined />
          </a-button>
        </div>
      </div>

      <div class="result-meta muted">
        地图来源：{{ result.mapSource }} · 生成时间：{{ formatTime(result.generatedAt) }}
      </div>
    </a-card>

    <a-empty v-else description="点击“生成”获取一组新的账单信息" class="empty-state" />
  </div>
</template>

<style scoped>
.billing-view {
  min-width: 0;
}

.page-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 16px;
}

.page-header h2 {
  margin: 0 0 4px;
  font-size: 20px;
}

.page-header p {
  margin: 0;
  font-size: 13px;
}

.result-card {
  margin-bottom: 16px;
}

.result-title {
  font-weight: 600;
}

.result-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
}

.result-item {
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 0;
  padding: 14px;
  border: 1px solid var(--kal-border);
  border-radius: 8px;
  background: var(--kal-block-bg);
}

.result-item-wide {
  grid-column: 1 / -1;
}

.item-icon {
  flex: 0 0 auto;
  color: var(--kal-primary);
  font-size: 18px;
}

.item-content {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}

.item-content strong {
  line-height: 1.6;
  overflow-wrap: anywhere;
}

.item-label {
  color: var(--kal-muted);
  font-size: 12px;
  font-weight: 400;
}

.item-label :deep(.ant-tag) {
  margin-left: 4px;
  font-size: 11px;
  line-height: 18px;
}

.result-meta {
  margin-top: 14px;
  text-align: right;
  font-size: 12px;
}

.empty-state {
  margin: 72px 0;
}

@media (max-width: 720px) {
  .result-grid {
    grid-template-columns: 1fr;
  }

  .result-item-wide {
    grid-column: auto;
  }
}
</style>
