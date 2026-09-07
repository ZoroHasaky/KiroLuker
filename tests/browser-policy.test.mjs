import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import vm from 'node:vm'
import { isIP } from 'node:net'
import { randomBytes } from 'node:crypto'
import ts from 'typescript'

const source = await fs.readFile(new URL('../src/main/browserPolicy.ts', import.meta.url), 'utf8')
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
})
const checkedAt = 1_788_768_000_000
const policy = {}
vm.runInNewContext(outputText, {
  exports: policy, URL, Date: class extends Date { static now() { return checkedAt } },
  require(id) { assert.equal(id, 'node:net'); return { isIP } }
}, { filename: 'browserPolicy.ts' })
const { browserNavigationUrl, isBrowserNavigationAllowed, browserOrigin, parseBrowserProxyTrace } = policy
const plain = (value) => structuredClone(value)

function rejectsWithoutInput(action, marker) {
  assert.throws(action, (error) => {
    assert.match(error.message, /[\u4e00-\u9fff]/, 'user-visible errors should be Chinese')
    if (marker) {
      assert.equal(error.message.includes(marker), false)
      assert.equal(error.stack.includes(marker), false)
    }
    assert.equal(error.cause, undefined)
    return true
  })
}

test('navigation policy canonicalizes HTTP(S) and handles blank pages without broadening remote navigation', () => {
  for (const [input, expected] of [
    ['https://EXAMPLE.invalid', 'https://example.invalid/'],
    [' http://example.invalid:80/a/../b?q=1#fragment ', 'http://example.invalid/b?q=1#fragment'],
    ['https://example.invalid:8443/path', 'https://example.invalid:8443/path'],
    ['http://127.0.0.1:1080/', 'http://127.0.0.1:1080/'],
    ['http://[::1]:1080/', 'http://[::1]:1080/'],
    ['https://例子.测试/', 'https://xn--fsqu00a.xn--0zwm56d/'],
    ['about:blank', 'about:blank']
  ]) {
    assert.equal(browserNavigationUrl(input), expected)
    assert.equal(isBrowserNavigationAllowed(input), true)
  }
  assert.equal(browserNavigationUrl('', true), 'about:blank')
  assert.equal(browserNavigationUrl('   ', true), 'about:blank')
  assert.throws(() => browserNavigationUrl(''))
  assert.throws(() => browserNavigationUrl('example.invalid'))
  assert.equal(isBrowserNavigationAllowed('example.invalid'), false)
})

test('only address-bar input gains an HTTPS default, including bare hostname:port and IPv6', () => {
  for (const [input, expected] of [
    ['example.invalid/a?q=1', 'https://example.invalid/a?q=1'],
    ['localhost:8080/path', 'https://localhost:8080/path'],
    ['127.0.0.1:8443', 'https://127.0.0.1:8443/'],
    ['[::1]:8443/', 'https://[::1]:8443/'],
    ['HTTP://example.invalid/', 'http://example.invalid/']
  ]) assert.equal(browserNavigationUrl(input, true), expected)
})

test('custom, privileged, filesystem, active-content and non-web schemes are denied', () => {
  for (const input of [
    'javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'data:text/html,<script>1</script>',
    'file:///C:/fixture-only.txt', 'C:\\fixture-only.txt', 'chrome://settings',
    'chrome-extension://fixture/index.html', 'devtools://devtools/', 'kiroluker://callback',
    'kiro://auth', 'mailto:fixture@example.invalid', 'tel:+12345',
    'blob:https://example.invalid/fixture-id', 'ftp://example.invalid/',
    'ws://example.invalid/', 'wss://example.invalid/', 'about:config', 'about:blank#fragment'
  ]) {
    for (const addressBar of [false, true]) rejectsWithoutInput(() => browserNavigationUrl(input, addressBar))
    assert.equal(isBrowserNavigationAllowed(input), false)
    assert.equal(browserOrigin(input), '')
  }
})

test('embedded credentials are rejected in navigation and stripped entirely from origin/error output', () => {
  const secret = `fixture-${randomBytes(16).toString('hex')}`
  for (const input of [
    `https://${secret}@example.invalid/`, `https://user:${secret}@example.invalid/`,
    `https://:${secret}@example.invalid/`, `https://%75ser:${secret}@example.invalid/`,
    `https://${encodeURIComponent(`user:@${secret}`)}@example.invalid/`
  ]) {
    for (const addressBar of [false, true]) rejectsWithoutInput(() => browserNavigationUrl(input, addressBar), secret)
    assert.equal(browserOrigin(input), '')
    assert.equal(isBrowserNavigationAllowed(input), false)
  }
  rejectsWithoutInput(() => browserNavigationUrl(`user:${secret}@example.invalid`, true), secret)
})

test('literal CRLF, all C0 controls and DEL are rejected before WHATWG URL normalization can discard them', () => {
  const marker = 'fixture-header-marker'
  for (const code of [...Array.from({ length: 32 }, (_, index) => index), 127]) {
    const control = String.fromCharCode(code)
    for (const input of [`https://example.invalid/${marker}${control}`, `${control}https://example.invalid/${marker}`]) {
      for (const addressBar of [false, true]) rejectsWithoutInput(() => browserNavigationUrl(input, addressBar), marker)
      assert.equal(isBrowserNavigationAllowed(input), false)
    }
  }
  rejectsWithoutInput(() => browserNavigationUrl(`https://example.invalid/\r\nAuthorization: ${marker}`), marker)
  // Percent-encoded path bytes remain URL data; they must not become literal header controls.
  assert.equal(browserNavigationUrl('https://example.invalid/%0D%0A'), 'https://example.invalid/%0D%0A')
})

test('invalid types, malformed authorities and overlong URLs fail without echoing input', () => {
  for (const input of [null, undefined, 0, false, {}, [], new URL('https://example.invalid'),
    'https://', 'https://:443', 'https://[::1', 'https://example.invalid:65536', 'not a URL']) {
    rejectsWithoutInput(() => browserNavigationUrl(input))
    assert.equal(isBrowserNavigationAllowed(input), false)
  }
  const prefix = 'https://example.invalid/'
  assert.equal(browserNavigationUrl(prefix + 'a'.repeat(16384 - prefix.length)).length, 16384)
  rejectsWithoutInput(() => browserNavigationUrl(prefix + 'a'.repeat(16385 - prefix.length)))
})

test('management origins never include portal session paths, queries, fragments or passwords', () => {
  const secret = randomBytes(16).toString('hex')
  assert.equal(browserOrigin(`https://example.invalid:8443/p/session/${secret}?token=${secret}#${secret}`), 'https://example.invalid:8443')
  assert.equal(browserOrigin(`https://example.invalid:443/${secret}`), 'https://example.invalid')
  assert.equal(browserOrigin('about:blank'), '空白页')
  for (const input of ['', 'bad URL', `file:///${secret}`, `https://user:${secret}@example.invalid/`, null]) assert.equal(browserOrigin(input), '')
})

test('trace parser accepts valid IPv4/IPv6 and CRLF, timestamps the check and returns only safe fields', () => {
  const marker = randomBytes(16).toString('hex')
  for (const [body, ip, country] of [
    [`ip=203.0.113.7\nloc=CN\nuag=${marker}\npath=/p/session/${marker}\n`, '203.0.113.7', 'CN'],
    ['ip=2001:db8::42\r\nloc=US\r\n', '2001:db8::42', 'US'],
    ['ip= 203.0.113.7 \r\nloc=HK\r\n', '203.0.113.7', 'HK']
  ]) {
    const parsed = parseBrowserProxyTrace(body, 125)
    assert.deepEqual(plain(parsed), { ip, country, checkedAt, latencyMs: 125 })
    assert.equal(JSON.stringify(parsed).includes(marker), false)
  }
})

test('country codes are optional but only an exact uppercase two-letter loc line is exposed', () => {
  for (const suffix of ['', 'loc=cn', 'loc=CHN', 'loc=CN extra', 'xloc=CN', 'loc=<x>', 'loc=CN?token=fixture']) {
    assert.equal(parseBrowserProxyTrace(`ip=203.0.113.7\n${suffix}\n`, 0).country, '')
  }
})

test('trace limits are inclusive and invalid/missing IP responses never echo body contents', () => {
  const base = 'ip=203.0.113.7\nloc=CN\n'
  assert.equal(parseBrowserProxyTrace(base + 'x'.repeat(16384 - base.length), 0).ip, '203.0.113.7')
  rejectsWithoutInput(() => parseBrowserProxyTrace(base + 'x'.repeat(16385 - base.length), 0))
  const marker = `fixture-${randomBytes(12).toString('hex')}`
  for (const ip of ['', '999.1.2.3', '127.1', '0x7f000001', 'example.invalid', 'http://127.0.0.1', '203.0.113.7 extra', '203.0.113.7\0']) {
    rejectsWithoutInput(() => parseBrowserProxyTrace(`ip=${ip}\nloc=CN\nsecret=${marker}`, 0), marker)
  }
  for (const body of ['', `xip=203.0.113.7\nsecret=${marker}`, `<html>${marker}</html>`, `loc=CN\nsecret=${marker}`]) {
    rejectsWithoutInput(() => parseBrowserProxyTrace(body, 0), marker)
  }
})
