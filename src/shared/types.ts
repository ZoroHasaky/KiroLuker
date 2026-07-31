// ============================================
// 账户管理 —— 主进程 / 渲染进程共享类型
// ============================================
import { DEFAULT_REGION } from './regions'

export type IdpType = 'BuilderId' | 'Github' | 'Google' | 'Enterprise'

export type SubscriptionType = 'Free' | 'Pro' | 'Pro_Plus' | 'Enterprise' | 'Teams'

export type AccountStatus = 'active' | 'expired' | 'error' | 'banned' | 'unknown'

export type AuthMethod = 'IdC' | 'social'

/** 账号凭证 */
export interface AccountCredentials {
  accessToken: string
  refreshToken: string
  clientId?: string
  clientSecret?: string
  region?: string
  startUrl?: string
  /** access token 过期时间戳（ms） */
  expiresAt: number
  authMethod?: AuthMethod
  provider?: IdpType
  profileArn?: string
}

/** 奖励额度 */
export interface BonusUsage {
  code: string
  name: string
  current: number
  limit: number
  expiresAt?: string
}

/** 资源（积分）详情 */
export interface ResourceDetail {
  resourceType?: string
  displayName?: string
  displayNamePlural?: string
  currency?: string
  unit?: string
  overageRate?: number
  overageCap?: number
  overageEnabled?: boolean
}

/** 用量 / 积分 */
export interface AccountUsage {
  current: number
  limit: number
  percentUsed: number
  lastUpdated: number
  baseLimit?: number
  baseCurrent?: number
  freeTrialLimit?: number
  freeTrialCurrent?: number
  freeTrialExpiry?: string
  bonuses?: BonusUsage[]
  nextResetDate?: string
  resourceDetail?: ResourceDetail
}

/** 积分变化日志的一条记录（以账号为单位保存） */
export interface UsageHistoryEntry {
  /** 记录时间戳（ms） */
  at: number
  /** 已用积分 */
  current: number
  /** 总额度 */
  limit: number
  /** 使用占比 0-1 */
  percentUsed: number
  /** 与上一条相比的增量，第一条为 0 */
  delta: number
  baseCurrent?: number
  baseLimit?: number
  freeTrialCurrent?: number
  freeTrialLimit?: number
  /** 奖励额度合计 */
  bonusCurrent?: number
  bonusLimit?: number
}

/** 订阅 */
export interface AccountSubscription {
  type: SubscriptionType
  title?: string
  rawType?: string
  /** 下次重置时间戳（ms） */
  expiresAt?: number
  daysRemaining?: number
}

/** 账号实体 */
export interface Account {
  id: string
  email: string
  password?: string
  nickname?: string
  note?: string
  idp: IdpType
  userId?: string
  profileArn?: string
  credentials: AccountCredentials
  subscription: AccountSubscription
  usage: AccountUsage
  status: AccountStatus
  lastError?: string
  isActive: boolean
  createdAt: number
  lastUsedAt: number
  lastCheckedAt?: number
}

/** 持久化载荷 */
export interface AccountStoreData {
  version: number
  accounts: Account[]
  activeAccountId?: string | null
}

/** 导出文件结构 */
export interface AccountExportData {
  app: 'kiro-account-lite'
  version: string
  exportedAt: number
  accounts: Omit<Account, 'isActive'>[]
}

/** 简化导入项（卡密 / OIDC JSON / CSV） */
export interface AccountImportItem {
  email?: string
  password?: string
  refreshToken: string
  clientId?: string
  clientSecret?: string
  region?: string
  provider?: string
  nickname?: string
}

export interface BatchResult {
  success: number
  failed: number
  skipped: number
  messages: string[]
}

// ============ IPC 结果 ============

export interface IpcResult<T = undefined> {
  success: boolean
  data?: T
  error?: string
}

/** 校验/查询接口返回的账号快照 */
export interface AccountSnapshot {
  email: string
  userId?: string
  idp?: string
  accessToken?: string
  refreshToken?: string
  expiresIn?: number
  profileArn?: string
  subscription: AccountSubscription
  usage: AccountUsage
}

export interface VerifyCredentialsInput {
  refreshToken: string
  clientId?: string
  clientSecret?: string
  region?: string
  authMethod?: AuthMethod
  provider?: IdpType
}

export interface RefreshTokenResult {
  accessToken: string
  refreshToken: string
  expiresIn: number
  syncedToIde: boolean
  syncSkipReason?: string
}

/** 在线登录拿到的原始凭证 */
export interface OnlineLoginCredentials {
  accessToken: string
  refreshToken: string
  clientId?: string
  clientSecret?: string
  region: string
  startUrl?: string
  expiresIn: number
  authMethod: AuthMethod
  provider: IdpType
  profileArn?: string
}

export type OnlineLoginMethod = 'Google' | 'Github' | 'BuilderId' | 'Enterprise'

// ============ 系统日志 ============

/** 日志级别，按严重程度升序 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export const LOG_LEVELS: LogLevel[] = ['debug', 'info', 'warn', 'error']

export interface LogEntry {
  /** 自增序号，同时用作列表 key 与增量拉取的游标 */
  id: number
  at: number
  level: LogLevel
  /** 来源分类，取自日志的 [Xxx] 前缀，如 Net / KiroApi / AutoRefresh */
  category: string
  message: string
}

/** 日志查询条件，全部为可选，未提供即不限制 */
export interface LogQuery {
  keyword?: string
  /** 命中其中任一级别；空数组或不传表示全部 */
  levels?: LogLevel[]
  category?: string
  /** 只看这个时间点之后的日志 */
  since?: number
  /** 最多返回多少条（取最新的） */
  limit?: number
}

export interface LogQueryResult {
  /** 按时间升序返回，便于界面直接追加显示 */
  entries: LogEntry[]
  /** 命中筛选的总条数（可能大于 entries.length） */
  matched: number
  /** 当前保留的日志总条数 */
  total: number
  /** 各级别条数，用于顶部徽章（不受 levels 筛选影响） */
  counts: Record<LogLevel, number>
  /** 出现过的分类，用于下拉选项 */
  categories: string[]
}

/**
 * 主进程主动续期成功后回传给渲染进程的新凭证。
 * refreshToken 是轮换式的，渲染进程必须同步内存，否则会用作废的旧值继续刷新。
 */
export interface ProactiveRenewalPayload {
  accountId: string
  accessToken: string
  refreshToken: string
  expiresIn: number
  /**
   * 新凭证是否已写进 Kiro IDE。
   * false 表示该账号已不是 IDE 当前激活账号，续期让位给渲染进程的自动刷新。
   */
  syncedToIde: boolean
}

/** 托盘菜单动作 */
export type TrayAction = 'refresh' | 'switch-next'

/** 渲染进程推送给托盘的账号摘要 */
export interface TraySnapshot {
  total: number
  /** 可切换的正常账号数 */
  switchable: number
  email?: string
  idp?: string
  subscription?: string
  status?: string
  healthy?: boolean
  usageCurrent?: number
  usageLimit?: number
  daysRemaining?: number
  tokenLife?: string
}

/** 外部浏览器打开结果 */
export interface BrowserOpenInfo {
  /** 是否真的用无痕/隐私窗口打开 */
  privateMode: boolean
  /** 实际使用的浏览器 */
  browser?: string
}

export interface BuilderIdStartInfo extends BrowserOpenInfo {
  userCode: string
  verificationUri: string
  interval: number
  expiresIn: number
}

export interface LoginPollResult {
  completed: boolean
  credentials?: OnlineLoginCredentials
  slowDown?: boolean
}

export interface SocialCallbackPayload {
  code?: string
  state?: string
  error?: string
}

export interface LocalKiroCredentials {
  accessToken: string
  refreshToken: string
  clientId: string
  clientSecret: string
  region: string
  authMethod: AuthMethod
  provider: IdpType
}

export interface SwitchAccountInput {
  accountId: string
  accessToken: string
  refreshToken: string
  clientId?: string
  clientSecret?: string
  region?: string
  startUrl?: string
  authMethod?: AuthMethod
  provider?: IdpType
  profileArn?: string
}

export interface SwitchAccountResult {
  accessToken: string
  refreshToken: string
  expiresIn: number
  tokenPath: string
  /** IdC 账号额外写入的客户端注册文件 */
  clientRegPath?: string
  /** 最终写盘的 profileArn（BuilderId 通常为空） */
  profileArn?: string
  /** 写盘后是否用该 token 实测通过了用量接口 */
  verified: boolean
  /** 校验失败时的原因，仅用于提示，不代表切号失败 */
  verifyError?: string
  /** 过程中的提示信息（如换用了哪个 profileArn、清理了几个陈旧注册文件） */
  notes?: string[]
}

/** Kiro 官方可用模型 */
export interface KiroModelInfo {
  modelId: string
  modelName?: string
  description?: string
}

export interface ApiKeyChatTestInput {
  keyId: string
  modelId: string
  message: string
}

/** 账号测活：发起一次真实的流式对话 */
export interface ChatTestInput {
  accountId: string
  accessToken: string
  modelId: string
  message: string
  profileArn?: string
  region?: string
  idp?: string
  /** social / IdC：决定 profileArn 兜底策略 */
  authMethod?: AuthMethod
}

export interface ChatTestResult {
  endpoint: string
  text: string
  /** 首字延迟（毫秒） */
  firstByteMs: number
  totalMs: number
  /** 后端回报的实际模型，选 auto 时可看到真正被选中的那个 */
  modelId?: string
  /** 思考内容字数，推理型模型才有 */
  thinkingChars?: number
}

/** 测活过程中推送给界面的流式片段 */
export interface ChatTestChunk {
  requestId: string
  delta: string
}

/** 重启 Kiro IDE 的结果 */
export interface RestartIdeResult {
  /** 是否检测到 IDE 正在运行并成功退出 */
  quit: boolean
  /** 是否已重新拉起 IDE */
  started: boolean
  message: string
}

/** 应用与运行时信息 */
export interface AppInfo {
  version: string
  electron: string
  chrome: string
  node: string
  platform: string
  storePath: string
  backupDir: string
}

// ============================================
// 常用工具：Kiro Agent 命令审批配置
// ============================================

/** 「自动同意 AI 操作（命令 / 文件 / 网络）」涉及的一种配置机制 */
export interface ShellAutoApproveTarget {
  /**
   * trustedCommands：Kiro IDE settings.json 的 kiroAgent.trustedCommands，
   *   0.x 版本命令审批的真正入口（列表含字面 "*" 即无条件放行）。
   * permissionsYaml：~/.kiro/settings/permissions.yaml，1.0+ 的权限规则表。
   */
  kind: 'trustedCommands' | 'permissionsYaml'
  label: string
  path: string
  fileExists: boolean
  /** 本应用写入的配置当前是否在位 */
  applied: boolean
  /** 该机制现在是否可写（不可写时给出 blockedReason） */
  writable: boolean
  /** 不可写原因，或需要提醒用户的说明 */
  note?: string
}

/**
 * 「自动同意 AI 操作（命令 / 文件 / 网络）」的当前状态。
 * 一律以配置文件的真实内容为准，不依赖本应用自己记录的开关值。
 */
export interface ShellAutoApproveStatus {
  /** 两种机制都已按预期写入即为开启 */
  enabled: boolean
  /** 部分机制写入成功、部分失败 */
  partial: boolean
  /** 两种机制都是热加载，正常情况下恒为 false */
  requiresRestart: boolean
  /** 是否存有开启前的原始配置，可用于精确还原 */
  hasBackup: boolean
  /** 用户自己已经配置了放行，不属于本应用，关闭开关时不会被改动 */
  externalAllow: boolean
  /** 存在优先级更高的拦截规则，会让放行失效 */
  denyConflict: boolean
  denyConflictReason?: string
  /** 完全无法自动处理时的原因 */
  blockedReason?: string
  targets: ShellAutoApproveTarget[]
}

/** GitHub Release 检查更新结果 */
export interface UpdateCheckResult {
  /** 当前运行版本，如 1.0.3 */
  current: string
  /** 远端最新版本，已去掉 tag 前缀 v */
  latest: string
  /** 远端版本高于当前版本 */
  hasUpdate: boolean
  /** Release 页面地址，用于「前往更新」 */
  releaseUrl: string
  /** Release 名称，缺失时回退成 tag */
  name: string
  /** Release 正文（更新说明），可能为空 */
  notes: string
  /** 发布时间 ISO 字符串，可能为空 */
  publishedAt: string
}

export interface AppSettings {
  /** 主题色 */
  primaryColor: string
  darkMode: boolean
  /** 侧栏折叠 */
  sidebarCollapsed: boolean
  /** 隐私打码：列表与详情中隐藏邮箱、昵称等隐私信息 */
  privacyMode: boolean
  /** 显示两位小数积分 */
  usagePrecision: boolean
  /** 在线登录默认用无痕窗口打开 */
  loginPrivateMode: boolean
  /** 记住上次填写的 Enterprise SSO 地址与区域 */
  enterpriseStartUrl: string
  enterpriseRegion: string
  /** 自动刷新 token */
  autoRefresh: boolean
  /** 自动刷新积分用量：按下面的检查间隔与批量并发，定期拉取账号的用量与订阅 */
  autoRefreshUsage: boolean
  /** 密钥刷新间隔（分钟） */
  keyRefreshInterval: number
  /** 用量刷新间隔（分钟） */
  usageRefreshInterval: number
  /** 批量并发 */
  concurrency: number
  /** 用量接口类型 */
  usageApiType: 'rest' | 'cbor'
  /**
   * 批量导入时同时校验的账号数量。导入几千条时靠这个并发池分批处理，
   * 避免一次性发起全部请求把内存和接口打满。
   */
  importConcurrency: number
  /** 网络代理 */
  proxyEnabled: boolean
  proxyUrl: string
  /** 删除前二次确认 */
  confirmBeforeDelete: boolean
  /** 自动刷新 API Key 的订阅与积分用量 */
  autoRefreshApiKeyUsage: boolean
  /** API Key 用量刷新间隔（分钟） */
  apiKeyUsageRefreshInterval: number
  /** API Key 批量同步并发数 */
  apiKeyRefreshConcurrency: number
  /** 删除 API Key 前二次确认 */
  confirmBeforeDeleteApiKey: boolean
  /** 启用系统托盘 */
  trayEnabled: boolean
  /** 点击窗口关闭按钮时的行为：每次询问 / 最小化到托盘 / 直接退出 */
  closeAction: 'ask' | 'minimize' | 'quit'
  /**
   * IDE 主动续期：开启后账号管理器会在 IDE 当前激活账号的 token 剩 ~15 分钟时
   * 抢先 refresh 并写盘，让 Kiro IDE 永远拿到剩余时间充足的 token，
   * IDE 内部 refresh loop 不会触发，彻底消除双方同时 refresh 撞车的可能。
   */
  proactiveRenewalEnabled: boolean
}

export const DEFAULT_SETTINGS: AppSettings = {
  primaryColor: '#7c3aed',
  darkMode: false,
  sidebarCollapsed: false,
  privacyMode: false,
  usagePrecision: false,
  loginPrivateMode: false,
  enterpriseStartUrl: '',
  enterpriseRegion: DEFAULT_REGION,
  autoRefresh: true,
  autoRefreshUsage: true,
  keyRefreshInterval: 5,
  usageRefreshInterval: 5,
  concurrency: 5,
  usageApiType: 'rest',
  importConcurrency: 50,
  proxyEnabled: false,
  proxyUrl: '',
  confirmBeforeDelete: true,
  autoRefreshApiKeyUsage: true,
  apiKeyUsageRefreshInterval: 5,
  apiKeyRefreshConcurrency: 5,
  confirmBeforeDeleteApiKey: true,
  trayEnabled: true,
  closeAction: 'minimize',
  proactiveRenewalEnabled: true
}

// ============================================
// Key 管理（Kiro API Key / ksk_ 网关）
// ============================================

/**
 * 一条 Kiro API Key（ksk_ 开头）。
 * 除密钥本身外，缓存一份最近查询到的订阅 / 积分信息，用于列表展示，
 * 不必每次进页面都重新拉取。
 */
export interface KeyEntry {
  id: string
  /** 完整密钥，ksk_ 开头 */
  key: string
  note?: string
  /**
   * 该 Key 所属 AWS 区域。不同 Key 可能来自不同区域，
   * 查询额度与网关转发都按各自的区域走。旧数据由 store 迁移时补齐。
   */
  region: string
  /** 该 Key 绑定的注册邮箱，同步时从上游查回；上游未返回则为空 */
  email?: string
  /** 账号唯一标识，形如 d-<目录ID>.<用户UUID> */
  userId?: string
  createdAt: number
  /** 最近一次查询到的订阅名称，如 Kiro Pro */
  subscription?: string
  /** 订阅粗分层：free / pro / pro+ / power / other */
  tier?: string
  /** 已用积分 */
  usedCredits?: number
  /** 总积分额度 */
  totalCredits?: number
  /** 最近一次成功查询时间戳（ms） */
  lastCheckedAt?: number
  /** 最近一次查询的错误信息 */
  lastError?: string
}

/** Key 网关持久化数据 */
export interface KeyGatewayData {
  version: number
  keys: KeyEntry[]
  /** 当前激活（用于连接）的 key id */
  activeKeyId?: string | null
  /** 总开关：开启后接管 Kiro IDE 内置对话 */
  enabled: boolean
  /**
   * 新增 Key 时的默认区域，仅作为添加 / 导入弹窗的预填值。
   * 真正生效的区域记录在每个 KeyEntry.region 上。
   */
  region: string
  /** 本地代理端口，默认 KRS 19830 / CPS 19831 */
  ports: { krs: number; cps: number }
  /** 开启接管前的端点原值；关闭或异常退出时原样恢复 */
  originalEndpoints?: {
    krs: { region: string; endpoint: string }[]
    cps: { region: string; endpoint: string }[]
  }
  /** 本次接管实际改写的 settings.json */
  settingsPath?: string
}

export const DEFAULT_KEY_GATEWAY_DATA: KeyGatewayData = {
  version: 1,
  keys: [],
  activeKeyId: null,
  enabled: false,
  region: 'us-east-1',
  ports: { krs: 19830, cps: 19831 }
}

/** 单个模型信息（Key 网关测活返回） */
export interface KeyModelInfo {
  id: string
  name?: string
  rate?: number
}

/** 测试一个 API Key 的结果 */
export interface KeyTestResult {
  modelCount: number
  defaultModel: string
  subscription: string
  tier: string
  used: number | null
  total: number | null
  models: KeyModelInfo[]
}

/**
 * 开启网关前检测到的接管冲突：Kiro IDE 的端点已经指向别的本地网关。
 * 结构化返回冲突端点与端口，界面才能给出「强制接管」而不是只报错。
 */
export interface KeyGatewayConflict {
  /** 面向用户的说明文案 */
  message: string
  /** 冲突的本地端点，如 http://127.0.0.1:19820 */
  endpoints: string[]
  /** 冲突端点对应的本地端口，用于强制接管时释放 */
  ports: number[]
}

/** 强制接管时对单个冲突端口的处理结果 */
export interface KeyGatewayReleaseResult {
  port: number
  /** 该端口上监听的进程（不含本应用自身） */
  pids: number[]
  /** 端口是否已不再被其它进程占用 */
  stopped: boolean
  message: string
}

/** 应用当前网关状态后回传给渲染进程的运行时信息 */
export interface KeyGatewayStatus {
  enabled: boolean
  /** 两个本地代理是否都已监听并通过健康检查 */
  running: boolean
  /** 已选择、下一次网关请求将使用的 Key；不代表最近实际使用 */
  activeKeyId: string | null
  /** 当前网关会话最近一次真实转发所使用的 Key */
  lastForwardedKeyId: string | null
  /** 最近一次真实转发准备发送到上游的时间戳（ms） */
  lastForwardedAt?: number
  /** 最近实际使用的 Key 是否来自当前已接管的网关运行会话 */
  observedInCurrentSession: boolean
  /**
   * IDE 的 AI 请求是否确实由本网关接管。
   * 磁盘端点已绑定，或本次网关会话近期有过真实转发（IDE 进程内存里仍持有本地端点）。
   * 判定接管请用这个字段，而不是单看 endpointsBound。
   */
  ideTakenOver: boolean
  /**
   * 接管中但磁盘端点已被外部改写（典型为 Kiro IDE 启动时按自身内存回写清空）。
   * 端点守护会自动改回，持续为真说明守护没能生效，IDE 重启后接管会失效。
   */
  endpointsHijacked: boolean
  /** 当前 Key 的区域，也是网关转发实际使用的区域；未选择 Key 时为默认区域 */
  region: string
  ports: { krs: number; cps: number }
  /** settings.json 端点是否已成功指向本地代理 */
  endpointsBound: boolean
  /** 是否需要重启 / 重载 Kiro IDE 才能生效 */
  needRestart: boolean
  /** Kiro IDE settings.json 路径（用于提示） */
  settingsPath?: string
  /** 过程中的说明信息 */
  message?: string
}
