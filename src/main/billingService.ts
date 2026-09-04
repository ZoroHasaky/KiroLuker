import { safeStorage } from 'electron'
import { pinyin } from 'pinyin-pro'
import {
  buildPostalCodeRequest,
  DEFAULT_BILLING_CONFIG,
  normalizeAmapResponse,
  normalizeBaiduResponse,
  parsePostalCode,
  type BillingConfigPatch,
  type BillingPublicConfig,
  type BillingReasoningEffort,
  type BillingResult,
  type BillingSecretName,
  type BillingSecretPatch,
  type BillingStoredConfig,
  type BillingStoredSecret
} from '../shared/billing'
import { httpRequest } from './net'

export interface BillingConfigRepository {
  load: () => BillingStoredConfig | undefined
  save: (config: BillingStoredConfig) => void
}

interface MapAddress {
  address: string
  source: BillingResult['mapSource']
}

interface RuntimeConfig {
  aiUrl: string
  aiModel: string
  reasoningEffort: BillingReasoningEffort
  amapKey: string
  baiduKey: string
  aiKey: string
}

/** 全国各区域的常用城市；随机取样，避免生成结果长期集中于少数一线城市。 */
export const BILLING_CITIES = [
  '北京', '上海', '天津', '重庆',
  '石家庄', '太原', '呼和浩特', '沈阳', '大连', '长春', '哈尔滨',
  '南京', '苏州', '杭州', '宁波', '合肥', '福州', '厦门', '南昌', '济南', '青岛',
  '郑州', '武汉', '长沙', '广州', '深圳', '珠海', '南宁', '海口',
  '成都', '贵阳', '昆明', '拉萨', '西安', '兰州', '西宁', '银川', '乌鲁木齐'
] as const

/** 地图公开地点检索词，仅用于获取真实存在的公共地址。 */
export const BILLING_POI_KEYWORDS = [
  '大学', '图书馆', '博物馆', '公园', '医院', '体育中心', '文化中心', '政务服务中心', '商场'
] as const

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

async function queryAmap(key: string, city: string, keyword: string): Promise<string> {
  const url = new URL('https://restapi.amap.com/v3/place/text')
  url.searchParams.set('key', key)
  url.searchParams.set('keywords', keyword)
  url.searchParams.set('city', city)
  url.searchParams.set('citylimit', 'true')
  url.searchParams.set('extensions', 'base')
  url.searchParams.set('offset', '20')
  url.searchParams.set('page', '1')
  let response
  try {
    response = await httpRequest(url.toString(), { timeoutMs: 15_000 })
  } catch {
    throw new Error('连接失败')
  }
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  let payload: unknown
  try {
    payload = await response.json<unknown>()
  } catch {
    throw new Error('响应不是有效 JSON')
  }
  const addresses = normalizeAmapResponse(payload)
  if (!addresses.length) throw new Error('没有返回可用地点')
  return randomItem(addresses)
}

async function queryBaidu(key: string, city: string, keyword: string): Promise<string> {
  const url = new URL('https://api.map.baidu.com/place/v2/search')
  url.searchParams.set('ak', key)
  url.searchParams.set('query', keyword)
  url.searchParams.set('region', city)
  url.searchParams.set('city_limit', 'true')
  url.searchParams.set('output', 'json')
  url.searchParams.set('scope', '1')
  url.searchParams.set('page_size', '20')
  url.searchParams.set('page_num', '0')
  let response
  try {
    response = await httpRequest(url.toString(), { timeoutMs: 15_000 })
  } catch {
    throw new Error('连接失败')
  }
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  let payload: unknown
  try {
    payload = await response.json<unknown>()
  } catch {
    throw new Error('响应不是有效 JSON')
  }
  const addresses = normalizeBaiduResponse(payload)
  if (!addresses.length) throw new Error('没有返回可用地点')
  return randomItem(addresses)
}

async function resolveMapAddress(config: RuntimeConfig): Promise<MapAddress> {
  if (!config.amapKey && !config.baiduKey) throw new Error('请先配置高德地图或百度地图 API Key')
  const city = randomItem(BILLING_CITIES)
  const keyword = randomItem(BILLING_POI_KEYWORDS)
  const failures: string[] = []

  if (config.amapKey) {
    try {
      return { address: await queryAmap(config.amapKey, city, keyword), source: '高德地图' }
    } catch (error) {
      failures.push(`高德地图：${error instanceof Error ? error.message : '请求失败'}`)
    }
  }
  if (config.baiduKey) {
    try {
      return { address: await queryBaidu(config.baiduKey, city, keyword), source: '百度地图' }
    } catch (error) {
      failures.push(`百度地图：${error instanceof Error ? error.message : '请求失败'}`)
    }
  }
  throw new Error(`地址获取失败（${failures.join('；')}）`)
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

async function inferPostalCode(config: RuntimeConfig, address: string): Promise<string> {
  if (!config.aiKey) throw new Error('请配置 AI 服务 API Key')
  if (!config.aiModel) throw new Error('请配置 AI 模型名称')
  const endpoint = validateEndpoint(config.aiUrl)
  let response
  try {
    response = await httpRequest(endpoint, {
      method: 'POST',
      timeoutMs: 30_000,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${config.aiKey}`
      },
      body: JSON.stringify(buildPostalCodeRequest(address, config.aiModel, config.reasoningEffort))
    })
  } catch {
    throw new Error('AI 服务连接失败')
  }
  if (!response.ok) throw new Error(`AI 服务请求失败（HTTP ${response.status}）`)
  let payload: unknown
  try {
    payload = await response.json<unknown>()
  } catch {
    throw new Error('AI 服务响应不是有效 JSON')
  }
  if (!payload || typeof payload !== 'object') throw new Error('AI 服务返回结构不正确')
  const choices = (payload as { choices?: unknown }).choices
  if (!Array.isArray(choices) || !choices[0] || typeof choices[0] !== 'object') {
    throw new Error('AI 服务没有返回候选结果')
  }
  const message = (choices[0] as { message?: unknown }).message
  if (!message || typeof message !== 'object') throw new Error('AI 服务没有返回消息内容')
  return parsePostalCode((message as { content?: unknown }).content)
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

  async generate(): Promise<BillingResult> {
    const stored = this.load()
    const runtime: RuntimeConfig = {
      aiUrl: stored.aiUrl,
      aiModel: stored.aiModel,
      reasoningEffort: stored.reasoningEffort,
      amapKey: revealBillingSecret(stored.amapKey),
      baiduKey: revealBillingSecret(stored.baiduKey),
      aiKey: revealBillingSecret(stored.aiKey)
    }
    const place = await resolveMapAddress(runtime)
    const name = createChineseName()
    const postalCode = await inferPostalCode(runtime, place.address)
    return {
      ...name,
      address: place.address,
      postalCode,
      mapSource: place.source,
      generatedAt: Date.now()
    }
  }
}
