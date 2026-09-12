import { safeStorage } from 'electron'
import { pinyin } from 'pinyin-pro'
import {
  DEFAULT_BILLING_CONFIG,
  type BillingConfigPatch,
  type BillingPublicConfig,
  type BillingReasoningEffort,
  type BillingResult,
  type CheckoutBillingResult,
  type BillingSecretName,
  type BillingSecretPatch,
  type BillingStoredConfig,
  type BillingStoredSecret
} from '../shared/billing'
import { createLocalBillingAddress } from '../shared/billingGenerator'

export interface BillingConfigRepository {
  load: () => BillingStoredConfig | undefined
  save: (config: BillingStoredConfig) => void
}

const SURNAMES = [
  '赵', '钱', '孙', '李', '周', '吴', '郑', '王', '冯', '陈', '褚', '卫', '蒋', '沈',
  '韩', '杨', '朱', '秦', '许', '何', '吕', '张', '孔', '曹', '严', '华', '金', '魏',
  '陶', '姜', '谢', '邹', '苏', '潘', '范', '彭', '鲁', '韦', '马', '方', '任', '袁',
  '柳', '唐', '罗', '宋', '梁', '杜', '程', '傅', '顾', '孟', '黄', '萧', '欧阳',
  '司马', '上官', '诸葛'
] as const

const GIVEN_NAMES = [
  '伟', '芳', '娜', '敏', '静', '强', '磊', '洋', '勇', '艳', '杰', '娟', '涛', '明',
  '超', '秀英', '霞', '平', '刚', '桂英', '文博', '子涵', '雨桐', '梓轩', '欣怡',
  '思远', '嘉宁', '若曦', '浩然', '宇航', '诗涵', '安然', '知夏', '嘉禾', '景行'
] as const

const SECRET_FIELD: Record<BillingSecretName, keyof Pick<BillingStoredConfig, 'amapKey' | 'baiduKey' | 'aiKey'>> = {
  amap: 'amapKey',
  baidu: 'baiduKey',
  ai: 'aiKey'
}

function isBillingSecretName(value: string): value is BillingSecretName {
  return Object.prototype.hasOwnProperty.call(SECRET_FIELD, value)
}

function randomItem<T>(items: readonly T[]): T {
  return items[Math.floor(Math.random() * items.length)]
}

function plainConfig(value?: BillingStoredConfig): BillingStoredConfig {
  const source = value ?? DEFAULT_BILLING_CONFIG
  const reasoningEffort: BillingReasoningEffort = ['', 'low', 'medium', 'high'].includes(
    source.reasoningEffort
  )
    ? source.reasoningEffort
    : ''
  return {
    version: 1,
    aiUrl: typeof source.aiUrl === 'string' ? source.aiUrl.trim() : '',
    aiModel: typeof source.aiModel === 'string' ? source.aiModel.trim() : '',
    reasoningEffort,
    amapKey: source.amapKey,
    baiduKey: source.baiduKey,
    aiKey: source.aiKey
  }
}

function encryptionAvailable(): boolean {
  try {
    return safeStorage.isEncryptionAvailable()
  } catch {
    return false
  }
}

/** 优先使用系统安全存储；回退值由外层 electron-store 的 encryptionKey 负责加密。 */
export function protectBillingSecret(value: string): BillingStoredSecret {
  if (typeof value !== 'string') throw new Error('API Key 必须是字符串')
  const secret = value.trim()
  if (!secret) throw new Error('API Key 不能为空')
  if (!encryptionAvailable()) return { scheme: 'store', value: secret }
  try {
    return {
      scheme: 'safe-storage',
      value: safeStorage.encryptString(secret).toString('base64')
    }
  } catch {
    // 某些系统会短暂报告可用但实际加密失败，仍应落到 electron-store 的加密层。
    return { scheme: 'store', value: secret }
  }
}

export function revealBillingSecret(secret?: BillingStoredSecret): string {
  if (!secret?.value) return ''
  if (secret.scheme === 'store') return secret.value
  if (secret.scheme !== 'safe-storage') throw new Error('API Key 存储格式损坏，请重新填写')
  if (!encryptionAvailable()) {
    throw new Error('系统安全存储当前不可用，无法读取已加密的 API Key')
  }
  try {
    return safeStorage.decryptString(Buffer.from(secret.value, 'base64'))
  } catch {
    throw new Error('API Key 解密失败，请在设置中重新填写')
  }
}

function validateEndpoint(raw: string): string {
  const text = raw.trim()
  if (!text) throw new Error('请配置 AI 服务完整 URL')
  let url: URL
  try {
    url = new URL(text)
  } catch {
    throw new Error('AI 服务 URL 不是有效的完整地址')
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('AI 服务 URL 仅支持 http:// 或 https://')
  }
  if (url.username || url.password) throw new Error('AI 服务 URL 不能包含用户名或密码')
  return url.toString()
}

export function createChineseName(): Pick<BillingResult, 'chineseName' | 'pinyinName'> {
  const surname = randomItem(SURNAMES)
  const givenName = randomItem(GIVEN_NAMES)
  const convert = (text: string): string =>
    pinyin(text, { toneType: 'none', type: 'array' }).join('').toUpperCase()
  return {
    chineseName: `${surname}${givenName}`,
    pinyinName: `${convert(surname)} ${convert(givenName)}`
  }
}

export class BillingService {
  constructor(private readonly repository: BillingConfigRepository) {}

  private load(): BillingStoredConfig {
    const config = plainConfig(this.repository.load())
    if (!encryptionAvailable()) return config

    // 系统安全存储后来恢复可用时，把此前的回退明文自动升级成 safeStorage 密文。
    let changed = false
    const upgraded = { ...config }
    for (const field of Object.values(SECRET_FIELD)) {
      const secret = upgraded[field]
      if (!secret || secret.scheme !== 'store') continue
      const protectedSecret = protectBillingSecret(secret.value)
      // 加密仍失败时保持原回退值，不反复写盘；以后读取会再次尝试升级。
      if (protectedSecret.scheme !== 'safe-storage') continue
      upgraded[field] = protectedSecret
      changed = true
    }
    if (changed) this.repository.save(upgraded)
    return upgraded
  }

  private publicConfig(config = this.load()): BillingPublicConfig {
    const configuredSecrets = [config.amapKey, config.baiduKey, config.aiKey].filter(Boolean)
    const systemStorageAvailable = encryptionAvailable()
    const secureStorage = systemStorageAvailable && configuredSecrets.every(
      (secret) => secret?.scheme === 'safe-storage'
    )
    const hasUnreadableSecret = !systemStorageAvailable && configuredSecrets.some(
      (secret) => secret?.scheme === 'safe-storage'
    )
    return {
      aiUrl: config.aiUrl,
      aiModel: config.aiModel,
      reasoningEffort: config.reasoningEffort,
      hasAmapKey: Boolean(config.amapKey?.value),
      hasBaiduKey: Boolean(config.baiduKey?.value),
      hasAiKey: Boolean(config.aiKey?.value),
      secureStorage,
      storageWarning: secureStorage
        ? undefined
        : hasUnreadableSecret
          ? '系统安全存储当前不可用，已保存的部分 API Key 暂时无法读取；请恢复系统安全存储或重新填写'
          : systemStorageAvailable
            ? '部分 API Key 未能写入系统安全存储，当前由应用现有加密存储保护'
            : '系统安全存储不可用，API Key 将回退由应用现有加密存储保护'
    }
  }

  getConfig(): BillingPublicConfig {
    return this.publicConfig()
  }

  saveConfig(patch: BillingConfigPatch): BillingPublicConfig {
    const config = this.load()
    const reasoningEffort = patch.reasoningEffort
    if (!['', 'low', 'medium', 'high'].includes(reasoningEffort)) {
      throw new Error('无效的思考等级')
    }
    const aiUrl = patch.aiUrl.trim()
    const aiModel = patch.aiModel.trim()
    if (aiUrl) validateEndpoint(aiUrl)
    const next = { ...config, aiUrl, aiModel, reasoningEffort }
    this.repository.save(next)
    return this.publicConfig(next)
  }

  replaceSecrets(patch: BillingSecretPatch): BillingPublicConfig {
    const config = this.load()
    const next = { ...config }
    for (const [name, value] of Object.entries(patch) as [BillingSecretName, string][]) {
      if (!isBillingSecretName(name)) throw new Error('无效的密钥类型')
      next[SECRET_FIELD[name]] = protectBillingSecret(value)
    }
    this.repository.save(next)
    return this.publicConfig(next)
  }

  clearSecrets(names: BillingSecretName[]): BillingPublicConfig {
    const config = this.load()
    const next = { ...config }
    for (const name of new Set(names)) {
      if (!isBillingSecretName(name)) throw new Error('无效的密钥类型')
      delete next[SECRET_FIELD[name]]
    }
    this.repository.save(next)
    return this.publicConfig(next)
  }

  clearConfig(): BillingPublicConfig {
    const next = { ...DEFAULT_BILLING_CONFIG }
    this.repository.save(next)
    return this.publicConfig(next)
  }

  async generateCheckout(): Promise<CheckoutBillingResult> {
    const place = createLocalBillingAddress()
    const name = createChineseName()
    return {
      ...name,
      countryCode: 'CN',
      province: place.province,
      city: place.city,
      district: place.district,
      pinyinCity: place.pinyinCity,
      pinyinDistrict: place.pinyinDistrict,
      addressLine1: place.addressLine1,
      postalCode: place.postalCode,
      mapSource: '本地生成',
      generatedAt: Date.now()
    }
  }

  async generate(): Promise<BillingResult> {
    const place = createLocalBillingAddress()
    const name = createChineseName()
    return {
      ...name,
      address: place.pinyinCity + ' ' + place.pinyinDistrict + ' ' + place.addressLine1,
      postalCode: place.postalCode,
      mapSource: '本地生成',
      generatedAt: Date.now()
    }
  }
}
