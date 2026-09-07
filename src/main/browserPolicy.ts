import { isIP } from 'node:net'
import type { BrowserProxyCheck } from '../shared/browser'

/** Never hand a privileged/custom scheme or embedded credentials to an external page. */
export function browserNavigationUrl(input: unknown, fromAddressBar = false): string {
  if (typeof input !== 'string' || input.length > 16384 || /[\u0000-\u001f\u007f]/.test(input)) {
    throw new Error('请输入有效的 HTTP 或 HTTPS 地址')
  }
  let value = input.trim()
  if (value === 'about:blank' || (fromAddressBar && !value)) return 'about:blank'
  if (fromAddressBar && !/^https?:\/\//i.test(value)) {
    if (/^[a-z][a-z\d+.-]*:/i.test(value) && !/^[^/:\s]+:\d+(?:\/|$)/.test(value)) {
      throw new Error('仅支持 HTTP、HTTPS 和空白页')
    }
    value = `https://${value}`
  }
  let url: URL
  try { url = new URL(value) } catch { throw new Error('请输入有效的网页地址') }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password) {
    throw new Error('仅支持不含用户名或密码的 HTTP / HTTPS 地址')
  }
  return url.href
}

export function isBrowserNavigationAllowed(url: string): boolean {
  try { browserNavigationUrl(url); return true } catch { return false }
}

export function browserOrigin(url: string): string {
  try { return url === 'about:blank' ? '空白页' : new URL(browserNavigationUrl(url)).origin } catch { return '' }
}

/** Cloudflare trace is deliberately parsed narrowly; never display the full response. */
export function parseBrowserProxyTrace(body: string, latencyMs: number): BrowserProxyCheck {
  if (body.length > 16384) throw new Error('出口检测响应异常')
  const ip = /^ip=([^\r\n]+)$/m.exec(body)?.[1].trim() || ''
  const country = /^loc=([A-Z]{2})\r?$/m.exec(body)?.[1] || ''
  if (!isIP(ip)) throw new Error('出口检测未返回有效 IP')
  return { ip, country, checkedAt: Date.now(), latencyMs }
}
