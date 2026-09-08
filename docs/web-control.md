# Web 控制面板与对外 API

KiroLuker 的 Web 控制面板由**正在运行的桌面程序**提供。默认关闭，首次使用请在桌面端的 **设置 → Web 控制面板与对外 API** 完成：

1. 设置至少 10 位的管理员密码（仅保存 `scrypt` 哈希）。
2. 保持默认监听 `127.0.0.1:19840`，或按需改为局域网地址。
3. 开启服务并复制面板地址，例如 `http://127.0.0.1:19840/panel/`。
4. 在面板的 **API Key** 页创建外部程序专用 Key；明文 Key 仅创建时显示一次。

## 公网部署

应用不配置防火墙、证书或公网 HTTP。若需要公网访问，必须在同机 HTTPS 反向代理之后运行，并在桌面设置中填写：

- **公网 HTTPS 地址**：例如 `https://kiro-panel.example.com`
- **可信代理**：反向代理的回环 IP 或 CIDR，例如 `127.0.0.1, ::1`

Nginx 示例（仅作反向代理配置，不包含证书申请）：

```nginx
server {
  listen 443 ssl http2;
  server_name kiro-panel.example.com;

  ssl_certificate     /etc/letsencrypt/live/kiro-panel.example.com/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/kiro-panel.example.com/privkey.pem;

  client_max_body_size 2m;

  location / {
    proxy_pass http://127.0.0.1:19840;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto https;
  }
}
```

不要将应用监听到公网地址后绕过 HTTPS 代理直接暴露。应用会在配置了公网地址时校验请求 `Host`，并把管理员 Cookie 标为 `Secure`。

## API 使用

API 前缀为 `/api/v1`。管理员可登录面板后打开受保护的 `/api/v1/openapi.json` 获取完整契约。

```bash
curl -H "Authorization: Bearer klr_请替换为创建时显示的Key" \
  "https://kiro-panel.example.com/api/v1/accounts?page=1&pageSize=30"
```

API Key 权限包括：`accounts:read`、`accounts:write`、`accounts:refresh`、`billing:generate`。API Key 无法管理管理员密码、其他 Key 或账单服务密钥。所有账户响应均经过白名单 DTO 脱敏，绝不返回 Token、client secret、密码或支付链接。

## 运行与限制

- 桌面程序最小化到托盘后，Web 服务继续运行；真正退出程序时会停止监听。
- 管理员会话：30 分钟空闲过期，最长 8 小时；修改管理员密码或服务重启后立即失效。
- 登录每 IP 每分钟 5 次；API Key 每分钟 120 次；账单生成每身份每分钟 10 次，最多 2 个并行生成。
- 导入、刷新和批量操作会返回 `202 + jobId`，通过 `GET /api/v1/jobs/:id` 查询状态；任务只存于内存，应用重启不会续跑。
