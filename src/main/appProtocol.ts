// 应用自有 URL Scheme：kiroluker:// 与短别名 klr://
//
// 与 onlineLogin.ts 里临时接管的 kiro:// 不同，这两个协议属于本应用，
// 常驻注册，用于从浏览器 / 终端 / 快捷方式快速唤起主窗口。
//
// 支持的形式（完整名与短别名等价）：
//   kiroluker://  |  klr://              唤起主窗口
//   kiroluker://focus  |  klr://focus    同上，回调页「打开应用」按钮的兜底入口
//   kiroluker://accounts  |  klr://accounts   唤起并跳转到账户管理
//   kiroluker://settings  |  klr://settings   唤起并跳转到设置
//   kiroluker://home|about  |  klr://home|about  唤起并跳转到对应页面
import { app } from 'electron'
import type { BrowserWindow } from 'electron'
import { join } from 'path'
import { sendToRenderer } from './utils'

/** 新协议用于当前版本；历史协议继续兼容已有快捷方式和网页回跳。 */
const APP_PROTOCOLS = ['kiroluker', 'klr', 'kiroluler', 'kiro-manager-lite', 'kml'] as const

/** 可通过协议直达的路由，避免把任意字符串塞给渲染进程路由 */
const ROUTABLE = new Set(['home', 'accounts', 'settings', 'about'])

/**
 * 注册协议时附带的启动参数：开发模式下应用由 electron 可执行文件启动，
 * 必须把入口脚本一起写进注册表/LaunchServices，否则唤起的是空的 electron。
 */
function protocolArgs(): string[] | undefined {
  if (!process.defaultApp) return undefined
  return process.argv.length >= 2 ? [join(process.argv[1])] : undefined
}

/**
 * 注册 / 注销单个协议。
 * onlineLogin 临时接管 kiro:// 时也走这里，避免两份启动参数逻辑各自维护。
 */
export function setProtocolClient(scheme: string, register: boolean): boolean {
  const args = protocolArgs()
  if (register) {
    return args
      ? app.setAsDefaultProtocolClient(scheme, process.execPath, args)
      : app.setAsDefaultProtocolClient(scheme)
  }
  return args
    ? app.removeAsDefaultProtocolClient(scheme, process.execPath, args)
    : app.removeAsDefaultProtocolClient(scheme)
}

/** 启动时注册，让系统把本应用的协议都指向自己 */
export function registerAppProtocol(): void {
  for (const scheme of APP_PROTOCOLS) {
    try {
      console.log(`[AppProtocol] ${scheme}:// registered: ${setProtocolClient(scheme, true)}`)
    } catch (e) {
      console.warn(`[AppProtocol] failed to register ${scheme}://:`, e)
    }
  }
}

export function isAppProtocolUrl(url: string): boolean {
  const lower = url.toLowerCase()
  return APP_PROTOCOLS.some((scheme) => lower.startsWith(`${scheme}://`))
}

/** 从命令行参数里找出本应用协议的 URL（Windows / Linux 第二实例场景） */
export function findAppProtocolUrl(argv: string[]): string | undefined {
  return argv.find((arg) => isAppProtocolUrl(arg))
}

/**
 * 处理协议唤起：先把窗口带到前台，再按需要跳转路由。
 * focus 由调用方传入，复用主进程已有的窗口唤起逻辑。
 */
export function handleAppProtocolUrl(
  url: string,
  focus: () => void,
  getWindow: () => BrowserWindow | null
): void {
  if (!isAppProtocolUrl(url)) return
  focus()

  let target: string | undefined
  try {
    // klr://accounts 里 accounts 落在 hostname 上，
    // klr:///accounts 之类的写法则落在 pathname
    const parsed = new URL(url)
    target = (parsed.hostname || parsed.pathname.replace(/^\/+/, '')).toLowerCase()
  } catch {
    return
  }

  // focus 等非路由目标已经被上面的 focus() 处理完，这里只放行白名单路由
  if (!ROUTABLE.has(target)) return

  sendToRenderer(getWindow(), 'app:navigate', target)
}
