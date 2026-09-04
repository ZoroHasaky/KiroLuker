import test from 'node:test'
import assert from 'node:assert/strict'
import {
  decodeAccountBackup,
  encodeEncryptedAccountBackup
} from '../src/shared/accountBackup.ts'

const data = {
  version: 2,
  accounts: [
    {
      id: 'account-1',
      email: 'user@example.com',
      password: 'password-sentinel',
      idp: 'BuilderId',
      credentials: {
        accessToken: 'access-token-sentinel',
        refreshToken: 'refresh-token-sentinel',
        clientSecret: 'client-secret-sentinel',
        region: 'us-east-1',
        expiresAt: 1
      },
      subscription: { type: 'Free' },
      usage: { current: 0, limit: 0, percentUsed: 0, lastUpdated: 0 },
      status: 'active',
      isActive: false,
      tagIds: [],
      paymentLink: '',
      createdAt: 1,
      lastUsedAt: 1
    }
  ],
  tags: [],
  activeAccountId: null
}

const encrypt = (plaintext) => Buffer.from(plaintext, 'utf8').toString('base64')
const decrypt = (ciphertext) => Buffer.from(ciphertext, 'base64').toString('utf8')

test('滚动备份只保存密文信封并可完整解密', () => {
  const encoded = encodeEncryptedAccountBackup(data, encrypt)
  assert.equal(encoded.includes('refresh-token-sentinel'), false)
  assert.equal(encoded.includes('client-secret-sentinel'), false)
  assert.equal(encoded.includes('password-sentinel'), false)
  assert.deepEqual(decodeAccountBackup(encoded, decrypt), { data, encrypted: true })
})

test('升级时仍可读取旧版明文备份', () => {
  assert.deepEqual(decodeAccountBackup(JSON.stringify(data), decrypt), {
    data,
    encrypted: false
  })
})
