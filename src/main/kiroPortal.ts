// 用指定账号的凭证打开 Kiro 官网后台
//
// 为什么不用系统浏览器的无痕窗口：那条路（browser.ts 的 openUrl）没法把凭证塞进去，
// 打开只会停在登录页。这里改用应用内的一次性会话分区，把账号 cookie 注入后再加载页面，
// 于是「用该账号身份进入后台」和「不碰用户自己的浏览器身份」两件事同时成立。
import { BrowserWindow, session as electronSession, shell } from 'electron'
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
 * 统一改写该会话发出的请求头。
 * 除了 UA 与客户端提示，再兜一层：任何残留 Electron 字样的头都清掉。
 */
function maskUserAgent(ses: Electron.Session): void {
  ses.setUserAgent(CHROME_UA)
  ses.webRequest.onBeforeSendHeaders((details, callback) => {
    const requestHeaders: Record<string, string> = { ...details.requestHeaders }
    requestHeaders['User-Agent'] = CHROME_UA
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

/** 门户认这三个 cookie：Idp 决定身份来源，AccessToken 是会话本体 */
function portalCookies(account: Account): { name: string; value: string }[] {
  const { accessToken, refreshToken } = account.credentials
  return [
    { name: 'Idp', value: account.idp },
    { name: 'AccessToken', value: accessToken },
    { name: 'RefreshToken', value: refreshToken }
  ].filter((item) => !!item.value)
}

/**
 * 打开官网后台并以该账号身份登录。
 * 已有窗口时复用：换账号只需重写 cookie，不必再开一个窗口。
 */
export async function openAccountPortal(account: Account): Promise<{ url: string }> {
  const { accessToken, refreshToken } = account.credentials
  if (!accessToken && !refreshToken) throw new Error('账号缺少凭证，无法登录官网')

  const ses = electronSession.fromPartition(PARTITION)
  maskUserAgent(ses)
  /*
   * 每次都先清空：残留的旧账号 cookie 会让门户继续按上一个身份渲染，
   * 表现就是「点了 A 账号却进了 B 账号的后台」。
   */
  await ses.clearStorageData({ storages: ['cookies'] })

  for (const { name, value } of portalCookies(account)) {
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
      width: 1180,
      height: 900,
      title: 'Kiro 官网',
      autoHideMenuBar: true,
      webPreferences: {
        partition: PARTITION,
        // 载入的是第三方页面，必须隔离并关掉 node 能力
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true
      }
    })
    portalWindow.on('closed', () => {
      portalWindow = null
    })
    // 站外链接交给系统浏览器，不在这个窗口里套娃
    portalWindow.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https:\/\/([a-z0-9-]+\.)*kiro\.dev/i.test(url)) return { action: 'allow' }
      void shell.openExternal(url)
      return { action: 'deny' }
    })
  }

  const window = portalWindow
  window.setTitle(`Kiro 官网 - ${account.email}`)
  // 同时设到 webContents：页面内 navigator.userAgent 也要一致，否则前端一比就露
  window.webContents.setUserAgent(CHROME_UA)
  await window.loadURL(PORTAL_ORIGIN, { userAgent: CHROME_UA })
  if (window.isMinimized()) window.restore()
  window.focus()
  console.info(`[KiroPortal] 已以 ${account.email} 的身份打开官网后台`)
  return { url: PORTAL_ORIGIN }
}
