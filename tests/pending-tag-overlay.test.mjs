import assert from 'node:assert/strict'
import test from 'node:test'
import { acknowledgePendingTagIds, overlayPendingTagIds } from '../src/renderer/src/stores/pendingTagOverlay.ts'

test('a live snapshot cannot make a debounced tag assignment disappear', () => {
  const pending = new Map([['account-1', ['tag-vip']]])
  const backgroundSnapshot = [{ id: 'account-1', tagIds: [], usage: { current: 2 } }]

  const rendered = overlayPendingTagIds(backgroundSnapshot, pending)
  assert.deepEqual(rendered[0].tagIds, ['tag-vip'])
  assert.deepEqual(backgroundSnapshot[0].tagIds, [])
})

test('acknowledging an earlier save keeps a newer tag selection pending', () => {
  const pending = new Map([['account-1', ['tag-new']]])
  acknowledgePendingTagIds(pending, new Map([['account-1', ['tag-old']]]))
  assert.deepEqual(pending.get('account-1'), ['tag-new'])

  acknowledgePendingTagIds(pending, new Map([['account-1', ['tag-new']]]))
  assert.equal(pending.has('account-1'), false)
})
