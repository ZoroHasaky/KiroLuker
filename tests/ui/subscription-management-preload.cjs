const { contextBridge, ipcRenderer } = require('electron')
const api = {}
for (const name of ['getSettings', 'getAppInfo', 'loadAccounts', 'getActiveKiroToken', 'syncTray',
  'getUpdateState', 'checkUpdate', 'saveAccounts', 'refreshAccountToken', 'deleteAccounts',
  'checkSubscriptionRenewal', 'switchSubscriptionToFree', 'getSubscriptionPlans', 'createSubscriptionLink']) {
  api[name] = (...args) => ipcRenderer.invoke('subscription-ui-fixture', name, args)
}
for (const name of ['onAccountsChanged', 'onAppNavigate', 'onBrowserWindowsChanged', 'onLogAppended',
  'onState', 'onTrayAction', 'onUpdateState']) {
  api[name] = () => () => {}
}
contextBridge.exposeInMainWorld('api', api)
