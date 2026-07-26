// 共享的「当前时间」时钟
//
// 相对时间要随时间推移自动刷新。列表里可能同时有上千张卡片，
// 各自开一个定时器成本太高，这里用单个模块级定时器驱动所有组件。
import { ref } from 'vue'

/** 更新步长：相对时间最小粒度是秒，5 秒足够平滑又不至于频繁重渲染 */
const TICK_MS = 5_000

export const now = ref(Date.now())

setInterval(() => {
  now.value = Date.now()
}, TICK_MS)
