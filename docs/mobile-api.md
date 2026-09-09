# 移动 App API 服务

桌面端提供独立 Bearer API，供 Flutter 移动端连接；不再发布浏览器管理面板、静态资源、管理员 Cookie 会话或 CSRF 管理路由。

## 在桌面端配置

1. 打开 **设置 → 移动 App API 服务**。
2. 选择监听地址和端口（局域网常用 `0.0.0.0:19840`），启用服务。
3. 服务首次启动时会自动生成唯一的“移动 App” API Key，并自动授予全部移动 App 权限。Key 以系统安全存储密文保存，页面不显示明文；可随时点击“复制 API Key”。重新创建会立即撤销并替换旧 Key。
4. 手机填写桌面 LAN IP、端口和 API Key；公网只填写你自己 HTTPS 反代的根地址。

账户列表不会返回凭证或完整支付链接。OIDC 精简 JSON、支付链接和 Checkout 账单均为按需接口，并返回 `Cache-Control: no-store`。

## 移动端接口

- `GET /api/v1/capabilities`
- `GET /api/v1/accounts` / `GET /api/v1/accounts/:id`
- `PATCH /api/v1/accounts/:id`（仅标签、备注、昵称）
- `GET /api/v1/accounts/:id/oidc`（需要 `accounts:export`）
- `GET /api/v1/accounts/:id/payment-link`（需要 `accounts:payment`）
- `GET /api/v1/tags`
- `POST /api/v1/billing/checkout/generate`（需要 `billing:generate`）

所有接口使用 `Authorization: Bearer <API Key>`。移动 App 默认 Key 始终拥有当前全部移动权限；重新创建后旧 Key 会立即失效。

### 账号列表筛选

`GET /api/v1/accounts` 支持下列移动端筛选参数：

- `subscription`：`Free`、`Pro`、`Pro_Plus`、`Pro_Max` 或 `Power`。
- `createdAfter` / `createdBefore`：导入时间的 Unix 毫秒范围，左闭右开（`[after, before)`）。移动端按手机本地日历日生成范围。
- `paymentStatus=pending`：仅返回“待支付”账号，即**有支付链接且订阅为 Free**；`not_pending` 则返回其余账号。
## 公网 HTTPS 反向代理连通性测试

先在桌面端保存并启动服务。反代与桌面服务部署在同一台机器时，监听地址应保持为 `127.0.0.1`，端口为 `19840`；“公网 HTTPS 地址”填写不带路径的根地址，例如 `https://api.example.com`；“可信代理”填写反代进程的来源 IP（同机 Nginx/Caddy 通常为 `127.0.0.1`）。

从**不在该局域网内**的网络测试，例如手机关闭 Wi-Fi 后使用蜂窝网络，或一台外部服务器：

```powershell
# 只验证 HTTPS、DNS、反代与 API 路由可达；预期为 401 UNAUTHORIZED。
curl.exe -i --connect-timeout 10 https://api.example.com/api/v1/capabilities

# 再验证 API Key 和权限。将 klr_... 替换成从桌面端“复制 API Key”取得且尚未重新创建的 Key；不要把真实 Key 写入脚本或提交到仓库。
curl.exe -i --connect-timeout 10 `
  -H "Authorization: Bearer klr_REPLACE_ME" `
  https://api.example.com/api/v1/capabilities
```

第二个请求预期返回 HTTP `200`，响应 `data` 中含有 `apiVersion: "1"`、当前 Key 的 `scopes` 和功能标志。随后在移动 App 的连接页填写同一个 HTTPS 根地址与 API Key；连接校验成功即表示 App 可通过反代访问服务。

常见结果：`401` 表示反代已到达 API 但缺少、错误或已撤销的 Key；`403` 表示 Key 有效但缺少所需权限；`502`/`504` 表示反代无法访问桌面服务；TLS 证书错误通常表示域名、证书链或反代 HTTPS 配置不正确。