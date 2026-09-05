<script setup lang="ts">
import { computed, type Component } from 'vue'
import {
  CopyOutlined,
  DeleteOutlined,
  EditOutlined,
  GlobalOutlined,
  KeyOutlined,
  LinkOutlined,
  LogoutOutlined,
  SyncOutlined,
  ThunderboltOutlined
} from '@ant-design/icons-vue'

const props = defineProps<{
  active: boolean
  /** 正在进行中的操作，只让对应按钮转圈 */
  busyAction?: string | null
}>()

const emit = defineEmits<{
  logout: []
  'refresh-key': []
  'refresh-usage': []
  'copy-oidc': []
  'payment-link': []
  test: []
  portal: []
  edit: []
  remove: []
}>()

const busy = computed(() => !!props.busyAction)

type ActionKey =
  | 'logout'
  | 'refresh-key'
  | 'refresh-usage'
  | 'copy-oidc'
  | 'payment-link'
  | 'test'
  | 'portal'
  | 'edit'
  | 'remove'

interface MenuEntry {
  key: ActionKey
  label: string
  icon: Component
}

interface AccountAction {
  id: string
  title: string
  icon: Component
  action?: ActionKey
  menu?: MenuEntry[]
  danger?: boolean
  color?: string
}

/** 卡片与列表共用同一份动作定义，避免两种视图的能力逐渐不一致。 */
const actions = computed<AccountAction[]>(() => {
  const items: AccountAction[] = []
  if (props.active) {
    items.push({
      id: 'logout',
      action: 'logout',
      title: '退出登录（清理 Kiro IDE 凭证）',
      icon: LogoutOutlined,
      color: '#52c41a'
    })
  }
  items.push({
    id: 'refresh',
    title: '刷新',
    icon: SyncOutlined,
    menu: [
      { key: 'refresh-key', label: '刷新密钥', icon: KeyOutlined },
      { key: 'refresh-usage', label: '刷新用量与积分', icon: SyncOutlined }
    ]
  })
  items.push(
    { id: 'copy-oidc', action: 'copy-oidc', title: '复制 OIDC 精简 JSON', icon: CopyOutlined },
    { id: 'payment-link', action: 'payment-link', title: '支付链接', icon: LinkOutlined },
    { id: 'test', action: 'test', title: '测活（发一次真实对话）', icon: ThunderboltOutlined },
    { id: 'portal', action: 'portal', title: '前往Kiro.dev官网', icon: GlobalOutlined },
    { id: 'edit', action: 'edit', title: '编辑', icon: EditOutlined },
    { id: 'remove', action: 'remove', title: '删除', icon: DeleteOutlined, danger: true }
  )
  return items
})

function isLoading(item: AccountAction): boolean {
  const keys = item.menu ? item.menu.map((entry) => entry.key) : item.action ? [item.action] : []
  return keys.some((key) => props.busyAction === key)
}

const emitAction = emit as (event: ActionKey) => void

function trigger(key: ActionKey): void {
  emitAction(key)
}
</script>

<template>
  <div class="action-row">
    <template v-for="item in actions" :key="item.id">
      <a-dropdown v-if="item.menu" :disabled="busy && !isLoading(item)">
        <a-button
          type="text"
          size="small"
          class="action-btn"
          :title="item.title"
          :loading="isLoading(item)"
          :disabled="busy && !isLoading(item)"
          @click.stop
        >
          <template #icon><component :is="item.icon" /></template>
        </a-button>
        <template #overlay>
          <a-menu>
            <a-menu-item v-for="entry in item.menu" :key="entry.key" @click="trigger(entry.key)">
              <component :is="entry.icon" />
              {{ entry.label }}
            </a-menu-item>
          </a-menu>
        </template>
      </a-dropdown>
      <a-tooltip v-else :title="item.title">
        <a-button
          type="text"
          size="small"
          class="action-btn"
          :danger="item.danger"
          :style="item.color ? { color: item.color } : undefined"
          :loading="isLoading(item)"
          :disabled="busy && !isLoading(item)"
          @click.stop="item.action && trigger(item.action)"
        >
          <template #icon><component :is="item.icon" /></template>
        </a-button>
      </a-tooltip>
    </template>
  </div>
</template>

<style scoped>
.action-row {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  gap: 0;
}

.action-btn {
  width: 24px;
  min-width: 24px;
  height: 24px;
  padding: 0;
}

.action-btn :deep(.anticon) {
  font-size: 13px;
}
</style>
