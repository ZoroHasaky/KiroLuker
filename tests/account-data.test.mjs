import test from 'node:test'
import assert from 'node:assert/strict'
import {
  ACCOUNT_STORE_VERSION,
  buildOidcImportItem,
  matchesAccountTagDateFilter,
  mergeAccountTags,
  migrateAccountStoreData,
  referencedAccountTags
} from '../src/shared/accountData.ts'

function account(overrides = {}) {
  return {
    id: 'account-1',
    email: 'user@example.com',
    password: 'secret',
    idp: 'BuilderId',
    credentials: {
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      clientId: 'client-id',
      clientSecret: 'client-secret',
      region: 'us-east-1',
      expiresAt: 123
    },
    subscription: { type: 'Free' },
    usage: { current: 0, limit: 0, percentUsed: 0, lastUpdated: 0 },
    status: 'active',
    isActive: false,
    tagIds: [],
    paymentLink: '',
    createdAt: 1_000,
    lastUsedAt: 1_000,
    ...overrides
  }
}

test('v1 账号数据幂等迁移到 v2，并保留原时间和凭证', () => {
  const legacyAccount = account()
  delete legacyAccount.tagIds
  delete legacyAccount.paymentLink
  const legacy = { version: 1, accounts: [legacyAccount], activeAccountId: 'account-1' }

  const first = migrateAccountStoreData(legacy)
  assert.equal(first.changed, true)
  assert.equal(first.data.version, ACCOUNT_STORE_VERSION)
  assert.deepEqual(first.data.tags, [])
  assert.deepEqual(first.data.accounts[0].tagIds, [])
  assert.equal(first.data.accounts[0].paymentLink, '')
  assert.equal(first.data.accounts[0].createdAt, 1_000)
  assert.equal(first.data.accounts[0].credentials.refreshToken, 'refresh-token')
  assert.equal('tagIds' in legacyAccount, false, '不得原地修改旧快照')

  const second = migrateAccountStoreData(first.data)
  assert.equal(second.changed, false)
  assert.deepEqual(second.data, first.data)
})

test('迁移会移除不存在于标签目录的悬空引用', () => {
  const data = {
    version: 2,
    tags: [{ id: 'valid', name: '有效', color: '#112233' }],
    accounts: [account({ tagIds: ['valid', 'missing'] })],
    activeAccountId: null
  }
  const migrated = migrateAccountStoreData(data)
  assert.equal(migrated.changed, true)
  assert.deepEqual(migrated.data.accounts[0].tagIds, ['valid'])
})

test('标签合并复用同名标签，并在 id 冲突时重映射', () => {
  const existing = [{ id: 'same-id', name: '工作', color: '#112233' }]
  const incoming = [
    { id: 'remote-work', name: ' 工作 ', color: '#112233' },
    { id: 'same-id', name: '个人', color: '#445566' },
    { id: 'remote-work-2', name: '工作', color: '#ffffff' }
  ]
  let nextId = 0
  const merged = mergeAccountTags(existing, incoming, () => `generated-${++nextId}`)

  assert.equal(merged.added, 1)
  assert.equal(merged.reused, 2)
  assert.equal(merged.colorConflicts, 1)
  assert.equal(merged.idMap.get('remote-work'), 'same-id')
  assert.equal(merged.idMap.get('same-id'), 'generated-1')
  assert.equal(merged.idMap.get('remote-work-2'), 'same-id')
  assert.deepEqual(merged.tags, [
    { id: 'same-id', name: '工作', color: '#112233' },
    { id: 'generated-1', name: '个人', color: '#445566' }
  ])
})

test('标签筛选为 OR，添加日期使用含下界、不含上界', () => {
  const target = account({ tagIds: ['a', 'b'], createdAt: 2_000 })
  assert.equal(matchesAccountTagDateFilter(target, { tagIds: ['x', 'b'] }), true)
  assert.equal(matchesAccountTagDateFilter(target, { tagIds: ['x'] }), false)
  assert.equal(matchesAccountTagDateFilter(target, { createdAtFrom: 2_000 }), true)
  assert.equal(matchesAccountTagDateFilter(target, { createdAtToExclusive: 2_000 }), false)
  assert.equal(
    matchesAccountTagDateFilter(target, { createdAtFrom: 1_000, createdAtToExclusive: 2_001 }),
    true
  )
})

test('完整导出标签只保留被目标账号引用的定义', () => {
  const tags = [
    { id: 'a', name: 'A', color: '#111111' },
    { id: 'b', name: 'B', color: '#222222' }
  ]
  assert.deepEqual(referencedAccountTags([account({ tagIds: ['b', 'missing'] })], tags), [tags[1]])
})

test('OIDC 精简项不含 accessToken 和 region，保留既有可选凭证规则', () => {
  assert.deepEqual(buildOidcImportItem(account()), {
    email: 'user@example.com',
    refreshToken: 'refresh-token',
    provider: 'BuilderId',
    password: 'secret',
    clientId: 'client-id',
    clientSecret: 'client-secret'
  })
})
