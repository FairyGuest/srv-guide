# srv-guide

住在个人服务器上的导游 Agent。访客在一个仿 Claude Code 的网页终端里和它对话，问这台服务器的硬件、架构、服务和安全边界，也可以问网站上的博客和项目。它只能读，不能改。

- 零第三方依赖，Node.js 24 直接运行
- 模型走 Anthropic Messages 协议（默认 DeepSeek 的兼容接口），没有 key 时离线运行
- 一套带类型的世界模型（本体），用来回答“谁依赖谁”，部署时还拿它和真实配置对账

## 快速开始

```bash
node dev.mjs
```

打开 <http://127.0.0.1:8080/guide/>。没有配置 key 时是离线模式，`!` 开头的只读 shell 命令照常可用。

想看完整的工具调用流程，用脚本化的假模型：

```bash
GUIDE_PROVIDER=mock node dev.mjs
```

接真模型：

```bash
LLM_API_KEY=你的key node dev.mjs
```

跑测试：

```bash
node --test
```

## 访客能做什么

| 输入 | 作用 |
| --- | --- |
| 直接提问 | 模型按需调用只读工具，回答附上读过的文件和页面 |
| `/tour` `/health-check` `/explain 概念` `/ontology` `/boundary` `/deploy-plan 项目描述` | 运行 skill（`vfs/skills/*/SKILL.md`） |
| `!ls` `!cat` `!grep` `!tree` `!free` `!uptime` `!site search 词` `!onto 实体` | 只读 shell，不经过模型 |
| `@server/architecture.md` | 把文件内容带进提问 |

## 结构

```
server.mjs      HTTP 后端：会话、SSE 流式对话、限流与每日 token 预算
agent.mjs       Agent 循环、系统提示、Anthropic 协议的流式解析、mock 模型
tools.mjs       11 个只读工具，每个都有动作契约（读什么、写什么、交回什么依据）
vfs.mjs         只读虚拟文件系统和 skill 加载
shell.mjs       ! 命令的解释器，拒绝管道、重定向和越出根目录
site.mjs        网站页面索引：按节切分、检索、按 URL 读取
ontology.mjs    世界模型：设定 + 博客知识图谱 + 运行时实体，按 domain/range 校验每条边
drift.mjs       漂移检测：本体 ⇔ release.sh、systemd 单元、Nginx location
live.mjs        活本体：给每个节点挂上实时状态（服务健康、内存、端口、最近部署）
system.mjs      读 /proc、systemctl show、健康探测；不在 Linux 上时返回样例数据
knock.mjs       把 Nginx 和 SSH 日志数成按天统计的扫描类型，不落 IP
vfs/            导游能读到的全部资料（这一份描述的是我自己的服务器）
web/guide/      网页终端
dev.mjs         本地试玩：起后端 + 提供网页 + 转发 /api/guide/
```

## 安全边界

- 工具全部只读。shell 不调用系统命令，`ls`、`cat` 读的是 `vfs/`，`free`、`uptime` 读的是 `/proc`
- 后端只监听 `127.0.0.1`，由 Nginx 代理 `/api/guide/`
- 每个 IP 每天的对话轮数、全站每日 token、单轮最多工具步数、同时运行的会话数都有上限（见下方环境变量）
- 日志只记 IP 的哈希
- 不公开的服务写在 `private/hidden.json`（不进仓库，格式见 `private/hidden.example.json`）：它们不进导游能读的资料，只在漂移对账和活本体的端口核对里使用，对外输出前会再过滤一遍

## 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `LLM_API_KEY` | 空 | 没有时离线运行 |
| `LLM_BASE_URL` | `https://api.deepseek.com/anthropic` | 任意 Anthropic Messages 兼容接口 |
| `LLM_MODEL` | `deepseek-flash` | |
| `LLM_MAX_TOKENS` | `1500` | 单次回复上限 |
| `GUIDE_PROVIDER` | 有 key 为 `live`，否则 `offline` | 也可设为 `mock` |
| `GUIDE_IP_TURNS` | `30` | 每个 IP 每天的轮数 |
| `GUIDE_DAILY_TOKENS` | `2000000` | 全站每日 token 预算 |
| `GUIDE_MAX_STEPS` | `8` | 单轮最多工具调用步数 |
| `GUIDE_MAX_CONCURRENT` | `6` | 同时运行的对话数 |
| `PORT` / `HOST` | `3003` / `127.0.0.1` | |
| `DATA_DIR` | `/srv/data/server-guide` | 会话日志和预算计数 |
| `VFS_DIR` | `./vfs` | |
| `SITE_DIR` | `/srv/www/personal` | 网站静态文件目录，用于站内检索 |
| `KNOCK_DIR` | `/srv/data/knock` | 扫描统计 |

## 换成你自己的服务器

1. 改写 `vfs/` 里的资料和 `vfs/ontology/world.json`（服务、端口、路由、数据目录、边界）
2. 改 `agent.mjs` 里 `buildSystem` 的开头一段，换成你的主机和身份
3. 改 `web/guide/` 里终端标题栏的主机名
4. 部署：Nginx 把 `/guide/` 指向 `web/guide/`，`location /api/guide/` 转发到 `127.0.0.1:3003/`（注意 SSE 要关缓冲）；systemd 以非 root 用户运行，`ReadWritePaths` 只给 `DATA_DIR`

部分测试依赖整站仓库（网站页面、`deploy/release.sh`、`systemd/`、`nginx/`），单独运行本仓库时自动跳过。设 `GUIDE_SITE` 和 `GUIDE_REPO` 指过去即可运行。

## License

MIT
