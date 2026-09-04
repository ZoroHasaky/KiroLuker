<script setup lang="ts">
import { computed } from 'vue'
import { RocketFilled } from '@ant-design/icons-vue'
import { useUpdateStore } from '@/stores/update'
import { formatDate } from '@/utils/format'
import { handleMarkdownClick, renderMarkdown } from '@/utils/markdown'

const updateStore = useUpdateStore()
const update = computed(() => updateStore.result)
const transfer = computed(() => updateStore.transfer)
const notesHtml = computed(() => renderMarkdown(update.value?.notes ?? ''))
const isBusy = computed(() => ['checking', 'downloading', 'installing'].includes(transfer.value.status))
const transferError = computed(() =>
  updateStore.actionError || (transfer.value.status === 'error' ? transfer.value.message : '')
)

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  const index = Math.min(units.length - 1, Math.floor(Math.log(value) / Math.log(1024)))
  return `${(value / 1024 ** index).toFixed(index === 0 ? 0 : 1)} ${units[index]}`
}

const progressDetail = computed(() => {
  const state = transfer.value
  const parts: string[] = []
  if (state.total > 0) parts.push(`${formatBytes(state.transferred)} / ${formatBytes(state.total)}`)
  if (state.bytesPerSecond > 0) parts.push(`${formatBytes(state.bytesPerSecond)}/s`)
  return parts.join(' · ')
})

const primaryText = computed(() => {
  const state = transfer.value
  if (state.status === 'downloaded') {
    return state.mode === 'windows-auto' ? '立即重启更新' : '再次打开安装包'
  }
  if (state.status === 'installing') return '正在安装…'
  if (state.status === 'checking') return '正在准备…'
  if (state.mode === 'windows-auto') return '下载并更新'
  if (state.mode === 'mac-download') return '下载 DMG'
  return '前往更新'
})

function browserUpdate(): void {
  const url = update.value?.releaseUrl
  if (url) void window.api.openExternal(url)
}

async function primaryAction(): Promise<void> {
  const state = transfer.value
  if (state.mode === 'manual') {
    browserUpdate()
    return
  }
  if (state.status === 'downloaded') {
    await updateStore.applyDownloaded()
    return
  }
  if (!isBusy.value) await updateStore.download()
}
</script>

<template>
  <a-modal
    :open="updateStore.modalOpen"
    title="发现新版本"
    :width="500"
    centered
    :closable="transfer.status !== 'installing'"
    :mask-closable="!isBusy"
    :keyboard="transfer.status !== 'installing'"
    @cancel="updateStore.closeModal"
  >
    <div class="check-result">
      <RocketFilled class="check-icon" />
      <div class="check-title">有新版本可以更新</div>
      <div class="version-flow">
        <span class="version-chip">v{{ update?.current }}</span>
        <span class="muted">→</span>
        <span class="version-chip new">v{{ update?.latest }}</span>
      </div>
      <div v-if="update?.publishedAt" class="muted release-time">
        发布于 {{ formatDate(update.publishedAt) }}
      </div>
    </div>
    <div v-if="transfer.status === 'checking'" class="transfer-panel">
      <a-spin />
      <span>{{ transfer.message || '正在准备更新…' }}</span>
    </div>
    <div v-else-if="transfer.status === 'downloading'" class="transfer-panel vertical">
      <a-progress :percent="Math.round(transfer.percent)" status="active" />
      <div class="transfer-row muted">
        <span>{{ transfer.message }}</span>
        <span v-if="progressDetail">{{ progressDetail }}</span>
      </div>
    </div>
    <a-alert
      v-else-if="transfer.status === 'downloaded'"
      type="success"
      show-icon
      :message="transfer.message"
      :description="transfer.downloadedFileName"
      class="transfer-alert"
    />
    <a-alert
      v-else-if="transfer.status === 'installing'"
      type="info"
      show-icon
      message="正在退出并安装更新"
      description="安装完成后 KiroLuker 会自动重新启动。"
      class="transfer-alert"
    />
    <a-alert
      v-else-if="transferError"
      type="error"
      show-icon
      message="更新失败"
      :description="transferError"
      class="transfer-alert"
    />
    <a-alert
      v-else-if="transfer.mode === 'mac-download'"
      type="info"
      show-icon
      message="macOS 当前使用未签名安装包"
      description="下载并校验 DMG 后会自动打开，请将 KiroLuker 拖入“应用程序”完成覆盖更新。"
      class="transfer-alert"
    />
    <div v-if="notesHtml" class="release-notes">
      <div class="release-notes-title muted">更新说明</div>
      <div class="release-notes-body markdown" v-html="notesHtml" @click="handleMarkdownClick" />
    </div>
    <template #footer>
      <a-button v-if="transfer.status !== 'installing'" @click="updateStore.closeModal">稍后再说</a-button>
      <a-button
        v-if="transfer.status === 'downloading'"
        danger
        @click="updateStore.cancelDownload"
      >
        取消下载
      </a-button>
      <a-button
        v-else-if="transfer.status !== 'installing' && transfer.mode !== 'manual'"
        @click="browserUpdate"
      >
        浏览器下载
      </a-button>
      <a-button
        type="primary"
        :loading="transfer.status === 'checking'"
        :disabled="transfer.status === 'downloading' || transfer.status === 'installing'"
        @click="primaryAction"
      >
        {{ primaryText }}
      </a-button>
    </template>
  </a-modal>
</template>


<style scoped>
.check-result { text-align: center; padding: 8px 0 4px; }
.check-icon { color: var(--kal-primary); font-size: 40px; }
.check-title { margin: 10px 0 6px; font-size: 16px; font-weight: 600; }
.version-flow { display: flex; align-items: center; justify-content: center; gap: 10px; }
.version-chip { padding: 2px 10px; border-radius: 6px; background: var(--kal-block-bg); font-size: 13px; }
.version-chip.new { color: #fff; background: var(--kal-primary); }
.release-time { margin-top: 8px; font-size: 12px; }
.transfer-panel { display: flex; align-items: center; justify-content: center; gap: 10px; margin-top: 16px; padding: 14px; border-radius: 8px; background: var(--kal-block-bg); }
.transfer-panel.vertical { display: block; }
.transfer-row { display: flex; justify-content: space-between; gap: 12px; margin-top: 4px; font-size: 12px; }
.transfer-alert { margin-top: 16px; }
.release-notes { margin-top: 16px; padding: 12px; border-radius: 8px; background: var(--kal-block-bg); }
.release-notes-title { margin-bottom: 6px; font-size: 12px; }
.release-notes-body { max-height: 280px; overflow: auto; font-size: 13px; line-height: 1.75; word-break: break-word; }
.markdown :deep(> *:first-child) { margin-top: 0; }
.markdown :deep(> *:last-child) { margin-bottom: 0; }
.markdown :deep(h1),
.markdown :deep(h2),
.markdown :deep(h3),
.markdown :deep(h4) { margin: 14px 0 6px; font-size: 14px; font-weight: 600; line-height: 1.5; }
.markdown :deep(h1) { font-size: 16px; }
.markdown :deep(h2) { font-size: 15px; }
.markdown :deep(p) { margin: 0 0 8px; }
.markdown :deep(ul),
.markdown :deep(ol) { margin: 0 0 8px; padding-left: 20px; }
.markdown :deep(li) { margin: 2px 0; }
.markdown :deep(li > p) { margin: 0; }
.markdown :deep(a) { color: var(--kal-primary); }
.markdown :deep(code) { padding: 1px 4px; border-radius: 4px; background: var(--kal-code-bg); }
</style>
