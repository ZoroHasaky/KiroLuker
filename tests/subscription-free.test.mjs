import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs/promises'
import vm from 'node:vm'
import { randomUUID } from 'node:crypto'
import ts from 'typescript'
import { encode, decode } from 'cbor-x'

const FREE = 'price_1RpBqGIHUhwdEnrTbZ8CIM0l'
const PORTAL = 'https://billing.stripe.com/p/session?secret=fixture_session'
const KIRO = 'https://app.kiro.dev'
const BUILDER_ARN = 'arn:fixture:builder-profile'
const PERIOD_END = 1_800_000_000
const NOW = 1_790_000_000_000
const account = {
  id: 'fixture-account', email: 'fixture@example.test', idp: 'BuilderId',
  credentials: { accessToken: 'fixture-kiro-token', region: 'us-east-1', expiresAt: NOW + 3600_000 },
  subscription: { type: 'Pro' }
}

async function loadModule(name, imports) {
  const source = await fs.readFile(new URL(`../src/main/${name}.ts`, import.meta.url), 'utf8')
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  })
  const exports = {}
  vm.runInNewContext(outputText, {
    exports, Buffer, URL, URLSearchParams, Headers, AbortController, TextDecoder, setTimeout, clearTimeout,
    console: { debug() {}, warn() {} },
    require(id) {
      assert.ok(Object.hasOwn(imports, id), `Unexpected real dependency: ${id}`)
      return imports[id]
    }
  }, { filename: `${name}.ts` })
  return exports
}
const forbidden = () => { throw new Error('Real Electron/auth/proxy access is forbidden in tests') }
// Execute real service/context code; only Electron session, auth constants and local transport are fixtures.
const portalModule = await loadModule('subscriptionPortalContext', {
  crypto: { randomUUID }, electron: { session: { fromPartition: forbidden } }, 'cbor-x': { encode, decode },
  './kiroPortalSession': { initializePortalSession: forbidden, configurePortalSession: forbidden, KIRO_PORTAL_ORIGIN: KIRO },
  './net': { getConfiguredProxyUrl: forbidden },
  './kiroAuth': { KIRO_BUILDER_ID_PLACEHOLDER_ARN: BUILDER_ARN, KIRO_SOCIAL_PROFILE_ARN: 'arn:fixture:social-profile' }
})
const { createFreeSubscriptionService } = await loadModule('stripePortalService', {
  './subscriptionPortalContext': portalModule
})

function subscription(patch = {}) {
  return {
    id: 'sub_fixture', status: 'active', current_period_end: PERIOD_END,
    cancel_at_period_end: false, has_update_scheduled: false,
    items: { data: [{ id: 'si_fixture', quantity: 1,
      price_details: { id: 'price_paid', product: { name: 'Kiro Pro' } } }] },
    ...patch
  }
}
function freeSubscription() {
  return subscription({ items: [{ id: 'si_fixture', price_details: { id: FREE, product: [{ name: 'Kiro Free' }] } }] })
}
function scheduledSubscription() {
  return subscription({ has_update_scheduled: true, transition_at: PERIOD_END,
    upcoming_invoice: { amount_due: 0, lines: { data: [{ price_details: { id: FREE } }] } } })
}
async function fixture(options, run) {
  const calls = []
  const sessions = []
  let reads = 0
  const server = http.createServer(async (request, response) => {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    const bytes = Buffer.concat(chunks)
    calls.push({ method: request.method, path: request.url, headers: request.headers, body: bytes.toString(), bytes })
    response.setHeader('Content-Type', 'application/json')
    if (request.url === '/') {
      response.setHeader('Content-Type', 'text/html')
      response.end('<meta name="user-status" content="active"><meta name="idp" content="BuilderId"><meta name="csrf-token" content="fixture-csrf">')
    } else if (request.url === '/service/KiroWebPortalService/operation/GenerateSubscriptionManagementUrl') {
      response.setHeader('Content-Type', 'application/cbor')
      response.end(encode({ encodedVerificationUrl: options.portalUrl ?? PORTAL }))
    } else if (new URL(request.url, KIRO).pathname === '/p/session' || request.url.startsWith('/p/session/')) {
      if (options.redirect) {
        response.writeHead(302, { Location: options.redirect }); response.end(); return
      }
      response.setHeader('Content-Type', 'text/html')
      response.end(options.html ?? '<script>{&quot;id&quot;:&quot;bps_fixture&quot;,&quot;session_api_key&quot;:&quot;ek_live_fixture+/=_-key&quot;,&quot;account&quot;:&quot;acct_1RoAWWIHUhwdEnrT&quot;}</script>')
    } else if (request.method === 'GET' && request.url.includes('/subscriptions?')) {
      reads++
      if (reads > 1 && options.verifyFailure) { response.writeHead(503); response.end('{}'); return }
      const sub = reads === 1 ? options.before ?? subscription() : options.after ?? freeSubscription()
      response.end(JSON.stringify({ data: Array.isArray(sub) ? sub : [sub] }))
    } else if (request.method === 'POST' && request.url.endsWith('/subscriptions/sub_fixture')) {
      if (options.disconnect) { request.socket.destroy(); return }
      response.writeHead(options.postStatus ?? 200)
      response.end('{"status":"active"}')
    } else {
      response.writeHead(404); response.end('{}')
    }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${server.address().port}`
  const service = createFreeSubscriptionService({
    now: () => NOW,
    createContext: async (target) => portalModule.createSubscriptionPortalContext(target, {
      proxyUrl: () => '', timeoutMs: 2000, configureSession: () => {},
      initializeSession: async (ses, user) => { assert.equal(user, target); return BUILDER_ARN },
      createSession(partition) {
        assert.match(partition, /^kiro-subscription-/)
        const ses = {
          cleanup: [], setProxy: async () => {},
          clearStorageData: async () => { ses.cleanup.push('storage') },
          clearCache: async () => { ses.cleanup.push('cache') },
          closeAllConnections: async () => { ses.cleanup.push('connections') },
          fetch(url, init) {
            const parsed = new URL(url)
            assert.ok([KIRO, 'https://kiro.dev', 'https://billing.stripe.com'].includes(parsed.origin))
            assert.equal(init.redirect, 'manual')
            assert.equal(init.credentials, 'include')
            // Rewrite every allowed URL to loopback; fetch itself never contacts the public host.
            return fetch(`${origin}${parsed.pathname}${parsed.search}`, init)
          }
        }
        sessions.push(ses)
        return ses
      }
    })
  })
  try {
    await run(service, calls)
    for (const ses of sessions) assert.deepEqual(ses.cleanup, ['storage', 'cache', 'connections'])
  } finally {
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
  }
}
const writes = calls => calls.filter(c => c.method === 'POST' && c.path.includes('/subscriptions/'))

test('只读预检实际请求管理门户，不传付费计划，且隔离 Kiro 与 Stripe 凭证', async () => {
  await fixture({}, async (service, calls) => {
    const info = await service.checkSubscriptionRenewal(account)
    assert.equal(info.state, 'paid')
    assert.equal(info.currentPeriodEnd, PERIOD_END * 1000)
    assert.equal(info.checkedAt, NOW)
    assert.equal(calls.length, 4)
    assert.equal(calls[0].method, 'GET')
    assert.equal(calls[0].path, '/')
    assert.equal(calls[1].path, '/service/KiroWebPortalService/operation/GenerateSubscriptionManagementUrl')
    const payload = decode(calls[1].bytes)
    assert.deepEqual(payload, { profileArn: BUILDER_ARN })
    assert.equal(calls[1].headers['content-type'], 'application/cbor')
    assert.equal(calls[1].headers['x-csrf-token'], 'fixture-csrf')
    assert.equal(calls[1].headers.authorization, 'Bearer fixture-kiro-token')
    assert.equal(calls[2].headers.authorization, undefined)
    assert.equal(calls[2].headers['x-csrf-token'], undefined)
    assert.equal(calls[3].headers.authorization, 'Bearer ek_live_fixture+/=_-key')
    assert.equal(calls[3].headers['stripe-account'], 'acct_1RoAWWIHUhwdEnrT')
    assert.equal(writes(calls).length, 0)
    assert.equal(JSON.stringify(info).includes('ek_live_'), false)
  })
})

test('切换后通过 HTTP 读回复核立即 Free，并保持原账号数据不变', async () => {
  await fixture({}, async (service, calls) => {
    const before = structuredClone(account)
    const result = await service.switchSubscriptionToFree(account)
    assert.equal(result.status, 'switched')
    assert.equal(result.renewal.state, 'free')
    assert.equal(result.previousPlan, 'Kiro Pro')
    assert.deepEqual(account, before)
    assert.equal(calls.length, 6)
    const [post] = writes(calls)
    assert.deepEqual(Object.fromEntries(new URLSearchParams(post.body)), {
      'recurring_items[0][id]': 'si_fixture',
      'recurring_items[0][quantity]': '1',
      'recurring_items[0][price]': FREE
    })
    assert.equal(post.headers.origin, 'https://billing.stripe.com')
  })
})

test('周期末 Free 保留当前付费计划，并显示真实生效时间', async () => {
  await fixture({ after: scheduledSubscription() }, async service => {
    const result = await service.switchSubscriptionToFree(account)
    assert.equal(result.status, 'scheduled')
    assert.equal(result.renewal.planName, 'Kiro Pro')
    assert.equal(result.renewal.transitionAt, PERIOD_END * 1000)
  })
})

for (const [name, before, status] of [
  ['已经 Free', freeSubscription(), 'already-free'],
  ['已安排降级', scheduledSubscription(), 'already-scheduled'],
  ['已经取消续费', subscription({ cancel_at_period_end: true }), 'wont-renew']
]) {
  test(`${name}时不重复写入 Stripe`, async () => {
    await fixture({ before }, async (service, calls) => {
      assert.equal((await service.switchSubscriptionToFree(account)).status, status)
      assert.equal(writes(calls).length, 0)
    })
  })
}

test('零元发票不是 Free 证明，未知的已排期变更不得被覆盖', async () => {
  const before = subscription({ has_update_scheduled: true, upcoming_invoice: {
    amount_due: 0, lines: { data: [{ price_details: { id: 'price_paid' } }] }
  } })
  await fixture({ before }, async service => {
    assert.equal((await service.checkSubscriptionRenewal(account)).state, 'paid')
  })
  await fixture({ before }, async (service, calls) => {
    await assert.rejects(service.switchSubscriptionToFree(account), /已有其他周期末/)
    assert.equal(writes(calls).length, 0)
  })
})

for (const [name, options, error] of [
  ['页面过期', { html: '<html>expired</html>' }, /会话已失效/],
  ['没有订阅', { before: [] }, /没有可管理/],
  ['多个订阅', { before: [subscription(), subscription({ id: 'sub_other' })] }, /多个订阅/],
  ['多个项目', { before: subscription({ items: [{}, {}] }) }, /不唯一/],
  ['恶意订阅 ID', { before: subscription({ id: 'sub_foo/../../bar' }) }, /ID 格式异常/],
  ['订阅已取消', { before: subscription({ status: 'canceled' }) }, /不是有效状态/],
  ['未知商品', { before: subscription({ items: [{ id: 'si_fixture', price_details: { id: 'price_paid', product: { name: 'Other' } } }] }) }, /无法确认/],
  ['多席位', { before: subscription({ items: [{ id: 'si_fixture', quantity: 2, price_details: { id: 'price_paid' } }] }) }, /数量不是 1/]
]) {
  test(`${name}时停止，绝不提交变更`, async () => {
    await fixture(options, async (service, calls) => {
      await assert.rejects(service.switchSubscriptionToFree(account), error)
      assert.equal(writes(calls).length, 0)
    })
  })
}

for (const portalUrl of [
  'https://evil.test/p/session/secret', 'http://billing.stripe.com/p/session/secret',
  'https://billing.stripe.com:8443/p/session/secret',
  'https://user:password@billing.stripe.com/p/session/secret',
  'https://billing.stripe.com/pay/secret'
]) {
  test(`拒绝危险管理链接或不可用门户 ${new URL(portalUrl).origin}`, async () => {
    await fixture({ portalUrl }, async (service, calls) => {
      const unavailableOfficialPage = new URL(portalUrl).pathname.startsWith('/pay/')
      await assert.rejects(service.switchSubscriptionToFree(account), unavailableOfficialPage ? /HTTP 404/ : /允许的 HTTPS/)
      assert.equal(calls.length, unavailableOfficialPage ? 3 : 2)
      assert.equal(writes(calls).length, 0)
    })
  })
}

test('门户危险重定向由官网上下文校验拒绝，真实 HTTP 不自动跟随', async () => {
  await fixture({ redirect: 'https://never-contact.example.test/secret' }, async (service, calls) => {
    await assert.rejects(service.checkSubscriptionRenewal(account), /允许的 HTTPS/)
    assert.equal(calls.length, 3)
  })
})

for (const [name, options] of [
  ['读回还是付费', { after: subscription() }],
  ['复核失败', { verifyFailure: true }],
  ['写入网络断开', { disconnect: true }],
  ['上游 500', { postStatus: 500 }],
  ['上游 408', { postStatus: 408 }],
  ['读回不同订阅', { after: { ...freeSubscription(), id: 'sub_other' } }]
]) {
  test(`${name}只报告待复核，不自动重试或谎报 Free`, async () => {
    await fixture(options, async (service, calls) => {
      const result = await service.switchSubscriptionToFree(account)
      assert.equal(result.status, 'unverified')
      assert.equal(result.renewal, undefined)
      assert.match(result.warning, /检查续费/)
      assert.equal(writes(calls).length, 1)
    })
  })
}

test('明确 HTTP 400 失败不复核为成功，也不重复提交', async () => {
  await fixture({ postStatus: 400 }, async (service, calls) => {
    await assert.rejects(service.switchSubscriptionToFree(account), /HTTP 400/)
    assert.equal(writes(calls).length, 1)
    assert.equal(calls.length, 5)
  })
})

test('主进程阻止同账号并行提交，并在结束后释放锁', async () => {
  await fixture({}, async (service, calls) => {
    const first = service.switchSubscriptionToFree(account)
    await assert.rejects(service.switchSubscriptionToFree(account), /勿重复提交/)
    assert.equal((await first).status, 'switched')
    assert.equal((await service.switchSubscriptionToFree(account)).status, 'already-free')
    assert.equal(writes(calls).length, 1)
  })
})


test('混合下期账单不能被误判为全量 Free', async () => {
  const before = scheduledSubscription()
  before.upcoming_invoice.lines.data.push({ price_details: { id: 'price_paid' } })
  await fixture({ before }, async (service, calls) => {
    await assert.rejects(service.switchSubscriptionToFree(account), /已有其他周期末/)
    assert.equal(writes(calls).length, 0)
  })
})
