import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { app, BrowserWindow, WebContentsView, screen, type WebContents, type WebPreferences, type IpcMainInvokeEvent } from 'electron'
import type { Account } from '../shared/types'
import { BROWSER_CHROME_HEIGHT, type BrowserChromeCommand, type BrowserChromeState, type BrowserFingerprint,
  type BrowserOpenRequest, type BrowserProxyCheck, type BrowserResolvedConfig, type BrowserWindowSummary } from '../shared/browser'
import { acceptLanguageFor } from '../shared/portalLocale'
import { CHROME_UA, initializePortalSession, KIRO_PORTAL_ORIGIN } from './kiroPortalSession'
import { createBrowserSession, type BrowserSessionResource } from './browserSession'
import { browserNavigationUrl, browserOrigin, isBrowserNavigationAllowed } from './browserPolicy'
import { getResolvedBrowserConfig } from './browserConfig'
import { getAccountData, getSettings } from './store'

interface Tab {
  id: string
  view: WebContentsView
  ready: Promise<void>
  error?: string
}
interface WindowRecord {
  id: string
  window: BrowserWindow
  resource: BrowserSessionResource
  fingerprint: BrowserFingerprint
  accountId?: string
  label: string
  createdAt: number
  proxyEnabled: boolean
  activeTabId: string
  tabs: Map<string, Tab>
  closing: boolean
  cleanup?: Promise<void>
}

export interface BrowserManagerOptions {
  config?: () => BrowserResolvedConfig
  account?: (id: string) => Account | undefined
  initializeAccount?: typeof initializePortalSession
  probeUrl?: string
  /** Local test harness can hide the real Electron windows; production never sets this. */
  hidden?: boolean
}

function browserSetupTimeout<T>(operation: Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('浏览器参数初始化超时')), 15000)
    operation.then((value) => { clearTimeout(timer); resolve(value) }, (error) => { clearTimeout(timer); reject(error) })
  })
}
export class BrowserManager {
  private windows = new Map<string, WindowRecord>()
  private queue: Promise<unknown> = Promise.resolve()
  private lastExitIp = ''
  private stopping = false
  private listeners = new Set<(windows: BrowserWindowSummary[]) => void>()
  private cleanups = new Set<Promise<void>>()
  private startupControllers = new Set<AbortController>()
  private checks = new Set<Promise<BrowserProxyCheck>>()

  constructor(private options: BrowserManagerOptions = {}) {}

  onChanged(listener: (windows: BrowserWindowSummary[]) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  list(): BrowserWindowSummary[] {
    return [...this.windows.values()].filter((r) => !r.closing).map((r) => this.summary(r))
  }

  private summary(record: WindowRecord): BrowserWindowSummary {
    const contents = record.tabs.get(record.activeTabId)?.view.webContents
    return {
      id: record.id, accountId: record.accountId, label: record.label,
      createdAt: record.createdAt, tabCount: record.tabs.size,
      activeOrigin: contents && !contents.isDestroyed() ? browserOrigin(contents.getURL()) : '',
      proxyEnabled: record.proxyEnabled, exitIp: record.resource.check?.ip, country: record.resource.check?.country
    }
  }

  private publish(record?: WindowRecord): void {
    if (record && !record.closing && !record.window.isDestroyed()) {
      record.window.webContents.send('browser-chrome:changed', this.state(record.id))
    }
    const snapshot = this.list()
    for (const listener of this.listeners) listener(snapshot)
  }

  private requireWindow(id: string): WindowRecord {
    const record = this.windows.get(id)
    if (!record || record.closing || record.window.isDestroyed()) throw new Error('浏览器窗口已关闭')
    return record
  }

  /** IPC is bound to the owning local toolbar's main frame, never a remote tab/subframe. */
  chromeOwner(event: IpcMainInvokeEvent): string {
    const record = [...this.windows.values()].find((r) => !r.closing && r.window.webContents === event.sender)
    if (!record || event.senderFrame !== record.window.webContents.mainFrame) throw new Error('无权操作浏览器窗口')
    return record.id
  }

  state(id: string): BrowserChromeState {
    const record = this.requireWindow(id)
    return {
      windowId: record.id, label: record.label, proxyEnabled: record.proxyEnabled,
      exitIp: record.resource.check?.ip, country: record.resource.check?.country,
      activeTabId: record.activeTabId,
      tabs: [...record.tabs.values()].filter((t) => !t.view.webContents.isDestroyed()).map((tab) => {
        const contents = tab.view.webContents
        return { id: tab.id, title: contents.getTitle() || '新标签页', url: contents.getURL() || 'about:blank',
          loading: contents.isLoading(), canGoBack: contents.navigationHistory.canGoBack(),
          canGoForward: contents.navigationHistory.canGoForward(), error: tab.error }
      })
    }
  }

  private async createSession(config: BrowserResolvedConfig): Promise<BrowserSessionResource> {
    const controller = new AbortController()
    this.startupControllers.add(controller)
    try {
      return await createBrowserSession(config, { probeUrl: this.options.probeUrl, signal: controller.signal })
    } finally { this.startupControllers.delete(controller) }
  }

  private config(): BrowserResolvedConfig { return (this.options.config || getResolvedBrowserConfig)() }

  open(request: BrowserOpenRequest = {}): Promise<BrowserWindowSummary> {
    // Serialize startup reservations: simultaneous clicks must not accept the same sampled IP.
    const work = this.queue.then(() => this.openNow(request))
    this.queue = work.catch(() => undefined)
    return work
  }

  private async openNow(request: BrowserOpenRequest): Promise<BrowserWindowSummary> {
    if (this.stopping) throw new Error('应用正在退出')
    if (!request || typeof request !== 'object' || (request.accountId !== undefined && typeof request.accountId !== 'string')) {
      throw new Error('无效的浏览器启动请求')
    }
    const account = request.accountId
      ? (this.options.account || ((id) => getAccountData().accounts.find((a) => a.id === id)))(request.accountId)
      : undefined
    if (request.accountId && !account) throw new Error('账号不存在，请刷新账户列表')
    const config = this.config()
    let resource: BrowserSessionResource | undefined
    for (let attempt = 0; attempt < 3; attempt++) {
      resource = await this.createSession(config)
      if (this.stopping) { await resource.close(); throw new Error('应用正在退出') }
      const ip = resource.check?.ip
      const duplicate = ip && (ip === this.lastExitIp || [...this.windows.values()].some((w) => w.resource.check?.ip === ip))
      if (!duplicate) break
      await resource.close()
      resource = undefined
    }
    if (!resource) throw new Error('[代理检测] 连续 3 次取得重复出口 IP，未打开窗口；请检查服务商轮换规则后重试')
    let record: WindowRecord | undefined
    try {
      if (account) {
        try { await (this.options.initializeAccount || initializePortalSession)(resource.session, account) }
        catch { throw new Error('[官网会话初始化] 无法初始化该账号的官网身份，请检查凭证后重试') }
      }
      if (this.stopping) throw new Error('应用正在退出')
      const id = randomUUID()
      const area = screen.getPrimaryDisplay().workAreaSize
      const window = new BrowserWindow({
        width: Math.min(config.fingerprint.width, area.width), height: Math.min(config.fingerprint.height, area.height),
        minWidth: Math.min(800, area.width), minHeight: Math.min(480, area.height),
        show: false, title: 'KiroLuker 浏览器', autoHideMenuBar: true, backgroundColor: '#f5f6fa',
        webPreferences: {
          preload: join(app.getAppPath(), 'out', 'preload', 'browserChrome.js'),
          partition: `browser-chrome-${id}`, contextIsolation: true, nodeIntegration: false,
          sandbox: true, webSecurity: true, spellcheck: false
        }
      })
      record = { id, window, resource, fingerprint: config.fingerprint, accountId: account?.id,
        label: account ? (getSettings().privacyMode ? '账号窗口' : (account.nickname || account.email)) : '独立临时窗口',
        createdAt: Date.now(), proxyEnabled: config.proxy.enabled, activeTabId: '', tabs: new Map(), closing: false }
      this.windows.set(id, record)
      const current = record
      window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
      window.webContents.on('will-navigate', (event) => event.preventDefault())
      window.webContents.on('will-redirect', (event) => event.preventDefault())
      window.webContents.setZoomFactor(1)
      this.installShortcuts(current, window.webContents)
      window.on('resize', () => this.layout(current))
      window.on('closed', () => { void this.dispose(current) })
      resource.session.webRequest.onBeforeRequest((details, callback) => {
        if (current.closing) { callback({ cancel: true }); return }
        if (details.resourceType === 'mainFrame' && !isBrowserNavigationAllowed(details.url)) {
          callback({ cancel: true }); return
        }
        const tab = [...current.tabs.values()].find((t) => t.view.webContents.id === details.webContentsId)
        if (!tab) { callback({ cancel: true }); return }
        callback({ cancel: current.closing })
      })
      // HTTP proxy failures (including proxy-chain 59x responses) are not did-fail-load events.
      resource.session.webRequest.onHeadersReceived((details, callback) => {
        const tab = [...current.tabs.values()].find((t) => t.view.webContents.id === details.webContentsId)
        if (details.resourceType === 'mainFrame' && tab && details.statusCode >= 400) {
          tab.error = `网页请求失败（HTTP ${details.statusCode}）${current.proxyEnabled ? '；请检查代理或网站，未回退直连' : ''}`
          this.publish(current)
        }
        callback({ cancel: current.closing })
      })
      const devUrl = process.env['ELECTRON_RENDERER_URL']
      if (devUrl && !app.isPackaged) {
        await window.loadURL(new URL('src/browser-chrome/index.html', devUrl.endsWith('/') ? devUrl : `${devUrl}/`).href)
      } else {
        await window.loadFile(join(app.getAppPath(), 'out', 'renderer', 'src', 'browser-chrome', 'index.html'))
      }
      await this.newTab(current, account ? KIRO_PORTAL_ORIGIN : 'about:blank')
      if (current.closing || window.isDestroyed()) throw new Error('浏览器窗口已关闭')
      if (!this.options.hidden) { window.show(); window.focus() }
      if (resource.check) this.lastExitIp = resource.check.ip
      this.publish(current)
      return this.summary(current)
    } catch (error) {
      if (record) await this.dispose(record)
      else await resource.close()
      // Only locally authored, credential-free errors may escape this boundary.
      if (error instanceof Error && (/^\[官网会话初始化\]/.test(error.message) || ['应用正在退出', '浏览器窗口已关闭'].includes(error.message))) throw error
      throw new Error('[浏览器初始化] 无法创建浏览器窗口，请检查应用文件或浏览器参数')
    }
  }

  checkProxy(): Promise<BrowserProxyCheck> {
    const work = this.checkProxyNow()
    this.checks.add(work)
    void work.finally(() => this.checks.delete(work)).catch(() => undefined)
    return work
  }

  private async checkProxyNow(): Promise<BrowserProxyCheck> {
    const config = this.config()
    if (!config.proxy.enabled) throw new Error('请先保存并启用自定义代理')
    if (this.stopping) throw new Error('应用正在退出')
    const resource = await this.createSession(config)
    try { return resource.check! } finally { await resource.close() }
  }

  private preferences(record: WindowRecord): WebPreferences {
    return { session: record.resource.session, contextIsolation: true, nodeIntegration: false,
      nodeIntegrationInSubFrames: false, nodeIntegrationInWorker: false, sandbox: true,
      webSecurity: true, allowRunningInsecureContent: false, safeDialogs: true, spellcheck: false,
      navigateOnDragDrop: false }
  }

  private async configureTab(record: WindowRecord, contents: WebContents, bootstrap: boolean): Promise<void> {
    contents.setWebRTCIPHandlingPolicy('disable_non_proxied_udp')
    const ua = record.fingerprint.userAgent || CHROME_UA
    contents.setUserAgent(ua)
    // A manually created WebContentsView has no renderer until its first navigation.
    // Bootstrap a local blank document before waiting for CDP (otherwise startup deadlocks).
    if (bootstrap) await contents.loadURL('about:blank')
    contents.debugger.attach('1.3')
    const metadata = !record.fingerprint.userAgent ? {
      brands: [{ brand: 'Chromium', version: process.versions.chrome.split('.')[0] },
        { brand: 'Google Chrome', version: process.versions.chrome.split('.')[0] }],
      fullVersion: process.versions.chrome, platform: process.platform === 'win32' ? 'Windows' : process.platform === 'darwin' ? 'macOS' : 'Linux',
      platformVersion: '', architecture: process.arch === 'arm64' ? 'arm' : 'x86', model: '', mobile: false
    } : undefined
    // Native popup targets must finish their initial renderer handshake before
    // timezone/locale commands. Do not delay/replay their navigation or POST requests.
    await contents.debugger.sendCommand('Emulation.setUserAgentOverride', {
      userAgent: ua, acceptLanguage: acceptLanguageFor(record.fingerprint.language),
      ...(metadata ? { userAgentMetadata: metadata } : {})
    })
    await contents.debugger.sendCommand('Emulation.setLocaleOverride', { locale: record.fingerprint.language })
    if (record.fingerprint.timezone) {
      await contents.debugger.sendCommand('Emulation.setTimezoneOverride', { timezoneId: record.fingerprint.timezone })
    }
  }

  private attachTab(record: WindowRecord, view: WebContentsView, popup = false): Tab {
    const contents = view.webContents
    const tab: Tab = { id: randomUUID(), view, ready: Promise.resolve() }
    record.tabs.set(tab.id, tab)
    record.window.contentView.addChildView(view)
    view.setVisible(false)
    // Manual tabs await setup before navigation; native popups keep Chromium opener/POST behavior.
    tab.ready = browserSetupTimeout(this.configureTab(record, contents, !popup))
    void tab.ready.catch(() => {
      if (!record.closing && !contents.isDestroyed()) { contents.stop(); tab.error = '浏览器参数初始化失败，已停止加载'; this.publish(record) }
    })
    const update = (): void => { if (!record.closing) this.publish(record) }
    contents.on('page-title-updated', update)
    contents.on('did-start-loading', update)
    contents.on('did-stop-loading', update)
    contents.on('did-navigate', update)
    contents.on('did-navigate-in-page', update)
    contents.on('did-start-navigation', (_event, _url, _inPlace, mainFrame) => { if (mainFrame) tab.error = undefined })
    contents.on('did-fail-load', (_event, code, _description, _url, mainFrame) => {
      if (mainFrame && code !== -3 && !record.closing) {
        tab.error = `网页加载失败（${code}）${record.proxyEnabled ? '；请检查代理，未回退直连' : ''}`
        update()
      }
    })
    contents.on('render-process-gone', () => { tab.error = '页面进程已退出，请重新加载'; update() })
    contents.on('will-navigate', (event, url) => { if (!isBrowserNavigationAllowed(url)) event.preventDefault() })
    contents.on('will-redirect', (event, url) => { if (!isBrowserNavigationAllowed(url)) event.preventDefault() })
    contents.on('will-attach-webview', (event) => event.preventDefault())
    contents.setWindowOpenHandler((details) => {
      const { url } = details
      if (record.closing || !isBrowserNavigationAllowed(url)) return { action: 'deny' }
      return {
        action: 'allow', outlivesOpener: true,
        overrideBrowserWindowOptions: { webPreferences: this.preferences(record) },
        createWindow: (options) => {
          // Adopt Chromium's already-created popup WebContents to preserve navigation,
          // window.opener and POST payloads; creating another one strands the real popup.
          const nativeContents = (options as { webContents?: WebContents }).webContents
          const child = new WebContentsView({ webContents: nativeContents,
            webPreferences: { ...options.webPreferences, ...this.preferences(record), preload: undefined } })
          const childTab = this.attachTab(record, child, !!nativeContents)
          if (!nativeContents) {
            // Electron's createWindow override owns initial navigation for link-opened tabs.
            void childTab.ready.then(() => {
              if (record.closing || child.webContents.isDestroyed()) return
              const post = details.postBody
              void child.webContents.loadURL(url, {
                httpReferrer: details.referrer,
                ...(post ? { postData: post.data, extraHeaders: `Content-Type: ${post.contentType}${post.boundary ? `; boundary=${post.boundary}` : ''}` } : {})
              }).catch(() => undefined)
            }).catch(() => undefined)
          }
          this.activate(record, childTab.id)
          return child.webContents
        }
      }
    })
    contents.on('destroyed', () => {
      if (!record.closing && record.tabs.has(tab.id)) this.removeTab(record, tab.id)
    })
    this.installShortcuts(record, contents)
    return tab
  }

  private async newTab(record: WindowRecord, url = 'about:blank'): Promise<void> {
    const tab = this.attachTab(record, new WebContentsView({ webPreferences: this.preferences(record) }))
    this.activate(record, tab.id)
    await tab.ready
    if (record.closing || tab.view.webContents.isDestroyed()) return
    // A navigation failure is visible in the address bar; it must not leak the failing full URL into logs.
    void tab.view.webContents.loadURL(browserNavigationUrl(url)).catch(() => undefined)
    this.publish(record)
  }

  private layout(record: WindowRecord): void {
    if (record.closing || record.window.isDestroyed()) return
    const [width, height] = record.window.getContentSize()
    for (const tab of record.tabs.values()) {
      tab.view.setBounds({ x: 0, y: BROWSER_CHROME_HEIGHT, width, height: Math.max(0, height - BROWSER_CHROME_HEIGHT) })
    }
  }

  private activate(record: WindowRecord, tabId: string): void {
    const active = record.tabs.get(tabId)
    if (!active) throw new Error('标签页不存在')
    record.activeTabId = tabId
    for (const tab of record.tabs.values()) tab.view.setVisible(tab.id === tabId)
    this.layout(record)
    active.view.webContents.focus()
    this.publish(record)
  }

  private removeTab(record: WindowRecord, tabId: string): void {
    const tab = record.tabs.get(tabId)
    if (!tab) throw new Error('标签页不存在')
    record.tabs.delete(tabId)
    record.window.contentView.removeChildView(tab.view)
    if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close({ waitForBeforeUnload: false })
    if (!record.tabs.size) { record.window.close(); return }
    if (record.activeTabId === tabId) this.activate(record, [...record.tabs.keys()].at(-1)!)
    else this.publish(record)
  }

  private installShortcuts(record: WindowRecord, contents: WebContents): void {
    contents.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown') return
      const key = input.key.toLowerCase()
      const control = process.platform === 'darwin' ? input.meta : input.control
      let command: BrowserChromeCommand | undefined
      if (control && key === 'l') {
        event.preventDefault(); record.window.webContents.focus()
        record.window.webContents.send('browser-chrome:focus-address'); return
      }
      if (control && key === 't') command = { type: 'new-tab' }
      else if (control && key === 'w' && record.activeTabId) command = { type: 'close-tab', tabId: record.activeTabId }
      else if ((control && key === 'r') || key === 'f5') command = { type: 'reload' }
      else if (input.alt && key === 'arrowleft') command = { type: 'back' }
      else if (input.alt && key === 'arrowright') command = { type: 'forward' }
      if (command) { event.preventDefault(); void this.command(record.id, command).catch(() => undefined) }
    })
  }

  async command(id: string, command: BrowserChromeCommand): Promise<void> {
    const record = this.requireWindow(id)
    if (!command || typeof command !== 'object') throw new Error('无效的浏览器操作')
    if (command.type === 'new-tab') { await this.newTab(record); return }
    if (command.type === 'activate-tab') { this.activate(record, command.tabId); return }
    if (command.type === 'close-tab') { this.removeTab(record, command.tabId); return }
    const tab = record.tabs.get(record.activeTabId)
    if (!tab || tab.view.webContents.isDestroyed()) throw new Error('标签页已关闭')
    const contents = tab.view.webContents
    await tab.ready
    switch (command.type) {
      case 'navigate': {
        const url = browserNavigationUrl(command.url, true)
        tab.error = undefined
        void contents.loadURL(url).catch(() => undefined)
        break
      }
      case 'back': if (contents.navigationHistory.canGoBack()) contents.navigationHistory.goBack(); break
      case 'forward': if (contents.navigationHistory.canGoForward()) contents.navigationHistory.goForward(); break
      case 'reload': contents.reload(); break
      case 'stop': contents.stop(); break
      default: throw new Error('不支持的浏览器操作')
    }
    this.publish(record)
  }

  focus(id: string): void {
    const record = this.requireWindow(id)
    if (record.window.isMinimized()) record.window.restore()
    record.window.show(); record.window.focus()
  }

  async close(id: string): Promise<void> { await this.dispose(this.requireWindow(id)) }

  private dispose(record: WindowRecord): Promise<void> {
    if (record.cleanup) return record.cleanup
    if (record.closing) return Promise.resolve()
    record.closing = true
    this.windows.delete(record.id)
    for (const tab of record.tabs.values()) {
      if (!record.window.isDestroyed()) record.window.contentView.removeChildView(tab.view)
      if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close({ waitForBeforeUnload: false })
    }
    record.tabs.clear()
    const chromeSession = record.window.isDestroyed() ? undefined : record.window.webContents.session
    if (!record.window.isDestroyed()) record.window.destroy()
    record.cleanup = (async () => {
      await Promise.allSettled([record.resource.close(), chromeSession?.clearStorageData(), chromeSession?.clearCache()])
    })()
    this.cleanups.add(record.cleanup)
    void record.cleanup.finally(() => this.cleanups.delete(record.cleanup!))
    this.publish()
    return record.cleanup
  }

  async shutdown(): Promise<void> {
    this.stopping = true
    for (const controller of this.startupControllers) controller.abort()
    await Promise.allSettled([...this.windows.values()].map((record) => this.dispose(record)))
    await this.queue
    await Promise.allSettled([...this.checks])
    await Promise.allSettled([...this.cleanups])
  }
}

export const browserManager = new BrowserManager()
