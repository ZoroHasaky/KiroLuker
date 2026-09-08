<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'

type Scope = 'accounts:read' | 'accounts:write' | 'accounts:refresh' | 'billing:generate'
type Tab = 'accounts' | 'billing' | 'keys' | 'docs'

interface ApiResponse<T> { success: boolean; data?: T; error?: { code: string; message: string }; requestId: string }
interface Account { id: string; email: string; nickname?: string; note?: string; idp: string; status: string; tagIds: string[]; usage: { percentUsed: number; current: number; limit: number; lastUpdated: number }; subscription: { type: string; title?: string; daysRemaining?: number }; tokenExpiresAt: number; lastError?: string }
interface Tag { id: string; name: string; color: string }
interface Job { id: string; status: string; total: number; completed: number; succeeded: number; failed: number; skipped: number; messages: string[] }
interface BillingConfig { aiUrl: string; aiModel: string; reasoningEffort: '' | 'low' | 'medium' | 'high'; hasAmapKey: boolean; hasBaiduKey: boolean; hasAiKey: boolean; secureStorage: boolean; storageWarning?: string }
interface BillingResult { chineseName: string; pinyinName: string; address: string; postalCode: string; mapSource: string; generatedAt: number }
interface ApiKey { id: string; name: string; prefix: string; scopes: Scope[]; createdAt: number; lastUsedAt?: number; revokedAt?: number }

const tab = ref<Tab>('accounts')
const csrfToken = ref('')
const password = ref('')
const loginError = ref('')
const loading = ref(false)
const notice = ref('')
const error = ref('')
const accounts = ref<Account[]>([])
const tags = ref<Tag[]>([])
const total = ref(0)
const search = ref('')
const selected = ref<string[]>([])
const importText = ref('')
const activeJob = ref<Job | null>(null)
const billingConfig = ref<BillingConfig | null>(null)
const billingResult = ref<BillingResult | null>(null)
const apiKeys = ref<ApiKey[]>([])
const newKeyName = ref('')
const newKeyScopes = ref<Scope[]>(['accounts:read'])
const revealedApiKey = ref('')
let refreshTimer: ReturnType<typeof setInterval> | undefined
let jobTimer: ReturnType<typeof setInterval> | undefined

const apiOrigin = window.location.origin
const authenticated = computed(() => Boolean(csrfToken.value))
const selectedCount = computed(() => selected.value.length)
const scopeOptions: Array<{ value: Scope; label: string }> = [
  { value: 'accounts:read', label: '读取账户' },
  { value: 'accounts:write', label: '维护账户' },
  { value: 'accounts:refresh', label: '刷新账户' },
  { value: 'billing:generate', label: '生成账单资料' }
]

function showNotice(message: string): void { notice.value = message; error.value = ''; window.setTimeout(() => { if (notice.value === message) notice.value = '' }, 3500) }
function showError(message: string): void { error.value = message; notice.value = '' }

async function api<T>(url: string, options: RequestInit = {}): Promise<T> {
  const method = (options.method ?? 'GET').toUpperCase()
  const headers = new Headers(options.headers)
  if (options.body) headers.set('content-type', 'application/json')
  if (csrfToken.value && !['GET', 'HEAD'].includes(method)) headers.set('x-csrf-token', csrfToken.value)
  const response = await fetch(url, { ...options, headers, credentials: 'include' })
  const payload = await response.json() as ApiResponse<T>
  if (!response.ok || !payload.success) throw new Error(payload.error?.message || '请求失败')
  return payload.data as T
}

async function login(): Promise<void> {
  loading.value = true; loginError.value = ''
  try {
    const data = await api<{ csrfToken: string }>('/api/v1/admin/login', { method: 'POST', body: JSON.stringify({ password: password.value }) })
    csrfToken.value = data.csrfToken; password.value = ''
    await refreshAll(); showNotice('已安全登录 Web 控制面板')
  } catch (cause) { loginError.value = cause instanceof Error ? cause.message : '登录失败' }
  finally { loading.value = false }
}

async function checkSession(): Promise<void> {
  try {
    const data = await api<{ csrfToken: string }>('/api/v1/admin/session')
    csrfToken.value = data.csrfToken
    await refreshAll()
  } catch { csrfToken.value = '' }
}

async function logout(): Promise<void> {
  try { await api('/api/v1/admin/logout', { method: 'POST' }) } finally { csrfToken.value = ''; accounts.value = []; stopTimers() }
}

async function loadAccounts(): Promise<void> {
  const params = new URLSearchParams({ page: '1', pageSize: '100', ...(search.value.trim() ? { search: search.value.trim() } : {}) })
  const data = await api<{ items: Account[]; total: number }>(`/api/v1/accounts?${params}`)
  accounts.value = data.items; total.value = data.total
}
async function loadTags(): Promise<void> { tags.value = await api<Tag[]>('/api/v1/tags') }
async function loadBilling(): Promise<void> { billingConfig.value = await api<BillingConfig>('/api/v1/admin/billing-config') }
async function loadKeys(): Promise<void> { apiKeys.value = await api<ApiKey[]>('/api/v1/admin/api-keys') }
async function refreshAll(): Promise<void> {
  try { await Promise.all([loadAccounts(), loadTags(), loadBilling(), loadKeys()]) } catch (cause) { showError(cause instanceof Error ? cause.message : '加载数据失败') }
}

async function startJob(url: string, body?: unknown): Promise<void> {
  try {
    const data = await api<{ jobId: string }>(url, { method: 'POST', body: body ? JSON.stringify(body) : undefined })
    showNotice('任务已提交，正在后台执行'); await pollJob(data.jobId)
  } catch (cause) { showError(cause instanceof Error ? cause.message : '提交任务失败') }
}
async function pollJob(id: string): Promise<void> {
  if (jobTimer) clearInterval(jobTimer)
  const get = async () => {
    try {
      const job = await api<Job>(`/api/v1/jobs/${id}`); activeJob.value = job
      if (job.status === 'completed' || job.status === 'failed') {
        if (jobTimer) clearInterval(jobTimer); jobTimer = undefined
        await loadAccounts(); showNotice(job.status === 'completed' ? `任务完成：成功 ${job.succeeded}，失败 ${job.failed}` : '任务执行失败')
      }
    } catch (cause) { if (jobTimer) clearInterval(jobTimer); showError(cause instanceof Error ? cause.message : '读取任务失败') }
  }
  await get(); jobTimer = setInterval(() => void get(), 1000)
}

function parseImport(): Array<Record<string, string>> {
  const text = importText.value.trim()
  if (!text) throw new Error('请粘贴账号凭证 JSON 或 refreshToken 列表')
  if (text.startsWith('[') || text.startsWith('{')) {
    const parsed = JSON.parse(text) as unknown
    const rows = Array.isArray(parsed) ? parsed : (parsed && typeof parsed === 'object' && Array.isArray((parsed as { items?: unknown }).items) ? (parsed as { items: unknown[] }).items : null)
    if (!rows) throw new Error('JSON 应为数组或包含 items 的对象')
    return rows.map((row) => { if (!row || typeof row !== 'object') throw new Error('导入项必须是对象'); return row as Record<string, string> })
  }
  return text.split(/\r?\n/).map((refreshToken) => ({ refreshToken: refreshToken.trim() })).filter((item) => item.refreshToken)
}
async function importAccounts(): Promise<void> {
  try {
    const items = parseImport(); await startJob('/api/v1/accounts/import', { items }); importText.value = ''
  } catch (cause) { showError(cause instanceof Error ? cause.message : '导入失败') }
}

async function updateAccount(account: Account): Promise<void> {
  const nickname = window.prompt('昵称（留空清除）', account.nickname ?? '')
  if (nickname === null) return
  const note = window.prompt('备注（留空清除）', account.note ?? '')
  if (note === null) return
  try { await api(`/api/v1/accounts/${account.id}`, { method: 'PATCH', body: JSON.stringify({ nickname, note }) }); await loadAccounts(); showNotice('账号已保存') } catch (cause) { showError(cause instanceof Error ? cause.message : '保存失败') }
}
async function deleteAccount(id: string): Promise<void> {
  if (!window.confirm('确定删除此账号？此操作不可撤销。')) return
  try { await api(`/api/v1/accounts/${id}`, { method: 'DELETE' }); selected.value = selected.value.filter((item) => item !== id); await loadAccounts(); showNotice('账号已删除') } catch (cause) { showError(cause instanceof Error ? cause.message : '删除失败') }
}
async function addTag(): Promise<void> {
  const name = window.prompt('标签名称')
  if (!name) return
  try { await api('/api/v1/tags', { method: 'POST', body: JSON.stringify({ name, color: '#7c3aed' }) }); await loadTags(); showNotice('标签已添加') } catch (cause) { showError(cause instanceof Error ? cause.message : '添加标签失败') }
}
async function generateBilling(): Promise<void> { try { billingResult.value = await api<BillingResult>('/api/v1/billing/generate', { method: 'POST' }); showNotice('账单资料已生成') } catch (cause) { showError(cause instanceof Error ? cause.message : '生成失败') } }
async function saveBillingConfig(): Promise<void> {
  if (!billingConfig.value) return
  try { billingConfig.value = await api<BillingConfig>('/api/v1/admin/billing-config', { method: 'PUT', body: JSON.stringify({ aiUrl: billingConfig.value.aiUrl, aiModel: billingConfig.value.aiModel, reasoningEffort: billingConfig.value.reasoningEffort }) }); showNotice('非敏感账单配置已保存') } catch (cause) { showError(cause instanceof Error ? cause.message : '保存失败') }
}
async function replaceSecret(kind: 'amap' | 'baidu' | 'ai'): Promise<void> {
  const secret = window.prompt(`填写新的 ${kind} API Key（不会再显示）`)
  if (!secret) return
  try { billingConfig.value = await api<BillingConfig>('/api/v1/admin/billing-config/secrets', { method: 'PUT', body: JSON.stringify({ [kind]: secret }) }); showNotice('密钥已更新') } catch (cause) { showError(cause instanceof Error ? cause.message : '更新密钥失败') }
}
async function createApiKey(): Promise<void> {
  if (!newKeyName.value.trim()) { showError('请填写 API Key 名称'); return }
  try {
    const data = await api<{ apiKey: string; item: ApiKey }>('/api/v1/admin/api-keys', { method: 'POST', body: JSON.stringify({ name: newKeyName.value, scopes: newKeyScopes.value }) })
    revealedApiKey.value = data.apiKey; newKeyName.value = ''; await loadKeys(); showNotice('API Key 已创建，请立即复制')
  } catch (cause) { showError(cause instanceof Error ? cause.message : '创建失败') }
}
async function revokeApiKey(id: string): Promise<void> { if (!window.confirm('确定撤销此 API Key？')) return; try { await api(`/api/v1/admin/api-keys/${id}`, { method: 'DELETE' }); await loadKeys(); showNotice('API Key 已撤销') } catch (cause) { showError(cause instanceof Error ? cause.message : '撤销失败') } }
async function copy(value: string): Promise<void> { try { await navigator.clipboard.writeText(value); showNotice('已复制到剪贴板') } catch { showError('浏览器未授予剪贴板权限') } }
function formatTime(value?: number): string { return value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '-' }
function openOpenApi(): void { window.open('/api/v1/openapi.json', '_blank', 'noopener') }
function stopTimers(): void { if (refreshTimer) clearInterval(refreshTimer); if (jobTimer) clearInterval(jobTimer); refreshTimer = undefined; jobTimer = undefined }

onMounted(async () => { await checkSession(); refreshTimer = setInterval(() => { if (document.visibilityState === 'visible' && authenticated.value) void loadAccounts() }, 5000) })
onBeforeUnmount(stopTimers)
</script>

<template>
  <main class="shell">
    <section v-if="!authenticated" class="login-card">
      <div class="brand-mark">K</div><h1>KiroLuker 控制面板</h1><p>使用桌面端设置的管理员密码登录。</p>
      <form @submit.prevent="login"><label>管理员密码<input v-model="password" type="password" autocomplete="current-password" autofocus /></label><button class="primary" :disabled="loading">{{ loading ? '验证中…' : '安全登录' }}</button></form>
      <p v-if="loginError" class="alert error">{{ loginError }}</p>
    </section>

    <template v-else>
      <header><div><div class="brand"><span class="brand-mark small">K</span><strong>KiroLuker</strong><span class="subtle">Web 控制面板</span></div><p class="subtle">桌面程序运行时可用 · 账户凭证不会通过本面板返回</p></div><button class="quiet" @click="logout">退出登录</button></header>
      <nav><button :class="{ active: tab === 'accounts' }" @click="tab = 'accounts'">账户管理</button><button :class="{ active: tab === 'billing' }" @click="tab = 'billing'">账单信息</button><button :class="{ active: tab === 'keys' }" @click="tab = 'keys'">API Key</button><button :class="{ active: tab === 'docs' }" @click="tab = 'docs'">开发文档</button></nav>
      <p v-if="notice" class="alert success">{{ notice }}</p><p v-if="error" class="alert error">{{ error }}</p>

      <section v-if="tab === 'accounts'" class="page-grid">
        <article class="card wide"><div class="card-head"><div><h2>账户</h2><p>共 {{ total }} 个账户。刷新与导入会进入后台队列。</p></div><div class="actions"><input v-model="search" placeholder="搜索邮箱或昵称" @keyup.enter="loadAccounts" /><button @click="loadAccounts">搜索</button><button class="primary" @click="addTag">新建标签</button></div></div>
          <div v-if="selectedCount" class="bulk"><span>已选 {{ selectedCount }} 项</span><button @click="startJob('/api/v1/accounts/batch', { operation: 'refresh-usage', ids: selected })">刷新用量</button><button @click="startJob('/api/v1/accounts/batch', { operation: 'refresh-token', ids: selected })">刷新 Token</button><button class="danger" @click="startJob('/api/v1/accounts/batch', { operation: 'delete', ids: selected })">批量删除</button></div>
          <div class="table-wrap"><table><thead><tr><th><input type="checkbox" :checked="selected.length === accounts.length && accounts.length > 0" @change="selected = ($event.target as HTMLInputElement).checked ? accounts.map(a => a.id) : []" /></th><th>账户</th><th>订阅 / 用量</th><th>状态</th><th>Token 到期</th><th>操作</th></tr></thead><tbody><tr v-for="account in accounts" :key="account.id"><td><input v-model="selected" type="checkbox" :value="account.id" /></td><td><strong>{{ account.nickname || account.email }}</strong><small>{{ account.email }} · {{ account.idp }}</small><span v-if="account.note" class="note">{{ account.note }}</span></td><td>{{ account.subscription.type }}<small>{{ account.usage.percentUsed.toFixed(1) }}% · {{ account.usage.current }}/{{ account.usage.limit }}</small></td><td><span class="pill" :class="account.status">{{ account.status }}</span><small v-if="account.lastError">{{ account.lastError }}</small></td><td>{{ formatTime(account.tokenExpiresAt) }}</td><td class="row-actions"><button @click="startJob(`/api/v1/accounts/${account.id}/refresh-usage`)">用量</button><button @click="startJob(`/api/v1/accounts/${account.id}/refresh-token`)">Token</button><button @click="updateAccount(account)">编辑</button><button class="danger link" @click="deleteAccount(account.id)">删除</button></td></tr><tr v-if="!accounts.length"><td colspan="6" class="empty">没有匹配的账户</td></tr></tbody></table></div>
        </article>
        <article class="card"><h2>凭证导入</h2><p>粘贴 JSON 数组 / <code>{ "items": [...] }</code>，或每行一个 refreshToken。提交后不回显任何凭证。</p><textarea v-model="importText" placeholder='[{"refreshToken":"...","region":"us-east-1"}]'></textarea><button class="primary full" @click="importAccounts">验证并导入</button></article>
        <article v-if="activeJob" class="card"><h2>后台任务</h2><p><strong>{{ activeJob.status }}</strong> · {{ activeJob.completed }}/{{ activeJob.total }}</p><progress :value="activeJob.completed" :max="activeJob.total || 1"></progress><p>成功 {{ activeJob.succeeded }} · 跳过 {{ activeJob.skipped }} · 失败 {{ activeJob.failed }}</p><small v-for="message in activeJob.messages" :key="message">{{ message }}</small></article>
      </section>

      <section v-else-if="tab === 'billing'" class="page-grid"><article class="card wide"><div class="card-head"><div><h2>账单信息</h2><p>复用桌面端的真实地点、中文姓名与邮编生成服务。</p></div><button class="primary" @click="generateBilling">生成账单资料</button></div><div v-if="billingResult" class="result-grid"><div><label>中文姓名</label><strong>{{ billingResult.chineseName }}</strong><button @click="copy(billingResult.chineseName)">复制</button></div><div><label>大写拼音</label><strong>{{ billingResult.pinyinName }}</strong><button @click="copy(billingResult.pinyinName)">复制</button></div><div class="span2"><label>地址（{{ billingResult.mapSource }}）</label><strong>{{ billingResult.address }}</strong><button @click="copy(billingResult.address)">复制</button></div><div><label>邮政编码</label><strong>{{ billingResult.postalCode }}</strong><button @click="copy(billingResult.postalCode)">复制</button></div></div><p v-else class="empty">尚未生成资料</p></article>
        <article v-if="billingConfig" class="card wide"><h2>账单服务配置</h2><p class="warn" v-if="billingConfig.storageWarning">{{ billingConfig.storageWarning }}</p><div class="form-grid"><label>AI 服务 URL<input v-model="billingConfig.aiUrl" /></label><label>模型名称<input v-model="billingConfig.aiModel" /></label><label>推理强度<select v-model="billingConfig.reasoningEffort"><option value="">不发送</option><option value="low">low</option><option value="medium">medium</option><option value="high">high</option></select></label></div><div class="actions"><button class="primary" @click="saveBillingConfig">保存配置</button><button @click="replaceSecret('amap')">更新高德 Key（{{ billingConfig.hasAmapKey ? '已配置' : '未配置' }}）</button><button @click="replaceSecret('baidu')">更新百度 Key（{{ billingConfig.hasBaiduKey ? '已配置' : '未配置' }}）</button><button @click="replaceSecret('ai')">更新 AI Key（{{ billingConfig.hasAiKey ? '已配置' : '未配置' }}）</button></div></article></section>

      <section v-else-if="tab === 'keys'" class="page-grid"><article class="card wide"><h2>创建外部 API Key</h2><p>Key 只显示一次；请立即复制并保存在安全的密码库。</p><div class="form-grid"><label>名称<input v-model="newKeyName" maxlength="100" placeholder="例如：自动报表" /></label><fieldset><legend>权限</legend><label v-for="scope in scopeOptions" :key="scope.value" class="check"><input v-model="newKeyScopes" type="checkbox" :value="scope.value" />{{ scope.label }}</label></fieldset></div><button class="primary" @click="createApiKey">创建 API Key</button><div v-if="revealedApiKey" class="secret"><code>{{ revealedApiKey }}</code><button @click="copy(revealedApiKey)">复制</button><button class="quiet" @click="revealedApiKey = ''">我已保存</button></div></article><article class="card wide"><h2>现有 API Key</h2><div class="table-wrap"><table><thead><tr><th>名称</th><th>前缀</th><th>权限</th><th>创建/最后使用</th><th></th></tr></thead><tbody><tr v-for="key in apiKeys" :key="key.id"><td>{{ key.name }}</td><td><code>{{ key.prefix }}…</code></td><td>{{ key.scopes.join(', ') }}</td><td>{{ formatTime(key.createdAt) }}<small>{{ key.lastUsedAt ? `最后使用：${formatTime(key.lastUsedAt)}` : '从未使用' }}</small></td><td><button v-if="!key.revokedAt" class="danger link" @click="revokeApiKey(key.id)">撤销</button><span v-else class="subtle">已撤销</span></td></tr><tr v-if="!apiKeys.length"><td colspan="5" class="empty">暂无 API Key</td></tr></tbody></table></div></article></section>

      <section v-else class="page-grid"><article class="card wide"><h2>API 文档</h2><p>OpenAPI 文档仅管理员会话可读取。外部程序使用 <code>Authorization: Bearer klr_...</code>，不要把 Key 放到 URL、日志或前端代码。</p><button class="primary" @click="openOpenApi">打开 OpenAPI JSON</button><pre>curl -H "Authorization: Bearer klr_…" \
  {{ apiOrigin }}/api/v1/accounts?page=1&amp;pageSize=30</pre><p>支持：账户查询、维护、刷新、批量任务、标签、账单资料生成及任务进度。管理员配置和 API Key 管理不向外部 API Key 开放。</p></article></section>
    </template>
  </main>
</template>
