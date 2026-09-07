import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createServer } from 'vite'
import { isSubscriptionAuthError } from '../src/shared/subscriptionBatch.ts'

const base = new URL('./fixtures/subscription-portal/', import.meta.url)
const management = JSON.parse(await readFile(new URL('management-link.json', base), 'utf8'))
const subscriptions = JSON.parse(await readFile(new URL('stripe-subscriptions.json', base), 'utf8'))
const denied = JSON.parse(await readFile(new URL('management-denied.json', base), 'utf8'))
const page = await readFile(new URL('stripe-page-excerpt.html', base), 'utf8')
const vite = await createServer({ configFile: false, appType: 'custom', ssr:{noExternal:['electron']},
  server: { middlewareMode: true }, optimizeDeps: { noDiscovery: true, include: [] },
  plugins: [{name:'no-live-electron',enforce:'pre',
    resolveId(id) { if(id==='electron') return '\0fixture-electron' },
    load(id) { if(id==='\0fixture-electron') return 'export const session={fromPartition(){throw new Error("No live Electron in fixture tests")}}' }
  }] })
after(() => vite.close())
const { createFreeSubscriptionService, parsePortalSubscription } = await vite.ssrLoadModule('/src/main/stripePortalService.ts')
const { validateManagementUrl } = await vite.ssrLoadModule('/src/main/subscriptionPortalContext.ts')

test('真实管理链接样本：/p/session?secret=… 无末尾斜杠也被正确接受', () => {
  const url = validateManagementUrl(management.encodedVerificationUrl)
  assert.equal(url.pathname, '/p/session')
  assert.equal(url.hostname, 'billing.stripe.com')
  assert.equal(url.searchParams.get('secret'), 'fixture-secret')
})

test('真实 Stripe 脱敏响应：items 数组和下一期 Free，不改变当前 Pro', () => {
  const { info } = parsePortalSubscription(subscriptions, 1_790_000_000_000)
  assert.equal(info.state, 'scheduled-free')
  assert.equal(info.planName, 'Kiro Pro')
  assert.equal(info.transitionAt, 1_800_000_000_000)
})

test('真实协议样本贯穿只读查询和幂等切换，已排期绝不再提交', async () => {
  const calls = []
  let closed = 0
  const createContext = async () => ({
    generateManagementUrl: async () => management.encodedVerificationUrl,
    callKiro: async () => { throw new Error('unexpected') },
    close: async () => { closed++ },
    request: async (url, options) => {
      calls.push({url, method: options?.method ?? 'GET'})
      assert.equal(options?.method ?? 'GET', 'GET')
      return { ok: true, status: 200, headers: new Headers(),
        text: async () => url.includes('/v1/') ? JSON.stringify(subscriptions) : page,
        json: async () => structuredClone(subscriptions) }
    }
  })
  const service = createFreeSubscriptionService({createContext})
  const account = {id:'fixture',credentials:{accessToken:'fixture'}}
  assert.equal((await service.checkSubscriptionRenewal(account)).state, 'scheduled-free')
  assert.equal((await service.switchSubscriptionToFree(account)).status, 'already-scheduled')
  assert.equal(closed, 2)
  assert.equal(calls.filter(c => c.method === 'POST').length, 0)
})

test('真实授权拒绝不被误当为 token 过期，不触发 UI 自动刷新', () => {
  assert.equal(denied.httpStatus, 401)
  assert.equal(denied.body.message, 'Authentication required or access denied.')
  assert.equal(isSubscriptionAuthError('[生成管理链接] HTTP 401：官网拒绝提供订阅管理门户；官网当前套餐为 KIRO FREE。Stripe 续费状态未核实。'), false)
  assert.equal(isSubscriptionAuthError('[生成管理链接] HTTP 403：官网拒绝访问，不会自动重试'), false)
  assert.equal(isSubscriptionAuthError('[读取订阅] Stripe HTTP 401，请重新检查续费'), false)
  assert.equal(isSubscriptionAuthError('[官网会话初始化] HTTP 401: 官网会话已过期，请刷新凭证'), true)
  assert.equal(isSubscriptionAuthError('[生成管理链接] HTTP 401：官网凭证已过期，请刷新凭证'), true)
  // 原购买流程的兼容行为不变。
  assert.equal(isSubscriptionAuthError('HTTP 401: Invalid bearer token'), true)
})


test('分页尚未结束时不把当前页的唯一订阅当作唯一目标', () => {
  assert.throws(() => parsePortalSubscription({...subscriptions,has_more:true}, Date.now()), /多个订阅/)
  const mixed = structuredClone(subscriptions)
  mixed.data[0].items = {data:mixed.data[0].items,has_more:true}
  assert.throws(() => parsePortalSubscription(mixed, Date.now()), /不唯一/)
})
