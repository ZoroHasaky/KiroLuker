import test from 'node:test'
import assert from 'node:assert/strict'
import { shouldSkipAccountUsageRefresh } from '../src/shared/refreshPolicy.ts'

test('shouldSkipAccountUsageRefresh 正常与异常状态判定', () => {
  assert.equal(shouldSkipAccountUsageRefresh({ status: 'banned', lastError: '' }), true)
  assert.equal(shouldSkipAccountUsageRefresh({ status: 'expired', lastError: '' }), true)
  assert.equal(shouldSkipAccountUsageRefresh({ status: 'active', lastError: '' }), false)
  // 临时网络错误不跳过
  assert.equal(shouldSkipAccountUsageRefresh({ status: 'error', lastError: 'ETIMEDOUT' }), false)
  assert.equal(shouldSkipAccountUsageRefresh({ status: 'error', lastError: 'Too Many Requests' }), false)
})
