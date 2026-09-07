// Runs the production renderer with fixture IPC only. Never loads the application's main process/store.
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
const ids = ['paid-a', 'paid-b', 'free', 'scheduled', 'canceling', 'failed']
const states = { 'paid-a': 'paid', 'paid-b': 'paid', free: 'free', scheduled: 'scheduled-free', canceling: 'canceling' }
const failedIds = new Set(['failed'])
const accounts = ids.map((id) => ({
  id, email: `${id}@example.invalid`, idp: 'BuilderId', status: 'active',
  credentials: { accessToken: 'fixture-only-access', refreshToken: 'fixture-only-refresh', expiresAt: Date.now() + 86400000 },
  subscription: { type: id === 'free' ? 'Free' : 'Pro', title: id === 'free' ? 'Kiro Free' : 'Kiro Pro' },
  usage: { current: 0, limit: 100, percentUsed: 0, lastUpdated: Date.now() },
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
  await evaluate(`document.querySelectorAll('.account-row').forEach(row => { const el = row.querySelector('input[type=checkbox]'); if(el.checked !== ${JSON.stringify(selected)}.includes(row.dataset.accountId)) el.click() })`)
}
async function searchAccounts(text, expectedRows) {
  await evaluate(`(() => { const input = document.querySelector('[data-testid=subscription-search] input') || document.querySelector('input[data-testid=subscription-search]'); input.value = ${JSON.stringify(text)}; input.dispatchEvent(new Event('input', { bubbles: true })) })()`)
  await waitFor(`document.querySelectorAll('.account-row').length === ${expectedRows}`, 'search filter')
}
async function chooseFilter(testId, label, expectedIds) {
  await evaluate(`document.querySelector('[data-testid=${testId}] .ant-select-selector').dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }))`)
  await waitFor(`Array.from(document.querySelectorAll('.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option-content')).some(el => el.textContent.trim() === ${JSON.stringify(label)})`, 'filter dropdown option')
  await evaluate(`Array.from(document.querySelectorAll('.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option-content')).find(el => el.textContent.trim() === ${JSON.stringify(label)}).click()`)
  await visibleIds(expectedIds)
}
async function visibleIds(expectedIds) {
  await waitFor(`JSON.stringify(Array.from(document.querySelectorAll('.account-row'), el => el.dataset.accountId)) === ${JSON.stringify(JSON.stringify(expectedIds))}`, 'filtered account IDs')
}
async function resetFilters(expectedIds = ids) {
  await click('[data-testid=reset-filters]')
  await visibleIds(expectedIds)
}
const records = () => evaluate(`JSON.parse(localStorage.getItem('${KEY}') || '{"records":{}}').records`)
const idle = () => waitFor(`!!document.querySelector('[data-testid=check-all]') && !document.querySelector('[data-testid=check-all]').disabled`, 'batch completion')
async function check(button, expectedIds) {
  const start = calls.length
  await click(`[data-testid=${button}]`)
  await idle()
  assert.deepEqual(calls.slice(start), expectedIds)
}
ipcMain.handle('subscription-ui-fixture', async (_event, method, args) => {
  if (method === 'getSettings') return ok({ autoRefresh: false, autoRefreshUsage: false, darkMode: false })
  if (method === 'getAppInfo') return ok({ version: '1.2.8', platform: 'win32', arch: 'x64', name: 'UI fixture' })
  if (method === 'loadAccounts') return ok({ version: 2, accounts, tags: [], activeAccountId: null })
  if (method === 'getActiveKiroToken') return ok(null)
  if (method === 'syncTray') return ok()
  if (method === 'getUpdateState') return ok({ status: 'idle', release: null, progress: null, error: null })
  if (method === 'checkUpdate') return ok({ hasUpdate: false, currentVersion: '1.2.8', latestVersion: '1.2.8' })
  if (method === 'checkSubscriptionRenewal') {
    const id = args[0].id
    assert.ok(ids.includes(id)); calls.push(id)
    active++; maxActive = Math.max(maxActive, active)
    await new Promise((resolve) => setTimeout(resolve, 35))
    active--
    return failedIds.has(id) ? { success: false, error: '读取订阅：HTTP 503（测试样本）' } : ok(renewal(id))
  }
  if (method === 'switchSubscriptionToFree') {
    const id = args[0].id
    assert.ok(['paid-a', 'paid-b'].includes(id))
    assert.equal((await records())[id].needsCheck, true, 'Write guard must be durable before IPC')
    writes.push(id)
    if (id === 'paid-b') return ok({ status: 'unverified', previousPlan: 'Kiro Pro', warning: 'fixture: verification unavailable' })
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
  await waitFor(`document.querySelectorAll('.account-row').length === 6`, 'real renderer account list')
  await idle()
  const body = await evaluate('document.body.innerText')
  assert.match(body, /订阅管理/)
  assert.doesNotMatch(body, /批量订阅|账号预检|选择计划并生成|订阅支付链接|最近检查与切换记录/)
  assert.equal(await evaluate(`document.querySelector('[data-testid=check-selected]').disabled`), true)
  if (restoring) {
    const data = await records()
    assert.equal(data['paid-a'].renewal.state, 'scheduled-free')
    assert.equal(data['paid-b'].needsCheck, true)
    assert.ok(data.free.lastCheckAt > 0)
    await select(['paid-b'])
    assert.equal(await evaluate(`document.querySelector('[data-testid=switch-selected]').disabled`), true)
    assert.match(await evaluate(`document.querySelector('[data-account-id="paid-b"]').innerText`), /复查|复核|未获确认|结果不确定/)
    await chooseFilter('subscription-arrangement-filter', '待复核', ['paid-b'])
    await resetFilters()
    assert.equal(calls.length, 0, 'Restart/filtering must not auto-check or change any subscription')
  } else {
    assert.match(body, /检查未切换至 Free（6）/)
    await select(ids)
    assert.equal(await evaluate(`document.querySelector('[data-testid=switch-selected]').disabled`), true, 'Unchecked accounts stay protected without a dialog')
    await select([])
    // Before any read, current type may use the local label but arrangements remain unconfirmed.
    await chooseFilter('subscription-plan-filter', 'Pro', ['paid-a', 'paid-b', 'scheduled', 'canceling', 'failed'])
    await chooseFilter('subscription-arrangement-filter', '尚未确认', ['paid-a', 'paid-b', 'scheduled', 'canceling', 'failed'])
    await chooseFilter('subscription-plan-filter', 'Free', ['free'])
    await chooseFilter('subscription-arrangement-filter', '已安排转为 Free', [])
    await resetFilters()
    assert.equal(calls.length, 0)
    await check('check-all', ids)
    assert.equal(maxActive, 1)
    assert.equal(writes.length, 0)
    let data = await records()
    assert.equal(Object.keys(data).length, 6)
    assert.ok(ids.every((id) => data[id].lastCheckAt && data[id].completedAt))
    assert.equal(data.failed.status, 'error')
    assert.equal(data.scheduled.renewal.planName, 'Kiro Pro', 'Scheduled Free must retain current paid tier')
    const saved = await evaluate(`localStorage.getItem('${KEY}')`)
    assert.doesNotMatch(saved, /example\.invalid|fixture-only|sub_fixture_/)
    // Plan + arrangement intersection, hidden selections and global batch scopes.
    const beforeFilters = await records()
    await chooseFilter('subscription-plan-filter', 'Pro', ['paid-a', 'paid-b', 'scheduled', 'canceling', 'failed'])
    await chooseFilter('subscription-arrangement-filter', '已安排转为 Free', ['scheduled'])
    assert.match(await evaluate(`document.querySelector('[data-account-id=scheduled] .plan-cell').innerText`), /Kiro Pro/)
    await click('input[data-testid=select-all], [data-testid=select-all] input')
    await chooseFilter('subscription-arrangement-filter', '付费订阅', ['paid-a', 'paid-b'])
    assert.match(await evaluate('document.body.innerText'), /隐藏 1/)
    assert.deepEqual(await records(), beforeFilters, 'Changing filters must not mutate records')
    await check('check-selected', ['scheduled'])
    await click('input[data-testid=select-all], [data-testid=select-all] input')
    await check('check-selected', ['scheduled', 'paid-a', 'paid-b'])
    await click('[data-testid=clear-selection]')
    await chooseFilter('subscription-plan-filter', 'Free', [])
    await chooseFilter('subscription-arrangement-filter', '已为 Free', ['free'])
    await searchAccounts('paid', 0)
    await check('check-all', ids)
    await resetFilters(['paid-a', 'paid-b'])
    await searchAccounts('', 6)
    await chooseFilter('subscription-arrangement-filter', '取消中（尚非 Free）', ['canceling'])
    await chooseFilter('subscription-arrangement-filter', '尚未确认', ['failed'])
    await resetFilters()
    // Search mirrors account management without silently narrowing global batch scopes.
    await searchAccounts('PAID-A', 1)
    await click('[data-account-id="paid-a"] .plan-cell')
    await check('check-selected', ['paid-a'])
    await searchAccounts('free', 1)
    assert.match(await evaluate('document.body.innerText'), /隐藏 1/)
    await check('check-selected', ['paid-a'])
    await click('input[data-testid=select-all], [data-testid=select-all] input')
    await check('check-selected', ['paid-a', 'free'])
    await click('[data-testid=clear-selection]')
    assert.equal(await evaluate(`document.querySelector('[data-testid=check-selected]').disabled`), true)
    await searchAccounts('not-an-account', 0)
    assert.match(await evaluate('document.body.innerText'), /没有匹配的账号/)
    await check('check-all', ids)
    await searchAccounts('', 6)
    // Row actions must not toggle selection through the row click handler.
    const beforeRowCheck = calls.length
    await click('[data-account-id="paid-a"] .row-actions button')
    await idle()
    assert.deepEqual(calls.slice(beforeRowCheck), ['paid-a'])
    assert.equal(await evaluate(`document.querySelector('[data-account-id="paid-a"] input').checked`), false)
    const layout = await evaluate(`(() => {
      const list = document.querySelector('.account-list'), panel = document.querySelector('.free-panel')
      return { listBottom: list.getBoundingClientRect().bottom, panelBottom: panel.getBoundingClientRect().bottom, overflow: getComputedStyle(list).overflowY, headerBeforeList: document.querySelector('.subscription-header').getBoundingClientRect().bottom <= list.getBoundingClientRect().top + 1 }
    })()`)
    assert.equal(layout.overflow, 'auto')
    assert.equal(layout.headerBeforeList, true)
    assert.ok(Math.abs(layout.listBottom - layout.panelBottom) < 2, 'List should fill remaining page height')
    await evaluate('new Promise(resolve => setTimeout(() => requestAnimationFrame(() => resolve(true)), 350))')
    fs.writeFileSync(path.join(root, 'out/subscription-management-ui.png'), (await win.webContents.capturePage()).toPNG())

    await check('check-remaining', ['paid-a', 'paid-b', 'canceling', 'failed'])
    await select(['paid-a', 'free'])
    await check('check-selected', ['paid-a', 'free'])
    // Failed rechecks retain the old snapshot but become eligible for the remaining check action.
    failedIds.add('free')
    await select(['free'])
    await check('check-selected', ['free'])
    data = await records()
    assert.equal(data.free.status, 'error')
    assert.equal(data.free.renewal.state, 'free')
    assert.match(await evaluate(`document.querySelector('[data-account-id=free]').innerText`), /上次确认套餐/)
    await check('check-remaining', ['paid-a', 'paid-b', 'free', 'canceling', 'failed'])
    failedIds.delete('free')
    await check('check-selected', ['free'])

    // Browser reload and route remount both execute the real Vue component lifecycle.
    const beforeReload = await records()
    await win.reload()
    await waitFor(`document.querySelectorAll('.account-row').length === 6`, 'renderer reload')
    await idle()
    assert.deepEqual(await records(), beforeReload)
    await evaluate(`location.hash = '#/home'`)
    await waitFor(`!document.querySelector('.free-panel')`, 'leave subscription page')
    await evaluate(`location.hash = '#/subscription'`)
    await waitFor(`document.querySelectorAll('.account-row').length === 6`, 'route remount')
    assert.deepEqual(await records(), beforeReload)

    // A storage failure must be visible and block real-write controls, not claim durability.
    await evaluate(`window.__setItem = Storage.prototype.setItem; Storage.prototype.setItem = function(){ throw new Error('fixture quota failure') }; void 0`)
    await select(['paid-a'])
    await check('check-selected', ['paid-a'])
    assert.match(await evaluate('document.body.innerText'), /记录保存失败/)
    assert.equal(await evaluate(`document.querySelector('[data-testid=switch-selected]').disabled`), true)
    await evaluate(`Storage.prototype.setItem = window.__setItem; void 0`)
    await check('check-selected', ['paid-a'])
    // Failing only the pre-submit durable guard must prevent IPC, not merely disable the next button.
    await evaluate(`Storage.prototype.setItem = function(key, value) { if(key === '${KEY}' && JSON.parse(value).records['paid-a']?.needsCheck) throw new Error('fixture guard save failure'); return window.__setItem.call(this, key, value) }; void 0`)
    await click('[data-testid=switch-selected]')
    await idle()
    assert.equal(writes.length, 0, 'Failed durable guard must prevent the write IPC')
    assert.equal(await evaluate("!!document.querySelector('.ant-modal')"), false)
    assert.match(await evaluate('document.body.innerText'), /未提交订阅变更/)
    await evaluate('Storage.prototype.setItem = window.__setItem; void 0')
    await check('check-selected', ['paid-a'])
    await select(ids)
    await chooseFilter('subscription-arrangement-filter', '付费订阅', ['paid-a', 'paid-b'])
    assert.equal(writes.length, 0, 'Selection and filtering alone must never submit')
    // One explicit toolbar click starts the batch; a second click in the same tick must be ignored.
    await evaluate(`(() => {
      const button = document.querySelector('[data-testid=switch-selected]')
      if (button.disabled) throw new Error('Eligible switch unexpectedly disabled')
      button.click()
      button.click()
    })()`)
    await idle()
    assert.equal(await evaluate("!!document.querySelector('.ant-modal')"), false, 'No secondary confirmation dialog')
    assert.deepEqual(writes, ['paid-a', 'paid-b'])
    data = await records()
    assert.equal(data['paid-a'].renewal.state, 'scheduled-free')
    assert.equal(data['paid-a'].renewal.planName, 'Kiro Pro')
    assert.equal(data['paid-b'].needsCheck, true)
    await visibleIds([]) // Results leave the active paid-arrangement filter without interrupting the batch.
    await resetFilters()
    // A failed read must not unlock an uncertain write, even across process restart.
    failedIds.add('paid-b')
    await select(['paid-b'])
    await check('check-selected', ['paid-b'])
    assert.equal((await records())['paid-b'].needsCheck, true)
    assert.equal(await evaluate(`document.querySelector('[data-testid=switch-selected]').disabled`), true)
    assert.deepEqual(writes, ['paid-a', 'paid-b'])
    assert.deepEqual(accounts.map((a) => a.subscription.type), ['Pro', 'Pro', 'Free', 'Pro', 'Pro', 'Pro'])
    await chooseFilter('subscription-arrangement-filter', '待复核', ['paid-b'])
    await chooseFilter('subscription-plan-filter', 'Pro', ['paid-b'])
    await chooseFilter('subscription-arrangement-filter', '已安排转为 Free', ['paid-a', 'scheduled'])
    await evaluate('new Promise(resolve => setTimeout(() => requestAnimationFrame(() => resolve(true)), 350))')
    fs.writeFileSync(path.join(root, 'out/subscription-management-ui-filtered.png'), (await win.webContents.capturePage()).toPNG())
    await resetFilters()
  }
  // Verify wrapping in a narrower real Electron viewport too.
  win.setSize(1000, 860)
  await evaluate('new Promise(resolve => setTimeout(() => requestAnimationFrame(() => resolve(true)), 350))')
  assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true)
  assert.equal(await evaluate("document.querySelector('.subscription-page').scrollWidth <= document.querySelector('.subscription-page').clientWidth"), true)
  if (!restoring) fs.writeFileSync(path.join(root, 'out/subscription-management-ui-narrow.png'), (await win.webContents.capturePage()).toPNG())
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
