# Android 发布签名密钥

自 2026-09-14 起 KiroLuker Android Release APK 使用固定密钥签名。
**丢失明文密钥库 = 以后无法覆盖升级（需卸载重装），请把整个 .signing 目录备份到安全位置。**

## 方案（v2：加密件随仓库）

密钥库以 AES-256-CBC + PBKDF2 加密为 `kiroluker-release.jks.enc` **直接提交进仓库**，
CI 用下方密码 Secret 解密；解密后强制校验证书指纹（864ceae9…），不匹配即发版失败。
（v1 曾把整段 base64 存为 Secret，但 Web 表单录入 5.7KB 字符串丢失字符，已弃用；
`ANDROID_KEYSTORE_BASE64` Secret 已无用，可在仓库设置里删除。）

## 需要的 3 个 Actions Secrets（已配置）

仓库页 → Settings → Secrets and variables → Actions：

| Secret 名称 | 值 |
|---|---|
| ANDROID_KEYSTORE_PASSWORD | store-password.txt 的内容 |
| ANDROID_KEY_ALIAS | kiro_lucker |
| ANDROID_KEY_PASSWORD | store-password.txt 的内容（与 store 密码相同） |

## 文件清单（.signing/ 其余文件不入库）

- kiro_lucker-release.jks —— PKCS12 密钥库明文（仅本机，别名 kiro_lucker，指纹 864ceae9…）
- kiro_lucker-release.jks.enc —— 上者的加密件（随仓库分发）
- store-password.txt —— store/key 共用密码
- keystore-base64.txt —— v1 方案遗留，已不使用

## 重建加密件（更换密钥或密码时）

    openssl enc -aes-256-cbc -pbkdf2 -salt \
      -in .signing/kiro_lucker-release.jks \
      -out .signing/kiroluker-release.jks.enc \
      -pass pass:'<密码>'
    # 并同步更新 release.yml 里的 EXPECTED 证书指纹
