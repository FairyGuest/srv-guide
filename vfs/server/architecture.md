# 架构

```
            Internet
               │  22 (ssh) · 80 · 443
               ▼
        ┌──────────────┐
        │    Nginx     │  静态站点 /srv/www/personal
        │  TLS · CSP   │  限流 · 反向代理
        └──────┬───────┘
     ┌─────────┼──────────────┬───────────────┬──────────────┐
     ▼         ▼              ▼               ▼              ▼
 /api/demo  /api/market   /api/guide     /ziwei/         静态页面
 :3000      :3004         :3003 (SSE)    /api/ziwei/     /, /blog, /lab ...
 demo       盯盘 agent     srv-guide（我） :3005 紫微
```

要点：

- 所有后端只监听 `127.0.0.1`，公网只能经过 Nginx 访问。
- 每个后端是一个 systemd 服务，以普通用户 `deploy` 运行，有内存与 CPU 上限。
- 没有数据库服务：后端的运行数据用 JSON / JSONL；紫微服务读 `/srv/data/ziwei` 里的只读 SQLite 文件；博客是本地构建好的静态文件。
- 源码在 `/srv/apps/<项目>/`，运行数据在 `/srv/data/<项目>/`，静态文件在 `/srv/www/personal/`。
