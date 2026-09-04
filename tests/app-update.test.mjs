import test from 'node:test'
import assert from 'node:assert/strict'
import {
  appUpdateMode,
  compareAppVersions,
  expectedUpdateAssetName,
  normalizeAppVersion,
  parseReleaseDigest,
  validUpdateAsset
} from '../src/shared/appUpdate.ts'

test('版本前缀归一化和正式版比较', () => {
  assert.equal(normalizeAppVersion('release-1.2.3'), '1.2.3')
  assert.equal(normalizeAppVersion('Version 1.2.3'), '1.2.3')
  assert.equal(compareAppVersions('1.10.0', '1.9.9'), 1)
  assert.equal(compareAppVersions('1.2.0', '1.2.0-beta.1'), 1)
  assert.equal(compareAppVersions('v1.2.0', '1.2'), 0)
})

test('自动更新只启用发布范围内的平台架构', () => {
  assert.equal(appUpdateMode('win32', 'x64'), 'windows-auto')
  assert.equal(appUpdateMode('darwin', 'arm64'), 'mac-download')
  assert.equal(appUpdateMode('win32', 'arm64'), 'manual')
  assert.equal(appUpdateMode('darwin', 'x64'), 'manual')
  assert.equal(appUpdateMode('linux', 'x64'), 'manual')
})

test('平台安装包名称固定且版本字段不能注入路径', () => {
  assert.equal(
    expectedUpdateAssetName('v1.2.3', 'windows-auto'),
    'kiroluker-1.2.3-win-x64-setup.exe'
  )
  assert.equal(
    expectedUpdateAssetName('1.2.3', 'mac-download'),
    'kiroluker-1.2.3-mac-arm64.dmg'
  )
  assert.equal(expectedUpdateAssetName('../1.2.3', 'mac-download'), null)
})

test('Release 资源必须匹配文件名、GitHub HTTPS 地址和 SHA-256', () => {
  const digest = `sha256:${'ab'.repeat(32)}`
  const asset = {
    name: 'kiroluker-1.2.3-mac-arm64.dmg',
    url: 'https://github.com/ZoroHasaky/KiroLuker/releases/download/v1.2.3/file.dmg',
    size: 100,
    digest
  }
  assert.equal(parseReleaseDigest(digest), 'ab'.repeat(32))
  assert.equal(validUpdateAsset(asset, '1.2.3', 'mac-download'), true)
  assert.equal(validUpdateAsset({ ...asset, url: 'http://github.com/file' }, '1.2.3', 'mac-download'), false)
  assert.equal(validUpdateAsset({ ...asset, digest: 'sha256:1234' }, '1.2.3', 'mac-download'), false)
  assert.equal(validUpdateAsset({ ...asset, name: 'other.dmg' }, '1.2.3', 'mac-download'), false)
})
