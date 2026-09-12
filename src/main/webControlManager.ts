import { safeStorage } from 'electron'
import { isIP } from 'node:net'
import type { FastifyInstance } from 'fastify'
import {
  getWebControlAuth,
  getWebControlSettings,
  setWebControlAuth,
  setWebControlSettings
} from './store'
import {
  DEFAULT_WEB_CONTROL_SETTINGS,
  type WebControlApiKeyPublic,
  type WebControlPublicConfig,
  type WebControlSettings
} from '../shared/webControl'
import { accountApplicationService } from './accountApplicationSingleton'
import { billingService } from './applicationServices'
import { createWebControlHttpApp } from './webControlHttp'
import { ensureDefaultMobileApiKey, publicApiKey, readMobileApiKey, regenerateMobileApiKey } from './webControlApiKey'

function apiKeyProtector() {
  try {
    if (!safeStorage.isEncryptionAvailable()) throw new Error()
    if (process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text') throw new Error()
  } catch {
    throw new Error('系统安全存储不可用，无法安全保存可复制的移动 App API Key')
  }
  return {
    encrypt: (value: string) => safeStorage.encryptString(value).toString('base64'),
    decrypt: (value: string) => safeStorage.decryptString(Buffer.from(value, 'base64'))
  }
}
function validateSettings(input: WebControlSettings): WebControlSettings {
  const host = input.host.trim()
  if (!(host === 'localhost' || isIP(host) !== 0)) throw new Error('监听地址必须是 localhost、IPv4 或 IPv6 地址')
  const port = Number(input.port)
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('端口必须在 1024 到 65535 之间')
  const publicUrl = input.publicUrl.trim().replace(/\/$/, '')
  if (publicUrl) {
    let url: URL
    try { url = new URL(publicUrl) } catch { throw new Error('公网访问地址不是有效 URL') }
    if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '' || url.search || url.hash) {
      throw new Error('公网访问地址必须是无路径、无凭证的 HTTPS 根地址')
    }
  }
  const trustedProxies = input.trustedProxies.split(',').map((item) => item.trim()).filter(Boolean)
  if (trustedProxies.some((item) => !(isIP(item) !== 0 || item.includes('/')))) throw new Error('可信代理必须是 IP 或 CIDR，多个值用逗号分隔')
  return { ...input, host, port, publicUrl, trustedProxies: trustedProxies.join(',') }
}

/** Electron 生命周期层：负责端口监听、关闭与设置变更，HTTP 路由本身保持可注入测试。 */
export class WebControlManager {
  private server: FastifyInstance | null = null
  private lastError = ''

  getConfig(): WebControlPublicConfig {
    const settings = getWebControlSettings()
    const running = this.server !== null
    return {
      ...settings,
      running,
      ...(running ? { url: settings.publicUrl || `http://${settings.host}:${settings.port}` } : {}),
      ...(this.lastError ? { error: this.lastError } : {})
    }
  }

  async saveSettings(patch: Partial<WebControlSettings>): Promise<WebControlPublicConfig> {
    const next = validateSettings({ ...getWebControlSettings(), ...patch })
    setWebControlSettings(next)
    if (this.server) await this.stop()
    if (next.enabled) await this.start()
    return this.getConfig()
  }

  async start(): Promise<WebControlPublicConfig> {
    if (this.server) return this.getConfig()
    const settings = validateSettings(getWebControlSettings())
    if (!settings.enabled) throw new Error('请先启用 API 服务')
    this.lastError = ''
    this.ensureDefaultMobileApiKey()
    const server = await createWebControlHttpApp({
      accountService: accountApplicationService,
      billingService,
      authRepository: { load: getWebControlAuth, save: setWebControlAuth },
      getSettings: getWebControlSettings,
    })
    try {
      await server.listen({ host: settings.host, port: settings.port })
      this.server = server
    } catch (error) {
      await server.close().catch(() => undefined)
      this.lastError = error instanceof Error ? error.message : '无法启动 API 服务'
      throw new Error(`API 服务启动失败：${this.lastError}`)
    }
    return this.getConfig()
  }

  private ensureDefaultMobileApiKey(): WebControlApiKeyPublic {
    const next = ensureDefaultMobileApiKey(getWebControlAuth(), apiKeyProtector())
    if (next.changed) setWebControlAuth(next.auth)
    return publicApiKey(next.item)
  }

  getMobileApiKey(): WebControlApiKeyPublic | null {
    // 打开设置页即可保证存在一把默认 Key，不必等 API 服务先启动。
    return this.ensureDefaultMobileApiKey()
  }

  regenerateMobileApiKey(): WebControlApiKeyPublic {
    const next = regenerateMobileApiKey(getWebControlAuth(), apiKeyProtector())
    setWebControlAuth(next.auth)
    return publicApiKey(next.item)
  }

  copyMobileApiKey(): string {
    this.ensureDefaultMobileApiKey()
    return readMobileApiKey(getWebControlAuth(), apiKeyProtector())
  }
  async stop(): Promise<void> {
    const server = this.server
    this.server = null
    if (server) await server.close()
  }

  async stopForShutdown(): Promise<void> {
    await this.stop().catch(() => undefined)
  }
}

export const webControlManager = new WebControlManager()
export { DEFAULT_WEB_CONTROL_SETTINGS }
