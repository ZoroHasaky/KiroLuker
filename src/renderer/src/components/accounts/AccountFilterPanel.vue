<script setup lang="ts">
import { computed } from 'vue'
import dayjs, { type Dayjs } from 'dayjs'
import { useAccountsStore } from '@/stores/accounts'
import { IDP_META, STATUS_META, SUBSCRIPTION_META } from '@/utils/format'
import type { AccountStatus, AccountTag, IdpType, SubscriptionType } from '@shared/types'

const accountsStore = useAccountsStore()

const filter = computed(() => accountsStore.filter)

/**
 * chip 列表：选项来自元数据表，数量直接复用 store 里已经算好的 stats，
 * 不再为筛选面板单独遍历一遍账号。
 */
function buildChips<K extends string>(
  meta: Record<K, { text: string }>,
  counts: Record<K, number>
): { key: K; label: string; count: number }[] {
  return (Object.keys(meta) as K[]).map((key) => ({
    key,
    label: meta[key].text,
    count: counts[key] || 0
  }))
}

const subscriptionChips = computed(() =>
  buildChips<SubscriptionType>(SUBSCRIPTION_META, accountsStore.stats.bySubscription)
)
const statusChips = computed(() =>
  buildChips<AccountStatus>(STATUS_META, accountsStore.stats.byStatus)
)
const idpChips = computed(() => buildChips<IdpType>(IDP_META, accountsStore.stats.byIdp))
const tagChips = computed(() => {
  const counts = new Map<string, number>()
  for (const account of accountsStore.accounts) {
    for (const tagId of account.tagIds ?? []) counts.set(tagId, (counts.get(tagId) ?? 0) + 1)
  }
  return accountsStore.tags.map((tag: AccountTag) => ({
    ...tag,
    count: counts.get(tag.id) ?? 0
  }))
})

/**
 * 数字输入框都要经过中转再写进筛选条件。
 *
 * a-input-number 在内容被删空时给过来的是 null，直接写进 filter 会让「是否已设置」
 * 判断为真（null !== undefined），比较时 null 又被转成 0，列表就被筛成空了。
 * 这里统一收敛成 undefined，界面侧用 null 表示空值。
 */

/** 百分比在界面上按 0-100 展示，存储里是 0-1 */
const usageMinPercent = computed<number | null>({
  get: () => (filter.value.usageMin == null ? null : Math.round(filter.value.usageMin * 100)),
  set: (v) => {
    filter.value.usageMin = v == null ? undefined : Math.max(0, Math.min(100, v)) / 100
  }
})
const usageMaxPercent = computed<number | null>({
  get: () => (filter.value.usageMax == null ? null : Math.round(filter.value.usageMax * 100)),
  set: (v) => {
    filter.value.usageMax = v == null ? undefined : Math.max(0, Math.min(100, v)) / 100
  }
})
const daysRemainingMin = computed<number | null>({
  get: () => filter.value.daysRemainingMin ?? null,
  set: (v) => {
    filter.value.daysRemainingMin = v == null ? undefined : Math.max(0, v)
  }
})
const daysRemainingMax = computed<number | null>({
  get: () => filter.value.daysRemainingMax ?? null,
  set: (v) => {
    filter.value.daysRemainingMax = v == null ? undefined : Math.max(0, v)
  }
})

/**
 * Store 使用时间戳和右开区间，日期控件展示的是包含首尾的自然日。
 * 结束日统一换算成次日 00:00，避免 23:59:59.999 的精度与夏令时问题。
 */
const createdAtRange = computed<[Dayjs, Dayjs] | null>({
  get: () => {
    if (filter.value.createdAtFrom == null || filter.value.createdAtToExclusive == null) return null
    return [
      dayjs(filter.value.createdAtFrom),
      dayjs(filter.value.createdAtToExclusive).subtract(1, 'millisecond')
    ] as [Dayjs, Dayjs]
  },
  set: (range: [Dayjs, Dayjs] | null) => {
    if (!range?.[0] || !range?.[1]) {
      filter.value.createdAtFrom = undefined
      filter.value.createdAtToExclusive = undefined
      return
    }
    filter.value.createdAtFrom = range[0].startOf('day').valueOf()
    filter.value.createdAtToExclusive = range[1].startOf('day').add(1, 'day').valueOf()
  }
})

function toggle<T extends string>(list: T[], value: T): T[] {
  return list.includes(value) ? list.filter((v) => v !== value) : [...list, value]
}

function toggleSubscription(value: SubscriptionType): void {
  filter.value.subscriptions = toggle(filter.value.subscriptions, value)
}
function toggleStatus(value: AccountStatus): void {
  filter.value.statuses = toggle(filter.value.statuses, value)
}
function toggleIdp(value: IdpType): void {
  filter.value.idps = toggle(filter.value.idps, value)
}
function toggleTag(value: string): void {
  filter.value.tagIds = toggle(filter.value.tagIds, value)
}

function reset(): void {
  accountsStore.applyFilter({ search: filter.value.search })
}
</script>

<template>
  <div class="filter-panel">
    <div class="filter-row">
      <span class="filter-label">订阅</span>
      <div class="chips">
        <button
          v-for="item in subscriptionChips"
          :key="item.key"
          class="chip"
          :class="{ on: filter.subscriptions.includes(item.key), empty: !item.count }"
          @click="toggleSubscription(item.key)"
        >
          {{ item.label }}<span class="chip-count">({{ item.count }})</span>
        </button>
      </div>
    </div>

    <div class="filter-row">
      <span class="filter-label">状态</span>
      <div class="chips">
        <button
          v-for="item in statusChips"
          :key="item.key"
          class="chip"
          :class="{ on: filter.statuses.includes(item.key), empty: !item.count }"
          @click="toggleStatus(item.key)"
        >
          {{ item.label }}<span class="chip-count">({{ item.count }})</span>
        </button>
      </div>
    </div>

    <div class="filter-row">
      <span class="filter-label">登录方式</span>
      <div class="chips">
        <button
          v-for="item in idpChips"
          :key="item.key"
          class="chip"
          :class="{ on: filter.idps.includes(item.key), empty: !item.count }"
          @click="toggleIdp(item.key)"
        >
          {{ item.label }}<span class="chip-count">({{ item.count }})</span>
        </button>
      </div>
    </div>

    <div class="filter-row">
      <span class="filter-label">标签</span>
      <div v-if="tagChips.length" class="chips">
        <button
          v-for="item in tagChips"
          :key="item.id"
          class="chip"
          :class="{ on: filter.tagIds.includes(item.id), empty: !item.count }"
          @click="toggleTag(item.id)"
        >
          <span class="tag-color" :style="{ backgroundColor: item.color }" />
          {{ item.name }}<span class="chip-count">({{ item.count }})</span>
        </button>
      </div>
      <span v-else class="muted">暂无可用标签</span>
    </div>

    <div class="filter-row">
      <span class="filter-label">添加日期</span>
      <a-range-picker
        v-model:value="createdAtRange"
        size="small"
        format="YYYY-MM-DD"
        :placeholder="['开始日期', '结束日期']"
      />
    </div>

    <div class="filter-row">
      <span class="filter-label">使用量</span>
      <div class="range">
        <a-input-number
          v-model:value="usageMinPercent"
          :min="0"
          :max="100"
          placeholder="min"
          size="small"
          style="width: 88px"
        />
        <span class="muted">-</span>
        <a-input-number
          v-model:value="usageMaxPercent"
          :min="0"
          :max="100"
          placeholder="max"
          size="small"
          style="width: 88px"
        />
        <span class="muted">%</span>
      </div>
    </div>

    <div class="filter-row">
      <span class="filter-label">重置剩余</span>
      <div class="range">
        <a-input-number
          v-model:value="daysRemainingMin"
          :min="0"
          placeholder="min"
          size="small"
          style="width: 88px"
        />
        <span class="muted">-</span>
        <a-input-number
          v-model:value="daysRemainingMax"
          :min="0"
          placeholder="max"
          size="small"
          style="width: 88px"
        />
        <span class="muted">天</span>
      </div>
    </div>

    <div class="filter-footer">
      <span class="muted">命中 {{ accountsStore.filtered.length }} 个账号</span>
      <a-button type="link" size="small" @click="reset">重置筛选</a-button>
    </div>
  </div>
</template>

<!-- 外观样式在 assets/styles.css 的 .filter-panel 段，与 API Key 筛选面板共用 -->
<style scoped>
.tag-color {
  display: inline-block;
  width: 8px;
  height: 8px;
  margin-right: 4px;
  border-radius: 50%;
  vertical-align: 1px;
}
</style>
