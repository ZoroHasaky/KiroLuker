import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { AccountApplicationService } from '../src/main/accountApplicationService.ts'
import { createWebControlHttpApp } from '../src/main/webControlHttp.ts'
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
function data(accounts = [account()]) { return { version: 2, accounts, tags: [], activeAccountId: null } }
function clone(value) { return structuredClone(value) }
function hash(value) { return createHash('sha256').update(value).digest('base64url') }

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

async function createFixture(initial = data()) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kiroluker-api-'))
  const accountFixture = createService(initial)
  let auth = clone(DEFAULT_WEB_CONTROL_AUTH)
  const issue = (name, scopes) => {
    const token = `klr_test_${name}_${randomUUID()}`
    const item = { id: randomUUID(), name, prefix: token.slice(0, 14), hash: hash(token), scopes, createdAt: Date.now() }
    auth = { ...auth, apiKeys: [...auth.apiKeys, item] }
    return { token, item }
  }
  const revoke = (id) => { auth = { ...auth, apiKeys: auth.apiKeys.map((item) => item.id === id ? { ...item, revokedAt: Date.now() } : item) } }
  const billing = {
    getConfig: () => ({ aiUrl: '', aiModel: '', reasoningEffort: '', hasAmapKey: false, hasBaiduKey: false, hasAiKey: false, secureStorage: true }),
    saveConfig: (value) => ({ aiUrl: value.aiUrl, aiModel: value.aiModel, reasoningEffort: value.reasoningEffort, hasAmapKey: false, hasBaiduKey: false, hasAiKey: false, secureStorage: true }),
    replaceSecrets: () => ({ aiUrl: '', aiModel: '', reasoningEffort: '', hasAmapKey: true, hasBaiduKey: false, hasAiKey: false, secureStorage: true }),
    clearSecrets: () => ({ aiUrl: '', aiModel: '', reasoningEffort: '', hasAmapKey: false, hasBaiduKey: false, hasAiKey: false, secureStorage: true }),
    generate: async () => ({ chineseName: '张三', pinyinName: 'ZHANG SAN', address: '测试地址', postalCode: '100000', mapSource: '高德地图', generatedAt: Date.now() }),
    generateCheckout: async () => ({ chineseName: '张三', pinyinName: 'ZHANG SAN', countryCode: 'CN', province: '北京市', city: '北京市', district: '海淀区', pinyinCity: 'Beijing Shi', pinyinDistrict: 'Haidian Qu', addressLine1: 'Zhongguancun Da Jie 1 Hao', postalCode: '100080', mapSource: '高德地图', generatedAt: Date.now() })
  }
  const app = await createWebControlHttpApp({
    accountService: accountFixture.service,
    billingService: billing,
    authRepository: { load: () => clone(auth), save: (next) => { auth = clone(next) } },
    getSettings: () => ({ enabled: true, host: '127.0.0.1', port: 19840, publicUrl: '', trustedProxies: '' })
  })
  return { app, root, accountFixture, issue, revoke }
}
function bearer(token) { return { authorization: `Bearer ${token}` } }

async function closeFixture(fixture) { await fixture.app.close(); await fs.rm(fixture.root, { recursive: true, force: true }) }

test('independent API requires a scoped API Key and never exposes stored credentials or full payment links', async () => {
  const fixture = await createFixture()
  try {
    const unauthenticated = await fixture.app.inject({ method: 'GET', url: '/api/v1/accounts' })
    assert.equal(unauthenticated.statusCode, 401)
    const reader = fixture.issue('reader', ['accounts:read'])
    const accounts = await fixture.app.inject({ method: 'GET', url: '/api/v1/accounts', headers: bearer(reader.token) })
    assert.equal(accounts.statusCode, 200)
    const record = accounts.json().data.items[0]
    assert.equal(record.email, 'one@example.com')
    assert.equal(record.hasPaymentLink, true)
    assert.equal('credentials' in record, false)
    assert.equal('paymentLink' in record, false)

    const deniedWrite = await fixture.app.inject({ method: 'PATCH', url: '/api/v1/accounts/account-1', headers: bearer(reader.token), payload: { nickname: 'Two' } })
    assert.equal(deniedWrite.statusCode, 403)
    assert.equal(deniedWrite.json().error.code, 'INSUFFICIENT_SCOPE')

    const writer = fixture.issue('writer', ['accounts:read', 'accounts:write'])
    const patched = await fixture.app.inject({ method: 'PATCH', url: '/api/v1/accounts/account-1', headers: bearer(writer.token), payload: { nickname: 'Two', note: 'only-safe-fields' } })
    assert.equal(patched.statusCode, 200)
    assert.equal(patched.json().data.nickname, 'Two')
    assert.equal(patched.json().data.note, 'only-safe-fields')
  } finally { await closeFixture(fixture) }
})


test('accounts endpoint filters import date ranges and defines pending payment as Free with a payment link', async () => {
  const start = 1_725_840_000_000
  const end = start + 86_400_000
  const fixture = await createFixture(data([
    account({ id: 'pending-today', createdAt: start + 1, subscription: { type: 'Free' }, paymentLink: 'https://pending.example' }),
    account({ id: 'pro-today', createdAt: start + 2, subscription: { type: 'Pro' }, paymentLink: 'https://paid.example' }),
    account({ id: 'free-no-link-today', createdAt: start + 3, subscription: { type: 'Free' }, paymentLink: '' }),
    account({ id: 'pending-yesterday', createdAt: start - 1, subscription: { type: 'Free' }, paymentLink: 'https://old-pending.example' })
  ]))
  try {
    const key = fixture.issue('reader', ['accounts:read'])
    const headers = bearer(key.token)
    const pending = await fixture.app.inject({ method: 'GET', url: `/api/v1/accounts?createdAfter=${start}&createdBefore=${end}&paymentStatus=pending`, headers })
    assert.equal(pending.statusCode, 200)
    assert.deepEqual(pending.json().data.items.map((item) => item.id), ['pending-today'])
    assert.equal(pending.json().data.total, 1)

    const notPending = await fixture.app.inject({ method: 'GET', url: `/api/v1/accounts?createdAfter=${start}&createdBefore=${end}&paymentStatus=not_pending`, headers })
    assert.equal(notPending.statusCode, 200)
    assert.deepEqual(notPending.json().data.items.map((item) => item.id), ['pro-today', 'free-no-link-today'])

    const invalidRange = await fixture.app.inject({ method: 'GET', url: `/api/v1/accounts?createdAfter=${end}&createdBefore=${start}`, headers })
    assert.equal(invalidRange.statusCode, 400)
    assert.equal(invalidRange.json().error.code, 'INVALID_DATE_RANGE')
  } finally { await closeFixture(fixture) }
})

test('API Key revocation takes effect immediately and browser-admin routes are absent', async () => {
  const fixture = await createFixture()
  try {
    const key = fixture.issue('reporter', ['accounts:read'])
    assert.equal((await fixture.app.inject({ method: 'GET', url: '/api/v1/accounts', headers: bearer(key.token) })).statusCode, 200)
    fixture.revoke(key.item.id)
    const revoked = await fixture.app.inject({ method: 'GET', url: '/api/v1/accounts', headers: bearer(key.token) })
    assert.equal(revoked.statusCode, 401)
    assert.equal((await fixture.app.inject({ method: 'POST', url: '/api/v1/admin/login', payload: { password: 'legacy' } })).statusCode, 404)
    assert.equal((await fixture.app.inject({ method: 'GET', url: '/panel/' })).statusCode, 404)
    assert.equal((await fixture.app.inject({ method: 'GET', url: '/assets/web-test.js' })).statusCode, 404)
  } finally { await closeFixture(fixture) }
})

test('desktop diff reconciliation preserves a remote API tag edit rather than overwriting it with an old snapshot', async () => {
  const fixture = await createFixture()
  try {
    const writer = fixture.issue('writer', ['accounts:read', 'accounts:write'])
    const base = fixture.accountFixture.stored()
    const patched = await fixture.app.inject({ method: 'PATCH', url: '/api/v1/accounts/account-1', headers: bearer(writer.token), payload: { note: 'changed-by-api' } })
    assert.equal(patched.statusCode, 200)
    const desktopNext = clone(base)
    desktopNext.accounts[0].nickname = 'changed-by-desktop'
    const merged = await fixture.accountFixture.service.reconcileDesktopSnapshot(base, desktopNext)
    assert.equal(merged.accounts[0].nickname, 'changed-by-desktop')
    assert.equal(merged.accounts[0].note, 'changed-by-api')
    assert.equal(fixture.accountFixture.stored().accounts[0].credentials.refreshToken, 'refresh-secret')
  } finally { await closeFixture(fixture) }
})

test('mobile capability, OIDC export, payment link and checkout billing endpoints are scoped and never cache sensitive data', async () => {
  const fixture = await createFixture()
  try {
    const mobile = fixture.issue('mobile', ['accounts:read', 'accounts:write', 'accounts:export', 'accounts:payment', 'billing:generate'])
    const auth = bearer(mobile.token)
    const capabilities = await fixture.app.inject({ method: 'GET', url: '/api/v1/capabilities', headers: auth })
    assert.equal(capabilities.statusCode, 200)
    assert.deepEqual(capabilities.json().data.features, { accountExport: true, paymentLinks: true, checkoutBilling: true })

    const oidc = await fixture.app.inject({ method: 'GET', url: '/api/v1/accounts/account-1/oidc', headers: auth })
    assert.equal(oidc.statusCode, 200)
    assert.equal(oidc.headers['cache-control'], 'no-store')
    assert.equal(oidc.json().data.content, '[\n  {\n    "email": "one@example.com",\n    "refreshToken": "refresh-secret",\n    "provider": "BuilderId"\n  }\n]')

    const payment = await fixture.app.inject({ method: 'GET', url: '/api/v1/accounts/account-1/payment-link', headers: auth })
    assert.equal(payment.statusCode, 200)
    assert.equal(payment.headers['cache-control'], 'no-store')
    assert.deepEqual(payment.json().data, { configured: true, url: 'https://sensitive.example' })

    const billing = await fixture.app.inject({ method: 'POST', url: '/api/v1/billing/checkout/generate', headers: auth })
    assert.equal(billing.statusCode, 200)
    assert.equal(billing.headers['cache-control'], 'no-store')
    assert.equal(billing.json().data.countryCode, 'CN')
    assert.equal(billing.json().data.postalCode, '100080')

    const readonly = fixture.issue('readonly', ['accounts:read'])
    const denied = await fixture.app.inject({ method: 'GET', url: '/api/v1/accounts/account-1/oidc', headers: bearer(readonly.token) })
    assert.equal(denied.statusCode, 403)
    assert.equal(denied.json().error.code, 'INSUFFICIENT_SCOPE')
  } finally { await closeFixture(fixture) }
})
