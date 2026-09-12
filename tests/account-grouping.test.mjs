import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import vm from 'node:vm'
import ts from 'typescript'

const source = await fs.readFile(
  new URL('../src/renderer/src/utils/accountGrouping.ts', import.meta.url), 'utf8'
)
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
})
const exports = {}
vm.runInNewContext(outputText, {
  exports,
  require(id) { assert.fail(`Unexpected dependency: ${id}`) }
}, { filename: 'accountGrouping.ts', timeout: 1000 })
const { getAccountGroup, isAccountDeprecated } = exports

function account({ type = 'Free', title, current = 0, paymentLink = '', subscription = {} } = {}) {
  return {
    paymentLink,
    subscription: { type, title, ...subscription },
    usage: { current }
  }
}

test('Free account with zero usage and no payment link is unused', () => {
  assert.equal(getAccountGroup(account()), 'unused')
})

test('Free account with a payment link is pending payment', () => {
  assert.equal(getAccountGroup(account({ paymentLink: ' https://pay.example.test/checkout ' })), 'pending-payment')
  assert.equal(getAccountGroup(account({ paymentLink: '   ' })), 'unused')
})

test('paid subscription is subscribed even with zero usage or a payment link', () => {
  assert.equal(getAccountGroup(account({ type: 'Pro' })), 'subscribed')
  assert.equal(getAccountGroup(account({ type: 'Pro', paymentLink: 'https://pay.example.test/checkout' })), 'subscribed')
})

test('any positive usage is subscribed even when subscription is Free', () => {
  assert.equal(getAccountGroup(account({ current: 1 })), 'subscribed')
})

test('Free in the subscription title is treated as Free', () => {
  assert.equal(getAccountGroup(account({ type: 'Pro', title: 'Free trial' })), 'unused')
})


test('Free account marked as managed subscription downgrade is deprecated', () => {
  assert.equal(getAccountGroup(account({
    paymentLink: 'https://pay.example.test/checkout',
    subscription: { managementTarget: 'MANAGE' }
  })), 'deprecated')
})

test('absolute usage threshold marks an account deprecated', () => {
  const value = account({ current: 500 })
  assert.equal(isAccountDeprecated(value, { usageCurrentThreshold: 500 }), true)
  assert.equal(getAccountGroup(value, { usageCurrentThreshold: 500 }), 'deprecated')
  assert.equal(getAccountGroup(value, { usageCurrentThreshold: 501 }), 'subscribed')
})

test('percentage usage threshold marks an account deprecated', () => {
  const value = account({ current: 50 })
  value.usage.limit = 100
  value.usage.percentUsed = 0.5
  assert.equal(getAccountGroup(value, { usagePercentThreshold: 50 }), 'deprecated')
  assert.equal(getAccountGroup(value, { usagePercentThreshold: 51 }), 'subscribed')
})

test('deprecated classification has priority over payment and subscription groups', () => {
  const value = account({ type: 'Pro', current: 90, paymentLink: 'https://pay.example.test/checkout' })
  value.usage.limit = 100
  value.usage.percentUsed = 0.9
  assert.equal(getAccountGroup(value, { usagePercentThreshold: 80 }), 'deprecated')
})
