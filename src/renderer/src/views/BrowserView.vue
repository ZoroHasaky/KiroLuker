<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref } from 'vue'
import { message } from 'ant-design-vue'
import { GlobalOutlined, PlusOutlined, ReloadOutlined } from '@ant-design/icons-vue'
import type {
  BrowserConfig,
  BrowserConfigPatch,
  BrowserRendererApi,
  BrowserProxyCheck,
  BrowserWindowSummary
} from '@shared/browser'
import { useAccountsStore } from '@/stores/accounts'
import { useSettingsStore } from '@/stores/settings'
import { displayEmail, displayName } from '@/utils/display'

const api = window.api as typeof window.api & BrowserRendererApi
const accountsStore = useAccountsStore()
const settingsStore = useSettingsStore()
const privacy = computed(() => settingsStore.settings.privacyMode)
const savedConfig = ref<BrowserConfig | null>(null)
const draft = reactive<BrowserConfig>({
  proxy: {
    enabled: false, mode: 'socks5', host: '', port: 1080, username: '', passwordSet: false,
    apiUrl: '', apiProxyHost: '', apiProxyPort: 7897
  },
  fingerprint: { language: navigator.language, timezone: '', userAgent: '', width: 1280, height: 900 }
})
const password = ref('')
const clearPassword = ref(false)
const loading = ref(true)
const saving = ref(false)
const checking = ref(false)
const opening = ref<'anonymous' | 'account' | null>(null)
const refreshingWindows = ref(false)
const busyWindows = reactive(new Set<string>())
const configError = ref('')
const actionError = ref('')
const windowsError = ref('')
const proxyCheck = ref<BrowserProxyCheck | null>(null)
const windows = ref<BrowserWindowSummary[]>([])
const selectedAccountId = ref<string>()
let offWindows: (() => void) | undefined
let disposed = false
let windowsRevision = 0

const dirty = computed(() => savedConfig.value !== null && (
  JSON.stringify(draft) !== JSON.stringify(savedConfig.value) || password.value !== '' || clearPassword.value
))
const configBusy = computed(() => loading.value || saving.value || checking.value)
const validationError = computed(() => savedConfig.value ? validate(createPatch()) : '')
const canOpen = computed(() => savedConfig.value !== null && !configBusy.value && !dirty.value && !validationError.value && opening.value === null)
const accountOptions = computed(() => accountsStore.accounts.map((account) => ({
  value: account.id,
  label: `${displayName(account, privacy.value)} · ${displayEmail(account.email, privacy.value)}`
})))
const selectedAccountExists = computed(() => accountsStore.accounts.some((account) => account.id === selectedAccountId.value))

function applyConfig(config: BrowserConfig): void {
  savedConfig.value = { proxy: { ...config.proxy }, fingerprint: { ...config.fingerprint } }
  draft.proxy = { ...config.proxy }
  draft.fingerprint = { ...config.fingerprint }
  password.value = ''
  clearPassword.value = false
}

async function loadConfig(): Promise<void> {
  loading.value = true
  configError.value = ''
  try {
    const result = await api.getBrowserConfig()
    if (disposed) return
    if (!result.success || !result.data) {
      configError.value = result.error || '读取浏览器配置失败'
      return
    }
    applyConfig(result.data)
  } catch {
    if (!disposed) configError.value = '浏览器服务不可用，请确认已更新并重启应用。'
  } finally {
    loading.value = false
  }
}

function createPatch(): BrowserConfigPatch {
  const { enabled, mode, host, port, username, apiUrl, apiProxyHost, apiProxyPort } = draft.proxy
  return {
    proxy: {
      enabled, mode, host: host.trim(), port, username,
      apiUrl: apiUrl.trim(), apiProxyHost: apiProxyHost.trim(), apiProxyPort,
      // Never send an empty secret accidentally: blank means preserve, explicit clear means remove.
      ...((mode === 'socks5' || mode === 'http') && (clearPassword.value ? true : password.value !== '')
        ? { password: clearPassword.value ? '' : password.value }
        : {})
    },
    fingerprint: {
      ...draft.fingerprint,
      language: draft.fingerprint.language.trim(),
      timezone: draft.fingerprint.timezone.trim(),
      userAgent: draft.fingerprint.userAgent.trim()
    }
  }
}

function validHost(host: string): boolean {
  if (/[\s/@?#%\[\]\\]/u.test(host)) return false
  if (host.includes(':')) {
    try { return new URL(`http://[${host}]/`).hostname.startsWith('[') } catch { return false }
  }
  if (/^[\d.]+$/.test(host)) {
    const parts = host.split('.')
    return parts.length === 4 && parts.every((part) => /^(0|[1-9]\d{0,2})$/.test(part) && Number(part) <= 255)
  }
  const domain = host.endsWith('.') ? host.slice(0, -1) : host
  return domain.length <= 253 && domain.split('.').every((label) => /^[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?$/i.test(label))
}

function validate(patch: BrowserConfigPatch): string {
  const { proxy, fingerprint } = patch
  const strings = [
    proxy.host, proxy.username, proxy.password || '', proxy.apiUrl, proxy.apiProxyHost,
    fingerprint.language, fingerprint.timezone, fingerprint.userAgent
  ]
  const encoder = new TextEncoder()
  if (strings.some((value) => /[\u0000-\u001f\u007f-\u009f]/.test(value) || new TextDecoder().decode(encoder.encode(value)) !== value)) {
    return '配置不能包含换行、控制字符或无效 Unicode。'
  }
  if (proxy.mode !== 'socks5' && proxy.mode !== 'http' && proxy.mode !== 'dynamic-http') return '请选择有效的代理模式。'
  if (!Number.isInteger(proxy.port) || proxy.port < 1 || proxy.port > 65535 || !Number.isInteger(proxy.apiProxyPort) || proxy.apiProxyPort < 1 || proxy.apiProxyPort > 65535) {
    return '代理端口必须为 1–65535 的整数。'
  }
  if (proxy.mode === 'socks5' || proxy.mode === 'http') {
    if ((proxy.enabled || proxy.host) && !validHost(proxy.host)) return `请填写有效的 ${proxy.mode === 'http' ? 'HTTP' : 'SOCKS5'} 代理主机名或 IP（不含协议、端口或路径）。`
    if ([proxy.username, proxy.password || ''].some((value) => encoder.encode(value).length > 255)) return `${proxy.mode === 'http' ? 'HTTP' : 'SOCKS5'} 用户名和密码各不能超过 255 个 UTF-8 字节。`
  } else if (proxy.enabled) {
    if (!validHost(proxy.apiProxyHost)) return '请填写本机 HTTP 代理的主机名或 IP（不含协议、端口或路径）。'
    try {
      const apiUrl = new URL(proxy.apiUrl)
      if (apiUrl.protocol !== 'https:' || !apiUrl.hostname || apiUrl.username || apiUrl.password || apiUrl.hash) throw new Error()
    } catch {
      return '动态代理 API 必须是无凭据、无片段的 HTTPS 地址。'
    }
  }
  if (fingerprint.language.length > 255 || !/^[a-z]{2,8}(?:-[a-z\d]{1,8})*$/i.test(fingerprint.language)) return '语言标签无效，请使用 zh-CN、en-US 等格式。'
  try {
    Intl.getCanonicalLocales(patch.fingerprint.language)
  } catch {
    return '语言标签无效，请使用 zh-CN、en-US 等格式。'
  }
  if (patch.fingerprint.timezone) {
    if (fingerprint.timezone.length > 100 || !/^[a-z][a-z\d_+\-/]*$/i.test(fingerprint.timezone)) return '请使用 IANA 时区名称，而不是数字偏移量。'
    try {
      new Intl.DateTimeFormat('en', { timeZone: patch.fingerprint.timezone }).format()
    } catch {
      return '时区无效，请使用 IANA 时区，例如 Asia/Shanghai；留空使用系统时区。'
    }
  }
  if (fingerprint.userAgent.length > 512) return 'User-Agent 不能超过 512 个字符。'
  if (!Number.isInteger(fingerprint.width) || fingerprint.width < 900 || fingerprint.width > 2400 || !Number.isInteger(fingerprint.height) || fingerprint.height < 600 || fingerprint.height > 1800) {
    return '窗口宽度须为 900–2400、高度须为 600–1800 的整数（CSS 像素）。'
  }
  return ''
}

async function saveConfig(): Promise<void> {
  if (configBusy.value || !dirty.value || !savedConfig.value || validationError.value) return
  const patch = createPatch()
  actionError.value = ''
  saving.value = true
  try {
    const result = await api.saveBrowserConfig(patch)
    if (disposed) return
    if (!result.success || !result.data) {
      actionError.value = result.error || '保存失败，配置草稿已保留。'
      return
    }
    applyConfig(result.data)
    proxyCheck.value = null
    message.success('已保存，仅对新打开的浏览器窗口生效')
  } catch {
    if (!disposed) actionError.value = '保存失败，请重试；配置草稿已保留。'
  } finally {
    saving.value = false
  }
}

async function testProxy(): Promise<void> {
  if (configBusy.value || dirty.value || !savedConfig.value || validationError.value) return
  checking.value = true
  actionError.value = ''
  proxyCheck.value = null
  try {
    // Deliberately no draft argument: main verifies only the SAVED configuration.
    const result = await api.checkBrowserProxy()
    if (disposed) return
    if (!result.success || !result.data) actionError.value = result.error || '出口验证失败'
    else proxyCheck.value = result.data
  } catch {
    if (!disposed) actionError.value = '出口验证失败，请检查已保存的代理配置。'
  } finally {
    checking.value = false
  }
}

async function refreshWindows(): Promise<void> {
  if (refreshingWindows.value) return
  refreshingWindows.value = true
  windowsError.value = ''
  const revision = windowsRevision
  try {
    const result = await api.getBrowserWindows()
    if (disposed || revision !== windowsRevision) return
    if (!result.success || !result.data) windowsError.value = result.error || '读取窗口列表失败'
    else windows.value = result.data
  } catch {
    if (!disposed && revision === windowsRevision) windowsError.value = '读取窗口列表失败，请重试。'
  } finally {
    refreshingWindows.value = false
  }
}

async function openWindow(account = false): Promise<void> {
  if (!canOpen.value || (account && !selectedAccountExists.value)) return
  opening.value = account ? 'account' : 'anonymous'
  actionError.value = ''
  try {
    const result = await api.openBrowserWindow(account ? { accountId: selectedAccountId.value } : {})
    if (disposed) return
    if (!result.success || !result.data) actionError.value = result.error || '打开浏览器窗口失败'
    else await refreshWindows()
  } catch {
    if (!disposed) actionError.value = '打开浏览器窗口失败，请检查已保存配置后重试。'
  } finally {
    opening.value = null
  }
}

async function windowAction(id: string, action: 'focus' | 'close'): Promise<void> {
  if (busyWindows.has(id)) return
  busyWindows.add(id)
  windowsError.value = ''
  try {
    const result = await (action === 'focus' ? api.focusBrowserWindow(id) : api.closeBrowserWindow(id))
    if (disposed) return
    if (!result.success) windowsError.value = result.error || '窗口操作失败'
    else if (action === 'close') await refreshWindows()
  } catch {
    if (!disposed) windowsError.value = '窗口操作失败，窗口可能已关闭，请刷新列表。'
  } finally {
    busyWindows.delete(id)
  }
}

onMounted(() => {
  try {
    offWindows = api.onBrowserWindowsChanged((items) => {
      if (disposed) return
      windowsRevision++
      windows.value = items
      windowsError.value = ''
    })
  } catch {
    windowsError.value = '无法订阅窗口变化，可使用刷新按钮更新列表。'
  }
  void loadConfig()
  void refreshWindows()
})
onUnmounted(() => {
  disposed = true
  offWindows?.()
  password.value = ''
})
</script>

<template>
  <a-config-provider component-size="small">
    <div class="browser-view" data-testid="browser-view">
      <header class="page-header">
        <div>
          <h2><GlobalOutlined /> 临时浏览器</h2>
          <p class="muted">在独立窗口中浏览真实网页；这里仅管理配置与运行中的窗口。</p>
        </div>
        <a-tag color="purple">独立临时会话</a-tag>
      </header>

      <a-alert type="info" show-icon class="notice" message="配置仅对新窗口生效，已有窗口不受影响。">
        <template #description>
          关闭窗口后清理该窗口的临时 Cookie、缓存与站点存储，不保留浏览器配置档案。
          基础参数不等于完整防关联；原生弹出页的首轮脚本可能仍读取系统时区。
          WebRTC 非代理 UDP 已禁用。出口 IP 仅是启动验证样本；轮换上游后续可能变化，不代表持续使用同一出口，也不保证匿名。
        </template>
      </a-alert>
      <a-alert v-if="configError" type="error" show-icon :message="configError">
        <template #action><a-button :loading="loading" @click="loadConfig">重试</a-button></template>
      </a-alert>
      <a-alert v-if="actionError" data-testid="browser-action-error" type="error" show-icon :message="actionError" closable @close="actionError = ''" />

      <a-alert v-if="validationError" data-testid="browser-validation-error" type="warning" show-icon :message="validationError" />

      <a-spin :spinning="loading">
        <a-form layout="vertical" :model="draft" :disabled="!savedConfig || configBusy" @finish="saveConfig">
          <div class="config-grid">
            <a-card title="代理" size="small">
              <div class="switch-row">
                <label for="browser-proxy-enabled">启用自定义代理</label>
                <a-switch id="browser-proxy-enabled" v-model:checked="draft.proxy.enabled" data-testid="proxy-enabled" />
              </div>
              <p class="muted field-help">关闭时使用系统网络（可能受系统代理影响），不使用自定义代理。</p>
              <a-form-item label="代理模式" html-for="browser-proxy-mode">
                <a-select id="browser-proxy-mode" v-model:value="draft.proxy.mode" :disabled="!draft.proxy.enabled">
                  <a-select-option value="socks5">静态 SOCKS5</a-select-option>
                  <a-select-option value="http">本地 HTTP 代理</a-select-option>
                  <a-select-option value="dynamic-http">白名单动态 HTTP API</a-select-option>
                </a-select>
              </a-form-item>

              <template v-if="draft.proxy.mode === 'socks5' || draft.proxy.mode === 'http'">
                <div class="host-port-grid">
                  <a-form-item :label="draft.proxy.mode === 'http' ? 'HTTP 主机' : 'SOCKS5 主机'" html-for="browser-proxy-host">
                    <a-input id="browser-proxy-host" v-model:value="draft.proxy.host" :disabled="!draft.proxy.enabled" :placeholder="draft.proxy.mode === 'http' ? '例如 127.0.0.1' : '主机名或 IP，不含 socks5://'" autocomplete="off" />
                  </a-form-item>
                  <a-form-item label="端口" html-for="browser-proxy-port">
                    <a-input-number id="browser-proxy-port" v-model:value="draft.proxy.port" @input="draft.proxy.port = Number($event)" :disabled="!draft.proxy.enabled" :min="1" :max="65535" :precision="0" />
                  </a-form-item>
                </div>
                <a-form-item label="用户名（可选）" html-for="browser-proxy-username">
                  <a-input id="browser-proxy-username" v-model:value="draft.proxy.username" :type="privacy ? 'password' : 'text'" :disabled="!draft.proxy.enabled" autocomplete="off" />
                </a-form-item>
                <a-form-item label="密码（只写，不回显）" html-for="browser-proxy-password">
                  <a-input id="browser-proxy-password" v-model:value="password" type="password" :disabled="!draft.proxy.enabled || clearPassword" autocomplete="new-password" :placeholder="draft.proxy.passwordSet ? '已保存密码；留空保持不变' : '未设置密码'" />
                  <div class="password-note">
                    <span class="muted">{{ clearPassword ? '保存后将清除密码。' : draft.proxy.passwordSet ? '已有密码已保存，不会读取或回显。' : '未保存密码。' }}</span>
                    <a-button data-testid="clear-proxy-password" type="link" danger :disabled="!draft.proxy.passwordSet && !clearPassword" @click="clearPassword = !clearPassword; password = ''">
                      {{ clearPassword ? '取消清除' : '清除已保存密码' }}
                    </a-button>
                  </div>
                </a-form-item>
              </template>

              <template v-else>
                <a-form-item label="动态代理 API（HTTPS）" html-for="browser-proxy-api-url">
                  <a-input id="browser-proxy-api-url" v-model:value="draft.proxy.apiUrl" :disabled="!draft.proxy.enabled" placeholder="https://provider.example/api?..." autocomplete="off" />
                </a-form-item>
                <div class="host-port-grid">
                  <a-form-item label="本机 HTTP 代理主机" html-for="browser-proxy-api-host">
                    <a-input id="browser-proxy-api-host" v-model:value="draft.proxy.apiProxyHost" :disabled="!draft.proxy.enabled" placeholder="127.0.0.1" autocomplete="off" />
                  </a-form-item>
                  <a-form-item label="端口" html-for="browser-proxy-api-port">
                    <a-input-number id="browser-proxy-api-port" v-model:value="draft.proxy.apiProxyPort" @input="draft.proxy.apiProxyPort = Number($event)" :disabled="!draft.proxy.enabled" :min="1" :max="65535" :precision="0" />
                  </a-form-item>
                </div>
                <a-alert
                  type="info"
                  show-icon
                  message="动态 API 与返回的 HTTP 代理都会经此本机代理连接"
                  description="用于满足供应商的来源 IP 白名单；返回内容必须是单个 IP:端口。链路失败不会回退为直连。"
                />
              </template>
            </a-card>

            <a-card title="浏览器指纹" size="small">
              <div class="two-columns">
                <a-form-item label="语言标签" html-for="browser-language">
                  <a-input id="browser-language" v-model:value="draft.fingerprint.language" placeholder="zh-CN / en-US" spellcheck="false" />
                </a-form-item>
                <a-form-item label="IANA 时区（可选）" html-for="browser-timezone">
                  <a-input id="browser-timezone" v-model:value="draft.fingerprint.timezone" placeholder="Asia/Shanghai；空为系统时区" spellcheck="false" />
                </a-form-item>
              </div>
              <a-form-item label="User-Agent（可选）" html-for="browser-user-agent">
                <a-textarea id="browser-user-agent" v-model:value="draft.fingerprint.userAgent" :rows="2" placeholder="留空使用当前内置 Chrome 默认 UA" spellcheck="false" />
              </a-form-item>
              <div class="two-columns">
                <a-form-item label="窗口宽度（px）" html-for="browser-width">
                  <a-input-number id="browser-width" v-model:value="draft.fingerprint.width" @input="draft.fingerprint.width = Number($event)" :min="900" :max="2400" :precision="0" />
                </a-form-item>
                <a-form-item label="窗口高度（px）" html-for="browser-height">
                  <a-input-number id="browser-height" v-model:value="draft.fingerprint.height" @input="draft.fingerprint.height = Number($event)" :min="600" :max="1800" :precision="0" />
                </a-form-item>
              </div>
              <p class="muted field-help">语言、时区、UA 与尺寸是可配置的浏览环境，不代表完整的反指纹或匿名保护。</p>
            </a-card>
          </div>
          <p class="muted field-help">新代理窗口最多尝试 3 次新连接；若出口仍与上次成功打开或正在运行的窗口重复，将拒绝打开，不会假装已更换 IP。</p>
          <div class="config-actions">
            <a-button data-testid="save-browser-config" type="primary" html-type="submit" :loading="saving" :disabled="!savedConfig || configBusy || !dirty || !!validationError">保存配置</a-button>
            <a-button data-testid="test-browser-proxy" :loading="checking" :disabled="!savedConfig || configBusy || dirty || !!validationError" @click="testProxy">测试已保存配置</a-button>
            <span class="muted" data-testid="browser-config-status">{{ dirty ? '有未保存修改，请先保存后再测试或打开窗口。' : '所有新窗口使用已保存配置。' }}</span>
          </div>
        </a-form>
      </a-spin>

      <div v-if="proxyCheck" class="check-result" role="status" data-testid="browser-proxy-result">
        <a-tag color="green">验证成功 · {{ savedConfig?.proxy.enabled ? savedConfig.proxy.mode === 'dynamic-http' ? '动态 HTTP API' : savedConfig.proxy.mode === 'http' ? 'HTTP' : 'SOCKS5' : '系统网络' }}</a-tag>
        <span class="mono">{{ proxyCheck.ip }}</span>
        <span>{{ proxyCheck.country || '国家/地区未知' }}</span>
        <span class="muted">{{ proxyCheck.latencyMs }} ms · {{ new Date(proxyCheck.checkedAt).toLocaleString() }}（仅本次验证）</span>
      </div>

      <a-card title="打开临时窗口" size="small">
        <div class="open-actions">
          <a-button data-testid="open-anonymous-browser" :disabled="!canOpen" :loading="opening === 'anonymous'" @click="openWindow()">
            <template #icon><PlusOutlined /></template>匿名空白窗口
          </a-button>
          <a-select v-model:value="selectedAccountId" class="account-select" data-testid="browser-account-select" aria-label="选择已有账户" placeholder="选择已有账户" show-search allow-clear option-filter-prop="label" :options="accountOptions" :loading="accountsStore.loading" :disabled="accountsStore.loading || opening !== null" />
          <a-button data-testid="open-account-browser" type="primary" :disabled="!canOpen || !selectedAccountExists" :loading="opening === 'account'" @click="openWindow(true)">打开所选账户</a-button>
        </div>
        <p class="muted field-help">{{ accountsStore.accounts.length ? '账户授权由主进程处理；网页与浏览器工具栏不接触账户管理 API。' : '暂无账户，可先在「账户管理」中添加；仍可打开匿名窗口。' }}</p>
      </a-card>

      <a-card size="small" class="windows-card">
        <template #title>运行中的窗口 <span class="muted">{{ windows.length }}</span></template>
        <template #extra><a-button data-testid="refresh-browser-windows" :loading="refreshingWindows" @click="refreshWindows"><template #icon><ReloadOutlined /></template>刷新</a-button></template>
        <a-alert v-if="windowsError" type="error" show-icon :message="windowsError" class="notice" />
        <div v-if="windows.length" class="windows-table-wrap">
          <table class="windows-table" data-testid="browser-windows-table">
            <thead><tr><th scope="col">窗口 / 当前站点</th><th scope="col">启动时出口</th><th scope="col">标签页</th><th scope="col">操作</th></tr></thead>
            <tbody>
              <tr v-for="item in windows" :key="item.id" :data-window-id="item.id">
                <td><div class="window-label">{{ item.label || '临时窗口' }}</div><div class="muted origin">{{ item.activeOrigin || '空白页' }}</div></td>
                <td><div class="mono">{{ item.exitIp || '未验证' }}</div><div class="muted">{{ item.proxyEnabled ? '自定义代理' : '系统网络' }} · {{ item.country || '国家/地区未知' }}</div></td>
                <td>{{ item.tabCount }}</td>
                <td><div class="window-actions"><a-button data-action="focus" :disabled="busyWindows.has(item.id)" @click="windowAction(item.id, 'focus')">聚焦</a-button><a-popconfirm title="关闭此窗口？临时站点数据将清理。" ok-text="关闭" cancel-text="取消" @confirm="windowAction(item.id, 'close')"><a-button data-action="close" danger :disabled="busyWindows.has(item.id)">关闭</a-button></a-popconfirm></div></td>
              </tr>
            </tbody>
          </table>
        </div>
        <a-empty v-else :description="refreshingWindows ? '正在读取窗口…' : '暂无运行中的窗口'" />
      </a-card>
    </div>
  </a-config-provider>
</template>

<style scoped>
.browser-view { display: flex; flex-direction: column; gap: 14px; }
.page-header, .switch-row, .password-note { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.page-header h2 { margin: 0 0 4px; font-size: 20px; }
.page-header p { margin: 0; font-size: 13px; }
.muted { color: var(--kal-muted); font-size: 12px; }
.config-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px; }
.host-port-grid { display: grid; grid-template-columns: minmax(0, 1fr) 100px; gap: 12px; }
.two-columns { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
.browser-view :deep(.ant-form-item) { margin-bottom: 12px; }
.browser-view :deep(.ant-input-number) { width: 100%; }
.field-help { margin: 8px 0 12px; line-height: 1.6; }
.password-note { flex-wrap: wrap; gap: 2px; margin-top: 5px; }
.password-note :deep(.ant-btn) { padding-inline: 0; }
.config-actions, .open-actions, .check-result { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.config-actions { margin-top: 12px; }
.check-result { padding: 10px 12px; background: var(--kal-block-bg); border: 1px solid var(--kal-border); border-radius: 8px; }
.account-select { flex: 1 1 260px; min-width: 180px; max-width: 500px; }
.windows-card .notice { margin-bottom: 12px; }
.windows-table-wrap { overflow-x: auto; }
.windows-table { width: 100%; border-collapse: collapse; text-align: left; font-size: 12px; }
.windows-table th { color: var(--kal-muted); font-weight: 500; white-space: nowrap; }
.windows-table th, .windows-table td { padding: 10px 8px; border-bottom: 1px solid var(--kal-border); }
.windows-table tr:last-child td { border-bottom: 0; }
.windows-table td:first-child { width: 45%; max-width: 360px; }
.window-label, .origin { overflow-wrap: anywhere; }
.window-label { margin-bottom: 4px; font-weight: 500; }
.window-actions { display: flex; gap: 6px; }
.mono { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; overflow-wrap: anywhere; }
@media (max-width: 900px) { .config-grid { grid-template-columns: 1fr; } }
@media (max-width: 560px) { .two-columns { grid-template-columns: 1fr; gap: 0; } .page-header { align-items: flex-start; } }
</style>