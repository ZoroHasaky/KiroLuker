import type {
  Account,
  AccountSnapshot,
  AccountStoreData,
  AccountUsage,
  AppInfo,
  AppSettings,
  AuthMethod,
  BrowserOpenInfo,
  BuilderIdStartInfo,
  ChatTestChunk,
  ChatTestInput,
  ChatTestResult,
  IpcResult,
  KiroModelInfo,
  LocalKiroCredentials,
  LoginPollResult,
  OnlineLoginCredentials,
  RefreshTokenResult,
  RestartIdeResult,
  SocialCallbackPayload,
  SwitchAccountInput,
  SwitchAccountResult,
  TrayAction,
  TraySnapshot,
  UsageHistoryEntry,
  VerifyCredentialsInput
} from '../shared/types'

export interface KiroActiveToken {
  refreshToken: string
  accessToken: string
  expiresAt: string
  authMethod?: string
  provider?: string
}

export interface ImportedFile {
  content: string
  format: string
  path: string
}

export interface Api {
  md5: (text: string) => string

  loadAccounts: () => Promise<IpcResult<AccountStoreData>>
  saveAccounts: (data: AccountStoreData) => Promise<IpcResult>

  verifyCredentials: (input: VerifyCredentialsInput) => Promise<IpcResult<AccountSnapshot>>
  refreshAccountToken: (account: Account) => Promise<IpcResult<RefreshTokenResult>>
  checkAccountStatus: (
    account: Account
  ) => Promise<IpcResult<AccountSnapshot> & { banned?: boolean }>

  readLocalKiroCredentials: () => Promise<IpcResult<LocalKiroCredentials>>
  getActiveKiroToken: () => Promise<IpcResult<KiroActiveToken>>
  switchAccount: (input: SwitchAccountInput) => Promise<IpcResult<SwitchAccountResult>>
  isKiroIdeRunning: () => Promise<IpcResult<{ running: boolean }>>
  restartKiroIde: () => Promise<IpcResult<RestartIdeResult>>
  logoutKiro: () => Promise<IpcResult<{ deleted: number }>>

  getUsageHistory: (accountId: string) => Promise<IpcResult<UsageHistoryEntry[]>>
  recordUsagePoint: (
    accountId: string,
    usage: AccountUsage
  ) => Promise<IpcResult<{ recorded: boolean }>>
  clearUsageHistory: (accountId: string) => Promise<IpcResult<{ cleared: number }>>

  listKiroModels: (input: {
    accessToken: string
    profileArn?: string
    region?: string
    idp?: string
    authMethod?: AuthMethod
  }) => Promise<IpcResult<KiroModelInfo[]>>
  chatTest: (requestId: string, input: ChatTestInput) => Promise<IpcResult<ChatTestResult>>
  cancelChatTest: (requestId: string) => Promise<IpcResult>
  onChatChunk: (handler: (payload: ChatTestChunk) => void) => () => void

  startBuilderIdLogin: (
    region?: string,
    privateMode?: boolean
  ) => Promise<IpcResult<BuilderIdStartInfo>>
  pollBuilderIdLogin: () => Promise<IpcResult<LoginPollResult>>
  startSocialLogin: (
    provider: 'Google' | 'Github',
    privateMode?: boolean
  ) => Promise<IpcResult<BrowserOpenInfo & { loginUrl: string }>>
  completeSocialLogin: (
    code: string,
    state: string
  ) => Promise<IpcResult<OnlineLoginCredentials>>
  startEnterpriseLogin: (
    startUrl: string,
    region?: string,
    privateMode?: boolean
  ) => Promise<IpcResult<BrowserOpenInfo & { authorizeUrl: string; expiresIn: number }>>
  pollEnterpriseLogin: () => Promise<IpcResult<LoginPollResult>>
  cancelLogin: () => Promise<IpcResult>
  onSocialCallback: (handler: (payload: SocialCallbackPayload) => void) => () => void

  exportToFile: (
    content: string,
    filename: string
  ) => Promise<IpcResult<{ saved: boolean; path?: string }>>
  importFromFile: () => Promise<IpcResult<ImportedFile | null>>
  writeClipboard: (text: string) => void

  getSettings: () => Promise<IpcResult<AppSettings>>
  saveSettings: (patch: Partial<AppSettings>) => Promise<IpcResult<AppSettings>>
  getAppInfo: () => Promise<IpcResult<AppInfo>>
  openExternal: (url: string, privateMode?: boolean) => Promise<IpcResult<BrowserOpenInfo>>
  showPath: (target: 'store' | 'backup') => Promise<IpcResult>

  syncTray: (snapshot: TraySnapshot) => Promise<IpcResult>
  onTrayAction: (handler: (action: TrayAction) => void) => () => void
  onAppNavigate: (handler: (target: string) => void) => () => void

  quitApp: () => Promise<IpcResult>
  onConfirmQuit: (handler: () => void) => () => void
}

declare global {
  interface Window {
    api: Api
  }
}
