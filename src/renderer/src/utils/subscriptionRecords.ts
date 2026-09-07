import type { SubscriptionRenewalInfo } from '@shared/subscriptionFree'

export type SubscriptionOperation = 'check' | 'switch'
export type SubscriptionRowStatus = 'pending' | 'running' | 'success' | 'warning' | 'error'
export interface SubscriptionRecord {
  status: SubscriptionRowStatus
  operation?: SubscriptionOperation
  message: string
  renewal?: SubscriptionRenewalInfo
  previousPlan?: string
  warning?: string
  needsCheck?: boolean
  settled?: boolean
  attemptedAt?: number
  completedAt?: number
  lastCheckAt?: number
}
export type SubscriptionRecords = Record<string, SubscriptionRecord>
export const SUBSCRIPTION_RECORDS_KEY = 'kiroluker-subscription-records-v1'
type RecordStorage = Pick<Storage, 'getItem' | 'setItem'>

/** Failed/interrupted reads and cancellation alone must not masquerade as confirmed Free. */
export function needsSubscriptionCheck(record?: SubscriptionRecord): boolean {
  return !record || record.status !== 'success' || !!record.needsCheck ||
    !record.renewal || !['free', 'scheduled-free'].includes(record.renewal.state)
}

/** Require a successful read before offering a real write, including after lost/corrupt storage. */
export function canSwitchSubscription(record?: SubscriptionRecord): boolean {
  return !!record && record.status === 'success' && !record.needsCheck && !record.settled &&
    record.renewal?.state === 'paid'
}

function text(value: unknown, limit = 2000): string | undefined {
  if (typeof value !== 'string') return undefined
  return value.replace(/https?:\/\/[^\s<>"']+/gi, '[链接已隐藏]')
    .replace(/\bBearer\s+\S+/gi, 'Bearer [已隐藏]')
    .replace(/\b(access[_-]?token|refresh[_-]?token|csrf[_-]?token|session[_-]?api[_-]?key|secret|cookie)\b\s*[:=]\s*[^\s,;]+/gi, '$1=[已隐藏]')
    .slice(0, limit)
}
function time(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined
}
function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}
function normalizeRecord(value: unknown): SubscriptionRecord {
  if (!object(value) || typeof value.status !== 'string' ||
    !['pending', 'running', 'success', 'warning', 'error'].includes(value.status) ||
    ['needsCheck', 'settled'].some((key) => value[key] !== undefined && typeof value[key] !== 'boolean')) {
    throw new Error('订阅记录格式无效，请重新只读检查')
  }
  const record: SubscriptionRecord = {
    status: value.status as SubscriptionRowStatus,
    operation: value.operation === 'check' || value.operation === 'switch' ? value.operation : undefined,
    message: text(value.message) || '未提供结果说明',
    previousPlan: text(value.previousPlan, 160),
    warning: text(value.warning),
    needsCheck: value.needsCheck === true,
    settled: value.settled === true,
    attemptedAt: time(value.attemptedAt),
    completedAt: time(value.completedAt),
    lastCheckAt: time(value.lastCheckAt)
  }
  const renewal = value.renewal
  if (object(renewal) && typeof renewal.state === 'string' &&
    ['paid', 'free', 'scheduled-free', 'canceling'].includes(renewal.state) && time(renewal.checkedAt)) {
    record.renewal = {
      state: renewal.state as SubscriptionRenewalInfo['state'],
      planName: text(renewal.planName, 160) || '',
      // Persist only status/timing: no account labels, credentials, portal URLs or Stripe identifiers.
      subscriptionId: '',
      checkedAt: time(renewal.checkedAt)!,
      currentPeriodEnd: time(renewal.currentPeriodEnd),
      transitionAt: time(renewal.transitionAt)
    }
  }
  return record
}

export function loadSubscriptionRecords(storage: RecordStorage): SubscriptionRecords {
  const raw = storage.getItem(SUBSCRIPTION_RECORDS_KEY)
  const records: SubscriptionRecords = Object.create(null)
  if (!raw) return records
  const data: unknown = JSON.parse(raw)
  if (!object(data) || data.version !== 1 || !object(data.records)) {
    throw new Error('订阅记录版本或格式无效，请重新只读检查')
  }
  for (const [id, value] of Object.entries(data.records)) {
    if (['__proto__', 'constructor', 'prototype'].includes(id)) continue
    const record = normalizeRecord(value)
    if (record.status === 'pending' || record.status === 'running') {
      record.needsCheck ||= record.status === 'running' && record.operation === 'switch'
      record.status = 'warning'
      record.message = record.needsCheck
        ? '上次切换未获确认，请先只读复查，禁止重复提交'
        : '上次操作中断，请重新只读检查'
    }
    records[id] = record
  }
  return records
}

export function saveSubscriptionRecords(storage: RecordStorage, records: SubscriptionRecords): void {
  const clean: SubscriptionRecords = Object.create(null)
  for (const [id, record] of Object.entries(records)) {
    if (!['__proto__', 'constructor', 'prototype'].includes(id)) clean[id] = normalizeRecord(record)
  }
  storage.setItem(SUBSCRIPTION_RECORDS_KEY, JSON.stringify({ version: 1, records: clean }))
}
