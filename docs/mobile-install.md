# KiroLuker Mobile 安装与验收

## 构建产物

GitHub Actions 的 **Mobile App** 工作流会上传以下仅供测试的产物：

- `kiroluker-android-debug-apk`：未签名的可安装 Android 调试 APK。
- `kiroluker-android-release-apk`：仅在四个 Android 签名 Secrets 均已配置时生成的签名 Release APK。
- `kiroluker-ios-unsigned-ipa`：由 macOS/Xcode 生成、未签名的设备 IPA。它需要使用你自己的证书重签后才能安装到 iPhone。

工作流不会发布到任何商店，也不会改变桌面端 release 流程。移动构建号使用 GitHub Actions 的运行序号；展示版本来自仓库根目录的 `VERSION`。

## Android 本地安装

1. 在桌面端「设置 → 移动 App API 服务」启用服务，创建最小权限 API Key。
2. 将测试 APK 传到 Android 10+ 设备并安装；如果系统拒绝安装，允许该文件来源安装未知应用。
3. 手机和桌面在同一局域网时，填写桌面的 IPv4 地址、端口 `19840` 和 API Key。公网访问只能填写你自己部署的 HTTPS 反向代理地址。
4. Android 和 iOS 支持这类局域网 HTTP；连接前 App 会要求明确确认，因为 API Key 和账号请求不会加密。请只在可信网络使用 HTTP，公网始终使用 HTTPS。
4. 登录成功后，检查账号分页、标签修改、按需 OIDC 复制、支付链接和网络 IP 面板。

## iPhone 重签与安装

1. 下载 `kiroluker-ios-unsigned-ipa` 并解压确认其结构为 `Payload/KiroLuker.app`。
2. 用你自己的 Apple 开发证书、描述文件和重签工具对 `.app` 重签，再重新压缩为 IPA。
3. 通过 Xcode、Apple Configurator 或你已配置的设备安装方式安装到 iOS 15+ 真机。
4. 在真机验证连接、账户、IP 检测和独立支付 WebView；不得把 CI 构建成功当成真机验证。

## Android Release 签名 Secrets

仅在需要 CI 直接生成 Release APK 时配置：

- `ANDROID_KEYSTORE_BASE64`
- `ANDROID_KEYSTORE_PASSWORD`
- `ANDROID_KEY_ALIAS`
- `ANDROID_KEY_PASSWORD`

不要提交 keystore、密钥、API Key、真实支付链接、高德或 AI 密钥。
