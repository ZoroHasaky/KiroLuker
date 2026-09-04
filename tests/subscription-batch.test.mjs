import test from 'node:test'
import assert from 'node:assert/strict'
import {
  classifySubscriptionEligibility,
  isPaidSubscriptionPlan,
  isSubscriptionAuthError,
  normalizeSubscriptionLink,
  normalizeSubscriptionPlans,
  preferredSubscriptionPlan
} from '../src/shared/subscriptionBatch.ts'

function account(overrides = {}) {
  const base = {
    id: 'account-1',
    email: 'user@example.com',
    idp: 'BuilderId',
    credentials: {
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      expiresAt: Date.now() + 3_600_000
    },
    subscription: { type: 'Free', title: 'Kiro Free' },
    usage: { current: 0, limit: 50, percentUsed: 0, lastUpdated: 0 },
    status: 'active',
    isActive: false,
    tagIds: [],
    paymentLink: '',
    createdAt: 1,
    lastUsedAt: 1
  }
  return {
    ...base,
    ...overrides,
    credentials: { ...base.credentials, ...(overrides.credentials || {}) },
    subscription: { ...base.subscription, ...(overrides.subscription || {}) },
    usage: { ...base.usage, ...(overrides.usage || {}) }
  }
}

test('批量订阅预检区分可升级、已订阅和不适合的 Free 账号', () => {
  assert.deepEqual(classifySubscriptionEligibility(account()), {
    eligible: true,
    reason: 'ok'
  })
  assert.equal(
    classifySubscriptionEligibility(account({ subscription: { type: 'Pro', title: 'Kiro Pro' } })).reason,
    'already-paid'
  )
  assert.equal(
    classifySubscriptionEligibility(account({ usage: { current: 1 } })).reason,
    'used-free'
  )
  assert.equal(
    classifySubscriptionEligibility(
      account({ subscription: { managementTarget: 'MANAGE' } })
    ).reason,
    'downgraded-free'
  )
  assert.equal(
    classifySubscriptionEligibility(
      account({ subscription: { upgradeCapability: 'NOT_UPGRADE_CAPABLE' } })
    ).reason,
    'cannot-upgrade'
  )
})

test('订阅计划响应被归一化，并默认优先选择标准 Pro', () => {
  const plans = normalizeSubscriptionPlans({
    subscriptionPlans: [
      {
        name: 'KIRO_PRO_PLUS',
        qSubscriptionType: 'Q_DEVELOPER_STANDALONE_PRO_PLUS',
        description: { title: 'Kiro Pro+', billingInterval: 'month', features: ['A'] },
        pricing: { amount: 4000, currency: 'USD' }
      },
      {
        name: 'KIRO_PRO',
        qSubscriptionType: 'Q_DEVELOPER_STANDALONE_PRO',
        description: { title: 'Kiro Pro', billingInterval: 'month', features: ['B'] },
        pricing: { amount: 2000, currency: 'USD' }
      },
      { name: 'broken' }
    ]
  })

  assert.equal(plans.length, 2)
  assert.equal(plans[0].pricing.amount, 4000)
  assert.equal(plans.every(isPaidSubscriptionPlan), true)
  assert.equal(preferredSubscriptionPlan(plans)?.name, 'KIRO_PRO')
})

test('订阅链接只接受上游返回的 http/https 地址', () => {
  assert.deepEqual(
    normalizeSubscriptionLink({
      encodedVerificationUrl: 'https://buy.stripe.com/example',
      status: 'CREATED'
    }),
    { url: 'https://buy.stripe.com/example', status: 'CREATED' }
  )
  assert.equal(normalizeSubscriptionLink({ url: 'file:///tmp/test' }), null)
  assert.equal(normalizeSubscriptionLink({ url: 'javascript:alert(1)' }), null)
})

test('只有明确的 401 或 token 过期错误才触发自动刷新重试', () => {
  assert.equal(isSubscriptionAuthError('HTTP 401: invalid token'), true)
  assert.equal(isSubscriptionAuthError('Token is expired'), true)
  assert.equal(isSubscriptionAuthError('HTTP 403: not authorized'), false)
  assert.equal(isSubscriptionAuthError('HTTP 500'), false)
})
