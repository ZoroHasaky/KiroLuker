// API Key 管理与网关编排层
import { randomUUID } from 'crypto'
import { getKeyData, setKeyData } from './store'
import { appendUsagePoint, clearUsageHistory } from './usageHistory'
import {
  fetchAccountInfo,
  fetchModels,
  gatewayRunning,
  getGatewayObservation,
  startGateway,
  stopGateway
} from './keyGateway'
import {
  applyEndpointOverride,
  endpointConflict,
  isEndpointBound,
  isKiroInstalled,
  restoreEndpointOverride,
  restoreEndpointOverrideSync,
  type EndpointSnapshot
} from './kiroSettings'
import { log } from './logger'
import type {
  AccountUsage,
  KeyEntry,
  KeyGatewayData,
  KeyGatewayStatus,
  KeyModelInfo,
  KeyTestResult
} from '../shared/types'

let notify: ((status: KeyGatewayStatus) => void) | null = null

function activeEntry(data = getKeyData()): KeyEntry | undefined {
  return data.keys.find((entry) => entry.id === data.activeKeyId)
}

function activeCredential(): { id: string; key: string } | null {
  const data = getKeyData()
  if (!data.enabled) return null
  const entry = activeEntry(data)
  return entry ? { id: entry.id, key: entry.key } : null
}

function region(): string {
  return getKeyData().region
}

function historySubjectId(id: string): string {
  return `key:${id}`
}

/**
 * API Key 用量历史由主进程在同步提交时写入，确保同步成功返回时弹窗即可读取。
 * appendUsagePoint 会跳过 current / limit 均未变化的连续快照。
 */
function recordKeyUsage(entry: KeyEntry): boolean {
  if (
    typeof entry.usedCredits !== 'number'
    || !Number.isFinite(entry.usedCredits)
    || typeof entry.totalCredits !== 'number'
    || !Number.isFinite(entry.totalCredits)
  ) return false
  const usage: AccountUsage = {
    current: entry.usedCredits,
    limit: entry.totalCredits,
    percentUsed: entry.totalCredits > 0 ? entry.usedCredits / entry.totalCredits : 0,
    lastUpdated: entry.lastCheckedAt ?? Date.now()
  }
  return appendUsagePoint(historySubjectId(entry.id), usage)
}

function originalSnapshot(data: KeyGatewayData): EndpointSnapshot {
  return data.originalEndpoints ?? { krs: [], cps: [] }
}

function validateKey(value: string): string {
  const key = String(value || '').trim()
  if (!key.startsWith('ksk_')) throw new Error('API Key 必须以 ksk_ 开头')
  if (key.length <= 4) throw new Error('API Key 格式不正确')
  return key
}

function validatePorts(krs: number, cps: number): void {
  for (const [name, value] of [['KRS', krs], ['CPS', cps]] as const) {
    if (!Number.isInteger(value) || value < 1024 || value > 65535) {
      throw new Error(`${name} 端口必须是 1024–65535 的整数`)
    }
  }
  if (krs === cps) throw new Error('KRS 与 CPS 端口不能相同')
}

export async function getGatewayStatus(message?: string, needRestart = false): Promise<KeyGatewayStatus> {
  const data = getKeyData()
  const running = gatewayRunning()
  const endpointsBound = data.enabled
    ? await isEndpointBound(data.ports.krs, data.ports.cps, data.region).catch(() => false)
    : false
  const observation = getGatewayObservation()
  const observedInCurrentSession = running && endpointsBound && !!observation.lastForwardedKeyId
  return {
    enabled: data.enabled,
    running,
    activeKeyId: data.enabled ? (data.activeKeyId ?? null) : null,
    lastForwardedKeyId: observedInCurrentSession ? observation.lastForwardedKeyId : null,
    lastForwardedAt: observedInCurrentSession ? observation.lastForwardedAt : undefined,
    observedInCurrentSession,
    region: data.region,
    ports: { ...data.ports },
    endpointsBound,
    needRestart,
    settingsPath: data.settingsPath,
    message
  }
}

async function emitStatus(message?: string, needRestart = false): Promise<KeyGatewayStatus> {
  const status = await getGatewayStatus(message, needRestart)
  notify?.(status)
  return status
}

function emitObservationStatus(): void {
  void emitStatus().catch((error) => {
    log('warn', `[KeyGateway] 推送实际使用 Key 状态失败：${error instanceof Error ? error.message : String(error)}`)
  })
}

export function loadKeys(): KeyGatewayData {
  const data = getKeyData()
  // 升级兼容：已有额度但尚无历史的旧 Key 会在首次加载时补一条基线。
  for (const entry of data.keys) recordKeyUsage(entry)
  return data
}

export function addKey(value: string, note = ''): KeyGatewayData {
  const key = validateKey(value)
  const data = getKeyData()
  if (data.keys.some((entry) => entry.key === key)) throw new Error('该 API Key 已存在')
  const entry: KeyEntry = {
    id: randomUUID(),
    key,
    note: note.trim() || undefined,
    createdAt: Date.now()
  }
  data.keys.push(entry)
  setKeyData(data)
  return data
}

export interface ImportKeysResult {
  data: KeyGatewayData
  added: number
  skipped: number
  invalid: number
}

export function importKeys(text: string): ImportKeysResult {
  const data = getKeyData()
  const existing = new Set(data.keys.map((entry) => entry.key))
  let added = 0
  let skipped = 0
  let invalid = 0
  for (const raw of String(text || '').split(/\r?\n/)) {
    const key = raw.trim()
    if (!key) continue
    if (!key.startsWith('ksk_') || key.length <= 4) {
      invalid++
      continue
    }
    if (existing.has(key)) {
      skipped++
      continue
    }
    existing.add(key)
    const entry: KeyEntry = { id: randomUUID(), key, createdAt: Date.now() }
    data.keys.push(entry)
    added++
  }
  setKeyData(data)
  return { data, added, skipped, invalid }
}

export function updateKey(id: string, note: string): KeyGatewayData {
  const data = getKeyData()
  const entry = data.keys.find((item) => item.id === id)
  if (!entry) throw new Error('未找到该 API Key')
  entry.note = note.trim() || undefined
  setKeyData(data)
  return data
}

export function deleteKey(id: string): KeyGatewayData {
  const data = getKeyData()
  if (data.enabled && data.activeKeyId === id) {
    throw new Error('该 Key 已被选为接管 Key，请先选择其它 Key 或关闭接管')
  }
  const before = data.keys.length
  data.keys = data.keys.filter((entry) => entry.id !== id)
  if (data.keys.length === before) throw new Error('未找到该 API Key')
  if (data.activeKeyId === id) data.activeKeyId = null
  setKeyData(data)
  clearUsageHistory(historySubjectId(id))
  return data
}

/** 网关开启时切换当前 Key；关闭状态不允许保留当前 Key。 */
export async function selectKey(id: string): Promise<{ data: KeyGatewayData; status: KeyGatewayStatus }> {
  const data = getKeyData()
  if (!data.enabled) throw new Error('API Key 网关未开启，请开启网关后再切换')
  if (!data.keys.some((entry) => entry.id === id)) throw new Error('未找到该 API Key')
  data.activeKeyId = id
  setKeyData(data)
  log('info', `[KeyGateway] 接管 Key 已选择为 ${id}`)
  return {
    data,
    status: await emitStatus('接管 Key 已更新，下一次网关请求使用新 Key')
  }
}

export async function listKeyModels(id: string): Promise<KeyModelInfo[]> {
  const data = getKeyData()
  const entry = data.keys.find((item) => item.id === id)
  if (!entry) throw new Error('未找到该 API Key')
  const result = await fetchModels(data.region, entry.key)
  return result.models
}

export async function testKey(id: string): Promise<KeyTestResult> {
  const data = getKeyData()
  const entry = data.keys.find((item) => item.id === id)
  if (!entry) throw new Error('未找到该 API Key')
  const [models, account] = await Promise.all([
    fetchModels(data.region, entry.key),
    fetchAccountInfo(data.region, entry.key)
  ])
  return {
    modelCount: models.models.length,
    defaultModel: models.defaultModel,
    subscription: account.subscriptionTitle,
    tier: account.tier,
    used: account.used,
    total: account.total,
    models: models.models
  }
}

export async function syncKey(id: string): Promise<KeyGatewayData> {
  // 网络请求使用不可变快照；提交时重新读取最新数据，避免并发同步整表互相覆盖。
  const snapshot = getKeyData()
  const source = snapshot.keys.find((item) => item.id === id)
  if (!source) throw new Error('未找到该 API Key')

  let info: Awaited<ReturnType<typeof fetchAccountInfo>>
  try {
    info = await fetchAccountInfo(snapshot.region, source.key)
  } catch (error) {
    const latest = getKeyData()
    const current = latest.keys.find((item) => item.id === id)
    if (current && current.key === source.key) {
      current.lastError = error instanceof Error ? error.message : String(error)
      setKeyData(latest)
    }
    throw error
  }

  const latest = getKeyData()
  const current = latest.keys.find((item) => item.id === id)
  if (!current || current.key !== source.key) throw new Error('API Key 已被删除或替换')
  current.subscription = info.subscriptionTitle
  current.tier = info.tier
  current.usedCredits = info.used ?? undefined
  current.totalCredits = info.total ?? undefined
  current.lastCheckedAt = Date.now()
  current.lastError = undefined
  setKeyData(latest)
  // 与额度提交处于同一主进程调用链；首条自动成为 delta=0 的添加基线。
  recordKeyUsage(current)
  return latest
}

export async function syncAllKeys(
  concurrency = 5
): Promise<{ data: KeyGatewayData; success: number; failed: number }> {
  const ids = getKeyData().keys.map((entry) => entry.id)
  const batchSize = Math.max(1, Math.min(Math.round(Number(concurrency) || 5), 20))
  let success = 0
  let failed = 0
  for (let i = 0; i < ids.length; i += batchSize) {
    const settled = await Promise.allSettled(ids.slice(i, i + batchSize).map((id) => syncKey(id)))
    for (const result of settled) result.status === 'fulfilled' ? success++ : failed++
  }
  return { data: getKeyData(), success, failed }
}

export async function enableGateway(keyId?: string): Promise<KeyGatewayStatus> {
  const data = getKeyData()
  validatePorts(data.ports.krs, data.ports.cps)
  if (!data.keys.length) throw new Error('请先添加 API Key，再开启网关')
  const selectedId = keyId ?? data.activeKeyId
  const selected = data.keys.find((entry) => entry.id === selectedId)
  if (!selected) throw new Error('请先选择一个 API Key，再开启网关')
  if (!isKiroInstalled()) throw new Error('未找到 Kiro IDE 用户数据目录，请先安装并启动一次 Kiro IDE')

  const conflict = await endpointConflict(data.ports.krs, data.ports.cps, data.region)
  if (conflict) throw new Error(conflict)

  const pendingCredential = { id: selected.id, key: selected.key }
  let applied: Awaited<ReturnType<typeof applyEndpointOverride>> | null = null
  try {
    // 启用提交前持久态仍为“关闭且无当前 Key”，局部凭证只服务于启动窗口。
    await startGateway(
      data.ports.krs,
      data.ports.cps,
      () => activeCredential() ?? pendingCredential,
      region,
      emitObservationStatus
    )
    applied = await applyEndpointOverride(data.ports.krs, data.ports.cps, data.region)

    // 异步启动期间 Key 可能被删除，提交前重新读取并复验。
    const latest = getKeyData()
    const latestSelected = latest.keys.find((entry) => entry.id === selected.id)
    if (!latestSelected || latestSelected.key !== selected.key) {
      throw new Error('所选 API Key 已被删除或替换，请重新选择')
    }
    latest.activeKeyId = selected.id
    latest.enabled = true
    if (!latest.originalEndpoints) latest.originalEndpoints = applied.original
    latest.settingsPath = applied.settingsPath
    setKeyData(latest)
    log('info', `[KeyGateway] 已开启接管，settings=${applied.settingsPath}`)
    return await emitStatus('API Key 接管已开启，请重启 Kiro IDE 使端点生效', applied.changed)
  } catch (error) {
    stopGateway()
    if (applied) {
      await restoreEndpointOverride(applied.original, applied.settingsPath).catch(() => undefined)
    } else if (data.enabled) {
      await restoreEndpointOverride(originalSnapshot(data), data.settingsPath).catch(() => undefined)
    }
    const failed = getKeyData()
    failed.enabled = false
    failed.activeKeyId = null
    failed.originalEndpoints = undefined
    failed.settingsPath = undefined
    setKeyData(failed)
    throw error
  }
}

export async function disableGateway(): Promise<KeyGatewayStatus> {
  const snapshot = getKeyData()
  const result = await restoreEndpointOverride(originalSnapshot(snapshot), snapshot.settingsPath)
  stopGateway()
  // 恢复端点期间其它 Key 数据可能更新，提交时只修改网关相关字段。
  const latest = getKeyData()
  latest.enabled = false
  latest.activeKeyId = null
  latest.originalEndpoints = undefined
  latest.settingsPath = undefined
  setKeyData(latest)
  log('info', '[KeyGateway] 已关闭接管、清除当前 Key 并恢复 Kiro 官方端点')
  return await emitStatus('API Key 接管已关闭，当前 Key 已清除；请重启 Kiro IDE 恢复官方服务', result.changed)
}

export async function configureGateway(input: {
  region?: string
  ports?: { krs: number; cps: number }
}): Promise<{ data: KeyGatewayData; status: KeyGatewayStatus }> {
  const data = getKeyData()
  const nextRegion = String(input.region ?? data.region).trim()
  if (!nextRegion) throw new Error('Region 不能为空')
  if (
    nextRegion.length > 63
    || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(nextRegion)
  ) {
    throw new Error('Region 格式无效，仅支持小写字母、数字和连字符')
  }
  const nextPorts = input.ports ?? data.ports
  validatePorts(Number(nextPorts.krs), Number(nextPorts.cps))
  if (data.enabled) throw new Error('请先关闭接管，再修改 Region 或端口')
  data.region = nextRegion
  data.ports = { krs: Number(nextPorts.krs), cps: Number(nextPorts.cps) }
  setKeyData(data)
  return { data, status: await emitStatus('网关配置已保存') }
}

/** 应用启动时恢复上次的接管状态；启动失败则安全还原并关闭开关。 */
export async function initializeKeyService(
  onStatus?: (status: KeyGatewayStatus) => void
): Promise<void> {
  notify = onStatus ?? null
  const data = getKeyData()
  if (!data.enabled) {
    await emitStatus()
    return
  }
  try {
    await enableGateway()
  } catch (error) {
    stopGateway()
    await restoreEndpointOverride(originalSnapshot(data), data.settingsPath).catch(() => undefined)
    data.enabled = false
    data.originalEndpoints = undefined
    data.settingsPath = undefined
    setKeyData(data)
    const message = error instanceof Error ? error.message : String(error)
    log('error', `[KeyGateway] 启动恢复失败：${message}`)
    await emitStatus(`上次的 API Key 接管恢复失败：${message}`)
  }
}

/** 退出前同步还原端点，避免 IDE 永久指向已经停止的本地端口。 */
export function shutdownKeyServiceSync(): void {
  const data = getKeyData()
  if (data.enabled) {
    restoreEndpointOverrideSync(originalSnapshot(data), data.settingsPath)
  }
  stopGateway()
}
