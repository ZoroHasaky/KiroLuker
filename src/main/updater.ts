// 更新服务：GitHub Release 检查 + Windows 自动安装 + macOS 未签名包下载引导。
import { app, shell } from 'electron'
import { constants as fsConstants } from 'fs'
import { copyFile, mkdir, open, unlink } from 'fs/promises'
import { createHash } from 'crypto'
import { basename, join, parse } from 'path'
import { autoUpdater, CancellationToken } from 'electron-updater'
import { getEffectiveProxyUrl, httpRequest, httpStream } from './net'
import { sleep } from './utils'
import {
  appUpdateMode,
  compareAppVersions,
  expectedUpdateAssetName,
  normalizeAppVersion,
  parseReleaseDigest,
  validUpdateAsset
} from '../shared/appUpdate'
import type {
  AppUpdateState,
  UpdateCheckResult,
  UpdateReleaseAsset
} from '../shared/types'

const REPO = 'ZoroHasaky/KiroLuker'
const LATEST_API = `https://api.github.com/repos/${REPO}/releases/latest`
const LATEST_PAGE = `https://github.com/${REPO}/releases/latest`
const RELEASES_PAGE = `https://github.com/${REPO}/releases`
const RELEASE_TAG_API = (version: string): string =>
  `https://api.github.com/repos/${REPO}/releases/tags/${encodeURIComponent(`v${version}`)}`
const MODE = appUpdateMode(process.platform, process.arch)
const MAX_MANUAL_DOWNLOAD_BYTES = 1024 * 1024 * 1024

interface GithubReleaseAsset {
  name?: string
  browser_download_url?: string
  size?: number
  digest?: string
}

interface GithubRelease {
  tag_name?: string
  name?: string
  body?: string
  published_at?: string
  assets?: GithubReleaseAsset[]
}

class UpdateSourceError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    /** false 表示结果是确定性的，不应再尝试页面兜底。 */
    readonly allowFallback = true
  ) {
    super(message)
    this.name = 'UpdateSourceError'
  }
}

const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504])
const API_ATTEMPTS = 2
let inFlight: Promise<UpdateCheckResult> | null = null
let lastCheck: UpdateCheckResult | null = null

let stateListener: ((state: AppUpdateState) => void) | null = null
let beforeInstall: () => void = () => undefined
let initialized = false
let windowsCancellation: CancellationToken | null = null
let windowsDownloaded = false
let macAbortController: AbortController | null = null
let macDownloadedPath = ''

let updateState: AppUpdateState = {
  mode: MODE,
  status: 'idle',
  current: app.getVersion(),
  latest: '',
  percent: 0,
  transferred: 0,
  total: 0,
  bytesPerSecond: 0,
  message: ''
}

function snapshot(): AppUpdateState {
  return { ...updateState }
}

function publishState(patch: Partial<AppUpdateState>): AppUpdateState {
  updateState = { ...updateState, ...patch }
  const value = snapshot()
  stateListener?.(value)
  return value
}

function githubHeaders(current = app.getVersion()): Record<string, string> {
  return {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': `kiroluker/${current}`
  }
}

function releaseAsset(
  release: GithubRelease | undefined,
  version: string
): UpdateReleaseAsset | undefined {
  const expectedName = expectedUpdateAssetName(version, MODE)
  if (!expectedName) return undefined
  const raw = release?.assets?.find((asset) => asset.name === expectedName)
  if (!raw?.browser_download_url) return undefined
  const asset: UpdateReleaseAsset = {
    name: raw.name || '',
    url: raw.browser_download_url,
    size: Number(raw.size) || 0,
    digest: raw.digest || ''
  }
  return validUpdateAsset(asset, version, MODE) ? asset : undefined
}

function resultOf(
  current: string,
  latest: string,
  release?: GithubRelease
): UpdateCheckResult {
  return {
    current,
    latest,
    hasUpdate: compareAppVersions(latest, current) > 0,
    releaseUrl: RELEASES_PAGE,
    name: release?.name || release?.tag_name || latest,
    notes: (release?.body || '').trim(),
    publishedAt: release?.published_at || '',
    asset: releaseAsset(release, latest)
  }
}

function nestedErrorCode(error: unknown): string {
  let current = error
  const visited = new Set<unknown>()
  while (current && typeof current === 'object' && !visited.has(current)) {
    visited.add(current)
    const item = current as { code?: unknown; cause?: unknown }
    if (typeof item.code === 'string' && item.code) return item.code
    current = item.cause
  }
  return ''
}

function rawErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isRetryableTransport(error: unknown): boolean {
  const text = `${rawErrorMessage(error)} ${nestedErrorCode(error)}`
  return /fetch failed|abort|timeout|timed out|ECONN|ENOTFOUND|EAI_AGAIN|socket|network|TLS|UND_ERR/i.test(text)
}

function friendlyNetworkError(error: unknown): Error {
  const code = nestedErrorCode(error)
  const raw = rawErrorMessage(error)
  if (/abort|timeout|timed out|UND_ERR_CONNECT_TIMEOUT/i.test(`${raw} ${code}`)) {
    return new Error('连接 GitHub 超时，请检查网络或代理设置后重试')
  }
  if (isRetryableTransport(error)) {
    return new Error(`无法连接 GitHub，请检查网络或代理设置${code ? `（${code}）` : ''}`)
  }
  return new Error(raw || '检查更新失败，请稍后重试')
}

async function checkViaApi(current: string): Promise<UpdateCheckResult> {
  const res = await httpRequest(LATEST_API, {
    headers: githubHeaders(current),
    timeoutMs: 10_000
  })

  if (!res.ok) {
    if (res.status === 404) {
      throw new UpdateSourceError('仓库还没有发布任何版本', false, false)
    }
    if (res.status === 403) {
      throw new UpdateSourceError('GitHub 接口访问频率受限', false)
    }
    throw new UpdateSourceError(
      `GitHub 接口返回 ${res.status}`,
      RETRYABLE_STATUS.has(res.status)
    )
  }

  const release = await res.json<GithubRelease>()
  const latest = normalizeAppVersion(release.tag_name || '')
  if (!latest) throw new UpdateSourceError('未能解析 GitHub API 返回的版本号', false)
  return resultOf(current, latest, release)
}

/** API 不可用时，根据 Releases /latest 的最终重定向地址识别版本。 */
async function checkViaReleasePage(current: string): Promise<UpdateCheckResult> {
  const res = await httpRequest(LATEST_PAGE, {
    headers: {
      Accept: 'text/html',
      'User-Agent': `kiroluker/${current}`
    },
    timeoutMs: 12_000
  })
  if (!res.ok) {
    if (res.status === 404) throw new Error('仓库还没有发布任何版本')
    throw new Error(`GitHub Releases 页面返回 ${res.status}`)
  }

  let tag = ''
  try {
    const match = new URL(res.url).pathname.match(/\/releases\/tag\/([^/]+)/)
    tag = match ? decodeURIComponent(match[1]) : ''
  } catch {
    // URL 异常统一落到下面的可读错误。
  }
  const latest = normalizeAppVersion(tag)
  if (!latest) throw new Error('未能从 GitHub Releases 页面识别最新版本')
  return resultOf(current, latest, { tag_name: tag })
}

async function runCheck(): Promise<UpdateCheckResult> {
  const current = app.getVersion()
  let apiError: unknown

  for (let attempt = 1; attempt <= API_ATTEMPTS; attempt++) {
    try {
      return await checkViaApi(current)
    } catch (error) {
      apiError = error
      if (error instanceof UpdateSourceError && !error.allowFallback) throw error
      const retryable = error instanceof UpdateSourceError
        ? error.retryable
        : isRetryableTransport(error)
      console.warn(
        `[Updater] GitHub API 第 ${attempt}/${API_ATTEMPTS} 次失败：`
          + `${rawErrorMessage(error)}${nestedErrorCode(error) ? ` (${nestedErrorCode(error)})` : ''}`
      )
      if (!retryable || attempt === API_ATTEMPTS) break
      await sleep(600)
    }
  }

  try {
    console.warn('[Updater] 切换到 GitHub Releases 页面兜底检查')
    return await checkViaReleasePage(current)
  } catch (fallbackError) {
    console.warn(
      `[Updater] Releases 页面兜底失败：${rawErrorMessage(fallbackError)}`
        + `${nestedErrorCode(fallbackError) ? ` (${nestedErrorCode(fallbackError)})` : ''}`
    )
    if (isRetryableTransport(fallbackError)) throw friendlyNetworkError(fallbackError)
    if (fallbackError instanceof Error) throw fallbackError
    throw friendlyNetworkError(apiError)
  }
}

function recordCheck(result: UpdateCheckResult): UpdateCheckResult {
  lastCheck = result
  if (!['checking', 'downloading', 'downloaded', 'installing'].includes(updateState.status)) {
    publishState({
      status: result.hasUpdate ? 'available' : 'idle',
      current: result.current,
      latest: result.latest,
      percent: 0,
      transferred: 0,
      total: result.asset?.size ?? 0,
      bytesPerSecond: 0,
      message: result.hasUpdate ? `发现新版本 v${result.latest}` : '当前已是最新版本',
      downloadedFileName: undefined
    })
  }
  return result
}

/** 拉取 GitHub 最新 Release 并与当前版本比较；并发触发时共用同一个请求。 */
export function checkForUpdate(): Promise<UpdateCheckResult> {
  if (!inFlight) {
    inFlight = runCheck().then(recordCheck).finally(() => {
      inFlight = null
    })
  }
  return inFlight
}

/** electron-updater 使用 Electron Session，需要单独同步应用代理配置。 */
export async function configureUpdaterProxy(): Promise<void> {
  if (!app.isReady()) return
  try {
    const proxy = getEffectiveProxyUrl()
    await autoUpdater.netSession.setProxy(
      proxy ? { mode: 'fixed_servers', proxyRules: proxy } : { mode: 'system' }
    )
    console.log(`[Updater] download proxy ${proxy ? 'enabled' : 'system'}`)
  } catch (error) {
    console.warn(`[Updater] 更新下载代理配置失败：${rawErrorMessage(error)}`)
  }
}

/** 注册一次更新器事件，并把状态推送给渲染层。 */
export function initializeUpdater(
  onState: (state: AppUpdateState) => void,
  onBeforeInstall: () => void
): void {
  stateListener = onState
  beforeInstall = onBeforeInstall
  if (initialized) {
    stateListener(snapshot())
    return
  }
  initialized = true

  autoUpdater.logger = null
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = false
  autoUpdater.autoRunAppAfterInstall = true
  autoUpdater.allowPrerelease = false
  autoUpdater.setFeedURL({ provider: 'github', owner: 'ZoroHasaky', repo: 'KiroLuker' })

  autoUpdater.on('download-progress', (info) => {
    if (MODE !== 'windows-auto') return
    publishState({
      status: 'downloading',
      percent: Math.max(0, Math.min(100, info.percent || 0)),
      transferred: info.transferred || 0,
      total: info.total || 0,
      bytesPerSecond: info.bytesPerSecond || 0,
      message: '正在下载 Windows 更新包'
    })
  })

  autoUpdater.on('update-downloaded', (event) => {
    if (MODE !== 'windows-auto') return
    windowsDownloaded = true
    publishState({
      status: 'downloaded',
      percent: 100,
      transferred: updateState.total,
      bytesPerSecond: 0,
      message: '更新已下载，可以立即重启安装',
      downloadedFileName: basename(event.downloadedFile || '') || undefined
    })
  })

  autoUpdater.on('update-cancelled', () => {
    if (MODE !== 'windows-auto') return
    publishState({
      status: 'available',
      percent: 0,
      transferred: 0,
      bytesPerSecond: 0,
      message: '更新下载已取消'
    })
  })

  autoUpdater.on('error', (error) => {
    if (MODE !== 'windows-auto' || windowsCancellation?.cancelled) return
    if (!['checking', 'downloading'].includes(updateState.status)) return
    publishState({ status: 'error', message: friendlyNetworkError(error).message })
  })

  void configureUpdaterProxy()
  stateListener(snapshot())
}

export function getUpdateState(): AppUpdateState {
  return snapshot()
}

function cancelled(error: unknown, explicit: boolean): boolean {
  return explicit || /cancel|abort/i.test(`${rawErrorMessage(error)} ${nestedErrorCode(error)}`)
}

async function downloadWindowsUpdate(result: UpdateCheckResult): Promise<AppUpdateState> {
  publishState({
    status: 'checking',
    latest: result.latest,
    percent: 0,
    transferred: 0,
    total: result.asset?.size ?? 0,
    bytesPerSecond: 0,
    message: '正在准备 Windows 更新'
  })

  const check = await autoUpdater.checkForUpdates()
  const remoteVersion = normalizeAppVersion(check?.updateInfo.version || '')
  if (!check || compareAppVersions(remoteVersion, app.getVersion()) <= 0) {
    throw new Error('更新源没有返回可下载的新版本')
  }

  const token = new CancellationToken()
  windowsCancellation = token
  windowsDownloaded = false
  publishState({ status: 'downloading', latest: remoteVersion, message: '正在下载 Windows 更新包' })
  try {
    const paths = await autoUpdater.downloadUpdate(token)
    if (!windowsDownloaded) {
      windowsDownloaded = true
      publishState({
        status: 'downloaded',
        percent: 100,
        transferred: updateState.total,
        bytesPerSecond: 0,
        message: '更新已下载，可以立即重启安装',
        downloadedFileName: paths[0] ? basename(paths[0]) : undefined
      })
    }
    return snapshot()
  } catch (error) {
    if (cancelled(error, token.cancelled)) {
      return publishState({
        status: 'available',
        percent: 0,
        transferred: 0,
        bytesPerSecond: 0,
        message: '更新下载已取消'
      })
    }
    const message = friendlyNetworkError(error).message
    publishState({ status: 'error', message })
    throw new Error(message)
  } finally {
    if (windowsCancellation === token) windowsCancellation = null
  }
}

async function fetchReleaseAsset(version: string): Promise<UpdateReleaseAsset> {
  const res = await httpRequest(RELEASE_TAG_API(version), {
    headers: githubHeaders(),
    timeoutMs: 12_000
  })
  if (!res.ok) throw new Error(`GitHub Release 资源接口返回 ${res.status}`)
  const release = await res.json<GithubRelease>()
  const asset = releaseAsset(release, version)
  if (!asset) throw new Error('Release 中没有找到可校验的 macOS arm64 DMG')
  return asset
}

async function copyToDownloads(partPath: string, filename: string): Promise<string> {
  const downloads = app.getPath('downloads')
  await mkdir(downloads, { recursive: true })
  const parsed = parse(filename)
  for (let index = 0; index < 1000; index++) {
    const suffix = index === 0 ? '' : ` (${index})`
    const destination = join(downloads, `${parsed.name}${suffix}${parsed.ext}`)
    try {
      await copyFile(partPath, destination, fsConstants.COPYFILE_EXCL)
      await unlink(partPath).catch(() => undefined)
      return destination
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
  }
  throw new Error('下载目录中同名更新包过多，请清理后重试')
}

async function downloadMacUpdate(result: UpdateCheckResult): Promise<AppUpdateState> {
  publishState({
    status: 'checking',
    latest: result.latest,
    percent: 0,
    transferred: 0,
    total: result.asset?.size ?? 0,
    bytesPerSecond: 0,
    message: '正在获取 macOS 安装包信息'
  })

  const asset = validUpdateAsset(result.asset, result.latest, MODE)
    ? result.asset
    : await fetchReleaseAsset(result.latest)
  const expectedDigest = parseReleaseDigest(asset.digest)
  if (!expectedDigest) throw new Error('GitHub 没有提供有效的安装包摘要，已拒绝下载')
  if (asset.size > MAX_MANUAL_DOWNLOAD_BYTES) throw new Error('macOS 安装包大小异常，已拒绝下载')

  const controller = new AbortController()
  macAbortController = controller
  const tempDir = join(app.getPath('temp'), 'KiroLuker-updates')
  const partPath = join(tempDir, `${asset.name}.${process.pid}.part`)
  let file: Awaited<ReturnType<typeof open>> | null = null
  let completed = false

  try {
    await mkdir(tempDir, { recursive: true })
    await unlink(partPath).catch(() => undefined)
    const response = await httpStream(asset.url, {
      method: 'GET',
      headers: { 'User-Agent': `kiroluker/${app.getVersion()}` },
      signal: controller.signal,
      connectTimeoutMs: 20_000
    })
    if (!response.ok || !response.body) {
      throw new Error(`macOS 安装包下载返回 ${response.status}`)
    }

    const total = asset.size || response.contentLength
    file = await open(partPath, 'w')
    const hash = createHash('sha256')
    const reader = response.body.getReader()
    const startedAt = Date.now()
    let transferred = 0
    let lastPublishedAt = 0

    publishState({ status: 'downloading', total, message: '正在下载 macOS DMG 安装包' })
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value?.byteLength) continue
      transferred += value.byteLength
      if (transferred > MAX_MANUAL_DOWNLOAD_BYTES) {
        throw new Error('macOS 安装包下载大小超过安全限制')
      }
      hash.update(value)
      await file.write(value)

      const now = Date.now()
      if (now - lastPublishedAt >= 250 || transferred === total) {
        lastPublishedAt = now
        const seconds = Math.max(0.001, (now - startedAt) / 1000)
        publishState({
          status: 'downloading',
          transferred,
          total,
          percent: total > 0 ? Math.min(100, transferred / total * 100) : 0,
          bytesPerSecond: Math.round(transferred / seconds),
          message: '正在下载 macOS DMG 安装包'
        })
      }
    }
    await file.close()
    file = null

    if (asset.size && transferred !== asset.size) {
      throw new Error(`安装包大小校验失败：应为 ${asset.size} 字节，实际为 ${transferred} 字节`)
    }
    const actualDigest = hash.digest('hex').toLowerCase()
    if (actualDigest !== expectedDigest) throw new Error('安装包 SHA-256 校验失败，已拒绝打开')

    macDownloadedPath = await copyToDownloads(partPath, asset.name)
    completed = true
    publishState({
      status: 'downloaded',
      percent: 100,
      transferred,
      total,
      bytesPerSecond: 0,
      message: 'DMG 已下载并通过校验，正在打开安装包',
      downloadedFileName: basename(macDownloadedPath)
    })
    shell.showItemInFolder(macDownloadedPath)
    const openError = await shell.openPath(macDownloadedPath)
    if (openError) {
      publishState({ message: `DMG 已下载，但自动打开失败：${openError}` })
    } else {
      publishState({ message: 'DMG 已打开，请将 KiroLuker 拖入“应用程序”完成更新' })
    }
    return snapshot()
  } catch (error) {
    if (cancelled(error, controller.signal.aborted)) {
      return publishState({
        status: 'available',
        percent: 0,
        transferred: 0,
        bytesPerSecond: 0,
        message: '更新下载已取消'
      })
    }
    const message = friendlyNetworkError(error).message
    publishState({ status: 'error', message })
    throw new Error(message)
  } finally {
    await file?.close().catch(() => undefined)
    if (!completed) await unlink(partPath).catch(() => undefined)
    if (macAbortController === controller) macAbortController = null
  }
}

export async function downloadAvailableUpdate(): Promise<AppUpdateState> {
  if (['checking', 'downloading'].includes(updateState.status)) return snapshot()
  if (updateState.status === 'downloaded') return snapshot()
  if (!app.isPackaged) throw new Error('自动更新只能在正式安装版中使用')

  const result = lastCheck?.current === app.getVersion() ? lastCheck : await checkForUpdate()
  if (!result.hasUpdate) throw new Error('当前已是最新版本')

  try {
    if (MODE === 'windows-auto') return await downloadWindowsUpdate(result)
    if (MODE === 'mac-download') return await downloadMacUpdate(result)
    await shell.openExternal(result.releaseUrl)
    return publishState({ status: 'available', message: '当前平台请从 Releases 页面手动更新' })
  } catch (error) {
    const message = friendlyNetworkError(error).message
    if (updateState.status !== 'error') publishState({ status: 'error', message })
    throw new Error(message)
  }
}

export function cancelUpdateDownload(): AppUpdateState {
  windowsCancellation?.cancel()
  macAbortController?.abort()
  return publishState({
    status: 'available',
    percent: 0,
    transferred: 0,
    bytesPerSecond: 0,
    message: '正在取消更新下载'
  })
}

export function applyDownloadedUpdate(): AppUpdateState {
  if (MODE === 'windows-auto') {
    if (!windowsDownloaded || updateState.status !== 'downloaded') {
      throw new Error('更新包尚未下载完成')
    }
    publishState({ status: 'installing', message: '正在退出并安装更新' })
    setTimeout(() => {
      try {
        // electron-updater 会先关窗口、后发 before-quit；必须提前放行窗口 close。
        beforeInstall()
        autoUpdater.quitAndInstall(true, true)
      } catch (error) {
        publishState({ status: 'error', message: rawErrorMessage(error) })
      }
    }, 150)
    return snapshot()
  }

  if (MODE === 'mac-download') {
    if (!macDownloadedPath || updateState.status !== 'downloaded') {
      throw new Error('macOS 安装包尚未下载完成')
    }
    shell.showItemInFolder(macDownloadedPath)
    void shell.openPath(macDownloadedPath).then((error) => {
      if (error) publishState({ message: `自动打开失败：${error}` })
    })
    return snapshot()
  }

  void shell.openExternal(RELEASES_PAGE)
  return snapshot()
}
