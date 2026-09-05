<p align="center">
  <img src="docs/logo.png" width="128" height="128" alt="KiroLuker Logo">
</p>

<h1 align="center">KiroLuker</h1>

<p align="center">
  <strong>Kiro 多账号、批量订阅与账单辅助工具</strong>
</p>

<p align="center">
  多账号集中管理 · 标签与日期筛选 · 批量订阅 · 自动刷新与流式测活 · 私密浏览器登录 · 托盘常驻
</p>

<p align="center">
  <img src="https://img.shields.io/badge/version-1.2.7-6c5ce7" alt="version">
  <img src="https://img.shields.io/badge/updated-2026--09--05-2f9e44" alt="updated">
  <img src="https://img.shields.io/badge/license-AGPL--3.0-blue" alt="license">
  <img src="https://img.shields.io/badge/platform-macOS%20arm64%20%7C%20Windows%20x64-lightgrey" alt="platform">
  <img src="https://img.shields.io/badge/Vue-3-42b883" alt="vue">
  <img src="https://img.shields.io/badge/Electron-35-47848f" alt="electron">
</p>

---

## ✨ 功能特性

### 🔐 多账号管理

**添加与列表**

- 五种添加方式：Google / GitHub 社交登录、AWS Builder ID 设备码、Enterprise IAM Identity Center SSO、OIDC 凭证、读取本机已登录的 Kiro 凭证
- 搜索、按状态 / 订阅 / 登录方式 / 标签 / 添加日期筛选、多选与批量操作；上千账号用虚拟列表保持流畅
- 卡片显示邮箱、昵称、标签、订阅档位、积分占比与 Token 剩余时间，并支持一键复制邮箱
- 详情抽屉展开订阅档位、积分构成、超额费率、Token 有效期与完整凭证，支持一键复制

**刷新与保活**

- 批量刷新 Token / 用量与积分，支持定时自动刷新；「主动续期」会在 IDE 当前账号的 Token 剩约 15 分钟时抢先续期并写盘，避免 IDE 自己刷新时撞车被登出
- 真实流式对话测活：可指定模型、实时看输出、随时中止。只有 runtime 面的真实对话才能暴露封禁账号

**账号 API Key**

- 卡片上的钥匙图标直接用该账号凭证向 Kiro 控制面申请 Key，并列出它已创建的全部 Key（名称、前缀、创建时间）
- 完整明文上游只在创建时返回一次，因此生成后单独弹窗展示并提供复制，未复制就关闭会二次确认；关闭后列表里只剩前缀

**前往官网**

- 用该账号凭证在应用内的私密窗口直接进入 Kiro 官网后台，无需影响 Kiro IDE 当前登录身份
- 会话分区不持久化、退出即清，也不碰你自己浏览器里的登录身份；每次打开前先清空 cookie，避免显示上一个账号
- 页面内的跳转全程留在应用内（含站外链接与二级弹窗），不会跳到系统浏览器丢掉会话
- 请求头伪装成普通 Chrome，并可在设置的「内置浏览器」里指定地区（内置 50 个常用地区，也支持自定义 BCP 47 标签）

### 📈 用量与历史

- 账号每次刷新都会记录积分变化，支持平滑趋势曲线、明细表、清空与 Excel 导出
- 历史曲线采用不过冲的单调平滑插值，时间轴末端标签完整显示
- 删除账号时同步清理关联历史和备份残留，避免孤儿数据继续占用存储

### 📦 导入与导出

- 账号支持卡密、精简 JSON、完整备份 JSON、CSV 和 TXT，可粘贴内容或一次选择多个文件导入
- 导出范围只有一条规则：**勾选了就导勾选的，没勾选就导全部**，不需要在弹窗里再选一次
- 导出可保存到文件或复制到剪贴板，账号导出可选择是否包含敏感凭证
- 导出成功后自动打开所在文件夹并选中该文件，也可在设置里关掉
- 账号的大批量校验 / 刷新并发数可配置

### 🖥️ 桌面端体验

- 系统托盘常驻，可查看当前账号、刷新、复制邮箱和显示窗口；关闭行为支持最小化到托盘 / 退出 / 每次询问
- macOS 中文菜单栏、自定义协议 `kiroluker://` / `klr://` 和单实例唤起（继续兼容 `kiroluler://` 等旧协议）
- 管理页详情、图表和各类模态框按用户操作实时挂载，页面切换不再等待退出动画，减少大数据量下的白屏感
- 关于页可检查并下载更新：Windows x64 下载完成后退出安装并自动重启；macOS arm64 下载并校验 DMG 后打开安装引导
- GitHub API 失败时自动重试并通过 Releases 页面兜底；更新支持进度、取消、重试、应用代理和浏览器下载兜底

### 🧾 系统日志

- 主进程与渲染进程日志汇入同一时间线，支持关键字、时间、分类和级别筛选
- 内存环形缓冲保留最近 5 万条，磁盘分片落盘并自动清理，虚拟滚动可承载数万行
- 支持跟随最新日志、导出筛选结果、打开日志目录和一键清空；向上查看历史时不会被新日志强制拉回底部

### ⚙️ 个性化设置

- 深色模式、主题色、积分精度与删除前确认
- **隐私打码**：一键遮住邮箱、昵称、API Key 与 User ID，截图或录屏前很有用。
  邮箱的遮罩串由 md5 前缀生成，同一账号每次结果一致，打码状态下仍能横向比对是不是同一个号
- **内置浏览器**：指定应用内打开的网页使用哪个地区，50 个常用地区可搜索选择，也可自定义 BCP 47 标签。
  只影响应用内的网页，不改界面语言、也不影响账号所属的 AWS 区域
- 导出后是否自动定位到文件、Token / 用量自动刷新间隔、主动续期、批量与导入并发数
- REST / CBOR 用量接口、HTTP 代理，以及数据、备份和日志目录快捷打开

---

## 📥 下载

KiroLuker 的安装包由 [GitHub Releases](https://github.com/ZoroHasaky/KiroLuker/releases) 发布。
开发测试可在 Windows 下双击 [`测试运行.bat`](测试运行.bat)。

**最新版本：v1.2.7**（2026-09-05） · 变更详情见 [CHANGELOG.md](CHANGELOG.md)

### 选择对应的安装包

| 平台 | 文件 | 适用设备 |
| --- | --- | --- |
| macOS (Apple Silicon) | `*-mac-arm64.dmg` | Apple M 系列芯片 |
| Windows | `*-win-x64-setup.exe` | 64 位 Windows |

当前 Releases 只提供 macOS Apple Silicon（arm64）和 Windows x64 安装包。

`.zip`、`.blockmap` 与 `latest*.yml` 是自动更新用的，手动安装不需要下载。

### 系统要求

| 平台 | 最低版本 | 架构 |
| --- | --- | --- |
| macOS | 11 Big Sur | arm64 |
| Windows | Windows 10 | 仅 x64 |

版本门槛跟随 Electron 35（Chromium 134）的[平台支持范围](https://github.com/electron/electron#platform-support)。
安装后约占 300–400 MB。

### 安装要点

- **Windows**：双击 `.exe` 安装。安装包未做代码签名，SmartScreen 可能提示「已保护你的电脑」，
  确认文件来自官方 Releases 后选「更多信息 → 仍要运行」即可，**不要为此关闭 SmartScreen 或杀毒软件**。
- **macOS**：拖入「应用程序」。未做公证，首次打开可能提示「已损坏」或「无法验证开发者」，
  DMG 里附了「安装指南.txt」说明处理办法。
- **升级**：应用内「关于」页可检查更新。Windows x64 可自动下载、退出安装并重启；macOS arm64
  会下载并校验 DMG，打开后将新版本拖入「应用程序」覆盖。也可以完全退出应用后手动覆盖安装，用户数据不受影响。

遇到系统拦截、架构选错、升级或卸载问题，完整排查步骤见 **[安装说明与常见问题](./INSTALL.md)**。

---

## 📸 截图

以下截图来自更名前的上游版本，仅用于展示基础界面结构；KiroLuker 实测截图将在功能验收后更新。

### 主页

![主页](docs/screenshots/home.png)

### 账户管理

![账户管理](docs/screenshots/account.png)

### 添加账号

![添加账号](docs/screenshots/account-add.png)

### 在线登录

![在线登录](docs/screenshots/account-add-online-login.png)

### 账号 API Key 管理

![账号 API Key 管理](docs/screenshots/account-apikey-manager.png)

### 账号测活

![账号测活](docs/screenshots/account-online-test.png)

### 系统日志

![系统日志](docs/screenshots/system-log.png)

### 设置

![设置](docs/screenshots/setting.png)

### 关于

![关于](docs/screenshots/about.png)

---

## 🛠️ 技术栈

| 层 | 选型 |
| --- | --- |
| 前端框架 | Vue 3 + TypeScript |
| 桌面框架 | Electron 35 |
| 状态管理 | Pinia |
| UI 组件 | Ant Design Vue 4 |
| 构建工具 | Vite + electron-vite |
| 网络层 | undici（统一 fetch + 代理） |
| 持久化 | electron-store（加密存储）+ safeStorage（系统保护的加密滚动备份） |
| 序列化 | cbor-x（Kiro 网页门户的 CBOR 接口） |

---

## 🚀 开发

```bash
# 安装依赖
npm install

# 启动开发环境
npm run dev

# VERSION 是唯一版本源；发布前只需修改该文件
# 推送 main 后，GitHub Actions 会自动构建并发布尚未存在的版本
npm run sync:version

# 类型检查
npm run typecheck

# 类型检查 + 构建产物
npm run build

# 打安装包（win / linux 同理）
npm run build:mac
```

---

## 📂 目录结构

```
src/
  shared/                主进程与渲染进程共享的单一真源
    types.ts             共享类型与默认设置
    errors.ts            错误归一与「是否确定性失败」判定
    refreshPolicy.ts     刷新跳过策略（手动 / 自动共用一份）
    regions.ts           AWS 区域列表与分组
    portalLocale.ts      内置浏览器地区：预设、归一化、Accept-Language
    subscription.ts      订阅档位归一
  main/
    index.ts             应用生命周期与窗口
    ipc.ts               IPC 注册与运行时设置下发
    appMenu.ts           macOS 中文菜单栏
    appProtocol.ts       自定义协议注册与唤起
    ── 账号
    accountService.ts    校验 / 刷新 / 状态检查
    onlineLogin.ts       在线登录：设备码、社交登录、Enterprise SSO
    proactiveRenewal.ts  Token 主动续期调度
    ── Kiro 接口与本体
    kiroApi.ts           Token 刷新、用户信息、用量与积分
    kiroApiKey.ts        账号维度的 API Key 申请与列表（控制面）
    kiroAuth.ts          IDE 凭证文件读写与 profileArn 决策
    kiroChat.ts          测活：模型列表与流式对话
    kiroEndpoints.ts     端点、区域映射与客户端 UA（服务端按版本号准入）
    kiroSettings.ts      IDE settings.json 读写与旧网关端点还原
    kiroPermissions.ts   旧版权限配置的安全还原与清理
    kiroProcess.ts       IDE 进程检测、打开、关闭与重启
    kiroPortal.ts        前往官网：应用内私密窗口与地区
    legacyKeyGateway.ts  仅清理旧版接管状态，保留历史 Key 数据
    eventStream.ts       AWS event-stream 帧解析（账号流式测活）
    ── 基础设施
    net.ts               统一 fetch 与代理
    store.ts             加密持久化与滚动备份
    usageHistory.ts      积分历史（防抖落盘）
    logger.ts            内存环形缓冲、分片落盘、接管 console
    tray.ts              系统托盘
    updater.ts           版本检查
    browser.ts           系统浏览器唤起
    xlsxWriter.ts        Excel 导出
  preload/               contextBridge 暴露的 API 白名单
  renderer/src/
    stores/              Pinia：accounts / settings / update
    views/               Home / Accounts / Subscription / Billing / Logs / Settings / About
    components/          layout、accounts、common
    utils/               格式化、打码、导入导出、图表、托盘桥接
```

---

## 🔒 安全说明

- 账号凭证保存在本机 electron-store 加密文件里，不会上传到任何第三方服务
- 渲染进程开启 contextIsolation、关闭 nodeIntegration，所有系统调用走 preload 白名单
- 导出内容包含可直接登录的凭证，请勿放到公开位置；导出时可关闭「包含凭证」
- Google / GitHub 在线登录期间会临时把 `kiro://` 协议注册到本应用（Kiro 授权服务只接受这个固定回调地址），登录结束或应用退出时立即注销，不会长期抢占 Kiro IDE 的协议
- Enterprise SSO 的回调服务器只监听 `127.0.0.1` 的随机端口，授权完成即关闭，state 与 PKCE 全程校验
- 「前往官网」用的是不持久化的内存会话分区，退出即清；每次打开前先清空 cookie，不会串号，也不会写入你自己浏览器的登录态
- 独立 API Key 管理及本地网关功能已移除。升级启动只还原仍指向旧网关端口的 IDE 端点，保留历史 Key 和统计文件；不会覆盖其它工具后来修改的端点。

---

## 🔖 更新日志

各版本变更记录见 [CHANGELOG.md](CHANGELOG.md)，当前版本 v1.2.7，最后更新于 2026-09-05。

---

## 💬 交流群

<p align="center">
  <img src="docs/qq-group.jpg" width="260" alt="QQ 交流群">
</p>

---

## 🙏 致谢与许可

账户管理相关的接口实现参考了开源项目 [Kiro-account-manager](https://github.com/chaogei/Kiro-account-manager)（AGPL-3.0），
本项目在其基础上重写为 Vue 技术栈，并裁剪为纯账户管理，去掉了反向代理、注册机、机器码管理、MITM 代理等模块。

- 作者：[lucks-cloud](https://github.com/lucks-cloud)
- 当前维护仓库：[ZoroHasaky/KiroLuker](https://github.com/ZoroHasaky/KiroLuker)
- 上游项目：[lucks-cloud/kiro-manager-lite](https://github.com/lucks-cloud/kiro-manager-lite)
- 许可：[AGPL-3.0](LICENSE)
- Kiro 官网：<https://kiro.dev>
