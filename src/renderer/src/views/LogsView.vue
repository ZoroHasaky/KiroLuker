<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { message } from 'ant-design-vue'
import {
  ClearOutlined,
  DownloadOutlined,
  FolderOpenOutlined,
  SearchOutlined,
  SyncOutlined,
  VerticalAlignBottomOutlined
} from '@ant-design/icons-vue'
import VirtualList from '@/components/common/VirtualList.vue'
import { formatLogTime } from '@/utils/format'
import { exportStamp } from '@/utils/transfer'
import { toPlain } from '@/utils/ipc'
import { bodyPopupContainer, confirmDanger } from '@/utils/ui'
import { LOG_LEVELS, type LogEntry, type LogLevel, type LogQuery } from '@shared/types'

/**
 * 单行日志的高度估算值（padding 3 + line-height 16 + padding 3）。
 * 虚拟列表开了动态行高，实际高度会在渲染后实测校正，这里只影响首帧与未测量行。
 */
const ROW_HEIGHT = 22
/** 新日志到达后的重查节流：高频写入时不必每条都刷界面 */
const REFRESH_THROTTLE_MS = 700

const TIME_RANGES = [
  { value: 0, label: '全部时间' },
  { value: 5 * 60_000, label: '最近 5 分钟' },
  { value: 60 * 60_000, label: '最近 1 小时' },
  { value: 6 * 60 * 60_000, label: '最近 6 小时' },
  { value: 24 * 60 * 60_000, label: '最近 24 小时' }
]

const LIMITS = [500, 1000, 5000, 20000]

const LEVEL_META: Record<LogLevel, { text: string; color: string }> = {
  debug: { text: 'DEBUG', color: '#8c8c8c' },
  info: { text: 'INFO', color: '#1677ff' },
  warn: { text: 'WARN', color: '#faad14' },
  error: { text: 'ERROR', color: '#ff4d4f' }
}

const keyword = ref('')
const levels = ref<LogLevel[]>([])
const category = ref<string | undefined>(undefined)
const range = ref(0)
const limit = ref(1000)
const autoFollow = ref(true)

const entries = ref<LogEntry[]>([])
const matched = ref(0)
const total = ref(0)
const counts = ref<Record<LogLevel, number>>({ debug: 0, info: 0, warn: 0, error: 0 })
const categories = ref<string[]>([])
const loading = ref(false)

// 泛型组件拿不到 InstanceType，按暴露出的方法声明即可（与 VirtualGrid 的用法一致）
const listRef = ref<{
  scrollToBottom: (smooth?: boolean) => void
  scrollToTop: () => void
} | null>(null)

/**
 * 用户是否已经向上翻离了底部。
 *
 * 阈值取一屏的一小段（80px，约 3~4 行）：手指轻微抖动或行高实测导致的
 * 几像素误差不该被判成「离开底部」，否则跟随会时开时关。
 */
const AWAY_THRESHOLD_PX = 80
const distanceToBottom = ref(0)
const awayFromBottom = computed(() => distanceToBottom.value > AWAY_THRESHOLD_PX)

function onScrollState(state: { distanceToBottom: number }): void {
  distanceToBottom.value = state.distanceToBottom
}

/** 回到底部：平滑滚动，滚完自然重新进入跟随状态 */
function backToBottom(): void {
  listRef.value?.scrollToBottom(true)
}

const followTip = computed(() => {
  if (!autoFollow.value) return '已关闭自动跟随，点击开启'
  return awayFromBottom.value ? '自动跟随已开启，向上翻看时暂停' : '自动跟随最新日志'
})

/** 手动开启跟随时顺带回到底部，否则开了却还停在上面会让人困惑 */
function toggleFollow(): void {
  autoFollow.value = !autoFollow.value
  if (autoFollow.value) backToBottom()
}

const categoryOptions = computed(() => [
  { value: '', label: '全部分类' },
  ...categories.value.map((c) => ({ value: c, label: c }))
])

/**
 * 当前筛选条件，查询与导出共用。
 * 必须经 toPlain 剥掉响应式代理：levels 是 ref 里的数组，直接经 IPC 传会报
 * "An object could not be cloned"。
 */
function buildQuery(overrides: Partial<LogQuery> = {}): LogQuery {
  return toPlain({
    keyword: keyword.value.trim() || undefined,
    levels: levels.value.length ? levels.value : undefined,
    category: category.value || undefined,
    since: range.value ? Date.now() - range.value : undefined,
    limit: limit.value,
    ...overrides
  })
}

async function refresh(keepPosition = false): Promise<void> {
  loading.value = true
  try {
    const res = await window.api.queryLogs(buildQuery())
    if (!res.success || !res.data) return void message.error(res.error || '读取日志失败')
    entries.value = res.data.entries
    matched.value = res.data.matched
    total.value = res.data.total
    counts.value = res.data.counts
    categories.value = res.data.categories
    /*
     * 贴底跟随的两个前提：手动开关开着，且用户当前就停在底部附近。
     * 用户向上翻看历史时（awayFromBottom）绝不自动滚，否则视图会被新日志
     * 不断拽回底部，根本没法看之前的内容。
     */
    if (!keepPosition || (autoFollow.value && !awayFromBottom.value)) {
      await Promise.resolve()
      listRef.value?.scrollToBottom()
    }
  } finally {
    loading.value = false
  }
}

/** 切换级别徽章：点中的再点一次取消 */
function toggleLevel(level: LogLevel): void {
  levels.value = levels.value.includes(level)
    ? levels.value.filter((l) => l !== level)
    : [...levels.value, level]
}

function clearLevels(): void {
  levels.value = []
}

async function download(): Promise<void> {
  const res = await window.api.exportLogs(buildQuery({ limit: undefined }))
  if (!res.success || !res.data) return void message.error(res.error || '导出失败')
  if (!res.data.content) return void message.info('当前筛选没有日志可导出')
  const saved = await window.api.exportToFile(res.data.content, `kiro-logs-${exportStamp()}.log`)
  if (!saved.success) return void message.error(saved.error || '保存失败')
  if (saved.data?.saved) message.success('日志已导出')
}

/** 模板里访问不到 window，单独包一层 */
function openLogDir(): void {
  void window.api.showPath('logs')
}

function clearAll(): void {
  confirmDanger({
    title: '清空系统日志',
    content: '会同时删除磁盘上已归档的日志分片，操作不可撤销。',
    okText: '清空',
    onOk: async () => {
      const res = await window.api.clearLogs()
      if (!res.success) return void message.error(res.error || '清空失败')
      await refresh()
      message.success('日志已清空')
    }
  })
}

// 筛选条件变化即重查；输入框改动也走这里，antd 的 allow-clear 同样能触发
watch([keyword, levels, category, range, limit], () => void refresh())

let offAppend: (() => void) | undefined
let throttleTimer: ReturnType<typeof setTimeout> | null = null

onMounted(() => {
  void refresh()
  offAppend = window.api.onLogAppended(() => {
    if (throttleTimer) return
    throttleTimer = setTimeout(() => {
      throttleTimer = null
      void refresh(true)
    }, REFRESH_THROTTLE_MS)
  })
})

onUnmounted(() => {
  offAppend?.()
  if (throttleTimer) clearTimeout(throttleTimer)
})
</script>

<template>
  <div class="logs-page">
    <div class="logs-toolbar">
      <a-input
        v-model:value="keyword"
        allow-clear
        placeholder="按消息、分类搜索…"
        class="search-input"
      >
        <template #prefix><SearchOutlined /></template>
      </a-input>

      <!-- 尺寸不显式指定，跟随全局 component-size="large"，与搜索框保持一致 -->
      <a-select
        v-model:value="range"
        :options="TIME_RANGES"
        style="width: 160px"
        :get-popup-container="bodyPopupContainer"
      />
      <a-select
        :value="category ?? ''"
        :options="categoryOptions"
        style="width: 180px"
        :get-popup-container="bodyPopupContainer"
        @change="(v: any) => (category = v || undefined)"
      />
      <a-select
        v-model:value="limit"
        style="width: 110px"
        :get-popup-container="bodyPopupContainer"
        :options="LIMITS.map((n) => ({ value: n, label: n >= 1000 ? `${n / 1000}K 行` : `${n} 行` }))"
      />

      <div class="level-chips">
        <button class="chip" :class="{ on: levels.length === 0 }" @click="clearLevels">
          全部 {{ total }}
        </button>
        <button
          v-for="level in LOG_LEVELS"
          :key="level"
          class="chip"
          :class="{ on: levels.includes(level) }"
          :style="levels.includes(level) ? { borderColor: LEVEL_META[level].color, color: LEVEL_META[level].color } : undefined"
          @click="toggleLevel(level)"
        >
          {{ LEVEL_META[level].text }} {{ counts[level] }}
        </button>
      </div>

      <!-- 五个操作图标作为一个整体：组内不换行，空间不足时整组一起折到下一行 -->
      <div class="toolbar-actions">
        <a-tooltip :title="followTip">
          <a-button
            :type="autoFollow ? 'primary' : 'default'"
            @click="toggleFollow"
          >
            <template #icon><VerticalAlignBottomOutlined /></template>
          </a-button>
        </a-tooltip>
        <a-tooltip title="刷新">
          <a-button :loading="loading" @click="refresh()">
            <template #icon><SyncOutlined /></template>
          </a-button>
        </a-tooltip>
        <a-tooltip title="下载当前筛选结果">
          <a-button @click="download">
            <template #icon><DownloadOutlined /></template>
          </a-button>
        </a-tooltip>
        <a-tooltip title="打开日志目录">
          <a-button @click="openLogDir">
            <template #icon><FolderOpenOutlined /></template>
          </a-button>
        </a-tooltip>
        <a-tooltip title="清空日志">
          <a-button danger @click="clearAll">
            <template #icon><ClearOutlined /></template>
          </a-button>
        </a-tooltip>
      </div>
    </div>

    <div class="logs-meta muted">
      命中 {{ matched }} 条，显示最新 {{ entries.length }} 条
      <template v-if="matched > entries.length">（可调整右上角行数上限）</template>
    </div>

    <div class="logs-body">
      <VirtualList
        ref="listRef"
        :items="entries"
        :row-height="ROW_HEIGHT"
        dynamic-height
        :item-key="(item: LogEntry) => item.id"
        @scroll-state="onScrollState"
      >
        <template #default="{ item }">
          <span class="log-dot" :style="{ background: LEVEL_META[item.level].color }" />
          <span class="log-time mono">{{ formatLogTime(item.at) }}</span>
          <span class="log-category" :title="item.category">{{ item.category }}</span>
          <span class="log-message mono" :style="{ color: LEVEL_META[item.level].color }">
            {{ item.message }}
          </span>
        </template>
      </VirtualList>

      <div v-if="!entries.length" class="logs-empty muted">
        {{ total ? '当前筛选没有匹配的日志' : '暂时还没有日志' }}
      </div>

      <!-- 向上翻看时才出现：提示已暂停跟随，点一下回到最新 -->
      <Transition name="fade-up">
        <button
          v-if="awayFromBottom && entries.length"
          type="button"
          class="back-bottom"
          @click="backToBottom"
        >
          <VerticalAlignBottomOutlined class="bb-icon" />
          <span class="bb-text">回到最新</span>
        </button>
      </Transition>
    </div>
  </div>
</template>

<style scoped>
.logs-page {
  display: flex;
  flex-direction: column;
  gap: 10px;
  height: 100%;
  min-height: 0;
}

.logs-toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.search-input {
  width: 240px;
}

/* margin-left: auto 顶到右侧；同行或换行后都保持右对齐，且组内始终一排 */
.toolbar-actions {
  display: inline-flex;
  flex: 0 0 auto;
  flex-wrap: nowrap;
  align-items: center;
  gap: 8px;
  margin-left: auto;
}

.level-chips {
  display: inline-flex;
  gap: 6px;
}

/* 高度对齐 large 尺寸的输入框与按钮（ant 的 large 控件高 40px） */
.chip {
  display: inline-flex;
  align-items: center;
  height: 40px;
  padding: 0 14px;
  border-radius: 999px;
  border: 1px solid var(--kal-border);
  background: transparent;
  color: inherit;
  font: inherit;
  font-size: 13px;
  white-space: nowrap;
  cursor: pointer;
  transition: border-color 0.15s ease, background 0.15s ease;
}

.chip:hover {
  border-color: var(--kal-primary);
}

.chip.on {
  border-color: var(--kal-primary);
  color: var(--kal-primary);
  background: color-mix(in srgb, var(--kal-primary) 10%, transparent);
}

.logs-meta {
  font-size: 12px;
}

/* 回到最新：日志区右下角悬浮，图标在上文字在下 */
.back-bottom {
  position: absolute;
  /* 往左让开纵向滚动条，避免压在滚动条上不好点 */
  right: 34px;
  bottom: 16px;
  z-index: 3;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  padding: 8px 12px 7px;
  border: none;
  border-radius: 12px;
  background: var(--kal-primary);
  color: #fff;
  cursor: pointer;
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.18);
  transition: filter 0.16s ease, transform 0.16s ease;
}
.back-bottom:hover { filter: brightness(1.08); }
.back-bottom:active { transform: translateY(1px); }
.bb-icon { font-size: 16px; line-height: 1; }
.bb-text { font-size: 11px; line-height: 1.2; white-space: nowrap; }

/* 淡入并轻微上浮，避免突然弹出 */
.fade-up-enter-active,
.fade-up-leave-active {
  transition: opacity 0.18s ease, transform 0.18s ease;
}
.fade-up-enter-from,
.fade-up-leave-to {
  opacity: 0;
  transform: translateY(6px);
}

.logs-body {
  position: relative;
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  border: 1px solid var(--kal-border);
  border-radius: 10px;
  background: var(--kal-code-bg);
  overflow: hidden;
}

.logs-empty {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  font-size: 13px;
  pointer-events: none;
}

/*
 * 行内各列：等宽字体 + 固定列宽，肉眼扫读时上下对齐。
 * 行高由内容决定（虚拟列表开了 dynamic-height），前三列用 line-height
 * 与消息首行对齐，长消息在消息列内换行。
 */
.log-dot {
  flex: 0 0 auto;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  margin: 8px;
}

.log-time {
  flex: 0 0 auto;
  width: 150px;
  padding: 3px 0;
  font-size: 11px;
  line-height: 16px;
  color: var(--kal-muted);
}

.log-category {
  flex: 0 0 auto;
  width: 110px;
  padding: 3px 8px 3px 0;
  font-size: 11px;
  line-height: 16px;
  color: var(--kal-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.log-message {
  flex: 1 1 auto;
  min-width: 0;
  padding: 3px 12px 3px 0;
  font-size: 12px;
  line-height: 16px;
  /* 保留原始空白与换行，同时允许长串（URL、JSON）断行 */
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  word-break: break-word;
}
</style>
