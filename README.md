<p align="center">
  <img src="docs/logo.png" width="128" height="128" alt="Kiro Manager Lite Logo">
</p>

<h1 align="center">Kiro Manager Lite</h1>

<p align="center">
  <strong>只做账户管理的 Kiro IDE 多账号管理器</strong>
</p>

<p align="center">
  多账号一键切换 · 在线登录添加 · Token 与积分刷新 · 账号真实测活 · 导入导出 · 托盘常驻
</p>

<p align="center">
  <img src="https://img.shields.io/badge/version-1.0.4-6c5ce7" alt="version">
  <img src="https://img.shields.io/badge/license-AGPL--3.0-blue" alt="license">
  <img src="https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-lightgrey" alt="platform">
  <img src="https://img.shields.io/badge/Vue-3-42b883" alt="vue">
  <img src="https://img.shields.io/badge/Electron-35-47848f" alt="electron">
</p>

---

## ✨ 功能特性

### 🔐 多账号管理

- 账号列表支持搜索（邮箱 / 昵称 / 备注）、按状态 / 订阅 / 登录方式多选筛选、列排序
- 账号信息面板：订阅类型、积分明细（基础 / 试用 / 奖励额度）、超额费率、Token 有效期、凭证查看与复制
- 单个与批量删除，删除确认可在设置里开关
- 积分变化日志：按账号记录每次用量采样，便于回看消耗曲线

### ➕ 三种添加方式

- **在线登录**：Google / GitHub 社交登录（PKCE + `kiro://` 回调）、AWS Builder ID 设备码、Enterprise IAM Identity Center SSO（授权码 + PKCE + 本地回调端口），均可选无痕窗口
- **OIDC 凭证**：手动填写 Refresh Token / Client ID / Client Secret
- **本地 Kiro 凭证**：直接读取 Kiro IDE 当前已登录的账号

### 🔄 切号与刷新

- 切换账号：写入 `~/.aws/sso/cache/kiro-auth-token.json`，写盘前强制刷新一次 Token，避免 IDE 拿到已作废的凭证被登出
- 切号后可一键重启 Kiro IDE，让它重新读盘生效
- 刷新密钥：单个 / 批量刷新 Access Token，仅当账号确实是 IDE 当前登录账号时才回写磁盘
- 刷新积分与用量：单个 / 批量拉取最新订阅与积分，并发数可调
- 主动续期：按 Token 到期时间提前调度刷新，保持 IDE 登录态不掉线

### 🧪 账号测活

- 拉取账号真实可用的模型列表，发起一次真实流式对话验证账号是否可用
- 流式输出实时回显，支持中途取消

### 📦 导入与导出

- 导入：卡密（`邮箱----密码----Token----ID----Secret----登录方式`）、精简 JSON 数组、完整备份 JSON、CSV、TXT，支持粘贴或选文件，大批量走并发校验池
- 导出：完整备份 JSON、精简 JSON、卡密、CSV、TXT，可保存文件或复制到剪贴板，并可选择是否包含凭证

### 🖥️ 桌面端体验

- 系统托盘（macOS 菜单栏）常驻：展示当前账号、刷新、切下一个账号、复制邮箱、显示窗口
- 关闭窗口行为可配：最小化到托盘 / 直接退出 / 每次询问
- macOS 顶部中文菜单栏：主页、账户管理、设置、关于，以及打开 / 关闭 Kiro IDE
- 自定义协议 `kiro-manager-lite://` 与短别名 `kml://`，从浏览器或终端直接唤起并跳转页面
- 关于页一键检查更新：对比 GitHub 最新 Release 版本号，有新版展示更新说明并跳转下载

### 🧾 系统日志

- 内置日志页面：按关键字、时间范围、分类、级别（DEBUG / INFO / WARN / ERROR）筛选，虚拟滚动承载数万行
- 内存环形缓冲保留最近 5 万条，磁盘按分片落盘并自动清理旧文件，不会出现巨型日志文件
- 主进程与渲染进程的日志汇入同一条时间线，接口请求、批量刷新结果、自动刷新耗时与失败明细都有记录
- 支持自动跟随最新日志、导出当前筛选结果为 `.log`、打开日志目录、一键清空

### ⚙️ 个性化设置

- 深色模式、主题色、隐私打码（隐藏邮箱与昵称）、积分显示精度
- 自动刷新开关与间隔（密钥 / 用量分开配置）、批量并发、导入并发
- 用量接口类型（REST / CBOR 门户）、HTTP 代理、数据目录与备份目录快捷打开

---

## 📸 截图

### 主页

![主页](docs/screenshots/home.png)

### 账户管理

![账户管理](docs/screenshots/account.png)

### 添加账号

![添加账号](docs/screenshots/account-add.png)

### 在线登录

![在线登录](docs/screenshots/account-add-online-login.png)

### 切换账号

![切换账号](docs/screenshots/account-change.png)

### 账号测活

![账号测活](docs/screenshots/account-online-test.png)

### API Key 管理

![API Key 管理](docs/screenshots/apikey.png)

### API Key 网关

![API Key 网关](docs/screenshots/apikey-gateway.png)

### 设置

![设置](docs/screenshots/setting.png)

### 关于

![关于](docs/screenshots/about.png)

---

## 📥 安装说明

前往 [Releases](https://github.com/lucks-cloud/kiro-manager-lite/releases) 下载对应平台的安装包。
如遇到系统拦截、架构选择、升级或卸载问题，请查看 **[安装说明与常见问题](./INSTALL.md)**。

| 平台 | 文件 | 说明 |
| --- | --- | --- |
| macOS (Apple Silicon) | `*-mac-arm64.dmg` | M 系列芯片 |
| macOS (Intel) | `*-mac-x64.dmg` | Intel 芯片 |
| Windows | `*-win-x64-setup.exe` | 仅 x64 |
| Linux | `*-linux-x86_64.AppImage` | 仅 x64 |

`.zip`、`.blockmap` 与 `latest*.yml` 主要供自动更新使用，手动安装无需下载。

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
| 持久化 | electron-store（加密存储 + 滚动备份） |

---

## 🚀 开发

```bash
# 安装依赖
npm install

# 启动开发环境
npm run dev

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
  shared/types.ts        主进程与渲染进程共享类型
  main/
    index.ts             应用生命周期与窗口
    appMenu.ts           macOS 中文菜单栏
    ipc.ts               IPC 注册
    accountService.ts    校验 / 刷新 / 状态检查 / 切号
    onlineLogin.ts       在线登录：设备码、社交登录、Enterprise SSO
    kiroApi.ts           Token 刷新、用量与积分接口
    kiroAuth.ts          Kiro IDE 凭证文件读写与 profileArn 决策
    kiroChat.ts          账号测活：模型列表与流式对话
    kiroProcess.ts       Kiro IDE 进程检测、打开、关闭与重启
    logger.ts            系统日志：内存环形缓冲、分片落盘、接管 console
    proactiveRenewal.ts  Token 主动续期调度
    tray.ts              系统托盘
    net.ts               统一 fetch 与代理
    store.ts             持久化与滚动备份
  preload/               contextBridge 暴露的 API
  renderer/src/
    stores/              Pinia：accounts / settings
    views/               HomeView / AccountsView / LogsView / SettingsView / AboutView
    components/          layout、accounts、common 下的组件
    utils/               格式化、导入导出解析、托盘桥接
```

---

## 🔒 安全说明

- 账号凭证保存在本机 electron-store 加密文件里，不会上传到任何第三方服务
- 渲染进程开启 contextIsolation、关闭 nodeIntegration，所有系统调用走 preload 白名单
- 导出内容包含可直接登录的凭证，请勿放到公开位置；导出时可关闭「包含凭证」
- Google / GitHub 在线登录期间会临时把 `kiro://` 协议注册到本应用（Kiro 授权服务只接受这个固定回调地址），登录结束或应用退出时立即注销，不会长期抢占 Kiro IDE 的协议
- Enterprise SSO 的回调服务器只监听 `127.0.0.1` 的随机端口，授权完成即关闭，state 与 PKCE 全程校验

---

## 🔖 更新日志

各版本变更记录见 [CHANGELOG.md](CHANGELOG.md)，当前版本 v1.0.4。

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
- 许可：[AGPL-3.0](LICENSE)
- Kiro 官网：<https://kiro.dev>
