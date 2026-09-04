import type { IpcResult } from './types'

/** OpenAI-compatible Chat Completions 的推理强度；空字符串表示不发送该字段。 */
export type BillingReasoningEffort = '' | 'low' | 'medium' | 'high'

export type BillingSecretName = 'amap' | 'baidu' | 'ai'

/** 渲染进程可见的账单服务配置，不包含任何 API Key 明文。 */
export interface BillingPublicConfig {
  aiUrl: string
  aiModel: string
  reasoningEffort: BillingReasoningEffort
  hasAmapKey: boolean
  hasBaiduKey: boolean
  hasAiKey: boolean
  /** false 表示系统安全存储不可用，密钥仅受 electron-store 的现有加密保护。 */
  secureStorage: boolean
  storageWarning?: string
}

/** 保存非敏感配置；允许先保存不完整草稿，生成时再校验必填项。 */
export interface BillingConfigPatch {
  aiUrl: string
  aiModel: string
  reasoningEffort: BillingReasoningEffort
}

/** 非空值替换对应密钥；主进程会 trim，空字符串不会被接受。 */
export type BillingSecretPatch = Partial<Record<BillingSecretName, string>>

export interface BillingResult {
  chineseName: string
  pinyinName: string
  address: string
  postalCode: string
  mapSource: '高德地图' | '百度地图'
  generatedAt: number
}

/** safeStorage 密文或受 electron-store 既有 encryptionKey 保护的回退明文。 */
export interface BillingStoredSecret {
  scheme: 'safe-storage' | 'store'
  value: string
}

/** 仅允许在主进程存储与读取。 */
export interface BillingStoredConfig {
  version: 1
  aiUrl: string
  aiModel: string
  reasoningEffort: BillingReasoningEffort
  amapKey?: BillingStoredSecret
  baiduKey?: BillingStoredSecret
  aiKey?: BillingStoredSecret
}

export const DEFAULT_BILLING_CONFIG: BillingStoredConfig = {
  version: 1,
  aiUrl: '',
  aiModel: '',
  reasoningEffort: ''
}

function cleanAddressPart(value: unknown): string {
  if (Array.isArray(value)) return value.map(cleanAddressPart).filter(Boolean).join('')
  return typeof value === 'string' ? value.trim() : ''
}

function joinAddress(parts: unknown[]): string {
  const values = parts.map(cleanAddressPart).filter(Boolean)
  return values.reduce<string[]>((output, part) => {
    const previous = output[output.length - 1] ?? ''
    if (!previous || (!previous.endsWith(part) && !part.startsWith(previous))) output.push(part)
    else if (part.startsWith(previous)) output[output.length - 1] = part
    return output
  }, []).join('')
}

/** 将高德地点搜索响应收敛成可展示的完整地址，不透传上游原始对象。 */
export function normalizeAmapResponse(payload: unknown): string[] {
  if (!payload || typeof payload !== 'object') return []
  const data = payload as { status?: unknown; pois?: unknown }
  if (String(data.status) !== '1' || !Array.isArray(data.pois)) return []
  return data.pois
    .map((item) => {
      if (!item || typeof item !== 'object') return ''
      const poi = item as Record<string, unknown>
      // 地点名称本身不足以作为“详细地址”；上游 address 为空时交给备用地图继续查。
      if (!cleanAddressPart(poi.address)) return ''
      return joinAddress([poi.pname, poi.cityname, poi.adname, poi.address, poi.name])
    })
    .filter((address) => address.length >= 8)
}

/** 将百度地点搜索响应收敛成可展示的完整地址，不透传上游原始对象。 */
export function normalizeBaiduResponse(payload: unknown): string[] {
  if (!payload || typeof payload !== 'object') return []
  const data = payload as { status?: unknown; results?: unknown }
  if (Number(data.status) !== 0 || !Array.isArray(data.results)) return []
  return data.results
    .map((item) => {
      if (!item || typeof item !== 'object') return ''
      const poi = item as Record<string, unknown>
      if (!cleanAddressPart(poi.address)) return ''
      return joinAddress([poi.province, poi.city, poi.area, poi.address, poi.name])
    })
    .filter((address) => address.length >= 8)
}

/** 只接受一个 postalCode 字段和六位数字，拒绝 Markdown 代码块及附加说明。 */
export function parsePostalCode(content: unknown): string {
  if (typeof content !== 'string') throw new Error('AI 返回内容不是字符串')
  let parsed: unknown
  try {
    parsed = JSON.parse(content.trim())
  } catch {
    throw new Error('AI 未返回严格 JSON')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('AI 返回 JSON 结构不正确')
  }
  const record = parsed as Record<string, unknown>
  if (
    Object.keys(record).length !== 1 ||
    typeof record.postalCode !== 'string' ||
    !/^\d{6}$/.test(record.postalCode)
  ) {
    throw new Error('AI 返回的邮政编码不是六位数字')
  }
  return record.postalCode
}

export function buildPostalCodeRequest(
  address: string,
  model: string,
  reasoningEffort: BillingReasoningEffort
): Record<string, unknown> {
  const request: Record<string, unknown> = {
    model,
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'system',
        content: '你是中国邮政编码查询助手。只能返回严格 JSON，格式为 {"postalCode":"六位数字"}，不得返回其他字段或文字。'
      },
      {
        role: 'user',
        content: `请根据以下真实地点地址推断最匹配的六位邮政编码：${address}`
      }
    ]
  }
  if (reasoningEffort) request.reasoning_effort = reasoningEffort
  return request
}

/** preload 合并进现有 Api 的契约。 */
export interface BillingRendererApi {
  getBillingConfig: () => Promise<IpcResult<BillingPublicConfig>>
  saveBillingConfig: (patch: BillingConfigPatch) => Promise<IpcResult<BillingPublicConfig>>
  replaceBillingSecrets: (
    patch: BillingSecretPatch
  ) => Promise<IpcResult<BillingPublicConfig>>
  clearBillingSecrets: (
    names: BillingSecretName[]
  ) => Promise<IpcResult<BillingPublicConfig>>
  clearBillingConfig: () => Promise<IpcResult<BillingPublicConfig>>
  generateBillingInfo: () => Promise<IpcResult<BillingResult>>
}
