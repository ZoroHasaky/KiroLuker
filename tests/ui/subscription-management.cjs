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
const ids = ['paid-high', 'paid-mid', 'paid-low', 'paid-fresh', 'free-tier', 'expired', 'link-ok', 'link-bad', 'link-net', 'link-paid']
// percentUsed: 42% / 30% / 2% / 0% — threshold 15 keeps only the first two switchable.
const percents = { 'paid-high': 0.42, 'paid-mid': 0.3, 'paid-low': 0.02, 'paid-fresh': 0, 'free-tier': 0.1, expired: 0.5, 'link-ok': 0, 'link-bad': 0, 'link-net': 0, 'link-paid': 0 }
const states = { 'paid-high': 'paid', 'paid-mid': 'paid', 'paid-low': 'paid', 'paid-fresh': 'paid' }
let accounts = ids.map((id) => ({
  id, email: `${id}@example.invalid`, idp: 'BuilderId', status: id === 'expired' ? 'expired' : 'active',
  credentials: { accessToken: 'fixture-only-access', refreshToken: 'fixture-only-refresh', expiresAt: Date.now() + 86400000 },
  subscription: { type: ['free-tier', 'link-ok', 'link-bad', 'link-net', 'link-paid'].includes(id) ? 'Free' : 'Pro', title: ['free-tier', 'link-ok', 'link-bad', 'link-net', 'link-paid'].includes(id) ? 'Kiro Free' : 'Kiro Pro' },
  usage: { current: ['link-ok', 'link-bad', 'link-net', 'link-paid'].includes(id) ? 0 : Math.round(percents[id] * 100), limit: 100, percentUsed: percents[id], lastUpdated: Date.now() },
  tagIds: [], paymentLink: id === 'link-paid' ? 'https://checkout.stripe.com/c/pay_fixture_existing' : '', isActive: false, createdAt: Date.now(), lastUsedAt: 0
}))
const deletions = []
const calls = [], linkWrites = [], switchWrites = [], unexpected = [], blockedNetwork = [], rendererErrors = []
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
  await waitFor(`JSON.stringify(Array.from(document.querySelectorAll('.account-row')).filter(el => el.offsetParent !== null).map(el => el.dataset.accountId)) === ${JSON.stringify(JSON.stringify(expectedIds))}`, 'filtered account IDs')
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
const linkPageReady = () => waitFor(`!!document.querySelector('[data-testid=fetch-links]')`, 'link page ready')
/** 提链与切Free 是两个独立页面；断言切Free 前，先从提链页导航到 #/free-switch。 */
async function showFreePage() {
  await evaluate(`location.hash = '#/free-switch'`)
  await waitFor(`(() => { const panel = document.querySelector('.free-panel'); return !!panel && panel.offsetParent !== null })()`, 'free page visible')
}
/** 切Free 页签分类：未切 / 已切 / 失败。 */
async function showTab(label) {
  await evaluate(`(() => { const tab = Array.from(document.querySelectorAll('.ant-tabs-tab')).find(t => t.textContent.includes(${JSON.stringify(label)})); if (!tab) throw new Error('tab missing: ' + ${JSON.stringify(label)}); tab.click() })()`)
  await new Promise((resolve) => setTimeout(resolve, 80))
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
    switchWrites.push(id)
    if (id === 'paid-mid') return ok({ status: 'unverified', previousPlan: 'Kiro Pro', warning: 'fixture: verification unavailable' })
    states[id] = 'scheduled-free'
    return ok({ status: 'scheduled', previousPlan: 'Kiro Pro', renewal: renewal(id) })
  }
  if (method === 'saveAccounts') {
    // 渲染层的保存是“快照对快照”；fixture 直接采纳提交快照并回显。
    const submitted = args[1]
    if (submitted && Array.isArray(submitted.accounts)) accounts = submitted.accounts
    return ok({ version: 2, accounts, tags: [], activeAccountId: null })
  }
  if (method === 'deleteAccounts') {
    const removedIds = new Set(args[0])
    accounts = accounts.filter((a) => !removedIds.has(a.id))
    for (const id of args[0]) deletions.push(id)
    return ok({ removed: args[0].length, accounts: { version: 2, accounts, tags: [], activeAccountId: null } })
  }
  if (method === 'getSubscriptionPlans') {
    await new Promise((resolve) => setTimeout(resolve, 30))
    return ok({ plans: [{ qSubscriptionType: 'PRO', name: 'Pro', description: { title: 'Kiro Pro（测试样本）' } }] })
  }
  if (method === 'createSubscriptionLink') {
    const id = args[0].id
    assert.ok(['link-ok', 'link-bad', 'link-net'].includes(id))
    linkWrites.push(id)
    await new Promise((resolve) => setTimeout(resolve, 35))
    if (id === 'link-bad') return { success: false, error: 'HTTP 403: profile not found（测试样本）' }
      if (id === 'link-net') return { success: false, error: '代理池获取 IP 失败：无法经可信代理访问代理池接口' }
    return ok({ url: 'https://checkout.stripe.com/c/pay_fixture_link_ok' })
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
  await win.loadFile(path.join(root, 'out/renderer/index.html'), { hash: '/link-extraction' })
  await linkPageReady()
  if (!restoring) {
    // 提链 tab（默认）：已生成支付链接的账号不再出现在待提链；提链失败的账号被直接删除。
    await waitFor(`(() => { const t = Array.from(document.querySelectorAll('.account-pick-item'), el => el.innerText).join('|'); return t.includes('link-ok@') && t.includes('link-bad@') && t.includes('link-net@') && !t.includes('link-paid@') })()`, 'eligible link accounts only')
    assert.match(await evaluate('document.body.innerText'), /待提链 3/)
    assert.match(await evaluate('document.body.innerText'), /待支付（已生成链接）1/)
        await evaluate(`Array.from(document.querySelectorAll('button')).find(b => b.textContent.includes('手动加载计划')).click()`)
    await waitFor(`!!document.querySelector('.plan-select')`, 'plans loaded')
    // 显式选择语义：不选任何账号时提取按钮禁用，点「全选」后可提取
        assert.equal(await evaluate(`document.querySelector('[data-testid=fetch-links]').disabled`), true, 'fetch button disabled without selection')
        await evaluate(`Array.from(document.querySelectorAll('.accounts-card button')).find(b => b.textContent.replace(' ', '') === '全选').click()`)
    await waitFor(`document.body.innerText.includes('已选 3 /')`, 'selection counted')
    await click('[data-testid=fetch-links]')
    await waitFor(`document.querySelectorAll('.link-row').length === 3 && !document.body.innerText.includes('提取中') && !document.body.innerText.includes('正在等待提链')`, 'link batch settled')
    assert.match(await evaluate(`document.querySelector('.link-row[data-account-id=link-ok]').innerText`), /成功/)
    assert.match(await evaluate(`document.querySelector('.link-row[data-account-id=link-ok]').innerText`), /pay_fixture_link_ok/)
    assert.match(await evaluate(`document.querySelector('.link-row[data-account-id=link-bad]').innerText`), /账号已删除/)
    assert.deepEqual([...linkWrites].sort(), ['link-bad', 'link-net', 'link-ok'])
    assert.deepEqual(deletions, ['link-bad'])
    assert.equal(await evaluate(`!!document.querySelector('.link-row[data-account-id=link-bad] button')`), false, 'Deleted account must not offer a retry button')
    assert.match(await evaluate(`document.querySelector('.link-row[data-account-id=link-net]').innerText`), /无法经可信代理访问代理池接口/)
    assert.equal(await evaluate(`!!document.querySelector('.link-row[data-account-id=link-net] button')`), true, 'Network failure must keep account and retry button')
    assert.equal(deletions.includes('link-net'), false, 'Network failure must not delete the account')
    // 成功写入支付链接（待支付）+ 失败删除后，待提链清零。
    await waitFor(`document.body.innerText.includes('待提链 1')`, 'only network-failed account remains')
    assert.match(await evaluate(`document.querySelector('.account-pick-item').innerText`), /link-net@/)
    await waitFor(`document.querySelectorAll('.account-pick-item').length === 1`, 'pick list keeps network-failed account')
  }
  await showFreePage()
  if (restoring) {
    // Fresh process: 未切 empty; persisted records keep 已切/失败 分类。
    await visibleIds([])
    await waitFor(`document.querySelector('.free-panel .threshold-input input').value === '15'`, 'persisted threshold')
    const data = await records()
    assert.equal(data['paid-high'].renewal.state, 'scheduled-free')
    assert.equal(data['paid-high'].needsCheck, false)
    assert.equal(data['paid-mid'].needsCheck, true)
    assert.equal(await evaluate(`document.querySelector('[data-testid=switch-selected]').disabled`), true)
    await showTab('已切')
    await visibleIds(['paid-high'])
    assert.match(await evaluate(`document.querySelector('[data-account-id=paid-high]').innerText`), /切换成功/)
    await showTab('失败')
    await visibleIds(['paid-mid'])
    assert.match(await evaluate(`document.querySelector('[data-account-id=paid-mid]').innerText`), /需关注/)
    await showTab('未切')
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
    assert.equal(switchWrites.length, 0, 'Failed durable guard must prevent the write IPC')
    assert.match(await evaluate('document.body.innerText'), /记录保存失败/)
    assert.equal(await evaluate(`document.querySelector('[data-testid=switch-selected]').disabled`), true)
    await evaluate('Storage.prototype.setItem = window.__setItem; void 0')
    await win.reload()
    await idle()
    await showFreePage()
    await visibleIds(['paid-high', 'paid-mid'])

    // Batch switch: rows move from 未切 to 已切 tab with their outcome.
    await click('input[data-testid=select-all], [data-testid=select-all] input')
    await waitFor(`!document.querySelector('[data-testid=switch-selected]').disabled`, 'switch button enabled')
    await click('[data-testid=switch-selected]')
    await idle()
    assert.deepEqual(switchWrites, ['paid-high', 'paid-mid'])
    assert.equal(maxActive, 1, 'Checks must stay sequential')
    assert.match(await evaluate('document.body.innerText'), /待切Free 0/)
    await visibleIds([])
    await showTab('已切')
    await visibleIds(['paid-high', 'paid-mid'])
    assert.match(await evaluate(`document.querySelector('[data-account-id=paid-high]').innerText`), /切换成功/)
    assert.match(await evaluate(`document.querySelector('[data-account-id=paid-mid]').innerText`), /需关注/)
    assert.equal(await evaluate(`document.querySelector('[data-account-id=paid-high] input[type=checkbox]').disabled`), true)
    const data = await records()
    assert.equal(data['paid-high'].renewal.state, 'scheduled-free')
    assert.equal(data['paid-high'].needsCheck, false)
    assert.equal(data['paid-mid'].needsCheck, true)
    await showTab('失败')
    await visibleIds([], 'no failed records in this batch')
    await showTab('已切')
    await evaluate('new Promise(resolve => setTimeout(() => requestAnimationFrame(() => resolve(true)), 350))')
    fs.writeFileSync(path.join(root, 'out/subscription-management-ui.png'), (await win.webContents.capturePage()).toPNG())

    // 已切 classification is independent of the threshold; the threshold keeps filtering only 未切.
    await setThreshold(50)
    await visibleIds(['paid-high', 'paid-mid'])
    await setThreshold(15)

    // Renderer reload keeps persisted classification: settled stays 已切, unverified goes to 失败.
    const beforeReload = await records()
    await win.reload()
    await idle()
    await showFreePage()
    await visibleIds([])
    await showTab('已切')
    await visibleIds(['paid-high'])
    await showTab('失败')
    await visibleIds(['paid-mid'])
    await showTab('未切')
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
  assert.equal(await evaluate("document.querySelector('.free-switch-page').scrollWidth <= document.querySelector('.free-switch-page').clientWidth"), true)
  assert.deepEqual(unexpected, [])
  assert.deepEqual(blockedNetwork, [], 'No external network should be requested')
  assert.deepEqual(rendererErrors, [])
  win.webContents.session.flushStorageData()
  console.log(JSON.stringify({ phase: restoring ? 'process-restart' : 'ui-interactions', readCalls: calls.length, linkWrites: linkWrites.length, switchWrites: switchWrites.length, realRequests: 0, result: 'PASS' }))
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
