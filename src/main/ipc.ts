import { BrowserWindow, dialog, ipcMain, shell, app, type IpcMainInvokeEvent } from 'electron'
import { readFile, writeFile } from 'fs/promises'
import {
  checkAccountStatus,
  forgetSwitchedAccounts,
  refreshAccountToken,
  setLastSwitchedAccountId,
  syncCredentialsToIde,
  verifyCredentials
} from './accountService'
import { createAccountApiKey, deleteAccountApiKey, listAccountApiKeys } from './kiroApiKey'
import { openAccountPortal } from './kiroPortal'
import { registerBrowserIpc, requireBrowserManagerSender } from './browserIpc'
import { createSubscriptionLink, getSubscriptionPlans } from './subscriptionService'
import { checkSubscriptionRenewal, switchSubscriptionToFree } from './stripePortalService'
import { clearKiroSsoCache, readKiroAuthToken, readLocalKiroCredentials } from './kiroAuth'
import { isKiroRunning, restartKiroIde } from './kiroProcess'
import { listKiroModels, streamKiroChat } from './kiroChat'
import {
  cancelLogin,
  completeSocialLogin,
  pollBuilderIdLogin,
  pollEnterpriseLogin,
  startBuilderIdLogin,
  startEnterpriseLogin,
  startSocialLogin
} from './onlineLogin'
import {
  inspectPrivateBrowserPath,
  isHttpUrl,
  openUrl,
  type BrowserOpenOptions
} from './browser'
import { setTraySnapshot, setTrayEnabled } from './tray'
import {
  clearProactiveRenewal,
  scheduleForActiveAccount,
  scheduleProactiveRenewal
} from './proactiveRenewal'
import { setUsageApiType } from './kiroApi'
import { setInAppLocale } from './kiroPortal'
import { setProxyConfig } from './net'
import {
  applyDownloadedUpdate,
  cancelUpdateDownload,
  checkForUpdate,
  configureUpdaterProxy,
  downloadAvailableUpdate,
  getUpdateState,
  initializeUpdater
} from './updater'
import { clearLogs, exportLogs, getLogDir, queryLogs } from './logger'
import { buildXlsx } from './xlsxWriter'
import { billingService } from './applicationServices'
import { accountApplicationService } from './accountApplicationSingleton'
import { webControlManager } from './webControlManager'
import { resolveRuntimePaths } from './runtimePaths'
import { errorMessage } from '../shared/errors'
import { sendToRenderer } from './utils'
import {
  deleteAccountData,
  getAccountData,
  getBackupDir,
  getBillingConfig,
  getSettings,
  getStorePath,
  setAccountData,
  setBillingConfig,
  setSettings
} from './store'
import {
  appendUsagePoint,
  clearUsageHistory,
  getUsageHistory,
  pruneUsageHistory
} from './usageHistory'
import { DEFAULT_REGION } from '../shared/regions'
import type {
  BillingConfigPatch,
  BillingSecretName,
  BillingSecretPatch
} from '../shared/billing'
import type {
  Account,
  AccountStoreData,
  AccountUsage,
  AppSettings,
  ChatTestInput,
  IpcResult,
  LogQuery,
  TraySnapshot,
  VerifyCredentialsInput,
  XlsxSheet
} from '../shared/types'

function ok<T>(data?: T): IpcResult<T> {
  return { success: true, data }
}

function fail(error: unknown): IpcResult<never> {
  return { success: false, error: errorMessage(error) }
}

/**
 * 注册 IPC 通道：统一把未捕获异常收敛成 { success: false, error }，
 * 各 handler 只负责返回结果，不再逐个写 try/catch。
 */
function handle(
  channel: string,
  handler: (event: IpcMainInvokeEvent, ...args: never[]) => unknown
): void {
  ipcMain.handle(channel, async (event, ...args) => {
    try {
      return await handler(event, ...(args as never[]))
    } catch (e) {
      return fail(e)
    }
  })
}

/** 把设置里与主进程相关的部分同步下去 */
export function applyRuntimeSettings(settings: AppSettings): void {
  setUsageApiType(settings.usageApiType)
  setProxyConfig(settings.proxyEnabled, settings.proxyUrl)
  void configureUpdaterProxy()
  setInAppLocale(settings.portalLocale)
}

export function registerIpc(
  getWindow: () => BrowserWindow | null,
  prepareToInstallUpdate: () => void = () => undefined
): void {
  initializeUpdater(
    (state) => sendToRenderer(getWindow(), 'app:update-state', state),
    prepareToInstallUpdate
  )
  registerBrowserIpc(getWindow)
  // 所有主进程/Web/API 写入完成后通知桌面缓存重新对齐，避免延迟保存旧快照。
  if (typeof accountApplicationService?.onChanged === 'function') {
    accountApplicationService.onChanged(({ data }) => sendToRenderer(getWindow(), 'accounts:changed', data))
  }
  // ============ 数据持久化 ============
  handle('accounts:load', () => ok(accountApplicationService.getData()))

  // 桌面 Store 传入“上次服务端快照 + 当前本地快照”；主进程仅合并实际 diff，
  // 绝不再让陈旧的整份 renderer snapshot 覆盖 Web/API 的新修改。
  handle('accounts:save', async (_e, base: AccountStoreData, next?: AccountStoreData) => {
    const merged = await accountApplicationService.reconcileDesktopSnapshot(
      next ? base : accountApplicationService.getData(),
      next ?? base
    )
    return ok(merged)
  })

  handle('accounts:delete', async (_e, ids: string[]) => {
    const result = await accountApplicationService.deleteAccounts(Array.isArray(ids) ? ids : [])
    if (result.removed) {
      forgetSwitchedAccounts(ids)
      scheduleForActiveAccount()
    }
    return ok({ accounts: result.data, removed: result.removed })
  })
  // ============ 积分变化日志 ============
  handle('usage:history', (_e, accountId: string) => ok(getUsageHistory(accountId)))

  handle('usage:record', (_e, accountId: string, usage: AccountUsage) =>
    ok({ recorded: appendUsagePoint(accountId, usage) })
  )

  handle('usage:clear-history', (_e, accountId: string) =>
    ok({ cleared: clearUsageHistory(accountId) })
  )

  // ============ 账号操作 ============
  handle('accounts:verify', async (_e, input: VerifyCredentialsInput) =>
    ok(await verifyCredentials(input))
  )

  handle('accounts:refresh-token', async (_e, account: Account) => {
    const { applied: _applied, ...result } = await accountApplicationService.refreshToken(account.id)
    // 刷新的正是 IDE 当前激活账号时，基于新 expiresAt 重排主动续期
    if (result.syncedToIde) scheduleProactiveRenewal(account.id, Date.now() + result.expiresIn * 1000)
    return ok(result)
  })
  handle('accounts:create-api-key', async (_e, account: Account, label: string) => {
    const result = await createAccountApiKey(account, label)
    // 生成过程中若刷新过凭证，按新的到期时间重排主动续期
    if (result.refreshed?.syncedToIde) {
      scheduleProactiveRenewal(account.id, Date.now() + result.refreshed.expiresIn * 1000)
    }
    return ok(result)
  })

  handle('accounts:open-portal', async (event, account: Account) => {
    requireBrowserManagerSender(event, getWindow())
    return ok(await openAccountPortal(account))
  })

  handle('accounts:subscription-renewal', async (_e, account: Account) =>
    ok(await checkSubscriptionRenewal(account))
  )

  handle('accounts:subscription-free', async (_e, account: Account) =>
    ok(await switchSubscriptionToFree(account))
  )

  handle('accounts:subscription-plans', async (_e, account: Account) =>
    ok(await getSubscriptionPlans(account))
  )

  handle(
    'accounts:subscription-link',
    async (_e, account: Account, subscriptionType: string) =>
      ok(await createSubscriptionLink(account, subscriptionType))
  )

  handle('accounts:list-api-keys', async (_e, account: Account) => {
    const result = await listAccountApiKeys(account)
    if (result.refreshed?.syncedToIde) {
      scheduleProactiveRenewal(account.id, Date.now() + result.refreshed.expiresIn * 1000)
    }
    return ok(result)
  })

  handle('accounts:delete-api-key', async (_e, account: Account, keyId: string) => {
    const result = await deleteAccountApiKey(account, keyId)
    if (result.refreshed?.syncedToIde) {
      scheduleProactiveRenewal(account.id, Date.now() + result.refreshed.expiresIn * 1000)
    }
    return ok(result)
  })

  // 封禁需要额外回传 banned 标记，单独注册以保留该字段
  ipcMain.handle('accounts:check-status', async (_e, account: Account) => {
    try {
      const { snapshot } = await accountApplicationService.refreshUsage(account.id)
      const { accessToken, refreshToken } = snapshot
      if (accessToken && refreshToken && refreshToken !== account.credentials.refreshToken) {
        const expiresIn = snapshot.expiresIn ?? 3600
        const { syncedToIde } = await syncCredentialsToIde(
          account,
          { accessToken, refreshToken, expiresIn },
          account.credentials.refreshToken
        )
        if (syncedToIde) scheduleProactiveRenewal(account.id, Date.now() + expiresIn * 1000)
      }
      return ok(snapshot)
    } catch (e) {
      const banned = (e as { isBanned?: boolean }).isBanned === true
      return { ...fail(e), banned }
    }
  })
  // ============ Kiro IDE 交互 ============
  handle('kiro:read-local-credentials', async () => {
    const result = await readLocalKiroCredentials()
    if ('error' in result) return fail(result.error)
    return ok(result)
  })

  handle('kiro:get-active-token', async () => {
    const token = await readKiroAuthToken()
    if (!token) return fail('本地没有 Kiro 登录状态')
    return ok({
      refreshToken: token.refreshToken,
      accessToken: token.accessToken,
      expiresAt: token.expiresAt,
      authMethod: token.authMethod,
      provider: token.provider
    })
  })

  handle('kiro:logout', async () => {
    setLastSwitchedAccountId(null)
    clearProactiveRenewal('logout ide')
    return ok({ deleted: await clearKiroSsoCache() })
  })

  handle('kiro:ide-running', async () => ok({ running: await isKiroRunning() }))

  handle('kiro:restart-ide', async () => ok(await restartKiroIde()))

  // ============ 账号测活（真实对话）============

  handle('kiro:list-models', async (_e, input: Parameters<typeof listKiroModels>[0]) =>
    ok(await listKiroModels(input))
  )

  // 一个账号测活请求对应一个 AbortController。
  const accountChatAborters = new Map<string, AbortController>()

  handle('kiro:chat-test', async (event, requestId: string, input: ChatTestInput) => {
    const controller = new AbortController()
    accountChatAborters.set(requestId, controller)
    try {
      const result = await streamKiroChat(
        input,
        {
          onDelta: (delta) => {
            // 渲染进程可能已经关闭弹窗，发送前确认还活着
            if (!event.sender.isDestroyed()) {
              event.sender.send('kiro:chat-chunk', { requestId, delta })
            }
          }
        },
        controller.signal
      )
      return ok(result)
    } finally {
      if (accountChatAborters.get(requestId) === controller) accountChatAborters.delete(requestId)
    }
  })

  handle('kiro:chat-cancel', (_e, requestId: string) => {
    accountChatAborters.get(requestId)?.abort(new Error('用户取消'))
    return ok()
  })

  // ============ 在线登录 ============
  handle('login:start-builder-id', async (_e, region?: string, browserOptions?: BrowserOpenOptions) =>
    ok(await startBuilderIdLogin(region || DEFAULT_REGION, browserOptions))
  )

  handle('login:poll-builder-id', async () => ok(await pollBuilderIdLogin()))

  handle('login:start-social', async (_e, provider: 'Google' | 'Github', browserOptions?: BrowserOpenOptions) =>
    ok(await startSocialLogin(provider, browserOptions))
  )

  handle('login:complete-social', async (_e, code: string, state: string) =>
    ok(await completeSocialLogin(code, state))
  )

  handle(
    'login:start-enterprise',
    async (_e, startUrl: string, region?: string, browserOptions?: BrowserOpenOptions) =>
      ok(await startEnterpriseLogin(startUrl, region || DEFAULT_REGION, browserOptions))
  )

  handle('login:poll-enterprise', async () => ok(await pollEnterpriseLogin()))

  handle('login:cancel', () => {
    cancelLogin()
    return ok()
  })

  // ============ 文件导入导出 ============
  /** 保存对话框的类型筛选：与文件名扩展名一致的那一项排在最前 */
  function exportFilters(filename: string): { name: string; extensions: string[] }[] {
    const known = [
      { name: 'JSON', extensions: ['json'] },
      { name: '日志', extensions: ['log'] },
      { name: '文本', extensions: ['txt'] },
      { name: 'CSV', extensions: ['csv'] },
      { name: 'Excel 工作簿', extensions: ['xlsx'] }
    ]
    const ext = filename.split('.').pop()?.toLowerCase() ?? ''
    const matched = known.filter((f) => f.extensions.includes(ext))
    const rest = known.filter((f) => !f.extensions.includes(ext))
    return [...matched, ...rest, { name: '全部文件', extensions: ['*'] }]
  }

  /**
   * 落盘后在文件管理器里定位该文件，由设置项「导出后」控制。
   *
   * 导出的多是凭证类文件，用户下一步基本都要去拿它，省掉自己翻目录这一步。
   * 用 showItemInFolder 而不是 openPath：后者会直接用默认程序打开文件内容，
   * 凭证文件被自动弹开并不是我们想要的效果。
   *
   * 每次现读设置而不是缓存：这个开关随时可改，且导出本身是低频操作，
   * 读一次 store 的开销可以忽略。
   */
  function revealExported(filePath: string): void {
    if (!getSettings().revealExportedFile) return
    // 定位失败不该让导出本身算失败，文件已经写成功了
    try {
      shell.showItemInFolder(filePath)
    } catch {
      /* ignore */
    }
  }

  handle('file:export', async (_e, content: string, filename: string) => {
    const result = await dialog.showSaveDialog(getWindow()!, {
      title: filename.endsWith('.log') ? '导出日志' : '导出账号数据',
      defaultPath: filename,
      // 匹配文件名扩展名的类型必须排在首位，否则 macOS 会按第一项再追加一次扩展名
      filters: exportFilters(filename)
    })
    if (result.canceled || !result.filePath) return ok({ saved: false })
    await writeFile(result.filePath, content, 'utf-8')
    revealExported(result.filePath)
    return ok({ saved: true, path: result.filePath })
  })

  // xlsx 是二进制 zip，走不了上面的 utf-8 通道；渲染层只传结构化数据，落盘前在主进程组装
  handle('file:export-xlsx', async (_e, sheet: XlsxSheet, filename: string) => {
    const result = await dialog.showSaveDialog(getWindow()!, {
      title: '导出表格',
      defaultPath: filename,
      filters: exportFilters(filename)
    })
    if (result.canceled || !result.filePath) return ok({ saved: false })
    await writeFile(result.filePath, buildXlsx(sheet))
    revealExported(result.filePath)
    return ok({ saved: true, path: result.filePath })
  })

  handle('file:import', async () => {
    const result = await dialog.showOpenDialog(getWindow()!, {
      title: '导入账号数据',
      properties: ['openFile'],
      filters: [
        { name: '支持的格式', extensions: ['json', 'txt', 'csv'] },
        { name: '全部文件', extensions: ['*'] }
      ]
    })
    if (result.canceled || result.filePaths.length === 0) return ok(null)
    const filePath = result.filePaths[0]
    const content = await readFile(filePath, 'utf-8')
    return ok({ content, format: filePath.split('.').pop()?.toLowerCase() || 'json', path: filePath })
  })

  // ============ 设置 ============
  handle('settings:get', () => {
    const settings = getSettings()
    applyRuntimeSettings(settings)
    return ok(settings)
  })

  handle('settings:save', (_e, patch: Partial<AppSettings>) => {
    const merged = setSettings(patch)
    applyRuntimeSettings(merged)
    // 托盘开关变化时动态启用 / 关闭托盘图标
    if (patch.trayEnabled !== undefined) setTrayEnabled(patch.trayEnabled)
    // 主动续期开关变化时立即生效：开启则按当前激活账号调度，关闭则清除
    if (patch.proactiveRenewalEnabled !== undefined) {
      if (patch.proactiveRenewalEnabled) scheduleForActiveAccount()
      else clearProactiveRenewal('disabled by user')
    }
    return ok(merged)
  })

  // ============ 账单信息 ============
  handle('billing:get-config', () => ok(billingService.getConfig()))
  handle('billing:save-config', (_e, patch: BillingConfigPatch) =>
    ok(billingService.saveConfig(patch))
  )
  handle('billing:replace-secrets', (_e, patch: BillingSecretPatch) =>
    ok(billingService.replaceSecrets(patch))
  )
  handle('billing:clear-secrets', (_e, names: BillingSecretName[]) =>
    ok(billingService.clearSecrets(Array.isArray(names) ? names : []))
  )
  handle('billing:clear-config', () => ok(billingService.clearConfig()))
  handle('billing:generate', async () => ok(await billingService.generate()))

  // ============ Web 控制面板 ============
  const webDir = () => resolveRuntimePaths(app.getAppPath()).web
  handle('web-control:get-config', () => ok(webControlManager.getConfig()))
  handle('web-control:save-settings', async (_e, patch) =>
    ok(await webControlManager.saveSettings(patch, webDir()))
  )
  handle('web-control:set-password', async (_e, password: string) => {
    if (typeof password !== 'string') throw new Error('管理员密码必须是字符串')
    return ok(await webControlManager.setAdminPassword(password, webDir()))
  })
  handle('web-control:start', async () => ok(await webControlManager.start(webDir())))
  handle('web-control:stop', async () => {
    await webControlManager.stop()
    return ok(webControlManager.getConfig())
  })

  // ============ 应用 ============
  handle('app:info', () =>
    ok({
      version: app.getVersion(),
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
      platform: process.platform,
      storePath: getStorePath(),
      backupDir: getBackupDir()
    })
  )

  // 检查更新：对比 GitHub 最新 Release 的版本号，只给结论不做下载
  handle('app:check-update', async () => ok(await checkForUpdate()))
  handle('app:update-state', () => ok(getUpdateState()))
  handle('app:update-download', async () => ok(await downloadAvailableUpdate()))
  handle('app:update-cancel', () => ok(cancelUpdateDownload()))
  handle('app:update-apply', () => ok(applyDownloadedUpdate()))

  handle('app:open-external', async (_e, url: string, browserOptions?: BrowserOpenOptions) => {
    // 只放行 http(s)，避免被诱导打开本地程序或自定义协议
    if (!isHttpUrl(url)) return fail(new Error('仅支持 http/https 链接'))
    return ok(await openUrl(url, browserOptions))
  })

  handle('app:choose-private-browser', async () => {
    const result = await dialog.showOpenDialog(getWindow()!, {
      title: '选择用于无痕登录的浏览器',
      properties: ['openFile'],
      filters: process.platform === 'win32'
        ? [
            { name: '支持的浏览器', extensions: ['exe'] },
            { name: '全部文件', extensions: ['*'] }
          ]
        : [{ name: '全部文件', extensions: ['*'] }]
    })
    if (result.canceled || !result.filePaths[0]) return ok({ selected: false })
    const selection = inspectPrivateBrowserPath(result.filePaths[0])
    if (!selection) {
      return fail(new Error('请选择 Chrome、Edge、Brave、Chromium 或 Firefox 的可执行文件'))
    }
    return ok({ selected: true, ...selection })
  })

  handle('tray:sync', (_e, data: TraySnapshot) => {
    setTraySnapshot(data)
    return ok()
  })

  handle('app:show-path', (_e, target: 'store' | 'backup' | 'logs') => {
    const paths = { store: app.getPath('userData'), backup: getBackupDir(), logs: getLogDir() }
    shell.openPath(paths[target] ?? paths.store)
    return ok()
  })

  // ============ 系统日志 ============
  handle('log:query', (_e, query: LogQuery) => ok(queryLogs(query)))

  handle('log:clear', async () => {
    await clearLogs()
    return ok()
  })

  /** 导出当前筛选结果的纯文本，由渲染层再决定存文件还是复制 */
  handle('log:export', (_e, query: LogQuery) => ok({ content: exportLogs(query) }))

  // 渲染进程确认退出后真正退出。before-quit 会先置位退出标记，
  // 所以窗口 close 监听里的「最小化到托盘」不会把这次退出拦下来
  handle('app:quit', () => {
    app.quit()
    return ok()
  })
}
