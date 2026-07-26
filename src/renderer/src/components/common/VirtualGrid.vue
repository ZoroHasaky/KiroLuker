<script setup lang="ts" generic="T">
/**
 * 定高网格虚拟滚动。
 *
 * 只渲染视口内（外加若干缓冲行）的单元格，DOM 数量与数据量无关，
 * 十万条也只维持几十个节点，滚动开销恒定。
 *
 * 关键点：
 *  - 列数由容器宽度算出，行高统一，于是任意 scrollTop 都能 O(1) 反推首行
 *  - 用 transform 平移可见区域，避免逐格 top 触发大量重排
 *  - 单元格高度先用预估值，挂载后按真实内容校正一次，不需要调用方写死
 *  - scroll 回调走 rAF 合并，一帧最多计算一次
 */
import { computed, onBeforeUnmount, onMounted, ref, watch, nextTick } from 'vue'

const props = withDefaults(
  defineProps<{
    items: T[]
    /** 单元格预估高度，挂载后会用真实高度校正 */
    estimatedHeight?: number
    /** 单列最小宽度，决定列数 */
    minColumnWidth?: number
    gap?: number
    /** 视口上下各额外渲染的行数，越大滚动越不易见白但 DOM 越多 */
    bufferRows?: number
    /** 单元格 key，缺省用索引（列表会变动时务必传） */
    itemKey?: (item: T, index: number) => string | number
  }>(),
  { estimatedHeight: 320, minColumnWidth: 320, gap: 14, bufferRows: 2, itemKey: undefined }
)

const viewport = ref<HTMLElement | null>(null)
const grid = ref<HTMLElement | null>(null)

const viewportWidth = ref(0)
const viewportHeight = ref(0)
const scrollTop = ref(0)
const itemHeight = ref(props.estimatedHeight)
/** 首帧还没量到真实高度时不锁定单元格高度，量完再锁 */
const measured = ref(false)

const columns = computed(() => {
  const w = viewportWidth.value
  if (!w) return 1
  return Math.max(1, Math.floor((w + props.gap) / (props.minColumnWidth + props.gap)))
})

const rowHeight = computed(() => itemHeight.value + props.gap)
const totalRows = computed(() => Math.ceil(props.items.length / columns.value))
/** 画布高度：最后一行不带 gap */
const totalHeight = computed(() => Math.max(0, totalRows.value * rowHeight.value - props.gap))

const startRow = computed(() =>
  Math.max(0, Math.floor(scrollTop.value / rowHeight.value) - props.bufferRows)
)
const rowsInView = computed(
  () => Math.ceil(viewportHeight.value / rowHeight.value) + props.bufferRows * 2 + 1
)
const endRow = computed(() => Math.min(totalRows.value, startRow.value + rowsInView.value))

const startIndex = computed(() => startRow.value * columns.value)
const endIndex = computed(() => Math.min(props.items.length, endRow.value * columns.value))
const visibleItems = computed(() => props.items.slice(startIndex.value, endIndex.value))

const gridStyle = computed(() => ({
  transform: `translateY(${startRow.value * rowHeight.value}px)`,
  gridTemplateColumns: `repeat(${columns.value}, minmax(0, 1fr))`,
  gap: `${props.gap}px`
}))

function keyOf(item: T, offset: number): string | number {
  const index = startIndex.value + offset
  return props.itemKey ? props.itemKey(item, index) : index
}

// ============ 滚动 ============

let ticking = false
function onScroll(): void {
  if (ticking) return
  ticking = true
  requestAnimationFrame(() => {
    scrollTop.value = viewport.value?.scrollTop ?? 0
    ticking = false
  })
}

function scrollToTop(): void {
  viewport.value?.scrollTo({ top: 0 })
  scrollTop.value = 0
}

defineExpose({ scrollToTop })

// ============ 尺寸测量 ============

/**
 * 校正行高。
 *
 * 取可见单元格里内容最高的那个：卡片内容行数可能不同（多一条额度明细就高一截），
 * 只看第一个会让更高的行重叠到下一行。首帧不给单元格 min-height，
 * 这样量到的是内容自然高度；之后只允许变高，避免来回抖动导致滚动位置跳。
 */
function measure(): void {
  const el = grid.value
  if (!el || el.children.length === 0) return

  let max = 0
  for (const child of Array.from(el.children) as HTMLElement[]) {
    max = Math.max(max, child.scrollHeight)
  }
  if (max <= 0) return

  if (!measured.value) {
    itemHeight.value = max
    measured.value = true
  } else if (max > itemHeight.value + 1) {
    itemHeight.value = max
  }
}

let viewportObserver: ResizeObserver | null = null
let gridObserver: ResizeObserver | null = null

onMounted(() => {
  const el = viewport.value
  if (!el) return

  viewportObserver = new ResizeObserver(() => {
    viewportWidth.value = el.clientWidth
    viewportHeight.value = el.clientHeight
  })
  viewportObserver.observe(el)
  viewportWidth.value = el.clientWidth
  viewportHeight.value = el.clientHeight

  // 内容变高会带动 grid 尺寸变化，借此触发一次校正
  if (grid.value) {
    gridObserver = new ResizeObserver(() => measure())
    gridObserver.observe(grid.value)
  }
  void nextTick(measure)
})

onBeforeUnmount(() => {
  viewportObserver?.disconnect()
  gridObserver?.disconnect()
})

// 列数变化时卡片宽度变了，内容换行情况可能不同，重新量一次
watch(columns, () => void nextTick(measure))
</script>

<template>
  <div ref="viewport" class="vg-viewport" @scroll.passive="onScroll">
    <div class="vg-canvas" :style="{ height: `${totalHeight}px` }">
      <div ref="grid" class="vg-grid" :style="gridStyle">
        <div
          v-for="(item, i) in visibleItems"
          :key="keyOf(item, i)"
          class="vg-cell"
          :style="measured ? { minHeight: `${itemHeight}px` } : undefined"
        >
          <slot :item="item" :index="startIndex + i" />
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.vg-viewport {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  overflow-x: hidden;
  /* hover 时卡片会上移并带投影，留点内边距免得被裁掉 */
  padding: 3px 3px 8px;
}

.vg-canvas {
  position: relative;
  width: 100%;
}

.vg-grid {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  display: grid;
  /* 平移整块可见区域，比逐格定位省一大截重排 */
  will-change: transform;
}

.vg-cell {
  display: flex;
  min-width: 0;
}

/* 让插槽内容撑满单元格，同排卡片高度一致 */
.vg-cell > :deep(*) {
  flex: 1 1 auto;
  min-width: 0;
}
</style>
