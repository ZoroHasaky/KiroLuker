import test from 'node:test'
import assert from 'node:assert/strict'
import { BILLING_REGIONS, BILLING_STREET_NAMES, billingPinyin, createLocalBillingAddress } from '../src/shared/billingGenerator.ts'

const regionKeys = new Set(BILLING_REGIONS.map((item) => [item.province, item.city, item.district].join('|')))

function assertTitleCaseWords(value) {
  for (const word of value.split(' ')) {
    if (/^\d+$/.test(word)) continue
    assert.match(word, /^[A-Z][a-z]*$/)
  }
}

test('本地账单生成器使用有效行政区并输出符合规则的字段', () => {
  for (let i = 0; i < 100; i += 1) {
    const result = createLocalBillingAddress()
    assert.ok(regionKeys.has([result.province, result.city, result.district].join('|')))
    assert.equal(result.pinyinCity, billingPinyin(result.city))
    assert.equal(result.pinyinDistrict, billingPinyin(result.district))
    assertTitleCaseWords(result.pinyinCity)
    assertTitleCaseWords(result.pinyinDistrict)
    assert.match(result.addressLine1, /^[A-Z][A-Za-z]*(?: [A-Z][A-Za-z]*)* \d+ Hao$/)
    assert.match(result.postalCode, /^\d{6}$/)
  }
})

test('账单拼音格式符合示例规则', () => {
  assert.equal(billingPinyin('杭州市'), 'Hangzhou Shi')
  assert.equal(billingPinyin('拱墅区'), 'Gongshu Qu')
  assert.equal(billingPinyin('龙湖天路233号'), 'Longhutian Lu 233 Hao')
})

test('本地数据覆盖中国大陆 31 个省级行政区和超过 100 组道路样本', () => {
  const provinces = new Set(BILLING_REGIONS.map((item) => item.province))
  const expectedProvinces = new Set([
    '北京市', '天津市', '河北省', '山西省', '内蒙古自治区', '辽宁省', '吉林省',
    '黑龙江省', '上海市', '江苏省', '浙江省', '安徽省', '福建省', '江西省',
    '山东省', '河南省', '湖北省', '湖南省', '广东省', '广西壮族自治区', '海南省',
    '重庆市', '四川省', '贵州省', '云南省', '西藏自治区', '陕西省', '甘肃省',
    '青海省', '宁夏回族自治区', '新疆维吾尔自治区'
  ])
  assert.deepEqual(provinces, expectedProvinces)
  assert.equal(provinces.size, 31)
  assert.ok(BILLING_REGIONS.length > 250)
  assert.ok(BILLING_STREET_NAMES.length >= 100)
  assert.equal(new Set(BILLING_STREET_NAMES).size, BILLING_STREET_NAMES.length)
})

test('随机池扩展后可连续生成且不会连续重复道路', () => {
  const generated = Array.from({ length: 100 }, () => createLocalBillingAddress())
  for (let index = 1; index < generated.length; index += 1) {
    const previousStreet = generated[index - 1].addressLine1.replace(/ \d+ Hao$/, '')
    const currentStreet = generated[index].addressLine1.replace(/ \d+ Hao$/, '')
    assert.notEqual(currentStreet, previousStreet)
  }
  assert.ok(generated.some((item) => item.province !== generated[0].province))
})
