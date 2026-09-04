<script setup lang="ts">
import { ref, watch } from 'vue'
import type { Account, AccountTag } from '@shared/types'

const props = defineProps<{
  account: Account | null
  tags: AccountTag[]
}>()

const emit = defineEmits<{
  close: []
  save: [accountId: string, tagIds: string[]]
}>()

const selectedIds = ref<string[]>([])

watch(
  () => [props.account, props.tags] as const,
  ([account]) => {
    const available = new Set(props.tags.map((tag) => tag.id))
    selectedIds.value = (account?.tagIds ?? []).filter((id) => available.has(id))
  },
  { immediate: true }
)

function submit(): void {
  if (!props.account) return
  emit('save', props.account.id, [...selectedIds.value])
  emit('close')
}
</script>

<template>
  <a-modal
    :open="!!props.account"
    title="选择标签"
    width="480px"
    ok-text="保存"
    cancel-text="取消"
    @ok="submit"
    @cancel="emit('close')"
  >
    <p class="hint">为 {{ props.account?.email }} 选择一个或多个已创建的标签。</p>
    <a-checkbox-group v-if="props.tags.length" v-model:value="selectedIds" class="tag-options">
      <a-checkbox v-for="tag in props.tags" :key="tag.id" :value="tag.id" class="tag-option">
        <span class="color-dot" :style="{ backgroundColor: tag.color }" />
        <span>{{ tag.name }}</span>
      </a-checkbox>
    </a-checkbox-group>
    <a-alert
      v-else
      type="info"
      show-icon
      message="还没有可用标签"
      description="请先在标签管理中创建标签，再为账号选择。"
    />
  </a-modal>
</template>

<style scoped>
.hint {
  margin: 0 0 14px;
  color: var(--kal-muted);
  word-break: break-all;
}

.tag-options {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
  width: 100%;
}

.tag-option {
  min-width: 0;
  margin-inline-start: 0;
  padding: 8px 10px;
  border: 1px solid var(--kal-border);
  border-radius: 8px;
}

.color-dot {
  display: inline-block;
  width: 10px;
  height: 10px;
  margin: 0 7px 0 2px;
  border-radius: 50%;
}
</style>
