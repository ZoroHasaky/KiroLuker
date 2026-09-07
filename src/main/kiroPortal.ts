// Existing account-portal API now opens an isolated window in the browser module.
import { session } from 'electron'
import { browserManager } from './browserManager'
import { getPortalAcceptLanguage, KIRO_PORTAL_ORIGIN, setPortalLocale } from './kiroPortalSession'
import type { Account } from '../shared/types'

/** Global portal locale still serves backend portal operations; open windows keep their own snapshot. */
export function setInAppLocale(locale?: string): void {
  setPortalLocale(locale)
  session.defaultSession.setUserAgent(session.defaultSession.getUserAgent(), getPortalAcceptLanguage())
}

export async function openAccountPortal(account: Account): Promise<{ url: string }> {
  if (!account || typeof account.id !== 'string' || !account.id) throw new Error('请选择有效账号')
  await browserManager.open({ accountId: account.id })
  return { url: KIRO_PORTAL_ORIGIN }
}
