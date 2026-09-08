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
  type WebControlPublicConfig,
  type WebControlSettings
} from '../shared/webControl'
import { accountApplicationService } from './accountApplicationSingleton'
import { billingService } from './applicationServices'
import { createPasswordRecord, createWebControlHttpApp } from './webControlHttp'

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
  private webDir = ''
  private lastError = ''

  getConfig(): WebControlPublicConfig {
    const settings = getWebControlSettings()
    const auth = getWebControlAuth()
    const running = this.server !== null
    return {
      ...settings,
      passwordConfigured: Boolean(auth.password),
      running,
      ...(running ? { url: `${settings.publicUrl || `http://${settings.host}:${settings.port}`}/panel/` } : {}),
      ...(this.lastError ? { error: this.lastError } : {})
    }
  }

  async saveSettings(patch: Partial<WebControlSettings>, webDir?: string): Promise<WebControlPublicConfig> {
    const next = validateSettings({ ...getWebControlSettings(), ...patch })
    setWebControlSettings(next)
    if (webDir) this.webDir = webDir
    if (this.server) await this.stop()
    if (next.enabled) await this.start(this.webDir)
    return this.getConfig()
  }

  async setAdminPassword(password: string, webDir?: string): Promise<WebControlPublicConfig> {
    const auth = getWebControlAuth()
    const passwordRecord = await createPasswordRecord(password)
    setWebControlAuth({ ...auth, password: passwordRecord })
    if (webDir) this.webDir = webDir
    // 重启会话内存，旧 cookie 立即失效。
    if (this.server) {
      await this.stop()
      if (getWebControlSettings().enabled) await this.start(this.webDir)
    }
    return this.getConfig()
  }

  async start(webDir?: string): Promise<WebControlPublicConfig> {
    if (webDir) this.webDir = webDir
    if (this.server) return this.getConfig()
    const settings = validateSettings(getWebControlSettings())
    if (!settings.enabled) throw new Error('请先启用 Web 控制面板')
    if (!getWebControlAuth().password) throw new Error('请先设置管理员密码')
    if (!this.webDir) throw new Error('Web 面板资源路径不可用')
    this.lastError = ''
    const server = await createWebControlHttpApp({
      accountService: accountApplicationService,
      billingService,
      authRepository: { load: getWebControlAuth, save: setWebControlAuth },
      getSettings: getWebControlSettings,
      webDir: this.webDir
    })
    try {
      await server.listen({ host: settings.host, port: settings.port })
      this.server = server
    } catch (error) {
      await server.close().catch(() => undefined)
      this.lastError = error instanceof Error ? error.message : '无法启动 Web 服务'
      throw new Error(`Web 服务启动失败：${this.lastError}`)
    }
    return this.getConfig()
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
