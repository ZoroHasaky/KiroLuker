import type { AppUpdateMode, UpdateReleaseAsset } from './types'

/** 去掉 Release tag 常见前缀。 */
export function normalizeAppVersion(raw: string): string {
  // 长前缀必须排在单字母 v 前面，否则 Version 会只被吃掉首字母。
  return (raw || '').trim().replace(/^(version|release|v)[-_\s]*/i, '')
}

/**
 * 语义化版本比较，返回 a-b 的符号。
 * 数字段逐位比较；数字段相同时，正式版本高于预发布版本。
 */
export function compareAppVersions(a: string, b: string): number {
  const split = (value: string): { nums: number[]; pre: string } => {
    const [core, ...rest] = normalizeAppVersion(value).split('-')
    return {
      nums: core.split('.').map((part) => Number.parseInt(part, 10) || 0),
      pre: rest.join('-')
    }
  }
  const left = split(a)
  const right = split(b)
  const length = Math.max(left.nums.length, right.nums.length)
  for (let index = 0; index < length; index++) {
    const diff = (left.nums[index] ?? 0) - (right.nums[index] ?? 0)
    if (diff !== 0) return diff > 0 ? 1 : -1
  }
  if (left.pre === right.pre) return 0
  if (!left.pre) return 1
  if (!right.pre) return -1
  return left.pre > right.pre ? 1 : -1
}

/** 当前正式发布只覆盖 Windows x64 和 Apple Silicon。 */
export function appUpdateMode(platform: string, arch: string): AppUpdateMode {
  if (platform === 'win32' && arch === 'x64') return 'windows-auto'
  if (platform === 'darwin' && arch === 'arm64') return 'mac-download'
  return 'manual'
}

export function expectedUpdateAssetName(
  version: string,
  mode: AppUpdateMode
): string | null {
  const normalized = normalizeAppVersion(version)
  if (!/^\d+\.\d+\.\d+(?:[-.][0-9A-Za-z.-]+)?$/.test(normalized)) return null
  if (mode === 'windows-auto') return `kiroluker-${normalized}-win-x64-setup.exe`
  if (mode === 'mac-download') return `kiroluker-${normalized}-mac-arm64.dmg`
  return null
}

/** 只接受 GitHub 返回的 SHA-256 摘要格式。 */
export function parseReleaseDigest(value: string | undefined): string | null {
  const match = /^sha256:([a-f0-9]{64})$/i.exec((value || '').trim())
  return match ? match[1].toLowerCase() : null
}

export function validUpdateAsset(
  asset: UpdateReleaseAsset | undefined,
  version: string,
  mode: AppUpdateMode
): asset is UpdateReleaseAsset {
  const expectedName = expectedUpdateAssetName(version, mode)
  return !!(
    asset
    && expectedName
    && asset.name === expectedName
    && /^https:\/\/github\.com\//i.test(asset.url)
    && Number.isSafeInteger(asset.size)
    && asset.size > 0
    && parseReleaseDigest(asset.digest)
  )
}
