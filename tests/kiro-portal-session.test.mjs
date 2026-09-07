import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import vm from 'node:vm'
import { EventEmitter } from 'node:events'
import ts from 'typescript'
import * as portalLocale from '../src/shared/portalLocale.ts'

// Run the actual TypeScript with strictly mocked imports: no Electron process or network.
const sources = new Map(await Promise.all(['kiroPortalSession', 'kiroPortal'].map(async (name) => {
  const file = new URL(`../src/main/${name}.ts`, import.meta.url)
  const source = await fs.readFile(file, 'utf8')
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  })
  return [name, outputText]
})))

function loadModule(name, imports, extra = {}) {
  const exports = {}
  vm.runInNewContext(sources.get(name), {
    exports,
    require(id) {
      assert.ok(Object.hasOwn(imports, id), `Unexpected real dependency: ${id}`)
      return imports[id]
    },
    ...extra
  }, { filename: `${name}.ts` })
  return exports
}

function loadHelper({ profiles = async () => [], versions = {}, platform = 'win32' } = {}) {
  const lookups = []
  const logs = []
  const api = loadModule('kiroPortalSession', {
    '../shared/portalLocale': portalLocale,
    './kiroApi': {
      async listAvailableProfiles(...args) {
        lookups.push(args)
        return profiles(...args)
      }
    }
  }, {
    process: { versions, platform },
    console: { info: (...args) => logs.push(args.join(' ')) }
  })
  return { api, lookups, logs }
}

function account(idp = 'BuilderId', overrides = {}) {
  const { credentials, ...rest } = overrides
  return {
    id: `test-${idp}`,
    email: 'fixture@example.invalid',
    idp,
    credentials: {
      accessToken: `fake-access-${idp}`,
      refreshToken: `fake-refresh-${idp}`,
      expiresAt: 0,
      region: 'us-east-1',
      ...credentials
    },
    ...rest
  }
}

class FakeSession {
  userAgent = 'Original app Electron/35.7.5'
  language = ''
  userAgentCalls = []
  headerListeners = []
  events = []
  cookieJar = new Map([['old-cookie', 'old-value']])
  localStorage = new Map([['unrelated-setting', 'keep']])
  cookies = {
    set: async (cookie) => {
      this.events.push(['set', structuredClone(cookie)])
      this.cookieJar.set(cookie.name, cookie.value)
    }
  }
  webRequest = {
    onBeforeSendHeaders: (listener) => {
      this.headerListeners.push(listener)
      this.headerListener = listener
    }
  }
  setUserAgent(ua, language) {
    this.userAgent = ua
    this.language = language
    this.userAgentCalls.push([ua, language])
  }
  getUserAgent() { return this.userAgent }
  async clearStorageData(options) {
    this.events.push(['clear', structuredClone(options)])
    assert.deepEqual(structuredClone(options), { storages: ['cookies'] })
    this.cookieJar.clear()
  }
  requestHeaders(headers) {
    let result
    let callbacks = 0
    this.headerListener({ requestHeaders: headers }, (response) => {
      callbacks++
      result = structuredClone(response.requestHeaders)
    })
    assert.equal(callbacks, 1)
    return result
  }
}

function assertCookies(ses, user, arn) {
  const expected = [
    ['Idp', user.idp],
    ['AccessToken', user.credentials.accessToken],
    ['RefreshToken', user.credentials.refreshToken],
    ['ProfileArn', arn]
  ].filter(([, value]) => !!value)
  assert.deepEqual([...ses.cookieJar], expected)
  assert.deepEqual(ses.events, [
    ['clear', { storages: ['cookies'] }],
    ...expected.map(([name, value]) => ['set', {
      url: 'https://app.kiro.dev', name, value, domain: 'app.kiro.dev', path: '/',
      secure: true, httpOnly: true, sameSite: 'lax'
    }])
  ])
  assert.deepEqual([...ses.localStorage], [['unrelated-setting', 'keep']])
}

test('Chrome UA tolerates Node without Chromium and uses the actual Chromium major when present', () => {
  for (const [versions, major] of [[{}, '134'], [{ chrome: '' }, '134'], [{ chrome: '142.0.7444.52' }, '142']]) {
    for (const [platform, token, brand] of [
      ['win32', 'Windows NT 10.0; Win64; x64', 'Windows'],
      ['darwin', 'Macintosh; Intel Mac OS X 10_15_7', 'macOS'],
      ['linux', 'X11; Linux x86_64', 'Linux']
    ]) {
      const { api } = loadHelper({ versions, platform })
      const ses = new FakeSession()
      api.configurePortalSession(ses)
      assert.equal(api.KIRO_PORTAL_ORIGIN, 'https://app.kiro.dev')
      assert.equal(ses.userAgent, `Mozilla/5.0 (${token}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`)
      const headers = ses.requestHeaders({})
      assert.equal(headers['User-Agent'], ses.userAgent)
      assert.equal(headers['sec-ch-ua'], `"Chromium";v="${major}", "Not(A:Brand";v="24", "Google Chrome";v="${major}"`)
      assert.equal(headers['sec-ch-ua-mobile'], '?0')
      assert.equal(headers['sec-ch-ua-platform'], `"${brand}"`)
    }
  }
})

test('configuration and locale changes preserve each session identity and rewrite only browser headers', () => {
  const { api, lookups } = loadHelper()
  const sessions = [new FakeSession(), new FakeSession()]
  api.setPortalLocale('zh_CN')
  for (const ses of sessions) {
    api.configurePortalSession(ses)
    assert.equal(ses.language, portalLocale.acceptLanguageFor('zh-CN'))
  }
  const oldCalls = sessions.map((ses) => structuredClone(ses.userAgentCalls))
  api.setPortalLocale('de-DE')
  assert.equal(api.getPortalAcceptLanguage(), portalLocale.acceptLanguageFor('de-DE'))
  for (const [index, ses] of sessions.entries()) {
    const original = {
      'User-Agent': 'App Electron/35.7.5',
      'Accept-Language': 'old',
      'sec-ch-ua': 'old',
      'X-Electron-Marker': 'App Electron/35.7.5',
      Cookie: `fixture-identity=${index}`,
      Authorization: `fake-authorization-${index}`,
      'X-Keep': 'unchanged'
    }
    const snapshot = structuredClone(original)
    const headers = ses.requestHeaders(original)
    assert.deepEqual(original, snapshot)
    assert.equal(headers['Accept-Language'], portalLocale.acceptLanguageFor('de-DE'))
    assert.equal(headers.Cookie, original.Cookie)
    assert.equal(headers.Authorization, original.Authorization)
    assert.equal(headers['X-Keep'], 'unchanged')
    assert.equal(headers['X-Electron-Marker'], undefined)
    assert.equal(Object.values(headers).some((value) => value.includes('Electron')), false)
    assert.deepEqual(ses.userAgentCalls, oldCalls[index])
    assert.equal(ses.headerListeners.length, 1)
    assert.deepEqual(ses.events, [])
    assert.deepEqual([...ses.cookieJar], [['old-cookie', 'old-value']])
  }
  api.configurePortalSession(sessions[0])
  assert.equal(sessions[0].language, portalLocale.acceptLanguageFor('de-DE'))
  assert.deepEqual(sessions[0].events, [])
  assert.deepEqual(lookups, [])
  api.setPortalLocale()
  assert.equal(api.getPortalAcceptLanguage(), portalLocale.acceptLanguageFor())
})

test('social, BuilderId and Enterprise retain stored ARN precedence and original cookie attributes', async (t) => {
  for (const idp of ['Google', 'Github', 'BuilderId', 'Enterprise']) {
    for (const topLevel of [true, false]) {
      await t.test(`${idp}: ${topLevel ? 'account ARN takes precedence' : 'credentials ARN fallback'}`, async () => {
        const { api, lookups } = loadHelper()
        const ses = new FakeSession()
        const user = account(idp, {
          profileArn: topLevel ? 'arn:fixture:account' : '',
          credentials: { profileArn: 'arn:fixture:credentials' }
        })
        const expected = topLevel ? 'arn:fixture:account' : 'arn:fixture:credentials'
        assert.equal(await api.initializePortalSession(ses, user), expected)
        assertCookies(ses, user, expected)
        assert.deepEqual(lookups, [])
      })
    }
  }
})

test('social and BuilderId without an ARN never query Enterprise profiles or inject an empty cookie', async () => {
  for (const idp of ['Google', 'Github', 'BuilderId']) {
    const { api, lookups } = loadHelper()
    const ses = new FakeSession()
    const user = account(idp)
    assert.equal(await api.initializePortalSession(ses, user), '')
    assertCookies(ses, user, '')
    assert.deepEqual(lookups, [])
  }
})

test('initializing independent background sessions never clears or borrows the visible session identity', async () => {
  const { api, lookups } = loadHelper()
  const visible = new FakeSession()
  const first = new FakeSession()
  const second = new FakeSession()
  for (const ses of [visible, first, second]) api.configurePortalSession(ses)
  await api.initializePortalSession(visible, account('Google', { profileArn: 'arn:fixture:visible' }))
  const visibleCookies = [...visible.cookieJar]
  const visibleEvents = structuredClone(visible.events)
  const firstAccount = account('BuilderId', { profileArn: 'arn:fixture:first' })
  const secondAccount = account('Github', { profileArn: 'arn:fixture:second' })
  assert.deepEqual(await Promise.all([
    api.initializePortalSession(first, firstAccount),
    api.initializePortalSession(second, secondAccount)
  ]), [firstAccount.profileArn, secondAccount.profileArn])
  assertCookies(first, firstAccount, firstAccount.profileArn)
  assertCookies(second, secondAccount, secondAccount.profileArn)
  const secondCookies = [...second.cookieJar]
  const secondEvents = structuredClone(second.events)
  await api.initializePortalSession(first, account('Enterprise', { credentials: { refreshToken: '', profileArn: 'arn:fixture:replacement' } }))
  assert.equal(first.cookieJar.has('RefreshToken'), false)
  assert.equal(first.cookieJar.get('ProfileArn'), 'arn:fixture:replacement')
  assert.deepEqual([...visible.cookieJar], visibleCookies)
  assert.deepEqual(visible.events, visibleEvents)
  assert.deepEqual([...second.cookieJar], secondCookies)
  assert.deepEqual(second.events, secondEvents)
  assert.deepEqual(lookups, [])
})

test('Enterprise missing ARN uses a read-only profile lookup, first ARN and no credential logs', async () => {
  const { api, lookups, logs } = loadHelper({ profiles: async () => ['arn:fixture:first', 'arn:fixture:second'] })
  const ses = new FakeSession()
  const user = account('Enterprise', { credentials: { region: 'eu-west-1' } })
  const snapshot = structuredClone(user)
  Object.freeze(user.credentials)
  Object.freeze(user)
  assert.equal(await api.initializePortalSession(ses, user), 'arn:fixture:first')
  assert.deepEqual(lookups, [[user.credentials.accessToken, 'eu-west-1']])
  assert.deepEqual(user, snapshot)
  assertCookies(ses, user, 'arn:fixture:first')
  assert.equal(logs.length, 1)
  for (const sensitive of [user.credentials.accessToken, user.credentials.refreshToken, 'arn:fixture:first']) {
    assert.equal(logs.some((line) => line.includes(sensitive)), false)
  }
})

test('Enterprise profile lookup empty/error or missing access token preserves the existing fallback', async (t) => {
  for (const scenario of ['empty', 'error', 'refresh-only']) {
    await t.test(scenario, async () => {
      const { api, lookups, logs } = loadHelper({ profiles: async () => {
        if (scenario === 'error') throw new Error('fake upstream failure; must not be logged')
        return []
      } })
      const ses = new FakeSession()
      const user = account('Enterprise', { credentials: scenario === 'refresh-only' ? { accessToken: '' } : {} })
      assert.equal(await api.initializePortalSession(ses, user), '')
      assertCookies(ses, user, '')
      assert.equal(lookups.length, scenario === 'refresh-only' ? 0 : 1)
      assert.deepEqual(logs, [])
    })
  }
})

test('missing credentials reject before clearing any session, and storage failures propagate', async () => {
  const { api, lookups } = loadHelper()
  const ses = new FakeSession()
  await assert.rejects(api.initializePortalSession(ses, account('Enterprise', {
    credentials: { accessToken: '', refreshToken: '' }
  })), /账号缺少凭证/)
  assert.deepEqual(ses.events, [])
  assert.deepEqual([...ses.cookieJar], [['old-cookie', 'old-value']])
  assert.deepEqual(lookups, [])
  ses.clearStorageData = async () => { throw new Error('fake clear failure') }
  await assert.rejects(api.initializePortalSession(ses, account()), /fake clear failure/)
  assert.deepEqual(ses.events, [])
  const failedWrite = new FakeSession()
  failedWrite.cookies.set = async () => { throw new Error('fake cookie failure') }
  await assert.rejects(api.initializePortalSession(failedWrite, account()), /fake cookie failure/)
})

function loadVisiblePortal() {
  const { api: helper } = loadHelper()
  const defaultSession = new FakeSession()
  const visibleSession = new FakeSession()
  const partitions = []
  const windows = []
  const externalUrls = []
  class FakeContents extends EventEmitter {
    setUserAgent(value) { this.userAgent = value }
    setWindowOpenHandler(handler) { this.openHandler = handler }
  }
  class FakeWindow extends EventEmitter {
    webContents = new FakeContents()
    loads = []
    minimized = false
    destroyed = false
    focuses = 0
    restores = 0
    constructor(options) { super(); this.options = structuredClone(options); windows.push(this) }
    isDestroyed() { return this.destroyed }
    setTitle(title) { this.title = title }
    async loadURL(url, options) { this.loads.push([url, structuredClone(options)]) }
    isMinimized() { return this.minimized }
    restore() { this.minimized = false; this.restores++ }
    focus() { this.focuses++ }
  }
  const portal = loadModule('kiroPortal', {
    './kiroPortalSession': helper,
    electron: {
      BrowserWindow: FakeWindow,
      screen: { getPrimaryDisplay: () => ({ workAreaSize: { width: 1920, height: 1080 } }) },
      session: {
        defaultSession,
        fromPartition(partition) {
          assert.equal(partition, 'kiro-portal-private')
          partitions.push(partition)
          return visibleSession
        }
      },
      shell: { openExternal: async (url) => { externalUrls.push(url) } }
    }
  }, { console: { info() {} } })
  return { portal, helper, defaultSession, visibleSession, partitions, windows, externalUrls, FakeWindow }
}

test('setInAppLocale keeps its public behavior and updates only default and visible-session languages', () => {
  const { portal, helper, defaultSession, visibleSession, partitions } = loadVisiblePortal()
  const background = new FakeSession()
  helper.configurePortalSession(background)
  portal.setInAppLocale('ja-JP')
  for (const ses of [defaultSession, visibleSession]) {
    assert.equal(ses.userAgent, 'Original app Electron/35.7.5')
    assert.equal(ses.language, portalLocale.acceptLanguageFor('ja-JP'))
    assert.deepEqual(ses.events, [])
  }
  assert.equal(background.userAgentCalls.length, 1)
  assert.equal(background.requestHeaders({})['Accept-Language'], portalLocale.acceptLanguageFor('ja-JP'))
  assert.deepEqual(background.events, [])
  assert.deepEqual(partitions, ['kiro-portal-private'])
})

test('visible portal retains partition, window reuse, sizing, navigation and sandbox isolation', async () => {
  const { portal, helper, defaultSession, visibleSession, windows, externalUrls, FakeWindow } = loadVisiblePortal()
  await assert.rejects(portal.openAccountPortal(account('BuilderId', {
    credentials: { accessToken: '', refreshToken: '' }
  })), /账号缺少凭证/)
  assert.equal(windows.length, 0)
  const first = account('Google')
  assert.deepEqual(structuredClone(await portal.openAccountPortal(first)), { url: helper.KIRO_PORTAL_ORIGIN })
  assert.equal(windows.length, 1)
  const window = windows[0]
  const preferences = { partition: 'kiro-portal-private', contextIsolation: true, nodeIntegration: false, sandbox: true }
  assert.deepEqual(window.options, {
    width: 1600, height: 1000, title: 'Kiro 官网', autoHideMenuBar: true, webPreferences: preferences
  })
  assert.equal(window.webContents.userAgent, helper.CHROME_UA)
  assert.equal(window.title, `Kiro 官网 - ${first.email}`)
  assert.deepEqual(window.loads, [[helper.KIRO_PORTAL_ORIGIN, { userAgent: helper.CHROME_UA }]])
  window.minimized = true
  await portal.openAccountPortal(account('BuilderId', { email: 'second@example.invalid' }))
  assert.equal(windows.length, 1)
  assert.equal(window.title, 'Kiro 官网 - second@example.invalid')
  assert.equal(window.loads.length, 2)
  assert.equal(window.restores, 1)
  assert.equal(window.focuses, 2)
  assert.equal(visibleSession.cookieJar.get('Idp'), 'BuilderId')
  assert.deepEqual(defaultSession.events, [])
  for (const url of ['https://app.kiro.dev/', 'https://billing.stripe.com/fixture', 'http://example.invalid/']) {
    assert.deepEqual(structuredClone(window.webContents.openHandler({ url })), {
      action: 'allow',
      overrideBrowserWindowOptions: { width: 1600, height: 1000, autoHideMenuBar: true, webPreferences: preferences }
    })
  }
  assert.deepEqual(structuredClone(window.webContents.openHandler({ url: 'mailto:fixture@example.invalid' })), { action: 'deny' })
  assert.deepEqual(externalUrls, ['mailto:fixture@example.invalid'])
  const child = new FakeWindow({})
  window.webContents.emit('did-create-window', child)
  assert.equal(child.webContents.userAgent, helper.CHROME_UA)
  assert.equal(child.webContents.openHandler({ url: 'https://example.invalid/' }).action, 'allow')
  const grandchild = new FakeWindow({})
  child.webContents.emit('did-create-window', grandchild)
  assert.equal(grandchild.webContents.openHandler({ url: 'https://example.invalid/' }).action, 'allow')
  window.destroyed = true
  window.emit('closed')
  await portal.openAccountPortal(first)
  assert.equal(windows.length, 4)
  assert.notEqual(windows.at(-1), window)
})
