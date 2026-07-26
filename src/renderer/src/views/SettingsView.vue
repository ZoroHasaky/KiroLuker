<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { message } from 'ant-design-vue'
import {
  DeleteOutlined,
  DownloadOutlined,
  FolderOpenOutlined,
  ReloadOutlined,
  UploadOutlined
} from '@ant-design/icons-vue'
import { DEFAULT_SETTINGS } from '@shared/types'
import type { AppSettings } from '@shared/types'
import { useSettingsStore } from '@/stores/settings'
import SettingSwitch from '@/components/common/SettingSwitch.vue'
import { useAccountsStore } from '@/stores/accounts'
import { formatCheckedAt } from '@/utils/format'
import { now } from '@/utils/now'
import { bodyPopupContainer, confirmDanger } from '@/utils/ui'
import ExportAccountsModal from '@/components/accounts/ExportAccountsModal.vue'
import ImportAccountsModal from '@/components/accounts/ImportAccountsModal.vue'

const settingsStore = useSettingsStore()
const accountsStore = useAccountsStore()

const settings = computed(() => settingsStore.settings)
const proxyDraft = ref(settingsStore.settings.proxyUrl)

/** 各设置卡片共用的表单栅格：左侧固定标签宽度，右侧自适应 */
const FORM_LAYOUT = {
  layout: 'horizontal',
  labelCol: { flex: '0 0 130px' },
  wrapperCol: { flex: '1 1 auto' }
} as const

/** 下次刷新的时间与倒计时，跟着共享时钟每 5 秒重算 */
function nextRefreshText(at: number | null): string {
  if (!at) return '未开启，不会自动执行'
  const remain = at - now.value
  // 到期后到期时间会被立刻往后推，这里还没推说明本轮正在执行或在等手动任务让路
  if (remain <= 0) return '本轮正在执行…'
  const minutes = Math.floor(remain / 60_000)
  const seconds = Math.floor((remain % 60_000) / 1000)
  const countdown = minutes ? `${minutes} 分 ${seconds} 秒后` : `${seconds} 秒后`
  return `下次刷新 ${formatCheckedAt(at, now.value)}（${countdown}）`
}

const nextKeyRefreshText = computed(() => nextRefreshText(accountsStore.nextKeyRefreshAt))
const nextUsageRefreshText = computed(() => nextRefreshText(accountsStore.nextUsageRefreshAt))

watch(
  () => settingsStore.settings.proxyUrl,
  (value) => {
    if (value !== proxyDraft.value) proxyDraft.value = value
  }
)

const presetColors = ['#7c3aed', '#1677ff', '#13c2c2', '#52c41a', '#fa8c16', '#eb2f96', '#f5222d']

/** 输入框可能给出 null 或越界值，统一夹到 1-100 */
function clampImportConcurrency(value: unknown): number {
  const num = Number(value)
  if (!Number.isFinite(num)) return DEFAULT_SETTINGS.importConcurrency
  return Math.max(1, Math.min(Math.round(num), 100))
}

const closeActionOptions: { value: AppSettings['closeAction']; label: string }[] = [
  { value: 'ask', label: '每次询问' },
  { value: 'minimize', label: '最小化到托盘' },
  { value: 'quit', label: '退出程序' }
]

/** 设置缺失时回落到默认的「最小化到托盘」，避免下拉显示空白 */
const closeAction = computed(
  () => settings.value.closeAction ?? DEFAULT_SETTINGS.closeAction
)

function update(patch: Parameters<typeof settingsStore.update>[0]): void {
  void settingsStore.update(patch)
}

async function saveProxy(): Promise<void> {
  await settingsStore.update({ proxyUrl: proxyDraft.value.trim() })
  message.success('代理地址已保存')
}

function openPath(target: 'store' | 'backup'): void {
  void window.api.showPath(target)
}

const exportOpen = ref(false)
const importOpen = ref(false)

const accountCount = computed(() => accountsStore.accounts.length)

function openExport(): void {
  if (accountCount.value === 0) return void message.warning('还没有账号可以导出')
  exportOpen.value = true
}

const resetting = ref(false)

function resetSettings(): void {
  confirmDanger({
    title: '恢复默认设置',
    content: '所有设置项会回到初始值，包括主题、刷新策略、代理与托盘配置。账号数据不会被删除。',
    okText: '恢复默认',
    // 默认的 okType: 'danger' 是描边按钮，这里要实心红
    okButtonProps: { type: 'primary', danger: true },
    onOk: async () => {
      resetting.value = true
      try {
        // 直接提交全量默认值：主进程会逐字段覆盖，托盘等副作用也会一起生效
        await settingsStore.update({ ...DEFAULT_SETTINGS })
        // 代理输入框是本地草稿，重置后同步回默认值
        proxyDraft.value = settingsStore.settings.proxyUrl
        message.success('设置已恢复默认')
      } finally {
        resetting.value = false
      }
    }
  })
}

function clearAll(): void {
  if (accountCount.value === 0) return void message.info('当前没有账号数据')
  confirmDanger({
    title: '清除所有账号数据',
    content: `会删除本应用保存的全部 ${accountCount.value} 个账号。请先导出备份，该操作不可撤销。`,
    okText: '确认清除',
    onOk: () => {
      const count = accountsStore.removeAccounts(accountsStore.accounts.map((a) => a.id))
      message.success(`已清除 ${count} 个账号`)
    }
  })
}
</script>

<template>
  <div>
    <a-card size="small" title="外观" style="margin-bottom: 16px">
      <a-form v-bind="FORM_LAYOUT">
        <a-form-item label="深色模式">
          <SettingSwitch field="darkMode" />
        </a-form-item>
        <a-form-item label="主题色">
          <a-space wrap>
            <button
              v-for="color in presetColors"
              :key="color"
              class="color-dot"
              :class="{ selected: settings.primaryColor === color }"
              :style="{ background: color }"
              @click="update({ primaryColor: color })"
            />
          </a-space>
        </a-form-item>
        <a-form-item label="邮箱打码" class="field-inline">
          <SettingSwitch field="privacyMode" />
          <span class="muted">列表与详情中隐藏邮箱中间部分</span>
        </a-form-item>
        <a-form-item label="积分两位小数">
          <SettingSwitch field="usagePrecision" />
        </a-form-item>
      </a-form>
    </a-card>

    <a-card size="small" title="账号刷新" style="margin-bottom: 16px">
      <a-form v-bind="FORM_LAYOUT">
        <a-form-item label="自动刷新密钥" class="field-inline">
          <SettingSwitch field="autoRefresh" />
          <span class="muted">
            只刷新 30 分钟内即将过期的账号，避免无谓轮换 Refresh Token
          </span>
        </a-form-item>
        <a-form-item label="IDE 主动续期" class="field-inline">
          <SettingSwitch field="proactiveRenewalEnabled" />
          <span class="muted">
            在 IDE 激活账号的 token 剩 ~15 分钟时抢先 refresh，让 Kiro IDE 永远不自己 refresh
          </span>
        </a-form-item>
        <a-form-item label="自动刷新用量" class="field-inline">
          <SettingSwitch field="autoRefreshUsage" />
          <span class="muted">
            按下面的用量刷新间隔与批量并发，定期拉取账号的积分用量与订阅信息
          </span>
        </a-form-item>
        <a-form-item label="密钥刷新间隔" class="field-inline">
          <a-input-number
            :value="settings.keyRefreshInterval"
            :min="1"
            :max="600"
            :step="5"
            addon-after="分钟"
            style="width: 180px"
            :disabled="!settings.autoRefresh"
            @change="(v: unknown) => update({ keyRefreshInterval: Number(v) || DEFAULT_SETTINGS.keyRefreshInterval })"
          />
          <span class="muted">
            多久检查一次即将过期的密钥
            <span class="next-refresh">{{ nextKeyRefreshText }}</span>
          </span>
        </a-form-item>
        <a-form-item label="用量刷新间隔" class="field-inline">
          <a-input-number
            :value="settings.usageRefreshInterval"
            :min="1"
            :max="600"
            :step="5"
            addon-after="分钟"
            style="width: 180px"
            :disabled="!settings.autoRefreshUsage"
            @change="(v: unknown) => update({ usageRefreshInterval: Number(v) || DEFAULT_SETTINGS.usageRefreshInterval })"
          />
          <span class="muted">
            多久拉取一次积分用量与订阅信息
            <span class="next-refresh">{{ nextUsageRefreshText }}</span>
          </span>
        </a-form-item>
        <a-form-item label="批量并发" class="field-inline">
          <a-input-number
            :value="settings.concurrency"
            :min="1"
            :max="20"
            style="width: 180px"
            @change="(v: unknown) => update({ concurrency: Number(v) || 5 })"
          />
          <span class="muted">并发过高容易被限流</span>
        </a-form-item>
        <a-form-item label="删除前确认">
          <SettingSwitch field="confirmBeforeDelete" />
        </a-form-item>
      </a-form>
      <ul class="tips">
        <li>自动刷新密钥只处理 30 分钟内即将过期的账号；自动刷新用量会覆盖全部非封禁账号。</li>
        <li>两个间隔各自独立计时，撞在一起时按「密钥 → 用量」先后串行执行，不会丢轮。</li>
        <li>账号很多时建议把用量刷新间隔调大一些，全量拉取用量的请求量随账号数线性增长。</li>
        <li>手动批量操作进行中时定时任务会等待，操作结束后立即补跑到期的那一轮。</li>
        <li>窗口最小化到托盘、电脑睡眠唤醒后错过的轮次都会自动补跑，不需要重开窗口。</li>
        <li>
          主动续期只对 IDE 当前激活的那一个账号维护定时器，续期成功后写回磁盘并刷新界面；
          该账号一旦不再是 IDE 当前账号就自动停止，交给 IDE 自身兜底。
        </li>
      </ul>
    </a-card>

    <a-card size="small" title="网络" style="margin-bottom: 16px">
      <a-form v-bind="FORM_LAYOUT">
        <a-form-item label="用量接口">
          <a-radio-group
            :value="settings.usageApiType"
            @change="(e: any) => update({ usageApiType: e.target.value })"
          >
            <a-radio value="rest">REST（q.*.amazonaws.com，推荐）</a-radio>
            <a-radio value="cbor">CBOR（app.kiro.dev 门户）</a-radio>
          </a-radio-group>
        </a-form-item>
        <a-form-item label="启用代理">
          <SettingSwitch field="proxyEnabled" />
        </a-form-item>
        <a-form-item label="代理地址">
          <a-input-group compact>
            <a-input
              v-model:value="proxyDraft"
              placeholder="http://127.0.0.1:7890"
              style="width: 300px"
            />
            <a-button type="primary" @click="saveProxy">保存</a-button>
          </a-input-group>
          <div class="muted" style="font-size: 12px">
            留空则回退到系统环境变量 HTTPS_PROXY / HTTP_PROXY
          </div>
        </a-form-item>
      </a-form>
    </a-card>

    <a-card size="small" title="批量导入" style="margin-bottom: 16px">
      <a-form v-bind="FORM_LAYOUT">
        <a-form-item label="并发数" class="field-inline">
          <a-input-number
            :value="settings.importConcurrency"
            :min="1"
            :max="100"
            :step="5"
            style="width: 180px"
            @change="(v: unknown) => update({ importConcurrency: clampImportConcurrency(v) })"
          />
          <span class="muted">
            同时验证的账号数量，过大可能导致 API 限流
          </span>
        </a-form-item>
      </a-form>
      <ul class="tips">
        <li>建议范围 10-100。设置过大可能导致大量「验证失败」，设置过小则导入速度较慢。</li>
        <li>导入几千条时会按这个并发分批校验，不会一次性发起全部请求。</li>
        <li>与「账号刷新」里的批量并发相互独立，互不影响。</li>
      </ul>
    </a-card>

    <a-card size="small" title="系统托盘" style="margin-bottom: 16px">
      <a-form v-bind="FORM_LAYOUT">
        <a-form-item label="启用系统托盘" class="field-inline">
          <SettingSwitch field="trayEnabled" />
          <span class="muted">在系统托盘显示图标</span>
        </a-form-item>
        <a-form-item label="关闭按钮行为" class="field-inline">
          <a-select
            :value="closeAction"
            :options="closeActionOptions"
            :disabled="settings.trayEnabled === false"
            :get-popup-container="bodyPopupContainer"
            style="width: 180px"
            @change="(v: unknown) => update({ closeAction: v as AppSettings['closeAction'] })"
          />
          <span class="muted">点击关闭按钮时的行为</span>
        </a-form-item>
      </a-form>
      <ul class="tips">
        <li>双击托盘图标可以显示主窗口</li>
        <li>右键托盘图标可以显示菜单</li>
        <li>托盘菜单可以查看当前账户信息和用量</li>
      </ul>
    </a-card>

    <a-card size="small" title="数据管理" style="margin-bottom: 16px">
      <div class="data-row">
        <div class="data-row-text">
          <div class="data-row-title">导出数据</div>
          <div class="muted">支持 JSON 完整备份、卡密、CSV、TXT，也可直接复制到剪贴板</div>
        </div>
        <a-button @click="openExport">
          <template #icon><DownloadOutlined /></template>
          导出
        </a-button>
      </div>

      <div class="data-row">
        <div class="data-row-text">
          <div class="data-row-title">导入数据</div>
          <div class="muted">从文件或粘贴内容导入账号，完整备份可原样恢复</div>
        </div>
        <a-button @click="importOpen = true">
          <template #icon><UploadOutlined /></template>
          导入
        </a-button>
      </div>

      <div class="data-row">
        <div class="data-row-text">
          <div class="data-row-title danger">清除所有数据</div>
          <div class="muted">删除本应用保存的全部账号，操作不可撤销</div>
        </div>
        <a-button danger type="primary" @click="clearAll">
          <template #icon><DeleteOutlined /></template>
          清除
        </a-button>
      </div>
    </a-card>

    <a-card size="small" title="初始化" style="margin-bottom: 16px">
      <div class="data-row">
        <div class="data-row-text">
          <div class="data-row-title">恢复默认设置</div>
          <div class="muted">
            把上面所有设置项（外观、刷新、网络、导入、托盘等）恢复到初始值，账号数据不受影响
          </div>
        </div>
        <a-button type="primary" danger :loading="resetting" @click="resetSettings">
          <template #icon><ReloadOutlined /></template>
          初始化
        </a-button>
      </div>
    </a-card>

    <a-card size="small" title="存储位置">
      <a-descriptions :column="1" size="small">
        <a-descriptions-item label="账号数量">{{ accountCount }}</a-descriptions-item>
        <a-descriptions-item label="存储文件">
          <span class="mono">{{ settingsStore.appInfo?.storePath || '-' }}</span>
        </a-descriptions-item>
        <a-descriptions-item label="备份目录">
          <span class="mono">{{ settingsStore.appInfo?.backupDir || '-' }}</span>
        </a-descriptions-item>
      </a-descriptions>
      <a-space style="margin-top: 8px">
        <a-button @click="openPath('store')">
          <template #icon><FolderOpenOutlined /></template>
          打开数据目录
        </a-button>
        <a-button @click="openPath('backup')">
          <template #icon><FolderOpenOutlined /></template>
          打开备份目录
        </a-button>
      </a-space>
    </a-card>

    <ExportAccountsModal v-model:open="exportOpen" />
    <ImportAccountsModal v-model:open="importOpen" />
  </div>
</template>

<style scoped>
.color-dot {
  width: 24px;
  height: 24px;
  border-radius: 50%;
  border: 2px solid transparent;
  cursor: pointer;
  padding: 0;
  outline-offset: 2px;
}

.color-dot.selected {
  border-color: rgba(0, 0, 0, 0.45);
  box-shadow: 0 0 0 2px rgba(255, 255, 255, 0.6) inset;
}

/*
 * 控件与右侧说明文字默认按基线对齐，说明文字会偏下。
 * 改成 flex 居中，让两者垂直对齐。
 */
.field-inline :deep(.ant-form-item-control-input-content) {
  display: flex;
  align-items: center;
}

/* 说明文字与控件间距统一，且可换行、不挤压前面的控件 */
.field-inline :deep(.ant-form-item-control-input-content) > .muted {
  min-width: 0;
  margin-left: 10px;
}

/* 下次刷新时间单独占一行，跟在说明文字下方 */
.next-refresh {
  display: block;
  margin-top: 2px;
  font-size: 12px;
}

/* 数据管理里的「说明 + 右侧操作」行 */
.data-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 12px 0;
  border-top: 1px solid var(--kal-border);
}

.data-row:first-child {
  padding-top: 0;
  border-top: none;
}

.data-row:last-child {
  padding-bottom: 0;
}

.data-row-text {
  min-width: 0;
}

.data-row-title {
  font-weight: 600;
  margin-bottom: 2px;
}

.data-row-title.danger {
  color: var(--kal-danger, #ff4d4f);
}

.data-row .muted {
  font-size: 12px;
}

/* 卡片底部的补充说明 */
.tips {
  margin: 0;
  padding: 10px 12px 10px 26px;
  border-radius: 8px;
  background: var(--kal-block-bg);
  color: var(--kal-muted);
  font-size: 12px;
  line-height: 1.9;
}
</style>
