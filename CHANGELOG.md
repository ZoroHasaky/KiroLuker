# 更新日志

本文件记录 Kiro Manager Lite 的版本变更。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [1.0.0] - 2026-07-26

首个正式版本。基于 [Kiro-account-manager](https://github.com/chaogei/Kiro-account-manager)（AGPL-3.0）的接口实现，
用 Vue 3 + Vite + Pinia + Ant Design Vue + Electron 重写，并裁剪为纯账户管理工具。

### 新增

#### 账号管理

- 账号列表：邮箱 / 昵称 / 备注关键字搜索，按状态、订阅、登录方式多选筛选，支持列排序
- 账号详情抽屉：订阅类型、积分明细（基础 / 试用 / 奖励额度）、超额费率、Token 有效期、凭证查看与复制
- 单个与批量删除，删除前二次确认可在设置里开关
- 积分变化日志：按账号记录每次用量采样，可查看与清空

#### 添加账号

- 在线登录：Google / GitHub 社交登录（PKCE + `kiro://` 回调）、AWS Builder ID 设备码、
  Enterprise IAM Identity Center SSO（授权码 + PKCE + 本地回调端口），三条链路均支持无痕窗口
- OIDC 凭证：手动填写 Refresh Token / Client ID / Client Secret
- 本地 Kiro 凭证：直接读取 Kiro IDE 当前已登录的账号

#### 切号与刷新

- 切换账号：写入 `~/.aws/sso/cache/kiro-auth-token.json`，写盘前强制刷新一次 Token，
  避免 IDE 拿到已作废的 Refresh Token 被强制登出
- 切号结果弹窗内可一键重启 Kiro IDE，让它重新读盘生效
- 刷新密钥：单个 / 批量刷新 Access Token，仅当账号确实是 IDE 当前登录账号时才回写磁盘
- 刷新积分与用量：单个 / 批量拉取最新订阅与积分，并发数可配
- 主动续期：按 Token 到期时间提前调度刷新，保持 IDE 登录态不掉线
- 自动刷新：密钥与用量各自独立的开关与间隔，窗口最小化到托盘后定时器不被节流

#### 账号测活

- 拉取账号真实可用的模型列表，发起一次真实流式对话验证可用性
- 流式输出实时回显，支持中途取消

#### 导入与导出

- 导入：卡密（`邮箱----密码----Token----ID----Secret----登录方式`）、精简 JSON 数组、
  完整备份 JSON、CSV、TXT，支持粘贴文本或选择文件，大批量走并发校验池
- 导出：完整备份 JSON、精简 JSON、卡密、CSV、TXT，可保存文件或复制到剪贴板，
  并可选择是否包含凭证

#### 桌面端体验

- 系统托盘（macOS 菜单栏）常驻：显示当前账号摘要，支持刷新、切换到下一个账号、
  复制当前邮箱、显示主窗口、退出程序
- 关闭窗口行为可配：最小化到托盘 / 直接退出 / 每次询问；macOS 隐藏窗口时同步隐藏 Dock 图标
- macOS 中文菜单栏：应用名菜单内「关于 Kiro Manager Lite」弹出原生信息弹窗（支持一键复制），
  「操作」菜单提供主页、账户管理、设置、关于四个页面跳转与打开 / 关闭 Kiro IDE
- 自定义协议 `kiro-manager-lite://` 与短别名 `kml://`：从浏览器或终端唤起应用并直达指定页面
- 单实例锁：重复启动时唤起已有窗口，并处理随命令行传入的协议 URL

#### 设置

- 外观：深色模式、主题色、邮箱打码、积分显示精度
- 性能：批量操作并发、导入校验并发
- 网络：用量接口类型（REST / CBOR 门户）、HTTP 代理开关与地址（留空回退系统环境变量）
- 数据：存储文件与备份目录一键打开，支持恢复默认设置

### 安全

- 账号凭证保存在本机 electron-store 加密文件，不上传任何第三方服务
- 渲染进程开启 contextIsolation、关闭 nodeIntegration，系统调用全部走 preload 白名单
- 在线登录期间临时接管 `kiro://` 协议，登录结束或应用退出立即注销，不长期占用 Kiro IDE 的协议
- Enterprise SSO 回调服务器仅监听 `127.0.0.1` 随机端口，授权完成即关闭，state 与 PKCE 全程校验
- 外部链接只放行 http/https，统一交给系统浏览器打开

[1.0.0]: https://github.com/lucks-cloud/kiro-manager-lite/releases/tag/v1.0.0
