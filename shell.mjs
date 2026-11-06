// `!` 模式下的只读沙盒 shell：命令全部用 JS 实现，只能看虚拟文件系统和只读系统指标。
import { systemInfo, listeningPorts, serviceHealth, fmtBytes, fmtDuration } from './system.mjs';
import { TOOL_DEFS, formatPorts, formatHealth, runTool } from './tools.mjs';

const HELP = `只读沙盒 shell，支持这些命令：

  ls [-l] [路径]     列目录            cd <路径>        切换目录
  cat <文件>         看文件            head [-n N] <文件>
  tree [路径]        目录树            grep <关键字> [路径]
  pwd  whoami  hostname  uname [-a]  date  echo  uptime
  free [-h]          内存              df [-h]          磁盘
  ps                 服务状态          ports            监听端口
  neofetch           系统名片          clear            清屏

  site                         网站公开页面列表
  site search <关键词>         全文检索网站
  site read <路径> [小节]      读一页，例如 site read /blog/notes/ontology/
  onto                         世界模型：类与关系
  onto <实体>                  看一个实体，例如 onto nginx、onto 证据优先
  onto find <关键词>           按关键词找实体
  onto class <类>              列出某一类，例如 onto class Boundary
  onto path <起点> <终点>      两个实体之间的关系链

这里没有真实 shell：rm、sudo、vim 之类的不会生效。
想问问题？去掉开头的 ! 直接用中文问我。`;

export function splitArgs(line) {
  const args = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(line))) args.push(m[1] ?? m[2] ?? m[3]);
  return args;
}

const LOGO = [
  '      ___      ',
  '     /   \\     ',
  '    | ◉ ◉ |    ',
  '    |  ▽  |    ',
  '   /|_____|\\   ',
  '  / |  ⚙  | \\  ',
  '    |_____|    ',
  '    /     \\    ',
];

function neofetch({ skills, ontology }) {
  const info = systemInfo();
  const mem = info.memory;
  const world = ontology ? (() => { const { entities, edges } = ontology.stats(); return `World: ${entities} entities · ${edges} relations`; })() : '';
  const rows = [
    'visitor@srv-guide',
    '─────────────────',
    `OS: ${info.os}`,
    `Kernel: ${info.kernel}`,
    `Uptime: ${fmtDuration(info.uptimeSeconds)}`,
    `CPU: ${info.cpu.cores} 核`,
    `Memory: ${fmtBytes(mem.total - mem.available)} / ${fmtBytes(mem.total)}`,
    `Load: ${info.loadavg.join(' ')}`,
    'Shell: srv-guide sandbox',
    `Agent: deepseek · ${TOOL_DEFS.length} tools · ${skills?.size ?? 0} skills`,
    world,
  ].filter(Boolean);
  const n = Math.max(LOGO.length, rows.length);
  const out = [];
  for (let i = 0; i < n; i++) out.push(`${LOGO[i] || ' '.repeat(15)}  ${rows[i] || ''}`);
  return out.join('\n');
}

export async function runShell(line, ctx) {
  const { vfs, session } = ctx;
  const raw = String(line || '').trim();
  if (!raw) return { output: '' };
  if (/[|;&><`$]/.test(raw)) return { output: '沙盒不支持管道、重定向和变量。一次只运行一条命令吧。' };
  const [cmd, ...args] = splitArgs(raw);
  const flags = args.filter((a) => a.startsWith('-'));
  const rest = args.filter((a) => !a.startsWith('-'));
  const cwd = session.cwd;

  switch (cmd) {
    case 'help':
      return { output: HELP };
    case 'clear':
      return { output: '', clear: true };
    case 'pwd':
      return { output: cwd };
    case 'whoami':
      return { output: 'visitor' };
    case 'hostname':
      return { output: 'srv-guide' };
    case 'date':
      return { output: new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) + ' (Asia/Shanghai)' };
    case 'echo':
      return { output: args.join(' ') };
    case 'uname': {
      const info = systemInfo();
      return { output: flags.includes('-a') ? `Linux srv-guide ${info.kernel} ${info.arch} ${info.os}` : 'Linux' };
    }
    case 'cd': {
      const target = vfs.resolve(rest[0] || '/', cwd);
      if (!vfs.isDir(target)) return { output: `cd: ${rest[0]}: 没有那个目录` };
      session.cwd = target;
      return { output: '', cwd: target };
    }
    case 'ls':
    case 'll': {
      const target = vfs.resolve(rest[0] || '.', cwd);
      if (vfs.isFile(target)) return { output: target.split('/').pop() };
      const entries = vfs.list(target);
      if (!entries) return { output: `ls: 无法访问 '${rest[0]}': 没有那个文件或目录` };
      if (cmd === 'll' || flags.some((f) => f.includes('l'))) {
        return {
          output: entries.map((e) => {
            const full = target === '/' ? `/${e.replace(/\/$/, '')}` : `${target}/${e.replace(/\/$/, '')}`;
            const size = e.endsWith('/') ? 4096 : Buffer.byteLength(vfs.read(full));
            return `${e.endsWith('/') ? 'dr-xr-xr-x' : '-r--r--r--'}  visitor  ${String(size).padStart(6)}  ${e}`;
          }).join('\n'),
        };
      }
      return { output: entries.join('  ') };
    }
    case 'cat':
    case 'less':
    case 'more': {
      if (!rest.length) return { output: `${cmd}: 缺少文件名` };
      const out = [];
      for (const name of rest.slice(0, 3)) {
        const p = vfs.resolve(name, cwd);
        if (vfs.isDir(p)) out.push(`${cmd}: ${name}: 是一个目录`);
        else if (!vfs.isFile(p)) out.push(`${cmd}: ${name}: 没有那个文件或目录`);
        else out.push(vfs.read(p).trimEnd());
      }
      return { output: out.join('\n') };
    }
    case 'head':
    case 'tail': {
      const nIdx = args.indexOf('-n');
      const n = Math.min(200, Number(nIdx >= 0 ? args[nIdx + 1] : 10) || 10);
      const file = rest.filter((a) => a !== String(n)).at(-1);
      const p = vfs.resolve(file || '', cwd);
      if (!vfs.isFile(p)) return { output: `${cmd}: ${file || ''}: 没有那个文件` };
      const lines = vfs.read(p).trimEnd().split('\n');
      return { output: (cmd === 'head' ? lines.slice(0, n) : lines.slice(-n)).join('\n') };
    }
    case 'tree': {
      const target = vfs.resolve(rest[0] || '.', cwd);
      if (!vfs.isDir(target)) return { output: `tree: ${rest[0]}: 不是目录` };
      return { output: [target, ...vfs.tree(target)].join('\n') };
    }
    case 'grep': {
      if (!rest[0]) return { output: '用法：grep <关键字> [路径]' };
      const hits = vfs.grep(rest[0].slice(0, 80), vfs.resolve(rest[1] || '/', cwd));
      return { output: hits.slice(0, 60).join('\n') || '（没有匹配）' };
    }
    case 'uptime': {
      const info = systemInfo();
      return { output: `up ${fmtDuration(info.uptimeSeconds)},  load average: ${info.loadavg.join(', ')}` };
    }
    case 'free': {
      const { memory: m } = systemInfo();
      const f = flags.some((x) => x.includes('h')) ? fmtBytes : (n) => Math.round(n / 1024);
      return {
        output: [
          '              total        used   available',
          `Mem:   ${String(f(m.total)).padStart(12)}${String(f(m.total - m.available)).padStart(12)}${String(f(m.available)).padStart(12)}`,
          `Swap:  ${String(f(m.swapTotal)).padStart(12)}${String(f(m.swapTotal - m.swapFree)).padStart(12)}${String(f(m.swapFree)).padStart(12)}`,
        ].join('\n'),
      };
    }
    case 'df': {
      const { disk: d } = systemInfo();
      if (!d) return { output: 'df: 无法读取磁盘信息' };
      const f = flags.some((x) => x.includes('h')) ? fmtBytes : (n) => Math.round(n / 1024);
      const use = Math.round(((d.total - d.free) / d.total) * 100);
      return { output: `Filesystem      Size   Used  Avail Use% Mounted on\n/dev/vda1   ${String(f(d.total)).padStart(8)}${String(f(d.total - d.free)).padStart(7)}${String(f(d.available)).padStart(7)} ${String(use).padStart(3)}% /` };
    }
    case 'ps':
    case 'top':
    case 'htop':
    case 'systemctl':
      return { output: formatHealth(await serviceHealth()) + (cmd === 'ps' ? '' : `\n\n（沙盒里没有真正的 ${cmd}，这是服务状态摘要）`) };
    case 'ports':
    case 'netstat':
    case 'ss':
      return { output: formatPorts(listeningPorts()) };
    case 'neofetch':
    case 'fastfetch':
      return { output: neofetch(ctx) };
    case 'site': {
      if (!ctx.site) return { output: 'site: 网站索引未加载' };
      const [sub, ...more] = rest;
      if (!sub) {
        const pages = ctx.site.pages();
        return { output: [`已索引 ${pages.length} 个公开页面：`, ...pages.map((p) => `  ${p.url.padEnd(34)} ${p.title}`), '', '用 site search <关键词> 检索，site read <路径> 读原文。'].join('\n') };
      }
      if (sub === 'search' || sub === 'grep') {
        if (!more.length) return { output: '用法：site search <关键词>' };
        return { output: (await runTool('SiteSearch', { query: more.join(' ').slice(0, 80) }, ctx)).content };
      }
      if (sub === 'read' || sub === 'cat') {
        if (!more[0]) return { output: '用法：site read <路径> [小节]' };
        return { output: (await runTool('ReadPage', { url: more[0], section: more.slice(1).join(' ') }, ctx)).content };
      }
      return { output: `site: 未知子命令 ${sub}。可用：search、read` };
    }
    case 'onto':
    case 'ontology': {
      if (!ctx.ontology) return { output: 'onto: 世界模型未加载' };
      const [sub, ...more] = rest;
      const q = more.join(' ');
      let input;
      if (!sub || sub === 'schema') input = { op: 'schema' };
      else if (sub === 'find') input = { op: 'find', query: q };
      else if (sub === 'class') input = { op: 'find', class: more[0] || '' };
      else if (sub === 'path') input = more.length >= 2 ? { op: 'path', from: more[0], to: more[1] } : null;
      else input = { op: 'entity', id: rest.join(' ') };
      if (!input) return { output: '用法：onto path <起点> <终点>' };
      return { output: ctx.ontology.query(input).content };
    }
    case 'sudo':
    case 'su':
      return { output: 'visitor 不在 sudoers 文件中。此事将被报告。\n（开玩笑的，不会报告。但这里确实没有 root。）' };
    case 'rm':
    case 'mv':
    case 'cp':
    case 'touch':
    case 'mkdir':
    case 'chmod':
    case 'chown':
    case 'vim':
    case 'vi':
    case 'nano':
      return { output: `${cmd}: 只读文件系统。这里的一切都只能看，不能改。` };
    case 'exit':
    case 'logout':
      return { output: '你可以关掉标签页，但我会一直在这台服务器上等你回来。' };
    case 'curl':
    case 'wget':
    case 'ssh':
    case 'ping':
      return { output: `${cmd}: 沙盒没有网络出口。想看服务状态可以用 ps 或 ports。` };
    default:
      return { output: `bash: ${cmd}: command not found\n输入 !help 查看可用命令，或去掉 ! 直接用中文问我。` };
  }
}
