# 安装说明与常见问题

本文适用于 KiroLuker 的安装、升级和卸载。请仅使用自己构建或项目正式发布的安装包，
不要运行来源不明的二次打包版本。

## 选择安装包

| 平台 | 应下载的文件 | 适用设备 |
| --- | --- | --- |
| macOS Apple Silicon | `*-mac-arm64.dmg` | Apple M 系列芯片 |
| Windows | `*-win-x64-setup.exe` | 64 位 Windows |

`.zip`、`.blockmap` 和 `latest*.yml` 主要供自动更新使用，手动安装时无需下载。

## Windows

1. 下载 `*-win-x64-setup.exe` 并双击运行。
2. 按安装向导选择安装目录并完成安装。
3. 从桌面或开始菜单启动 KiroLuker。

当前安装包未做代码签名。如果 SmartScreen 显示“Windows 已保护你的电脑”，请先确认文件来自上述官方
Releases 页面，再选择“更多信息”→“仍要运行”。不要为此全局关闭 SmartScreen 或杀毒软件。

如安装程序无法写入目标目录，请改用当前用户有权限的目录；本应用通常不需要管理员权限。

## macOS

当前只发布 Apple Silicon（M 系列）`arm64` 安装包，不提供 Intel Mac 安装包。
打开 DMG 后，将 KiroLuker 拖入“应用程序”文件夹。

当前安装包未做 Apple 签名与公证。首次打开若提示“无法验证开发者”，可在 Finder 的“应用程序”中
按住 `Control` 点击应用，选择“打开”，然后再次确认；也可前往“系统设置”→“隐私与安全性”允许本次打开。

若提示应用“已损坏，无法打开”，请先确认安装包来自官方 Releases，再关闭应用并执行：

```bash
xattr -cr "/Applications/KiroLuker.app"
```

该命令只移除这个应用的下载隔离属性，不会关闭系统的全局安全功能。

## Linux / Intel Mac

当前 GitHub Actions 不生成 Linux 或 Intel Mac 安装包；需要时可在对应系统从源码自行构建。

## 升级与数据保留

应用内“关于”页面可以检查更新：

- **Windows x64**：点击“下载并更新”，校验完成后选择“立即重启更新”。应用会退出、安装新版本并自动重启。
- **macOS arm64**：点击“下载 DMG”，应用会下载并校验安装包，然后自动打开；将新版本拖入“应用程序”覆盖旧版本。

也可以继续手动升级：

1. 完全退出应用（包括托盘或菜单栏中的后台进程）。
2. 从 Releases 下载新版本对应平台的安装包。
3. Windows 直接运行新安装程序；macOS 用新应用覆盖“应用程序”中的旧版本。
4. 启动应用并在“关于”页面确认版本号。

覆盖安装默认保留账号、API Key、设置、积分历史和日志。账号滚动备份使用当前系统账号的安全存储
加密，适合同一系统账号下的重装恢复；跨设备迁移请在应用内导出完整 JSON 备份。任何备份都不要
上传到公开位置。

## 卸载

卸载前请先在应用内关闭 API Key 网关，让应用把 Kiro IDE 的端点配置还原回去：

- **API Key 网关**：在 API Key 管理页关闭网关并按提示重启 Kiro IDE，确保官方端点已恢复。
  涉及 `codewhisperer.config.krsEndpoints` / `cpsEndpoints` 两项设置。

然后按平台卸载：

- **Windows**：在“设置”→“应用”中卸载 KiroLuker。
- **macOS**：退出应用后，将“应用程序”中的 KiroLuker 移到废纸篓。
- **Linux**：退出应用后删除 AppImage 文件以及自行创建的快捷方式。

普通卸载会保留用户数据，便于以后重装恢复。若要彻底删除，请在卸载前通过应用设置打开数据目录，
记下位置；退出并卸载应用后，再手动删除该目录。删除后账号、API Key、设置和历史记录无法恢复。

### 已经卸载才想起来还原 Kiro 配置

应用首次修改 Kiro IDE 的 `settings.json` 时，会在同目录留下一份
`settings.json.kiroluker.bak` 备份，可据此手动恢复；从旧版升级时也会识别原有
`settings.json.kiroluler.bak` 和 `settings.json.kiro-manager.bak`。Kiro IDE 用户设置的位置：

| 平台 | 路径 |
| --- | --- |
| macOS | `~/Library/Application Support/Kiro/User/settings.json` |
| Windows | `%APPDATA%\Kiro\User\settings.json` |
| Linux | `~/.config/Kiro/User/settings.json` |

`~/.kiro/settings/permissions.yaml` 里由本应用追加的内容包在
`# >>> kiroluker:shell-auto-approve` 与 `# <<< ...` 两行标记之间；从旧版升级时，
原 `kiroluler` 和 `kiro-manager-lite` 标记也会继续识别和清理。
删掉这一段即可还原，其余规则不会被改动。

## 常见问题

### 安装后打不开或双击没有反应

确认下载的平台与架构正确，并检查应用是否已经在系统托盘或 macOS 菜单栏运行。Windows 和 macOS
出现安全拦截时，只使用本文针对单个官方安装包的放行方式，不要关闭系统全局安全功能。

### 更新后界面仍显示旧版本

完全退出托盘中的旧进程后重新安装并启动；不要只关闭主窗口。随后在“关于”页面核对版本号。

### 开启网关或切换 API Key 后未生效

按应用提示重启 Kiro IDE，使 IDE 重新读取端点配置。如果提示端口占用，请在 API Key 网关设置中
改用未被占用的端口后重试。若提示已被其它本地网关接管，可在冲突弹窗里选择强制关闭其它网关并接管。

仍未生效时，完全退出 Kiro IDE 和托盘中的 KiroLuker，重新打开应用确认网关状态后再启动
Kiro IDE。

### 检查更新失败

检查更新需要访问 GitHub Releases。请确认网络可访问 GitHub；如需代理，在应用设置中配置 HTTP
代理。如 GitHub Releases 尚无可用安装包，请使用本地构建版本。

### 更新下载或安装失败

可在更新弹窗中重试，或使用“浏览器下载”从 Releases 手动下载安装包。Windows 自动更新只适用于正式
安装版，开发运行版不能覆盖安装。macOS 安装包当前未签名，下载校验通过后仍需按本文 macOS 步骤手动覆盖。

### 关闭窗口后应用仍在运行

默认关闭行为可能是最小化到托盘。请从 macOS 菜单栏或 Windows / Linux 系统托盘中选择“退出”，
也可在设置中修改关闭窗口行为。

### 如何查看日志

进入应用的“系统日志”页面，可筛选、导出日志或点击文件夹按钮打开日志目录。反馈问题时请先检查并
移除账号凭证、API Key、邮箱等敏感信息，再提供必要的错误片段。

### 重装后如何恢复数据

先启动一次新安装的应用再退出，通过设置页确认数据和备份目录。将同一系统账号下保存的数据目录或
加密滚动备份恢复到对应位置后重新启动应用；跨设备请使用应用内导出的完整 JSON。恢复前请额外
保留现有目录副本，避免覆盖仍需使用的数据。

### 仍然无法安装或启动

提交 Issue 时请附上系统版本、CPU 架构、安装包文件名、报错截图和复现步骤，但不要粘贴完整
Token、Refresh Token 或 API Key。
