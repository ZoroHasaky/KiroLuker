import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs/promises'
import vm from 'node:vm'
import { randomUUID } from 'node:crypto'
import ts from 'typescript'
import { encode, decode } from 'cbor-x'

const KIRO = 'https://app.kiro.dev'
const STRIPE = 'https://billing.stripe.com'
const MANAGEMENT = '/service/KiroWebPortalService/operation/GenerateSubscriptionManagementUrl'
const MANAGEMENT_URL = `${STRIPE}/p/session/fixture-secret?token=fixture-query-secret`
// Auth module constants are dependencies, not live account/profile lookups.
const BUILDER_ARN = 'arn:fixture:builder-profile'
const SOCIAL_ARN = 'arn:fixture:social-profile'
const sources = new Map(await Promise.all([
  ['locale', '../src/shared/portalLocale.ts'],
  ['batch', '../src/shared/subscriptionBatch.ts'],
  ['helper', '../src/main/kiroPortalSession.ts'],
  ['context', '../src/main/subscriptionPortalContext.ts']
].map(async ([name, file]) => {
  const source = await fs.readFile(new URL(file, import.meta.url), 'utf8')
  return [name, ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText]
})))

function loadModule(name, imports, logs) {
  const exports = {}
  vm.runInNewContext(sources.get(name), {
    exports, Buffer, URL, Headers, AbortController, TextDecoder, setTimeout, clearTimeout,
    process: { versions: {}, platform: 'win32' },
    console: Object.fromEntries(['debug', 'info', 'warn', 'error'].map(level => [level, (...args) => {
      logs.push(`${level}: ${args.join(' ')}`)
    }])),
    require(id) {
      assert.ok(Object.hasOwn(imports, id), `Unexpected real dependency: ${id}`)
      return imports[id]
    }
  }, { filename: `${name}.ts` })
  return exports
}

function account(idp = 'BuilderId', overrides = {}) {
  const { credentials, ...rest } = overrides
  return {
    id: `fixture-${idp}`, email: 'fixture@example.invalid', userId: 'fixture-user', idp,
    profileArn: `arn:fixture:stored-${idp}`,
    credentials: {
      accessToken: `fake-access-${idp}`, refreshToken: `fake-refresh-${idp}`,
      region: 'us-east-1', expiresAt: 0, ...credentials
    },
    ...rest
  }
}
function metadata(overrides = {}) {
  return Object.entries({
    'user-status': 'active', 'user-id': 'fixture-user', idp: 'BuilderId', 'csrf-token': 'fake-csrf',
    ...overrides
  }).filter(([, value]) => value !== undefined)
    .map(([name, value]) => `<meta name="${name}" content="${value}">`).join('')
}

class FakeSession {
  cookieJar = new Map()
  events = []
  fetches = []
  headersReceived = 0
  userAgentCalls = []
  webRequest = { onBeforeSendHeaders: listener => { this.headerListener = listener } }
  setUserAgent(ua, language) { this.userAgentCalls.push([ua, language, this.events.length]); this.userAgent = ua }
  getUserAgent() { return this.userAgent }
  cookies = { set: async cookie => {
    this.events.push(['cookie', cookie.name])
    this.cookieJar.set(`${cookie.domain}/${cookie.name}`, structuredClone(cookie))
  } }
  constructor(partition, origin) { this.partition = partition; this.origin = origin }
  async setProxy(value) { this.events.push(['proxy', structuredClone(value)]) }
  async clearStorageData(options) {
    this.events.push(['storage', structuredClone(options)])
    this.cookieJar.clear()
  }
  async clearCache() { this.events.push(['cache']) }
  async closeAllConnections() { this.events.push(['connections']) }
  async fetch(url, init) {
    const parsed = new URL(url)
    assert.ok([KIRO, STRIPE, 'https://kiro.dev'].includes(parsed.origin))
    assert.equal(init.redirect, 'manual')
    assert.equal(init.credentials, 'include')
    let headers = new Headers(init.headers)
    if (this.headerListener) {
      this.headerListener({ requestHeaders: Object.fromEntries(headers) }, result => { headers = new Headers(result.requestHeaders) })
    }
    // Chromium owns domain-scoped cookies. The request layer must not assemble a Cookie header.
    assert.equal(headers.has('cookie'), false)
    const cookie = [...this.cookieJar.values()]
      .filter(item => item.domain === parsed.hostname)
      .map(item => `${item.name}=${item.value}`).join('; ')
    if (cookie) headers.set('cookie', cookie)
    this.fetches.push({ url, method: init.method, headers: Object.fromEntries(headers), signal: init.signal })
    // Never fetch the public URL: all traffic is rewritten to our loopback HTTP server.
    const response = await fetch(`${this.origin}${parsed.pathname}${parsed.search}`, { ...init, headers })
    this.headersReceived++
    return response
  }
}

function harness(origin) {
  const logs = []
  const sessions = []
  const defaults = []
  const lookups = []
  const locale = loadModule('locale', {}, logs)
  const helper = loadModule('helper', {
    '../shared/portalLocale': locale,
    './kiroApi': { listAvailableProfiles: async (...args) => { lookups.push(args); return ['arn:fixture:resolved'] } }
  }, logs)
  const createSession = partition => {
    const ses = new FakeSession(partition, origin)
    sessions.push(ses)
    return ses
  }
  const api = loadModule('context', {
    crypto: { randomUUID }, 'cbor-x': { encode, decode },
    electron: { session: {
      get defaultSession() { throw new Error('Default/visible session must never be accessed') },
      fromPartition(partition, options) { defaults.push([partition, structuredClone(options)]); return createSession(partition) }
    } },
    './kiroPortalSession': helper,
    './net': { getConfiguredProxyUrl: () => '' },
    './kiroAuth': { KIRO_BUILDER_ID_PLACEHOLDER_ARN: BUILDER_ARN, KIRO_SOCIAL_PROFILE_ARN: SOCIAL_ARN }
  }, logs)
  return {
    api, helper, sessions, defaults, logs, lookups, createSession,
    auth: loadModule('batch', {}, logs),
    create: (user = account(), overrides = {}) => api.createSubscriptionPortalContext(user, {
      createSession, proxyUrl: () => '', timeoutMs: 2000, ...overrides
    })
  }
}

async function fixture(options, run) {
  const calls = []
  const handlerErrors = []
  const contexts = []
  const server = http.createServer(async (request, response) => {
    try {
      const chunks = []
      for await (const chunk of request) chunks.push(chunk)
      const call = { method: request.method, path: request.url, headers: request.headers, body: Buffer.concat(chunks) }
      calls.push(call)
      if (options.handle && await options.handle(call, response)) return
      if (request.url === '/') {
        response.setHeader('Content-Type', 'text/html')
        response.end(options.html ?? metadata())
      } else if (request.url.startsWith('/service/KiroWebPortalService/operation/')) {
        response.setHeader('Content-Type', 'application/cbor')
        response.end(encode(request.url === MANAGEMENT
          ? { encodedVerificationUrl: MANAGEMENT_URL }
          : { operation: request.url.split('/').at(-1), ok: true }))
      } else {
        response.setHeader('Content-Type', 'application/json')
        response.end('{"ok":true}')
      }
    } catch (error) {
      handlerErrors.push(error)
      response.destroy()
    }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const h = harness(`http://127.0.0.1:${server.address().port}`)
  const create = h.create
  h.create = async (...args) => { const context = await create(...args); contexts.push(context); return context }
  try {
    await run(h, calls)
    assert.deepEqual(handlerErrors, [])
  } finally {
    for (const context of contexts) await context.close()
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
  }
}
function cookieValues(ses) {
  return Object.fromEntries([...ses.cookieJar.values()].map(({ name, value }) => [name, value]))
}
function assertSafeLogs(logs, secrets) {
  const output = logs.join('\n')
  for (const secret of secrets) assert.equal(output.includes(secret), false, 'A fixture secret appeared in logs')
}

test('parsePortalMetadata handles attribute order, quoted values, HTML entities and ignores non-public fields', () => {
  const { api } = harness('http://127.0.0.1:1')
  const parsed = api.parsePortalMetadata(`
    <META CONTENT='active' NAME='user-status'>
    <meta content="token&amp;&quot;&#39;&#x2f;" data-extra="ignored" name="csrf-token">
    <meta name="idp" content="ExternalOIDC"><meta name="profile-arn" content="arn:fixture:a&amp;b">
    <meta name="user-id" content="fixture-user"><meta name="access-token" content="must-ignore">
    <meta name=csrf-token content=unquoted><meta name="unknown" content="ignored">`)
  assert.deepEqual(structuredClone(parsed), {
    'user-status': 'active', 'csrf-token': `token&"'/`, idp: 'ExternalOIDC',
    'profile-arn': 'arn:fixture:a&b', 'user-id': 'fixture-user'
  })
})

test('management URL validation accepts only exact HTTPS official origins without credentials', () => {
  const { api } = harness('http://127.0.0.1:1')
  for (const url of [KIRO, 'https://kiro.dev/account', `${STRIPE}/p/session/fixture?x=1`]) {
    assert.equal(api.validateManagementUrl(url).href, new URL(url).href)
  }
  for (const url of [
    'not-a-url', '//billing.stripe.com/path', 'http://billing.stripe.com/path',
    'https://billing.stripe.com:8443/path', 'https://billing.stripe.com.evil.test/path',
    'https://evil.test/path', 'https://user:secret@billing.stripe.com/path',
    'https://app.kiro.dev@evil.test/path', 'https://127.0.0.1/path',
    'http://169.254.169.254/latest/meta-data/', 'file:///secret', 'javascript:alert(1)',
    'data:text/html,fixture', 'https://billing.stripe.com./path'
  ]) {
    assert.throws(() => api.validateManagementUrl(url, 'management'), error => {
      assert.equal(error.stage, 'management')
      return /管理链接|允许的 HTTPS/.test(error.message)
    })
  }
})

test('GenerateSubscriptionManagementUrl executes CBOR with session Cookie/CSRF and no paid-plan token flow', async () => {
  await fixture({}, async (h, calls) => {
    const user = account()
    const snapshot = structuredClone(user)
    Object.freeze(user.credentials); Object.freeze(user)
    const context = await h.create(user)
    assert.equal(calls.length, 0, 'Creating a context must not launch a page or perform network I/O')
    assert.equal(await context.generateManagementUrl(), MANAGEMENT_URL)
    const info = await context.callKiro('GetUserInfo')
    const usage = await context.callKiro('GetUserUsageAndLimits', { origin: 'KIRO_IDE' })
    assert.equal(info.operation, 'GetUserInfo')
    assert.equal(usage.operation, 'GetUserUsageAndLimits')
    assert.equal(calls.length, 4, 'Bootstrap is reused only within this context')
    assert.equal(calls[0].method, 'GET')
    assert.equal(calls[0].headers.authorization, undefined)
    const management = calls[1]
    assert.equal(management.path, MANAGEMENT)
    assert.equal(management.method, 'POST')
    assert.deepEqual(decode(management.body), { profileArn: BUILDER_ARN })
    assert.equal(management.headers.authorization, `Bearer ${user.credentials.accessToken}`)
    assert.equal(management.headers['x-csrf-token'], 'fake-csrf')
    assert.equal(management.headers['content-type'], 'application/cbor')
    assert.equal(management.headers.accept, 'application/cbor')
    assert.equal(management.headers['smithy-protocol'], 'rpc-v2-cbor')
    assert.equal(management.headers['amz-sdk-request'], 'attempt=1; max=1')
    assert.match(management.headers['amz-sdk-invocation-id'], /^[0-9a-f-]{36}$/)
    assert.equal(management.headers.origin, KIRO)
    assert.equal(management.headers.referer, `${KIRO}/`)
    assert.equal(management.headers.cookie, `Idp=BuilderId; AccessToken=${user.credentials.accessToken}; RefreshToken=${user.credentials.refreshToken}; ProfileArn=${user.profileArn}`)
    assert.deepEqual(decode(calls[3].body), { origin: 'KIRO_IDE', profileArn: BUILDER_ARN })
    assert.deepEqual(user, snapshot)
    assert.deepEqual(h.lookups, [])
    assertSafeLogs(h.logs, [user.credentials.accessToken, user.credentials.refreshToken, 'fake-csrf', 'fixture-query-secret'])
  })
})

for (const [idp, portalIdp, expectedArn] of [
  ['Google', 'Google', SOCIAL_ARN], ['Github', 'Github', SOCIAL_ARN],
  ['BuilderId', 'Internal', BUILDER_ARN], ['Enterprise', 'Enterprise', 'arn:fixture:metadata-profile'],
  ['Enterprise', 'ExternalOIDC', 'arn:fixture:metadata-profile']
]) {
  test(`${idp}/${portalIdp}: stored ProfileArn cookie and portal-specific CBOR profile remain distinct`, async () => {
    await fixture({ html: metadata({ idp: portalIdp, 'profile-arn': 'arn:fixture:metadata-profile' }) }, async (h, calls) => {
      const user = account(idp)
      const context = await h.create(user)
      await context.generateManagementUrl()
      assert.equal(cookieValues(h.sessions[0]).ProfileArn, user.profileArn)
      assert.deepEqual(decode(calls[1].body), { profileArn: expectedArn })
      assert.equal(calls[1].headers['x-kiro-idp'], portalIdp === 'ExternalOIDC' ? portalIdp : undefined)
      assert.equal(calls[1].headers.tokentype, portalIdp === 'ExternalOIDC' ? 'EXTERNAL_IDP' : undefined)
      assert.equal(calls[1].headers['x-kiro-profile-arn'], portalIdp === 'ExternalOIDC' ? expectedArn : undefined)
    })
  })
}

test('Enterprise without metadata ARN falls back to read-only initialized profile and never mutates account', async () => {
  await fixture({ html: metadata({ idp: 'ExternalOIDC' }) }, async (h, calls) => {
    const user = account('Enterprise', { profileArn: '' })
    const snapshot = structuredClone(user)
    Object.freeze(user.credentials); Object.freeze(user)
    const context = await h.create(user)
    await context.generateManagementUrl()
    assert.deepEqual(h.lookups, [[user.credentials.accessToken, 'us-east-1']])
    assert.equal(cookieValues(h.sessions[0]).ProfileArn, 'arn:fixture:resolved')
    assert.equal(calls[1].headers['x-kiro-profile-arn'], 'arn:fixture:resolved')
    assert.deepEqual(decode(calls[1].body), { profileArn: 'arn:fixture:resolved' })
    assert.deepEqual(user, snapshot)
  })
})

test('contexts use unique non-persistent sessions; initialization and close never clear visible/other sessions', async () => {
  await fixture({}, async h => {
    const visible = new FakeSession('kiro-portal-private', 'http://127.0.0.1:1')
    await h.helper.initializePortalSession(visible, account('Google'))
    const visibleSnapshot = structuredClone([...visible.cookieJar])
    const visibleEvents = structuredClone(visible.events)
    const first = await h.create(account(), { proxyUrl: () => 'http://127.0.0.1:3128' })
    const second = await h.create(account('Github'))
    const [firstSession, secondSession] = h.sessions
    assert.notEqual(firstSession.partition, secondSession.partition)
    for (const ses of h.sessions) {
      assert.match(ses.partition, /^kiro-subscription-[0-9a-f-]{36}$/)
      assert.equal(ses.partition.startsWith('persist:'), false)
      assert.equal(ses.userAgent, h.helper.CHROME_UA)
      assert.equal(ses.userAgentCalls.length, 1)
      assert.equal(ses.userAgentCalls[0][2], 1, 'Configure follows proxy setup and precedes cookie initialization')
      assert.deepEqual(ses.events[1], ['storage', { storages: ['cookies'] }])
    }
    assert.deepEqual(firstSession.events[0], ['proxy', { proxyRules: 'http://127.0.0.1:3128' }])
    assert.deepEqual(secondSession.events[0], ['proxy', { mode: 'system' }])
    const secondSnapshot = structuredClone([...secondSession.cookieJar])
    const secondEvents = structuredClone(secondSession.events)
    await first.close(); await first.close()
    assert.deepEqual(firstSession.events.slice(-3), [['storage', undefined], ['cache'], ['connections']])
    assert.equal(firstSession.events.filter(([event]) => event === 'storage').length, 2)
    assert.equal(firstSession.cookieJar.size, 0)
    assert.deepEqual([...secondSession.cookieJar], secondSnapshot)
    assert.deepEqual(secondSession.events, secondEvents)
    assert.deepEqual([...visible.cookieJar], visibleSnapshot)
    assert.deepEqual(visible.events, visibleEvents)
    await assert.rejects(first.request(`${KIRO}/read`, { stage: 'verify' }), error => {
      assert.equal(error.stage, 'verify'); return /已关闭/.test(error.message)
    })
    assert.equal(firstSession.fetches.length, 0)
    await second.close()
  })
})

test('default Electron factory disables cache and missing access token is rejected before creating a session', async () => {
  const h = harness('http://127.0.0.1:1')
  for (const user of [undefined, { id: 'fixture' }, account('BuilderId', { credentials: { accessToken: '' } })]) {
    await assert.rejects(h.api.createSubscriptionPortalContext(user), /Access Token/)
  }
  assert.equal(h.sessions.length, 0)
  const context = await h.api.createSubscriptionPortalContext(account())
  try {
    assert.equal(h.defaults.length, 1)
    assert.deepEqual(h.defaults[0][1], { cache: false })
    assert.match(h.defaults[0][0], /^kiro-subscription-/)
  } finally { await context.close() }
})

test('initialization failures and cleanup failures still close connections without leaking original exceptions', async () => {
  for (const failure of ['proxy', 'initialize']) {
    const h = harness('http://127.0.0.1:1')
    await assert.rejects(h.create(account(), {
      createSession(partition) {
        const ses = h.createSession(partition)
        if (failure === 'proxy') ses.setProxy = async () => { throw new Error('fixture-secret-proxy') }
        return ses
      },
      initializeSession: async () => { throw new Error('fixture-secret-initialize') }
    }), /创建独立官网会话失败/)
    assert.deepEqual(h.sessions[0].events.slice(-3), [['storage', undefined], ['cache'], ['connections']])
    assertSafeLogs(h.logs, ['fixture-secret-proxy', 'fixture-secret-initialize'])
  }
  const h = harness('http://127.0.0.1:1')
  const context = await h.create()
  const [ses] = h.sessions
  const cleanup = []
  ses.clearStorageData = async () => { cleanup.push('storage'); throw new Error('fixture-cleanup-secret') }
  ses.clearCache = async () => { cleanup.push('cache'); throw new Error('fixture-cleanup-secret') }
  ses.closeAllConnections = async () => { cleanup.push('connections') }
  await context.close(); await context.close()
  assert.deepEqual(cleanup, ['storage', 'cache', 'connections'])
  assert.equal(h.logs.filter(line => line.includes('cleanup failed')).length, 2)
  assertSafeLogs(h.logs, ['fixture-cleanup-secret'])
})

for (const [name, patch, error] of [
  ['stale', { 'user-status': 'stale' }, /HTTP 401/],
  ['anonymous', { 'user-status': 'anonymous' }, /HTTP 401/],
  ['missing status', { 'user-status': undefined }, /有效登录状态/],
  ['missing CSRF', { 'csrf-token': undefined }, /有效登录状态/],
  ['missing IdP', { idp: undefined }, /有效登录状态/],
  ['wrong user', { 'user-id': 'another-fixture-user' }, /身份与目标账号不一致/]
]) {
  test(`bootstrap stops before management call for ${name}`, async () => {
    await fixture({ html: metadata(patch) }, async (h, calls) => {
      const context = await h.create()
      await assert.rejects(context.generateManagementUrl(), error)
      assert.equal(calls.length, 1)
    })
  })
}

test('all allowed redirect statuses follow at most five GET hops and never forward Kiro identity to Stripe', async () => {
  const destinations = [`${KIRO}/hop-1`, 'https://kiro.dev/hop-2', `${STRIPE}/hop-3`, `${STRIPE}/hop-4`, `${STRIPE}/done`]
  const statuses = [301, 302, 303, 307, 308]
  await fixture({ handle(call, response) {
    const index = call.path === '/start' ? 0 : Number(call.path.match(/^\/hop-(\d)$/)?.[1])
    if (index >= 0 && index < destinations.length) {
      response.writeHead(statuses[index], { location: destinations[index] }); response.end(); return true
    }
  } }, async (h, calls) => {
    const context = await h.create()
    const result = await h.api.loadPortalPage(context, `${KIRO}/start`)
    assert.equal(result.url, `${STRIPE}/done`)
    assert.equal(result.response.status, 200)
    assert.equal(calls.length, 6)
    for (const [index, call] of calls.entries()) {
      assert.equal(call.method, 'GET')
      assert.equal(call.headers.accept, 'text/html')
      assert.equal(call.headers.authorization, undefined)
      assert.equal(call.headers['x-csrf-token'], undefined)
      assert.equal(call.headers['x-kiro-profile-arn'], undefined)
      if (index < 2) assert.match(call.headers.cookie, /AccessToken=fake-access-BuilderId/)
      else assert.equal(call.headers.cookie, undefined)
    }
  })
})

test('relative redirects resolve correctly; sixth redirect and loops stop before a seventh request', async () => {
  await fixture({ handle(call, response) {
    if (call.path === '/relative/start') {
      response.writeHead(302, { location: '../done?fixture=1' }); response.end(); return true
    }
  } }, async (h, calls) => {
    const context = await h.create()
    assert.equal((await h.api.loadPortalPage(context, `${STRIPE}/relative/start`)).url, `${STRIPE}/done?fixture=1`)
    assert.equal(calls.length, 2)
  })
  await fixture({ handle(call, response) {
    response.writeHead(302, { location: '/loop' }); response.end(); return true
  } }, async (h, calls) => {
    const context = await h.create()
    await assert.rejects(h.api.loadPortalPage(context, `${KIRO}/loop`), error => {
      assert.equal(error.stage, 'redirect'); return /超过五次跳转/.test(error.message)
    })
    assert.equal(calls.length, 6)
  })
})

for (const [name, location, expected] of [
  ['missing Location', undefined, /缺少 Location/],
  ['malformed Location', 'http://[invalid', /格式无效/],
  ['untrusted host', 'https://never-contact.example.invalid/fixture-secret', /允许的 HTTPS/],
  ['protocol downgrade', 'http://billing.stripe.com/fixture-secret', /允许的 HTTPS/],
  ['embedded credentials', 'https://fake-user:fake-secret@billing.stripe.com/path', /允许的 HTTPS/],
  ['local address', 'http://127.0.0.1/private', /允许的 HTTPS/]
]) {
  test(`redirect ${name} stops before requesting its target`, async () => {
    await fixture({ handle(call, response) {
      response.writeHead(302, location === undefined ? {} : { location }); response.end(); return true
    } }, async (h, calls) => {
      const context = await h.create()
      await assert.rejects(h.api.loadPortalPage(context, MANAGEMENT_URL), expected)
      assert.equal(calls.length, 1)
    })
  })
}

test('manual API/POST requests never follow redirects and retain explicit stage/default GET behavior', async () => {
  await fixture({ handle(call, response) {
    if (call.path === '/redirect-api') {
      response.writeHead(303, { location: 'https://never-contact.example.invalid/fixture-secret' })
      response.end('fixture response body'); return true
    }
  } }, async (h, calls) => {
    const context = await h.create()
    const post = await context.request(`${STRIPE}/redirect-api`, { method: 'POST', body: 'quantity=1', stage: 'switch' })
    assert.equal(post.status, 303)
    assert.equal(post.headers.get('location'), 'https://never-contact.example.invalid/fixture-secret')
    assert.equal(await post.text(), 'fixture response body')
    assert.equal(calls.length, 1)
    assert.equal(calls[0].method, 'POST')
    const read = await context.request(`${STRIPE}/read`)
    assert.equal(calls[1].method, 'GET')
    assert.equal(await read.text(), '{"ok":true}')
    assert.deepEqual(structuredClone(await read.json()), { ok: true })
    assert.equal(Buffer.from(await read.arrayBuffer()).toString(), '{"ok":true}')
    assert.ok(h.logs.some(line => line.includes(' switch HTTP 303 ')))
    assert.ok(h.logs.some(line => line.includes(' read HTTP 200 ')))
  })
})

test('Cookie and identity headers cannot cross credential domains, even with mixed header casing', async () => {
  await fixture({}, async (h, calls) => {
    const user = account()
    const context = await h.create(user)
    for (const [origin, headers] of [
      [KIRO, { CoOkIe: 'fake-cookie-secret' }], [STRIPE, { cookie: 'fake-cookie-secret' }],
      [STRIPE, { Authorization: `Bearer ${user.credentials.accessToken}` }],
      ['https://kiro.dev', { authorization: `Bearer ${user.credentials.accessToken}` }],
      [KIRO, { authorization: 'Bearer another-account-secret' }],
      [KIRO, { authorization: 'Bearer ek_live_fixture' }],
      [STRIPE, { authorization: 'Bearer not-an-ephemeral-key' }],
      ['https://kiro.dev', { authorization: 'Bearer ek_live_fixture' }],
      [STRIPE, { 'X-CSRF-Token': 'fake-csrf' }],
      [STRIPE, { 'X-Kiro-Profile-Arn': user.profileArn }],
      [STRIPE, { 'X-Kiro-Idp': 'ExternalOIDC' }],
      [STRIPE, { TokenType: 'EXTERNAL_IDP' }]
    ]) {
      await assert.rejects(context.request(`${origin}/read`, { headers, stage: 'verify' }), error => {
        assert.equal(error.stage, 'verify'); return /跨域发送身份凭证/.test(error.message)
      })
    }
    assert.equal(calls.length, 0)
    assert.equal(h.sessions[0].fetches.length, 0)
    await context.request(`${KIRO}/read`, { headers: { authorization: `Bearer ${user.credentials.accessToken}` } })
    await context.request(`${STRIPE}/read`, { headers: { authorization: 'Bearer ek_live_fixture+/=_-key' } })
    assert.match(calls[0].headers.cookie, /ProfileArn=arn:fixture:stored-BuilderId/)
    assert.equal(calls[1].headers.cookie, undefined)
    assert.equal(calls[1].headers['x-csrf-token'], undefined)
    assertSafeLogs(h.logs, ['fake-cookie-secret', 'another-account-secret', user.credentials.accessToken, 'ek_live_fixture'])
  })
})

for (const status of [401, 403]) {
  test(`management HTTP ${status} supplements current plan once without retrying management or claiming renewal verified`, async () => {
    await fixture({ handle(call, response) {
      if (call.path === MANAGEMENT) {
        response.writeHead(status)
        response.end(encode({ __type: 'UnauthorizedException', message: 'Authentication required or access denied. fake-private-detail' }))
        return true
      }
      if (call.path.endsWith('/GetUserUsageAndLimits')) {
        response.end(encode({ subscriptionInfo: { subscriptionTitle: 'KIRO FREE' } }))
        return true
      }
    } }, async (h, calls) => {
      const context = await h.create()
      await assert.rejects(context.generateManagementUrl(), error => {
        assert.equal(error.stage, 'management')
        assert.equal(error.httpStatus, status)
        assert.equal(error.authExpired, false)
        assert.match(error.message, /官网当前套餐为 KIRO FREE/)
        assert.match(error.message, /Stripe 续费状态未核实/)
        assert.equal(h.auth.isSubscriptionAuthError(error.message), false)
        assert.equal(error.message.includes('fake-private-detail'), false)
        return true
      })
      assert.equal(calls.length, 3)
      assert.equal(calls.filter(call => call.path === MANAGEMENT).length, 1)
      assert.equal(calls.filter(call => call.path.endsWith('/GetUserUsageAndLimits')).length, 1)
      assert.deepEqual(decode(calls[2].body), { origin: 'KIRO_IDE', profileArn: BUILDER_ARN })
      assertSafeLogs(h.logs, ['fake-private-detail', 'fake-access-BuilderId'])
    })
  })
}

for (const supplement of ['denied', 'failure', 'unsafe-title']) {
  test(`permission supplement ${supplement} preserves original management denial and never recurses`, async () => {
    await fixture({ handle(call, response) {
      if (call.path === MANAGEMENT) {
        response.writeHead(403); response.end(encode({ message: 'Access denied' })); return true
      }
      if (call.path.endsWith('/GetUserUsageAndLimits')) {
        response.writeHead(supplement === 'denied' ? 401 : supplement === 'failure' ? 500 : 200)
        response.end(encode({ subscriptionInfo: { subscriptionTitle: 'KIRO FREE <fake-private-secret>' } }))
        return true
      }
    } }, async (h, calls) => {
      const context = await h.create()
      await assert.rejects(context.generateManagementUrl(), error => {
        assert.equal(error.httpStatus, 403)
        assert.match(error.message, /Stripe 续费状态未核实/)
        assert.equal(error.message.includes('官网当前套餐'), false)
        assert.equal(error.message.includes('fake-private-secret'), false)
        assert.equal(h.auth.isSubscriptionAuthError(error.message), false)
        return true
      })
      assert.equal(calls.length, 3)
      assert.equal(calls.filter(call => call.path === MANAGEMENT).length, 1)
      assertSafeLogs(h.logs, ['fake-private-secret'])
    })
  })
}

test('explicitly expired credentials are marked for refresh without permission supplementation or management retry', async () => {
  await fixture({ handle(call, response) {
    if (call.path === MANAGEMENT) {
      response.writeHead(401); response.end(encode({ message: 'The access token is expired' })); return true
    }
  } }, async (h, calls) => {
    const context = await h.create()
    await assert.rejects(context.generateManagementUrl(), error => {
      assert.equal(error.httpStatus, 401)
      assert.equal(error.authExpired, true)
      assert.match(error.message, /官网凭证已过期/)
      assert.equal(h.auth.isSubscriptionAuthError(error.message), true)
      return true
    })
    assert.equal(calls.length, 2)
    assert.equal(calls.filter(call => call.path === MANAGEMENT).length, 1)
  })
})

for (const [name, body, expected] of [
  ['missing URL', encode({}), /未返回管理链接/],
  ['non-string URL', encode({ encodedVerificationUrl: 1 }), /未返回管理链接/],
  ['unsafe URL', encode({ encodedVerificationUrl: 'https://never-contact.example.invalid/private' }), /允许的 HTTPS/],
  ['invalid CBOR', Buffer.alloc(0), /CBOR 响应无法解析/]
]) {
  test(`management ${name} fails closed without retrying`, async () => {
    await fixture({ handle(call, response) {
      if (call.path === MANAGEMENT) { response.end(body); return true }
    } }, async (h, calls) => {
      const context = await h.create()
      await assert.rejects(context.generateManagementUrl(), expected)
      assert.equal(calls.length, 2)
    })
  })
}

test('redacted URLs and network errors never reveal path/query/hash credentials or raw transport exceptions', async () => {
  const h = harness('http://127.0.0.1:1')
  const url = `${STRIPE}/p/session/bps_fixture-private/ek_live_fixture-private?token=fake-query-secret#fake-fragment-secret`
  assert.equal(h.api.redactedPortalUrl(url), `${STRIPE}/p/session/:redacted/:redacted?[redacted]`)
  assert.equal(h.api.redactedPortalUrl('not a URL fake-secret'), '[invalid-url]')
  assert.equal(h.api.redactedPortalUrl('https://fake-user:fake-password@billing.stripe.com/session/fake-path'), `${STRIPE}/session/:redacted`)
  const context = await h.create()
  h.sessions[0].fetch = async () => { throw new Error(`private transport ${url} Authorization: Bearer fake-access-secret`) }
  try {
    await assert.rejects(context.request(url, { stage: 'portal' }), error => {
      assert.equal(error.stage, 'portal')
      assert.match(error.message, /网络请求失败/)
      assert.equal(error.message.includes('secret'), false)
      return true
    })
    assertSafeLogs(h.logs, ['fixture-private', 'fake-query-secret', 'fake-fragment-secret', 'fake-access-secret'])
  } finally { await context.close() }
})

test('timeout remains active after response headers and aborts stalled response-body consumption', { timeout: 5000 }, async () => {
  await fixture({ handle(call, response) {
    response.writeHead(200, { 'content-type': 'text/plain', 'content-length': '100' })
    response.flushHeaders()
    response.write('partial')
    // Intentionally never end: this tests body consumption, not connection/header timeout.
    return true
  } }, async (h, calls) => {
    const context = await h.create(account(), { timeoutMs: 150 })
    await assert.rejects(context.request(`${STRIPE}/stalled-body?secret=fake-timeout-secret`, { stage: 'verify' }), error => {
      assert.equal(error.stage, 'verify')
      return /网络请求超时/.test(error.message)
    })
    assert.equal(calls.length, 1)
    assert.equal(h.sessions[0].headersReceived, 1)
    assert.equal(h.sessions[0].fetches[0].signal.aborted, true)
    assertSafeLogs(h.logs, ['fake-timeout-secret'])
  })
})
