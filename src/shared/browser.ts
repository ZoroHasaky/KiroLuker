/** Browser UI contracts. Secrets are write-only; remote web pages never receive this API. */
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
    host: string
    port: number
    username: string
    passwordSet: boolean
  }
  fingerprint: BrowserFingerprint
}

export interface BrowserConfigPatch {
  proxy: Omit<BrowserConfig['proxy'], 'passwordSet'> & {
    /** Omitted preserves the stored secret; empty string explicitly clears it. */
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

export interface BrowserChromeState {
  windowId: string
  label: string
  proxyEnabled: boolean
  exitIp?: string
  country?: string
  activeTabId: string
  tabs: BrowserTabState[]
}

export type BrowserChromeCommand =
  | { type: 'new-tab' }
  | { type: 'activate-tab'; tabId: string }
  | { type: 'close-tab'; tabId: string }
  | { type: 'navigate'; url: string }
  | { type: 'back' | 'forward' | 'reload' | 'stop' }

export const BROWSER_CHROME_HEIGHT = 112
import type { IpcResult } from './types'

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
