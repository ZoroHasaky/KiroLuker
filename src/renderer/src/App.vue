<script setup lang="ts">
import { onMounted, onUnmounted, watch } from 'vue'
import { useRouter } from 'vue-router'
import { Modal } from 'ant-design-vue'
import zhCN from 'ant-design-vue/es/locale/zh_CN'
import AppSidebar from '@/components/layout/AppSidebar.vue'
import AppTitleBar from '@/components/layout/AppTitleBar.vue'
import { useSettingsStore } from '@/stores/settings'
import { useAccountsStore } from '@/stores/accounts'
import { useTrayBridge } from '@/utils/tray'

const settingsStore = useSettingsStore()
const accountsStore = useAccountsStore()
const router = useRouter()

useTrayBridge()

// kiro-manager-lite://accounts 之类的协议唤起，跳到对应页面
let offNavigate: (() => void) | undefined
// 托盘「退出程序」的确认框，避免连点托盘菜单弹出多个
let offConfirmQuit: (() => void) | undefined
let quitConfirmOpen = false

function confirmQuit(): void {
  if (quitConfirmOpen) return
  quitConfirmOpen = true
  Modal.confirm({
    title: '退出 Kiro Manager Lite',
    content: '退出后自动刷新与 IDE 主动续期都会停止，托盘图标也会一起关闭。',
    okText: '退出',
    okType: 'danger',
    cancelText: '取消',
    onOk: () => void window.api.quitApp(),
    afterClose: () => {
      quitConfirmOpen = false
    }
  })
}

onMounted(() => {
  offNavigate = window.api.onAppNavigate((target) => {
    if (router.hasRoute(target)) void router.push({ name: target })
  })
  offConfirmQuit = window.api.onConfirmQuit(confirmQuit)
})
onUnmounted(() => {
  offNavigate?.()
  offConfirmQuit?.()
})

onMounted(async () => {
  await settingsStore.load()
  await accountsStore.load()
  accountsStore.startAutoRefresh()
})

// 开关或间隔改动后重新对齐自动刷新；startAutoRefresh 是幂等的，
// 设置对象整体替换带来的无关触发不会把正在跑的倒计时清零
watch(
  () => [
    settingsStore.settings.autoRefresh,
    settingsStore.settings.autoRefreshUsage,
    settingsStore.settings.keyRefreshInterval,
    settingsStore.settings.usageRefreshInterval
  ],
  () => accountsStore.startAutoRefresh()
)

// 原生窗口标题：带上当前版本号
watch(
  () => settingsStore.appInfo?.version,
  (version) => {
    document.title = version ? `Kiro Manager Lite v${version}` : 'Kiro Manager Lite'
  },
  { immediate: true }
)
</script>

<template>
  <a-config-provider :theme="settingsStore.themeConfig" :locale="zhCN" component-size="large">
    <div class="app-shell">
      <AppSidebar />
      <div class="app-body">
        <AppTitleBar />
        <main class="app-content">
          <router-view v-slot="{ Component }">
            <transition name="fade" mode="out-in">
              <component :is="Component" />
            </transition>
          </router-view>
        </main>
      </div>
    </div>
  </a-config-provider>
</template>

<style scoped>
.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.14s ease;
}

.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}
</style>
