# HTTPS

- 2026-10-28 为公网 IP 申请了 Let's Encrypt 的可信 **IP 证书**，不需要域名。
- 证书是 shortlived 配置，有效期约 160 小时，所以续期必须自动化：
  `personal-certbot-renew.timer` 每天检查两次，续期成功后先 `nginx -t` 再 reload。
- 验证方式是 HTTP-01，因此公网 80 端口必须保持开放。
- 支持 TLS 1.2 / 1.3，开启 HTTP/2。
