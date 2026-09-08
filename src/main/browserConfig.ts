import Store from 'electron-store'
import { safeStorage } from 'electron'
import { isIP } from 'node:net'
import { getSettings } from './store'
import type { BrowserConfig, BrowserConfigPatch, BrowserFingerprint, BrowserProxyMode, BrowserResolvedConfig } from '../shared/browser'

const CONTROLS = /[\u0000-\u001f\u007f-\u009f]/
type RecordValue = Record<string, unknown>

function object(value: unknown, field: string): RecordValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${field}格式无效`)
  return value as RecordValue
}

function text(value: unknown, field: string): string {
  if (typeof value !== 'string' || CONTROLS.test(value) || Buffer.from(value).toString('utf8') !== value) {
    throw new Error(`${field}格式无效`)
  }
  return value
}

function integer(value: unknown, min: number, max: number, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${field}须为 ${min}～${max} 的整数`)
  }
  return value
}

function proxyMode(value: unknown): BrowserProxyMode {
  // Stored v1 configurations and direct callers are static SOCKS5 configurations.
  if (value === undefined || value === 'socks5') return 'socks5'
  if (value === 'dynamic-http') return value
  throw new Error('代理模式无效')
}

/** Pure validation: never include the submitted value (especially credentials) in errors. */
export function validateBrowserProxyHost(value: unknown, required = true): string {
  const host = text(value, '代理地址')
  if (!host && !required) return host
  if (!host || /[\s/@?#%\[\]\\]/u.test(host)) throw new Error('代理地址须为不含端口的 IP 或域名')
  if (isIP(host)) return host
  // Canonical bare IPv4/IPv6 or ASCII DNS labels (IDNs may use punycode); never a URI.
  const domain = host.endsWith('.') ? host.slice(0, -1) : host
  if (domain.length > 253 || /^[\d.]+$/.test(domain) || !domain.split('.').every(
    (label) => /^[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?$/i.test(label)
  )) throw new Error('代理地址须为不含端口的 IP 或域名')
  return host
}

export function validateBrowserProxyApiUrl(value: unknown, required = true): string {
  const apiUrl = text(value, '动态代理 API 地址').trim()
  if (!apiUrl && !required) return ''
  if (!apiUrl || apiUrl.length > 2048) throw new Error('动态代理 API 地址无效')
  try {
    const parsed = new URL(apiUrl)
    if (parsed.protocol !== 'https:' || !parsed.hostname || parsed.username || parsed.password || parsed.hash) {
      throw new Error()
    }
    return parsed.href
  } catch {
    throw new Error('动态代理 API 地址须为不含凭据或片段的 HTTPS 地址')
  }
}

export function validateBrowserLanguage(value: unknown): string {
  const language = text(value, '语言标签').trim()
  if (language.length > 255 || !/^[a-z]{2,8}(?:-[a-z\d]{1,8})*$/i.test(language)) {
    throw new Error('语言标签无效，请使用 zh-CN 等 BCP 47 格式')
  }
  try {
    return Intl.getCanonicalLocales(language)[0]
  } catch {
    throw new Error('语言标签无效，请使用 zh-CN 等 BCP 47 格式')
  }
}

export function validateBrowserTimezone(value: unknown): string {
  const timezone = text(value, '时区').trim()
  if (!timezone) return ''
  // Intl on newer runtimes also accepts numeric offsets; those are NOT IANA zones.
  if (timezone.length > 100 || !/^[a-z][a-z\d_+\-/]*$/i.test(timezone)) {
    throw new Error('时区无效，请使用 Asia/Shanghai 等 IANA 时区')
  }
  try {
    new Intl.DateTimeFormat('en', { timeZone: timezone }).format(0)
    return timezone
  } catch {
    throw new Error('时区无效，请使用 Asia/Shanghai 等 IANA 时区')
  }
}

export function validateBrowserFingerprint(value: unknown): BrowserFingerprint {
  const fingerprint = object(value, '浏览器指纹')
  const userAgent = text(fingerprint.userAgent, 'User-Agent').trim()
  if (userAgent.length > 512) throw new Error('User-Agent 不能超过 512 个字符')
  return {
    userAgent,
    language: validateBrowserLanguage(fingerprint.language),
    timezone: validateBrowserTimezone(fingerprint.timezone),
    width: integer(fingerprint.width, 900, 2400, '窗口宽度'),
    height: integer(fingerprint.height, 600, 1800, '窗口高度')
  }
}

export function validateBrowserProxy(value: unknown): BrowserResolvedConfig['proxy'] {
  const proxy = object(value, '代理配置')
  if (typeof proxy.enabled !== 'boolean') throw new Error('代理开关须为布尔值')
  const mode = proxyMode(proxy.mode)
  const username = text(proxy.username, '代理用户名')
  const password = text(proxy.password, '代理密码')
  if (Buffer.byteLength(username, 'utf8') > 255 || Buffer.byteLength(password, 'utf8') > 255) {
    throw new Error('代理用户名和密码各自不能超过 255 字节')
  }
  const dynamic = mode === 'dynamic-http'
  return {
    enabled: proxy.enabled,
    mode,
    host: validateBrowserProxyHost(proxy.host, proxy.enabled && !dynamic),
    port: integer(proxy.port, 1, 65535, '代理端口'),
    username,
    password,
    apiUrl: validateBrowserProxyApiUrl(proxy.apiUrl === undefined ? '' : proxy.apiUrl, proxy.enabled && dynamic),
    apiProxyHost: validateBrowserProxyHost(proxy.apiProxyHost === undefined ? '' : proxy.apiProxyHost, proxy.enabled && dynamic),
    apiProxyPort: integer(proxy.apiProxyPort === undefined ? 7897 : proxy.apiProxyPort, 1, 65535, '本机 HTTP 代理端口')
  }
}

/** The patch contract is a complete form; only password is optional (omitted retains it in SOCKS5 mode). */
export function validateBrowserConfigPatch(value: unknown, previousPassword = ''): BrowserResolvedConfig {
  const patch = object(value, '浏览器配置')
  const proxy = object(patch.proxy, '代理配置')
  return {
    proxy: validateBrowserProxy({ ...proxy, password: proxy.password === undefined ? previousPassword : proxy.password }),
    fingerprint: validateBrowserFingerprint(patch.fingerprint)
  }
}

export function defaultBrowserConfig(portalLocale: unknown = 'zh-CN'): BrowserResolvedConfig {
  let language = 'zh-CN'
  try { language = validateBrowserLanguage(portalLocale) } catch { /* Invalid legacy preference. */ }
  return {
    proxy: {
      enabled: false, mode: 'socks5', host: '', port: 1080, username: '', password: '',
      apiUrl: '', apiProxyHost: '', apiProxyPort: 7897
    },
    fingerprint: { userAgent: '', language, timezone: '', width: 1280, height: 900 }
  }
}

interface StoredBrowserConfig {
  version: 2
  proxy: {
    enabled: boolean
    mode: BrowserProxyMode
    host: string
    port: number
    apiUrl: string
    apiProxyHost: string
    apiProxyPort: number
    encryptedCredentials: string
  }
  fingerprint: BrowserFingerprint
}
interface BrowserStore { config: StoredBrowserConfig }
let store: Store<BrowserStore> | undefined

function getStore(): Store<BrowserStore> {
  // Lazy: safeStorage and userData are ready before the manager calls this API.
  store ??= new Store<BrowserStore>({ name: 'browser-settings' })
  return store
}

function secureStorageRequired(): void {
  try {
    if (!safeStorage.isEncryptionAvailable()) throw new Error()
    if (process.platform === 'linux') {
      const backend = safeStorage.getSelectedStorageBackend()
      if (backend === 'basic_text' || backend === 'unknown') throw new Error()
    }
  } catch {
    throw new Error('系统安全存储不可用，无法保存或读取代理凭据')
  }
}

function encodeConfig(config: BrowserResolvedConfig): StoredBrowserConfig {
  const { enabled, mode, host, port, username, password, apiUrl, apiProxyHost, apiProxyPort } = config.proxy
  let encryptedCredentials = ''
  if (mode === 'socks5' && (username || password)) {
    secureStorageRequired()
    try {
      encryptedCredentials = safeStorage.encryptString(JSON.stringify({ username, password })).toString('base64')
      if (!encryptedCredentials) throw new Error()
    } catch {
      throw new Error('无法安全加密代理凭据')
    }
  }
  return {
    version: 2,
    proxy: { enabled, mode, host, port, apiUrl, apiProxyHost, apiProxyPort, encryptedCredentials },
    fingerprint: { ...config.fingerprint }
  }
}

function readConfig(): BrowserResolvedConfig {
  let stored: unknown
  try {
    stored = getStore().get('config')
  } catch {
    throw new Error('无法读取浏览器配置')
  }
  if (stored === undefined) {
    let locale: unknown
    try { locale = getSettings().portalLocale } catch { /* Default only; never modify account settings. */ }
    const defaults = defaultBrowserConfig(locale)
    writeConfig(encodeConfig(defaults))
    return defaults
  }
  const config = object(stored, '已保存的浏览器配置')
  const proxy = object(config.proxy, '已保存的代理配置')
  const legacy = config.version === 1
  if ((!legacy && config.version !== 2) || typeof proxy.encryptedCredentials !== 'string') {
    throw new Error('浏览器配置存储格式无效')
  }
  let credentials = { username: '', password: '' }
  if (proxy.encryptedCredentials) {
    secureStorageRequired()
    try {
      const encrypted = Buffer.from(proxy.encryptedCredentials, 'base64')
      if (encrypted.toString('base64') !== proxy.encryptedCredentials) throw new Error()
      const decrypted = object(JSON.parse(safeStorage.decryptString(encrypted)), '已保存的代理凭据')
      credentials = {
        username: text(decrypted.username, '已保存的代理用户名'),
        password: text(decrypted.password, '已保存的代理密码')
      }
    } catch {
      // Never attach a cause: Electron/JSON errors can contain decrypted text or paths.
      throw new Error('无法解密代理凭据，请重新填写或清空')
    }
  }
  return validateBrowserConfigPatch({
    proxy: {
      ...proxy,
      mode: legacy ? 'socks5' : proxy.mode,
      apiUrl: legacy ? '' : proxy.apiUrl,
      apiProxyHost: legacy ? '' : proxy.apiProxyHost,
      apiProxyPort: legacy ? 7897 : proxy.apiProxyPort,
      ...credentials
    },
    fingerprint: config.fingerprint
  })
}

function writeConfig(config: StoredBrowserConfig): void {
  try {
    getStore().set('config', config)
  } catch {
    throw new Error('无法保存浏览器配置')
  }
}

function publicConfig(config: BrowserResolvedConfig): BrowserConfig {
  const { enabled, mode, host, port, username, password, apiUrl, apiProxyHost, apiProxyPort } = config.proxy
  return {
    proxy: { enabled, mode, host, port, username, passwordSet: password.length > 0, apiUrl, apiProxyHost, apiProxyPort },
    fingerprint: { ...config.fingerprint }
  }
}

export function getBrowserConfig(): BrowserConfig {
  return publicConfig(readConfig())
}

/** Main-process ONLY. Do not expose this function or its result through IPC. */
export function getResolvedBrowserConfig(): BrowserResolvedConfig {
  return readConfig()
}

export function saveBrowserConfig(patch: BrowserConfigPatch): BrowserConfig {
  // Validate before any read/write. Dynamic mode has no SOCKS secret and deliberately
  // clears stale SOCKS credentials instead of retaining an unused encrypted value.
  const config = validateBrowserConfigPatch(patch)
  if (config.proxy.mode === 'socks5' && patch.proxy.password === undefined) {
    config.proxy.password = readConfig().proxy.password
  } else if (config.proxy.mode === 'dynamic-http') {
    config.proxy.username = ''
    config.proxy.password = ''
  }
  writeConfig(encodeConfig(config))
  return publicConfig(config)
}
