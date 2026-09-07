const { app, BrowserWindow, session, ipcMain } = require('electron')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const http = require('node:http')
const https = require('node:https')
const ts = require('typescript')
const root = path.resolve(__dirname, '../..')
const profile = path.resolve(process.argv[2])
assert.ok(profile.startsWith(path.join(root, 'out') + path.sep), 'isolated workspace profile only')
app.setPath('userData', profile)
app.getAppPath = () => root
app.disableHardwareAcceleration()
app.on('window-all-closed', () => {})
app.commandLine.appendSwitch('disable-background-networking')
app.commandLine.appendSwitch('host-resolver-rules', 'MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1, EXCLUDE ::1')
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true }
}).outputText, filename)
const { startBrowserProxyFixture } = require('../helpers/browser-proxy-fixture.cjs')
const tlsFixture = require('../helpers/browser-test-tls.cjs')
const reports = [], pageRequests = [], probeIps = []
let probeCounter = 10, manager, fixture, httpServer, httpsServer
const timer = setTimeout(() => { console.error('Browser integration timed out'); app.exit(1) }, 110000)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function until(check, label, timeout = 12000) {
  const end = Date.now() + timeout
  while (Date.now() < end) { if (await check()) return; await sleep(30) }
  throw new Error(`Timed out: ${label}`)
}
const active = (record) => record.tabs.get(record.activeTabId).view.webContents
async function loaded(contents, fragment) {
  await until(() => !contents.isDestroyed() && contents.getURL().includes(fragment) && !contents.isLoading(), fragment)
  await contents.executeJavaScript('document.readyState', true)
}
function target(req, res) {
  pageRequests.push({ host: req.headers.host, url: req.url, cookie: req.headers.cookie || '', ua: req.headers['user-agent'], language: req.headers['accept-language'] })
  if (req.url === '/trace') {
    res.writeHead(200, { 'content-type': 'text/plain', 'cache-control': 'no-store' })
    res.end(`ip=${probeIps.shift() || `198.51.100.${probeCounter++}`}\nloc=US\n`); return
  }
  if (req.url === '/redirect') { res.writeHead(302, { location: '/final?secret=fixture-temporary-url' }); res.end(); return }
  res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' })
  res.end(`<!doctype html><title>Local browser fixture</title><h1 id="page">Local fixture</h1><a id="manage" target="_blank" rel="opener" href="https://billing.stripe.com/fixture-manage">Manage plan</a><script>window.initialFingerprint={language:navigator.language,timezone:Intl.DateTimeFormat().resolvedOptions().timeZone};addEventListener('message',e=>window.fixtureMessage=e.data);</script>`)
}
async function listen(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return server.address().port
}
async function run() {
  httpServer = http.createServer(target); httpsServer = https.createServer(tlsFixture, target)
  const httpPort = await listen(httpServer), httpsPort = await listen(httpsServer)
  const allowedHosts = new Set(['probe.browser.invalid', 'tabs.browser.invalid', 'app.kiro.dev', 'billing.stripe.com', '127.0.0.1'])
  fixture = await startBrowserProxyFixture({ mapDestination({ host, port }) {
    return allowedHosts.has(host) ? { host: '127.0.0.1', port: port === 443 ? httpsPort : httpPort } : null
  } })
  const { BrowserManager } = require(path.join(root, 'src/main/browserManager.ts'))
  const { initializePortalSession } = require(path.join(root, 'src/main/kiroPortalSession.ts'))
  const accounts = ['alpha', 'beta'].map((id) => ({ id, email: `${id}@example.invalid`, idp: 'Google', profileArn: 'arn:fixture:profile',
    credentials: { accessToken: `fixture-only-access-${id}`, refreshToken: `fixture-only-refresh-${id}` } }))
  let config = { proxy: { enabled: true, host: '127.0.0.1', port: fixture.port, ...fixture.credentials },
    fingerprint: { userAgent: '', language: 'de-DE', timezone: 'America/New_York', width: 1280, height: 900 } }
  manager = new BrowserManager({ config: () => structuredClone(config), account: (id) => accounts.find((a) => a.id === id),
    hidden: true, probeUrl: 'http://probe.browser.invalid/trace', async initializeAccount(ses, account) {
      ses.setCertificateVerifyProc((request, callback) => {
        // ONLY this test session trusts the known local fixture certificate. No global bypass.
        const actual = request.certificate.data.replace(/\s/g, '')
        callback(allowedHosts.has(request.hostname) && actual === tlsFixture.cert.replace(/\s/g, '') ? 0 : -2)
      })
      await initializePortalSession(ses, account)
    }
  })
  ipcMain.handle('browser-chrome:state', (e) => manager.state(manager.chromeOwner(e)))
  ipcMain.handle('browser-chrome:command', async (e, command) => {
    try { await manager.command(manager.chromeOwner(e), command); return { success: true } }
    catch (error) { return { success: false, error: error.message } }
  })
  const background = session.fromPartition('fixture-background-subscription')
  await background.cookies.set({ url: 'https://app.kiro.dev', name: 'background-marker', value: 'keep' })
  const first = await manager.open({ accountId: 'alpha' })
  const a = manager.windows.get(first.id)
  await loaded(active(a), 'app.kiro.dev')
  assert.equal(await active(a).executeJavaScript('document.querySelector("#page").textContent'), 'Local fixture')
  assert.equal(await a.window.webContents.executeJavaScript('typeof window.api'), 'undefined')
  assert.equal(await active(a).executeJavaScript('typeof window.api + ":" + typeof require + ":" + typeof window.browserChrome'), 'undefined:undefined:undefined')
  const identity = await active(a).executeJavaScript('({language:navigator.language,languages:navigator.languages,timezone:Intl.DateTimeFormat().resolvedOptions().timeZone,ua:navigator.userAgent,cookies:document.cookie})')
  assert.equal(identity.language, 'de-DE'); assert.equal(identity.timezone, 'America/New_York')
  assert.ok(identity.ua.includes('Chrome/')); assert.ok(!identity.ua.includes('Electron/'))
  assert.ok(!identity.cookies.includes('fixture-only'))
  await active(a).executeJavaScript('localStorage.setItem("isolation", "alpha");')
  const second = await manager.open({ accountId: 'beta' })
  const b = manager.windows.get(second.id)
  await loaded(active(b), 'app.kiro.dev')
  assert.notEqual(a.resource.session, b.resource.session)
  assert.notEqual(first.exitIp, second.exitIp)
  assert.equal(await active(b).executeJavaScript('localStorage.getItem("isolation")'), null)
  const cookiesA = await a.resource.session.cookies.get({ url: 'https://app.kiro.dev' })
  const cookiesB = await b.resource.session.cookies.get({ url: 'https://app.kiro.dev' })
  assert.equal(cookiesA.find((c) => c.name === 'AccessToken').value, accounts[0].credentials.accessToken)
  assert.equal(cookiesB.find((c) => c.name === 'AccessToken').value, accounts[1].credentials.accessToken)
  assert.equal((await background.cookies.get({ name: 'background-marker' }))[0].value, 'keep')
  reports.push('distinct authenticated SOCKS exits, isolated accounts/cookies/storage, preserved background session, locale/UA/timezone applied')
  const original = active(a)
  await original.executeJavaScript('document.querySelector("#manage").click()', true)
  await until(() => a.tabs.size === 2, 'Manage plan opens a tab')
  const popup = active(a)
  await loaded(popup, 'billing.stripe.com')
  assert.equal(popup.session, a.resource.session)
  await a.tabs.get(a.activeTabId).ready
  assert.equal(await popup.executeJavaScript('Intl.DateTimeFormat().resolvedOptions().timeZone'), 'America/New_York')
  assert.equal(await popup.executeJavaScript('window.opener !== null'), true, 'popup opener semantics retained')
  await popup.executeJavaScript('window.opener.postMessage("fixture-popup-ok", "https://app.kiro.dev")')
  await until(async () => (await original.executeJavaScript('window.fixtureMessage')) === 'fixture-popup-ok', 'popup postMessage')
  const stripeRequest = pageRequests.find((r) => r.host === 'billing.stripe.com')
  assert.equal(stripeRequest.cookie, '', 'Kiro credentials never enter Stripe requests')
  assert.equal(popup.getLastWebPreferences().sandbox, true)
  assert.equal(popup.getLastWebPreferences().nodeIntegration, false)
  assert.equal(popup.getLastWebPreferences().preload, undefined)
  assert.equal(popup.getWebRTCIPHandlingPolicy(), 'disable_non_proxied_udp')
  await a.window.webContents.executeJavaScript('window.browserChrome.command({type:"navigate",url:"http://tabs.browser.invalid/redirect"})')
  await loaded(popup, '/final?secret=fixture-temporary-url')
  await until(async () => (await a.window.webContents.executeJavaScript('document.querySelector("#address").value')).includes('/final?secret='), 'address follows real redirects')
  assert.equal(manager.list().find((w) => w.id === first.id).activeOrigin, 'http://tabs.browser.invalid')
  assert.ok(!JSON.stringify(manager.list()).includes('fixture-temporary-url'))
  const invalid = await a.window.webContents.executeJavaScript('window.browserChrome.command({type:"navigate",url:"file:///C:/Windows/win.ini"})')
  assert.equal(invalid.success, false)
  await popup.executeJavaScript('window.open("kiro://fixture-forbidden")', true)
  await sleep(100)
  assert.equal(a.tabs.size, 2)
  assert.throws(() => manager.chromeOwner({ sender: popup, senderFrame: popup.mainFrame }), /无权/)
  assert.throws(() => manager.chromeOwner({ sender: a.window.webContents, senderFrame: {} }), /无权/)
  const popupId = a.activeTabId
  await manager.command(first.id, { type: 'new-tab' })
  assert.equal(a.tabs.size, 3)
  await manager.command(first.id, { type: 'close-tab', tabId: a.activeTabId })
  assert.equal(a.activeTabId, popupId)
  popup.sendInputEvent({ type: 'keyDown', keyCode: 'L', modifiers: ['control'] })
  popup.sendInputEvent({ type: 'keyUp', keyCode: 'L', modifiers: ['control'] })
  await until(async () => await a.window.webContents.executeJavaScript('document.activeElement.id === "address"'), 'Ctrl+L from page focus')
  fs.writeFileSync(path.join(root, 'out/browser-runtime.png'), (await a.window.capturePage()).toPNG())
  reports.push('real popup tab/opener, shared tab session, safe navigation, current address, tab close, keyboard focus, unprivileged pages')

  const beforeDuplicate = manager.list().length
  probeIps.push(second.exitIp, second.exitIp, second.exitIp)
  await assert.rejects(manager.open({}), /重复出口/)
  assert.equal(manager.list().length, beforeDuplicate)
  const goodPassword = config.proxy.password
  config.proxy.password = 'fixture-wrong-password'
  await assert.rejects(manager.open({}), /代理检测/)
  config.proxy.password = goodPassword
  assert.equal(manager.list().length, beforeDuplicate)
  reports.push('repeated exit and wrong SOCKS credentials block new windows')

  fixture.setMode('drop'); fixture.dropConnections()
  await a.resource.session.closeAllConnections()
  const directCount = pageRequests.filter((r) => r.url === '/no-direct').length
  await manager.command(first.id, { type: 'navigate', url: `http://127.0.0.1:${httpPort}/no-direct` })
  await until(() => manager.state(first.id).tabs.find((t) => t.id === a.activeTabId).error, 'proxy drop visible failure')
  assert.equal(pageRequests.filter((r) => r.url === '/no-direct').length, directCount, 'even loopback requests cannot bypass proxy')
  assert.ok(manager.state(first.id).tabs.find((t) => t.id === a.activeTabId).error.includes('未回退直连'))
  fixture.setMode('normal')
  const aSession = a.resource.session
  await manager.close(first.id)
  assert.equal(a.window.isDestroyed(), true)
  assert.equal((await aSession.cookies.get({})).length, 0)
  assert.equal((await b.resource.session.cookies.get({ name: 'AccessToken' }))[0].value, accounts[1].credentials.accessToken)
  await manager.close(second.id)
  await until(() => fixture.sockets.size === 0 && fixture.state.destinations.size === 0, 'all proxy sockets released')
  assert.deepEqual(fixture.state.failures, [])
  assert.ok(fixture.observedDestinations.every((r) => allowedHosts.has(r.host) || r.host === 'redirector.gvt1.com'), 'unknown requests must be refused locally')
  assert.ok(fixture.observedDestinations.some((r) => r.host === 'probe.browser.invalid' && r.addressType === 3), 'remote DNS verified')
  assert.equal(manager.list().length, 0)
  reports.push('proxy drop fails closed incl loopback, close clears only own data and destroys all SOCKS connections')
  await background.clearStorageData()
  fixture.setMode('stall-auth')
  const authCount = fixture.observedAuthentications.length
  const pendingCheck = manager.checkProxy()
  const cancelled = assert.rejects(pendingCheck, /已中断/)
  await until(() => fixture.observedAuthentications.length > authCount, 'pending check reaches SOCKS authentication')
  const shutdownStarted = Date.now()
  await manager.shutdown()
  await cancelled
  assert.ok(Date.now() - shutdownStarted < 4000, 'shutdown cancels rather than waiting for the probe deadline')
  await until(() => fixture.sockets.size === 0, 'shutdown frees pending check sockets')
  reports.push('shutdown cancels in-flight authenticated SOCKS probe and awaits cleanup')
  console.log(JSON.stringify({ result: 'PASS', reports, localProxyConnections: fixture.state.accepted,
    localHttpRequests: pageRequests.length, realExternalRequests: 0, realSubscriptionWrites: 0 }))
}
app.whenReady().then(async () => {
  let code = 0
  try { await run() } catch (error) { code = 1; console.error(error.stack || error); console.error('fixture counts', fixture?.state.accepted, fixture?.observedDestinations, fixture?.state.failures) }
  finally {
    await manager?.shutdown().catch(() => {})
    await fixture?.close().catch(() => {})
    for (const server of [httpServer, httpsServer]) { server?.closeAllConnections(); server?.close() }
    clearTimeout(timer)
    app.exit(code)
  }
})