<script setup lang="ts">
import { reactive, ref, watch } from 'vue'
import { DeleteOutlined, EditOutlined, PlusOutlined } from '@ant-design/icons-vue'
import { message } from 'ant-design-vue'
import TagColorSelector from './TagColorSelector.vue'
import type { AccountTag } from '@shared/types'

const props = defineProps<{
  open: boolean
  tags: AccountTag[]
}>()

const emit = defineEmits<{
  'update:open': [boolean]
  create: [{ name: string; color: string }]
  update: [AccountTag]
  remove: [string]
}>()

const DEFAULT_COLOR = '#1677ff'
const createForm = reactive({ name: '', color: DEFAULT_COLOR })
const editingId = ref<string | null>(null)
const editForm = reactive({ name: '', color: DEFAULT_COLOR })

watch(
  () => props.open,
  (open) => {
    if (!open) return
    editingId.value = null
    createForm.name = ''
    createForm.color = DEFAULT_COLOR
  }
)

function normalizedName(value: string): string {
  return value.trim().toLocaleLowerCase()
}

function validate(name: string, color: string, exceptId?: string): boolean {
  if (!name.trim()) {
    message.warning('标签名称不能为空')
    return false
  }
  if (!/^#[0-9a-f]{6}$/i.test(color)) {
    message.warning('请使用六位十六进制颜色，例如 #1677ff')
    return false
  }
  const duplicate = props.tags.some(
    (tag) => tag.id !== exceptId && normalizedName(tag.name) === normalizedName(name)
  )
  if (duplicate) {
    message.warning('标签名称不能重复')
    return false
  }
  return true
}

function createTag(): void {
  const name = createForm.name.trim()
  const color = createForm.color.toLowerCase()
  if (!validate(name, color)) return
  emit('create', { name, color })
  createForm.name = ''
}

function startEdit(tag: AccountTag): void {
  editingId.value = tag.id
  editForm.name = tag.name
  editForm.color = tag.color
}

function cancelEdit(): void {
  editingId.value = null
}

function updateTag(tag: AccountTag): void {
  const name = editForm.name.trim()
  const color = editForm.color.toLowerCase()
  if (!validate(name, color, tag.id)) return
  emit('update', { ...tag, name, color })
  editingId.value = null
}
</script>

<template>
  <a-modal
    :open="props.open"
    title="标签管理"
    width="620px"
    :footer="null"
    @cancel="emit('update:open', false)"
  >
    <div class="create-panel">
      <TagColorSelector v-model="createForm.color" />
      <div class="create-row">
        <a-input
          v-model:value="createForm.name"
          :maxlength="24"
          placeholder="输入新标签名称"
          allow-clear
          @press-enter="createTag"
        />
        <a-button type="primary" @click="createTag">
          <template #icon><PlusOutlined /></template>
          创建
        </a-button>
      </div>
    </div>

    <div v-if="props.tags.length" class="tag-list">
      <div v-for="tag in props.tags" :key="tag.id" class="tag-item">
        <div v-if="editingId === tag.id" class="edit-panel">
          <TagColorSelector v-model="editForm.color" />
          <div class="edit-row">
            <a-input
              v-model:value="editForm.name"
              :maxlength="24"
              size="small"
              @press-enter="updateTag(tag)"
            />
            <a-button type="link" size="small" @click="updateTag(tag)">保存</a-button>
            <a-button type="link" size="small" @click="cancelEdit">取消</a-button>
          </div>
        </div>
        <template v-else>
          <span class="color-dot" :style="{ backgroundColor: tag.color }" />
          <span class="tag-name">{{ tag.name }}</span>
          <a-button type="text" size="small" title="编辑标签" @click="startEdit(tag)">
            <EditOutlined />
          </a-button>
          <a-popconfirm
            title="删除后将从所有账号中移除该标签，确定继续？"
            ok-text="删除"
            cancel-text="取消"
            @confirm="emit('remove', tag.id)"
          >
            <a-button type="text" size="small" danger title="删除标签">
              <DeleteOutlined />
            </a-button>
          </a-popconfirm>
        </template>
      </div>
    </div>
    <a-empty v-else :image="undefined" description="暂无标签，请先创建" />
  </a-modal>
</template>

<style scoped>
.tag-item {
  display: flex;
  align-items: center;
  gap: 8px;
}

.create-panel {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin-bottom: 16px;
  padding: 12px;
  border: 1px solid var(--kal-border);
  border-radius: 10px;
  background: var(--kal-block-bg);
}

.create-row,
.edit-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.tag-list {
  max-height: 380px;
  overflow-y: auto;
  border-top: 1px solid var(--kal-border);
}

.tag-item {
  min-height: 48px;
  padding: 7px 2px;
  border-bottom: 1px solid var(--kal-border);
}

.edit-panel {
  display: flex;
  flex-direction: column;
  gap: 8px;
  width: 100%;
  padding: 4px 0;
}

.color-dot {
  flex: 0 0 auto;
  width: 12px;
  height: 12px;
  border-radius: 50%;
}

.tag-name {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
