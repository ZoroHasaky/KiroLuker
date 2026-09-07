import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import vm from 'node:vm'
import ts from 'typescript'

const source = await fs.readFile(new URL('../src/renderer/src/utils/subscriptionFilters.ts', import.meta.url), 'utf8')
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
})
const exports = {}
vm.runInNewContext(outputText, { exports, require(id) { assert.fail(`Unexpected dependency: ${id}`) } })
const { currentSubscriptionType, subscriptionArrangement, filterSubscriptionAccounts,
  subscriptionPlanOptions, subscriptionArrangementOptions } = exports
const account = (id, type = 'Pro', nickname) => ({ id, email: `${id}@example.invalid`, nickname,
  subscription: { type, title: `Kiro ${type}` } })
const record = (state, planName = 'Kiro Pro', patch = {}) => ({
  status: 'success', needsCheck: false, message: 'fixture',
  renewal: { state, planName, subscriptionId: '', checkedAt: 1800000000000 }, ...patch
})
const accounts = [account('paid'), account('scheduled', 'Free'), account('free', 'Pro'),
  account('canceling'), account('unchecked', 'Pro_Plus', 'Special'), account('failed'), account('uncertain')]
const records = {
  paid: record('paid'), scheduled: record('scheduled-free'), free: record('free', 'Kiro Free'),
  canceling: record('canceling'), failed: { status: 'error', message: 'fixture failure' },
  uncertain: record('paid', 'Kiro Pro', { status: 'warning', needsCheck: true })
}
const filter = (patch = {}, input = accounts, results = records) =>
  Array.from(filterSubscriptionAccounts(input, results, { search: '', plan: 'all', arrangement: 'all', ...patch }), (a) => a.id)

test('订阅类型覆盖本地所有档位与门户名称写法，不把未知套餐当 Free', () => {
  for (const [type, names] of [
    ['Free', ['Free', 'KIRO FREE']], ['Pro', ['Kiro Pro', ' pro ']],
    ['Pro_Plus', ['Kiro Pro+', 'KIRO PRO PLUS', 'Pro_Plus', 'Pro +']],
    ['Pro_Max', ['Kiro Pro Max', 'KIRO_PRO_MAX', 'ProMax']],
    ['Power', ['Kiro Power', 'POWER']], ['Teams', ['Kiro Teams', 'teams']]
  ]) {
    assert.equal(currentSubscriptionType(account('local', type)), type)
    for (const title of names) assert.equal(currentSubscriptionType(account('portal'), record('paid', title)), type, title)
  }
  for (const title of ['Kiro Future', 'Professional', 'Freeish', 'Kiro Business']) {
    assert.equal(currentSubscriptionType(account('unknown', 'Free'), record('paid', title)), 'unknown')
  }
  assert.equal(currentSubscriptionType(account('legacy', 'Enterprise')), 'unknown')
})

test('门户当前套餐优先于本地标签，周期末 Free 仍按当前 Pro 筛选', () => {
  assert.equal(currentSubscriptionType(accounts[1], records.scheduled), 'Pro')
  assert.equal(currentSubscriptionType(accounts[2], records.free), 'Free')
  assert.deepEqual(filter({ plan: 'Free' }), ['free'])
  assert.deepEqual(filter({ plan: 'Pro', arrangement: 'scheduled-free' }), ['scheduled'])
  assert.deepEqual(filter({ plan: 'Free', arrangement: 'scheduled-free' }), [])
})

test('没有门户套餐时参考本地类型，但不会凭本地 Free 推断续费安排', () => {
  assert.equal(currentSubscriptionType(account('no-portal', 'Pro_Plus')), 'Pro_Plus')
  assert.equal(currentSubscriptionType(account('empty-title', 'Teams'), record('paid', '')), 'Teams')
  assert.equal(subscriptionArrangement(), 'unknown')
  assert.equal(subscriptionArrangement(records.failed), 'unknown')
  assert.deepEqual(filter({ arrangement: 'unknown' }), ['unchecked', 'failed'])
  assert.deepEqual(filter({ plan: 'Free', arrangement: 'unknown' }, [account('local-free', 'Free')], {}), ['local-free'])
})

test('续费安排筛选区分付费、立即 Free、周期末 Free 与取消中', () => {
  for (const [arrangement, expected] of [
    ['paid', ['paid']], ['free', ['free']], ['scheduled-free', ['scheduled']], ['canceling', ['canceling']]
  ]) assert.deepEqual(filter({ arrangement }), expected)
})

test('待复核优先单独归类，不沿用旧付费或已安排快照冒充已确认', () => {
  for (const state of ['paid', 'free', 'scheduled-free', 'canceling']) {
    assert.equal(subscriptionArrangement(record(state, 'Kiro Pro', { needsCheck: true })), 'needs-check')
  }
  assert.deepEqual(filter({ arrangement: 'needs-check' }), ['uncertain'])
  assert.equal(subscriptionArrangement({ status: 'warning', needsCheck: true }), 'needs-check')
})

test('失败复查保留上次确认的类型与安排，并不修改失败状态', () => {
  const failed = record('scheduled-free', 'Kiro Pro', { status: 'error' })
  assert.deepEqual(filter({ plan: 'Pro', arrangement: 'scheduled-free' }, [account('failed')], { failed }), ['failed'])
  assert.equal(failed.status, 'error')
})

test('搜索与两类筛选按交集工作，支持邮箱、昵称、ID和忽略大小写', () => {
  assert.deepEqual(filter({ search: ' SCHED ', plan: 'Pro', arrangement: 'scheduled-free' }), ['scheduled'])
  assert.deepEqual(filter({ search: 'special', plan: 'Pro_Plus', arrangement: 'unknown' }), ['unchecked'])
  assert.deepEqual(filter({ search: 'FREE@EXAMPLE.INVALID', plan: 'Free', arrangement: 'free' }), ['free'])
  assert.deepEqual(filter({ search: 'scheduled', plan: 'Free' }), [])
  assert.deepEqual(filter({ search: ' PAID ', arrangement: 'paid' }), ['paid'])
})

test('清除类型筛选后恢复全集或剩余搜索范围，空列表正常返回', () => {
  assert.deepEqual(filter(), accounts.map((a) => a.id))
  assert.deepEqual(filter({ search: 'free' }), ['free'])
  assert.deepEqual(filter({ search: 'not-found' }), [])
  assert.deepEqual(filter({}, [], {}), [])
})

test('筛选不改写账号、已保存记录或顺序，并返回原账号对象', () => {
  const before = structuredClone({ accounts, records })
  const selected = filterSubscriptionAccounts(accounts, records, { search: '', plan: 'Pro', arrangement: 'all' })
  assert.equal(selected[0], accounts[0])
  assert.deepEqual(Array.from(selected, (a) => a.id), ['paid', 'scheduled', 'canceling', 'failed', 'uncertain'])
  assert.deepEqual({ accounts, records }, before)
})

test('读取记录更新后筛选立即跟随新状态，原账号本地标签保持不变', () => {
  const row = account('changing')
  const data = { changing: record('paid') }
  assert.deepEqual(filter({ arrangement: 'paid' }, [row], data), ['changing'])
  data.changing = record('scheduled-free')
  assert.deepEqual(filter({ arrangement: 'paid' }, [row], data), [])
  assert.deepEqual(filter({ plan: 'Pro', arrangement: 'scheduled-free' }, [row], data), ['changing'])
  data.changing = record('free', 'Kiro Free')
  assert.deepEqual(filter({ plan: 'Free', arrangement: 'free' }, [row], data), ['changing'])
  assert.equal(row.subscription.type, 'Pro')
})

test('筛选选项值唯一且包含全部、未知与待复核选项', () => {
  for (const options of [subscriptionPlanOptions, subscriptionArrangementOptions]) {
    assert.equal(new Set(options.map((o) => o.value)).size, options.length)
    assert.equal(options[0].value, 'all')
    assert.ok(options.some((o) => o.value === 'unknown'))
  }
  assert.ok(subscriptionArrangementOptions.some((o) => o.value === 'needs-check'))
})
