import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const billing = {
  pinyinName: 'LI MINGHUA',
  countryCode: 'CN',
  province: '福建省',
  city: '福州市',
  district: '鼓楼区',
  pinyinCity: 'Fuzhou Shi',
  pinyinDistrict: 'Gulou Qu',
  addressLine1: 'Wusi Lu 88 Hao',
  postalCode: '350001'
}

class FormControl {
  constructor(tagName, attributes = {}) {
    this.tagName = tagName
    this.attributes = attributes
    this.id = attributes.id ?? ''
    this.name = attributes.name ?? ''
    this.options = []
    this._value = attributes.value ?? ''
    this.events = []
  }

  get autocomplete() {
    return this.attributes.autocomplete ?? ''
  }

  get value() {
    return this._value
  }

  set value(value) {
    this._value = value
  }

  getAttribute(name) {
    return this.attributes[name] ?? null
  }

  closest() {
    return null
  }

  querySelector() {
    return null
  }

  focus() {}

  dispatchEvent(event) {
    this.events.push(event.type)
    return true
  }
}

class HTMLInputElement extends FormControl {
  constructor(attributes) {
    super('INPUT', attributes)
  }
}

class HTMLTextAreaElement extends FormControl {
  constructor(attributes) {
    super('TEXTAREA', attributes)
  }
}

class HTMLSelectElement extends FormControl {
  constructor(attributes, options) {
    super('SELECT', attributes)
    this.options = options
  }
}

function option(value, textContent) {
  return { value, textContent }
}

function createDocument(fields, labels = []) {
  return {
    getElementById: (id) => fields.find((field) => field.id === id) ?? null,
    querySelector: (selector) => {
      if (selector.startsWith('input[') || selector.startsWith('textarea[') || selector.startsWith('select[')) {
        const match = selector.match(/\[autocomplete="(.+)"\]/)
        if (match) return fields.find((field) => field.autocomplete === match[1]) ?? null
      }
      const match = selector.match(/^\[autocomplete="(.+)"\]$/)
      return match ? fields.find((field) => field.autocomplete === match[1]) ?? null : null
    },
    querySelectorAll: (selector) => {
      if (selector === 'label') return labels
      if (selector === 'input, textarea, select') return fields
      if (selector === 'input, textarea') return fields.filter((f) => f.tagName === 'INPUT' || f.tagName === 'TEXTAREA')
      if (selector === 'select') return fields.filter((f) => f.tagName === 'SELECT')
      return []
    }
  }
}

function formFields() {
  return [
    new HTMLSelectElement({ autocomplete: 'country', id: 'country' }, [option('US', 'United States'), option('CN', 'China')]),
    new HTMLInputElement({ autocomplete: 'cc-name', id: 'name' }),
    new HTMLSelectElement({ autocomplete: 'address-level1', id: 'administrativeArea' }, [option('Fujian', '福建省')]),
    new HTMLInputElement({ autocomplete: 'address-level2', id: 'locality' }),
    new HTMLInputElement({ autocomplete: 'address-level3', id: 'dependentLocality' }),
    new HTMLInputElement({ autocomplete: 'address-line1', id: 'addressLine1' }),
    new HTMLInputElement({ autocomplete: 'postal-code', id: 'postalCode' })
  ]
}

function execute(script, customDocument) {
  const fields = formFields()
  const raw = Function(
    'document',
    'location',
    'Event',
    'HTMLInputElement',
    'HTMLTextAreaElement',
    'HTMLSelectElement',
    `return ${script}`
  )(
    customDocument ?? createDocument(fields),
    { hostname: 'checkout.stripe.com' },
    class Event {
      constructor(type) {
        this.type = type
      }
    },
    HTMLInputElement,
    HTMLTextAreaElement,
    HTMLSelectElement
  )
  return { result: JSON.parse(raw), fields }
}

function androidScript() {
  const source = readFileSync(resolve(root, 'app/android/app/src/main/kotlin/com/kiroluker/kiro_lucker/MainActivity.kt'), 'utf8')
  const match = source.match(/private fun checkoutFillScript[\s\S]*?return """\s*([\s\S]*?)\s*"""\.trimIndent\(\)/)
  assert.ok(match, 'Android 填充脚本必须存在')
  return match[1]
    .replace('const data = $payload;', `const data = ${JSON.stringify(billing)};`)
    .replaceAll("${'$'}{'$'}{key}", '${key}')
}

function iosScript() {
  const source = readFileSync(resolve(root, 'app/ios/Runner/AppDelegate.swift'), 'utf8')
  const match = source.match(/private func checkoutFillScript[\s\S]*?return """\s*([\s\S]*?)\s*"""/)
  assert.ok(match, 'iOS 填充脚本必须存在')
  return match[1].replace('const data = \\(json);', `const data = ${JSON.stringify(billing)};`).replaceAll('\\\\', '\\')
}

for (const [platform, script] of [
  ['Android', androidScript],
  ['iOS', iosScript]
]) {
  test(`${platform} 支付填充脚本可填充 Stripe 的原生地址字段`, () => {
    const { result, fields } = execute(script())
    assert.equal(result.success, true)
    assert.deepEqual(result.failed, [])
    assert.deepEqual(result.completed, ['国家/地区', '持卡人姓名', '省/州', '城市', '地区', '地址第 1 行', '邮编'])
    assert.deepEqual(fields.map((field) => field.value), ['CN', billing.pinyinName, 'Fujian', billing.pinyinCity, billing.pinyinDistrict, billing.addressLine1, billing.postalCode])
    for (const field of fields) assert.deepEqual(field.events, ['input', 'change', 'blur'])
  })

  test(`${platform} 支付填充脚本在有“国家/地区”标签时不会将地区误识别为国家下拉框`, () => {
    // 模拟真实 Stripe 中文页面的无 autocomplete 或 label/placeholder 匹配场景
    const countrySelect = new HTMLSelectElement({ id: 'country' }, [option('US', 'United States'), option('CN', 'China')])
    const countryLabel = { textContent: '国家/地区', htmlFor: 'country', querySelector: () => null }
    const nameInput = new HTMLInputElement({ id: 'name' })
    const nameLabel = { textContent: '持卡人姓名', htmlFor: 'name', querySelector: () => null }
    const adminSelect = new HTMLSelectElement({ id: 'administrativeArea' }, [option('Fujian', '福建省')])
    const adminLabel = { textContent: '省', htmlFor: 'administrativeArea', querySelector: () => null }
    const cityInput = new HTMLInputElement({ id: 'locality', placeholder: '城市' })
    const cityLabel = { textContent: '城市', htmlFor: 'locality', querySelector: () => null }
    const districtInput = new HTMLInputElement({ id: 'dependentLocality', placeholder: '地区' })
    const districtLabel = { textContent: '地区', htmlFor: 'dependentLocality', querySelector: () => null }
    const line1Input = new HTMLInputElement({ id: 'addressLine1', placeholder: '地址第 1 行' })
    const line1Label = { textContent: '地址第 1 行', htmlFor: 'addressLine1', querySelector: () => null }
    const postalInput = new HTMLInputElement({ id: 'postalCode', placeholder: '邮编' })
    const postalLabel = { textContent: '邮编', htmlFor: 'postalCode', querySelector: () => null }

    const fields = [countrySelect, nameInput, adminSelect, cityInput, districtInput, line1Input, postalInput]
    const labels = [countryLabel, nameLabel, adminLabel, cityLabel, districtLabel, line1Label, postalLabel]
    const doc = createDocument(fields, labels)

    const raw = Function(
      'document',
      'location',
      'Event',
      'HTMLInputElement',
      'HTMLTextAreaElement',
      'HTMLSelectElement',
      `return ${script()}`
    )(
      doc,
      { hostname: 'checkout.stripe.com' },
      class Event {
        constructor(type) {
          this.type = type
        }
      },
      HTMLInputElement,
      HTMLTextAreaElement,
      HTMLSelectElement
    )
    const result = JSON.parse(raw)
    assert.equal(result.success, true)
    assert.deepEqual(result.failed, [])
    assert.equal(districtInput.value, billing.pinyinDistrict)
    assert.equal(countrySelect.value, 'CN')
  })
}
