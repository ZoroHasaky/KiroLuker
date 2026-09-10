import type { IpcResult } from './types'

/** Browser UI contracts. Secrets are write-only; remote web pages never receive this API. */
export type BrowserProxyMode = 'socks5' | 'dynamic-http'

export interface BrowserFingerprint {
  /** Empty means the bundled Chromium/host-platform Chrome UA. */
  userAgent: string
  language: string
  /** Empty means the operating-system time zone; otherwise an IANA time zone. */
  timezone: string
  width: number
  height: number
}

export interface BrowserConfig {
  proxy: {
    enabled: boolean
    /** Static SOCKS5, or a whitelist API which returns an HTTP CONNECT proxy. */
    mode: BrowserProxyMode
    /** Static SOCKS5 endpoint only. */
    host: string
    port: number
    username: string
    passwordSet: boolean
    /** HTTPS whitelist API returning one `IP:port` value. Dynamic mode only. */
    apiUrl: string
    /** Local HTTP proxy used both to request the API and reach the returned endpoint. */
    apiProxyHost: string
    apiProxyPort: number
  }
  fingerprint: BrowserFingerprint
}

export interface BrowserConfigPatch {
  proxy: Omit<BrowserConfig['proxy'], 'passwordSet'> & {
    /** Omitted preserves the stored secret in SOCKS5 mode; empty string explicitly clears it. */
    password?: string
  }
  fingerprint: BrowserFingerprint
}

/** Main-process-only resolved credentials. Never return through renderer IPC. */
export interface BrowserResolvedConfig {
  proxy: Omit<BrowserConfig['proxy'], 'passwordSet'> & { password: string }
  fingerprint: BrowserFingerprint
}

export interface BrowserProxyCheck {
  ip: string
  country: string
  checkedAt: number
  latencyMs: number
}

export interface BrowserWindowSummary {
  id: string
  accountId?: string
  label: string
  createdAt: number
  tabCount: number
  /** Origin only: portal session links must not enter the management UI. */
  activeOrigin: string
  proxyEnabled: boolean
  exitIp?: string
  country?: string
}

export interface BrowserOpenRequest {
  /** Omitted opens a blank, anonymous window. Credentials are resolved in main. */
  accountId?: string
}

export interface BrowserTabState {
  id: string
  title: string
  url: string
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
  error?: string
}

export interface BrowserSessionAccountSummary {
  detected: boolean
  email?: string
  idp?: string
  userId?: string
  alreadyAdded?: boolean
  error?: string
}

export interface BrowserChromeState {
  windowId: string
  label: string
  proxyEnabled: boolean
  exitIp?: string
  country?: string
  activeTabId: string
  tabs: BrowserTabState[]
  sessionAccount?: BrowserSessionAccountSummary
}

export type BrowserChromeCommand =
  | { type: 'new-tab' }
  | { type: 'activate-tab'; tabId: string }
  | { type: 'close-tab'; tabId: string }
  | { type: 'navigate'; url: string }
  | { type: 'back' | 'forward' | 'reload' | 'stop' }
  | { type: 'check-account' }
  | { type: 'import-account' }
  | { type: 'start-login'; provider?: 'Google' | 'Github' }

export const BROWSER_CHROME_HEIGHT = 112

export interface BrowserRendererApi {
  getBrowserConfig(): Promise<IpcResult<BrowserConfig>>
  saveBrowserConfig(patch: BrowserConfigPatch): Promise<IpcResult<BrowserConfig>>
  checkBrowserProxy(): Promise<IpcResult<BrowserProxyCheck>>
  getBrowserWindows(): Promise<IpcResult<BrowserWindowSummary[]>>
  openBrowserWindow(request: BrowserOpenRequest): Promise<IpcResult<BrowserWindowSummary>>
  focusBrowserWindow(id: string): Promise<IpcResult<void>>
  closeBrowserWindow(id: string): Promise<IpcResult<void>>
  onBrowserWindowsChanged(callback: (windows: BrowserWindowSummary[]) => void): () => void
}
