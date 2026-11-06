// 工具定义（Anthropic Messages API 的 tools 格式）与执行器。所有工具都是只读的。
import { systemInfo, listeningPorts, serviceHealth, fmtBytes, fmtDuration } from './system.mjs';

const MAX_TOOL_OUTPUT = 8000;

export const TOOL_DEFS = [
  {
    name: 'LS',
    description: '列出虚拟文件系统中某个目录的内容。目录名以 / 结尾。',
    input_schema: { type: 'object', properties: { path: { type: 'string', description: '目录路径，默认为当前目录' } } },
  },
  {
    name: 'Read',
    description: '读取虚拟文件系统中的文本文件，返回带行号的内容。',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文件路径，例如 server/security.md' },
        offset: { type: 'integer', description: '起始行号（从 1 开始）' },
        limit: { type: 'integer', description: '最多读取的行数' },
      },
      required: ['path'],
    },
  },
  {
    name: 'Grep',
    description: '在虚拟文件系统中按关键字（不区分大小写的字面匹配）搜索，返回 文件:行号: 内容。',
    input_schema: {
      type: 'object',
      properties: { pattern: { type: 'string' }, path: { type: 'string', description: '搜索范围目录，默认 /' } },
      required: ['pattern'],
    },
  },
  {
    name: 'SystemInfo',
    description: '读取服务器此刻的真实状态：系统版本、运行时长、负载、CPU、内存、磁盘。',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'Ports',
    description: '列出服务器上真实的 TCP 监听端口，标注绑定范围（公网 / 本机）和对应服务。',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'ServiceHealth',
    description: '请求各后端的健康检查接口，并读取 systemd 服务状态。',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'Skill',
    description: '加载一个 skill 的完整说明。当用户的需求明显匹配某个 skill 时先调用它，再按说明执行。',
    input_schema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
  },
  {
    name: 'SiteSearch',
    description: '在网站已发布的公开页面（主页、简历、项目、博客笔记与文章、Agent 工坊）里全文检索，返回 页面 › 小节、片段和链接。回答关于主人、项目、博客观点的问题之前先搜；关键词用页面里可能出现的词，必要时换个说法再搜。',
    input_schema: {
      type: 'object',
      properties: { query: { type: 'string', description: '关键词或短语，例如「证据优先」「Text-to-SQL」' }, limit: { type: 'integer', description: '最多返回几条，默认 6' } },
      required: ['query'],
    },
  },
  {
    name: 'ReadPage',
    description: '读取网站上一个公开页面的正文（按小节组织），可以只读一节。引用观点前先读原文，回答里附上页面链接。',
    input_schema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '页面路径，例如 /blog/notes/ontology/、/projects/，也可以带 #锚点' },
        section: { type: 'string', description: '可选：小节标题或锚点，只读这一节' },
      },
      required: ['url'],
    },
  },
  {
    name: 'Ontology',
    description: '查询导游的世界模型（本体）：这里有哪些对象、属于哪一类、彼此是什么关系、每条边界由什么机制守住，也包含博客「Agent 学习本体」的笔记节点及其关系。op=schema 看类与关系的定义；op=find 按关键词和/或类找实体；op=entity 看一个实体的属性、来源和关系；op=path 找两个实体之间的关系链。',
    input_schema: {
      type: 'object',
      properties: {
        op: { type: 'string', enum: ['schema', 'find', 'entity', 'path'] },
        id: { type: 'string', description: 'op=entity：实体 id、名称、别名或页面路径，例如 server-guide、证据优先、/resume/' },
        query: { type: 'string', description: 'op=find：关键词' },
        class: { type: 'string', description: 'op=find：只找某一类，例如 Service、Boundary、Concept、Tool' },
        from: { type: 'string', description: 'op=path：起点' },
        to: { type: 'string', description: 'op=path：终点' },
      },
      required: ['op'],
    },
  },
  {
    name: 'TodoWrite',
    description: '为多步骤任务创建或更新任务清单，界面会以清单形式展示给用户。每次传入完整清单。',
    input_schema: {
      type: 'object',
      properties: {
        todos: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              content: { type: 'string' },
              status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
            },
            required: ['content', 'status'],
          },
        },
      },
      required: ['todos'],
    },
  },
];

export const TOOL_NAMES = new Set(TOOL_DEFS.map((t) => t.name));

// 动作契约：工具有什么效果、读什么、由什么守住。和 TOOL_DEFS 分开放——它是给人和世界模型看的，不发给模型。
export const TOOL_CONTRACTS = {
  LS: { effect: '只读', reads: '内存虚拟文件系统（公开资料）', guard: 'vfs.mjs 路径解析，退不出虚拟根目录' },
  Read: { effect: '只读', reads: '内存虚拟文件系统（公开资料）', guard: 'vfs.mjs 路径解析，退不出虚拟根目录' },
  Grep: { effect: '只读', reads: '内存虚拟文件系统（公开资料）', guard: '字面匹配，关键字限长 80' },
  SystemInfo: { effect: '只读', reads: 'os 模块、/proc/meminfo、statfs(/)', guard: '只有读系统调用' },
  Ports: { effect: '只读', reads: '/proc/net/tcp、/proc/net/tcp6', guard: '只读文件' },
  ServiceHealth: { effect: '只读', reads: '本机 /health 接口、systemctl is-active', guard: 'execFile 固定参数和固定服务名，URL 写死' },
  SiteSearch: { effect: '只读', reads: '已发布的公开页面', guard: 'site.mjs 页面白名单（只含公开页面，不含 noindex 页面）' },
  ReadPage: { effect: '只读', reads: '已发布的公开页面', guard: 'site.mjs 页面白名单，只能按 URL 取索引里的页面' },
  Ontology: { effect: '只读', reads: '世界模型：设定 + 博客图谱 + 运行时生成', guard: '构建时按 domain / range 校验' },
  Skill: { effect: '只读', reads: 'vfs/skills/*/SKILL.md', guard: '只能按名字取已加载的 skill' },
  TodoWrite: { effect: '只写本会话内存里的任务清单', reads: '无', guard: '最多 12 项，随会话回收' },
};

function clip(text) {
  return text.length > MAX_TOOL_OUTPUT ? `${text.slice(0, MAX_TOOL_OUTPUT)}\n…（已截断）` : text;
}

function pct(part, total) {
  return total ? Math.round((part / total) * 100) : 0;
}

function pad(s, n) {
  s = String(s);
  let width = 0;
  for (const ch of s) width += ch.charCodeAt(0) > 0x2e80 ? 2 : 1;
  return s + ' '.repeat(Math.max(1, n - width));
}

export function formatSystemInfo(info) {
  const mem = info.memory;
  const used = mem.total - mem.available;
  const lines = [
    `系统      ${info.os}（内核 ${info.kernel}，${info.arch}）`,
    `运行时长  ${fmtDuration(info.uptimeSeconds)}`,
    `负载      ${info.loadavg.join(' / ')}（1 / 5 / 15 分钟，${info.cpu.cores} 核）`,
    `CPU       ${info.cpu.model}`,
    `内存      已用 ${fmtBytes(used)} / ${fmtBytes(mem.total)}，可用 ${fmtBytes(mem.available)}（${pct(mem.available, mem.total)}%）`,
  ];
  if (mem.swapTotal) lines.push(`Swap      已用 ${fmtBytes(mem.swapTotal - mem.swapFree)} / ${fmtBytes(mem.swapTotal)}`);
  if (info.disk) {
    const d = info.disk;
    lines.push(`磁盘 /    已用 ${fmtBytes(d.total - d.free)} / ${fmtBytes(d.total)}（${pct(d.total - d.free, d.total)}%），可用 ${fmtBytes(d.available)}`);
  }
  lines.push(`Node.js   ${info.node}，srv-guide 进程占用 ${fmtBytes(info.guideRss)}`);
  return lines.join('\n');
}

const SCOPE_LABEL = { public: '公网', loopback: '本机', other: '内网' };

export function formatPorts({ sample, ports }) {
  const lines = [`${pad('地址', 16)}${pad('端口', 7)}${pad('范围', 6)}服务`];
  for (const p of ports) lines.push(`${pad(p.address, 16)}${pad(p.port, 7)}${pad(SCOPE_LABEL[p.scope], 6)}${p.service}`);
  if (sample) lines.push('', '（当前运行环境不是 Linux，以上为示例数据）');
  return lines.join('\n');
}

export function formatHealth({ checks, systemd }) {
  const lines = ['健康检查：'];
  for (const c of checks) {
    lines.push(`  ${c.ok ? '✔' : '✘'} ${pad(c.name, 16)}${c.status ? `HTTP ${c.status}` : c.error}  ${c.ms}ms${c.note ? `  ${c.note}` : ''}`);
  }
  if (systemd) {
    lines.push('systemd：');
    for (const [unit, state] of Object.entries(systemd)) lines.push(`  ${state === 'active' ? '●' : '○'} ${pad(unit, 30)}${state}`);
  } else {
    lines.push('systemd：当前环境无法读取（非 Linux 或无权限）');
  }
  return lines.join('\n');
}

// 博客笔记的类型与阶段（来自世界模型），用来提醒模型「起步笔记」不是结论
function noteTag(ontology, url) {
  const note = ontology?.noteForUrl(url);
  if (!note) return '';
  return `[${ontology.classes[note.class]?.label || note.class} · ${note.stageLabel}]`;
}

// 返回 { content: 给模型的文本, summary: 界面上的一行摘要, isError, evidence: 本次调用真正读到/查到/实测了什么 }
export async function runTool(name, input, ctx) {
  const result = await execTool(name, input, ctx);
  if (result.isError) delete result.evidence;
  return result;
}

async function execTool(name, input, ctx) {
  const { vfs, skills, session, site, ontology } = ctx;
  input = input && typeof input === 'object' ? input : {};
  try {
    switch (name) {
      case 'LS': {
        const p = vfs.resolve(input.path, session.cwd);
        const entries = vfs.list(p);
        if (!entries) return { content: `不是目录：${p}`, summary: `不是目录：${p}`, isError: true };
        return { content: `${p}\n${entries.join('\n')}`, summary: `列出 ${entries.length} 项` };
      }
      case 'Read': {
        const p = vfs.resolve(input.path, session.cwd);
        if (!vfs.isFile(p)) return { content: `文件不存在：${p}`, summary: `文件不存在：${p}`, isError: true };
        const all = vfs.read(p).split('\n');
        const start = Math.max(1, Number(input.offset) || 1);
        const limit = Math.min(400, Math.max(1, Number(input.limit) || 400));
        const slice = all.slice(start - 1, start - 1 + limit);
        const body = slice.map((line, i) => `${String(start + i).padStart(4)}\t${line}`).join('\n');
        return { content: clip(body), summary: `读取 ${slice.length} 行`, evidence: [{ kind: 'file', ref: p }] };
      }
      case 'Grep': {
        const pattern = String(input.pattern || '').slice(0, 80);
        if (!pattern) return { content: '缺少 pattern', summary: '缺少 pattern', isError: true };
        const hits = vfs.grep(pattern, vfs.resolve(input.path || '/', session.cwd));
        return { content: clip(hits.join('\n') || '没有匹配'), summary: `${hits.length} 处匹配`, evidence: [{ kind: 'search', ref: pattern, hits: hits.length, scope: 'vfs' }] };
      }
      case 'SystemInfo': {
        const info = systemInfo();
        const mem = info.memory;
        const summary = `负载 ${info.loadavg[0]} · 内存可用 ${pct(mem.available, mem.total)}%${info.disk ? ` · 磁盘已用 ${pct(info.disk.total - info.disk.free, info.disk.total)}%` : ''}`;
        return { content: formatSystemInfo(info), summary, evidence: [{ kind: 'observe', ref: name }] };
      }
      case 'Ports': {
        const result = listeningPorts();
        const pub = result.ports.filter((p) => p.scope === 'public').map((p) => p.port);
        return { content: formatPorts(result), summary: `${result.ports.length} 个监听端口，公网 ${pub.length} 个（${[...new Set(pub)].join(', ')}）`, evidence: [{ kind: 'observe', ref: name }] };
      }
      case 'ServiceHealth': {
        const result = await serviceHealth();
        const ok = result.checks.filter((c) => c.ok).length;
        return { content: formatHealth(result), summary: `健康检查 ${ok}/${result.checks.length} 通过`, evidence: [{ kind: 'observe', ref: name }] };
      }
      case 'SiteSearch': {
        if (!site) return { content: '网站索引不可用', summary: '网站索引不可用', isError: true };
        const query = String(input.query || '').trim().slice(0, 80);
        if (!query) return { content: '缺少 query', summary: '缺少 query', isError: true };
        const hits = site.search(query, Math.min(10, Math.max(1, Number(input.limit) || 6)));
        const body = hits.map((h, i) => {
          const link = `${h.url}${h.anchor ? `#${h.anchor}` : ''}`;
          const where = h.heading && h.heading !== h.title ? `${h.title} › ${h.heading}` : h.title;
          return `${i + 1}. ${where}  ${link} ${noteTag(ontology, h.url)}\n   ${h.snippet}`;
        }).join('\n');
        return {
          content: body ? `${body}\n\n（片段只是线索，引用观点前用 ReadPage 读原文）` : `网站上没有找到「${query}」。可以换个说法再搜；如果仍然没有，就如实说网站没有提到。`,
          summary: hits.length ? `${hits.length} 条结果，${new Set(hits.map((h) => h.url)).size} 个页面` : '没有结果',
          evidence: [{ kind: 'search', ref: query, hits: hits.length, scope: 'site' }],
        };
      }
      case 'ReadPage': {
        if (!site) return { content: '网站索引不可用', summary: '网站索引不可用', isError: true };
        const page = site.read(input.url, input.section);
        if (!page) {
          const known = site.pages().map((p) => p.url).join('、');
          return { content: `没有这个公开页面：${input.url}。已索引的页面：${known}`, summary: '没有这个页面', isError: true };
        }
        const note = ontology?.noteForUrl(page.url);
        const head = [`标题：${page.title}`, `链接：${page.url}`];
        if (note) head.push(`笔记：${noteTag(ontology, page.url)}${note.stage === 'seed' ? '——起步笔记，观点还在形成，转述时说明这一点' : ''}`);
        if (input.section && !page.section) head.push(`（没有找到小节「${input.section}」，以下是全文）`);
        if (page.toc.length) head.push(`本页小节：${page.toc.join(' / ')}`);
        const anchor = page.section ? `#${page.section}` : '';
        return {
          content: clip(`${head.join('\n')}\n---\n${page.text}`),
          summary: `${page.title}${page.section ? ` › ${page.section}` : ''} · ${page.text.length} 字`,
          evidence: [{ kind: 'page', ref: page.url + anchor, title: page.title }],
        };
      }
      case 'Ontology': {
        if (!ontology) return { content: '世界模型不可用', summary: '世界模型不可用', isError: true };
        const r = ontology.query(input);
        const evidence = r.entities.length ? r.entities.map((id) => ({ kind: 'entity', ref: id })) : [{ kind: 'model', ref: input.op || 'schema' }];
        return { content: clip(r.content), summary: r.summary, isError: r.isError, evidence };
      }
      case 'Skill': {
        const skill = skills.get(String(input.name || '').replace(/^\//, ''));
        if (!skill) return { content: `没有这个 skill。可用：${[...skills.keys()].join(', ')}`, summary: '没有这个 skill', isError: true };
        return { content: skill.body, summary: `已加载 skill：${skill.name}` };
      }
      case 'TodoWrite': {
        const todos = Array.isArray(input.todos) ? input.todos.slice(0, 12) : [];
        session.todos = todos.map((t) => ({ content: String(t.content || '').slice(0, 120), status: t.status }));
        const done = session.todos.filter((t) => t.status === 'completed').length;
        return { content: '任务清单已更新，请继续执行。', summary: `${done}/${session.todos.length} 已完成` };
      }
      default:
        return { content: `未知工具：${name}`, summary: `未知工具：${name}`, isError: true };
    }
  } catch (err) {
    return { content: `工具执行失败：${err.message}`, summary: '工具执行失败', isError: true };
  }
}
