import { ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import { browserManager } from './browserManager'
import { getBrowserConfig, saveBrowserConfig } from './browserConfig'
import type { BrowserChromeCommand, BrowserConfigPatch, BrowserOpenRequest } from '../shared/browser'

export function requireBrowserManagerSender(event: IpcMainInvokeEvent, mainWindow: BrowserWindow | null): void {
  if (!mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents || event.senderFrame !== mainWindow.webContents.mainFrame) {
    throw new Error('无权访问浏览器管理功能')
  }
}

export function registerBrowserIpc(getMainWindow: () => BrowserWindow | null): void {
  const handle = (channel: string, run: (...args: never[]) => unknown): void => {
    ipcMain.handle(channel, async (event, ...args) => {
      try {
        requireBrowserManagerSender(event, getMainWindow())
        return { success: true, data: await run(...(args as never[])) }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : '浏览器操作失败' }
      }
    })
  }
  handle('browser:config', () => getBrowserConfig())
  handle('browser:save-config', (patch: BrowserConfigPatch) => saveBrowserConfig(patch))
  handle('browser:check-proxy', () => browserManager.checkProxy())
  handle('browser:windows', () => browserManager.list())
  handle('browser:open', (request: BrowserOpenRequest) => browserManager.open(request))
  handle('browser:focus', (id: string) => browserManager.focus(id))
  handle('browser:close', (id: string) => browserManager.close(id))
  browserManager.onChanged((windows) => {
    const main = getMainWindow()
    if (main && !main.isDestroyed()) main.webContents.send('browser:windows-changed', windows)
  })
  ipcMain.handle('browser-chrome:state', (event) => browserManager.state(browserManager.chromeOwner(event)))
  ipcMain.handle('browser-chrome:command', async (event, command: BrowserChromeCommand) => {
    try {
      await browserManager.command(browserManager.chromeOwner(event), command)
      return { success: true }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : '浏览器操作失败' }
    }
  })
}
