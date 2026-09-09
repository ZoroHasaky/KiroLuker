import { createHash, randomUUID, timingSafeEqual } from 'node:crypto'
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify'
import type { BillingPublicConfig, BillingResult } from '../shared/billing'
import { type WebApiScope, type WebControlAuthData, type WebControlSettings } from '../shared/webControl'
import type { AccountTag, BatchResult, VerifyCredentialsInput } from '../shared/types'
import { AccountApplicationService, type PublicAccount } from './accountApplicationService'
import type { BillingService } from './billingService'

const JSON_BODY_LIMIT = 2 * 1024 * 1024
const MAX_BATCH_ITEMS = 1000

interface WebControlAuthRepository {
  load(): WebControlAuthData
  save(value: WebControlAuthData): void
}

export interface WebControlHttpDependencies {
  accountService: AccountApplicationService
  billingService: BillingService
  authRepository: WebControlAuthRepository
  getSettings(): WebControlSettings
}

export interface WebJob {
  id: string
  owner: string
  kind: 'import' | 'refresh-token' | 'refresh-usage' | 'batch'
  status: 'queued' | 'running' | 'completed' | 'failed'
  total: number
  completed: number
  succeeded: number
  failed: number
  skipped: number
  messages: string[]
  createdAt: number
  startedAt?: number
  finishedAt?: number
}

interface AuthContext {
  kind: 'api-key'
  owner: string
  scopes: WebApiScope[]
}

declare module 'fastify' {
  interface FastifyRequest {
    requestId: string
    webAuth?: AuthContext
  }
}

class HttpError extends Error {
  readonly statusCode: number
  readonly code: string

  constructor(statusCode: number, code: string, message: string) {
    super(message)
    this.statusCode = statusCode
    this.code = code
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('base64url')
}

function readRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, 'INVALID_BODY', '请求体必须是对象')
  return value as Record<string, unknown>
}

function readString(value: unknown, label: string, options: { required?: boolean; max?: number } = {}): string | undefined {
  if (value == null && !options.required) return undefined
  if (typeof value !== 'string') throw new HttpError(400, 'INVALID_BODY', `${label}必须是字符串`)
  const text = value.trim()
  if (options.required && !text) throw new HttpError(400, 'INVALID_BODY', `${label}不能为空`)
  if (options.max && text.length > options.max) throw new HttpError(400, 'INVALID_BODY', `${label}过长`)
  return text
}

class SlidingWindowRateLimiter {
  private readonly timestamps = new Map<string, number[]>()

  consume(key: string, max: number, now = Date.now()): boolean {
    const windowStart = now - 60_000
    const retained = (this.timestamps.get(key) ?? []).filter((at) => at > windowStart)
    if (retained.length >= max) {
      this.timestamps.set(key, retained)
      return false
    }
    retained.push(now)
    this.timestamps.set(key, retained)
    return true
  }
}

class WebJobManager {
  private readonly jobs = new Map<string, WebJob>()
  private readonly waiting: Array<{ job: WebJob; run: (job: WebJob) => Promise<void> }> = []
  private active = 0

  enqueue(owner: string, kind: WebJob['kind'], total: number, run: (job: WebJob) => Promise<void>): WebJob {
    if (this.waiting.length >= 20) throw new HttpError(429, 'JOB_QUEUE_FULL', '后台任务队列已满，请稍后重试')
    const job: WebJob = {
      id: randomUUID(), owner, kind, status: 'queued', total, completed: 0, succeeded: 0, failed: 0, skipped: 0, messages: [], createdAt: Date.now()
    }
    this.jobs.set(job.id, job)
    this.waiting.push({ job, run })
    this.pump()
    return job
  }

  get(id: string): WebJob | null {
    const job = this.jobs.get(id)
    return job ? structuredClone(job) : null
  }

  private pump(): void {
    while (this.active < 3 && this.waiting.length) {
      const item = this.waiting.shift()!
      this.active++
      item.job.status = 'running'
      item.job.startedAt = Date.now()
      void item.run(item.job)
        .then(() => { item.job.status = 'completed' })
        .catch(() => {
          item.job.status = 'failed'
          item.job.messages.push('任务执行失败')
        })
        .finally(() => {
          item.job.finishedAt = Date.now()
          this.active--
          this.pump()
        })
    }
  }
}

function requestOrigin(request: FastifyRequest): string {
  const forwarded = request.headers['x-forwarded-proto']
  const proto = typeof forwarded === 'string' ? forwarded.split(',')[0].trim() : 'http'
  return `${proto}://${request.headers.host ?? ''}`
}

function publicJob(job: WebJob): WebJob {
  return structuredClone(job)
}

const responseEnvelopeSchema = {
  type: 'object',
  required: ['success', 'requestId'],
  properties: {
    success: { type: 'boolean' },
    requestId: { type: 'string' },
    data: {},
    error: {
      type: 'object',
      properties: { code: { type: 'string' }, message: { type: 'string' } }
    }
  }
} as const

/**
 * 生产 HTTP 应用工厂。它不直接依赖 Electron，测试可用 Fastify inject + 内存仓储真实验证
 * 路由、鉴权和任务队列；Electron 生命周期由 WebControlManager 单独管理。
 */
export async function createWebControlHttpApp(deps: WebControlHttpDependencies): Promise<FastifyInstance> {
  const initialSettings = deps.getSettings()
  const proxyList = initialSettings.trustedProxies.split(',').map((value) => value.trim()).filter(Boolean)
  const app = Fastify({ logger: false, bodyLimit: JSON_BODY_LIMIT, trustProxy: proxyList.length ? proxyList : false })
  const loginRate = new SlidingWindowRateLimiter()
  const apiRate = new SlidingWindowRateLimiter()
  const billingRate = new SlidingWindowRateLimiter()
  const jobs = new WebJobManager()
  let billingInFlight = 0

  function ok<T>(request: FastifyRequest, data?: T): { success: true; data?: T; requestId: string } {
    return data === undefined ? { success: true, requestId: request.requestId } : { success: true, data, requestId: request.requestId }
  }

  function ensureHost(request: FastifyRequest): void {
    const publicUrl = deps.getSettings().publicUrl.trim()
    if (!publicUrl) return
    let allowed: URL
    try { allowed = new URL(publicUrl) } catch { throw new HttpError(500, 'INVALID_CONFIG', '公网访问地址配置无效') }
    if (request.headers.host !== allowed.host) throw new HttpError(403, 'INVALID_HOST', '请求 Host 不受信任')
  }

  function requireAuth(scopes: WebApiScope[] = [], _adminOnly = false, _write = false) {
    return async (request: FastifyRequest): Promise<void> => {
      const authorization = request.headers.authorization
      if (!authorization?.startsWith('Bearer ')) throw new HttpError(401, 'AUTH_REQUIRED', '需要 API Key')
      const token = authorization.slice('Bearer '.length).trim()
      if (!token || token.length > 300) throw new HttpError(401, 'INVALID_API_KEY', 'API Key 无效')
      const auth = deps.authRepository.load()
      const key = auth.apiKeys.find((item) => !item.revokedAt && timingSafeEqual(Buffer.from(item.hash), Buffer.from(sha256(token))))
      if (!key) throw new HttpError(401, 'INVALID_API_KEY', 'API Key 无效')
      if (!apiRate.consume(`api:${key.id}`, 120)) throw new HttpError(429, 'RATE_LIMITED', 'API 请求过于频繁')
      if (scopes.some((scope) => !key.scopes.includes(scope))) throw new HttpError(403, 'INSUFFICIENT_SCOPE', 'API Key 没有该操作权限')
      request.webAuth = { kind: 'api-key', owner: `key:${key.id}`, scopes: [...key.scopes] }
      key.lastUsedAt = Date.now()
      deps.authRepository.save({ ...auth, apiKeys: auth.apiKeys.map((item) => item.id === key.id ? key : item) })
    }
  }

  async function runItems<T>(job: WebJob, items: T[], action: (item: T) => Promise<'success' | 'skipped'>): Promise<void> {
    let cursor = 0
    const workers = Array.from({ length: Math.min(3, items.length) }, async () => {
      while (true) {
        const index = cursor++
        if (index >= items.length) return
        try {
          const state = await action(items[index])
          if (state === 'success') job.succeeded++
          else job.skipped++
        } catch {
          job.failed++
          job.messages.push('部分账号操作失败')
        } finally {
          job.completed++
        }
      }
    })
    await Promise.all(workers)
  }

  app.addHook('onRequest', async (request, reply) => {
    request.requestId = randomUUID()
    reply.header('x-request-id', request.requestId)
    ensureHost(request)
  })

  app.setErrorHandler((error, request, reply) => {
    const known = error instanceof HttpError
    const candidateStatus = typeof (error as { statusCode?: unknown }).statusCode === 'number' ? (error as { statusCode: number }).statusCode : undefined
    const status = known ? error.statusCode : (candidateStatus && candidateStatus < 500 ? candidateStatus : 500)
    const code = known ? error.code : status === 429 ? 'RATE_LIMITED' : 'INTERNAL_ERROR'
    const message = known ? error.message : status === 429 ? '请求过于频繁' : '请求处理失败'
    void reply.status(status).send({ success: false, error: { code, message }, requestId: request.requestId })
  })


  /** 移动端连接校验：认证成功即可返回，不把缺少业务权限误报为登录失效。 */
  app.get('/api/v1/capabilities', { schema: { tags: ['capabilities'], response: { 200: responseEnvelopeSchema } }, preHandler: requireAuth() }, async (request) => ok(request, {
    apiVersion: '1',
    scopes: [...request.webAuth!.scopes],
    features: { accountExport: true, paymentLinks: true, checkoutBilling: true }
  }))

  app.get('/api/v1/accounts', { schema: { tags: ['accounts'], querystring: { type: 'object', additionalProperties: false, properties: { page: { type: 'integer', minimum: 1 }, pageSize: { type: 'integer', minimum: 1, maximum: 100 }, search: { type: 'string', maxLength: 200 }, status: { type: 'string' }, subscription: { type: 'string' }, idp: { type: 'string' }, tagId: { type: 'string', maxLength: 100 }, createdAfter: { type: 'integer', minimum: 0 }, createdBefore: { type: 'integer', minimum: 0 }, paymentStatus: { type: 'string', enum: ['pending', 'not_pending'] } } }, response: { 200: responseEnvelopeSchema } }, preHandler: requireAuth(['accounts:read']) }, async (request) => {
    const query = (request.query ?? {}) as Record<string, unknown>
    const page = Number(query.page ?? 1)
    const pageSize = Number(query.pageSize ?? 30)
    const search = typeof query.search === 'string' ? query.search.trim().toLowerCase() : ''
    const createdAfter = typeof query.createdAfter === 'number' ? query.createdAfter : undefined
    const createdBefore = typeof query.createdBefore === 'number' ? query.createdBefore : undefined
    if (createdAfter !== undefined && createdBefore !== undefined && createdAfter >= createdBefore) {
      throw new HttpError(400, 'INVALID_DATE_RANGE', '导入日期范围无效')
    }
    let accounts = deps.accountService.listPublicAccounts()
    if (search) accounts = accounts.filter((account) => `${account.email} ${account.nickname ?? ''}`.toLowerCase().includes(search))
    for (const key of ['status', 'subscription', 'idp'] as const) {
      const value = query[key]
      if (typeof value === 'string' && value) accounts = accounts.filter((account) => key === 'subscription' ? account.subscription.type === value : account[key] === value)
    }
    const tagId = typeof query.tagId === 'string' ? query.tagId : ''
    if (tagId) accounts = accounts.filter((account) => account.tagIds.includes(tagId))
    if (createdAfter !== undefined) accounts = accounts.filter((account) => account.createdAt >= createdAfter)
    if (createdBefore !== undefined) accounts = accounts.filter((account) => account.createdAt < createdBefore)
    const paymentStatus = typeof query.paymentStatus === 'string' ? query.paymentStatus : ''
    if (paymentStatus) {
      accounts = accounts.filter((account) => {
        const pending = account.hasPaymentLink && account.subscription.type === 'Free'
        return paymentStatus === 'pending' ? pending : !pending
      })
    }
    const total = accounts.length
    return ok(request, { items: accounts.slice((page - 1) * pageSize, page * pageSize), page, pageSize, total })
  })

  app.get('/api/v1/accounts/:id', { schema: { tags: ['accounts'], params: { type: 'object', required: ['id'], properties: { id: { type: 'string', minLength: 1, maxLength: 100 } } }, response: { 200: responseEnvelopeSchema } }, preHandler: requireAuth(['accounts:read']) }, async (request) => {
    const id = (request.params as { id: string }).id
    const account = deps.accountService.getPublicAccount(id)
    if (!account) throw new HttpError(404, 'NOT_FOUND', '账号不存在')
    return ok(request, account)
  })

  /** 凭证导出只在用户显式复制时读取，不会进入 PublicAccount 或普通列表缓存。 */
  app.get('/api/v1/accounts/:id/oidc', { schema: { tags: ['accounts'], params: { type: 'object', required: ['id'], properties: { id: { type: 'string', minLength: 1, maxLength: 100 } } }, response: { 200: responseEnvelopeSchema } }, preHandler: requireAuth(['accounts:export']) }, async (request, reply) => {
    const content = deps.accountService.getOidcExportContent((request.params as { id: string }).id)
    if (content === null) throw new HttpError(404, 'NOT_FOUND', '账号不存在')
    reply.header('cache-control', 'no-store')
    return ok(request, { content })
  })

  /** 完整支付链接不出现在账号响应中；未配置时返回明确业务状态。 */
  app.get('/api/v1/accounts/:id/payment-link', { schema: { tags: ['accounts'], params: { type: 'object', required: ['id'], properties: { id: { type: 'string', minLength: 1, maxLength: 100 } } }, response: { 200: responseEnvelopeSchema } }, preHandler: requireAuth(['accounts:payment']) }, async (request, reply) => {
    const link = deps.accountService.getPaymentLink((request.params as { id: string }).id)
    if (link === null && !deps.accountService.getPublicAccount((request.params as { id: string }).id)) {
      throw new HttpError(404, 'NOT_FOUND', '账号不存在')
    }
    reply.header('cache-control', 'no-store')
    return ok(request, link ? { configured: true, url: link } : { configured: false })
  })

  app.patch('/api/v1/accounts/:id', { schema: { tags: ['accounts'], params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } }, body: { type: 'object', additionalProperties: false, properties: { nickname: { type: 'string', maxLength: 200 }, note: { type: 'string', maxLength: 4000 }, tagIds: { type: 'array', maxItems: 100, items: { type: 'string', minLength: 1, maxLength: 100 } } } }, response: { 200: responseEnvelopeSchema } }, preHandler: requireAuth(['accounts:write'], false, true) }, async (request) => {
    const body = readRecord(request.body)
    const account = await deps.accountService.patchAccount((request.params as { id: string }).id, { nickname: readString(body.nickname, '昵称', { max: 200 }), note: readString(body.note, '备注', { max: 4000 }), tagIds: Array.isArray(body.tagIds) ? body.tagIds.map((value) => String(value)) : undefined })
    return ok(request, account)
  })

  app.delete('/api/v1/accounts/:id', { schema: { tags: ['accounts'], params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } }, response: { 200: responseEnvelopeSchema } }, preHandler: requireAuth(['accounts:write'], false, true) }, async (request) => ok(request, await deps.accountService.deleteAccounts([(request.params as { id: string }).id])))

  app.post('/api/v1/accounts/import', { schema: { tags: ['accounts'], body: { type: 'object', additionalProperties: false, required: ['items'], properties: { items: { type: 'array', minItems: 1, maxItems: MAX_BATCH_ITEMS, items: { type: 'object', additionalProperties: false, required: ['refreshToken'], properties: { refreshToken: { type: 'string', minLength: 1, maxLength: 10000 }, clientId: { type: 'string', maxLength: 2000 }, clientSecret: { type: 'string', maxLength: 10000 }, region: { type: 'string', maxLength: 100 }, authMethod: { type: 'string' }, provider: { type: 'string' }, profileArn: { type: 'string', maxLength: 2000 }, nickname: { type: 'string', maxLength: 200 }, paymentLink: { type: 'string', maxLength: 2000 } } } } } }, response: { 202: responseEnvelopeSchema } }, preHandler: requireAuth(['accounts:write'], false, true) }, async (request, reply) => {
    const items = readRecord(request.body).items
    if (!Array.isArray(items)) throw new HttpError(400, 'INVALID_BODY', 'items必须是数组')
    const clean = items.map((item) => readRecord(item) as unknown as VerifyCredentialsInput & { nickname?: string; paymentLink?: string })
    const job = jobs.enqueue(request.webAuth!.owner, 'import', clean.length, async (state) => {
      const result: BatchResult = await deps.accountService.importCredentials(clean)
      state.completed = clean.length; state.succeeded = result.success; state.failed = result.failed; state.skipped = result.skipped
      state.messages = result.failed ? [`${result.failed} 个账号导入失败，请查看桌面端系统日志`] : []
    })
    return reply.status(202).send(ok(request, { jobId: job.id }))
  })

  function refreshRoute(kind: 'refresh-token' | 'refresh-usage') {
    return async (request: FastifyRequest, reply: FastifyReply) => {
      const id = (request.params as { id: string }).id
      if (!deps.accountService.getPublicAccount(id)) throw new HttpError(404, 'NOT_FOUND', '账号不存在')
      const job = jobs.enqueue(request.webAuth!.owner, kind, 1, async (state) => {
        try {
          if (kind === 'refresh-token') await deps.accountService.refreshToken(id)
          else await deps.accountService.refreshUsage(id)
          state.succeeded = 1
        } catch { state.failed = 1; state.messages.push('账号刷新失败') }
        state.completed = 1
      })
      return reply.status(202).send(ok(request, { jobId: job.id }))
    }
  }

  const refreshSchema = { tags: ['accounts'], params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } }, response: { 202: responseEnvelopeSchema } }
  app.post('/api/v1/accounts/:id/refresh-token', { schema: refreshSchema, preHandler: requireAuth(['accounts:refresh'], false, true) }, refreshRoute('refresh-token'))
  app.post('/api/v1/accounts/:id/refresh-usage', { schema: refreshSchema, preHandler: requireAuth(['accounts:refresh'], false, true) }, refreshRoute('refresh-usage'))

  app.post('/api/v1/accounts/batch', { schema: { tags: ['accounts'], body: { type: 'object', additionalProperties: false, required: ['operation', 'ids'], properties: { operation: { type: 'string', enum: ['refresh-token', 'refresh-usage', 'delete', 'set-tags'] }, ids: { type: 'array', minItems: 1, maxItems: MAX_BATCH_ITEMS, items: { type: 'string', minLength: 1, maxLength: 100 } }, tagIds: { type: 'array', maxItems: 100, items: { type: 'string', minLength: 1, maxLength: 100 } } } }, response: { 202: responseEnvelopeSchema } }, preHandler: async (request) => {
    const body = readRecord(request.body)
    const op = body.operation
    if (op === 'delete' || op === 'set-tags') return requireAuth(['accounts:write'], false, true)(request)
    return requireAuth(['accounts:refresh'], false, true)(request)
  } }, async (request, reply) => {
    const body = readRecord(request.body)
    const operation = readString(body.operation, 'operation', { required: true })!
    const ids = Array.isArray(body.ids) ? [...new Set(body.ids.map((value) => String(value)).filter(Boolean))] : []
    if (!ids.length || ids.length > MAX_BATCH_ITEMS) throw new HttpError(400, 'INVALID_BODY', 'ids数量无效')
    const tagIds = Array.isArray(body.tagIds) ? body.tagIds.map((value) => String(value)) : []
    const job = jobs.enqueue(request.webAuth!.owner, 'batch', ids.length, async (state) => {
      if (operation === 'delete') {
        const result = await deps.accountService.deleteAccounts(ids)
        state.completed = ids.length; state.succeeded = result.removed; state.skipped = ids.length - result.removed
        return
      }
      await runItems(state, ids, async (id) => {
        const account = deps.accountService.getPublicAccount(id)
        if (!account) return 'skipped'
        if (operation === 'refresh-token') await deps.accountService.refreshToken(id)
        else if (operation === 'refresh-usage') await deps.accountService.refreshUsage(id)
        else if (operation === 'set-tags') await deps.accountService.patchAccount(id, { tagIds })
        else throw new Error('unsupported')
        return 'success'
      })
    })
    return reply.status(202).send(ok(request, { jobId: job.id }))
  })

  app.get('/api/v1/jobs/:id', { schema: { tags: ['jobs'], params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } }, response: { 200: responseEnvelopeSchema } }, preHandler: requireAuth() }, async (request) => {
    const job = jobs.get((request.params as { id: string }).id)
    if (!job) throw new HttpError(404, 'NOT_FOUND', '任务不存在')
    if (job.owner !== request.webAuth!.owner) throw new HttpError(403, 'FORBIDDEN', '无权查看该任务')
    return ok(request, publicJob(job))
  })

  app.get('/api/v1/tags', { schema: { tags: ['tags'], response: { 200: responseEnvelopeSchema } }, preHandler: requireAuth(['accounts:read']) }, async (request) => ok(request, deps.accountService.getData().tags))
  app.post('/api/v1/tags', { schema: { tags: ['tags'], body: { type: 'object', additionalProperties: false, required: ['name'], properties: { name: { type: 'string', minLength: 1, maxLength: 100 }, color: { type: 'string', maxLength: 32 } } }, response: { 200: responseEnvelopeSchema } }, preHandler: requireAuth(['accounts:write'], false, true) }, async (request) => {
    const body = readRecord(request.body)
    return ok(request, await deps.accountService.createTag({ name: readString(body.name, '标签名称', { required: true, max: 100 })!, color: readString(body.color, '颜色', { max: 32 }) ?? '#7c3aed' }))
  })
  app.patch('/api/v1/tags/:id', { schema: { tags: ['tags'], params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } }, body: { type: 'object', additionalProperties: false, properties: { name: { type: 'string', maxLength: 100 }, color: { type: 'string', maxLength: 32 } } }, response: { 200: responseEnvelopeSchema } }, preHandler: requireAuth(['accounts:write'], false, true) }, async (request) => {
    const body = readRecord(request.body)
    return ok(request, await deps.accountService.patchTag((request.params as { id: string }).id, { name: readString(body.name, '标签名称', { max: 100 }), color: readString(body.color, '颜色', { max: 32 }) }))
  })
  app.delete('/api/v1/tags/:id', { schema: { tags: ['tags'], params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } }, response: { 200: responseEnvelopeSchema } }, preHandler: requireAuth(['accounts:write'], false, true) }, async (request) => { await deps.accountService.deleteTag((request.params as { id: string }).id); return ok(request) })

  app.post('/api/v1/billing/generate', { schema: { tags: ['billing'], response: { 200: responseEnvelopeSchema } }, preHandler: requireAuth(['billing:generate'], false, true) }, async (request, reply) => {
    if (!billingRate.consume(`billing:${request.webAuth!.owner}`, 10)) throw new HttpError(429, 'RATE_LIMITED', '账单生成过于频繁')
    if (billingInFlight >= 2) throw new HttpError(429, 'BILLING_BUSY', '账单生成任务繁忙')
    billingInFlight++
    try {
      reply.header('cache-control', 'no-store')
      return ok(request, await deps.billingService.generate())
    } finally { billingInFlight-- }
  })

  app.post('/api/v1/billing/checkout/generate', { schema: { tags: ['billing'], response: { 200: responseEnvelopeSchema } }, preHandler: requireAuth(['billing:generate'], false, true) }, async (request, reply) => {
    if (!billingRate.consume(`billing:${request.webAuth!.owner}`, 10)) throw new HttpError(429, 'RATE_LIMITED', '账单生成过于频繁')
    if (billingInFlight >= 2) throw new HttpError(429, 'BILLING_BUSY', '账单生成任务繁忙')
    billingInFlight++
    try {
      reply.header('cache-control', 'no-store')
      return ok(request, await deps.billingService.generateCheckout())
    } finally { billingInFlight-- }
  })



  return app
}

export type { BillingPublicConfig, BillingResult, PublicAccount }
