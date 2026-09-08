import assert from 'node:assert/strict'
import test from 'node:test'
import { createPinia } from 'pinia'
import { useBillingStore } from '../src/renderer/src/stores/billing.ts'

test('账单结果在路由页面重新进入后仍保留，只有显式丢弃才清空', () => {
  const pinia = createPinia()
  const billingStore = useBillingStore(pinia)
  const result = {
    chineseName: '张三',
    pinyinName: 'ZHANG SAN',
    address: '测试地址 1 号',
    postalCode: '100000',
    mapSource: '测试地图',
    generatedAt: 1_800_000_000_000
  }

  billingStore.setResult(result)

  // BillingView 卸载、再进入时会重新调用同一 Pinia store。
  const reenteredStore = useBillingStore(pinia)
  assert.deepEqual(reenteredStore.result, result)

  reenteredStore.discardResult()
  assert.equal(billingStore.result, null)
})
