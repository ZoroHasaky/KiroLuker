import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { createPinia, setActivePinia } from 'pinia'
import { createServer } from 'vite'

function account(overrides = {}) {
  return {
    id: 'account-id',
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

test('完整备份导入重映射标签和账号 ID，并保持凭证格式隔离', async () => {
  const root = process.cwd()
  const server = await createServer({
    root,
    configFile: false,
    appType: 'custom',
    server: { middlewareMode: true },
    optimizeDeps: { noDiscovery: true, include: [] },
    resolve: {
      alias: {
        '@': path.join(root, 'src/renderer/src'),
        '@shared': path.join(root, 'src/shared')
      }
    }
  })

  try {
    const saved = []
    globalThis.window = {
      api: {
        saveAccounts: async (data) => {
          saved.push(data)
          return { success: true }
        }
      }
    }

    const [{ useAccountsStore }, transfer] = await Promise.all([
      server.ssrLoadModule('/src/renderer/src/stores/accounts.ts'),
      server.ssrLoadModule('/src/renderer/src/utils/transfer.ts')
    ])
    setActivePinia(createPinia())
    const store = useAccountsStore()
    store.tags.push({ id: 'shared-id', name: '工作', color: '#112233' })
    store.accounts.push(account({ id: 'shared-account-id', email: 'existing@example.com' }))

    // 改名前的完整备份标识必须继续可导入。
    const result = store.importFullData({
      app: 'kiro-account-lite',
      version: '1.0.19',
      exportedAt: 999,
      tags: [
        { id: 'remote-work', name: ' 工作 ', color: '#112233' },
        { id: 'shared-id', name: '个人', color: '#445566' }
      ],
      accounts: [
        account({
          id: 'shared-account-id',
          email: 'first@example.com',
          isActive: undefined,
          tagIds: ['remote-work', 'shared-id'],
          paymentLink: 'https://pay.example/first',
          createdAt: 123_456
        }),
        account({
          id: 'shared-account-id',
          email: 'second@example.com',
          isActive: undefined,
          createdAt: 234_567
        })
      ]
    })

    assert.equal(result.success, 2)
    const first = store.accounts.find((item) => item.email === 'first@example.com')
    const second = store.accounts.find((item) => item.email === 'second@example.com')
    assert.ok(first)
    assert.ok(second)
    assert.notEqual(first.id, 'shared-account-id')
    assert.notEqual(second.id, 'shared-account-id')
    assert.notEqual(first.id, second.id)
    assert.equal(first.createdAt, 123_456)
    assert.equal(second.createdAt, 234_567)
    assert.equal(first.paymentLink, 'https://pay.example/first')

    const workTags = store.tags.filter((tag) => tag.name === '工作')
    const personal = store.tags.find((tag) => tag.name === '个人')
    assert.equal(workTags.length, 1, '同名同色标签应复用本地标签')
    assert.ok(personal)
    assert.notEqual(personal.id, 'shared-id', '冲突的标签 id 应重新生成')
    assert.deepEqual(new Set(first.tagIds), new Set(['shared-id', personal.id]))

    const full = JSON.parse(
      transfer.buildExportContent('json', [first], {
        includeCredentials: true,
        appVersion: 'test',
        tags: store.tags
      })
    )
    assert.equal(full.app, 'kiroluker', '新完整备份应使用改名后的应用标识')
    assert.deepEqual(
      new Set(full.tags.map((tag) => tag.id)),
      new Set(first.tagIds),
      '完整备份必须携带目标账号引用的标签目录'
    )

    const oidc = JSON.parse(transfer.buildOidcExportContent([first]))[0]
    assert.deepEqual(oidc, {
      email: 'first@example.com',
      refreshToken: 'refresh-token',
      provider: 'BuilderId',
      password: 'secret',
      clientId: 'client-id',
      clientSecret: 'client-secret'
    })
    assert.equal('paymentLink' in oidc, false)
    assert.equal('tagIds' in oidc, false)
    assert.equal('accessToken' in oidc, false)
    assert.equal('region' in oidc, false)
    for (const format of ['kami', 'csv', 'txt', 'clipboard']) {
      const content = transfer.buildExportContent(format, [first], {
        includeCredentials: true,
        appVersion: 'test',
        tags: store.tags
      })
      assert.equal(content.includes(first.paymentLink), false, `${format} 不得包含支付链接`)
    }
    assert.equal(saved.length, 1, '导入应一次性持久化')
  } finally {
    await server.close()
    delete globalThis.window
  }
})
