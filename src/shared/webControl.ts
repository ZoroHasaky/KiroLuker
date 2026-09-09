export type WebApiScope =
  | 'accounts:read'
  | 'accounts:write'
  | 'accounts:refresh'
  | 'accounts:export'
  | 'accounts:payment'
  | 'billing:generate'

/** 移动 App 登录 Key 固定授予的全部 API 权限。新增权限时服务会重新生成默认 Key。 */
export const WEB_API_SCOPES: WebApiScope[] = [
  'accounts:read',
  'accounts:write',
  'accounts:refresh',
  'accounts:export',
  'accounts:payment',
  'billing:generate'
]

/** 独立移动 API 服务的非敏感运行配置。旧管理员密码记录仅为兼容旧安装而保留。 */
export interface WebControlSettings {
  enabled: boolean
  host: string
  port: number
  /** 反向代理对外的 HTTPS 地址；为空时仅按本地访问处理。 */
  publicUrl: string
  /** 仅当经反向代理部署时填写受信任代理 IP/CIDR，逗号分隔。 */
  trustedProxies: string
}

export const DEFAULT_WEB_CONTROL_SETTINGS: WebControlSettings = {
  enabled: false,
  host: '127.0.0.1',
  port: 19840,
  publicUrl: '',
  trustedProxies: ''
}

export interface WebControlPasswordRecord {
  salt: string
  hash: string
}

export interface WebControlApiKeyRecord {
  id: string
  name: string
  prefix: string
  hash: string
  scopes: WebApiScope[]
  createdAt: number
  lastUsedAt?: number
  revokedAt?: number
  /** 仅主进程持有的 Electron safeStorage 密文；绝不经 IPC/HTTP 列表返回。 */
  encryptedToken?: string
}

/** 仅主进程可读取，绝不通过 IPC/HTTP 返回 hash 或管理员密码材料。 */
export interface WebControlAuthData {
  version: 1 | 2
  password?: WebControlPasswordRecord
  apiKeys: WebControlApiKeyRecord[]
}

export const DEFAULT_WEB_CONTROL_AUTH: WebControlAuthData = {
  version: 2,
  apiKeys: []
}

export interface WebControlPublicConfig extends WebControlSettings {
  running: boolean
  url?: string
  error?: string
}

export interface WebControlApiKeyPublic {
  id: string
  name: string
  prefix: string
  scopes: WebApiScope[]
  createdAt: number
  lastUsedAt?: number
  revokedAt?: number
}
