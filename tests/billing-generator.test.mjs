import test from 'node:test'
import assert from 'node:assert/strict'
import { BILLING_REGIONS, billingPinyin, createLocalBillingAddress } from '../src/shared/billingGenerator.ts'

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
