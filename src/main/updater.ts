// 检查更新：只读 GitHub Releases 的最新版本号做对比，不做自动下载安装
import { app } from 'electron'
import { httpRequest } from './net'
import type { UpdateCheckResult } from '../shared/types'

const REPO = 'lucks-cloud/kiro-manager-lite'
const LATEST_API = `https://api.github.com/repos/${REPO}/releases/latest`
/** 「前往更新」统一落到 Releases 列表页，方便用户自己挑平台安装包与历史版本 */
const RELEASES_PAGE = `https://github.com/${REPO}/releases`

interface GithubRelease {
  tag_name?: string
  name?: string
  body?: string
  published_at?: string
}

/** 去掉 tag 常见前缀，`v1.0.3` / `V1.0.3` / `release-1.0.3` 都归一成 `1.0.3` */
function normalizeVersion(raw: string): string {
  return (raw || '').trim().replace(/^(v|version|release)[-_\s]*/i, '')
}

/**
 * 语义化版本比较，返回 a-b 的符号。
 * 数字段逐位比较；带 -beta 之类预发布标记的一方在数字段相同时视为更旧。
 */
export function compareVersions(a: string, b: string): number {
  const split = (v: string): { nums: number[]; pre: string } => {
    const [core, ...rest] = normalizeVersion(v).split('-')
    return {
      nums: core.split('.').map((n) => Number.parseInt(n, 10) || 0),
      pre: rest.join('-')
    }
  }
  const left = split(a)
  const right = split(b)
  const len = Math.max(left.nums.length, right.nums.length)
  for (let i = 0; i < len; i++) {
    const diff = (left.nums[i] ?? 0) - (right.nums[i] ?? 0)
    if (diff !== 0) return diff > 0 ? 1 : -1
  }
  if (left.pre === right.pre) return 0
  if (!left.pre) return 1
  if (!right.pre) return -1
  return left.pre > right.pre ? 1 : -1
}

/**
 * 拉取 GitHub 最新 Release 并与当前版本比较。
 * 失败时抛出可读错误，由 IPC 层收敛成 { success: false, error }。
 */
export async function checkForUpdate(): Promise<UpdateCheckResult> {
  const current = app.getVersion()

  const res = await httpRequest(LATEST_API, {
    headers: {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      // GitHub API 拒绝没有 UA 的请求
      'User-Agent': `kiro-manager-lite/${current}`
    },
    timeoutMs: 15_000
  })

  if (!res.ok) {
    if (res.status === 404) throw new Error('仓库还没有发布任何版本')
    if (res.status === 403) throw new Error('GitHub 接口访问频率受限，请稍后再试')
    throw new Error(`GitHub 接口返回 ${res.status}`)
  }

  const release = await res.json<GithubRelease>()
  const latest = normalizeVersion(release.tag_name || '')
  if (!latest) throw new Error('未能解析远端版本号')

  return {
    current,
    latest,
    hasUpdate: compareVersions(latest, current) > 0,
    releaseUrl: RELEASES_PAGE,
    name: release.name || release.tag_name || latest,
    notes: (release.body || '').trim(),
    publishedAt: release.published_at || ''
  }
}
