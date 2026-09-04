import test from 'node:test'
import assert from 'node:assert/strict'
import { isKiroLogoutCacheFile } from '../src/shared/kiroCache.ts'

test('退出 Kiro 只删除自身 token，不触碰其它 AWS SSO 缓存', () => {
  assert.equal(isKiroLogoutCacheFile('kiro-auth-token.json'), true)
  assert.equal(isKiroLogoutCacheFile('1234567890abcdef.json'), false)
  assert.equal(isKiroLogoutCacheFile('botocore-client-id-us-east-1.json'), false)
  assert.equal(isKiroLogoutCacheFile('README'), false)
})
