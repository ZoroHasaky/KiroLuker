<script setup lang="ts">
/**
 * 账号导入统一弹窗：在同一处提供文件导入与文本导入，两种方式共用解析和 store action。
 */
import { computed, nextTick, ref, watch } from 'vue'
import { message } from 'ant-design-vue'
import {
  CodeOutlined,
  DeleteOutlined,
  ImportOutlined,
  InboxOutlined,
  LoadingOutlined
} from '@ant-design/icons-vue'
import { useAccountsStore } from '@/stores/accounts'
import { useSettingsStore } from '@/stores/settings'
import { parseImportContent, type ParsedImport } from '@/utils/transfer'
import { DEFAULT_SETTINGS, type BatchResult } from '@shared/types'

export type ImportMode = 'file' | 'text'

const props = withDefaults(
  defineProps<{
    open: boolean
    initialMode?: ImportMode
  }>(),
  {
    initialMode: 'file'
  }
)
const emit = defineEmits<{ 'update:open': [boolean] }>()

const accountsStore = useAccountsStore()
const settingsStore = useSettingsStore()
const mode = ref<ImportMode>(props.initialMode)

interface Entry {
  /** 列表内唯一 key，同名文件也能各自删除 */
  uid: string
  name: string
  size: number
  parsed?: ParsedImport
  /** 读取或解析失败的原因；有值时该文件不参与导入 */
  error?: string
}

const entries = ref<Entry[]>([])
const fileImporting = ref(false)
/** 正在导入第几个文件（1 基），0 表示未开始 */
const currentIndex = ref(0)
const currentName = ref('')
const fileResult = ref<BatchResult | null>(null)

const text = ref('')
const textImporting = ref(false)
const textResult = ref<BatchResult | null>(null)

const isImporting = computed(() => fileImporting.value || textImporting.value)
const importConcurrency = computed(
  () => settingsStore.settings.importConcurrency || DEFAULT_SETTINGS.importConcurrency
)

/** 可导入的文件（排除解析失败的） */
const usable = computed(() => entries.value.filter((entry) => !entry.error && entry.parsed))
/** 还在读取中的文件：此时不能开始导入，否则它们会被漏掉 */
const pendingCount = computed(
  () => entries.value.filter((entry) => !entry.error && !entry.parsed).length
)
const totalCount = computed(() => usable.value.reduce((sum, entry) => sum + entryCount(entry), 0))
/** 是否存在需要联网校验的凭证条目 */
const hasCredentialItems = computed(() =>
  usable.value.some((entry) => !entry.parsed?.fullData && (entry.parsed?.items.length ?? 0) > 0)
)

const placeholder = `支持以下任意一种格式：

1) 卡密：邮箱----密码----RefreshToken----ClientId----ClientSecret----登录方式
2) 精简 JSON 数组：[{ "email": "a@b.c", "refreshToken": "...", "provider": "BuilderId" }]
3) 本应用导出的完整 JSON（含用量、订阅快照）
4) CSV（带表头）/ TXT（邮箱,RefreshToken,昵称,登录方式）`

/** 文本解析结果由预览与提交共用，避免重复解析大量输入。 */
const parsedText = computed(() => (text.value.trim() ? parseImportContent(text.value) : null))
const textPreview = computed(() => {
  const data = parsedText.value
  if (!data) return null
  if (data.fullData) {
    return { kind: '完整备份', count: data.fullData.accounts?.length ?? 0 }
  }
  return { kind: '凭证条目', count: data.items.length }
})

const MAX_VISIBLE_MESSAGES = 200
const visibleFileMessages = computed(
  () => fileResult.value?.messages.slice(0, MAX_VISIBLE_MESSAGES) ?? []
)
const hiddenFileMessageCount = computed(() =>
  Math.max(0, (fileResult.value?.messages.length ?? 0) - MAX_VISIBLE_MESSAGES)
)
const visibleTextMessages = computed(
  () => textResult.value?.messages.slice(0, MAX_VISIBLE_MESSAGES) ?? []
)
const hiddenTextMessageCount = computed(() =>
  Math.max(0, (textResult.value?.messages.length ?? 0) - MAX_VISIBLE_MESSAGES)
)

/** 只展示本次文本导入自身的校验进度。 */
const textValidationProgress = computed(() => {
  const task = accountsStore.task
  if (!textImporting.value || !task.running || task.type !== 'import-validation') return null
  return `校验进度 ${task.done}/${task.total}`
})

function reset(): void {
  mode.value = props.initialMode
  entries.value = []
  fileResult.value = null
  currentIndex.value = 0
  currentName.value = ''
  text.value = ''
  textResult.value = null
}

watch(
  () => props.open,
  (open) => {
    if (open) reset()
  },
  { immediate: true }
)

watch(
  () => props.initialMode,
  (value) => {
    if (props.open && !isImporting.value) mode.value = value
  }
)

function entryCount(entry: Entry): number {
  const parsed = entry.parsed
  if (!parsed) return 0
  return parsed.fullData ? (parsed.fullData.accounts?.length ?? 0) : parsed.items.length
}

function entryKind(entry: Entry): string {
  if (entry.error) return '无法解析'
  return entry.parsed?.fullData ? '完整备份' : '凭证条目'
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/** a-upload 必须同步返回 false，文件读取在后台异步完成。 */
function beforeUpload(file: File): boolean {
  void addFile(file)
  return false
}

async function addFile(file: File): Promise<void> {
  if (entries.value.some((entry) => entry.name === file.name && entry.size === file.size)) {
    message.info(`${file.name} 已在列表中`)
    return
  }

  const entry: Entry = {
    uid: `${file.name}-${file.size}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name: file.name,
    size: file.size
  }
  entries.value = [...entries.value, entry]

  try {
    const content = (await file.text()).replace(/^\ufeff/, '')
    if (!content.trim()) throw new Error('文件内容为空')
    const parsed = parseImportContent(content)
    const count = parsed.fullData ? (parsed.fullData.accounts?.length ?? 0) : parsed.items.length
    if (count === 0) throw new Error('没有解析出有效凭证，请检查格式')
    updateEntry(entry.uid, { parsed })
  } catch (error) {
    updateEntry(entry.uid, { error: error instanceof Error ? error.message : String(error) })
  }
}

function updateEntry(uid: string, patch: Partial<Entry>): void {
  entries.value = entries.value.map((entry) =>
    entry.uid === uid ? { ...entry, ...patch } : entry
  )
}

function removeEntry(uid: string): void {
  entries.value = entries.value.filter((entry) => entry.uid !== uid)
}

function clearFiles(): void {
  entries.value = []
  fileResult.value = null
}

function close(): void {
  if (!isImporting.value) emit('update:open', false)
}

/** 按列表顺序逐个导入，汇总成一份结果。 */
async function submitFiles(): Promise<void> {
  if (pendingCount.value) return void message.warning('还有文件正在读取，请稍候')
  const list = usable.value
  if (list.length === 0) return void message.warning('请先添加可导入的文件')

  fileImporting.value = true
  const merged: BatchResult = { success: 0, failed: 0, skipped: 0, messages: [] }
  try {
    for (let index = 0; index < list.length; index++) {
      const entry = list[index]
      currentIndex.value = index + 1
      currentName.value = entry.name

      const parsed = entry.parsed as ParsedImport
      let single: BatchResult
      if (parsed.fullData) {
        await nextTick()
        single = accountsStore.importFullData(parsed.fullData)
      } else {
        single = await accountsStore.importItems(parsed.items)
      }

      merged.success += single.success
      merged.failed += single.failed
      merged.skipped += single.skipped
      merged.messages.push(
        `【${entry.name}】成功 ${single.success}，跳过 ${single.skipped}，失败 ${single.failed}`,
        ...single.messages.map((line) => `  ${line}`)
      )
    }

    fileResult.value = merged
    const summary = `成功 ${merged.success}，跳过 ${merged.skipped}，失败 ${merged.failed}`
    if (merged.success) message.success(`${list.length} 个文件导入完成：${summary}`)
    else message.warning(`没有成功导入的账号（${summary}）`)
    if (merged.success && !merged.failed) emit('update:open', false)
  } finally {
    fileImporting.value = false
    currentIndex.value = 0
    currentName.value = ''
  }
}

async function submitText(): Promise<void> {
  const data = parsedText.value
  if (!data) return void message.warning('请先粘贴要导入的内容')

  textImporting.value = true
  try {
    if (data.fullData) {
      const result = accountsStore.importFullData(data.fullData)
      textResult.value = result
      message.success(`恢复完成：新增 ${result.success}，跳过 ${result.skipped}`)
      if (!result.failed) emit('update:open', false)
      return
    }

    if (data.items.length === 0) {
      return void message.error('没有解析出有效凭证，请检查格式')
    }
    const result = await accountsStore.importItems(data.items)
    textResult.value = result
    if (result.success) {
      message.success(
        `导入完成：成功 ${result.success}，跳过 ${result.skipped}，失败 ${result.failed}`
      )
    } else {
      message.warning(`没有成功导入的账号（跳过 ${result.skipped}，失败 ${result.failed}）`)
    }
    if (result.success && !result.failed) emit('update:open', false)
  } finally {
    textImporting.value = false
  }
}
</script>

<template>
  <a-modal
    :open="props.open"
    width="700px"
    centered
    :footer="null"
    :mask-closable="!isImporting"
    :closable="!isImporting"
    @cancel="close"
  >
    <template #title>
      <span class="modal-title">
        <ImportOutlined />
        导入账号
        <a-tag v-if="mode === 'file' && usable.length" color="blue" style="margin: 0">
          {{ usable.length }} 个文件 · 共 {{ totalCount }} 条
        </a-tag>
      </span>
    </template>

    <a-tabs v-model:active-key="mode" :animated="false">
      <a-tab-pane key="file" :disabled="textImporting">
        <template #tab>
          <span class="tab-label"><InboxOutlined />从文件导入</span>
        </template>

        <div class="tab-content">
          <a-upload-dragger
            class="tool-dragger"
            :multiple="true"
            :show-upload-list="false"
            accept=".json,.txt,.csv"
            :disabled="fileImporting"
            :before-upload="beforeUpload"
          >
            <div class="drop-inner">
              <p class="drop-icon"><InboxOutlined /></p>
              <p class="drop-title">点击选择，或把文件拖到这里</p>
              <p class="drop-hint">
                支持一次选择多个文件，按列表顺序依次导入。<br />
                可用格式：完整备份 JSON、精简 JSON、卡密 TXT、CSV
              </p>
            </div>
          </a-upload-dragger>

          <div v-if="entries.length" class="file-list">
            <div v-for="(entry, index) in entries" :key="entry.uid" class="file-row">
              <span class="file-index">{{ index + 1 }}</span>
              <div class="file-body">
                <div class="file-name">{{ entry.name }}</div>
                <div class="file-meta muted">
                  <template v-if="entry.error">
                    <span class="file-error">{{ entry.error }}</span>
                  </template>
                  <template v-else-if="entry.parsed">
                    {{ entryKind(entry) }} · {{ entryCount(entry) }} 条 ·
                    {{ formatSize(entry.size) }}
                  </template>
                  <template v-else>
                    <LoadingOutlined /> 正在读取…
                  </template>
                </div>
              </div>
              <a-tag v-if="entry.error" color="red" style="margin: 0">跳过</a-tag>
              <a-button
                type="text"
                size="small"
                danger
                :disabled="fileImporting"
                @click="removeEntry(entry.uid)"
              >
                <template #icon><DeleteOutlined /></template>
              </a-button>
            </div>
          </div>

          <div v-if="hasCredentialItems && !fileImporting" class="hint-line muted">
            凭证条目会在导入时联网校验并拉取用量，并发 {{ importConcurrency }}（可在设置里调整）
          </div>

          <a-alert
            v-if="fileImporting"
            type="info"
            show-icon
            style="margin-top: 12px"
            :message="`正在导入第 ${currentIndex}/${usable.length} 个文件：${currentName}`"
            :description="
              accountsStore.task.running && accountsStore.task.type === 'import-validation'
                ? `校验进度 ${accountsStore.task.done}/${accountsStore.task.total}`
                : undefined
            "
          />

          <template v-if="fileResult?.messages.length">
            <a-divider style="margin: 14px 0 10px" />
            <div class="section-title">导入日志</div>
            <div class="token-box mono" style="max-height: 160px">
              <div v-for="(line, index) in visibleFileMessages" :key="index">{{ line }}</div>
              <div v-if="hiddenFileMessageCount" class="muted">
                … 另有 {{ hiddenFileMessageCount }} 条未显示（避免一次渲染过多内容）
              </div>
            </div>
          </template>
        </div>
      </a-tab-pane>

      <a-tab-pane key="text" :disabled="fileImporting">
        <template #tab>
          <span class="tab-label"><CodeOutlined />输入 JSON 导入</span>
        </template>

        <div class="tab-content">
          <a-textarea v-model:value="text" :rows="12" :placeholder="placeholder" />

          <div v-if="textPreview" style="margin-top: 10px">
            <a-tag color="blue">识别为 {{ textPreview.kind }}</a-tag>
            <span class="muted">共 {{ textPreview.count }} 条</span>
            <span v-if="textPreview.kind === '凭证条目'" class="muted">
              · 导入时会联网校验并拉取用量，并发 {{ importConcurrency }}（可在设置里调整）
            </span>
          </div>

          <a-alert
            v-if="textValidationProgress"
            type="info"
            show-icon
            style="margin-top: 10px"
            :message="textValidationProgress"
          />

          <template v-if="textResult?.messages.length">
            <a-divider style="margin: 14px 0 10px" />
            <div class="section-title">导入日志</div>
            <div class="token-box mono" style="max-height: 140px">
              <div v-for="(line, index) in visibleTextMessages" :key="index">{{ line }}</div>
              <div v-if="hiddenTextMessageCount" class="muted">
                … 另有 {{ hiddenTextMessageCount }} 条未显示（避免一次渲染过多内容）
              </div>
            </div>
          </template>
        </div>
      </a-tab-pane>
    </a-tabs>

    <a-space class="modal-actions">
      <a-button :disabled="isImporting" @click="close">关闭</a-button>
      <template v-if="mode === 'file'">
        <a-button v-if="entries.length" :disabled="fileImporting" @click="clearFiles">
          清空列表
        </a-button>
        <a-button
          type="primary"
          :loading="fileImporting || pendingCount > 0"
          :disabled="usable.length === 0 || pendingCount > 0"
          @click="submitFiles"
        >
          <template #icon><ImportOutlined /></template>
          开始导入{{ usable.length ? `（${usable.length} 个文件）` : '' }}
        </a-button>
      </template>
      <a-button v-else type="primary" :loading="textImporting" @click="submitText">
        <template #icon><ImportOutlined /></template>
        开始导入
      </a-button>
    </a-space>
  </a-modal>
</template>

<style scoped>
.modal-title,
.tab-label {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}

.tab-content {
  min-height: 330px;
}

.tool-dragger {
  display: block;
}

.tool-dragger :deep(.ant-upload-drag) {
  min-height: 220px;
}

.drop-inner {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  min-height: 190px;
}

.drop-icon {
  margin: 0 0 12px;
  font-size: 56px;
  line-height: 1;
  color: var(--kal-primary);
}

.drop-title {
  margin: 0 0 6px;
  font-size: 16px;
}

.drop-hint {
  margin: 0 auto;
  max-width: 440px;
  color: var(--kal-muted);
  font-size: 12.5px;
  line-height: 1.8;
}

.file-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-height: 240px;
  overflow-y: auto;
  margin-top: 14px;
}

.file-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  border-radius: 10px;
  background: var(--kal-block-bg);
}

.file-index {
  flex: 0 0 auto;
  width: 20px;
  text-align: center;
  color: var(--kal-muted);
  font-size: 12px;
}

.file-body {
  flex: 1 1 auto;
  min-width: 0;
}

.file-name {
  font-size: 13px;
  word-break: break-all;
}

.file-meta {
  margin-top: 1px;
  font-size: 12px;
}

.file-error {
  color: #cf1322;
}

.hint-line {
  margin-top: 10px;
  font-size: 12px;
}

.modal-actions {
  display: flex;
  justify-content: flex-end;
  width: 100%;
  margin-top: 16px;
}
</style>
