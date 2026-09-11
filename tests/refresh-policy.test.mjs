import test from 'node:test'
import assert from 'node:assert/strict'
import {
  shouldSkipAccountUsageRefresh,
  shouldSkipAccountUsageByPercent
} from '../src/shared/refreshPolicy.ts'

test('shouldSkipAccountUsageRefresh 正常与异常状态判定', () => {
  assert.equal(shouldSkipAccountUsageRefresh({ status: 'banned', lastError: '' }), true)
  assert.equal(shouldSkipAccountUsageRefresh({ status: 'expired', lastError: '' }), true)
  assert.equal(shouldSkipAccountUsageRefresh({ status: 'active', lastError: '' }), false)
  // 临时网络错误不跳过
  assert.equal(shouldSkipAccountUsageRefresh({ status: 'error', lastError: 'ETIMEDOUT' }), false)
  assert.equal(shouldSkipAccountUsageRefresh({ status: 'error', lastError: 'Too Many Requests' }), false)
})

test('shouldSkipAccountUsageByPercent 根据用量百分比跳过刷新', () => {
  // 未启用时永不跳过
  assert.equal(
    shouldSkipAccountUsageByPercent(
      { usage: { limit: 1000, percentUsed: 1.0 } },
      false,
      100
    ),
    false
  )

  // 无用量或 limit <= 0 不跳过
  assert.equal(
    shouldSkipAccountUsageByPercent({ usage: null }, true, 100),
    false
  )
  assert.equal(
    shouldSkipAccountUsageByPercent(
      { usage: { limit: 0, percentUsed: 0 } },
      true,
      100
    ),
    false
  )

  // 达到阈值跳过
  assert.equal(
    shouldSkipAccountUsageByPercent(
      { usage: { limit: 1000, percentUsed: 1.0 } },
      true,
      100
    ),
    true
  )
  assert.equal(
    shouldSkipAccountUsageByPercent(
      { usage: { limit: 1000, percentUsed: 0.85 } },
      true,
      80
    ),
    true
  )

  // 未达到阈值不跳过
  assert.equal(
    shouldSkipAccountUsageByPercent(
      { usage: { limit: 1000, percentUsed: 0.99 } },
      true,
      100
    ),
    false
  )
  assert.equal(
    shouldSkipAccountUsageByPercent(
      { usage: { limit: 1000, percentUsed: 0.79 } },
      true,
      80
    ),
    false
  )
})
