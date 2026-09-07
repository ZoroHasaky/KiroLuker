import { contextBridge, ipcRenderer } from 'electron'
import type { BrowserChromeCommand, BrowserChromeState } from '../shared/browser'

// This is the ONLY preload used by the local browser toolbar. External tabs have no preload.
contextBridge.exposeInMainWorld('browserChrome', {
  getState: (): Promise<BrowserChromeState> => ipcRenderer.invoke('browser-chrome:state'),
  command: (command: BrowserChromeCommand) => ipcRenderer.invoke('browser-chrome:command', command),
  onFocusAddress: (callback: () => void) => {
    const listener = (): void => callback()
    ipcRenderer.on('browser-chrome:focus-address', listener)
    return () => ipcRenderer.removeListener('browser-chrome:focus-address', listener)
  },
  onState: (callback: (state: BrowserChromeState) => void) => {
    const listener = (_event: unknown, state: BrowserChromeState): void => callback(state)
    ipcRenderer.on('browser-chrome:changed', listener)
    return () => ipcRenderer.removeListener('browser-chrome:changed', listener)
  }
})
