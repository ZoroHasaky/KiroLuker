const { contextBridge, ipcRenderer } = require('electron')
const api = {}
for (const name of ['getSettings', 'getAppInfo', 'loadAccounts', 'getActiveKiroToken', 'syncTray',
  'getUpdateState', 'checkUpdate', 'saveAccounts', 'refreshAccountToken',
  'checkSubscriptionRenewal', 'switchSubscriptionToFree']) {
  api[name] = (...args) => ipcRenderer.invoke('subscription-ui-fixture', name, args)
}
for (const name of ['onAppNavigate', 'onConfirmQuit', 'onProactiveRenewal', 'onTrayAction', 'onUpdateState']) {
  api[name] = () => () => {}
}
contextBridge.exposeInMainWorld('api', api)
