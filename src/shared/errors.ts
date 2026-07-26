/** 错误信息归一：Error 取 message，其余转字符串，空值用兜底文案 */
export function errorMessage(error: unknown, fallback = ''): string {
  if (error instanceof Error) return error.message || fallback
  if (error === undefined || error === null) return fallback
  return String(error) || fallback
}
