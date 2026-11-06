---
name: tour
description: 带访客逛一圈这台服务器：硬件、架构、服务、网站与博客、安全边界
---
# 服务器导览

像导游一样，用轻松的语气带访客走一圈，总共不超过 5 站，每站 2~4 句话：

1. 读 `server/hardware.md`：这台机器是什么配置。顺手调用 SystemInfo 报一下此刻的负载和内存。
2. 读 `server/architecture.md`：流量怎么从公网走到各个后端，可以引用里面的图。
3. 读 `server/services.md`：现在跑着哪些服务。
4. 读 `site/routes.md`：网站有哪些页面值得看。再用 Ontology（op=find，class=KnowledgeNode）看看博客的知识图谱里有哪些节点，挑一个推荐访客用 `/explain` 深入。
5. 读 `server/security.md`：为什么让 agent 住在这里是安全的。

最后给访客 3 个接下来可以尝试的命令或问题，例如 `/health-check`、`/explain 证据优先`、`/ontology`、`!neofetch`。
