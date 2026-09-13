import test from 'node:test'
import assert from 'node:assert/strict'
import { classifyAccountGroup } from '../src/shared/accountGrouping.ts'

const account = ({ type = 'Free', title = '', managementTarget, current = 0, percentUsed = 0, hasPaymentLink = false } = {}) => ({
  subscription: { type, title, managementTarget }, usage: { current, percentUsed }, hasPaymentLink
})

test('mobile API grouping follows desktop priority and thresholds', () => {
  assert.equal(classifyAccountGroup(account()), 'unused')
  assert.equal(classifyAccountGroup(account({ hasPaymentLink: true })), 'pending')
  assert.equal(classifyAccountGroup(account({ type: 'Pro' })), 'subscribed')
  assert.equal(classifyAccountGroup(account({ current: 1 })), 'subscribed')
  assert.equal(classifyAccountGroup(account({ managementTarget: 'MANAGE', hasPaymentLink: true })), 'deprecated')
  assert.equal(classifyAccountGroup(account({ current: 50 }), { absoluteCurrent: 50, percent: 100 }), 'deprecated')
  assert.equal(classifyAccountGroup(account({ current: 50, percentUsed: 0.5 }), { absoluteCurrent: 0, percent: 50 }), 'deprecated')
  assert.equal(classifyAccountGroup(account({ type: 'Pro', current: 50, hasPaymentLink: true }), { absoluteCurrent: 1, percent: 1 }), 'deprecated')
  assert.equal(classifyAccountGroup(account({ title: 'Free trial' })), 'unused')
})
