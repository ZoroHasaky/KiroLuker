<script setup lang="ts">
import { computed, ref } from 'vue'
import {
  CheckCircleFilled,
  CommentOutlined,
  GithubOutlined,
  HeartFilled,
  SyncOutlined
} from '@ant-design/icons-vue'
import { message } from 'ant-design-vue'
import { useSettingsStore } from '@/stores/settings'
import { useUpdateStore } from '@/stores/update'
import kiroLogo from '@/assets/kiro-logo.png'
import qqGroup from '@/assets/qq-group.jpg'
import authorAvatar from '@/assets/author_avatar.jpg'
import sponsorWechat from '@/assets/sponsor_wechat.jpg'
import sponsorAlipay from '@/assets/sponsor_alipay.jpg'

const settingsStore = useSettingsStore()
const updateStore = useUpdateStore()
const info = computed(() => settingsStore.appInfo)

// ============ 检查更新 ============
const checking = computed(() => updateStore.checking)
const checkResult = computed(() => updateStore.result)
const upToDateOpen = ref(false)
const groupOpen = ref(false)

/** 手动检查始终访问 GitHub，绕过冷启动缓存。 */
async function checkUpdate(): Promise<void> {
  if (checking.value) return
  const response = await updateStore.checkNow()
  if (response.error) {
    message.error(response.error)
    return
  }
  if (response.data && !response.data.hasUpdate) upToDateOpen.value = true
}

const author = {
  name: 'lucks-cloud',
  url: 'https://github.com/lucks-cloud',
  avatar: authorAvatar
}

const sponsors = [
  { label: '微信', image: sponsorWechat },
  { label: '支付宝', image: sponsorAlipay }
]

const links = [
  { label: '原项目 Kiro-account-manager', url: 'https://github.com/chaogei/Kiro-account-manager' },
  { label: 'Kiro 官网', url: 'https://kiro.dev' }
]

function open(url: string): void {
  void window.api.openExternal(url)
}
</script>

<template>
  <div>
    <!-- 头部：品牌标识 + 版本 + 检查更新 / 交流群 -->
    <section class="hero">
      <span class="hero-blob hero-blob-a" />
      <span class="hero-blob hero-blob-b" />
      <div class="hero-main">
        <div class="wordmark">
          <img class="wordmark-logo" :src="kiroLogo" alt="Kiro" />
          <span class="wordmark-text">kiro</span>
        </div>
        <h2 class="hero-title">Kiro 账户管理器</h2>
        <p class="hero-version muted">版本 {{ info?.version || '-' }}</p>
        <a-space :size="12" wrap class="hero-actions">
          <a-button :loading="checking" @click="checkUpdate">
            <template #icon><SyncOutlined /></template>
            检查更新
          </a-button>
          <a-button @click="groupOpen = true">
            <template #icon><CommentOutlined /></template>
            加入交流群
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

    <a-card size="small" title="说明" style="margin-bottom: 16px">
      <ul style="margin: 0; padding-left: 20px; line-height: 1.9">
        <li>账号凭证保存在本机 electron-store 加密文件中，不会上传到任何服务器。</li>
        <li>
          切号会写入 <span class="mono">~/.aws/sso/cache/kiro-auth-token.json</span>，
          写盘前会强制刷新一次 Token，避免 Kiro IDE 拿到已作废的 Refresh Token 被强制登出。
        </li>
        <li>刷新密钥只在该账号确实是 IDE 当前登录账号时才回写磁盘，不会覆盖正在使用的账号。</li>
        <li>批量操作并发可在设置里调整，并发过高容易触发接口限流。</li>
      </ul>
    </a-card>

    <a-card size="small" title="作者" style="margin-bottom: 16px">
      <div class="author">
        <a-avatar :size="56" :src="author.avatar" alt="作者头像" />
        <div class="author-main">
          <div class="author-name">{{ author.name }}</div>
          <!-- 保留 href 让链接可聚焦，实际跳转交给系统浏览器 -->
          <a
            class="author-link mono"
            :href="author.url"
            @click.prevent="open(author.url)"
          >
            {{ author.url }}
          </a>
        </div>
        <a-button @click="open(author.url)">
          <template #icon><GithubOutlined /></template>
          GitHub 主页
        </a-button>
      </div>
    </a-card>

    <a-card size="small" title="赞助支持" style="margin-bottom: 16px">
      <p class="muted" style="margin: 0 0 14px">
        <HeartFilled style="color: #eb2f96" />
        本项目免费开源，如果它帮你省了力气，可以请作者喝杯咖啡，完全自愿。
      </p>
      <div class="sponsor-grid">
        <div v-for="item in sponsors" :key="item.label" class="sponsor-item">
          <img class="sponsor-qr" :src="item.image" :alt="`${item.label}收款码`" />
          <span class="sponsor-label muted">{{ item.label }}</span>
        </div>
      </div>
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

    <!-- 已是最新版 -->
    <a-modal v-model:open="upToDateOpen" title="检查更新" :width="380" centered>
      <div class="check-result">
        <CheckCircleFilled class="check-icon ok" />
        <div class="check-title">已是最新版本</div>
        <div class="muted">当前版本 v{{ checkResult?.current || info?.version || '-' }}</div>
      </div>
      <template #footer>
        <a-button type="primary" @click="upToDateOpen = false">好的</a-button>
      </template>
    </a-modal>

    <!-- 用户交流群 -->
    <a-modal v-model:open="groupOpen" title="用户交流群" :width="440" centered :footer="null">
      <div class="group-box">
        <img class="group-qr" :src="qqGroup" alt="QQ 交流群二维码" />
        <span class="muted group-tip">用 QQ 扫码加入交流群</span>
      </div>
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

/* logo + 文字组成的品牌标识 */
.wordmark {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
}

.wordmark-logo {
  width: 56px;
  height: 56px;
  border-radius: 14px;
  object-fit: cover;
}

.wordmark-text {
  font-size: 48px;
  font-weight: 700;
  line-height: 1;
  letter-spacing: -1px;
}

.hero-title {
  margin: 22px 0 8px;
  font-size: 20px;
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

/* ============ 交流群弹窗 ============ */
.group-box {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
}

/* 原图是竖长图，宽度撑满弹窗的同时限高，避免小窗口下弹窗超出视口 */
.group-qr {
  width: 100%;
  max-width: 380px;
  height: auto;
  max-height: 62vh;
  object-fit: contain;
  border-radius: 8px;
  background: #fff;
}

.group-tip {
  font-size: 12px;
}

.author {
  display: flex;
  align-items: center;
  gap: 14px;
}

.author-main {
  flex: 1 1 auto;
  min-width: 0;
}

.author-name {
  font-size: 16px;
  font-weight: 600;
}

.author-link {
  font-size: 12px;
  word-break: break-all;
}

.sponsor-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 16px;
}

.sponsor-item {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  padding: 10px;
  border-radius: 10px;
  background: var(--kal-block-bg);
}

/* 只固定宽度，高度按原图比例走，避免二维码被压变形 */
.sponsor-qr {
  width: 260px;
  height: auto;
  border-radius: 8px;
  background: #fff;
}

.sponsor-label {
  font-size: 12px;
}
</style>
