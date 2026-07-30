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
 * 凭证失效错误的可读文案：保留状态码便于排查，去掉原始响应体。
 * 非凭证类错误原样返回，避免掩盖真实原因。
 */
export function describeRefreshError(message: string): string {
  const raw = String(message || '')
  if (!isCredentialRejected(raw)) return raw
  const status = raw.match(/HTTP\s+(\d{3})/i)?.[1]
  return `刷新凭证已失效，可能已被 Kiro IDE 或其它设备刷新，请重新登录该账号${status ? `（HTTP ${status}）` : ''}`
}
