# 服务清单

| 服务 | 类型 | 监听 | 说明 |
| --- | --- | --- | --- |
| nginx | systemd | 0.0.0.0:80 / 443 | 静态站点、HTTPS、反向代理、限流 |
| personal-demo | systemd | 127.0.0.1:3000 | 无依赖 Node.js 示例后端，提供 /health |
| server-guide | systemd | 127.0.0.1:3003 | 就是我：导游 agent，SSE 流式输出 |
| market-watch | systemd | 127.0.0.1:3004 | 盯盘 Agent：每个交易日收盘后辩论、自动对账，/lab/market/ 的数据来源 |
| ziwei | systemd | 127.0.0.1:3005 | 紫微十三维观照：按公历日期、时辰和资料分类查历史解读，只读资料库，不保存出生信息；可选的 AI 白话解读走 DeepSeek，只发资料正文，不发出生日期 |
| personal-certbot-renew.timer | systemd timer | - | 每天两次检查 IP 证书续期 |
| docker | systemd | - | 已安装，默认不运行容器 |
| sshd | systemd | 0.0.0.0:22 | 管理入口（密钥登录） |

所有自建服务的 systemd 单元都带有：`NoNewPrivileges`、`ProtectSystem=strict`、`ProtectHome`、
`PrivateTmp`、`MemoryMax=512M`（我是 256M）、`CPUQuota`、异常自动重启。

新后端从 3006 起分配端口；动手前先用 Ports 工具确认没有被占用。
