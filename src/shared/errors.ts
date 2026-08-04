/** 错误信息归一：Error 取 message，其余转字符串，空值用兜底文案 */
export function errorMessage(error: unknown, fallback = ''): string {
  if (error instanceof Error) return error.message || fallback
  if (error === undefined || error === null) return fallback
  return String(error) || fallback
}

/**
 * 判断错误是否为「刷新凭证被服务端拒绝」。
 *
 * refreshToken 是轮换式的，任何一次刷新都会让旧值立即作废。拿作废的值再刷，
 * AWS OIDC 回 `invalid_grant`，Kiro auth service 回 401 `Bad credentials`。
 * 这类错误重试没有意义，只能换用最新凭证或重新登录。
 */
export function isCredentialRejected(message: string): boolean {
  const m = String(message || '').toLowerCase()
  if (m.includes('invalid_grant') || m.includes('bad credentials')) return true
  // 其余 4xx 需要同时带上凭证语义，避免把用量接口的普通 400 也算进来
  if (!m.includes('401') && !m.includes('400')) return false
  return m.includes('credential') || m.includes('unauthorized') || m.includes('token')
}

/**
 * 判断错误是否为「重试也不会变好」的确定性失败，用于批量刷新时跳过。
 *
 * 只认凭证被拒、权限被拒和账号被封这三类：它们要靠重新登录或换账号才能解决，
 * 反复请求纯属浪费额度和时间。
 *
 * 反过来，429（限流）、5xx、超时、fetch failed 这些一律不算：
 * 它们是临时故障，跳过会让账号或 Key 因为一次网络抖动就再也不被刷新，
 * 永远停在异常状态出不来。
 */
export function isPermanentFailure(message: string): boolean {
  const m = String(message || '').toLowerCase()
  if (!m) return false
  // 限流与服务端故障优先判定为临时，避免被下面的关键词误伤
  if (m.includes('429') || m.includes('too many requests')) return false
  if (/\b5\d\d\b/.test(m) || m.includes('timeout') || m.includes('fetch failed')) return false
  if (isCredentialRejected(m)) return true
  if (m.includes('accountsuspended') || m.includes('suspended') || m.includes('banned')) return true
  // 403 一律视为权限被拒（bearer token invalid / forbidden），重试无意义
  return m.includes('403') || m.includes('forbidden')
}
