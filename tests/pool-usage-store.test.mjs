// 提链出口 IP 计次存储：真 node:sqlite（:memory:）验证建表、窗口计数与清理。
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  _initForTests,
  countRecentUsage,
  pruneOlderThan,
  recordUsage
} from '../src/main/poolUsageStore.ts'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

test('出口 IP 计数随记录增长并按时间窗口计算', async () => {
  _initForTests()
  assert.equal(countRecentUsage('198.51.100.7'), 0)
  recordUsage('198.51.100.7')
  recordUsage('198.51.100.7')
  assert.equal(countRecentUsage('198.51.100.7'), 2)
  // 其它出口互不影响
  assert.equal(countRecentUsage('198.51.100.8'), 0)
  // 窗口外（毫秒级回看）的记录不计
  await sleep(10)
  assert.equal(countRecentUsage('198.51.100.7', 3), 0, '早于回看窗口的记录不应计数')
  assert.equal(countRecentUsage('198.51.100.7'), 2, '默认 24h 窗口仍应计数')
})

test('pruneOlderThan 只清理早于阈值的记录', async () => {
  _initForTests()
  const fresh = '2001:db8::1'
  const stale = '2001:db8::2'
  recordUsage(fresh)
  recordUsage(stale)
  await sleep(10)
  // 阈值 5ms：两条记录都已过期
  pruneOlderThan(5)
  assert.equal(countRecentUsage(fresh, 60_000), 0)
  assert.equal(countRecentUsage(stale, 60_000), 0)
  // 新写入的记录不受大阈值清理影响
  const kept = '2001:db8::3'
  recordUsage(kept)
  pruneOlderThan(60_000)
  assert.equal(countRecentUsage(kept, 60_000), 1)
})
