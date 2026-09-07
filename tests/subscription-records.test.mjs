import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import vm from 'node:vm'
import ts from 'typescript'

// Execute the real renderer utility, without Electron, account stores or network access.
const source = await fs.readFile(
  new URL('../src/renderer/src/utils/subscriptionRecords.ts', import.meta.url), 'utf8'
)
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
})
const exports = {}
vm.runInNewContext(outputText, {
  exports,
  require(id) { assert.fail(`Unexpected real dependency: ${id}`) }
}, { filename: 'subscriptionRecords.ts', timeout: 1000 })
const {
  SUBSCRIPTION_RECORDS_KEY,
  needsSubscriptionCheck,
  canSwitchSubscription,
  loadSubscriptionRecords,
  saveSubscriptionRecords
} = exports

const NOW = 1_800_000_000_000
const PERIOD_END = NOW + 30 * 86_400_000
const STATES = ['paid', 'free', 'scheduled-free', 'canceling']

function renewal(state = 'paid', overrides = {}) {
  return {
    state, planName: 'Kiro Pro', subscriptionId: 'sub_fixture_private',
    checkedAt: NOW, currentPeriodEnd: PERIOD_END, transitionAt: PERIOD_END,
    ...overrides
  }
}

function record(overrides = {}) {
  return {
    status: 'success', operation: 'check', message: '只读检查完成',
    renewal: renewal(), needsCheck: false, settled: false,
    attemptedAt: NOW - 1000, completedAt: NOW, lastCheckAt: NOW,
    ...overrides
  }
}

function memoryStorage(raw = null) {
  const values = new Map(raw === null ? [] : [[SUBSCRIPTION_RECORDS_KEY, raw]])
  const reads = []
  const writes = []
  return {
    values, reads, writes,
    getItem(key) { reads.push(key); return values.get(key) ?? null },
    setItem(key, value) { writes.push({ key, value }); values.set(key, value) }
  }
}

function roundTrip(records) {
  const storage = memoryStorage()
  saveSubscriptionRecords(storage, records)
  return { storage, loaded: loadSubscriptionRecords(storage) }
}

// JSON values cross the VM boundary; prototype checks are asserted separately below.
const plain = value => JSON.parse(JSON.stringify(value))
const stored = storage => JSON.parse(storage.values.get(SUBSCRIPTION_RECORDS_KEY))
const encoded = records => JSON.stringify({ version: 1, records })

function assertReadOnly(row) {
  assert.equal(needsSubscriptionCheck(row), true, '必须继续只读检查')
  assert.equal(canSwitchSubscription(row), false, '不能提交或重试切换')
}

test('只有成功确认且无需复核的 Free / scheduled-free 跳过检查', async t => {
  for (const state of ['free', 'scheduled-free']) {
    for (const settled of [false, true]) {
      await t.test(`${state}, settled=${settled}`, () => {
        const row = record({ renewal: renewal(state), settled })
        assert.equal(needsSubscriptionCheck(row), false)
        assert.equal(canSwitchSubscription(row), false)
      })
    }
  }
  for (const state of ['paid', 'canceling']) {
    await t.test(`${state} 即使已处理仍需检查`, () => {
      assert.equal(needsSubscriptionCheck(record({ renewal: renewal(state) })), true)
      assertReadOnly(record({ renewal: renewal(state), settled: true }))
    })
  }
})

test('未检查、无 renewal、失败、警告、排队、执行中和待复核均不假装已确认', async t => {
  for (const [name, row] of [
    ['未检查', undefined], ['空记录', null],
    ['缺少 renewal', record({ renewal: undefined })],
    ['空 renewal', record({ renewal: null })],
    ['只有 Free 文案', record({ renewal: undefined, message: '已经 Free', settled: true })],
    ['canceling 不是 Free', record({ renewal: renewal('canceling', { planName: 'Kiro Free' }) })]
  ]) {
    await t.test(name, () => assertReadOnly(row))
  }
  for (const state of STATES) {
    for (const status of ['pending', 'running', 'warning', 'error']) {
      await t.test(`${status} 保留旧 ${state}`, () => {
        assertReadOnly(record({ status, renewal: renewal(state) }))
      })
    }
    await t.test(`success ${state} 仍待复核`, () => {
      assertReadOnly(record({ renewal: renewal(state), needsCheck: true }))
    })
  }
})

test('只有成功检查且未处理、无需复核的 paid 能切换', async t => {
  const checked = record()
  assert.equal(needsSubscriptionCheck(checked), true)
  assert.equal(canSwitchSubscription(checked), true)
  assert.equal(canSwitchSubscription(record({ operation: undefined })), true)
  for (const flags of [
    { needsCheck: true, settled: false },
    { needsCheck: false, settled: true },
    { needsCheck: true, settled: true }
  ]) {
    await t.test(JSON.stringify(flags), () => assertReadOnly(record(flags)))
  }
  for (const state of ['free', 'scheduled-free', 'canceling']) {
    assert.equal(canSwitchSubscription(record({ renewal: renewal(state) })), false, state)
  }
})

test('新存储返回无原型空字典，不伪造结果也不写回', () => {
  assert.equal(SUBSCRIPTION_RECORDS_KEY, 'kiroluker-subscription-records-v1')
  for (const raw of [null, '']) {
    const storage = memoryStorage(raw)
    const loaded = loadSubscriptionRecords(storage)
    assert.equal(Object.getPrototypeOf(loaded), null)
    assert.deepEqual(Object.keys(loaded), [])
    assertReadOnly(loaded['fixture-account'])
    assert.deepEqual(storage.reads, [SUBSCRIPTION_RECORDS_KEY])
    assert.deepEqual(storage.writes, [])
  }
  const { storage, loaded } = roundTrip({})
  assert.deepEqual(stored(storage), { version: 1, records: {} })
  assert.equal(Object.getPrototypeOf(loaded), null)
})

test('持久化采用字段白名单：无凭证、账号标签、链接或 Stripe ID，并且不修改输入', () => {
  const privateFields = {
    email: 'fixture-account@example.invalid', accountLabel: 'fixture-account-label',
    label: 'fixture-label', displayName: 'fixture-display-name',
    tags: ['fixture-tag'], tagIds: ['fixture-tag-id'],
    credentials: { accessToken: 'fixture-nested-access', refreshToken: 'fixture-nested-refresh' },
    accessToken: 'fixture-access', refreshToken: 'fixture-refresh', csrfToken: 'fixture-csrf',
    sessionApiKey: 'fixture-api-key', password: 'fixture-password', cookie: 'fixture-cookie',
    authorization: 'Bearer fixture-bearer',
    portalUrl: 'https://portal.example.invalid/session/fixture-secret',
    paymentLink: 'https://pay.example.invalid/fixture-payment',
    subscriptionId: 'sub_fixture_private', customerId: 'cus_fixture_private',
    stripeAccountId: 'acct_fixture_private', priceId: 'price_fixture_private',
    subscriptionItemId: 'si_fixture_private',
    account: { email: 'nested@example.invalid', credentials: { accessToken: 'fixture-account-token' } }
  }
  const input = {
    'fixture-account': record({
      ...privateFields, previousPlan: 'Kiro Pro+', warning: '本地提示',
      renewal: renewal('scheduled-free', privateFields), settled: true
    })
  }
  const before = structuredClone(input)
  const { storage, loaded } = roundTrip(input)
  const expected = {
    status: 'success', operation: 'check', message: '只读检查完成',
    previousPlan: 'Kiro Pro+', warning: '本地提示', needsCheck: false, settled: true,
    attemptedAt: NOW - 1000, completedAt: NOW, lastCheckAt: NOW,
    renewal: {
      state: 'scheduled-free', planName: 'Kiro Pro', subscriptionId: '',
      checkedAt: NOW, currentPeriodEnd: PERIOD_END, transitionAt: PERIOD_END
    }
  }
  assert.deepEqual(stored(storage), { version: 1, records: { 'fixture-account': expected } })
  assert.deepEqual(plain(loaded), { 'fixture-account': expected })
  assert.deepEqual(input, before)
  assert.equal(storage.writes.length, 1)
  assert.equal(storage.writes[0].key, SUBSCRIPTION_RECORDS_KEY)
  assert.deepEqual(storage.reads, [SUBSCRIPTION_RECORDS_KEY])
  const raw = storage.writes[0].value
  for (const secret of [
    'example.invalid', 'fixture-account-label', 'fixture-label', 'fixture-display-name',
    'fixture-tag', 'fixture-nested-access', 'fixture-nested-refresh', 'fixture-access',
    'fixture-refresh', 'fixture-csrf', 'fixture-api-key', 'fixture-password', 'fixture-cookie',
    'fixture-bearer', 'fixture-secret', 'fixture-payment', 'sub_fixture_private',
    'cus_fixture_private', 'acct_fixture_private', 'price_fixture_private', 'si_fixture_private',
    'fixture-account-token'
  ]) assert.equal(raw.includes(secret), false, `不应持久化 ${secret}`)

  // Loading untrusted old storage must apply the same whitelist, not just saving new records.
  const oldStorage = memoryStorage(encoded(input))
  assert.deepEqual(plain(loadSubscriptionRecords(oldStorage)), { 'fixture-account': expected })
  assert.deepEqual(oldStorage.writes, [])
})

test('所有允许持久化的文本字段均隐藏链接和常见凭证', async t => {
  const cases = [
    ['跳转 https://portal.example.invalid/session?secret=fixture', '跳转 [链接已隐藏]'],
    ['HTTP://portal.example.invalid/path 和 https://pay.example.invalid', '[链接已隐藏] 和 [链接已隐藏]'],
    ['Bearer fixture-auth', 'Bearer [已隐藏]'],
    ['bEaReR fixture-auth', 'Bearer [已隐藏]']
  ]
  for (const key of [
    'accessToken', 'access_token', 'access-token',
    'refreshToken', 'refresh_token', 'refresh-token',
    'csrfToken', 'csrf_token', 'csrf-token',
    'sessionApiKey', 'session_api_key', 'session-api-key', 'secret', 'cookie'
  ]) cases.push([`${key}: fixture-private; 安全说明`, `${key}=[已隐藏]; 安全说明`])
  cases.push(['access_token=fixture-private,安全说明', 'access_token=[已隐藏],安全说明'])
  for (const [input, expected] of cases) {
    await t.test(input, () => {
      const records = { a: record({
        message: input, warning: input, previousPlan: input,
        renewal: renewal('paid', { planName: input })
      }) }
      const { storage, loaded } = roundTrip(records)
      const fromOldStorage = loadSubscriptionRecords(memoryStorage(encoded(records)))
      for (const row of [stored(storage).records.a, loaded.a, fromOldStorage.a]) {
        assert.equal(row.message, expected)
        assert.equal(row.warning, expected)
        assert.equal(row.previousPlan, expected)
        assert.equal(row.renewal.planName, expected)
      }
      assert.equal(storage.writes[0].value.includes('fixture-private'), false)
    })
  }
})

test('文本长度受限，非字符串不被隐式转换为结果说明或套餐名', async t => {
  const long = '长'.repeat(2100)
  const { loaded } = roundTrip({ a: record({
    message: long, warning: long, previousPlan: long, renewal: renewal('paid', { planName: long })
  }) })
  assert.equal(loaded.a.message, '长'.repeat(2000))
  assert.equal(loaded.a.warning, '长'.repeat(2000))
  assert.equal(loaded.a.previousPlan, '长'.repeat(160))
  assert.equal(loaded.a.renewal.planName, '长'.repeat(160))
  for (const value of [undefined, null, 42, false, {}, []]) {
    await t.test(String(value), () => {
      const { loaded } = roundTrip({ a: record({
        message: value, warning: value, previousPlan: value,
        renewal: renewal('paid', { planName: value })
      }) })
      assert.equal(loaded.a.message, '未提供结果说明')
      assert.equal(loaded.a.warning, undefined)
      assert.equal(loaded.a.previousPlan, undefined)
      assert.equal(loaded.a.renewal.planName, '')
    })
  }
})

test('重载保留各终态的结果、标志和毫秒时间，重复保存重载保持稳定', async t => {
  for (const state of STATES) {
    for (const status of ['success', 'warning', 'error']) {
      await t.test(`${status} / ${state}`, () => {
        const original = record({
          status, operation: 'switch', renewal: renewal(state),
          message: '已记录结果', previousPlan: 'Kiro Pro+', warning: '需要保留的提示',
          needsCheck: true, settled: true,
          attemptedAt: NOW - 2000, completedAt: NOW + 500, lastCheckAt: NOW - 500
        })
        const expected = { ...original, renewal: { ...original.renewal, subscriptionId: '' } }
        const { storage, loaded } = roundTrip({ a: original })
        assert.deepEqual(plain(loaded.a), expected)
        assertReadOnly(loaded.a)
        const firstRaw = storage.writes[0].value
        saveSubscriptionRecords(storage, loaded)
        assert.equal(storage.writes[1].value, firstRaw)
        assert.deepEqual(plain(loadSubscriptionRecords(storage)), plain(loaded))
        assert.equal(Object.getPrototypeOf(loaded), null)
      })
    }
  }
  const { loaded } = roundTrip({ a: record() })
  assert.equal(canSwitchSubscription(loaded.a), true, '已成功检查的未处理 paid 重载后仍可切换')
})

test('中断记录恢复为警告，运行中的 switch 强制复查而不能直接重试', async t => {
  const cases = [
    ['pending', 'check', false, false], ['running', 'check', false, false],
    ['pending', 'switch', false, false], ['running', 'switch', false, true],
    ['pending', 'switch', true, true], ['running', 'switch', true, true],
    ['pending', 'check', true, true], ['running', 'check', true, true],
    ['pending', undefined, false, false], ['running', undefined, false, false]
  ]
  for (const [status, operation, needsCheck, expectedNeedsCheck] of cases) {
    await t.test(`${status} ${operation} needsCheck=${needsCheck}`, () => {
      const original = record({ status, operation, needsCheck, message: '操作进行中' })
      const before = structuredClone(original)
      const { storage, loaded } = roundTrip({ a: original })
      const recovered = loaded.a
      assert.equal(stored(storage).records.a.status, status, '保存不冒充操作已完成')
      assert.equal(recovered.status, 'warning')
      assert.equal(recovered.operation, operation)
      assert.equal(recovered.needsCheck, expectedNeedsCheck)
      assert.equal(recovered.settled, false)
      assert.match(recovered.message, expectedNeedsCheck ? /先只读复查.*禁止重复提交/ : /中断.*只读检查/)
      assertReadOnly(recovered)
      assert.deepEqual(plain(recovered.renewal), { ...original.renewal, subscriptionId: '' })
      for (const key of ['attemptedAt', 'completedAt', 'lastCheckAt']) {
        assert.equal(recovered[key], original[key], `恢复不能伪造 ${key}`)
      }
      assert.deepEqual(original, before)
      assert.equal(storage.writes.length, 1, '加载不能自动保存或重试操作')
      const again = roundTrip(loaded).loaded
      assert.deepEqual(plain(again), plain(loaded))
      assertReadOnly(again.a)
    })
  }
  for (const state of STATES) {
    const { loaded } = roundTrip({ a: record({
      status: 'running', operation: 'switch', renewal: renewal(state), settled: true
    }) })
    assert.equal(loaded.a.needsCheck, true)
    assertReadOnly(loaded.a)
  }
})

test('检查失败保留以前 renewal 和成功读取时间，但新的失败时间不能造成假成功', async t => {
  for (const state of STATES) {
    for (const needsCheck of [false, true]) {
      await t.test(`${state} needsCheck=${needsCheck}`, () => {
        const previous = renewal(state)
        const failed = record({
          status: 'error', message: '只读检查失败：fixture timeout',
          renewal: previous, needsCheck, settled: true,
          attemptedAt: NOW + 5000, completedAt: NOW + 7000, lastCheckAt: NOW + 7000
        })
        const { loaded } = roundTrip({ a: failed })
        assert.equal(loaded.a.status, 'error')
        assert.equal(loaded.a.message, failed.message)
        assert.equal(loaded.a.needsCheck, needsCheck)
        assert.equal(loaded.a.settled, true)
        assert.deepEqual(plain(loaded.a.renewal), { ...previous, subscriptionId: '' })
        assert.equal(loaded.a.renewal.checkedAt, NOW)
        assert.equal(loaded.a.lastCheckAt, NOW + 7000)
        assert.equal(loaded.a.attemptedAt, NOW + 5000)
        assert.equal(loaded.a.completedAt, NOW + 7000)
        assertReadOnly(loaded.a)
      })
    }
  }
})

test('复查标志在失败和重载后保持，直到新的成功 paid 检查显式解除', () => {
  const interrupted = roundTrip({ a: record({ status: 'running', operation: 'switch' }) }).loaded.a
  const failed = roundTrip({ a: {
    ...interrupted, status: 'error', operation: 'check', message: '只读复查失败', lastCheckAt: NOW + 1000
  } }).loaded.a
  assert.equal(failed.needsCheck, true)
  assertReadOnly(failed)
  const success = { ...failed, status: 'success', message: '只读复查完成',
    renewal: renewal('paid', { checkedAt: NOW + 2000 }), lastCheckAt: NOW + 2000 }
  assertReadOnly(roundTrip({ a: success }).loaded.a)
  const confirmed = roundTrip({ a: { ...success, needsCheck: false, settled: false } }).loaded.a
  assert.equal(canSwitchSubscription(confirmed), true)
  assert.equal(needsSubscriptionCheck(confirmed), true)
})

test('无效 renewal 不得恢复为已确认 Free 或可切换 paid', async t => {
  const cases = [
    ['missing', undefined], ['null', null], ['array', []], ['primitive', 'paid'],
    ['missing state', { checkedAt: NOW }], ['unknown state', renewal('unknown')],
    ['wrong case', renewal('Free')], ['missing checkedAt', renewal('free', { checkedAt: undefined })]
  ]
  for (const checkedAt of [0, -1, NaN, Infinity, -Infinity, String(NOW), null, true, {}, []]) {
    cases.push([`paid checkedAt=${String(checkedAt)}`, renewal('paid', { checkedAt })])
    cases.push([`free checkedAt=${String(checkedAt)}`, renewal('free', { checkedAt })])
  }
  for (const [name, value] of cases) {
    await t.test(name, () => {
      const records = { a: record({ renewal: value }) }
      const { storage, loaded } = roundTrip(records)
      assert.equal(Object.hasOwn(stored(storage).records.a, 'renewal'), false)
      assert.equal(loaded.a.renewal, undefined)
      assertReadOnly(loaded.a)
      const fromOldStorage = loadSubscriptionRecords(memoryStorage(encoded(records)))
      assert.equal(fromOldStorage.a.renewal, undefined)
      assertReadOnly(fromOldStorage.a)
    })
  }
})

test('时间只保留正有限数，不接受字符串、零、负数或非有限值', async t => {
  for (const value of [undefined, null, 0, -1, NaN, Infinity, -Infinity, String(NOW), true, {}, []]) {
    await t.test(String(value), () => {
      const records = { a: record({
        attemptedAt: value, completedAt: value, lastCheckAt: value,
        renewal: renewal('paid', { currentPeriodEnd: value, transitionAt: value })
      }) }
      const { storage, loaded } = roundTrip(records)
      for (const row of [stored(storage).records.a, loaded.a,
        loadSubscriptionRecords(memoryStorage(encoded(records))).a]) {
        for (const key of ['attemptedAt', 'completedAt', 'lastCheckAt']) assert.equal(row[key], undefined)
        assert.equal(row.renewal.currentPeriodEnd, undefined)
        assert.equal(row.renewal.transitionAt, undefined)
        assert.equal(row.renewal.checkedAt, NOW)
      }
    })
  }
  const { loaded } = roundTrip({ a: record({ attemptedAt: 1, renewal: renewal('paid', { checkedAt: 1 }) }) })
  assert.equal(loaded.a.attemptedAt, 1)
  assert.equal(loaded.a.renewal.checkedAt, 1)
})

test('畸形 JSON 明确抛错，不返回空记录或覆盖损坏数据', async t => {
  for (const raw of ['{', 'not-json', ' ', '{"version":1,"records":}', '{"version":1,"records":{},}']) {
    await t.test(JSON.stringify(raw), () => {
      const storage = memoryStorage(raw)
      assert.throws(() => loadSubscriptionRecords(storage), error => error.name === 'SyntaxError')
      assert.deepEqual(storage.writes, [])
      assert.equal(storage.values.get(SUBSCRIPTION_RECORDS_KEY), raw)
    })
  }
})

test('无效顶层格式和版本必须显式失败，而非静默当作首次使用', async t => {
  const cases = [
    null, false, 1, 'records', [], {}, { records: {} }, { version: 1 },
    { version: 1, records: null }, { version: 1, records: [] },
    { version: 1, records: 'records' }, { version: 1, records: 42 },
    ...[0, 2, -1, '1', true, null].map(version => ({ version, records: { a: record() } }))
  ]
  for (const data of cases) {
    await t.test(JSON.stringify(data), () => {
      const raw = JSON.stringify(data)
      const storage = memoryStorage(raw)
      assert.throws(() => loadSubscriptionRecords(storage), /版本或格式无效.*只读检查/)
      assert.deepEqual(storage.writes, [])
      assert.equal(storage.values.get(SUBSCRIPTION_RECORDS_KEY), raw)
    })
  }
})

test('任意一条记录格式无效时，加载拒绝部分成功，保存不能写出部分结果', async t => {
  const invalid = [null, [], 'success', 42, {}, { status: null }, { status: false },
    { status: 1 }, { status: '' }, { status: 'done' }, { status: 'SUCCESS' },
    { status: ['success'] }]
  for (const value of invalid) {
    await t.test(JSON.stringify(value), () => {
      const records = { valid: record(), invalid: value }
      const raw = encoded(records)
      const readStorage = memoryStorage(raw)
      assert.throws(() => loadSubscriptionRecords(readStorage), /记录格式无效.*只读检查/)
      assert.deepEqual(readStorage.writes, [])
      assert.equal(readStorage.values.get(SUBSCRIPTION_RECORDS_KEY), raw)
      const oldRaw = encoded({ old: record({ renewal: renewal('free') }) })
      const writeStorage = memoryStorage(oldRaw)
      assert.throws(() => saveSubscriptionRecords(writeStorage, records), /记录格式无效.*只读检查/)
      assert.deepEqual(writeStorage.writes, [])
      assert.equal(writeStorage.values.get(SUBSCRIPTION_RECORDS_KEY), oldRaw)
    })
  }
})

test('存储读取失败原样抛出，不降级为空字典也不尝试写回', () => {
  const failure = new Error('fixture storage access denied')
  failure.name = 'SecurityError'
  let reads = 0
  const storage = {
    getItem(key) { assert.equal(key, SUBSCRIPTION_RECORDS_KEY); reads++; throw failure },
    setItem() { assert.fail('读取失败不能写回') }
  }
  assert.throws(() => loadSubscriptionRecords(storage), error => error === failure)
  assert.equal(reads, 1)
})

test('存储写入失败原样抛出，不能报告成功、重试或损坏已有记录', () => {
  const oldRaw = encoded({ old: record({ renewal: renewal('free') }) })
  const storage = memoryStorage(oldRaw)
  const failure = new Error('fixture storage quota exhausted')
  failure.name = 'QuotaExceededError'
  let attempts = 0
  storage.setItem = (key, value) => {
    attempts++
    assert.equal(key, SUBSCRIPTION_RECORDS_KEY)
    assert.equal(JSON.parse(value).records.a.needsCheck, true)
    throw failure
  }
  const records = { a: record({ status: 'running', operation: 'switch', needsCheck: true }) }
  const before = structuredClone(records)
  assert.throws(() => saveSubscriptionRecords(storage, records), error => error === failure)
  assert.equal(attempts, 1)
  assert.deepEqual(storage.reads, [])
  assert.equal(storage.values.get(SUBSCRIPTION_RECORDS_KEY), oldRaw)
  assert.deepEqual(records, before)
  const loaded = loadSubscriptionRecords(storage)
  assert.deepEqual(Object.keys(loaded), ['old'])
  assertReadOnly(loaded.a)
})

test('加载和保存过滤原型危险键，保留合法同名键并返回无原型字典', () => {
  // Object.fromEntries creates an own __proto__ key instead of object-literal prototype syntax.
  const records = Object.fromEntries([
    ['__proto__', { polluted: 'fixture-pollution' }], ['constructor', null], ['prototype', []],
    ['a', record()], ['toString', record()], ['valueOf', record()], ['hasOwnProperty', record()]
  ])
  const before = structuredClone(records)
  const raw = encoded(records)
  assert.ok(raw.includes('"__proto__"'))
  const direct = loadSubscriptionRecords(memoryStorage(raw))
  const { storage, loaded } = roundTrip(records)
  for (const result of [direct, loaded, stored(storage).records]) {
    assert.deepEqual(Object.keys(result).sort(), ['a', 'hasOwnProperty', 'toString', 'valueOf'])
    for (const key of ['__proto__', 'constructor', 'prototype']) {
      assert.equal(Object.hasOwn(result, key), false, key)
    }
    assert.equal(result.polluted, undefined)
    assert.equal(result.toString.status, 'success')
  }
  for (const result of [direct, loaded]) {
    assert.equal(Object.getPrototypeOf(result), null)
    assert.equal(result.constructor, undefined)
    assert.equal(result.__proto__, undefined)
    assertReadOnly(result.constructor)
  }
  assert.deepEqual(records, before)
  assert.equal(Object.hasOwn(Object.prototype, 'polluted'), false)
  assert.equal(({}).polluted, undefined)
})

test('保存只枚举自有记录，忽略继承属性和符号键', () => {
  const records = Object.create({ inherited: record() })
  records.own = record()
  records[Symbol('fixture-private')] = { status: 'invalid' }
  const { storage, loaded } = roundTrip(records)
  assert.deepEqual(Object.keys(stored(storage).records), ['own'])
  assert.deepEqual(Object.keys(loaded), ['own'])
  assert.equal(loaded.inherited, undefined)
  assertReadOnly(loaded.inherited)
})

test('重载成功结果仍按实际续费状态决定跳过检查和切换资格', async t => {
  for (const [state, needsCheck, switchable] of [
    ['free', false, false], ['scheduled-free', false, false],
    ['paid', true, true], ['canceling', true, false]
  ]) {
    await t.test(state, () => {
      const { loaded } = roundTrip({ a: record({ renewal: renewal(state) }) })
      assert.equal(needsSubscriptionCheck(loaded.a), needsCheck)
      assert.equal(canSwitchSubscription(loaded.a), switchable)
    })
  }
})

test('损坏的复查或已处理标志不得被归一化成 false 而放行 paid 切换', async t => {
  for (const field of ['needsCheck', 'settled']) {
    for (const [name, read] of [
      ['直接加载', records => loadSubscriptionRecords(memoryStorage(encoded(records)))],
      ['保存后重载', records => roundTrip(records).loaded]
    ]) {
      await t.test(`${name}: ${field}="true"`, () => {
        const records = { a: record({ [field]: 'true' }) }
        let loaded
        try {
          loaded = read(records)
        } catch (error) {
          // Rejecting a malformed record or retaining a read-only guard are both safe.
          assert.match(error.message, /格式无效.*只读检查/)
          return
        }
        assertReadOnly(loaded.a)
      })
    }
  }
})
