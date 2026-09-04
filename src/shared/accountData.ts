import type {
  Account,
  AccountImportItem,
  AccountStoreData,
  AccountTag
} from './types'

export const ACCOUNT_STORE_VERSION = 2
export const DEFAULT_ACCOUNT_TAG_COLOR = '#7c3aed'

type UnknownRecord = Record<string, unknown>

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function normalizeTagName(value: string): string {
  return value.trim()
}

/** 统一成 #rrggbb；同时兼容颜色选择器可能给出的 #rgb。 */
export function normalizeTagColor(value: string): string | null {
  const color = value.trim().toLowerCase()
  if (/^#[0-9a-f]{6}$/.test(color)) return color
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(color)
  return short ? `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}` : null
}

export function tagNameKey(name: string): string {
  return normalizeTagName(name).toLocaleLowerCase()
}

function normalizeStoredTag(value: unknown): AccountTag | null {
  if (!isRecord(value)) return null
  const id = typeof value.id === 'string' ? value.id.trim() : ''
  const name = typeof value.name === 'string' ? normalizeTagName(value.name) : ''
  const color = typeof value.color === 'string' ? normalizeTagColor(value.color) : null
  return id && name && color ? { id, name, color } : null
}

function stringIds(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return [...new Set(value.filter((id): id is string => typeof id === 'string' && !!id.trim()).map((id) => id.trim()))]
}

/**
 * 把任意历史账号快照升级到 v2。函数不修改传入对象，便于主进程安全地判断并落盘。
 */
export function migrateAccountStoreData(value: unknown): {
  data: AccountStoreData
  changed: boolean
} {
  if (!isRecord(value) || !Array.isArray(value.accounts)) {
    return {
      data: { version: ACCOUNT_STORE_VERSION, accounts: [], tags: [], activeAccountId: null },
      changed: true
    }
  }

  let changed = value.version !== ACCOUNT_STORE_VERSION || !Array.isArray(value.tags)
  const accounts: Account[] = []
  for (const raw of value.accounts) {
    if (!isRecord(raw)) {
      changed = true
      continue
    }
    const tagIds = stringIds(raw.tagIds)
    const paymentLink = typeof raw.paymentLink === 'string' ? raw.paymentLink : ''
    const originalTagIds = Array.isArray(raw.tagIds) ? raw.tagIds : []
    const accountChanged =
      !Array.isArray(raw.tagIds) ||
      originalTagIds.length !== tagIds.length ||
      originalTagIds.some((id, index) => id !== tagIds[index]) ||
      typeof raw.paymentLink !== 'string'
    changed ||= accountChanged
    accounts.push((accountChanged ? { ...raw, tagIds, paymentLink } : raw) as unknown as Account)
  }

  const tags: AccountTag[] = []
  const seenIds = new Set<string>()
  const seenNames = new Set<string>()
  for (const raw of Array.isArray(value.tags) ? value.tags : []) {
    const tag = normalizeStoredTag(raw)
    if (!tag || seenIds.has(tag.id) || seenNames.has(tagNameKey(tag.name))) {
      changed = true
      continue
    }
    const source = raw as UnknownRecord
    if (source.id !== tag.id || source.name !== tag.name || source.color !== tag.color) changed = true
    seenIds.add(tag.id)
    seenNames.add(tagNameKey(tag.name))
    tags.push(tag)
  }

  // 标签目录是唯一事实来源；迁移时清掉已不存在的引用，避免筛选和导出携带悬空 id。
  const validTagIds = new Set(tags.map((tag) => tag.id))
  for (let index = 0; index < accounts.length; index++) {
    const account = accounts[index]
    const tagIds = account.tagIds.filter((id) => validTagIds.has(id))
    if (tagIds.length === account.tagIds.length) continue
    accounts[index] = { ...account, tagIds }
    changed = true
  }

  const activeAccountId =
    typeof value.activeAccountId === 'string' || value.activeAccountId === null
      ? value.activeAccountId
      : null
  if (value.activeAccountId !== activeAccountId) changed = true

  return {
    data: {
      ...(value as Partial<AccountStoreData>),
      version: ACCOUNT_STORE_VERSION,
      accounts,
      tags,
      activeAccountId
    },
    changed
  }
}

export interface AccountTagDateFilter {
  /** 非空时匹配任一标签。 */
  tagIds?: string[]
  createdAtFrom?: number
  createdAtToExclusive?: number
}

/** 日期边界使用调用方传入的毫秒时间戳；上界为排他边界。 */
export function matchesAccountTagDateFilter(
  account: Pick<Account, 'tagIds' | 'createdAt'>,
  filter: AccountTagDateFilter
): boolean {
  const selectedTagIds = filter.tagIds ?? []
  if (selectedTagIds.length) {
    const accountTags = new Set(account.tagIds ?? [])
    if (!selectedTagIds.some((id) => accountTags.has(id))) return false
  }
  if (filter.createdAtFrom != null && account.createdAt < filter.createdAtFrom) return false
  if (filter.createdAtToExclusive != null && account.createdAt >= filter.createdAtToExclusive) {
    return false
  }
  return true
}

export interface MergeAccountTagsResult {
  tags: AccountTag[]
  /** 导入文件中的标签 id -> 当前标签目录 id。 */
  idMap: Map<string, string>
  added: number
  reused: number
  colorConflicts: number
}

/**
 * 合并完整备份里的标签目录：名称（忽略大小写）唯一，本地已有标签优先保留颜色；
 * id 撞到不同标签时为导入标签生成新 id，并通过 idMap 重映射账号关联。
 */
export function mergeAccountTags(
  existing: AccountTag[],
  incoming: AccountTag[] | undefined,
  createId: () => string
): MergeAccountTagsResult {
  const tags = existing.map((tag) => ({ ...tag }))
  const byId = new Map(tags.map((tag) => [tag.id, tag]))
  const byName = new Map(tags.map((tag) => [tagNameKey(tag.name), tag]))
  const idMap = new Map<string, string>()
  let added = 0
  let reused = 0
  let colorConflicts = 0

  for (const raw of incoming ?? []) {
    const tag = normalizeStoredTag(raw)
    if (!tag) continue
    const sameName = byName.get(tagNameKey(tag.name))
    if (sameName) {
      idMap.set(tag.id, sameName.id)
      reused++
      if (sameName.color !== tag.color) colorConflicts++
      continue
    }

    let id = tag.id
    if (byId.has(id)) {
      do id = createId()
      while (byId.has(id))
    }
    const created = { ...tag, id }
    tags.push(created)
    byId.set(id, created)
    byName.set(tagNameKey(created.name), created)
    idMap.set(tag.id, id)
    added++
  }

  return { tags, idMap, added, reused, colorConflicts }
}

/** 只导出目标账号实际引用且仍存在于全局目录中的标签。 */
export function referencedAccountTags(accounts: Account[], tags: AccountTag[]): AccountTag[] {
  const referenced = new Set(accounts.flatMap((account) => account.tagIds ?? []))
  return tags.filter((tag) => referenced.has(tag.id)).map((tag) => ({ ...tag }))
}

/** 单账号 OIDC 精简项；有值的可选字段才会出现在 JSON 中。 */
export function buildOidcImportItem(account: Account): AccountImportItem {
  const item: AccountImportItem = {
    email: account.email,
    refreshToken: account.credentials.refreshToken || '',
    provider: account.idp || 'BuilderId'
  }
  if (account.password) item.password = account.password
  if (account.credentials.clientId) item.clientId = account.credentials.clientId
  if (account.credentials.clientSecret) item.clientSecret = account.credentials.clientSecret
  return item
}
