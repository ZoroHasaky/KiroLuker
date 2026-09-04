export const KIRO_AUTH_TOKEN_FILE = 'kiro-auth-token.json'

/** 退出 Kiro 时只删除它自己的 token，不能波及同目录中的 AWS CLI SSO 缓存。 */
export function isKiroLogoutCacheFile(fileName: string): boolean {
  return fileName === KIRO_AUTH_TOKEN_FILE
}
