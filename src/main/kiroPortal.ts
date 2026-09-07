// 用指定账号的凭证打开 Kiro 官网后台
//
// 为什么不用系统浏览器的无痕窗口：那条路（browser.ts 的 openUrl）没法把凭证塞进去，
// 打开只会停在登录页。这里改用应用内的一次性会话分区，把账号 cookie 注入后再加载页面，
// 于是「用该账号身份进入后台」和「不碰用户自己的浏览器身份」两件事同时成立。
import { BrowserWindow, screen, session as electronSession, shell } from 'electron'
import {
  CHROME_UA,
  KIRO_PORTAL_ORIGIN as PORTAL_ORIGIN,
  configurePortalSession,
  getPortalAcceptLanguage,
  initializePortalSession,
  setPortalLocale
} from './kiroPortalSession'
import type { Account } from '../shared/types'

/**
 * 私密会话：分区名不带 persist: 前缀，Electron 就只在内存里保存，
 * 应用退出即消失，也不会与主窗口或其它账号共用登录态。
 */
const PARTITION = 'kiro-portal-private'

/**
 * 设置应用内网页的地区。
 *
 * 除了门户那个分区，默认会话也一并更新：这样以后再加别的内嵌网页
 * 不用记得单独设一次，地区口径始终跟着这个设置走。
 * 默认会话只改 Accept-Language、保留原 UA——UA 是给 Kiro 接口用的，不能动。
 */
export function setInAppLocale(locale?: string): void {
  setPortalLocale(locale)
  const acceptLanguage = getPortalAcceptLanguage()

  const sessions = [electronSession.defaultSession, electronSession.fromPartition(PARTITION)]
  for (const ses of sessions) {
    ses.setUserAgent(ses.getUserAgent(), acceptLanguage)
  }
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
 * 打开官网后台并以该账号身份登录。
 * 已有窗口时复用：换账号只需重写 cookie，不必再开一个窗口。
 */
export async function openAccountPortal(account: Account): Promise<{ url: string }> {
  const { accessToken, refreshToken } = account.credentials
  if (!accessToken && !refreshToken) throw new Error('账号缺少凭证，无法登录官网')

  const ses = electronSession.fromPartition(PARTITION)
  configurePortalSession(ses)
  await initializePortalSession(ses, account)

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
