<script setup lang="ts">
import { ref, watch } from 'vue'
import type { AccountTag } from '@shared/types'

const props = defineProps<{
  accountCount: number
  initialTagIds: string[]
  tags: AccountTag[]
}>()

const emit = defineEmits<{
  close: []
  save: [tagIds: string[]]
}>()

const selectedIds = ref<string[]>([])

watch(
  () => [props.initialTagIds, props.tags] as const,
  ([initialTagIds]) => {
    const available = new Set(props.tags.map((tag) => tag.id))
    selectedIds.value = [...new Set(initialTagIds.filter((id) => available.has(id)))]
  },
  { immediate: true }
)

function submit(): void {
  emit('save', [...selectedIds.value])
  emit('close')
}
</script>

<template>
  <a-modal
    :open="true"
    title="批量设置标签"
    width="480px"
    ok-text="保存"
    cancel-text="取消"
    @ok="submit"
    @cancel="emit('close')"
  >
    <p class="hint">为已选的 {{ props.accountCount }} 个账号设置标签。</p>
    <a-alert
      class="overwrite-notice"
      type="warning"
      show-icon
      message="保存会覆盖所有已选账号当前的标签"
      description="仅预选所有账号共有的标签；取消全部勾选后保存即可批量清空标签。"
    />
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
      description="保存后会清空已选账号的标签；如需添加标签，请先在标签管理中创建。"
    />
  </a-modal>
</template>

<style scoped>
.hint {
  margin: 0 0 14px;
  color: var(--kal-muted);
}

.overwrite-notice {
  margin-bottom: 14px;
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
