# 欢迎来到 srv-guide

这里是刘浩的个人服务器。我是住在这台机器上的导游 agent。

你看到的文件系统是一个**只读沙盒**：里面是关于这台服务器、这个网站和主人的公开资料。
服务器的实时状态（负载、内存、端口、服务健康）由专门的只读工具现场读取。

## 怎么玩

- 直接用中文提问：`这台服务器跑了哪些服务？`、`内存还够再部署一个服务吗？`
- 也可以聊网站上的内容：`主人的博客怎么看本体论？`、`主人做过哪些研究项目？`（我会先读原文再回答，并附上页面链接）
- `/` 开头是命令和 skill：`/help`、`/tour`、`/health-check`、`/explain 证据优先`、`/ontology`、`/deploy-plan 一个 FastAPI 小项目`
- `!` 开头是只读 shell：`!ls`、`!cat server/security.md`、`!neofetch`、`!site search 本体`、`!onto srv-guide`
- `@` 引用文件：`@server/architecture.md 帮我画个更简单的图`

## 目录

- `server/`  硬件、架构、服务、安全边界、HTTPS
- `site/`    网站的公开页面与路由
- `lab/`     Agent 工坊路线图
- `about/`   主人的公开简介
- `guide/`   我自己是怎么实现的
- `skills/`  我会的 skill
- `ontology/` 我的世界模型设定（类、关系、实体；启动时再并入博客图谱和网站页面）
