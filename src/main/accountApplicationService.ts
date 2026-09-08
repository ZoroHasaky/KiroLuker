import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import type {
  Account,
  AccountSnapshot,
  AccountStoreData,
  AccountTag,
  AccountUsage,
  BatchResult,
  RefreshTokenResult,
  VerifyCredentialsInput
} from '../shared/types'
import { ACCOUNT_STORE_VERSION } from '../shared/accountData'

export interface PublicAccount {
  id: string
  email: string
  nickname?: string
  note?: string
  idp: Account['idp']
  userId?: string
  profileArn?: string
  subscription: Account['subscription']
  usage: Account['usage']
  status: Account['status']
  isActive: boolean
  tagIds: string[]
  createdAt: number
  lastUsedAt: number
  lastCheckedAt?: number
  tokenExpiresAt: number
}

export interface AccountChange {
  data: AccountStoreData
  removedIds: string[]
}

interface AccountRepository {
  load(): AccountStoreData
  save(data: AccountStoreData): Promise<void>
}

interface AccountDependencies {
  verify(input: VerifyCredentialsInput): Promise<AccountSnapshot>
  refresh(account: Account): Promise<RefreshTokenResult>
  check(account: Account): Promise<AccountSnapshot>
}

function clone<T>(value: T): T {
  return structuredClone(value)
}

function publicAccount(account: Account): PublicAccount {
  return {
    id: account.id,
    email: account.email,
    nickname: account.nickname,
    note: account.note,
    idp: account.idp,
    userId: account.userId,
    profileArn: account.profileArn,
    subscription: clone(account.subscription),
    usage: clone(account.usage),
    status: account.status,
    isActive: account.isActive,
    tagIds: [...account.tagIds],
    createdAt: account.createdAt,
    lastUsedAt: account.lastUsedAt,
    lastCheckedAt: account.lastCheckedAt,
    tokenExpiresAt: account.credentials.expiresAt
  }
}

function changedPatch(before: Record<string, unknown>, after: Record<string, unknown>): Record<string, unknown> {
  const output: Record<string, unknown> = {}
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (!isDeepStrictEqual(before[key], after[key])) output[key] = clone(after[key])
  }
  return output
}

function mergePatch<T extends Record<string, unknown>>(target: T, patch: Record<string, unknown>): T {
  const next = { ...target } as Record<string, unknown>
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) delete next[key]
    else next[key] = clone(value)
  }
  return next as T
}

/**
 * 唯一的账户写入入口。所有磁盘修改均串行化；长网络操作在锁外运行，回写前会校验
 * 账号及 refreshToken 仍未变更，避免删除后复活或旧 refreshToken 覆盖新凭证。
 */
export class AccountApplicationService {
  private writeTail: Promise<void> = Promise.resolve()
  private readonly listeners = new Set<(change: AccountChange) => void>()

  private readonly repository: AccountRepository
  private readonly dependencies: AccountDependencies

  constructor(repository: AccountRepository, dependencies: AccountDependencies) {
    this.repository = repository
    this.dependencies = dependencies
  }

  onChanged(listener: (change: AccountChange) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getData(): AccountStoreData {
    return clone(this.repository.load())
  }

  getPublicAccount(id: string): PublicAccount | null {
    const account = this.repository.load().accounts.find((item) => item.id === id)
    return account ? publicAccount(account) : null
  }

  listPublicAccounts(): PublicAccount[] {
    return this.repository.load().accounts.map(publicAccount)
  }

  private async write<T>(mutator: (data: AccountStoreData) => { data: AccountStoreData; result: T; removedIds?: string[] }): Promise<T> {
    const task = this.writeTail.then(async () => {
      const current = clone(this.repository.load())
      const before = clone(current)
      const outcome = mutator(current)
      const next: AccountStoreData = { ...outcome.data, version: ACCOUNT_STORE_VERSION }
      if (!isDeepStrictEqual(before, next)) await this.repository.save(next)
      const removedIds = outcome.removedIds ?? []
      if (!isDeepStrictEqual(before, next)) {
        const change = { data: clone(next), removedIds }
        for (const listener of this.listeners) listener(change)
      }
      return outcome.result
    })
    this.writeTail = task.then(() => undefined, () => undefined)
    return task
  }

  async patchAccount(id: string, patch: Pick<Partial<Account>, 'nickname' | 'note' | 'tagIds'>): Promise<PublicAccount> {
    return this.write((data) => {
      const index = data.accounts.findIndex((account) => account.id === id)
      if (index < 0) throw new Error('账号不存在')
      const account = data.accounts[index]
      const next = {
        ...account,
        ...(typeof patch.nickname === 'string' ? { nickname: patch.nickname.trim() || undefined } : {}),
        ...(typeof patch.note === 'string' ? { note: patch.note.trim() || undefined } : {}),
        ...(Array.isArray(patch.tagIds) ? { tagIds: [...new Set(patch.tagIds)] } : {})
      }
      data.accounts[index] = next
      return { data, result: publicAccount(next) }
    })
  }

  async deleteAccounts(ids: string[]): Promise<{ removed: number; data: AccountStoreData }> {
    const wanted = new Set(ids.filter(Boolean))
    return this.write((data) => {
      const removedIds = data.accounts.filter((account) => wanted.has(account.id)).map((account) => account.id)
      if (removedIds.length) {
        data.accounts = data.accounts.filter((account) => !wanted.has(account.id))
        if (data.activeAccountId && wanted.has(data.activeAccountId)) data.activeAccountId = null
      }
      return { data, result: { removed: removedIds.length, data: clone(data) }, removedIds }
    })
  }

  async createTag(input: Pick<AccountTag, 'name' | 'color'>): Promise<AccountTag> {
    const name = input.name.trim()
    if (!name) throw new Error('标签名称不能为空')
    return this.write((data) => {
      if (data.tags.some((tag) => tag.name === name)) throw new Error('标签名称已存在')
      const tag: AccountTag = { id: randomUUID(), name, color: input.color || '#7c3aed' }
      data.tags.push(tag)
      return { data, result: clone(tag) }
    })
  }

  async patchTag(id: string, patch: Pick<Partial<AccountTag>, 'name' | 'color'>): Promise<AccountTag> {
    return this.write((data) => {
      const index = data.tags.findIndex((tag) => tag.id === id)
      if (index < 0) throw new Error('标签不存在')
      const name = typeof patch.name === 'string' ? patch.name.trim() : undefined
      if (name !== undefined && !name) throw new Error('标签名称不能为空')
      if (name && data.tags.some((tag) => tag.id !== id && tag.name === name)) throw new Error('标签名称已存在')
      const next = { ...data.tags[index], ...(name ? { name } : {}), ...(patch.color ? { color: patch.color } : {}) }
      data.tags[index] = next
      return { data, result: clone(next) }
    })
  }

  async deleteTag(id: string): Promise<void> {
    await this.write((data) => {
      if (!data.tags.some((tag) => tag.id === id)) throw new Error('标签不存在')
      data.tags = data.tags.filter((tag) => tag.id !== id)
      data.accounts = data.accounts.map((account) => ({ ...account, tagIds: account.tagIds.filter((tagId) => tagId !== id) }))
      return { data, result: undefined }
    })
  }

  async importCredentials(items: Array<VerifyCredentialsInput & { nickname?: string; paymentLink?: string }>): Promise<BatchResult> {
    const result: BatchResult = { success: 0, failed: 0, skipped: 0, messages: [] }
    for (const item of items) {
      try {
        const snapshot = await this.dependencies.verify(item)
        const outcome = await this.write((data) => {
          const existing = data.accounts.some((account) =>
            Boolean(snapshot.userId && account.userId === snapshot.userId) ||
            Boolean(snapshot.email && account.email.toLowerCase() === snapshot.email.toLowerCase())
          )
          if (existing) return { data, result: false }
          const now = Date.now()
          const account: Account = {
            id: randomUUID(),
            email: snapshot.email,
            nickname: item.nickname?.trim() || undefined,
            idp: (snapshot.idp as Account['idp']) || item.provider || 'BuilderId',
            userId: snapshot.userId,
            profileArn: snapshot.profileArn || item.profileArn,
            credentials: {
              accessToken: snapshot.accessToken || '',
              refreshToken: snapshot.refreshToken || item.refreshToken,
              clientId: item.clientId,
              clientSecret: item.clientSecret,
              region: item.region,
              profileArn: snapshot.profileArn || item.profileArn,
              authMethod: item.authMethod,
              provider: item.provider,
              expiresAt: now + (snapshot.expiresIn ?? 3600) * 1000
            },
            subscription: clone(snapshot.subscription),
            usage: clone(snapshot.usage),
            status: 'active',
            isActive: false,
            tagIds: [],
            paymentLink: item.paymentLink || '',
            createdAt: now,
            lastUsedAt: now,
            lastCheckedAt: now
          }
          data.accounts.push(account)
          return { data, result: true }
        })
        if (outcome) result.success++
        else result.skipped++
      } catch (error) {
        result.failed++
        result.messages.push(error instanceof Error ? error.message : String(error))
      }
    }
    return result
  }

  async refreshToken(id: string): Promise<RefreshTokenResult & { applied: boolean }> {
    const before = this.repository.load().accounts.find((account) => account.id === id)
    if (!before) throw new Error('账号不存在')
    const refreshToken = before.credentials.refreshToken
    const result = await this.dependencies.refresh(clone(before))
    const applied = await this.write((data) => {
      const index = data.accounts.findIndex((account) => account.id === id)
      if (index < 0 || data.accounts[index].credentials.refreshToken !== refreshToken) {
        return { data, result: false }
      }
      const account = data.accounts[index]
      data.accounts[index] = {
        ...account,
        credentials: {
          ...account.credentials,
          accessToken: result.accessToken,
          refreshToken: result.refreshToken,
          expiresAt: Date.now() + result.expiresIn * 1000
        },
        status: 'active',
        lastError: undefined,
        lastCheckedAt: Date.now()
      }
      return { data, result: true }
    })
    return { ...result, applied }
  }

  async refreshUsage(id: string): Promise<{ applied: boolean; snapshot: AccountSnapshot }> {
    const before = this.repository.load().accounts.find((account) => account.id === id)
    if (!before) throw new Error('账号不存在')
    const refreshToken = before.credentials.refreshToken
    const snapshot = await this.dependencies.check(clone(before))
    const applied = await this.write((data) => {
      const index = data.accounts.findIndex((account) => account.id === id)
      if (index < 0 || data.accounts[index].credentials.refreshToken !== refreshToken) return { data, result: false }
      const account = data.accounts[index]
      data.accounts[index] = {
        ...account,
        ...(snapshot.accessToken && snapshot.refreshToken ? {
          credentials: {
            ...account.credentials,
            accessToken: snapshot.accessToken,
            refreshToken: snapshot.refreshToken,
            expiresAt: Date.now() + (snapshot.expiresIn ?? 3600) * 1000
          }
        } : {}),
        subscription: clone(snapshot.subscription),
        usage: clone(snapshot.usage),
        status: 'active',
        lastError: undefined,
        lastCheckedAt: Date.now()
      }
      return { data, result: true }
    })
    return { applied, snapshot }
  }

  /** 将旧桌面 Store 的本地修改按 diff 合并到当前主进程快照，禁止陈旧全量覆盖。 */
  async reconcileDesktopSnapshot(base: AccountStoreData, next: AccountStoreData): Promise<AccountStoreData> {
    return this.write((current) => {
      const baseAccounts = new Map(base.accounts.map((account) => [account.id, account]))
      const nextAccounts = new Map(next.accounts.map((account) => [account.id, account]))
      const removedIds = [...baseAccounts.keys()].filter((id) => !nextAccounts.has(id))
      current.accounts = current.accounts.filter((account) => !removedIds.includes(account.id))
      const currentById = new Map(current.accounts.map((account) => [account.id, account]))

      for (const [id, after] of nextAccounts) {
        const before = baseAccounts.get(id)
        const live = currentById.get(id)
        if (!before) {
          if (!live) current.accounts.push(clone(after))
          continue
        }
        if (!live || isDeepStrictEqual(before, after)) continue
        const outer = changedPatch(before as unknown as Record<string, unknown>, after as unknown as Record<string, unknown>)
        delete outer.credentials
        delete outer.subscription
        delete outer.usage
        let merged = mergePatch(live as unknown as Record<string, unknown>, outer) as unknown as Account
        if (!isDeepStrictEqual(before.credentials, after.credentials) && isDeepStrictEqual(live.credentials, before.credentials)) {
          merged = { ...merged, credentials: mergePatch(live.credentials as unknown as Record<string, unknown>, changedPatch(before.credentials as unknown as Record<string, unknown>, after.credentials as unknown as Record<string, unknown>)) as unknown as Account['credentials'] }
        }
        if (!isDeepStrictEqual(before.subscription, after.subscription)) {
          merged = { ...merged, subscription: mergePatch(live.subscription as unknown as Record<string, unknown>, changedPatch(before.subscription as unknown as Record<string, unknown>, after.subscription as unknown as Record<string, unknown>)) as unknown as Account['subscription'] }
        }
        if (!isDeepStrictEqual(before.usage, after.usage)) {
          merged = { ...merged, usage: mergePatch(live.usage as unknown as Record<string, unknown>, changedPatch(before.usage as unknown as Record<string, unknown>, after.usage as unknown as Record<string, unknown>)) as unknown as Account['usage'] }
        }
        const index = current.accounts.findIndex((account) => account.id === id)
        current.accounts[index] = merged
      }

      const baseTags = new Map(base.tags.map((tag) => [tag.id, tag]))
      const nextTags = new Map(next.tags.map((tag) => [tag.id, tag]))
      current.tags = current.tags.filter((tag) => !baseTags.has(tag.id) || nextTags.has(tag.id))
      for (const [id, tag] of nextTags) {
        const previous = baseTags.get(id)
        const index = current.tags.findIndex((value) => value.id === id)
        if (!previous && index < 0) current.tags.push(clone(tag))
        else if (previous && !isDeepStrictEqual(previous, tag) && index >= 0) current.tags[index] = clone(tag)
      }
      if (base.activeAccountId !== next.activeAccountId) current.activeAccountId = next.activeAccountId
      return { data: current, result: clone(current), removedIds }
    })
  }

  async applyProactiveRefresh(id: string, expectedRefreshToken: string, result: RefreshTokenResult): Promise<boolean> {
    const applied = await this.write((data) => {
      const index = data.accounts.findIndex((account) => account.id === id)
      if (index < 0 || data.accounts[index].credentials.refreshToken !== expectedRefreshToken) return { data, result: false }
      const account = data.accounts[index]
      data.accounts[index] = {
        ...account,
        credentials: { ...account.credentials, accessToken: result.accessToken, refreshToken: result.refreshToken, expiresAt: Date.now() + result.expiresIn * 1000 },
        isActive: result.syncedToIde ? account.isActive : false,
        status: 'active',
        lastError: undefined,
        lastCheckedAt: Date.now()
      }
      return { data, result: true }
    })
    return applied
  }
}
