import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import vm from 'node:vm'
import { isIP } from 'node:net'
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto'
import ts from 'typescript'

const source = await fs.readFile(new URL('../src/main/browserConfig.ts', import.meta.url), 'utf8')
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true }
})

function harness({ locale = 'en-US', available = true, backend = 'gnome_libsecret', data = new Map() } = {}) {
  const key = randomBytes(32)
  const state = { available, backend, locale, settingsReads: 0, encryptions: 0, decryptions: 0, failEncrypt: '', failDecrypt: '', failWrite: '', failRead: '' }
  const instances = []
  class Store {
    constructor(options) {
      instances.push(options)
      assert.equal(options.name, 'browser-settings')
    }
    get(key) {
      if (state.failRead) throw new Error(state.failRead)
      return structuredClone(data.get(key))
    }
    set(key, value) {
      if (state.failWrite) throw new Error(state.failWrite)
      data.set(key, structuredClone(value))
    }
  }
  // Real authenticated encryption, substituting only the platform key-store adapter.
  // All keys/credentials are generated test-only values; no real Electron/account store.
  const safeStorage = {
    isEncryptionAvailable: () => state.available,
    getSelectedStorageBackend: () => state.backend,
    encryptString(value) {
      state.encryptions++
      if (state.failEncrypt) throw new Error(state.failEncrypt)
      const iv = randomBytes(12)
      const cipher = createCipheriv('aes-256-gcm', key, iv)
      const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
      return Buffer.concat([iv, cipher.getAuthTag(), ciphertext])
    },
    decryptString(value) {
      state.decryptions++
      if (state.failDecrypt) throw new Error(state.failDecrypt)
      const decipher = createDecipheriv('aes-256-gcm', key, value.subarray(0, 12))
      decipher.setAuthTag(value.subarray(12, 28))
      return Buffer.concat([decipher.update(value.subarray(28)), decipher.final()]).toString('utf8')
    }
  }
  const imports = {
    'electron-store': Store, electron: { safeStorage }, 'node:net': { isIP },
    './store': { getSettings: () => { state.settingsReads++; return { portalLocale: state.locale } } }
  }
  function load() {
    const exports = {}
    vm.runInNewContext(outputText, {
      exports, Buffer, Intl, process: { platform: 'linux' },
      require(id) {
        assert.ok(Object.hasOwn(imports, id), `Unexpected dependency: ${id}`)
        return imports[id]
      }
    }, { filename: 'browserConfig.ts' })
    return exports
  }
  return { api: load(), load, state, data, instances, safeStorage }
}

function patch(api, overrides = {}) {
  const config = structuredClone(api.defaultBrowserConfig())
  config.proxy = { ...config.proxy, enabled: true, host: 'proxy.example.invalid', ...overrides }
  return config
}
function ephemeralCredentials() {
  return { username: `fixture-${randomBytes(12).toString('hex')}`, password: randomBytes(24).toString('base64') }
}
const plain = (value) => structuredClone(value)

// Pure helpers are the actual compiled production functions, not reimplementations.
test('defaults are isolated, seeded once from valid portalLocale, and never expose a password', () => {
  const { api, state, load, instances, data } = harness({ locale: 'zh-hant-hk' })
  assert.equal(instances.length, 0, 'store is lazy')
  const config = api.getBrowserConfig()
  assert.deepEqual(plain(config), {
    proxy: { enabled: false, host: '', port: 1080, username: '', passwordSet: false },
    fingerprint: { userAgent: '', language: 'zh-Hant-HK', timezone: '', width: 1280, height: 900 }
  })
  state.locale = 'fr-FR'
  assert.equal(load().getBrowserConfig().fingerprint.language, 'zh-Hant-HK')
  assert.equal(state.settingsReads, 1)
  assert.equal(state.encryptions, 0)
  assert.equal(data.get('config').proxy.encryptedCredentials, '')
  assert.equal(instances.every((options) => options.name === 'browser-settings'), true)
  config.fingerprint.width = 1000
  assert.equal(api.getBrowserConfig().fingerprint.width, 1280, 'no shared mutable config')
})

test('invalid legacy language defaults to zh-CN without repairing account preferences', () => {
  for (const locale of [undefined, null, '', '__custom__', 'en_US', 'en;q=0.9', 'bad\r\nInjected: x', {}, 99]) {
    const { api, state } = harness({ locale })
    const expected = locale === undefined ? 'en-US' : 'zh-CN'
    assert.equal(api.getBrowserConfig().fingerprint.language, expected)
    assert.equal(state.settingsReads, 1)
  }
})

test('pure host validator accepts bare IPv4/IPv6/DNS and rejects URIs and ambiguous input', () => {
  const { api } = harness()
  for (const host of ['127.0.0.1', '::1', '2001:db8::7', 'localhost', 'proxy.example.invalid', 'xn--fsqu00a.xn--0zwm56d', 'proxy.example.invalid.']) {
    assert.equal(api.validateBrowserProxyHost(host), host)
  }
  assert.equal(api.validateBrowserProxyHost('', false), '')
  for (const host of ['', ' host', 'host ', 'a b', 'a\t', 'socks5://host', 'http://host:80', 'user@host', 'host/path', 'host\\path', 'host?x', 'host#x', '[::1]', '::1%eth0', 'host:1080', '999.1.2.3', '127.1', '12345', '-host.test', 'host-.test', '.host', 'a..b', 'a'.repeat(64) + '.test', 'a.'.repeat(128) + 'test', {}, null, 1080]) {
    assert.throws(() => api.validateBrowserProxyHost(host), /代理地址/)
  }
})

test('pure proxy validation enforces types, port bounds, UTF-8 SOCKS lengths and control exclusion even when disabled', () => {
  const { api } = harness()
  const proxy = patch(api).proxy
  for (const port of [1, 1080, 65535]) assert.equal(api.validateBrowserProxy({ ...proxy, port }).port, port)
  for (const port of [0, 65536, -1, 1.5, NaN, Infinity, '1080', null]) {
    assert.throws(() => api.validateBrowserProxy({ ...proxy, port }), /代理端口/)
  }
  for (const enabled of [1, 'true', null]) assert.throws(() => api.validateBrowserProxy({ ...proxy, enabled }), /代理开关/)
  for (const field of ['username', 'password']) {
    assert.equal(api.validateBrowserProxy({ ...proxy, [field]: 'a'.repeat(255) })[field].length, 255)
    assert.equal(api.validateBrowserProxy({ ...proxy, [field]: '界'.repeat(85) })[field].length, 85)
    for (const value of ['a'.repeat(256), '界'.repeat(86), '🙂'.repeat(64), 'bad\r', '\n', '\0', '\u001f', '\u007f', '\u0085', '\ud800', null, 42]) {
      assert.throws(() => api.validateBrowserProxy({ ...proxy, enabled: false, [field]: value }))
    }
    assert.equal(api.validateBrowserProxy({ ...proxy, [field]: ' leading and trailing ' })[field], ' leading and trailing ')
  }
})

test('fingerprint validators enforce BCP47/IANA, integer viewport and trimmed safe UA', () => {
  const { api } = harness()
  const fingerprint = api.defaultBrowserConfig().fingerprint
  assert.equal(api.validateBrowserLanguage(' EN-us '), 'en-US')
  assert.equal(api.validateBrowserLanguage('zh-Hant-TW'), 'zh-Hant-TW')
  assert.equal(api.validateBrowserLanguage('de-DE-u-co-phonebk'), 'de-DE-u-co-phonebk')
  for (const language of ['', 'en_US', 'en US', 'en--US', 'en-US,en', 'en;q=0.8', 'x', 'a'.repeat(256), 'en\r\n', 7]) {
    assert.throws(() => api.validateBrowserLanguage(language), /语言标签/)
  }
  for (const timezone of ['', 'UTC', 'Asia/Shanghai', 'America/New_York', 'Etc/GMT+8']) {
    assert.equal(api.validateBrowserTimezone(timezone), timezone)
  }
  for (const timezone of ['Mars/Olympus', '+08:00', '-0500', 'UTC+08:00', 'Asia Shanghai', 'UTC\r', {}]) {
    assert.throws(() => api.validateBrowserTimezone(timezone), /时区/)
  }
  for (const [field, values] of [['width', [899, 2401, 1280.5, '1280', null]], ['height', [599, 1801, Infinity, '900', null]]]) {
    for (const value of values) assert.throws(() => api.validateBrowserFingerprint({ ...fingerprint, [field]: value }), new RegExp(field === 'width' ? '窗口宽度' : '窗口高度'))
  }
  assert.equal(api.validateBrowserFingerprint({ ...fingerprint, width: 900, height: 600 }).width, 900)
  assert.equal(api.validateBrowserFingerprint({ ...fingerprint, width: 2400, height: 1800 }).height, 1800)
  assert.equal(api.validateBrowserFingerprint({ ...fingerprint, userAgent: '  Chrome/test  ' }).userAgent, 'Chrome/test')
  assert.equal(api.validateBrowserFingerprint({ ...fingerprint, userAgent: 'x'.repeat(512) }).userAgent.length, 512)
  for (const userAgent of ['x'.repeat(513), 'ok\r\nX: injected', '\tChrome', '\u0085', null]) {
    assert.throws(() => api.validateBrowserFingerprint({ ...fingerprint, userAgent }), /User-Agent/)
  }
})

test('malformed forms cannot cause writes and validators return whitelisted contract properties', () => {
  const { api, data } = harness()
  for (const value of [null, [], {}, { proxy: null }, { proxy: patch(api).proxy }, { ...patch(api), fingerprint: [] }]) {
    assert.throws(() => api.saveBrowserConfig(value))
    assert.equal(data.size, 0)
  }
  const value = patch(api)
  value.extra = 'ignored'
  value.proxy.passwordSet = true
  assert.deepEqual(Object.keys(api.validateBrowserConfigPatch(value)).sort(), ['fingerprint', 'proxy'])
  assert.equal(Object.hasOwn(api.validateBrowserConfigPatch(value).proxy, 'passwordSet'), false)
})

test('entire credential pair is encrypted at rest; getters/reload mask password and mutation cannot affect storage', () => {
  const { api, data, load } = harness()
  const credentials = ephemeralCredentials()
  const saved = api.saveBrowserConfig(patch(api, credentials))
  assert.equal(saved.proxy.username, credentials.username)
  assert.equal(saved.proxy.passwordSet, true)
  assert.equal(Object.hasOwn(saved.proxy, 'password'), false)
  assert.equal(JSON.stringify(saved).includes(credentials.password), false)
  const disk = JSON.stringify(data.get('config'))
  assert.equal(disk.includes(credentials.username), false)
  assert.equal(disk.includes(credentials.password), false)
  assert.deepEqual(Object.keys(data.get('config').proxy).sort(), ['enabled', 'encryptedCredentials', 'host', 'port'])
  const reloaded = load()
  assert.deepEqual(plain(reloaded.getBrowserConfig()), plain(saved))
  assert.equal(reloaded.getResolvedBrowserConfig().proxy.password, credentials.password)
  const resolved = api.getResolvedBrowserConfig()
  resolved.proxy.password = 'changed'
  assert.equal(api.getResolvedBrowserConfig().proxy.password, credentials.password)
})

test('omitted password retains, explicit empty clears, username-only is encrypted, complete empty clears cipher', () => {
  const { api, data, state } = harness()
  const credentials = ephemeralCredentials()
  api.saveBrowserConfig(patch(api, credentials))
  const update = patch(api, { username: 'new-fixture-user' })
  delete update.proxy.password
  api.saveBrowserConfig(update)
  assert.equal(api.getResolvedBrowserConfig().proxy.password, credentials.password)
  assert.equal(api.getBrowserConfig().proxy.username, 'new-fixture-user')
  assert.equal(api.saveBrowserConfig(patch(api, { username: 'new-fixture-user', password: '' })).proxy.passwordSet, false)
  assert.ok(data.get('config').proxy.encryptedCredentials)
  assert.equal(JSON.stringify(data.get('config')).includes('new-fixture-user'), false)
  state.available = false
  assert.equal(api.saveBrowserConfig(patch(api, { username: '', password: '' })).proxy.passwordSet, false)
  assert.equal(data.get('config').proxy.encryptedCredentials, '')
})

test('unavailable/basic_text/unknown secure storage refuses any nonempty credentials without committing', () => {
  for (const options of [{ available: false }, { backend: 'basic_text' }, { backend: 'unknown' }]) {
    for (const credentials of [{ username: 'test-only', password: '' }, { username: '', password: 'test-only' }]) {
      const { api, data } = harness(options)
      const defaults = api.getBrowserConfig()
      const before = JSON.stringify(data.get('config'))
      assert.throws(() => api.saveBrowserConfig(patch(api, credentials)), /系统安全存储不可用/)
      assert.equal(JSON.stringify(data.get('config')), before)
      assert.deepEqual(plain(api.getBrowserConfig()), plain(defaults))
    }
  }
})

test('encrypted credentials fail closed if key/backend is lost, but explicit replacement/clear is possible', () => {
  const { api, state, data } = harness()
  const credentials = ephemeralCredentials()
  api.saveBrowserConfig(patch(api, credentials))
  const before = JSON.stringify(data.get('config'))
  state.backend = 'basic_text'
  assert.throws(() => api.getBrowserConfig(), /系统安全存储不可用/)
  assert.throws(() => api.getResolvedBrowserConfig(), /系统安全存储不可用/)
  const update = patch(api)
  delete update.proxy.password
  assert.throws(() => api.saveBrowserConfig(update), /系统安全存储不可用/)
  assert.equal(JSON.stringify(data.get('config')), before)
  state.backend = 'gnome_libsecret'
  state.failDecrypt = credentials.password
  assert.throws(() => api.getBrowserConfig(), (error) => error.message === '无法解密代理凭据，请重新填写或清空' && !error.cause)
  assert.equal(api.saveBrowserConfig(patch(api)).proxy.passwordSet, false)
})

test('corruption, encryption and disk failures never leak underlying messages or overwrite prior settings', () => {
  const { api, state, data, safeStorage } = harness()
  const credentials = ephemeralCredentials()
  api.saveBrowserConfig(patch(api, credentials))
  const original = plain(data.get('config'))
  const before = JSON.stringify(original)
  for (const [field, expected] of [['failEncrypt', '加密'], ['failWrite', '保存'], ['failRead', '读取'], ['failDecrypt', '解密']]) {
    state[field] = credentials.password
    assert.throws(() => field === 'failRead' || field === 'failDecrypt' ? api.getBrowserConfig() : api.saveBrowserConfig(patch(api, credentials)), (error) => {
      assert.match(error.message, new RegExp(expected))
      assert.equal(`${error.stack}`.includes(credentials.password), false)
      assert.equal(error.cause, undefined)
      return true
    })
    state[field] = ''
    assert.equal(JSON.stringify(data.get('config')), before)
  }
  for (const ciphertext of ['not base64!', 'AAAA', safeStorage.encryptString(credentials.password).toString('base64')]) {
    data.set('config', { ...original, proxy: { ...original.proxy, encryptedCredentials: ciphertext } })
    assert.throws(() => api.getResolvedBrowserConfig(), /无法解密代理凭据/)
  }
  data.set('config', { ...original, version: 2 })
  assert.throws(() => api.getBrowserConfig(), /浏览器配置存储格式无效/)
  data.set('config', { ...original, proxy: { ...original.proxy, port: 0 } })
  assert.throws(() => api.getBrowserConfig(), /代理端口/)
})
