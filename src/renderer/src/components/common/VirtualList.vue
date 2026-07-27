<script setup lang="ts" generic="T">
/**
 * 单列虚拟列表，支持两种行高模式。
 *
 * 定高（默认）：行高由 rowHeight 给出，可见区间用除法 O(1) 算出，
 * 专门服务「几万行、每行等高」的场景。
 *
 * 动态（dynamicHeight）：行高由内容决定，适合日志这类长消息需要换行的场景。
 * 做法是先用 rowHeight 当估算值，渲染后用 ResizeObserver 实测可见行的真实高度，
 * 按 itemKey 缓存下来并重算前缀和。只有可见的那几十行需要测量，
 * 列表整体替换（日志刷新）时缓存仍然命中，不会反复抖动。
 *
 * 提供 scrollToBottom：日志默认看最新的，追加后需要贴底。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'

const props = withDefaults(
  defineProps<{
    items: T[]
    /** 定高模式下的行高；动态模式下作为首次渲染前的估算值（px） */
    rowHeight?: number
    /** 行高是否由内容决定 */
    dynamicHeight?: boolean
    /** 视口上下各额外渲染的行数 */
    bufferRows?: number
    itemKey?: (item: T, index: number) => string | number
  }>(),
  { rowHeight: 22, dynamicHeight: false, bufferRows: 8, itemKey: undefined }
)

const viewport = ref<HTMLElement | null>(null)
const viewportHeight = ref(0)
const scrollTop = ref(0)

/** 实测行高缓存，key 取 itemKey；测量结果变化时 bump version 触发重算 */
const measured = new Map<string, number>()
const version = ref(0)

function keyOf(item: T, index: number): string {
  return String(props.itemKey ? props.itemKey(item, index) : index)
}

function heightAt(item: T, index: number): number {
  return measured.get(keyOf(item, index)) ?? props.rowHeight
}

/**
 * 动态模式的行偏移前缀和：prefix[i] 是第 i 行的顶部位置，最后一项是总高度。
 * 定高模式不走这里，避免上万行每次都做 O(n) 累加。
 */
const prefix = computed<number[]>(() => {
  if (!props.dynamicHeight) return []
  void version.value
  const list = props.items
  const result = new Array<number>(list.length + 1)
  result[0] = 0
  for (let i = 0; i < list.length; i++) result[i + 1] = result[i] + heightAt(list[i], i)
  return result
})

const totalHeight = computed(() =>
  props.dynamicHeight
    ? (prefix.value[props.items.length] ?? 0)
    : props.items.length * props.rowHeight
)

/** 二分找出第一个底部越过 scrollTop 的行 */
function rowAt(offset: number): number {
  const p = prefix.value
  let low = 0
  let high = props.items.length
  while (low < high) {
    const mid = (low + high) >> 1
    if (p[mid + 1] <= offset) low = mid + 1
    else high = mid
  }
  return low
}

const startIndex = computed(() => {
  if (!props.dynamicHeight) {
    return Math.max(0, Math.floor(scrollTop.value / props.rowHeight) - props.bufferRows)
  }
  return Math.max(0, rowAt(scrollTop.value) - props.bufferRows)
})

const endIndex = computed(() => {
  const count = props.items.length
  if (!props.dynamicHeight) {
    const visible = Math.ceil(viewportHeight.value / props.rowHeight) + props.bufferRows * 2 + 1
    return Math.min(count, startIndex.value + visible)
  }
  // 从起始行往下累加，直到填满视口再多铺一段缓冲
  const bottom = scrollTop.value + viewportHeight.value
  const p = prefix.value
  let index = rowAt(scrollTop.value)
  while (index < count && p[index] < bottom) index++
  return Math.min(count, index + props.bufferRows)
})

const visibleItems = computed(() => props.items.slice(startIndex.value, endIndex.value))

const offsetStyle = computed(() => {
  const top = props.dynamicHeight
    ? (prefix.value[startIndex.value] ?? 0)
    : startIndex.value * props.rowHeight
  return { transform: `translateY(${top}px)` }
})

/** 是否已经贴在底部：决定新日志进来要不要自动跟随 */
const atBottom = computed(() => {
  const el = viewport.value
  if (!el) return true
  return el.scrollHeight - el.scrollTop - el.clientHeight < props.rowHeight * 2
})

let ticking = false
function onScroll(): void {
  if (ticking) return
  ticking = true
  // 合并到一帧，滚动时最多算一次可见区间
  requestAnimationFrame(() => {
    scrollTop.value = viewport.value?.scrollTop ?? 0
    ticking = false
  })
}

function scrollToBottom(): void {
  const el = viewport.value
  if (!el) return
  el.scrollTop = el.scrollHeight
  scrollTop.value = el.scrollTop
}

function scrollToTop(): void {
  viewport.value?.scrollTo({ top: 0 })
  scrollTop.value = 0
}

defineExpose({ scrollToBottom, scrollToTop, atBottom })

// ============ 尺寸观察 ============

let viewportObserver: ResizeObserver | null = null
let rowObserver: ResizeObserver | null = null

/** 收集当前渲染出来的行，交给 ResizeObserver 实测高度 */
function observeRow(el: unknown): void {
  if (props.dynamicHeight && el instanceof HTMLElement) rowObserver?.observe(el)
}

onMounted(() => {
  const el = viewport.value
  if (!el) return
  viewportObserver = new ResizeObserver(() => {
    viewportHeight.value = el.clientHeight
  })
  viewportObserver.observe(el)
  viewportHeight.value = el.clientHeight

  if (!props.dynamicHeight) return
  rowObserver = new ResizeObserver((entries) => {
    let changed = false
    for (const entry of entries) {
      const key = (entry.target as HTMLElement).dataset.vlKey
      if (!key) continue
      const height = Math.ceil(entry.contentRect.height)
      if (height > 0 && Math.abs((measured.get(key) ?? -1) - height) > 0.5) {
        measured.set(key, height)
        changed = true
      }
    }
    if (changed) version.value++
  })
})

// 视口宽度变化会改变换行结果，之前测的高度全部作废
watch(
  () => (props.dynamicHeight ? viewport.value?.clientWidth : 0),
  (width, previous) => {
    if (!props.dynamicHeight || !width || width === previous) return
    measured.clear()
    version.value++
  }
)

onBeforeUnmount(() => {
  viewportObserver?.disconnect()
  rowObserver?.disconnect()
})
</script>

<template>
  <div ref="viewport" class="vl-viewport" :class="{ 'vl-wrap': dynamicHeight }" @scroll.passive="onScroll">
    <div class="vl-canvas" :style="{ height: `${totalHeight}px` }">
      <div class="vl-window" :style="offsetStyle">
        <div
          v-for="(item, i) in visibleItems"
          :key="keyOf(item, startIndex + i)"
          :ref="observeRow"
          :data-vl-key="keyOf(item, startIndex + i)"
          class="vl-row"
          :style="dynamicHeight ? undefined : { height: `${rowHeight}px` }"
        >
          <slot :item="item" :index="startIndex + i" />
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.vl-viewport {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  overflow-x: auto;
}

/* 动态行高即内容换行，不需要横向滚动 */
.vl-viewport.vl-wrap {
  overflow-x: hidden;
}

.vl-canvas {
  position: relative;
  width: 100%;
}

.vl-window {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  will-change: transform;
}

.vl-row {
  display: flex;
  align-items: center;
  white-space: nowrap;
}

/* 换行模式：顶部对齐，行高交给内容决定 */
.vl-wrap .vl-row {
  align-items: flex-start;
  white-space: normal;
}
</style>
