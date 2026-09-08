import { acceptHMRUpdate, defineStore } from 'pinia'
import { ref } from 'vue'
import type { BillingResult } from '@shared/billing'

/**
 * 账单结果仅在当前应用进程内保留。
 * 路由切换会卸载 BillingView，因此由 Store 承担页面间的临时状态；
 * 不写入本地存储，也不形成生成历史。
 */
export const useBillingStore = defineStore('billing', () => {
  const result = ref<BillingResult | null>(null)

  function setResult(nextResult: BillingResult): void {
    result.value = nextResult
  }

  function discardResult(): void {
    result.value = null
  }

  return { result, setResult, discardResult }
})

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useBillingStore, import.meta.hot))
}
