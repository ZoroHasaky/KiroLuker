export type WebApiScope = 'accounts:read' | 'accounts:write' | 'accounts:refresh' | 'billing:generate'

export const WEB_API_SCOPES: WebApiScope[] = [
  'accounts:read',
  'accounts:write',
  'accounts:refresh',
  'billing:generate'
]

/** 内置 Web 控制面板的非敏感运行配置。管理员密码与 API Key 单独保存。 */
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
}

/** 仅主进程可读取，绝不通过 IPC/HTTP 返回 hash 或管理员密码材料。 */
export interface WebControlAuthData {
  version: 1
  password?: WebControlPasswordRecord
  apiKeys: WebControlApiKeyRecord[]
}

export const DEFAULT_WEB_CONTROL_AUTH: WebControlAuthData = {
  version: 1,
  apiKeys: []
}

export interface WebControlPublicConfig extends WebControlSettings {
  passwordConfigured: boolean
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
