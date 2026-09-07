const { contextBridge, ipcRenderer } = require('electron')
const subscribe = (channel, callback) => {
  const listener = (_event, value) => callback(value)
  ipcRenderer.on(channel, listener)
  return () => { ipcRenderer.removeListener(channel, listener); ipcRenderer.send('fixture-unsubscribe', channel) }
}
if (process.argv.includes('--fixture-chrome')) {
  contextBridge.exposeInMainWorld('browserChrome', {
    getState: () => ipcRenderer.invoke('fixture-chrome-state'),
    command: (command) => ipcRenderer.invoke('fixture-chrome-command', command),
    onState: (callback) => subscribe('fixture-chrome-push', callback),
    onFocusAddress: (callback) => subscribe('fixture-focus-address', callback)
  })
} else {
  const api = { md5: () => '0123456789abcdef0123456789abcdef', onBrowserWindowsChanged: (callback) => subscribe('fixture-windows', callback) }
  for (const name of ['onAppNavigate', 'onConfirmQuit', 'onProactiveRenewal', 'onTrayAction', 'onUpdateState']) api[name] = () => () => {}
  for (const method of ['getSettings', 'saveSettings', 'getAppInfo', 'loadAccounts', 'getActiveKiroToken', 'syncTray', 'getUpdateState', 'checkUpdate', 'getBrowserConfig', 'saveBrowserConfig', 'checkBrowserProxy', 'getBrowserWindows', 'openBrowserWindow', 'focusBrowserWindow', 'closeBrowserWindow']) {
    api[method] = (...args) => ipcRenderer.invoke('fixture-browser-api', method, args)
  }
  contextBridge.exposeInMainWorld('api', api)
}