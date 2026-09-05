<script setup lang="ts">
import { computed, ref } from 'vue'
import {
  CheckCircleFilled,
  CloseCircleFilled,
  GithubOutlined,
  SyncOutlined,
} from '@ant-design/icons-vue'
import { useSettingsStore } from '@/stores/settings'
import { useUpdateStore } from '@/stores/update'
import kirolukerLogo from '@/assets/kiroluker-logo.png'

const settingsStore = useSettingsStore()
const updateStore = useUpdateStore()
const info = computed(() => settingsStore.appInfo)

// ============ 检查更新 ============
const checking = computed(() => updateStore.checking)
const checkResult = computed(() => updateStore.result)
const checkOpen = ref(false)
const checkError = ref('')

/** 手动检查始终访问 GitHub；先打开状态弹窗，再在弹窗中呈现最终结果。 */
async function checkUpdate(): Promise<void> {
  if (checking.value) return
  checkError.value = ''
  checkOpen.value = true
  const response = await updateStore.checkNow()
  if (response.error) {
    checkError.value = response.error
    return
  }
  // 发现新版本时关闭状态弹窗，由全局 UpdateAvailableModal 接管更新详情。
  if (response.data?.hasUpdate) checkOpen.value = false
  else if (!response.data) checkError.value = '没有收到有效的版本检查结果，请稍后重试'
}

function manualUpdate(): void {
  checkOpen.value = false
  open(`${PROJECT_REPO_URL}/releases`)
}

const PROJECT_REPO_URL = 'https://github.com/ZoroHasaky/KiroLuker'
/** 改名前的上游仓库，保留用于开源归属与历史追溯。 */
const UPSTREAM_REPO_URL = 'https://github.com/lucks-cloud/kiro-manager-lite'

const links = [
  { label: '上游项目 kiro-manager-lite', url: UPSTREAM_REPO_URL },
  { label: '参考项目 Kiro-account-manager', url: 'https://github.com/chaogei/Kiro-account-manager' },
  { label: 'Kiro 官网', url: 'https://github.com/kirodotdev/Kiro' }
]

function open(url: string): void {
  void window.api.openExternal(url)
}
</script>

<template>
  <div>
    <!-- 头部：品牌标识、版本与更新入口 -->
    <section class="hero">
      <span class="hero-blob hero-blob-a" />
      <span class="hero-blob hero-blob-b" />
      <div class="hero-main">
        <img class="hero-logo" :src="kirolukerLogo" alt="KiroLuker" />
        <h2 class="hero-title">KiroLuker</h2>
        <p class="hero-version muted">版本 {{ info?.version || '-' }}</p>
        <a-space :size="12" wrap class="hero-actions">
          <a-button :loading="checking" @click="checkUpdate">
            <template #icon><SyncOutlined /></template>
            检查更新
          </a-button>
          <a-button @click="open(PROJECT_REPO_URL)">
            <template #icon><GithubOutlined /></template>
            项目仓库
          </a-button>
        </a-space>
      </div>
    </section>

    <a-card size="small" title="版本信息" style="margin-bottom: 16px">
      <a-descriptions :column="2" size="small">
        <a-descriptions-item label="应用版本">{{ info?.version || '-' }}</a-descriptions-item>
        <a-descriptions-item label="平台">{{ info?.platform || '-' }}</a-descriptions-item>
        <a-descriptions-item label="Electron">{{ info?.electron || '-' }}</a-descriptions-item>
        <a-descriptions-item label="Chromium">{{ info?.chrome || '-' }}</a-descriptions-item>
        <a-descriptions-item label="Node">{{ info?.node || '-' }}</a-descriptions-item>
        <a-descriptions-item label="技术栈">Vue 3 · Vite · Pinia · Ant Design Vue · Electron</a-descriptions-item>
      </a-descriptions>
    </a-card>

    <a-card size="small" title="致谢与许可" class="credits-card">
      <p class="muted" style="margin: 0 0 14px">
        账户管理相关的接口实现参考了开源项目 Kiro-account-manager（AGPL-3.0），本项目在其基础上重写为
        Vue 技术栈并裁剪为纯账户管理。
      </p>
      <a-space wrap>
        <a-button v-for="link in links" :key="link.url" @click="open(link.url)">
          <template #icon><GithubOutlined /></template>
          {{ link.label }}
        </a-button>
      </a-space>
    </a-card>

    <!-- 手动检查状态：点击后立即打开，加载、失败、已是最新版都在同一弹窗内呈现。 -->
    <a-modal
      v-if="checkOpen"
      v-model:open="checkOpen"
      title="检查更新"
      :width="420"
      centered
      :closable="!checking"
      :mask-closable="!checking"
      :keyboard="!checking"
    >
      <div class="check-result" aria-live="polite">
        <template v-if="checking">
          <a-spin size="large" class="check-spinner" />
          <div class="check-title">正在检查更新</div>
          <div class="check-detail muted">正在连接 GitHub 并获取最新版本，请稍候…</div>
        </template>
        <template v-else-if="checkError">
          <CloseCircleFilled class="check-icon error" />
          <div class="check-title">检查更新失败</div>
          <div class="check-error">{{ checkError }}</div>
          <div class="check-detail muted">可以稍后重试，或前往项目主页手动下载最新版本。</div>
        </template>
        <template v-else>
          <CheckCircleFilled class="check-icon ok" />
          <div class="check-title">已是最新版本</div>
          <div class="check-detail muted">
            当前版本 v{{ checkResult?.current || info?.version || '-' }}
          </div>
        </template>
      </div>
      <template #footer>
        <span v-if="checking" class="check-footer-loading muted">正在检查，请勿关闭…</span>
        <template v-else-if="checkError">
          <a-button @click="checkOpen = false">关闭</a-button>
          <a-button @click="checkUpdate">
            <template #icon><SyncOutlined /></template>
            重新检查
          </a-button>
          <a-button type="primary" @click="manualUpdate">
            <template #icon><GithubOutlined /></template>
            手动更新
          </a-button>
        </template>
        <a-button v-else type="primary" @click="checkOpen = false">好的</a-button>
      </template>
    </a-modal>

  </div>
</template>

<style scoped>
/* small 卡片默认 12px 内边距，大号按钮在其中显得贴边，单独放宽上下留白 */
.credits-card :deep(.ant-card-body) {
  padding: 16px 12px 20px;
}

/* 最后一张卡片别贴着内容区底边 */
.credits-card {
  margin-bottom: 24px;
}

/* ============ 头部横幅 ============ */
.hero {
  position: relative;
  overflow: hidden;
  margin-bottom: 16px;
  padding: 40px 24px 36px;
  border: 1px solid var(--kal-border);
  border-radius: 12px;
  background: var(--kal-card-bg);
  text-align: center;
}

.hero-blob {
  position: absolute;
  border-radius: 50%;
  filter: blur(40px);
  background: radial-gradient(circle, var(--kal-primary), transparent 70%);
  opacity: 0.18;
  pointer-events: none;
}

.hero-blob-a {
  top: -60px;
  right: -30px;
  width: 180px;
  height: 180px;
}

.hero-blob-b {
  bottom: -60px;
  left: -20px;
  width: 150px;
  height: 150px;
}

.hero-main {
  position: relative;
}

/* 品牌标识：logo 单独居中，应用名放在下方 */
.hero-logo {
  display: block;
  width: 72px;
  height: 72px;
  margin: 0 auto;
  border-radius: 18px;
  object-fit: cover;
}

.hero-title {
  margin: 18px 0 8px;
  font-size: 22px;
  font-weight: 700;
  color: var(--kal-primary);
}

.hero-version {
  margin: 0 0 24px;
  font-size: 13px;
}

/* ============ 检查更新弹窗 ============ */
.check-result {
  text-align: center;
  padding: 8px 0 4px;
}

.check-icon {
  font-size: 40px;
}

.check-icon.ok {
  color: #52c41a;
}

.check-icon.error {
  color: #ff4d4f;
}

.check-spinner {
  display: inline-flex;
  margin: 2px 0 4px;
}

.check-detail {
  max-width: 340px;
  margin: 0 auto;
  font-size: 12.5px;
  line-height: 1.7;
}

.check-error {
  max-width: 350px;
  margin: 0 auto 6px;
  color: #ff4d4f;
  font-size: 12.5px;
  line-height: 1.7;
  overflow-wrap: anywhere;
}

.check-footer-loading {
  display: inline-block;
  padding: 5px 0;
  font-size: 12px;
}

.check-icon.new {
  color: var(--kal-primary);
}

.check-title {
  margin: 10px 0 6px;
  font-size: 16px;
  font-weight: 600;
}

.version-flow {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
}

.version-chip {
  padding: 2px 10px;
  border-radius: 6px;
  font-size: 13px;
  background: var(--kal-block-bg);
}

.version-chip.new {
  color: #fff;
  background: var(--kal-primary);
}

.release-time {
  margin-top: 8px;
  font-size: 12px;
}

.release-notes {
  margin-top: 16px;
  padding: 12px;
  border-radius: 8px;
  background: var(--kal-block-bg);
}

.release-notes-title {
  font-size: 12px;
  margin-bottom: 6px;
}

/* 更新说明可能很长，限高滚动 */
.release-notes-body {
  max-height: 260px;
  overflow: auto;
  font-size: 13px;
  line-height: 1.75;
  word-break: break-word;
}

/* ============ Markdown 正文（v-html，需要 deep 穿透）============ */
.markdown :deep(> *:first-child) {
  margin-top: 0;
}

.markdown :deep(> *:last-child) {
  margin-bottom: 0;
}

.markdown :deep(h1),
.markdown :deep(h2),
.markdown :deep(h3),
.markdown :deep(h4) {
  margin: 14px 0 6px;
  font-size: 14px;
  font-weight: 600;
  line-height: 1.5;
}

.markdown :deep(h1) {
  font-size: 16px;
}

.markdown :deep(h2) {
  font-size: 15px;
}

.markdown :deep(p) {
  margin: 0 0 8px;
}

.markdown :deep(ul),
.markdown :deep(ol) {
  margin: 0 0 8px;
  padding-left: 20px;
}

.markdown :deep(li) {
  margin: 2px 0;
}

.markdown :deep(li > p) {
  margin: 0;
}

.markdown :deep(a) {
  color: var(--kal-primary);
}

.markdown :deep(code) {
  padding: 1px 5px;
  border-radius: 4px;
  font-size: 12px;
  font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace;
  background: var(--kal-code-bg);
}

.markdown :deep(pre) {
  margin: 0 0 8px;
  padding: 10px 12px;
  border-radius: 6px;
  overflow: auto;
  background: var(--kal-code-bg);
}

/* 代码块内的 code 不再叠一层底色 */
.markdown :deep(pre code) {
  padding: 0;
  background: none;
}

.markdown :deep(blockquote) {
  margin: 0 0 8px;
  padding: 2px 0 2px 10px;
  border-left: 3px solid var(--kal-border);
  color: var(--kal-muted);
}

.markdown :deep(hr) {
  margin: 12px 0;
  border: none;
  border-top: 1px solid var(--kal-border);
}

.markdown :deep(img) {
  max-width: 100%;
}

.markdown :deep(table) {
  width: 100%;
  margin: 0 0 8px;
  border-collapse: collapse;
  font-size: 12px;
}

.markdown :deep(th),
.markdown :deep(td) {
  padding: 5px 8px;
  border: 1px solid var(--kal-border);
  text-align: left;
}

</style>
