// 用指定账号的凭证打开 Kiro 官网后台
//
// 为什么不用系统浏览器的无痕窗口：那条路（browser.ts 的 openUrl）没法把凭证塞进去，
// 打开只会停在登录页。这里改用应用内的一次性会话分区，把账号 cookie 注入后再加载页面，
// 于是「用该账号身份进入后台」和「不碰用户自己的浏览器身份」两件事同时成立。
import { BrowserWindow, screen, session as electronSession, shell } from 'electron'
import { acceptLanguageFor } from '../shared/portalLocale'
import { listAvailableProfiles } from './kiroApi'
import type { Account } from '../shared/types'

const PORTAL_ORIGIN = 'https://app.kiro.dev'

/**
 * 私密会话：分区名不带 persist: 前缀，Electron 就只在内存里保存，
 * 应用退出即消失，也不会与主窗口或其它账号共用登录态。
 */
const PARTITION = 'kiro-portal-private'

/**
 * 伪装成普通 Chrome。
 *
 * 默认 UA 会带上应用名与 Electron/<版本>，对站点来说是显眼的自动化特征。
 * 版本号直接取内置 Chromium 的主版本而不是写死一个更新的值：UA 里声称的版本
 * 与实际引擎能力对不上，本身也是可被识别的破绽。
 */
const CHROME_MAJOR = process.versions.chrome.split('.')[0] || '134'

function platformToken(): string {
  if (process.platform === 'darwin') return 'Macintosh; Intel Mac OS X 10_15_7'
  if (process.platform === 'win32') return 'Windows NT 10.0; Win64; x64'
  return 'X11; Linux x86_64'
}

function platformBrand(): string {
  if (process.platform === 'darwin') return 'macOS'
  if (process.platform === 'win32') return 'Windows'
  return 'Linux'
}

const CHROME_UA =
  `Mozilla/5.0 (${platformToken()}) AppleWebKit/537.36 (KHTML, like Gecko) ` +
  `Chrome/${CHROME_MAJOR}.0.0.0 Safari/537.36`

/** 客户端提示要和 UA 对齐，否则两者矛盾反而更容易被判为异常 */
const SEC_CH_UA =
  `"Chromium";v="${CHROME_MAJOR}", "Not(A:Brand";v="24", "Google Chrome";v="${CHROME_MAJOR}"`

/**
 * 应用内网页使用的地区，由设置里的「浏览器地区」决定。
 * 主进程启动时读一次设置，之后随设置保存实时更新（Accept-Language 无需重启即可生效）。
 */
let acceptLanguage = acceptLanguageFor()

/**
 * 设置应用内网页的地区。
 *
 * 除了门户那个分区，默认会话也一并更新：这样以后再加别的内嵌网页
 * 不用记得单独设一次，地区口径始终跟着这个设置走。
 * 默认会话只改 Accept-Language、保留原 UA——UA 是给 Kiro 接口用的，不能动。
 */
export function setInAppLocale(locale?: string): void {
  acceptLanguage = acceptLanguageFor(locale)

  const sessions = [electronSession.defaultSession, electronSession.fromPartition(PARTITION)]
  for (const ses of sessions) {
    ses.setUserAgent(ses.getUserAgent(), acceptLanguage)
  }
}

/**
 * 统一改写该会话发出的请求头。
 * 除了 UA 与客户端提示，再兜一层：任何残留 Electron 字样的头都清掉。
 */
function maskUserAgent(ses: Electron.Session): void {
  // 第二个参数就是该会话的 Accept-Language，会一并影响子资源请求
  ses.setUserAgent(CHROME_UA, acceptLanguage)
  ses.webRequest.onBeforeSendHeaders((details, callback) => {
    const requestHeaders: Record<string, string> = { ...details.requestHeaders }
    requestHeaders['User-Agent'] = CHROME_UA
    requestHeaders['Accept-Language'] = acceptLanguage
    requestHeaders['sec-ch-ua'] = SEC_CH_UA
    requestHeaders['sec-ch-ua-mobile'] = '?0'
    requestHeaders['sec-ch-ua-platform'] = `"${platformBrand()}"`
    for (const [name, value] of Object.entries(requestHeaders)) {
      if (typeof value === 'string' && value.includes('Electron')) delete requestHeaders[name]
    }
    callback({ requestHeaders })
  })
}

let portalWindow: BrowserWindow | null = null

/**
 * 所有窗口共用一份 webPreferences：
 * 子窗口必须落在同一个会话分区，否则弹出的页面拿不到登录态，等于又要重新登录。
 * 加载的是第三方页面（含支付页），因此隔离、沙箱、禁用 node 三件套不能省。
 */
const CHILD_WEB_PREFERENCES = {
  partition: PARTITION,
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true
} as const

/**
 * 网页窗口尺寸：目标 1600x1200，但按当前显示器可用区域收一下。
 * 1080p 等较矮的屏幕放不下 1200 高，硬开会被系统裁掉或顶出屏幕，
 * 与主窗口的处理保持一致。
 */
function portalWindowSize(): { width: number; height: number } {
  const { width: aw, height: ah } = screen.getPrimaryDisplay().workAreaSize
  return {
    width: Math.min(1600, Math.max(900, aw - 80)),
    height: Math.min(1200, Math.max(600, ah - 80))
  }
}

/**
 * 把导航留在应用内。
 *
 * 之前只放行 kiro.dev、其余交给系统浏览器，于是点到支付页、AWS 文档这类站外链接
 * 就跳出应用，而系统浏览器里没有这份会话，流程直接断掉。
 * 现在 http(s) 一律用应用内新窗口承载，并对新窗口递归挂上同样的规则，
 * 保证从弹窗里再点出去的链接同样不会外泄。
 *
 * 非 http(s) 的 scheme（mailto、itms-apps 等）Electron 渲染不了，仍交给系统处理。
 */
function keepNavigationInApp(contents: Electron.WebContents): void {
  contents.setUserAgent(CHROME_UA)

  contents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          ...portalWindowSize(),
          autoHideMenuBar: true,
          webPreferences: { ...CHILD_WEB_PREFERENCES }
        }
      }
    }
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  // 新开的窗口同样要遵守这套规则，否则第二层弹窗又会漏到系统浏览器
  contents.on('did-create-window', (child) => {
    keepNavigationInApp(child.webContents)
  })
}

/**
 * 门户认的会话 cookie。
 *
 * Idp / AccessToken / RefreshToken 三个是社交与 Builder ID 账号进后台的充分条件。
 * Enterprise（IdC / SSO）账号还必须带 ProfileArn，否则门户把会话判为 stale、停在登录页
 * —— 实测同一 token 补上该 cookie，user-status 立刻从 stale 变 active、user-id 也出现。
 * 对其它登录方式带上它无副作用（本就 active，加了仍 active），因此只要账号有 ARN 就一并注入。
 */
function portalCookies(account: Account, profileArn: string): { name: string; value: string }[] {
  const { accessToken, refreshToken } = account.credentials
  return [
    { name: 'Idp', value: account.idp },
    { name: 'AccessToken', value: accessToken },
    { name: 'RefreshToken', value: refreshToken },
    { name: 'ProfileArn', value: profileArn }
  ].filter((item) => !!item.value)
}

/**
 * 定出注入 cookie 用的 profileArn。
 *
 * 优先用账号已存的值。仅当 Enterprise 账号一次都没存过 ARN 时，才现场问一次
 * ListAvailableProfiles 补齐——否则这类账号打开官网只会停在登录页（stale）。
 * 失败或非 Enterprise 一律返回空串，行为与之前一致，不引入回归。
 */
async function resolvePortalArn(account: Account): Promise<string> {
  const stored = account.profileArn || account.credentials.profileArn
  if (stored) return stored
  if (account.idp !== 'Enterprise') return ''

  const { accessToken, region } = account.credentials
  if (!accessToken) return ''
  try {
    const [arn] = await listAvailableProfiles(accessToken, region)
    if (arn) console.info('[KiroPortal] Enterprise 账号缺 profileArn，已现查补齐')
    return arn || ''
  } catch {
    return ''
  }
}

/**
 * 打开官网后台并以该账号身份登录。
 * 已有窗口时复用：换账号只需重写 cookie，不必再开一个窗口。
 */
export async function openAccountPortal(account: Account): Promise<{ url: string }> {
  const { accessToken, refreshToken } = account.credentials
  if (!accessToken && !refreshToken) throw new Error('账号缺少凭证，无法登录官网')

  const profileArn = await resolvePortalArn(account)

  const ses = electronSession.fromPartition(PARTITION)
  maskUserAgent(ses)
  /*
   * 每次都先清空：残留的旧账号 cookie 会让门户继续按上一个身份渲染，
   * 表现就是「点了 A 账号却进了 B 账号的后台」。
   */
  await ses.clearStorageData({ storages: ['cookies'] })

  for (const { name, value } of portalCookies(account, profileArn)) {
    await ses.cookies.set({
      url: PORTAL_ORIGIN,
      name,
      value,
      domain: 'app.kiro.dev',
      path: '/',
      secure: true,
      httpOnly: true,
      sameSite: 'lax'
    })
  }

  if (!portalWindow || portalWindow.isDestroyed()) {
    portalWindow = new BrowserWindow({
      ...portalWindowSize(),
      title: 'Kiro 官网',
      autoHideMenuBar: true,
      webPreferences: CHILD_WEB_PREFERENCES
    })
    portalWindow.on('closed', () => {
      portalWindow = null
    })
    keepNavigationInApp(portalWindow.webContents)
  }

  const window = portalWindow
  window.setTitle(`Kiro 官网 - ${account.email}`)
  await window.loadURL(PORTAL_ORIGIN, { userAgent: CHROME_UA })
  if (window.isMinimized()) window.restore()
  window.focus()
  console.info(`[KiroPortal] 已以 ${account.email} 的身份打开官网后台`)
  return { url: PORTAL_ORIGIN }
}
