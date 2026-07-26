<script setup lang="ts">
import { computed } from 'vue'
import { GithubOutlined, HeartFilled } from '@ant-design/icons-vue'
import { useSettingsStore } from '@/stores/settings'
import authorAvatar from '@/assets/author_avatar.jpg'
import sponsorWechat from '@/assets/sponsor_wechat.jpg'
import sponsorAlipay from '@/assets/sponsor_alipay.jpg'

const settingsStore = useSettingsStore()
const info = computed(() => settingsStore.appInfo)

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
    <a-card size="small" style="margin-bottom: 16px">
      <a-space align="start" :size="16">
        <!-- 底色跟随主题色，其余样式走 scoped class -->
        <div class="brand-mark" :style="{ background: settingsStore.settings.primaryColor }">K</div>
        <div>
          <h2 style="margin: 0 0 4px">Kiro Manager Lite</h2>
          <p class="muted" style="margin: 0">
            只做账户管理的轻量版：添加、导入导出、账号信息面板、删除、刷新密钥与积分、切号。
          </p>
        </div>
      </a-space>
    </a-card>

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

/* 应用标识方块，底色由主题色内联注入 */
.brand-mark {
  width: 52px;
  height: 52px;
  border-radius: 14px;
  display: grid;
  place-items: center;
  color: #fff;
  font-size: 24px;
  font-weight: 700;
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
