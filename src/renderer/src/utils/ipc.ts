// 与主进程通信时的数据处理

/**
 * 转成可结构化克隆的普通对象。
 *
 * store 里的账号是 Vue 响应式代理，直接经 IPC 发送会触发
 * "An object could not be cloned"，所以传参前先剥掉代理。
 */
export function toPlain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value))
}
