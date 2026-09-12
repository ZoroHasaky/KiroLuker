import assert from 'node:assert/strict'
import test from 'node:test'
import {
  acknowledgePendingAccountPatches,
  overlayPendingAccountPatches,
  type PendingAccountPatch
} from '../src/renderer/src/stores/pendingAccountOverlay.ts'

test('a live snapshot cannot make a local payment-link edit disappear', () => {
  const pending = new Map<string, PendingAccountPatch<{ id: string; paymentLink: string }>>([
    ['account-1', { version: 1, patch: { paymentLink: 'https://pay.local/new' } }]
  ])
  const backgroundSnapshot = [{ id: 'account-1', paymentLink: 'https://pay.local/old' }]

  const rendered = overlayPendingAccountPatches(backgroundSnapshot, pending)
  assert.equal(rendered[0].paymentLink, 'https://pay.local/new')
  assert.equal(backgroundSnapshot[0].paymentLink, 'https://pay.local/old')
})

test('acknowledging an earlier save keeps a newer account edit pending', () => {
  const pending = new Map<string, PendingAccountPatch<{ id: string; paymentLink: string }>>([
    ['account-1', { version: 2, patch: { paymentLink: 'https://pay.local/newer' } }]
  ])
  acknowledgePendingAccountPatches(
    pending,
    new Map([['account-1', { version: 1, patch: { paymentLink: 'https://pay.local/older' } }]])
  )
  assert.equal(pending.get('account-1')?.version, 2)

  acknowledgePendingAccountPatches(pending, new Map([['account-1', { version: 2, patch: { paymentLink: 'https://pay.local/newer' } }]]))
  assert.equal(pending.has('account-1'), false)
})
