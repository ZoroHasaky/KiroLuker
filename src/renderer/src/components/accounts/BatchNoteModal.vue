<script setup lang="ts">
import { ref } from 'vue'
import { message } from 'ant-design-vue'
import { useAccountsStore } from '@/stores/accounts'

const props = defineProps<{ ids: string[] }>()
const emit = defineEmits<{ close: [] }>()

const accountsStore = useAccountsStore()
const note = ref('')

function submit(): void {
  if (!props.ids.length) return void message.info('没有选中的账号')
  // 覆盖式：所选账号的备注统一改为输入值，留空即清空这些账号的备注
  const changed = accountsStore.setNoteForAccounts(props.ids, note.value)
  message.success(note.value.trim() ? `已为 ${changed} 个账号设置备注` : `已清空 ${changed} 个账号的备注`)
  emit('close')
}
</script>

<template>
  <a-modal
    :open="true"
    title="批量设置备注"
    centered
    width="520px"
    ok-text="保存"
    cancel-text="取消"
    @ok="submit"
    @cancel="emit('close')"
  >
    <p class="muted tip">
      将覆盖所选 {{ props.ids.length }} 个账号的备注；留空则清空这些账号的备注。
    </p>
    <a-textarea
      v-model:value="note"
      :rows="3"
      placeholder="例如：主力号 / 待观察 / 某渠道"
      allow-clear
      @press-enter="submit"
    />
  </a-modal>
</template>

<style scoped>
.tip {
  margin: 0 0 12px;
  font-size: 12px;
}
</style>
