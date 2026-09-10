import { BROWSER_CHROME_HEIGHT } from '../../../shared/browser'
import type { BrowserChromeCommand, BrowserChromeState, BrowserTabState } from '../../../shared/browser'
import './style.css'

interface BrowserChromeApi {
  getState(): Promise<BrowserChromeState>
  command(command: BrowserChromeCommand): Promise<{ success: boolean; error?: string }>
  onState(callback: (state: BrowserChromeState) => void): () => void
  onFocusAddress(callback: () => void): () => void
}

// This standalone renderer intentionally knows nothing about window.api or account credentials.
const api = (window as unknown as { browserChrome?: BrowserChromeApi }).browserChrome
const tabsElement = document.querySelector<HTMLDivElement>('#tabs')!
const addressForm = document.querySelector<HTMLFormElement>('#address-form')!
const address = document.querySelector<HTMLInputElement>('#address')!
const newTabButton = document.querySelector<HTMLButtonElement>('#new-tab')!
const backButton = document.querySelector<HTMLButtonElement>('#back')!
const forwardButton = document.querySelector<HTMLButtonElement>('#forward')!
const reloadButton = document.querySelector<HTMLButtonElement>('#reload')!
const goButton = document.querySelector<HTMLButtonElement>('#go')!
const btnLoginKiro = document.querySelector<HTMLButtonElement>('#btn-login-kiro')!
const btnAddAccount = document.querySelector<HTMLButtonElement>('#btn-add-account')!
const proxyStatus = document.querySelector<HTMLSpanElement>('#proxy-status')!
const statusElement = document.querySelector<HTMLSpanElement>('#status')!
document.documentElement.style.setProperty('--chrome-height', `${BROWSER_CHROME_HEIGHT}px`)

let state: BrowserChromeState | undefined
let commandError = ''
let commandRevision = 0
let receivedState = false
let disposed = false
let offState: (() => void) | undefined
let offFocusAddress: (() => void) | undefined
const tabElements = new Map<string, { root: HTMLDivElement; select: HTMLButtonElement; close: HTMLButtonElement }>()

function activeTab(): BrowserTabState | undefined {
  return state?.tabs.find((tab) => tab.id === state?.activeTabId)
}

function syncAddress(): void {
  // Even redirect/loading pushes must not overwrite text the user is editing.
  if (document.activeElement !== address) address.value = activeTab()?.url || ''
}

function focusAddress(): void {
  if (disposed || address.disabled) return
  address.focus()
  address.select()
}

function renderStatus(): void {
  const tab = activeTab()
  const error = commandError || tab?.error
  const text = error || (tab?.loading ? '正在加载…' : tab?.url && tab.url !== 'about:blank' ? '就绪' : '输入网址开始浏览')
  statusElement.textContent = text
  statusElement.title = text
  statusElement.classList.toggle('error', Boolean(error))
}

async function send(command: BrowserChromeCommand): Promise<void> {
  if (!api || disposed) return
  const revision = ++commandRevision
  commandError = ''
  renderStatus()
  try {
    const result = await api.command(command)
    if (disposed || revision !== commandRevision) return
    if (!result.success) commandError = result.error || '操作失败，请重试。'
  } catch {
    if (disposed || revision !== commandRevision) return
    commandError = '浏览器连接失败，请重试。'
  }
  if (!disposed) renderStatus()
}

function render(next: BrowserChromeState): void {
  if (disposed) return
  const previousActiveId = state?.activeTabId
  state = next
  const present = new Set(next.tabs.map((tab) => tab.id))
  for (const [id, elements] of tabElements) {
    if (!present.has(id)) {
      elements.root.remove()
      tabElements.delete(id)
    }
  }
  next.tabs.forEach((tab, index) => {
    let elements = tabElements.get(tab.id)
    if (!elements) {
      const root = document.createElement('div')
      root.className = 'tab'
      root.dataset.tabId = tab.id
      const select = document.createElement('button')
      select.type = 'button'
      select.className = 'tab-select'
      select.setAttribute('role', 'tab')
      select.addEventListener('click', () => { void send({ type: 'activate-tab', tabId: tab.id }) })
      const close = document.createElement('button')
      close.type = 'button'
      close.className = 'tab-close'
      close.textContent = '×'
      close.addEventListener('click', () => { void send({ type: 'close-tab', tabId: tab.id }) })
      root.addEventListener('auxclick', (event) => {
        if (event.button === 1) {
          event.preventDefault()
          void send({ type: 'close-tab', tabId: tab.id })
        }
      })
      root.append(select, close)
      elements = { root, select, close }
      tabElements.set(tab.id, elements)
    }
    const active = tab.id === next.activeTabId
    const title = tab.title || (tab.url && tab.url !== 'about:blank' ? tab.url : '新标签页')
    // Titles and URLs are untrusted remote strings: never parse them as markup.
    elements.select.textContent = title
    elements.select.title = title
    elements.select.setAttribute('aria-selected', String(active))
    elements.select.tabIndex = active ? 0 : -1
    elements.close.setAttribute('aria-label', `关闭标签页：${title}`)
    elements.close.title = '关闭标签页 (Ctrl+W)'
    elements.root.classList.toggle('active', active)
    elements.root.classList.toggle('loading', tab.loading)
    elements.root.classList.toggle('has-error', Boolean(tab.error))
    if (tabsElement.children[index] !== elements.root) {
      tabsElement.insertBefore(elements.root, tabsElement.children[index] || null)
    }
  })
  const tab = activeTab()
  newTabButton.disabled = false
  address.disabled = !tab
  goButton.disabled = !tab
  backButton.disabled = !tab?.canGoBack
  forwardButton.disabled = !tab?.canGoForward
  reloadButton.disabled = !tab
  reloadButton.textContent = tab?.loading ? '■' : '↻'
  reloadButton.title = tab?.loading ? '停止加载' : '重新加载'
  reloadButton.setAttribute('aria-label', reloadButton.title)
  proxyStatus.textContent = `${next.proxyEnabled ? 'SOCKS5 出口' : '系统网络出口'}：${next.exitIp || '未验证'}${next.country ? ` · ${next.country}` : ''}（启动样本）`
  document.title = next.label || '临时浏览器'

  // 渲染账号检测与添加操作按钮
  const acc = next.sessionAccount
  if (acc?.detected && acc.email) {
    btnLoginKiro.style.display = 'none'
    btnAddAccount.style.display = 'inline-block'
    if (acc.alreadyAdded) {
      btnAddAccount.textContent = `已添加 (${acc.email})`
      btnAddAccount.className = 'btn-action added'
      btnAddAccount.disabled = true
      btnAddAccount.title = `该账号已在 KiroLuker 账号列表中：${acc.email}`
    } else {
      btnAddAccount.textContent = `添加此账号 (${acc.email})`
      btnAddAccount.className = 'btn-action primary'
      btnAddAccount.disabled = false
      btnAddAccount.title = `一键将当前登录账号 (${acc.email}) 添加到 KiroLuker`
    }
  } else {
    btnAddAccount.style.display = 'none'
    btnLoginKiro.style.display = 'inline-block'
    btnLoginKiro.disabled = !tab
  }

  syncAddress()
  renderStatus()
  if (previousActiveId !== next.activeTabId) {
    tabElements.get(next.activeTabId)?.root.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }
}

newTabButton.addEventListener('click', () => { void send({ type: 'new-tab' }) })
backButton.addEventListener('click', () => { void send({ type: 'back' }) })
forwardButton.addEventListener('click', () => { void send({ type: 'forward' }) })
reloadButton.addEventListener('click', () => { void send({ type: activeTab()?.loading ? 'stop' : 'reload' }) })

btnLoginKiro.addEventListener('click', () => {
  void send({ type: 'start-login' })
})

btnAddAccount.addEventListener('click', async () => {
  if (btnAddAccount.disabled) return
  btnAddAccount.disabled = true
  btnAddAccount.textContent = '正在添加…'
  await send({ type: 'import-account' })
})

address.addEventListener('blur', () => { address.value = activeTab()?.url || '' })
address.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    address.value = activeTab()?.url || ''
    address.select()
    event.preventDefault()
  }
})
addressForm.addEventListener('submit', (event) => {
  event.preventDefault()
  if (!activeTab()) return
  const url = address.value.trim() || 'about:blank'
  // Main owns URL validation, scheme policy and navigation. Keep the actual URL until it updates.
  address.blur()
  void send({ type: 'navigate', url })
})

tabsElement.addEventListener('keydown', (event) => {
  if (!state || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
  if (!(event.target instanceof HTMLElement) || event.target.getAttribute('role') !== 'tab') return
  const index = state.tabs.findIndex((tab) => tab.id === state?.activeTabId)
  let target: BrowserTabState | undefined
  if (event.key === 'ArrowRight') target = state.tabs[(index + 1) % state.tabs.length]
  else if (event.key === 'ArrowLeft') target = state.tabs[(index - 1 + state.tabs.length) % state.tabs.length]
  else if (event.key === 'Home') target = state.tabs[0]
  else if (event.key === 'End') target = state.tabs.at(-1)
  if (target) {
    event.preventDefault()
    tabElements.get(target.id)?.select.focus()
    void send({ type: 'activate-tab', tabId: target.id })
  }
})

document.addEventListener('keydown', (event) => {
  if (event.defaultPrevented || event.isComposing) return
  const key = event.key.toLowerCase()
  if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && ['l', 't', 'w'].includes(key)) {
    event.preventDefault()
    if (event.repeat) return
    if (key === 'l') focusAddress()
    else if (key === 't') void send({ type: 'new-tab' })
    else if (state?.activeTabId) void send({ type: 'close-tab', tabId: state.activeTabId })
  } else if (event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault()
      if (event.key === 'ArrowLeft' && activeTab()?.canGoBack) void send({ type: 'back' })
      if (event.key === 'ArrowRight' && activeTab()?.canGoForward) void send({ type: 'forward' })
    }
  }
})

async function initialize(): Promise<void> {
  if (!api) {
    commandError = '浏览器工具栏服务不可用，请关闭窗口后重试。'
    proxyStatus.textContent = '出口未验证'
    renderStatus()
    return
  }
  try {
    offState = api.onState((next) => {
      receivedState = true
      render(next)
    })
    offFocusAddress = api.onFocusAddress(focusAddress)
    const initial = await api.getState()
    // A newer push can arrive while the initial snapshot is in flight.
    if (!receivedState) render(initial)
  } catch {
    if (!disposed) {
      commandError = '读取浏览器状态失败，请关闭窗口后重试。'
      renderStatus()
    }
  }
}

window.addEventListener('unload', () => {
  disposed = true
  offState?.()
  offFocusAddress?.()
}, { once: true })
void initialize()