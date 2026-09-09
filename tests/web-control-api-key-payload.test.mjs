import assert from 'node:assert/strict'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import test from 'node:test'
import {
  ensureDefaultMobileApiKey,
  getCurrentMobileApiKey,
  readMobileApiKey,
  regenerateMobileApiKey
} from '../src/main/webControlApiKey.ts'
import { WEB_API_SCOPES } from '../src/shared/webControl.ts'

function createProtector() {
  const key = randomBytes(32)
  return {
    encrypt(value) {
      const iv = randomBytes(12)
      const cipher = createCipheriv('aes-256-gcm', key, iv)
      const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
      return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64')
    },
    decrypt(value) {
      const payload = Buffer.from(value, 'base64')
      const decipher = createDecipheriv('aes-256-gcm', key, payload.subarray(0, 12))
      decipher.setAuthTag(payload.subarray(12, 28))
      return Buffer.concat([decipher.update(payload.subarray(28)), decipher.final()]).toString('utf8')
    }
  }
}

function activeKeys(auth) {
  return auth.apiKeys.filter((item) => !item.revokedAt)
}

test('service startup creates exactly one encrypted all-scope mobile key and public metadata never contains its plaintext', () => {
  const protector = createProtector()
  const first = ensureDefaultMobileApiKey({ version: 1, apiKeys: [] }, protector)

  assert.equal(first.changed, true)
  assert.equal(first.auth.version, 2)
  assert.equal(activeKeys(first.auth).length, 1)
  assert.deepEqual(first.item.scopes, WEB_API_SCOPES)
  assert.match(first.item.encryptedToken, /^[A-Za-z0-9+/=]+$/)

  const token = readMobileApiKey(first.auth, protector)
  assert.match(token, /^klr_/)
  assert.doesNotMatch(JSON.stringify(first.auth), new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))

  const publicKey = getCurrentMobileApiKey(first.auth, protector)
  assert.ok(publicKey)
  assert.equal('hash' in publicKey, false)
  assert.equal('encryptedToken' in publicKey, false)
  assert.doesNotMatch(JSON.stringify(publicKey), new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))

  const repeated = ensureDefaultMobileApiKey(first.auth, protector)
  assert.equal(repeated.changed, false)
  assert.equal(readMobileApiKey(repeated.auth, protector), token)
})

test('legacy or malformed stored keys are revoked and replaced by one secure default mobile key', () => {
  const protector = createProtector()
  const legacy = {
    version: 1,
    apiKeys: [{
      id: 'legacy-id', name: '旧手机', prefix: 'klr_legacy', hash: 'legacy-hash',
      scopes: ['accounts:read'], createdAt: 1
    }]
  }

  const migrated = ensureDefaultMobileApiKey(legacy, protector)
  assert.equal(activeKeys(migrated.auth).length, 1)
  assert.equal(migrated.auth.apiKeys.find((item) => item.id === 'legacy-id')?.revokedAt !== undefined, true)
  assert.deepEqual(activeKeys(migrated.auth)[0].scopes, WEB_API_SCOPES)
  assert.match(readMobileApiKey(migrated.auth, protector), /^klr_/)
})

test('regenerating replaces the current key immediately while preserving only encrypted desktop-copy material', () => {
  const protector = createProtector()
  const initial = ensureDefaultMobileApiKey({ version: 2, apiKeys: [] }, protector)
  const oldToken = readMobileApiKey(initial.auth, protector)

  const regenerated = regenerateMobileApiKey(initial.auth, protector)
  const current = readMobileApiKey(regenerated.auth, protector)
  assert.notEqual(current, oldToken)
  assert.equal(activeKeys(regenerated.auth).length, 1)
  assert.equal(regenerated.auth.apiKeys.find((item) => item.id === initial.item.id)?.revokedAt !== undefined, true)
  assert.deepEqual(regenerated.item.scopes, WEB_API_SCOPES)
  assert.doesNotMatch(JSON.stringify(regenerated.auth), new RegExp(current.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
})