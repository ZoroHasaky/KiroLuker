import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { basename, extname, resolve, sep } from 'node:path'
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify'
import swagger from '@fastify/swagger'
import type { BillingConfigPatch, BillingSecretName, BillingSecretPatch, BillingPublicConfig, BillingResult } from '../shared/billing'
import { WEB_API_SCOPES, type WebApiScope, type WebControlApiKeyPublic, type WebControlApiKeyRecord, type WebControlAuthData, type WebControlSettings } from '../shared/webControl'
import type { AccountTag, BatchResult, VerifyCredentialsInput } from '../shared/types'
import { AccountApplicationService, type PublicAccount } from './accountApplicationService'
import type { BillingService } from './billingService'

const SESSION_IDLE_MS = 30 * 60 * 1000
const SESSION_MAX_MS = 8 * 60 * 60 * 1000
const SESSION_COOKIE = 'klr_admin_session'
const CSRF_HEADER = 'x-csrf-token'
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
  webDir: string
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

interface Session {
  id: string
  csrfToken: string
  createdAt: number
  lastSeenAt: number
}

interface AuthContext {
  kind: 'admin' | 'api-key'
  owner: string
  scopes: WebApiScope[]
  csrfToken?: string
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

function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url')
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

function parseCookies(header: unknown): Record<string, string> {
  if (typeof header !== 'string') return {}
  const output: Record<string, string> = {}
  for (const item of header.split(';')) {
    const index = item.indexOf('=')
    if (index <= 0) continue
    output[item.slice(0, index).trim()] = decodeURIComponent(item.slice(index + 1).trim())
  }
  return output
}

function mimeType(file: string): string {
  switch (extname(file).toLowerCase()) {
    case '.html': return 'text/html; charset=utf-8'
    case '.js': return 'application/javascript; charset=utf-8'
    case '.css': return 'text/css; charset=utf-8'
    case '.json': return 'application/json; charset=utf-8'
    case '.svg': return 'image/svg+xml'
    case '.png': return 'image/png'
    case '.ico': return 'image/x-icon'
    case '.woff2': return 'font/woff2'
    default: return 'application/octet-stream'
  }
}

function asPublicApiKey(record: WebControlApiKeyRecord): WebControlApiKeyPublic {
  return {
    id: record.id,
    name: record.name,
    prefix: record.prefix,
    scopes: [...record.scopes],
    createdAt: record.createdAt,
    lastUsedAt: record.lastUsedAt,
    revokedAt: record.revokedAt
  }
}

function scryptAsync(value: string, salt: string): Promise<Buffer> {
  return new Promise((resolvePromise, reject) => {
    scrypt(value, salt, 64, { N: 16_384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (error, derived) => {
      if (error) reject(error)
      else resolvePromise(derived as Buffer)
    })
  })
}

export async function createPasswordRecord(password: string): Promise<{ salt: string; hash: string }> {
  if (password.length < 10) throw new Error('管理员密码至少需要 10 个字符')
  const salt = randomToken(16)
  const hash = (await scryptAsync(password, salt)).toString('base64url')
  return { salt, hash }
}

async function passwordMatches(password: string, record: { salt: string; hash: string }): Promise<boolean> {
  const actual = await scryptAsync(password, record.salt)
  const expected = Buffer.from(record.hash, 'base64url')
  return expected.length === actual.length && timingSafeEqual(expected, actual)
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

function cookieValue(value: string, settings: WebControlSettings): string {
  const secure = settings.publicUrl.startsWith('https://') ? '; Secure' : ''
  return `${SESSION_COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(SESSION_MAX_MS / 1000)}${secure}`
}

function emptyCookie(settings: WebControlSettings): string {
  const secure = settings.publicUrl.startsWith('https://') ? '; Secure' : ''
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure}`
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
  const sessions = new Map<string, Session>()
  const loginRate = new SlidingWindowRateLimiter()
  const apiRate = new SlidingWindowRateLimiter()
  const billingRate = new SlidingWindowRateLimiter()
  const jobs = new WebJobManager()
  let billingInFlight = 0

  function ok<T>(request: FastifyRequest, data?: T): { success: true; data?: T; requestId: string } {
    return data === undefined ? { success: true, requestId: request.requestId } : { success: true, data, requestId: request.requestId }
  }

  function currentSession(request: FastifyRequest): Session | null {
    const id = parseCookies(request.headers.cookie)[SESSION_COOKIE]
    if (!id) return null
    const session = sessions.get(id)
    if (!session) return null
    const now = Date.now()
    if (now - session.lastSeenAt > SESSION_IDLE_MS || now - session.createdAt > SESSION_MAX_MS) {
      sessions.delete(id)
      return null
    }
    session.lastSeenAt = now
    return session
  }

  function ensureHost(request: FastifyRequest): void {
    const publicUrl = deps.getSettings().publicUrl.trim()
    if (!publicUrl) return
    let allowed: URL
    try { allowed = new URL(publicUrl) } catch { throw new HttpError(500, 'INVALID_CONFIG', '公网访问地址配置无效') }
    if (request.headers.host !== allowed.host) throw new HttpError(403, 'INVALID_HOST', '请求 Host 不受信任')
  }

  function requireAuth(scopes: WebApiScope[] = [], adminOnly = false, write = false) {
    return async (request: FastifyRequest): Promise<void> => {
      const session = currentSession(request)
      if (session) {
        if (write) {
          const configuredPublicUrl = deps.getSettings().publicUrl.trim()
          const expectedOrigin = configuredPublicUrl ? new URL(configuredPublicUrl).origin : requestOrigin(request)
          const origin = request.headers.origin
          if (typeof origin !== 'string' || origin !== expectedOrigin || request.headers[CSRF_HEADER] !== session.csrfToken) {
            throw new HttpError(403, 'CSRF_REJECTED', 'CSRF 校验失败')
          }
        }
        request.webAuth = { kind: 'admin', owner: 'admin', scopes: WEB_API_SCOPES, csrfToken: session.csrfToken }
        return
      }
      if (adminOnly) throw new HttpError(401, 'AUTH_REQUIRED', '需要管理员登录')
      const authorization = request.headers.authorization
      if (!authorization?.startsWith('Bearer ')) throw new HttpError(401, 'AUTH_REQUIRED', '需要管理员登录或 API Key')
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

  function requireAdmin(write = false) { return requireAuth([], true, write) }

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

  await app.register(swagger, {
    openapi: {
      info: { title: 'KiroLuker Web Control API', version: 'v1' },
      components: { securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } } }
    }
  })

  app.post('/api/v1/admin/login', {
    schema: { tags: ['admin'], body: { type: 'object', additionalProperties: false, required: ['password'], properties: { password: { type: 'string', minLength: 1, maxLength: 1024 } } }, response: { 200: responseEnvelopeSchema } }
  }, async (request, reply) => {
    if (!loginRate.consume(`login:${request.ip}`, 5)) throw new HttpError(429, 'RATE_LIMITED', '登录尝试过于频繁')
    const password = readString(readRecord(request.body).password, '密码', { required: true, max: 1024 })!
    const auth = deps.authRepository.load()
    if (!auth.password || !(await passwordMatches(password, auth.password))) throw new HttpError(401, 'INVALID_CREDENTIALS', '管理员密码错误')
    const session: Session = { id: randomToken(), csrfToken: randomToken(), createdAt: Date.now(), lastSeenAt: Date.now() }
    sessions.set(session.id, session)
    reply.header('set-cookie', cookieValue(session.id, deps.getSettings()))
    return ok(request, { csrfToken: session.csrfToken })
  })

  app.post('/api/v1/admin/logout', { schema: { tags: ['admin'], response: { 200: responseEnvelopeSchema } }, preHandler: requireAdmin(true) }, async (request, reply) => {
    const id = parseCookies(request.headers.cookie)[SESSION_COOKIE]
    if (id) sessions.delete(id)
    reply.header('set-cookie', emptyCookie(deps.getSettings()))
    return ok(request)
  })

  app.get('/api/v1/admin/session', { schema: { tags: ['admin'], response: { 200: responseEnvelopeSchema } }, preHandler: requireAdmin() }, async (request) => ok(request, { csrfToken: request.webAuth?.csrfToken }))

  app.get('/api/v1/openapi.json', { schema: { tags: ['admin'], response: { 200: { type: 'object' } } }, preHandler: requireAdmin() }, async () => app.swagger())

  app.get('/api/v1/accounts', { schema: { tags: ['accounts'], querystring: { type: 'object', additionalProperties: false, properties: { page: { type: 'integer', minimum: 1 }, pageSize: { type: 'integer', minimum: 1, maximum: 100 }, search: { type: 'string', maxLength: 200 }, status: { type: 'string' }, subscription: { type: 'string' }, idp: { type: 'string' }, tagId: { type: 'string', maxLength: 100 } } }, response: { 200: responseEnvelopeSchema } }, preHandler: requireAuth(['accounts:read']) }, async (request) => {
    const query = (request.query ?? {}) as Record<string, unknown>
    const page = Number(query.page ?? 1)
    const pageSize = Number(query.pageSize ?? 30)
    const search = typeof query.search === 'string' ? query.search.trim().toLowerCase() : ''
    let accounts = deps.accountService.listPublicAccounts()
    if (search) accounts = accounts.filter((account) => `${account.email} ${account.nickname ?? ''}`.toLowerCase().includes(search))
    for (const key of ['status', 'subscription', 'idp'] as const) {
      const value = query[key]
      if (typeof value === 'string' && value) accounts = accounts.filter((account) => key === 'subscription' ? account.subscription.type === value : account[key] === value)
    }
    const tagId = typeof query.tagId === 'string' ? query.tagId : ''
    if (tagId) accounts = accounts.filter((account) => account.tagIds.includes(tagId))
    const total = accounts.length
    return ok(request, { items: accounts.slice((page - 1) * pageSize, page * pageSize), page, pageSize, total })
  })

  app.get('/api/v1/accounts/:id', { schema: { tags: ['accounts'], params: { type: 'object', required: ['id'], properties: { id: { type: 'string', minLength: 1, maxLength: 100 } } }, response: { 200: responseEnvelopeSchema } }, preHandler: requireAuth(['accounts:read']) }, async (request) => {
    const id = (request.params as { id: string }).id
    const account = deps.accountService.getPublicAccount(id)
    if (!account) throw new HttpError(404, 'NOT_FOUND', '账号不存在')
    return ok(request, account)
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
    if (request.webAuth!.kind !== 'admin' && job.owner !== request.webAuth!.owner) throw new HttpError(403, 'FORBIDDEN', '无权查看该任务')
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

  app.post('/api/v1/billing/generate', { schema: { tags: ['billing'], response: { 200: responseEnvelopeSchema } }, preHandler: requireAuth(['billing:generate'], false, true) }, async (request) => {
    if (!billingRate.consume(`billing:${request.webAuth!.owner}`, 10)) throw new HttpError(429, 'RATE_LIMITED', '账单生成过于频繁')
    if (billingInFlight >= 2) throw new HttpError(429, 'BILLING_BUSY', '账单生成任务繁忙')
    billingInFlight++
    try { return ok(request, await deps.billingService.generate()) }
    finally { billingInFlight-- }
  })

  app.get('/api/v1/admin/billing-config', { schema: { tags: ['admin'], response: { 200: responseEnvelopeSchema } }, preHandler: requireAdmin() }, async (request) => ok(request, deps.billingService.getConfig()))
  app.put('/api/v1/admin/billing-config', { schema: { tags: ['admin'], body: { type: 'object', additionalProperties: false, required: ['aiUrl', 'aiModel', 'reasoningEffort'], properties: { aiUrl: { type: 'string', maxLength: 2000 }, aiModel: { type: 'string', maxLength: 300 }, reasoningEffort: { type: 'string', enum: ['', 'low', 'medium', 'high'] } } }, response: { 200: responseEnvelopeSchema } }, preHandler: requireAdmin(true) }, async (request) => ok(request, deps.billingService.saveConfig(readRecord(request.body) as unknown as BillingConfigPatch)))
  app.put('/api/v1/admin/billing-config/secrets', { schema: { tags: ['admin'], body: { type: 'object', additionalProperties: false, properties: { amap: { type: 'string', minLength: 1, maxLength: 10000 }, baidu: { type: 'string', minLength: 1, maxLength: 10000 }, ai: { type: 'string', minLength: 1, maxLength: 10000 } } }, response: { 200: responseEnvelopeSchema } }, preHandler: requireAdmin(true) }, async (request) => ok(request, deps.billingService.replaceSecrets(readRecord(request.body) as BillingSecretPatch)))
  app.delete('/api/v1/admin/billing-config/secrets', { schema: { tags: ['admin'], body: { type: 'object', additionalProperties: false, required: ['names'], properties: { names: { type: 'array', minItems: 1, maxItems: 3, items: { type: 'string', enum: ['amap', 'baidu', 'ai'] } } } }, response: { 200: responseEnvelopeSchema } }, preHandler: requireAdmin(true) }, async (request) => {
    const names = readRecord(request.body).names
    if (!Array.isArray(names)) throw new HttpError(400, 'INVALID_BODY', 'names必须是数组')
    return ok(request, deps.billingService.clearSecrets(names as BillingSecretName[]))
  })

  app.get('/api/v1/admin/api-keys', { schema: { tags: ['admin'], response: { 200: responseEnvelopeSchema } }, preHandler: requireAdmin() }, async (request) => ok(request, deps.authRepository.load().apiKeys.map(asPublicApiKey)))
  app.post('/api/v1/admin/api-keys', { schema: { tags: ['admin'], body: { type: 'object', additionalProperties: false, required: ['name'], properties: { name: { type: 'string', minLength: 1, maxLength: 100 }, scopes: { type: 'array', maxItems: WEB_API_SCOPES.length, items: { type: 'string', enum: WEB_API_SCOPES } } } }, response: { 200: responseEnvelopeSchema } }, preHandler: requireAdmin(true) }, async (request) => {
    const body = readRecord(request.body)
    const name = readString(body.name, '名称', { required: true, max: 100 })!
    const scopes: WebApiScope[] = Array.isArray(body.scopes) ? body.scopes.filter((scope): scope is WebApiScope => typeof scope === 'string' && WEB_API_SCOPES.includes(scope as WebApiScope)) : ['accounts:read']
    const token = `klr_${randomToken()}`
    const record: WebControlApiKeyRecord = { id: randomUUID(), name, prefix: token.slice(0, 14), hash: sha256(token), scopes: scopes.length ? [...new Set(scopes)] : ['accounts:read'], createdAt: Date.now() }
    const auth = deps.authRepository.load()
    deps.authRepository.save({ ...auth, apiKeys: [...auth.apiKeys, record] })
    return ok(request, { apiKey: token, item: asPublicApiKey(record) })
  })
  app.delete('/api/v1/admin/api-keys/:id', { schema: { tags: ['admin'], params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } }, response: { 200: responseEnvelopeSchema } }, preHandler: requireAdmin(true) }, async (request) => {
    const id = (request.params as { id: string }).id
    const auth = deps.authRepository.load()
    const found = auth.apiKeys.find((item) => item.id === id && !item.revokedAt)
    if (!found) throw new HttpError(404, 'NOT_FOUND', 'API Key 不存在')
    deps.authRepository.save({ ...auth, apiKeys: auth.apiKeys.map((item) => item.id === id ? { ...item, revokedAt: Date.now() } : item) })
    return ok(request)
  })

  app.get('/', { schema: { hide: true } }, async (_request, reply) => reply.redirect('/panel/'))
  // renderer 多入口会把带 hash 的面板资源输出到共享 assets 目录。只允许面板入口
  // 自身及它唯一的 Vue runtime chunk，绝不把桌面 renderer 的其它页面资源当静态目录暴露。
  app.get('/assets/:file', { schema: { hide: true } }, async (request, reply) => {
    const file = (request.params as { file: string }).file
    if (!/^(?:web|vendor-vue)-[A-Za-z0-9_-]+\.(?:js|css)$/.test(file)) {
      throw new HttpError(404, 'NOT_FOUND', '静态资源不存在')
    }
    const asset = resolve(deps.webDir, '..', 'assets', file)
    try {
      const info = await stat(asset)
      if (!info.isFile()) throw new Error('not-file')
      reply.type(mimeType(asset)).header('cache-control', 'public, max-age=31536000, immutable')
      return readFile(asset)
    } catch {
      throw new HttpError(404, 'NOT_FOUND', '静态资源不存在')
    }
  })
  app.get('/panel/*', { schema: { hide: true } }, async (request, reply) => {
    const wildcard = ((request.params as { '*': string })['*'] ?? '').replace(/\\/g, '/')
    const safe = wildcard === '' ? 'index.html' : wildcard
    if (safe.includes('..') || basename(safe) !== safe && safe.split('/').some((part) => part === '..')) throw new HttpError(400, 'INVALID_PATH', '路径无效')
    const root = resolve(deps.webDir)
    const candidate = resolve(root, safe)
    if (candidate !== root && !candidate.startsWith(root + sep)) throw new HttpError(400, 'INVALID_PATH', '路径无效')
    try {
      const info = await stat(candidate)
      if (!info.isFile()) throw new Error('not-file')
      reply.type(mimeType(candidate))
      if (safe.includes('/assets/') || safe.startsWith('assets/')) reply.header('cache-control', 'public, max-age=31536000, immutable')
      else reply.header('cache-control', 'no-cache')
      return await readFile(candidate)
    } catch {
      if (safe.includes('.') && safe !== 'index.html') throw new HttpError(404, 'NOT_FOUND', '静态资源不存在')
      reply.type('text/html; charset=utf-8').header('cache-control', 'no-cache')
      return readFile(resolve(root, 'index.html'))
    }
  })

  return app
}

export type { BillingPublicConfig, BillingResult, PublicAccount }
