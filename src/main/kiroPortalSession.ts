// 官网会话的请求头与身份初始化；只操作调用方传入的 session，不选择或复用任何分区。
import { acceptLanguageFor } from '../shared/portalLocale'
import { listAvailableProfiles } from './kiroApi'
import type { Account } from '../shared/types'

export const KIRO_PORTAL_ORIGIN = 'https://app.kiro.dev'

/**
 * 伪装成普通 Chrome。
 *
 * 默认 UA 会带上应用名与 Electron/<版本>，对站点来说是显眼的自动化特征。
 * 版本号直接取内置 Chromium 的主版本而不是写死一个更新的值：UA 里声称的版本
 * 与实际引擎能力对不上，本身也是可被识别的破绽。
 */
const CHROME_MAJOR = process.versions.chrome?.split('.')[0] || '134'

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

export const CHROME_UA =
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

/** 仅更新语言配置；不访问或修改任何 session 的身份。 */
export function setPortalLocale(locale?: string): void {
  acceptLanguage = acceptLanguageFor(locale)
}

export function getPortalAcceptLanguage(): string {
  return acceptLanguage
}

/**
 * 统一改写该会话发出的请求头。
 * 除了 UA 与客户端提示，再兜一层：任何残留 Electron 字样的头都清掉。
 */
export function configurePortalSession(
  ses: Electron.Session,
  overrides?: { userAgent?: string; acceptLanguage?: string }
): void {
  // 第二个参数就是该会话的 Accept-Language，会一并影响子资源请求
  const userAgent = overrides?.userAgent || CHROME_UA
  ses.setUserAgent(userAgent, overrides?.acceptLanguage || acceptLanguage)
  ses.webRequest.onBeforeSendHeaders((details, callback) => {
    const requestHeaders: Record<string, string> = { ...details.requestHeaders }
    requestHeaders['User-Agent'] = userAgent
    requestHeaders['Accept-Language'] = overrides?.acceptLanguage || acceptLanguage
    requestHeaders['sec-ch-ua'] = SEC_CH_UA
    requestHeaders['sec-ch-ua-mobile'] = '?0'
    requestHeaders['sec-ch-ua-platform'] = `"${platformBrand()}"`
    // Custom UA must not inherit contradictory Chromium client hints.
    if (userAgent !== CHROME_UA) {
      for (const name of Object.keys(requestHeaders)) {
        if (name.toLowerCase().startsWith('sec-ch-ua')) delete requestHeaders[name]
      }
    }
    for (const [name, value] of Object.entries(requestHeaders)) {
      if (typeof value === 'string' && value.includes('Electron')) delete requestHeaders[name]
    }
    callback({ requestHeaders })
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
 * 在指定会话中替换官网身份，只清理该会话的 cookies。
 * ARN 补齐只读，不修改传入账号；可见门户与后台业务必须由调用方使用各自的 session。
 */
export async function initializePortalSession(
  ses: Electron.Session,
  account: Account
): Promise<string> {
  const { accessToken, refreshToken } = account.credentials
  if (!accessToken && !refreshToken) throw new Error('账号缺少凭证，无法登录官网')

  const profileArn = await resolvePortalArn(account)
  // 清除上一账号的 cookies，避免门户继续按旧身份渲染。
  await ses.clearStorageData({ storages: ['cookies'] })

  for (const { name, value } of portalCookies(account, profileArn)) {
    await ses.cookies.set({
      url: KIRO_PORTAL_ORIGIN,
      name,
      value,
      domain: 'app.kiro.dev',
      path: '/',
      secure: true,
      httpOnly: true,
      sameSite: 'lax'
    })
  }
  return profileArn
}
