// 外部浏览器打开：支持无痕/隐私窗口，找不到可用浏览器时回退到系统默认浏览器
import { app, shell } from 'electron'
import { spawn, spawnSync } from 'child_process'
import * as fs from 'fs'
import { homedir } from 'os'
import { basename, join } from 'path'
import type { BrowserOpenInfo } from '../shared/types'

export interface BrowserOpenOptions {
  privateMode?: boolean
  /** 严格私密模式：没有可用浏览器时直接失败，不允许回退普通窗口 */
  requirePrivate?: boolean
  /** 用户通过原生选择器指定的浏览器可执行文件 */
  browserPath?: string
}

export interface PrivateBrowserSelection {
  path: string
  family: Family
  name: string
}

export const PRIVATE_BROWSER_REQUIRED = 'PRIVATE_BROWSER_REQUIRED'

/** 只放行 http(s)：自定义协议可能被诱导拉起本地程序 */
export function isHttpUrl(url: string): boolean {
  return /^https?:\/\//i.test(url)
}

type Family = 'chromium' | 'edge' | 'firefox'

interface Candidate {
  name: string
  family: Family
  /** 可执行文件路径（macOS / Windows）或命令名（Linux） */
  bin: string
}

/** 只接受我们明确知道私密启动参数的浏览器，避免把任意可执行文件当浏览器拉起。 */
export function inspectPrivateBrowserPath(input: string): PrivateBrowserSelection | null {
  const path = input.trim()
  if (!path || !fs.existsSync(path)) return null
  try {
    if (!fs.statSync(path).isFile()) return null
  } catch {
    return null
  }
  const file = basename(path).toLowerCase()
  if (file === 'firefox' || file === 'firefox.exe') {
    return { path, family: 'firefox', name: 'Firefox' }
  }
  if (
    file === 'msedge.exe' ||
    file === 'microsoft edge' ||
    file === 'microsoft-edge' ||
    file === 'microsoft-edge-stable'
  ) {
    return { path, family: 'edge', name: 'Microsoft Edge' }
  }
  if (file === 'brave.exe' || file === 'brave browser' || file === 'brave-browser') {
    return { path, family: 'chromium', name: 'Brave' }
  }
  if (file === 'chromium.exe' || file === 'chromium' || file === 'chromium-browser') {
    return { path, family: 'chromium', name: 'Chromium' }
  }
  if (
    file === 'chrome.exe' ||
    file === 'google chrome' ||
    file === 'google-chrome' ||
    file === 'google-chrome-stable'
  ) {
    return { path, family: 'chromium', name: 'Google Chrome' }
  }
  return null
}

function configuredCandidate(path?: string): Candidate | null {
  if (!path) return null
  const selected = inspectPrivateBrowserPath(path)
  return selected ? { name: selected.name, family: selected.family, bin: selected.path } : null
}

function macCandidates(): Candidate[] {
  const roots = ['/Applications', join(homedir(), 'Applications')]
  const apps: [string, Family, string][] = [
    ['Google Chrome', 'chromium', 'Google Chrome.app/Contents/MacOS/Google Chrome'],
    ['Microsoft Edge', 'edge', 'Microsoft Edge.app/Contents/MacOS/Microsoft Edge'],
    ['Brave', 'chromium', 'Brave Browser.app/Contents/MacOS/Brave Browser'],
    ['Chromium', 'chromium', 'Chromium.app/Contents/MacOS/Chromium'],
    ['Firefox', 'firefox', 'Firefox.app/Contents/MacOS/firefox']
  ]
  return roots.flatMap((root) =>
    apps.map(([name, family, relative]) => ({ name, family, bin: join(root, relative) }))
  )
}

function winCandidates(): Candidate[] {
  const dirs = [
    process.env['PROGRAMFILES'],
    process.env['PROGRAMFILES(X86)'],
    process.env['LOCALAPPDATA']
  ].filter((v): v is string => !!v)

  const apps: [string, Family, string][] = [
    ['Google Chrome', 'chromium', 'Google\\Chrome\\Application\\chrome.exe'],
    ['Microsoft Edge', 'edge', 'Microsoft\\Edge\\Application\\msedge.exe'],
    ['Brave', 'chromium', 'BraveSoftware\\Brave-Browser\\Application\\brave.exe'],
    ['Firefox', 'firefox', 'Mozilla Firefox\\firefox.exe']
  ]
  return dirs.flatMap((dir) =>
    apps.map(([name, family, relative]) => ({ name, family, bin: join(dir, relative) }))
  )
}

function linuxCandidates(): Candidate[] {
  return [
    { name: 'Google Chrome', family: 'chromium', bin: 'google-chrome' },
    { name: 'Google Chrome', family: 'chromium', bin: 'google-chrome-stable' },
    { name: 'Chromium', family: 'chromium', bin: 'chromium' },
    { name: 'Chromium', family: 'chromium', bin: 'chromium-browser' },
    { name: 'Brave', family: 'chromium', bin: 'brave-browser' },
    { name: 'Microsoft Edge', family: 'edge', bin: 'microsoft-edge' },
    { name: 'Firefox', family: 'firefox', bin: 'firefox' }
  ]
}

function candidates(browserPath?: string): Candidate[] {
  const automatic = process.platform === 'darwin'
    ? macCandidates()
    : process.platform === 'win32'
      ? winCandidates()
      : linuxCandidates()
  const configured = configuredCandidate(browserPath)
  if (!configured) return automatic
  return [configured, ...automatic.filter((item) => item.bin !== configured.bin)]
}

/** Linux 下命令名需要先在 PATH 中解析，其它平台直接判断文件是否存在 */
function available(candidate: Candidate): boolean {
  if (process.platform === 'linux') {
    return spawnSync('which', [candidate.bin], { stdio: 'ignore' }).status === 0
  }
  return fs.existsSync(candidate.bin)
}

/**
 * 为无痕登录准备一个独立于用户主浏览器的数据目录。
 *
 * 关键点：Chromium 系浏览器已在运行时，直接带 --incognito 启动会被转发给
 * 主实例，而转发路径不尊重 --incognito，于是开出来的是普通窗口。指定一个
 * 独立的 user-data-dir 会强制拉起全新实例（拿到独立的单例锁），--incognito
 * 才真正生效，同时绝不会复用主 profile 里已登录的身份。
 */
function loginProfileDir(family: Family): string {
  const dir = join(app.getPath('userData'), 'login-browser', family)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

function privateArgs(candidate: Candidate): string[] {
  switch (candidate.family) {
    case 'edge':
      return ['--inprivate', `--user-data-dir=${loginProfileDir('edge')}`, '--no-first-run']
    case 'firefox':
      // Firefox 的 -private-window 通过 remote 交给已运行实例也能正确开隐私窗
      return ['-private-window']
    default:
      return [
        '--incognito',
        `--user-data-dir=${loginProfileDir('chromium')}`,
        '--no-first-run',
        '--no-default-browser-check'
      ]
  }
}

/**
 * 直接以参数数组启动浏览器可执行文件，不经过 shell，URL 不参与命令拼接。
 */
function launch(candidate: Candidate, url: string): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false
    const done = (value: boolean): void => {
      if (settled) return
      settled = true
      resolve(value)
    }
    try {
      const child = spawn(candidate.bin, [...privateArgs(candidate), url], {
        detached: true,
        stdio: 'ignore'
      })
      child.once('error', () => done(false))
      child.unref()
      // 独立实例会常驻，短暂等待没报错即视为成功
      setTimeout(() => done(true), 800)
    } catch {
      done(false)
    }
  })
}

/**
 * 打开外部链接。privateMode 为真时依次尝试本机已安装的浏览器的无痕窗口。
 * 普通私密模式全部不可用时回退系统默认浏览器；严格模式直接失败。
 */
export async function openUrl(
  url: string,
  input?: boolean | BrowserOpenOptions
): Promise<BrowserOpenInfo> {
  if (!isHttpUrl(url)) throw new Error('仅支持 http/https 链接')

  const options: BrowserOpenOptions =
    typeof input === 'boolean' ? { privateMode: input } : (input ?? {})

  // 严格模式本身就意味着必须走私密窗口。即使未来调用方误传 privateMode: false，
  // 也绝不能落到下面的 shell.openExternal 普通窗口分支。
  const wantsPrivate = options.privateMode || options.requirePrivate

  if (wantsPrivate) {
    for (const candidate of candidates(options.browserPath)) {
      if (!available(candidate)) continue
      if (await launch(candidate, url)) {
        console.log(`[Browser] opened in ${candidate.name} private window`)
        return { privateMode: true, browser: candidate.name }
      }
    }
    if (options.requirePrivate) {
      throw new Error(
        `${PRIVATE_BROWSER_REQUIRED}: 未找到可用的无痕浏览器，请选择 Chrome、Edge、Brave、Chromium 或 Firefox 的可执行文件`
      )
    }
    console.warn('[Browser] no private-capable browser found, falling back to default browser')
  }

  await shell.openExternal(url)
  return { privateMode: false }
}
