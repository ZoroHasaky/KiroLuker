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

function createDocument(fields) {
  return {
    getElementById: (id) => fields.find((field) => field.id === id) ?? null,
    querySelector: (selector) => {
      const match = selector.match(/^\[autocomplete="(.+)"\]$/)
      return match ? fields.find((field) => field.autocomplete === match[1]) ?? null : null
    },
    querySelectorAll: (selector) => {
      if (selector === 'label') return []
      if (selector === 'input, textarea, select') return fields
      return []
    }
  }
}

function formFields() {
  return [
    new HTMLSelectElement({ autocomplete: 'country' }, [option('US', 'United States'), option('CN', 'China')]),
    new HTMLInputElement({ autocomplete: 'cc-name' }),
    new HTMLSelectElement({ autocomplete: 'address-level1' }, [option('Fujian', '福建省')]),
    new HTMLInputElement({ autocomplete: 'address-level2' }),
    new HTMLInputElement({ autocomplete: 'address-level3' }),
    new HTMLInputElement({ autocomplete: 'address-line1' }),
    new HTMLInputElement({ autocomplete: 'postal-code' })
  ]
}

function execute(script) {
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
    createDocument(fields),
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
  return match[1].replace('const data = \\(json);', `const data = ${JSON.stringify(billing)};`)
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
}