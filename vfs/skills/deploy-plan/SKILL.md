---
name: deploy-plan
description: 为访客描述的项目生成一份部署到这台服务器的方案（只生成，不执行）
argument-hint: <项目描述，例如：一个 FastAPI + SQLite 的小工具>
---
# 部署方案（dry-run）

目标：根据用户描述的项目，生成一份**符合本服务器约定**的部署方案。你不能执行任何部署，必须明确说明这是方案。

步骤（先用 TodoWrite 列出）：

1. 如果用户没给项目描述，用一句话追问，然后停止。
2. 读 `server/services.md` 和 `server/security.md`，了解约定与边界。
3. 调用 Ports 确认可用端口，调用 SystemInfo 评估内存余量。
4. 输出方案：
   - **评估**：资源是否够用（结合实时内存），选哪个端口及原因。
   - **目录**：`/srv/apps/<名字>/`（源码）、`/srv/data/<名字>/`（数据）。
   - **systemd 单元**：完整的 `<名字>.service`，沿用 deploy 用户、只听 127.0.0.1、
     `NoNewPrivileges`、`ProtectSystem=strict`、`ProtectHome`、`PrivateTmp`、`ReadWritePaths`、`MemoryMax`。
   - **Nginx 片段**：`location /api/<名字>/ { ... }`，带 `limit_req` 与转发头。
   - **需要 root 的步骤**：单独列出，注明“需主人确认后手动执行”。
5. 代码块要完整可用，但整体保持紧凑。
