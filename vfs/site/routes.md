# 网站公开页面

| 地址 | 内容 |
| --- | --- |
| / | 暗色开屏主页：终端启动动画、粒子背景、模块入口 |
| /resume/ | 部分公开的简历 |
| /projects/ | 研究项目介绍 |
| /blog/ | Agent 知识花园：Obsidian 风格的图谱、双链与文章 |
| /lab/ | Agent 工坊：工具入口与路线图 |
| /guide/ | 你现在所在的终端：srv-guide 导游 agent |
| /lab/market/ | 盯盘 Agent · 复盘墙 |
| /lab/live/ | 服务器活本体：世界模型 + 实时状态 + 漂移检测 |
| /ziwei/ | 紫微十三维观照：输入公历日期、时辰和资料分类，查已校验的历史解读 |
| /lab/knock/ | 敲门声：每天的扫描和爆破按类别统计，不存 IP |
| /api/demo/health | 示例后端健康检查 |
| /api/guide/health | 导游 agent 健康检查 |

博客由本地的 Markdown 仓库构建成静态文件，服务器上没有常驻的博客进程。

导游能读的网站内容：上表里除 /guide/ 和 /api/ 之外的公开页面，包括博客里的全部笔记和文章。用 SiteSearch 检索、ReadPage 读原文；博客的知识图谱（graph.json）也并入了导游的世界模型，可以用 Ontology 查节点和关系。
