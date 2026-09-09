import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildPostalCodeRequest,
  buildCheckoutAddressRequest,
  normalizeAmapCheckoutResponse,
  normalizeAmapResponse,
  normalizeBaiduResponse,
  parseCheckoutAddressLine,
  parsePostalCode
} from '../src/shared/billing.ts'

test('高德地点响应归一化为完整地址，并过滤空地点', () => {
  assert.deepEqual(
    normalizeAmapResponse({
      status: '1',
      pois: [
        {
          pname: '广东省',
          cityname: '深圳市',
          adname: '南山区',
          address: '南海大道3688号',
          name: '深圳大学'
        },
        { pname: '广东省', cityname: '深圳市', name: '只有名称没有地址的地点' },
        { pname: '', cityname: '', address: '' }
      ]
    }),
    ['广东省深圳市南山区南海大道3688号深圳大学']
  )
  assert.deepEqual(normalizeAmapResponse({ status: '0', pois: [] }), [])
})

test('百度地点响应归一化为完整地址', () => {
  assert.deepEqual(
    normalizeBaiduResponse({
      status: 0,
      results: [
        {
          province: '四川省',
          city: '成都市',
          area: '武侯区',
          address: '一环路南一段24号',
          name: '四川大学望江校区'
        },
        { province: '四川省', city: '成都市', name: '只有名称没有地址的地点' }
      ]
    }),
    ['四川省成都市武侯区一环路南一段24号四川大学望江校区']
  )
})

test('邮编解析只接受唯一 postalCode 字段和六位数字', () => {
  assert.equal(parsePostalCode('{"postalCode":"518000"}'), '518000')
  assert.throws(() => parsePostalCode('{"postalCode":518000}'), /六位数字/)
  assert.throws(() => parsePostalCode('```json\n{"postalCode":"518000"}\n```'), /严格 JSON/)
  assert.throws(() => parsePostalCode('{"postalCode":"51800"}'), /六位数字/)
  assert.throws(
    () => parsePostalCode('{"postalCode":"518000","city":"深圳"}'),
    /六位数字/
  )
})

test('Chat Completions 请求只在选择时发送 reasoning_effort', () => {
  const normal = buildPostalCodeRequest('广东省深圳市南山区', 'example-model', '')
  assert.equal(normal.model, 'example-model')
  assert.equal('reasoning_effort' in normal, false)
  assert.deepEqual(normal.response_format, { type: 'json_object' })

  const reasoning = buildPostalCodeRequest('广东省深圳市南山区', 'example-model', 'high')
  assert.equal(reasoning.reasoning_effort, 'high')
})


test('Checkout 高德扩展 POI 只接受同一记录中的完整行政区、详细地址和六位邮编', () => {
  assert.deepEqual(
    normalizeAmapCheckoutResponse({
      status: '1',
      pois: [
        { pname: '云南省', cityname: '昆明市', adname: '官渡区', address: '丽华路122号', postcode: '650200' },
        { pname: '云南省', cityname: '昆明市', adname: '官渡区', address: '缺邮编路1号', postcode: '' },
        { pname: '云南省', cityname: '昆明市', address: '缺区路1号', postcode: '650200' }
      ]
    }),
    [{ province: '云南省', city: '昆明市', district: '官渡区', address: '丽华路122号', postalCode: '650200' }]
  )
})

test('Checkout AI 地址提取只接受严格单字段 JSON，且请求不让模型改行政区或邮编', () => {
  assert.equal(parseCheckoutAddressLine('{"addressLine1":"丽华路122号"}'), '丽华路122号')
  assert.throws(() => parseCheckoutAddressLine('{"addressLine1":"丽华路"}'), /地址第 1 行/)
  assert.throws(() => parseCheckoutAddressLine('{"addressLine1":"丽华路122号","postalCode":"650200"}'), /地址第 1 行/)
  const request = buildCheckoutAddressRequest('云南省昆明市官渡区丽华路122号', 'example-model', 'low')
  assert.equal(request.reasoning_effort, 'low')
  assert.match(request.messages[0].content, /不得返回省、市、区、邮编/)
})
