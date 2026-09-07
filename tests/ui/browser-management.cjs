// Isolated frontend test runner. No application main/preload, real credentials, or external network.
const { app, BrowserWindow, ipcMain, nativeTheme } = require('electron')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { fileURLToPath } = require('node:url')
const root = path.resolve(__dirname, '../..')
const output = path.join(root, 'out/browser-management-ui')
fs.mkdirSync(output, { recursive: true })
const profile = path.resolve(process.argv[2] || fs.mkdtempSync(path.join(output, 'profile-')))
assert.ok(profile.startsWith(output + path.sep), 'Fixture profile must stay under out/browser-management-ui')
app.setPath('userData', profile)
app.disableHardwareAcceleration()
app.commandLine.appendSwitch('force-device-scale-factor', '1')
const clone = (value) => structuredClone(value)
const ok = (data) => ({ success: true, data })
const calls = [], commands = [], errors = [], blockedNetwork = [], unsubscribes = [], unexpected = []
let fixtureAccounts = [{
  id: 'fixture-account', email: 'fixture@example.invalid', nickname: 'Fixture account', idp: 'BuilderId', status: 'active',
  credentials: { accessToken: 'fixture-only-access', refreshToken: 'fixture-only-refresh', expiresAt: Date.now() + 86400000 },
  subscription: { type: 'Free', title: 'Kiro Free' }, usage: { current: 0, limit: 100, percentUsed: 0, lastUpdated: 1 },
  tagIds: [], paymentLink: '', isActive: false, createdAt: 1, lastUsedAt: 0
}]
let settings = { autoRefresh: false, autoRefreshUsage: false, darkMode: false, privacyMode: true, trayEnabled: false, proactiveRenewalEnabled: false }
let config = {
  proxy: { enabled: true, host: 'proxy.example.invalid', port: 1080, username: '', passwordSet: true },
  fingerprint: { language: 'zh-CN', timezone: 'Asia/Shanghai', userAgent: '', width: 1280, height: 900 }
}
let windows = [{ id: 'fixture-window', accountId: 'fixture-account', label: '主进程隐私标签', createdAt: 1, tabCount: 2, activeOrigin: 'https://example.invalid', proxyEnabled: true, exitIp: '203.0.113.5', country: '测试地区' }]
let view, chrome, failCheck = false, failOpen = false, failSave = false, failConfig = false, deferredWindows
let state = {
  windowId: 'fixture-chrome', label: '主进程浏览器标签', proxyEnabled: true, exitIp: '203.0.113.5', country: '测试地区', activeTabId: 'first',
  tabs: [
    { id: 'first', title: '<img src=x onerror="window.injected=true">', url: 'https://example.invalid/actual?value=<untrusted>', loading: false, canGoBack: true, canGoForward: false },
    { id: 'second', title: '第二页', url: 'https://second.invalid/', loading: false, canGoBack: false, canGoForward: false }
  ]
}
let nextTab = 0
ipcMain.on('fixture-unsubscribe', (_event, channel) => unsubscribes.push(channel))
ipcMain.handle('fixture-browser-api', async (_event, method, args) => {
  calls.push({ method, args: clone(args) })
  if (method === 'getSettings') return ok(clone(settings))
  if (method === 'saveSettings') { settings = { ...settings, ...args[0] }; return ok(clone(settings)) }
  if (method === 'getAppInfo') return ok({ version: '1.2.9', platform: 'win32', arch: 'x64', name: 'Browser UI fixture' })
  if (method === 'loadAccounts') return ok({ version: 2, accounts: clone(fixtureAccounts), tags: [], activeAccountId: null })
  if (method === 'getActiveKiroToken') return ok(null)
  if (method === 'syncTray') return ok()
  if (method === 'getUpdateState') return ok({ mode: 'manual', status: 'idle', current: '1.2.9', latest: '', percent: 0, transferred: 0, total: 0, bytesPerSecond: 0, message: '' })
  if (method === 'checkUpdate') return ok({ current: '1.2.9', latest: '1.2.9', hasUpdate: false, releaseUrl: '', name: '', notes: '', publishedAt: '' })
  if (method === 'getBrowserConfig') return failConfig ? { success: false, error: '读取失败测试' } : ok(clone(config))
  if (method === 'saveBrowserConfig') {
    if (failSave) return { success: false, error: '保存失败测试' }
    const patch = args[0]
    config = { proxy: { ...config.proxy, ...patch.proxy, passwordSet: Object.hasOwn(patch.proxy, 'password') ? patch.proxy.password !== '' : config.proxy.passwordSet }, fingerprint: clone(patch.fingerprint) }
    delete config.proxy.password
    return ok(clone(config))
  }
  if (method === 'checkBrowserProxy') return failCheck ? { success: false, error: '验证失败测试' } : ok({ ip: '203.0.113.9', country: '测试地区', checkedAt: 1, latencyMs: 27 })
  if (method === 'getBrowserWindows') {
    if (deferredWindows === true) return new Promise((resolve) => { deferredWindows = resolve })
    return ok(clone(windows))
  }
  if (method === 'openBrowserWindow') return failOpen ? { success: false, error: '重复出口，三次尝试后拒绝打开' } : ok(clone(windows[0]))
  if (method === 'focusBrowserWindow') return ok()
  if (method === 'closeBrowserWindow') {
    windows = windows.filter((item) => item.id !== args[0])
    view.webContents.send('fixture-windows', clone(windows))
    return ok()
  }
  unexpected.push(method); throw new Error(`Unexpected method: ${method}`)
})
ipcMain.handle('fixture-chrome-state', async (event) => {
  const stale = clone(state)
  stale.tabs[0].title = '过时快照'
  await new Promise((resolve) => setTimeout(resolve, 30))
  event.sender.send('fixture-chrome-push', clone(state))
  await new Promise((resolve) => setTimeout(resolve, 30))
  return stale
})
ipcMain.handle('fixture-chrome-command', (_event, command) => {
  commands.push(clone(command))
  if (command.type === 'navigate') {
    if (command.url.startsWith('javascript:')) return { success: false, error: '<b>禁止的协议</b>' }
    Object.assign(state.tabs.find((tab) => tab.id === state.activeTabId), { url: command.url, loading: false, error: undefined })
  } else if (command.type === 'new-tab') {
    const id = `new-${++nextTab}`
    state.tabs.push({ id, title: '新标签页', url: 'about:blank', loading: false, canGoBack: false, canGoForward: false })
    state.activeTabId = id
  } else if (command.type === 'activate-tab') state.activeTabId = command.tabId
  else if (command.type === 'close-tab') {
    state.tabs = state.tabs.filter((tab) => tab.id !== command.tabId)
    if (state.activeTabId === command.tabId) state.activeTabId = state.tabs[0]?.id || ''
  } else if (command.type === 'stop') state.tabs.find((tab) => tab.id === state.activeTabId).loading = false
  chrome.webContents.send('fixture-chrome-push', clone(state))
  return { success: true }
})
const evaluate = (win, code) => win.webContents.executeJavaScript(code, true)
async function wait(win, expression, label) {
  const until = Date.now() + 12000
  while (Date.now() < until) {
    if (await evaluate(win, expression)) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(`Timeout: ${label}: ${await evaluate(win, 'document.body.innerText.slice(0,2000)')}`)
}
async function click(win, selector) {
  await evaluate(win, `(() => { const element = document.querySelector(${JSON.stringify(selector)}); if (!element || element.disabled) throw new Error('Missing or disabled: ${selector}'); element.click() })()`)
}
async function input(win, selector, value) {
  await evaluate(win, `(() => { const element = document.querySelector(${JSON.stringify(selector)}); element.focus(); const setter = Object.getOwnPropertyDescriptor(element.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value').set; setter.call(element, ${JSON.stringify(value)}); element.dispatchEvent(new Event('input', { bubbles:true })); element.dispatchEvent(new Event('change', { bubbles:true })); })()`)
}
async function shortcut(key, modifiers = {}) {
  const count = commands.length
  await evaluate(chrome, `document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(key)}, bubbles:true, cancelable:true, ...${JSON.stringify(modifiers)} }))`)
  return count
}
async function save() {
  const count = calls.filter((call) => call.method === 'saveBrowserConfig').length
  await click(view, '[data-testid="save-browser-config"]')
  const deadline = Date.now() + 12000
  while (calls.filter((call) => call.method === 'saveBrowserConfig').length === count && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25))
  await new Promise((resolve) => setTimeout(resolve, 40))
  await wait(view, '!document.querySelector("[data-testid=save-browser-config]").classList.contains("ant-btn-loading")', 'save complete')
  assert.equal(calls.filter((call) => call.method === 'saveBrowserConfig').length, count + 1)
  return calls.filter((call) => call.method === 'saveBrowserConfig').at(-1).args[0]
}
async function capture(win, name, rect) {
  win.webContents.invalidate()
  await evaluate(win, 'new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
  await new Promise((resolve) => setTimeout(resolve, 100))
  fs.writeFileSync(path.join(output, name), (await win.webContents.capturePage(rect, { stayHidden: true, stayAwake: true })).toPNG())
}
function makeWindow(chromeMode = false) {
  const win = new BrowserWindow({ show: false, width: 1200, height: 1100, webPreferences: {
    preload: path.join(__dirname, 'browser-management-preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true,
    partition: `fixture-${chromeMode ? 'chrome' : 'view'}-${Date.now()}`, additionalArguments: chromeMode ? ['--fixture-chrome'] : [], backgroundThrottling: false, offscreen: true
  } })
  win.webContents.on('console-message', ({ level, message }) => { if (level === 'warning' || level === 'error') errors.push(message) })
  win.webContents.on('render-process-gone', (_event, details) => errors.push(`Renderer gone: ${details.reason}`))
  win.webContents.session.webRequest.onBeforeRequest((details, callback) => {
    const allowed = ['file:', 'data:', 'devtools:'].some((scheme) => details.url.startsWith(scheme))
    if (!allowed) blockedNetwork.push(details.url)
    callback({ cancel: !allowed })
  })
  return win
}
app.whenReady().then(async () => {
  view = makeWindow()
  await view.loadFile(path.join(root, 'out/renderer/index.html'), { hash: '/browser' })
  await wait(view, '!!document.querySelector("[data-testid=open-anonymous-browser]") && !document.querySelector("[data-testid=open-anonymous-browser]").disabled', 'management initialized')
  assert.equal(await evaluate(view, 'document.querySelector("#browser-proxy-password").value'), '')
  assert.match(await evaluate(view, 'document.querySelector("#browser-proxy-password").placeholder'), /已保存密码/)
  assert.match(await evaluate(view, 'document.querySelector("[data-testid=browser-windows-table]").innerText'), /主进程隐私标签/)
  assert.equal(await evaluate(view, 'document.body.innerText.includes("fixture@example.invalid")'), false)
  assert.equal(await evaluate(view, 'document.querySelector("[data-testid=open-account-browser]").disabled'), true)
  assert.match(await evaluate(view, 'document.body.innerText'), /系统网络.*系统代理/s)
  await input(view, '#browser-proxy-host', 'proxy-updated.example.invalid')
  assert.equal(await evaluate(view, 'document.querySelector("[data-testid=open-anonymous-browser]").disabled'), true, 'unsaved proxy change must not start with old settings')
  assert.equal(await evaluate(view, 'document.querySelector("[data-testid=test-browser-proxy]").disabled'), true)
  let patch = await save()
  assert.equal(Object.hasOwn(patch.proxy, 'password'), false, 'blank preserves saved secret')
  await input(view, '#browser-proxy-password', 'fixture-only-password')
  patch = await save()
  assert.equal(patch.proxy.password, 'fixture-only-password')
  assert.equal(await evaluate(view, 'document.querySelector("#browser-proxy-password").value'), '', 'secret draft cleared after save')
  await click(view, '[data-testid="clear-proxy-password"]')
  await wait(view, 'document.querySelector("#browser-proxy-password").disabled', 'clear password selected')
  await click(view, '[data-testid="clear-proxy-password"]')
  await wait(view, 'document.querySelector("[data-testid=save-browser-config]").disabled', 'clear cancellation restores clean state')
  await click(view, '[data-testid="clear-proxy-password"]')
  patch = await save()
  assert.equal(patch.proxy.password, '', 'explicit clear is the only empty secret patch')
  assert.equal(await evaluate(view, 'document.querySelector("#browser-proxy-password").placeholder'), '未设置密码')
  const invalidActions = ['save-browser-config', 'test-browser-proxy', 'open-anonymous-browser', 'open-account-browser']
  async function invalidDraft(selector, value, message) {
    await input(view, selector, value)
    await wait(view, `document.querySelector('[data-testid=browser-validation-error]')?.innerText.includes(${JSON.stringify(message)})`, 'invalid draft warning')
    for (const testId of invalidActions) {
      assert.equal(await evaluate(view, `document.querySelector('[data-testid=${testId}]').disabled`), true, `${testId} disabled for invalid draft`)
    }
    const before = calls.length
    await evaluate(view, 'document.querySelector("form").requestSubmit()')
    await new Promise((resolve) => setTimeout(resolve, 40))
    assert.equal(calls.length, before, 'invalid draft never sent even with programmatic submit')
  }
  await invalidDraft('#browser-language', 'not_a_language', '语言标签无效')
  await input(view, '#browser-language', 'zh-CN')
  await invalidDraft('#browser-timezone', 'Not/A_Timezone', '时区无效')
  await input(view, '#browser-timezone', 'Asia/Shanghai')
  await invalidDraft('#browser-proxy-host', 'socks5://invalid.example.invalid:1080', '主机名或 IP')
  await input(view, '#browser-proxy-host', 'proxy-updated.example.invalid')
  await invalidDraft('#browser-width', '899', '900–2400')
  await input(view, '#browser-width', '1280')
  await input(view, '#browser-proxy-host', 'unsaved.example.invalid')
  assert.equal(await evaluate(view, 'document.querySelector("[data-testid=test-browser-proxy]").disabled'), true)
  assert.equal(config.proxy.host, 'proxy-updated.example.invalid', 'draft never changes the active proxy implicitly')
  await save()
  await click(view, '[data-testid="test-browser-proxy"]')
  await wait(view, '!!document.querySelector("[data-testid=browser-proxy-result]")', 'saved proxy check')
  assert.equal(config.proxy.host, 'unsaved.example.invalid')
  assert.deepEqual(calls.filter((call) => call.method === 'checkBrowserProxy').at(-1).args, [])
  assert.match(await evaluate(view, 'document.querySelector("[data-testid=browser-config-status]").innerText'), /所有新窗口/)
  failCheck = true
  await click(view, '[data-testid="test-browser-proxy"]')
  await wait(view, 'document.querySelector("[data-testid=browser-action-error]").innerText.includes("验证失败测试")', 'proxy check failure')
  assert.equal(await evaluate(view, '!!document.querySelector("[data-testid=browser-proxy-result]")'), false, 'failed check clears previous success')
  failCheck = false
  failSave = true
  await input(view, '#browser-proxy-host', 'pending.example.invalid')
  await save()
  assert.equal(await evaluate(view, 'document.querySelector("#browser-proxy-host").value'), 'pending.example.invalid', 'failed save retains draft')
  failSave = false
  await save()
  await click(view, '[data-testid="open-anonymous-browser"]')
  await wait(view, '!document.querySelector("[data-testid=open-anonymous-browser]").disabled', 'anonymous open')
  assert.deepEqual(calls.filter((call) => call.method === 'openBrowserWindow').at(-1).args, [{}])
  await evaluate(view, 'document.querySelector("[data-testid=browser-account-select] .ant-select-selector").dispatchEvent(new MouseEvent("mousedown", { bubbles:true }))')
  await wait(view, '!!document.querySelector(".ant-select-item-option")', 'account dropdown')
  assert.equal(await evaluate(view, 'document.querySelector(".ant-select-item-option").innerText.includes("fixture@example.invalid")'), false)
  await click(view, '.ant-select-item-option')
  await click(view, '[data-testid="open-account-browser"]')
  await wait(view, '!document.querySelector("[data-testid=open-account-browser]").disabled', 'account open')
  assert.deepEqual(calls.filter((call) => call.method === 'openBrowserWindow').at(-1).args, [{ accountId: 'fixture-account' }], 'only account id crosses browser API')
  failOpen = true
  await click(view, '[data-testid="open-anonymous-browser"]')
  await wait(view, 'document.querySelector("[data-testid=browser-action-error]").innerText.includes("三次尝试")', 'duplicate IP rejection is visible')
  failOpen = false
  await click(view, '[data-window-id="fixture-window"] [data-action="focus"]')
  await wait(view, '!document.querySelector("[data-action=focus]").disabled', 'focus complete')
  assert.deepEqual(calls.filter((call) => call.method === 'focusBrowserWindow').at(-1).args, ['fixture-window'])
  deferredWindows = true
  await click(view, '[data-testid="refresh-browser-windows"]')
  while (typeof deferredWindows !== 'function') await new Promise((resolve) => setTimeout(resolve, 10))
  windows = [{ ...windows[0], id: 'newer-window', label: '推送的新窗口', tabCount: 3 }]
  view.webContents.send('fixture-windows', clone(windows))
  await wait(view, '!!document.querySelector("[data-window-id=newer-window]")', 'window push')
  deferredWindows(ok([]))
  deferredWindows = undefined
  await wait(view, '!document.querySelector("[data-testid=refresh-browser-windows]").classList.contains("ant-btn-loading")', 'stale snapshot resolved')
  assert.equal(await evaluate(view, '!!document.querySelector("[data-window-id=newer-window]")'), true, 'push wins over stale list snapshot')
  await evaluate(view, 'document.querySelector(".ant-alert-close-icon")?.click()')
  await click(view, '.sidebar-footer .footer-btn')
  await wait(view, 'document.documentElement.classList.contains("dark")', 'main app dark mode')
  await wait(view, 'document.querySelectorAll(".ant-message-notice").length === 0', 'save notifications dismissed before screenshots')
  await capture(view, 'management-dark-wide.png')
  assert.notEqual(await evaluate(view, 'getComputedStyle(document.querySelector(".ant-card")).backgroundColor'), 'rgb(255, 255, 255)', 'Ant cards inherit dark theme')
  await click(view, '.sidebar-footer .footer-btn')
  await wait(view, '!document.documentElement.classList.contains("dark")', 'main app light mode')
  await capture(view, 'management-light-wide.png')
  view.setSize(740, 1100)
  await wait(view, 'window.innerWidth < 900', 'narrow viewport')
  assert.equal(await evaluate(view, 'document.querySelector(".config-grid").getBoundingClientRect().width <= window.innerWidth'), true)
  assert.equal(await evaluate(view, 'getComputedStyle(document.querySelector(".config-grid")).gridTemplateColumns.split(" ").length'), 1)
  await capture(view, 'management-narrow.png')
  await evaluate(view, 'document.querySelector(".app-content").scrollTop = document.querySelector(".app-content").scrollHeight')
  await capture(view, 'management-narrow-bottom.png')
  await click(view, '[data-window-id="newer-window"] [data-action="close"]')
  await wait(view, '!!document.querySelector(".ant-popconfirm .ant-btn-primary")', 'close confirmation')
  await click(view, '.ant-popconfirm .ant-btn-primary')
  await wait(view, '!document.querySelector("[data-window-id=newer-window]")', 'closed window removed')
  await evaluate(view, 'window.location.hash = "#/about"')
  await wait(view, '!document.querySelector("[data-testid=browser-view]")', 'route unmount')
  fixtureAccounts = []
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.ok(unsubscribes.includes('fixture-windows'), 'window listener unsubscribed')
  failConfig = true
  await view.loadFile(path.join(root, 'out/renderer/index.html'), { hash: '/browser' })
  await wait(view, 'document.body.innerText.includes("读取失败测试")', 'config loading failure')
  assert.equal(await evaluate(view, 'document.querySelector("[data-testid=open-anonymous-browser]").disabled'), true)
  failConfig = false
  await evaluate(view, '[...document.querySelectorAll("button")].find((button) => button.textContent.replaceAll(" ", "") === "重试").click()')
  await wait(view, '!document.querySelector("[data-testid=open-anonymous-browser]").disabled', 'config retry')
  assert.equal(await evaluate(view, 'document.querySelector("[data-testid=open-account-browser]").disabled'), true, 'empty accounts cannot open')
  console.log('PASS management: password preserve/write/explicit-clear/cancel, validation, saved-only testing, failure recovery, anonymous/account payloads, privacy, main labels, list race, focus/close, narrow/dark layout, cleanup')

  chrome = makeWindow(true)
  chrome.setSize(1000, 500)
  await chrome.loadFile(path.join(root, 'out/renderer/src/browser-chrome/index.html'))
  await wait(chrome, '!document.querySelector("#address").disabled', 'chrome initialized')
  await new Promise((resolve) => setTimeout(resolve, 100))
  const chromeDocument = await evaluate(chrome, `({
    csp: document.querySelector('meta[http-equiv="Content-Security-Policy"]').content,
    scripts: [...document.scripts].map((script) => script.src),
    styles: [...document.querySelectorAll('link[rel=stylesheet]')].map((link) => link.href),
    inlineHandlers: document.querySelectorAll('[onclick], [onerror], [onload]').length
  })`)
  assert.match(chromeDocument.csp, /default-src 'none'/)
  assert.match(chromeDocument.csp, /script-src 'self'/)
  assert.match(chromeDocument.csp, /form-action 'none'/)
  assert.match(chromeDocument.csp, /base-uri 'none'/)
  assert.match(chromeDocument.csp, /object-src 'none'/)
  assert.doesNotMatch(chromeDocument.csp, /unsafe-eval/)
  assert.equal(chromeDocument.inlineHandlers, 0)
  assert.ok(chromeDocument.scripts.length > 0 && chromeDocument.styles.length > 0)
  for (const url of [...chromeDocument.scripts, ...chromeDocument.styles]) {
    const asset = fileURLToPath(url)
    assert.ok(asset.startsWith(path.join(root, 'out/renderer/assets') + path.sep), 'Nested production HTML resolves assets inside renderer output')
    assert.ok(fs.existsSync(asset), `Built asset exists: ${asset}`)
  }
  assert.equal(await evaluate(chrome, 'document.querySelector(".tab-select").textContent'), state.tabs[0].title, 'new state wins over stale getState')
  assert.equal(await evaluate(chrome, '[...document.querySelectorAll(".tab")].every(tab => tab.getBoundingClientRect().right <= document.querySelector("#tabs").getBoundingClientRect().right)'), true, 'both initial tabs are visible without unnecessary clipping')
  assert.equal(await evaluate(chrome, 'document.querySelectorAll("#tabs img, #tabs script").length'), 0, 'title is text only')
  assert.equal(await evaluate(chrome, 'typeof window.api'), 'undefined', 'shell has no account/management API')
  assert.equal(await evaluate(chrome, 'document.title'), state.label)
  assert.equal(await evaluate(chrome, 'document.querySelector("#browser-chrome").getBoundingClientRect().height'), 112)
  assert.equal(await evaluate(chrome, 'document.querySelector(".status-bar").getBoundingClientRect().bottom <= 112'), true)
  assert.equal(await evaluate(chrome, 'document.querySelector("#address").value'), state.tabs[0].url)
  assert.equal(await evaluate(chrome, 'document.querySelector("#forward").disabled'), true)
  await input(chrome, '#address', 'https://draft.invalid/editing')
  state.tabs[0].url = 'https://redirect.invalid/final'
  state.tabs[0].title = '重定向已完成'
  chrome.webContents.send('fixture-chrome-push', clone(state))
  await new Promise((resolve) => setTimeout(resolve, 50))
  await wait(chrome, 'document.querySelector(".tab-select").textContent === "重定向已完成"', 'redirect push rendered')
  assert.equal(await evaluate(chrome, 'document.querySelector("#address").value'), 'https://draft.invalid/editing', 'redirect does not clobber editing')
  // Hidden BrowserWindows have no native focus; dispatch the focus event after changing activeElement.
  await evaluate(chrome, 'document.querySelector("#address").blur(); document.querySelector("#address").dispatchEvent(new FocusEvent("blur"))')
  assert.equal(await evaluate(chrome, 'document.querySelector("#address").value'), 'https://redirect.invalid/final', 'blur restores actual redirected URL')
  chrome.webContents.send('fixture-focus-address')
  await wait(chrome, 'document.activeElement.id === "address"', 'remote Ctrl+L callback')
  assert.equal(await evaluate(chrome, 'document.querySelector("#address").selectionEnd'), 'https://redirect.invalid/final'.length)
  await input(chrome, '#address', 'https://navigation.invalid/path')
  await evaluate(chrome, 'document.querySelector("#address-form").requestSubmit()')
  await wait(chrome, 'document.querySelector("#address").value === "https://navigation.invalid/path"', 'navigate actual URL')
  assert.deepEqual(commands.at(-1), { type: 'navigate', url: 'https://navigation.invalid/path' })
  await input(chrome, '#address', 'javascript:alert(1)')
  await evaluate(chrome, 'document.querySelector("#address-form").requestSubmit()')
  await wait(chrome, 'document.querySelector("#status").classList.contains("error")', 'command error')
  assert.equal(await evaluate(chrome, 'document.querySelector("#status").textContent'), '<b>禁止的协议</b>')
  assert.equal(await evaluate(chrome, 'document.querySelector("#status b")'), null, 'error is text only')
  await click(chrome, '#new-tab')
  await wait(chrome, 'document.querySelectorAll(".tab").length === 3', 'new tab button')
  assert.equal(state.activeTabId, 'new-1')
  await click(chrome, '[data-tab-id="first"] .tab-select')
  await wait(chrome, 'document.querySelector("[data-tab-id=first]").classList.contains("active")', 'switch tab')
  await click(chrome, '[data-tab-id="new-1"] .tab-close')
  await wait(chrome, 'document.querySelectorAll(".tab").length === 2', 'close tab button')
  await click(chrome, '#reload')
  assert.equal(commands.at(-1).type, 'reload')
  state.tabs[0].loading = true
  chrome.webContents.send('fixture-chrome-push', clone(state))
  await wait(chrome, 'document.querySelector("#reload").getAttribute("aria-label") === "停止加载"', 'loading toggles stop')
  await click(chrome, '#reload')
  await wait(chrome, 'document.querySelector("#reload").getAttribute("aria-label") === "重新加载"', 'stop command')
  assert.equal(commands.at(-1).type, 'stop')
  await shortcut('ArrowLeft', { altKey: true })
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.equal(commands.at(-1).type, 'back')
  const beforeForward = commands.length
  await shortcut('ArrowRight', { altKey: true })
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.equal(commands.length, beforeForward, 'disabled forward ignored')
  state.tabs[0].canGoForward = true
  chrome.webContents.send('fixture-chrome-push', clone(state))
  await wait(chrome, '!document.querySelector("#forward").disabled', 'forward ready')
  await shortcut('ArrowRight', { altKey: true })
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.equal(commands.at(-1).type, 'forward')
  await shortcut('t', { ctrlKey: true })
  await wait(chrome, 'document.querySelectorAll(".tab").length === 3', 'Ctrl+T')
  await shortcut('w', { ctrlKey: true })
  await wait(chrome, 'document.querySelectorAll(".tab").length === 2', 'Ctrl+W')
  await shortcut('l', { ctrlKey: true })
  assert.equal(await evaluate(chrome, 'document.activeElement.id'), 'address')
  await input(chrome, '#address', 'unsaved edit')
  await shortcut('Escape')
  assert.equal(await evaluate(chrome, 'document.querySelector("#address").value'), state.tabs[0].url)
  // Hidden BrowserWindows have no native focus; dispatch the focus event after changing activeElement.
  await evaluate(chrome, 'document.querySelector("#address").blur(); document.querySelector("#address").dispatchEvent(new FocusEvent("blur"))')
  state.tabs[0].error = '页面加载失败 <script>恶意文本</script>'
  chrome.webContents.send('fixture-chrome-push', clone(state))
  await wait(chrome, 'document.querySelector("#status").textContent.includes("页面加载失败")', 'page error')
  assert.equal(await evaluate(chrome, 'document.querySelector("#status script")'), null)
  state.tabs[0].error = undefined
  state.proxyEnabled = false
  chrome.webContents.send('fixture-chrome-push', clone(state))
  await wait(chrome, 'document.querySelector("#proxy-status").textContent.includes("系统网络出口")', 'system network wording')
  nativeTheme.themeSource = 'dark'
  await new Promise((resolve) => setTimeout(resolve, 100))
  await capture(chrome, 'chrome-dark-wide.png', { x: 0, y: 0, width: 1000, height: 112 })
  nativeTheme.themeSource = 'light'
  await new Promise((resolve) => setTimeout(resolve, 100))
  await capture(chrome, 'chrome-light-wide.png', { x: 0, y: 0, width: 1000, height: 112 })
  chrome.setSize(600, 500)
  await wait(chrome, 'window.innerWidth < 620', 'narrow chrome viewport')
  assert.equal(await evaluate(chrome, 'document.querySelector("#browser-chrome").getBoundingClientRect().height'), 112)
  assert.equal(await evaluate(chrome, 'document.querySelector(".address-toolbar").scrollWidth <= window.innerWidth'), true)
  await capture(chrome, 'chrome-narrow.png', { x: 0, y: 0, width: 600, height: 112 })
  await evaluate(chrome, 'window.dispatchEvent(new Event("unload"))')
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.ok(unsubscribes.includes('fixture-chrome-push'))
  assert.ok(unsubscribes.includes('fixture-focus-address'))
  console.log('PASS chrome: exact production path/112px, minimal bridge only, state race, untrusted text, actual redirected URL, editing protection, remote focus callback, all commands/shortcuts, errors, system network, light/dark/narrow, unsubscribe')
  assert.deepEqual(blockedNetwork, [], 'no external network requests')
  assert.deepEqual(errors, [], 'no renderer console errors/warnings')
  assert.deepEqual(unexpected, [], 'no unexpected or account-credential operations')
  fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify({ result: 'PASS', managementCalls: calls.length, chromeCommands: commands.length, errors, blockedNetwork, unsubscribes }, null, 2))
  console.log('PASS: isolated fixtures only; no application store/real credentials/network accessed.')
  app.exit(0)
}).catch((error) => { console.error(error); console.error('Renderer issues:', errors); console.error('Unexpected API:', unexpected); app.exit(1) })