<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { CopyOutlined, DeleteOutlined, EditOutlined } from '@ant-design/icons-vue'
import { message } from 'ant-design-vue'
import { copyText } from '@/utils/ui'
import type { Account } from '@shared/types'

const props = defineProps<{ account: Account | null }>()

const emit = defineEmits<{
  close: []
  save: [accountId: string, paymentLink: string]
  clear: [accountId: string]
}>()

const editing = ref(false)
const value = ref('')
const savedLink = ref('')
const currentLink = computed(() => savedLink.value)

watch(
  () => [props.account?.id, props.account?.paymentLink] as const,
  ([, paymentLink]) => {
    savedLink.value = paymentLink?.trim() ?? ''
    value.value = savedLink.value
    editing.value = !value.value
  },
  { immediate: true }
)

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
        <a-typography-paragraph class="link-text" :ellipsis="{ rows: 2, tooltip: currentLink }">
          {{ currentLink }}
        </a-typography-paragraph>
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
  padding: 6px 0 20px;
}

.link-text {
  width: 100%;
  margin: 0 !important;
  text-align: center;
  word-break: break-all;
}

.modal-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
}

.action-spacer {
  flex: 1 1 auto;
}
</style>
