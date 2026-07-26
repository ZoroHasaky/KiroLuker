<script setup lang="ts">
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import { CheckCircleFilled, ExclamationCircleOutlined } from '@ant-design/icons-vue'
import { useAccountsStore } from '@/stores/accounts'
import { useSettingsStore } from '@/stores/settings'
import { displayEmail } from '@/utils/display'

const route = useRoute()
const accountsStore = useAccountsStore()
const settingsStore = useSettingsStore()

const title = computed(() => (route.meta.title as string) || '主页')

/** IDE 当前账号只在账户管理页展示，其他页面保持页头干净 */
const showIdeStatus = computed(() => route.name === 'accounts')

const activeLabel = computed(() => {
  const account = accountsStore.activeAccount
  if (!account) return null
  // 打码时昵称同样会暴露邮箱前缀，所以只显示打码后的邮箱
  if (settingsStore.settings.privacyMode) return displayEmail(account.email, true)
  return account.nickname ? `${account.nickname} · ${account.email}` : account.email
})
</script>

<template>
  <header class="app-titlebar">
    <strong>{{ title }}</strong>

    <template v-if="accountsStore.task.running">
      <a-progress
        :percent="Math.round((accountsStore.task.done / Math.max(1, accountsStore.task.total)) * 100)"
        :show-info="false"
        size="small"
        style="width: 140px; margin: 0"
      />
      <span class="muted" style="font-size: 12px">
        {{ accountsStore.task.label }} {{ accountsStore.task.done }}/{{ accountsStore.task.total }}
      </span>
    </template>

    <span class="toolbar-spacer" />

    <template v-if="showIdeStatus">
      <a-tag v-if="activeLabel" color="green" style="margin: 0">
        <CheckCircleFilled /> IDE 当前：{{ activeLabel }}
      </a-tag>
      <a-tag v-else style="margin: 0">
        <ExclamationCircleOutlined /> IDE 未匹配到已管理账号
      </a-tag>
      <a-button size="small" @click="accountsStore.syncActiveFromIde()">重新检测</a-button>
    </template>
  </header>
</template>
