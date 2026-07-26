<script setup lang="ts">
import { computed } from 'vue'
import { useAccountsStore } from '@/stores/accounts'
import { IDP_META, STATUS_META, SUBSCRIPTION_META } from '@/utils/format'
import type { AccountStatus, IdpType, SubscriptionType } from '@shared/types'

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

/** 百分比在界面上按 0-100 展示，存储里是 0-1 */
const usageMinPercent = computed({
  get: () => (filter.value.usageMin === undefined ? null : Math.round(filter.value.usageMin * 100)),
  set: (v: number | null) => {
    filter.value.usageMin = v === null ? undefined : Math.max(0, Math.min(100, v)) / 100
  }
})
const usageMaxPercent = computed({
  get: () => (filter.value.usageMax === undefined ? null : Math.round(filter.value.usageMax * 100)),
  set: (v: number | null) => {
    filter.value.usageMax = v === null ? undefined : Math.max(0, Math.min(100, v)) / 100
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
          v-model:value="filter.daysRemainingMin"
          :min="0"
          placeholder="min"
          size="small"
          style="width: 88px"
        />
        <span class="muted">-</span>
        <a-input-number
          v-model:value="filter.daysRemainingMax"
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

<style scoped>
.filter-panel {
  width: 460px;
  max-width: 70vw;
}

.filter-row {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 7px 0;
}

.filter-label {
  flex: 0 0 62px;
  padding-top: 3px;
  font-size: 13px;
  color: var(--kal-muted);
}

.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  min-width: 0;
}

.chip {
  padding: 2px 9px;
  font-size: 12px;
  line-height: 20px;
  border-radius: 999px;
  border: 1px solid var(--kal-border);
  background: transparent;
  color: inherit;
  cursor: pointer;
  transition: all 0.15s ease;
}

.chip:hover {
  border-color: var(--kal-primary);
}

.chip.on {
  border-color: var(--kal-primary);
  background: var(--kal-primary);
  color: #fff;
}

/* 没有账号命中的选项弱化显示，但仍可点 */
.chip.empty:not(.on) {
  color: var(--kal-muted);
}

.chip-count {
  margin-left: 3px;
  opacity: 0.7;
}

.range {
  display: flex;
  align-items: center;
  gap: 6px;
}

.filter-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-top: 6px;
  padding-top: 8px;
  border-top: 1px solid var(--kal-border);
  font-size: 12px;
}
</style>
