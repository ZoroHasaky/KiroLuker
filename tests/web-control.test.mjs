import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { AccountApplicationService } from '../src/main/accountApplicationService.ts'
import { createPasswordRecord, createWebControlHttpApp } from '../src/main/webControlHttp.ts'
import { DEFAULT_WEB_CONTROL_AUTH } from '../src/shared/webControl.ts'

function account(overrides = {}) {
  return {
    id: 'account-1',
    email: 'one@example.com',
    nickname: 'One',
    idp: 'BuilderId',
    credentials: { accessToken: 'access-secret', refreshToken: 'refresh-secret', expiresAt: 9_999_999_999_999 },
    subscription: { type: 'Free' },
    usage: { current: 1, limit: 100, percentUsed: 1, lastUpdated: 1 },
    status: 'active',
    isActive: false,
    tagIds: [],
    paymentLink: 'https://sensitive.example',
    createdAt: 1,
    lastUsedAt: 1,
    ...overrides
  }
}

function data(accounts = [account()]) {
  return { version: 2, accounts, tags: [], activeAccountId: null }
}

function clone(value) { return structuredClone(value) }

function createService(initial = data()) {
  let stored = clone(initial)
  const service = new AccountApplicationService(
    { load: () => clone(stored), save: async (next) => { stored = clone(next) } },
    {
      verify: async (input) => ({ email: `${input.refreshToken}@example.com`, subscription: { type: 'Free' }, usage: { current: 0, limit: 100, percentUsed: 0, lastUpdated: Date.now() } }),
      refresh: async () => ({ accessToken: 'new-access', refreshToken: 'new-refresh', expiresIn: 3600, syncedToIde: false }),
      check: async () => ({ subscription: { type: 'Pro' }, usage: { current: 10, limit: 100, percentUsed: 10, lastUpdated: Date.now() } })
    }
  )
  return { service, stored: () => clone(stored) }
}

async function createFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kiroluker-web-control-'))
  const webDir = path.join(root, 'web')
  await fs.mkdir(path.join(root, 'assets'), { recursive: true })
  await fs.mkdir(webDir, { recursive: true })
  await fs.writeFile(path.join(webDir, 'index.html'), '<!doctype html><title>Web Panel</title>')
  await fs.writeFile(path.join(root, 'assets', 'web-test.js'), 'export const panel = true')
  const accountFixture = createService()
  let auth = clone(DEFAULT_WEB_CONTROL_AUTH)
  auth.password = await createPasswordRecord('administrator-password')
  const billing = {
    getConfig: () => ({ aiUrl: '', aiModel: '', reasoningEffort: '', hasAmapKey: false, hasBaiduKey: false, hasAiKey: false, secureStorage: true }),
    saveConfig: (value) => ({ aiUrl: value.aiUrl, aiModel: value.aiModel, reasoningEffort: value.reasoningEffort, hasAmapKey: false, hasBaiduKey: false, hasAiKey: false, secureStorage: true }),
    replaceSecrets: () => ({ aiUrl: '', aiModel: '', reasoningEffort: '', hasAmapKey: true, hasBaiduKey: false, hasAiKey: false, secureStorage: true }),
    clearSecrets: () => ({ aiUrl: '', aiModel: '', reasoningEffort: '', hasAmapKey: false, hasBaiduKey: false, hasAiKey: false, secureStorage: true }),
    generate: async () => ({ chineseName: '张三', pinyinName: 'ZHANG SAN', address: '测试地址', postalCode: '100000', mapSource: '高德地图', generatedAt: Date.now() })
  }
  const app = await createWebControlHttpApp({
    accountService: accountFixture.service,
    billingService: billing,
    authRepository: { load: () => clone(auth), save: (next) => { auth = clone(next) } },
    getSettings: () => ({ enabled: true, host: '127.0.0.1', port: 19840, publicUrl: '', trustedProxies: '' }),
    webDir
  })
  return { app, root, accountFixture }
}

async function login(app) {
  const response = await app.inject({ method: 'POST', url: '/api/v1/admin/login', payload: { password: 'administrator-password' } })
  assert.equal(response.statusCode, 200)
  const payload = response.json()
  return { cookie: response.headers['set-cookie'].split(';')[0], csrf: payload.data.csrfToken }
}

function adminHeaders(session, write = false) {
  return { host: 'localhost', cookie: session.cookie, ...(write ? { origin: 'http://localhost', 'x-csrf-token': session.csrf } : {}) }
}

test('HTTP API requires administrator authentication and never exposes stored account credentials', async () => {
  const { app, root } = await createFixture()
  try {
    const unauthenticated = await app.inject({ method: 'GET', url: '/api/v1/accounts' })
    assert.equal(unauthenticated.statusCode, 401)

    const session = await login(app)
    const accounts = await app.inject({ method: 'GET', url: '/api/v1/accounts', headers: adminHeaders(session) })
    assert.equal(accounts.statusCode, 200)
    const record = accounts.json().data.items[0]
    assert.equal(record.email, 'one@example.com')
    assert.equal('credentials' in record, false)
    assert.equal('paymentLink' in record, false)
    assert.equal('lastError' in record, false)
    assert.equal(JSON.stringify(record).includes('refresh-secret'), false)
    assert.equal(JSON.stringify(record).includes('upstream details'), false)

    const csrfRejected = await app.inject({ method: 'PATCH', url: '/api/v1/accounts/account-1', headers: adminHeaders(session), payload: { nickname: 'Two' } })
    assert.equal(csrfRejected.statusCode, 403)

    const patched = await app.inject({ method: 'PATCH', url: '/api/v1/accounts/account-1', headers: adminHeaders(session, true), payload: { nickname: 'Two', note: 'only-safe-fields' } })
    assert.equal(patched.statusCode, 200)
    assert.equal(patched.json().data.nickname, 'Two')
  } finally {
    await app.close()
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('API Key is shown once, is scope-limited, and becomes unusable after revocation', async () => {
  const { app, root } = await createFixture()
  try {
    const session = await login(app)
    const created = await app.inject({ method: 'POST', url: '/api/v1/admin/api-keys', headers: adminHeaders(session, true), payload: { name: 'reporter', scopes: ['accounts:read'] } })
    assert.equal(created.statusCode, 200)
    const token = created.json().data.apiKey
    assert.match(token, /^klr_/)

    const read = await app.inject({ method: 'GET', url: '/api/v1/accounts', headers: { authorization: `Bearer ${token}` } })
    assert.equal(read.statusCode, 200)
    const denied = await app.inject({ method: 'POST', url: '/api/v1/billing/generate', headers: { authorization: `Bearer ${token}` } })
    assert.equal(denied.statusCode, 403)

    const keyId = created.json().data.item.id
    const revoked = await app.inject({ method: 'DELETE', url: `/api/v1/admin/api-keys/${keyId}`, headers: adminHeaders(session, true) })
    assert.equal(revoked.statusCode, 200)
    const rejected = await app.inject({ method: 'GET', url: '/api/v1/accounts', headers: { authorization: `Bearer ${token}` } })
    assert.equal(rejected.statusCode, 401)
  } finally {
    await app.close()
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('desktop diff reconciliation preserves a remote edit rather than overwriting it with an old full snapshot', async () => {
  const { service, stored } = createService()
  const base = service.getData()
  await service.patchAccount('account-1', { note: 'changed-by-web' })
  const desktopNext = clone(base)
  desktopNext.accounts[0].nickname = 'changed-by-desktop'
  const merged = await service.reconcileDesktopSnapshot(base, desktopNext)
  assert.equal(merged.accounts[0].nickname, 'changed-by-desktop')
  assert.equal(merged.accounts[0].note, 'changed-by-web')
  assert.equal(stored().accounts[0].credentials.refreshToken, 'refresh-secret')
})

test('static panel route serves only files inside its Web output directory', async () => {
  const { app, root } = await createFixture()
  try {
    const panel = await app.inject({ method: 'GET', url: '/panel/' })
    assert.equal(panel.statusCode, 200)
    assert.match(panel.body, /Web Panel/)
    const traversal = await app.inject({ method: 'GET', url: '/panel/../../package.json' })
    assert.notEqual(traversal.statusCode, 200)
    const allowedAsset = await app.inject({ method: 'GET', url: '/assets/web-test.js' })
    assert.equal(allowedAsset.statusCode, 200)
    assert.match(allowedAsset.body, /panel = true/)
    const desktopAsset = await app.inject({ method: 'GET', url: '/assets/AccountsView-unsafe.js' })
    assert.equal(desktopAsset.statusCode, 404)
  } finally {
    await app.close()
    await fs.rm(root, { recursive: true, force: true })
  }
})
