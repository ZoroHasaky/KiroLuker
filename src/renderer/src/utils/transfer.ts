// 导入 / 导出格式转换
import { DEFAULT_REGION } from '@shared/regions'
import type { Account, AccountExportData, AccountImportItem, IdpType } from '@shared/types'

export type ExportFormat = 'json' | 'oidc' | 'kami' | 'csv' | 'txt' | 'clipboard'

const VALID_IDPS: IdpType[] = ['BuilderId', 'Github', 'Google', 'Enterprise']

/** 把外部写法归一成内部 IdP 枚举，认不出来的按 BuilderId 处理 */
export function normalizeIdp(value?: string): IdpType {
  if (!value) return 'BuilderId'
  const lower = value.trim().toLowerCase()
  const hit = VALID_IDPS.find((v) => v.toLowerCase() === lower)
  if (hit) return hit
  // 别名：标准名已在上面命中，这里只处理简写
  if (lower === 'gh') return 'Github'
  if (lower === 'gmail') return 'Google'
  return 'BuilderId'
}

/** 社交登录（GitHub / Google）只有 refreshToken，IdC 才需要 clientId/secret */
export function isSocialIdp(idp: IdpType): boolean {
  return idp === 'Github' || idp === 'Google'
}

/** 卡密行分隔符自动识别：----、Tab、连续空格、逗号 */
function splitCredentialLine(line: string): string[] {
  if (line.includes('----')) return line.split('----')
  if (line.includes('\t')) return line.split('\t')
  if (/\s{2,}/.test(line)) return line.split(/\s{2,}/)
  return line.split(',')
}

function parseKamiLines(text: string): AccountImportItem[] {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .map((line) => {
      const parts = splitCredentialLine(line).map((p) => p.trim())
      const password = parts[1] && parts[1] !== 'no_password' ? parts[1] : undefined
      const clientId = parts[3] || undefined
      const clientSecret = parts[4] || undefined
      // 第 6 段是登录方式；旧卡密没有该字段时，按有无 clientId/secret 推断：
      // social（GitHub/Google）只有 refreshToken，IdC 才带 clientId/secret
      const provider = parts[5] || (!clientId && !clientSecret ? 'Google' : 'BuilderId')
      return {
        email: parts[0] || undefined,
        password,
        refreshToken: parts[2] || '',
        clientId,
        clientSecret,
        provider
      }
    })
    .filter((item) => !!item.refreshToken)
}

function parseCsvRow(row: string): string[] {
  const out: string[] = []
  let cur = ''
  let quoted = false
  for (let i = 0; i < row.length; i++) {
    const ch = row[i]
    if (quoted) {
      if (ch === '"') {
        if (row[i + 1] === '"') {
          cur += '"'
          i++
        } else quoted = false
      } else cur += ch
    } else if (ch === '"') {
      quoted = true
    } else if (ch === ',') {
      out.push(cur)
      cur = ''
    } else cur += ch
  }
  out.push(cur)
  return out.map((c) => c.trim())
}

const HEADER_ALIASES: Record<string, keyof AccountImportItem> = {
  邮箱: 'email',
  email: 'email',
  昵称: 'nickname',
  nickname: 'nickname',
  登录方式: 'provider',
  idp: 'provider',
  provider: 'provider',
  密码: 'password',
  password: 'password',
  refreshtoken: 'refreshToken',
  'refresh token': 'refreshToken',
  clientid: 'clientId',
  clientsecret: 'clientSecret',
  region: 'region'
}

function parseCsv(text: string): AccountImportItem[] {
  const lines = text
    .replace(/^\ufeff/, '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
  if (lines.length === 0) return []

  const first = parseCsvRow(lines[0]).map((h) => h.toLowerCase())
  const mapped = first.map((h) => HEADER_ALIASES[h])
  const hasHeader = mapped.filter(Boolean).length >= 2

  if (!hasHeader) return parseKamiLines(text)

  return lines
    .slice(1)
    .map((line) => {
      const cells = parseCsvRow(line)
      const item: AccountImportItem = { refreshToken: '' }
      mapped.forEach((key, i) => {
        if (!key) return
        const value = cells[i]
        if (value) (item as unknown as Record<string, string>)[key] = value
      })
      return item
    })
    .filter((item) => !!item.refreshToken)
}

export interface ParsedImport {
  items: AccountImportItem[]
  /** 完整导出文件（含用量、订阅等），可直接恢复 */
  fullData?: AccountExportData
}

/** 统一解析导入内容：完整 JSON / 精简 JSON 数组 / 卡密 / CSV / TXT */
export function parseImportContent(raw: string): ParsedImport {
  const text = raw.trim()
  if (!text) return { items: [] }

  try {
    const parsed = JSON.parse(text)

    // 完整导出文件
    if (parsed && typeof parsed === 'object' && Array.isArray(parsed.accounts)) {
      return { items: [], fullData: parsed as AccountExportData }
    }

    // 精简 JSON 数组 / 单对象
    const list = Array.isArray(parsed) ? parsed : [parsed]
    const items = list
      .map((entry: Record<string, string>) => ({
        email: entry.email,
        password: entry.password,
        refreshToken: entry.refreshToken || entry.refresh_token || '',
        clientId: entry.clientId || entry.client_id,
        clientSecret: entry.clientSecret || entry.client_secret,
        region: entry.region,
        provider: entry.provider || entry.idp,
        nickname: entry.nickname
      }))
      .filter((item) => !!item.refreshToken)
    return { items }
  } catch {
    // 非 JSON：CSV / 卡密 / TXT
    return { items: text.includes(',') && !text.includes('----') ? parseCsv(text) : parseKamiLines(text) }
  }
}

// ============ 导出 ============

export function buildExportContent(
  format: ExportFormat,
  accounts: Account[],
  options: { includeCredentials: boolean; appVersion: string }
): string {
  const { includeCredentials, appVersion } = options

  switch (format) {
    case 'json': {
      const data: AccountExportData = {
        app: 'kiro-account-lite',
        version: appVersion,
        exportedAt: Date.now(),
        accounts: accounts.map(({ isActive: _isActive, ...rest }) =>
          includeCredentials
            ? rest
            : { ...rest, password: undefined, credentials: { ...rest.credentials, accessToken: '', refreshToken: '' } }
        )
      }
      return JSON.stringify(data, null, 2)
    }

    case 'oidc':
      // 精简 JSON，可直接粘回批量导入框
      return JSON.stringify(
        accounts.map((a) => {
          const item: Record<string, string> = {
            email: a.email,
            refreshToken: a.credentials.refreshToken || '',
            provider: a.idp || 'BuilderId'
          }
          if (a.password) item.password = a.password
          if (a.credentials.clientId) item.clientId = a.credentials.clientId
          if (a.credentials.clientSecret) item.clientSecret = a.credentials.clientSecret
          return item
        }),
        null,
        2
      )

    case 'kami':
      // 邮箱----密码----RefreshToken----ClientId----ClientSecret----登录方式
      return accounts
        .map((a) =>
          [
            a.email,
            a.password || 'no_password',
            a.credentials.refreshToken || '',
            a.credentials.clientId || '',
            a.credentials.clientSecret || '',
            a.idp || 'BuilderId'
          ].join('----')
        )
        .join('\n')

    case 'csv': {
      const headers = includeCredentials
        ? ['邮箱', '昵称', '登录方式', 'refreshToken', 'clientId', 'clientSecret', 'region']
        : ['邮箱', '昵称', '登录方式', '订阅', '已用积分', '总积分', '状态']
      const rows = accounts.map((a) =>
        includeCredentials
          ? [
              a.email,
              a.nickname || '',
              a.idp,
              a.credentials.refreshToken || '',
              a.credentials.clientId || '',
              a.credentials.clientSecret || '',
              a.credentials.region || DEFAULT_REGION
            ]
          : [
              a.email,
              a.nickname || '',
              a.idp,
              a.subscription.title || a.subscription.type,
              String(a.usage.current ?? ''),
              String(a.usage.limit ?? ''),
              a.status
            ]
      )
      // BOM 让 Excel 正确识别 UTF-8
      return (
        '\ufeff' +
        [headers, ...rows]
          .map((row) => row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(','))
          .join('\n')
      )
    }

    case 'txt':
      if (includeCredentials) {
        return accounts
          .map((a) => [a.email, a.credentials.refreshToken || '', a.nickname || '', a.idp].join(','))
          .join('\n')
      }
      return accounts
        .map((a) =>
          [
            `邮箱: ${a.email}`,
            a.nickname ? `昵称: ${a.nickname}` : null,
            `登录方式: ${a.idp}`,
            `订阅: ${a.subscription.title || a.subscription.type}`,
            `积分: ${a.usage.current ?? 0} / ${a.usage.limit ?? 0}`,
            `状态: ${a.status}`
          ]
            .filter(Boolean)
            .join('\n')
        )
        .join('\n\n---\n\n')

    // 已覆盖 ExportFormat 的全部取值，无需 default 兜底
    case 'clipboard':
      // 邮箱,RefreshToken —— 最短的可回导格式，方便直接粘贴
      if (includeCredentials) {
        return accounts.map((a) => `${a.email},${a.credentials.refreshToken || ''}`).join('\n')
      }
      return accounts
        .map(
          (a) =>
            `${a.email}${a.nickname ? ` (${a.nickname})` : ''} - ${a.subscription.title || a.subscription.type}`
        )
        .join('\n')
  }
}

export const EXPORT_EXTENSION: Record<ExportFormat, string> = {
  json: 'json',
  oidc: 'json',
  kami: 'txt',
  csv: 'csv',
  txt: 'txt',
  clipboard: 'txt'
}
