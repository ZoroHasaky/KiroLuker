<script setup lang="ts">
import { computed } from 'vue'
import { useAccountsStore, type AccountTaskType } from '@/stores/accounts'

const accountsStore = useAccountsStore()

const accountTaskLabels: Record<AccountTaskType, string> = {
  'import-validation': '批量导入校验中',
  'account-key-refresh': '正在刷新账户密钥',
  'account-usage-refresh': '正在刷新账户用量与积分'
}

const accountTaskLabel = computed(() => accountTaskLabels[accountsStore.task.type])
const percent = computed(() =>
  Math.round((accountsStore.task.done / Math.max(1, accountsStore.task.total)) * 100)
)
</script>

<template>
  <Transition name="task-progress">
    <div v-if="accountsStore.task.running" class="account-task-progress" role="status">
      <a-progress
        :percent="percent"
        :show-info="false"
        size="small"
        class="task-progress-bar"
      />
      <span class="muted task-progress-label">
        {{ accountTaskLabel }} {{ accountsStore.task.done }}/{{ accountsStore.task.total }}
      </span>
    </div>
  </Transition>
</template>

<style scoped>
.account-task-progress {
  position: fixed;
  right: 24px;
  bottom: 24px;
  z-index: 1100;
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 330px;
  max-width: calc(100vw - 32px);
  padding: 11px 14px;
  border: 1px solid var(--kal-border);
  border-radius: 10px;
  background: var(--kal-card-bg);
  box-shadow: 0 8px 28px rgba(0, 0, 0, 0.16);
  pointer-events: none;
}

.task-progress-bar {
  flex: 0 0 140px;
  width: 140px;
  margin: 0;
}

.task-progress-label {
  font-size: 12px;
  white-space: nowrap;
}

.task-progress-enter-active,
.task-progress-leave-active {
  transition: opacity 0.16s ease, transform 0.16s ease;
}

.task-progress-enter-from,
.task-progress-leave-to {
  opacity: 0;
  transform: translateY(8px);
}
</style>
