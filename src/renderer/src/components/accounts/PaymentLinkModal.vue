<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { CopyOutlined, DeleteOutlined, EditOutlined, ReloadOutlined } from '@ant-design/icons-vue'
import { message } from 'ant-design-vue'
import { copyText } from '@/utils/ui'
import type { Account } from '@shared/types'
import type { BillingRendererApi } from '@shared/billing'
import { useBillingStore } from '@/stores/billing'

const props = defineProps<{ account: Account | null }>()

const emit = defineEmits<{
  close: []
  save: [accountId: string, paymentLink: string]
  clear: [accountId: string]
}>()

const api = window.api as typeof window.api & BillingRendererApi
const billingStore = useBillingStore()
const editing = ref(false)
const value = ref('')
const savedLink = ref('')
const currentLink = computed(() => savedLink.value)
const billingGenerating = ref(false)
const billingError = ref('')

watch(
  () => [props.account?.id, props.account?.paymentLink] as const,
  ([, paymentLink]) => {
    savedLink.value = paymentLink?.trim() ?? ''
    value.value = savedLink.value
    editing.value = !value.value
  },
  { immediate: true }
)

// 打开二维码时若还没有账单信息则自动生成一组，本地随机即时完成。
watch(
  () => props.account?.id,
  (id) => {
    if (id && !billingStore.result && !billingGenerating.value) void generateBilling()
  }
)

async function generateBilling(): Promise<void> {
  if (billingGenerating.value) return
  billingGenerating.value = true
  billingError.value = ''
  try {
    const response = await api.generateBillingInfo()
    if (!response.success || !response.data) {
      billingError.value = response.error || '生成账单信息失败'
      return
    }
    billingStore.setResult(response.data)
  } finally {
    billingGenerating.value = false
  }
}

function copyBillingField(value: string, label: string): void {
  copyText(value, `${label}已复制`)
}

function copyAllBilling(): void {
  const current = billingStore.result
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

function validHttpUrl(input: string): boolean {
  try {
    const url = new URL(input)
    return (url.protocol === 'http:' || url.protocol === 'https:') && !!url.hostname
  } catch {
    return false
  }
}

function submit(): void {
  const account = props.account
  const link = value.value.trim()
  if (!account) return
  if (!validHttpUrl(link)) {
    message.warning('请输入有效的 http:// 或 https:// 链接')
    return
  }
  emit('save', account.id, link)
  savedLink.value = link
  editing.value = false
}

function cancelEdit(): void {
  if (!currentLink.value) {
    emit('close')
    return
  }
  value.value = currentLink.value
  editing.value = false
}

function clearLink(): void {
  if (!props.account) return
  emit('clear', props.account.id)
  savedLink.value = ''
  emit('close')
}

function copyLink(): void {
  if (currentLink.value) copyText(currentLink.value, '支付链接已复制')
}
</script>

<template>
  <a-modal
    :open="!!props.account"
    title="支付链接"
    width="500px"
    :footer="null"
    @cancel="emit('close')"
  >
    <template v-if="editing">
      <a-form layout="vertical" @submit.prevent="submit">
        <a-form-item label="支付链接" required>
          <a-input
            v-model:value="value"
            allow-clear
            autofocus
            placeholder="https://example.com/pay/..."
            @press-enter="submit"
          />
        </a-form-item>
        <div class="modal-actions">
          <a-button @click="cancelEdit">取消</a-button>
          <a-button type="primary" @click="submit">保存</a-button>
        </div>
      </a-form>
    </template>

    <template v-else>
      <div class="qr-wrap">
        <a-qrcode :value="currentLink" :size="220" error-level="M" />
      </div>
      <div class="billing-section">
        <template v-if="billingStore.result">
          <div class="billing-header">
            <span class="billing-title">账单信息</span>
            <a-button size="small" :loading="billingGenerating" @click="generateBilling">
              <template #icon><ReloadOutlined /></template>
              重新生成
            </a-button>
          </div>
          <a-alert v-if="billingError" type="error" show-icon :message="billingError" class="billing-error" />
          <div class="billing-rows">
            <div class="billing-row">
              <span class="billing-label">中文姓名</span>
              <strong class="billing-value">{{ billingStore.result.chineseName }}</strong>
              <a-button type="text" size="small" aria-label="复制中文姓名" @click="copyBillingField(billingStore.result.chineseName, '中文姓名')">
                <CopyOutlined />
              </a-button>
            </div>
            <div class="billing-row">
              <span class="billing-label">大写拼音</span>
              <strong class="billing-value">{{ billingStore.result.pinyinName }}</strong>
              <a-button type="text" size="small" aria-label="复制大写拼音" @click="copyBillingField(billingStore.result.pinyinName, '大写拼音')">
                <CopyOutlined />
              </a-button>
            </div>
            <div class="billing-row">
              <span class="billing-label">详细地址</span>
              <strong class="billing-value">{{ billingStore.result.address }}</strong>
              <a-button type="text" size="small" aria-label="复制详细地址" @click="copyBillingField(billingStore.result.address, '详细地址')">
                <CopyOutlined />
              </a-button>
            </div>
            <div class="billing-row">
              <span class="billing-label">邮政编码</span>
              <strong class="billing-value">{{ billingStore.result.postalCode }}</strong>
              <a-button type="text" size="small" aria-label="复制邮政编码" @click="copyBillingField(billingStore.result.postalCode, '邮政编码')">
                <CopyOutlined />
              </a-button>
            </div>
          </div>
          <div class="billing-footer">
            <span class="billing-meta">地址来源：{{ billingStore.result.mapSource }}</span>
            <a-button size="small" @click="copyAllBilling">一键复制全部</a-button>
          </div>
        </template>
        <template v-else>
          <a-alert v-if="billingError" type="error" show-icon :message="billingError" class="billing-error" />
          <div class="billing-empty">
            <span class="muted">本地随机生成可用于支付的账单信息</span>
            <a-button size="small" type="primary" :loading="billingGenerating" @click="generateBilling">生成账单信息</a-button>
          </div>
        </template>
      </div>
      <div class="modal-actions">
        <a-popconfirm
          title="确定清空该账号的支付链接？"
          ok-text="清空"
          cancel-text="取消"
          @confirm="clearLink"
        >
          <a-button danger>
            <template #icon><DeleteOutlined /></template>
            清空
          </a-button>
        </a-popconfirm>
        <span class="action-spacer" />
        <a-button @click="copyLink">
          <template #icon><CopyOutlined /></template>
          复制
        </a-button>
        <a-button type="primary" @click="editing = true">
          <template #icon><EditOutlined /></template>
          编辑
        </a-button>
      </div>
    </template>
  </a-modal>
</template>

<style scoped>
.qr-wrap {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 14px;
  padding: 6px 0 14px;
}

.billing-section {
  padding: 12px;
  border: 1px solid var(--kal-border);
  border-radius: 8px;
  background: var(--kal-block-bg);
}

.billing-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 10px;
}

.billing-title {
  font-weight: 600;
}

.billing-error {
  margin-bottom: 10px;
}

.billing-rows {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.billing-row {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 34px;
}

.billing-label {
  flex: 0 0 64px;
  color: var(--kal-muted);
  font-size: 12px;
}

.billing-value {
  flex: 1 1 auto;
  min-width: 0;
  font-size: 13px;
  line-height: 1.5;
  overflow-wrap: anywhere;
}

.billing-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-top: 10px;
}

.billing-meta {
  color: var(--kal-muted);
  font-size: 11px;
}

.billing-empty {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.modal-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 12px;
}

.action-spacer {
  flex: 1 1 auto;
}
</style>
