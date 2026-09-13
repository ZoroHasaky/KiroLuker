// Runs the production renderer with fixture IPC only. Never loads the application's main process/store.
// Covers the 切Free panel: usage-percentage threshold filtering (default 15), search, the durable
// write guard under storage failure, and keeping switched accounts listed with their outcome.
const { app, BrowserWindow, ipcMain } = require('electron')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const root = path.resolve(__dirname, '../..')
const profile = path.resolve(process.argv[2])
assert.ok(profile.startsWith(path.join(root, 'out') + path.sep), 'Use only an isolated workspace test profile')
app.setPath('userData', profile)
app.disableHardwareAcceleration()
const restoring = process.argv[3] === 'restore'
const KEY = 'kiroluker-subscription-records-v1'
const ids = ['paid-high', 'paid-mid', 'paid-low', 'paid-fresh', 'free-tier', 'expired']
// percentUsed: 42% / 30% / 2% / 0% — threshold 15 keeps only the first two switchable.
const percents = { 'paid-high': 0.42, 'paid-mid': 0.3, 'paid-low': 0.02, 'paid-fresh': 0, 'free-tier': 0.1, expired: 0.5 }
const states = { 'paid-high': 'paid', 'paid-mid': 'paid', 'paid-low': 'paid', 'paid-fresh': 'paid' }
const accounts = ids.map((id) => ({
  id, email: `${id}@example.invalid`, idp: 'BuilderId', status: id === 'expired' ? 'expired' : 'active',
  credentials: { accessToken: 'fixture-only-access', refreshToken: 'fixture-only-refresh', expiresAt: Date.now() + 86400000 },
  subscription: { type: id === 'free-tier' ? 'Free' : 'Pro', title: id === 'free-tier' ? 'Kiro Free' : 'Kiro Pro' },
  usage: { current: Math.round(percents[id] * 100), limit: 100, percentUsed: percents[id], lastUpdated: Date.now() },
  tagIds: [], paymentLink: '', isActive: false, createdAt: Date.now(), lastUsedAt: 0
}))
const calls = [], writes = [], unexpected = [], blockedNetwork = [], rendererErrors = []
let active = 0, maxActive = 0, win
const ok = (data) => ({ success: true, data })
const renewal = (id) => ({
  state: states[id], planName: states[id] === 'free' ? 'Kiro Free' : 'Kiro Pro', subscriptionId: `sub_fixture_${id}`,
  checkedAt: Date.now(), currentPeriodEnd: Date.now() + 86400000,
  ...(states[id] === 'scheduled-free' ? { transitionAt: Date.now() + 86400000 } : {})
})
const evaluate = (code) => win.webContents.executeJavaScript(code, true)
async function waitFor(code, label, timeout = 15000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await evaluate(code)) return
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(`Timed out: ${label}; ${await evaluate('document.body.innerText.slice(0, 1600)')}`)
}
async function click(selector) {
  await evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el || el.disabled) throw new Error('Missing or disabled: ' + ${JSON.stringify(selector)}); el.click() })()`)
}
async function select(selected) {
  await evaluate(`document.querySelectorAll('.account-row').forEach(row => { const el = row.querySelector('input[type=checkbox]'); if (el && !el.disabled && el.checked !== ${JSON.stringify(selected)}.includes(row.dataset.accountId)) el.click() })`)
}
async function visibleIds(expectedIds) {
  await waitFor(`JSON.stringify(Array.from(document.querySelectorAll('.account-row'), el => el.dataset.accountId)) === ${JSON.stringify(JSON.stringify(expectedIds))}`, 'filtered account IDs')
}
async function setThreshold(value) {
  const text = value == null ? '' : String(value)
  await evaluate(`(() => {
    const input = document.querySelector('.free-panel .threshold-input input')
    input.value = ${JSON.stringify(text)}
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.dispatchEvent(new Event('blur', { bubbles: true }))
  })()`)
  await new Promise((resolve) => setTimeout(resolve, 120))
}
async function searchAccounts(text) {
  await evaluate(`(() => { const input = document.querySelector('.free-panel .search-input input'); input.value = ${JSON.stringify(text)}; input.dispatchEvent(new Event('input', { bubbles: true })) })()`)
  await new Promise((resolve) => setTimeout(resolve, 120))
}
const records = () => evaluate(`JSON.parse(localStorage.getItem('${KEY}') || '{"records":{}}').records`)
const idle = () => waitFor(`!!document.querySelector('[data-testid=switch-selected]') && !document.querySelector('[data-testid=switch-selected]').classList.contains('ant-btn-loading')`, 'batch completion')
/** 提链 是默认标签页；切Free 面板用 v-show 隐藏，innerText 断言前必须先切过去。 */
async function showFreeTab() {
  await evaluate(`(() => { const tab = Array.from(document.querySelectorAll('.subscription-tabs button')).find(b => b.textContent.includes('切Free')); if (!tab) throw new Error('切Free tab missing'); tab.click() })()`)
  await waitFor(`(() => { const panel = document.querySelector('.free-panel'); return !!panel && panel.offsetParent !== null })()`, 'free panel visible')
}
ipcMain.handle('subscription-ui-fixture', async (_event, method, args) => {
  if (method === 'getSettings') return ok({ autoRefresh: false, autoRefreshUsage: false, darkMode: false })
  if (method === 'getAppInfo') return ok({ version: '1.2.32', platform: 'win32', arch: 'x64', name: 'UI fixture' })
  if (method === 'loadAccounts') return ok({ version: 2, accounts, tags: [], activeAccountId: null })
  if (method === 'getActiveKiroToken') return ok(null)
  if (method === 'syncTray') return ok()
  if (method === 'getUpdateState') return ok({ status: 'idle', release: null, progress: null, error: null })
  if (method === 'checkUpdate') return ok({ hasUpdate: false, currentVersion: '1.2.32', latestVersion: '1.2.32' })
  if (method === 'checkSubscriptionRenewal') {
    const id = args[0].id
    assert.ok(ids.includes(id)); calls.push(id)
    active++; maxActive = Math.max(maxActive, active)
    await new Promise((resolve) => setTimeout(resolve, 35))
    active--
    return ok(renewal(id))
  }
  if (method === 'switchSubscriptionToFree') {
    const id = args[0].id
    assert.ok(['paid-high', 'paid-mid', 'paid-low', 'paid-fresh'].includes(id))
    assert.equal((await records())[id].needsCheck, true, 'Write guard must be durable before IPC')
    writes.push(id)
    if (id === 'paid-mid') return ok({ status: 'unverified', previousPlan: 'Kiro Pro', warning: 'fixture: verification unavailable' })
    states[id] = 'scheduled-free'
    return ok({ status: 'scheduled', previousPlan: 'Kiro Pro', renewal: renewal(id) })
  }
  unexpected.push(method)
  return { success: false, error: `Forbidden fixture API: ${method}` }
})
async function run() {
  await app.whenReady()
  win = new BrowserWindow({ show: false, width: 1380, height: 1060, webPreferences: {
    preload: path.join(__dirname, 'subscription-management-preload.cjs'), contextIsolation: true, sandbox: true,
    partition: 'persist:subscription-management-ui', backgroundThrottling: false, offscreen: true
  } })
  win.webContents.session.webRequest.onBeforeRequest((details, callback) => {
    const allowed = /^(file:|data:|devtools:)/.test(details.url)
    if (!allowed) blockedNetwork.push(new URL(details.url).origin)
    callback({ cancel: !allowed })
  })
  win.webContents.on('console-message', (_event, level, message) => {
    if (level >= 3 && !/Electron Security Warning/.test(message)) rendererErrors.push(message)
  })
  await win.loadFile(path.join(root, 'out/renderer/index.html'), { hash: '/subscription' })
  await idle()
  await showFreeTab()
  if (restoring) {
    // Fresh process: session retention is gone, persisted records still exclude switched accounts.
    await visibleIds([])
    await waitFor(`document.querySelector('.free-panel .threshold-input input').value === '15'`, 'persisted threshold')
    const data = await records()
    assert.equal(data['paid-high'].renewal.state, 'scheduled-free')
    assert.equal(data['paid-high'].needsCheck, false)
    assert.equal(data['paid-mid'].needsCheck, true)
    assert.equal(await evaluate(`document.querySelector('[data-testid=switch-selected]').disabled`), true)
    await setThreshold(null)
    await visibleIds(['paid-low', 'paid-fresh'])
    assert.equal(calls.length, 0, 'Restart must not auto-check or change any subscription')
  } else {
    // Default threshold 15% keeps only accounts with usage at or above it.
    await visibleIds(['paid-high', 'paid-mid'])
    await waitFor(`document.querySelector('.free-panel .threshold-input input').value === '15'`, 'default threshold')
    assert.match(await evaluate('document.body.innerText'), /待切Free 2/)
    await setThreshold(50)
    await visibleIds([])
    assert.match(await evaluate('document.body.innerText'), /没有待切Free账号/)
    await setThreshold(42) // Boundary: exactly 42% stays listed with >= semantics.
    await visibleIds(['paid-high'])
    await setThreshold(null) // Cleared threshold disables usage filtering entirely.
    await visibleIds(['paid-high', 'paid-mid', 'paid-low', 'paid-fresh'])
    await searchAccounts('LOW')
    await visibleIds(['paid-low'])
    await searchAccounts('')
    await setThreshold(15)
    await visibleIds(['paid-high', 'paid-mid'])

    // A failing durable guard must prevent the write IPC and surface the storage error.
    await evaluate(`window.__setItem = Storage.prototype.setItem; Storage.prototype.setItem = function(){ throw new Error('fixture quota failure') }; void 0`)
    await click('input[data-testid=select-all], [data-testid=select-all] input')
    await click('[data-testid=switch-selected]')
    await idle()
    assert.equal(writes.length, 0, 'Failed durable guard must prevent the write IPC')
    assert.match(await evaluate('document.body.innerText'), /记录保存失败/)
    assert.equal(await evaluate(`document.querySelector('[data-testid=switch-selected]').disabled`), true)
    await evaluate('Storage.prototype.setItem = window.__setItem; void 0')
    await win.reload()
    await idle()
    await showFreeTab()
    await visibleIds(['paid-high', 'paid-mid'])

    // Batch switch: both accounts stay listed with their outcome instead of vanishing.
    await click('input[data-testid=select-all], [data-testid=select-all] input')
    await waitFor(`!document.querySelector('[data-testid=switch-selected]').disabled`, 'switch button enabled')
    await click('[data-testid=switch-selected]')
    await idle()
    assert.deepEqual(writes, ['paid-high', 'paid-mid'])
    assert.equal(maxActive, 1, 'Checks must stay sequential')
    await visibleIds(['paid-high', 'paid-mid']) // Retained rows keep the same IDs listed.
    assert.match(await evaluate('document.body.innerText'), /待切Free 0/)
    assert.match(await evaluate('document.body.innerText'), /已切换 2（本次会话）/)
    assert.match(await evaluate(`document.querySelector('[data-account-id=paid-high]').innerText`), /切换成功/)
    assert.match(await evaluate(`document.querySelector('[data-account-id=paid-mid]').innerText`), /需关注/)
    assert.equal(await evaluate(`document.querySelector('[data-account-id=paid-high] input[type=checkbox]').disabled`), true)
    const data = await records()
    assert.equal(data['paid-high'].renewal.state, 'scheduled-free')
    assert.equal(data['paid-high'].needsCheck, false)
    assert.equal(data['paid-mid'].needsCheck, true)
    await evaluate('new Promise(resolve => setTimeout(() => requestAnimationFrame(() => resolve(true)), 350))')
    fs.writeFileSync(path.join(root, 'out/subscription-management-ui.png'), (await win.webContents.capturePage()).toPNG())

    // Retention is independent of the threshold; the threshold keeps filtering only pending rows.
    await setThreshold(50)
    await visibleIds(['paid-high', 'paid-mid'])
    await setThreshold(15)

    // Renderer reload clears session retention while records and the threshold persist.
    const beforeReload = await records()
    await win.reload()
    await idle()
    await showFreeTab()
    await visibleIds([])
    assert.deepEqual(await records(), beforeReload)
    await setThreshold(null)
    await visibleIds(['paid-low', 'paid-fresh'])

    const layout = await evaluate(`(() => {
      const list = document.querySelector('.account-list'), panel = document.querySelector('.free-panel')
      return { overflow: getComputedStyle(list).overflowY, headerBeforeList: document.querySelector('.subscription-header').getBoundingClientRect().bottom <= list.getBoundingClientRect().top + 1, listInsidePanel: list.getBoundingClientRect().bottom <= panel.getBoundingClientRect().bottom + 1 }
    })()`)
    assert.equal(layout.overflow, 'auto')
    assert.equal(layout.headerBeforeList, true)
    assert.equal(layout.listInsidePanel, true, 'List must stay inside the scrollable panel')

    await setThreshold(15)
    await searchAccounts('')
  }
  // Verify wrapping in a narrower real Electron viewport too.
  win.setSize(1000, 860)
  await evaluate('new Promise(resolve => setTimeout(() => requestAnimationFrame(() => resolve(true)), 350))')
  assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true)
  assert.equal(await evaluate("document.querySelector('.subscription-page').scrollWidth <= document.querySelector('.subscription-page').clientWidth"), true)
  assert.deepEqual(unexpected, [])
  assert.deepEqual(blockedNetwork, [], 'No external network should be requested')
  assert.deepEqual(rendererErrors, [])
  win.webContents.session.flushStorageData()
  console.log(JSON.stringify({ phase: restoring ? 'process-restart' : 'ui-interactions', readCalls: calls.length, fixtureWrites: writes.length, realRequests: 0, result: 'PASS' }))
  win.destroy()
  app.exit(0)
}
run().catch(async (error) => {
  console.error(error.stack || error)
  console.error(JSON.stringify({ unexpected, blockedNetwork, rendererErrors }))
  if (win && !win.isDestroyed()) {
    try { fs.writeFileSync(path.join(root, 'out/subscription-management-ui-failure.png'), (await win.webContents.capturePage()).toPNG()) } catch {}
  }
  app.exit(1)
})
