<script setup lang="ts">
import { computed } from 'vue'
import { RocketFilled } from '@ant-design/icons-vue'
import { useUpdateStore } from '@/stores/update'
import { formatDate } from '@/utils/format'
import { handleMarkdownClick, renderMarkdown } from '@/utils/markdown'

const updateStore = useUpdateStore()
const update = computed(() => updateStore.result)
const notesHtml = computed(() => renderMarkdown(update.value?.notes ?? ''))

function goUpdate(): void {
  const url = update.value?.releaseUrl
  if (url) void window.api.openExternal(url)
  updateStore.closeModal()
}
</script>

<template>
  <a-modal
    :open="updateStore.modalOpen"
    title="发现新版本"
    :width="500"
    centered
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
    <div v-if="notesHtml" class="release-notes">
      <div class="release-notes-title muted">更新说明</div>
      <div class="release-notes-body markdown" v-html="notesHtml" @click="handleMarkdownClick" />
    </div>
    <template #footer>
      <a-button @click="updateStore.closeModal">稍后再说</a-button>
      <a-button type="primary" @click="goUpdate">前往更新</a-button>
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