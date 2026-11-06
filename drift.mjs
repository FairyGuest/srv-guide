// 漂移检测：拿世界模型里的结构化属性（unit、port、path）去和真正生效的配置对账。
//   release.sh 的 services 列表 ⇔ 推送即部署「部署」了哪些服务、各自端口
//   systemd 单元的 PORT 与 ReadWritePaths ⇔ 服务「监听」的端点、「写入」的数据目录
//   Nginx 的 location → proxy_pass ⇔ 路由「转发到」的服务
// 对不上的每一处都是一条漂移：要么本体过时了，要么配置被改了。纯函数，不起 shell。
//
// CLI（推送即部署时由 release.sh 调用）：
//   node drift.mjs [--repo 目录] [--live] [--out 文件]
//   --live 额外检查服务器上已安装的 systemd 单元和 Nginx 配置；--out 把 JSON 报告写到文件
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Ontology } from './ontology.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

export function parseReleaseServices(text) {
  const m = /^services=\(([^)]*)\)/m.exec(text || '');
  if (!m) return null;
  return m[1].trim().split(/\s+/).filter(Boolean).map((entry) => {
    const [src, dst, unit, port] = entry.split(':');
    return { src, dst, unit, port: Number(port) };
  });
}

export function parseUnit(text) {
  const env = {};
  for (const m of text.matchAll(/^Environment=(\w+)=(.*)$/gm)) env[m[1]] = m[2].trim();
  const rw = [...text.matchAll(/^ReadWritePaths=(.*)$/gm)].flatMap((m) => m[1].trim().split(/\s+/)).filter(Boolean);
  return { port: env.PORT ? Number(env.PORT) : null, readWrite: rw.map((p) => p.replace(/^-/, '').replace(/\/$/, '')) };
}

export function parseNginx(text) {
  const out = [];
  // 只看转发到本机端口的 location；静态 location 由 Nginx 自己处理，不对应后端
  const re = /location\s+(=\s*|\^~\s*)?(\/[^\s{]*)\s*\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}/g;
  for (const m of (text || '').matchAll(re)) {
    const pass = /proxy_pass\s+http:\/\/127\.0\.0\.1:(\d+)/.exec(m[3]);
    if (pass) out.push({ path: m[2], exact: (m[1] || '').trim() === '=', port: Number(pass[1]) });
  }
  return out;
}

// 从本体里取出对账要用的视图
export function infraView(ontology) {
  const ents = [...ontology.entities.values()];
  const outs = (id, rel) => (ontology.out.get(id) || []).filter((e) => e.relation === rel).map((e) => ontology.entities.get(e.target));
  const services = ents.filter((e) => e.class === 'Service' && e.unit).map((s) => ({
    id: s.id,
    unit: s.unit,
    ports: outs(s.id, 'listens_on').map((ep) => ep.port).filter(Boolean),
    writes: outs(s.id, 'writes').map((d) => d.path).filter(Boolean),
  }));
  const routes = ents.filter((e) => e.class === 'Endpoint' && e.path).map((r) => {
    const svc = outs(r.id, 'proxies_to')[0];
    return { id: r.id, path: r.path, service: svc?.id || null, ports: svc ? services.find((s) => s.id === svc.id)?.ports || [] : [] };
  });
  const deployed = ents.filter((e) => e.class === 'Pipeline').flatMap((p) => outs(p.id, 'deploys').map((s) => s.id));
  return { services, routes, deployed };
}

const unitKey = (name) => name.replace(/\.service$/, '');

// sources: { release: 文本, units: { 'x.service': 文本 | null（应在但缺失） }, nginx: 文本, where: '仓库' | '线上' }
export function detectDrift(ontology, sources) {
  const view = infraView(ontology);
  const byUnit = new Map(view.services.map((s) => [s.unit, s]));
  const items = [];
  const add = (subject, problem, source) => items.push({ subject, problem, source });
  const where = sources.where || '仓库';

  if (sources.release !== undefined) {
    const list = parseReleaseServices(sources.release);
    if (!list) add('push-deploy', '读不到 release.sh 里的 services 列表', 'release.sh');
    for (const r of list || []) {
      const s = byUnit.get(r.unit);
      if (!s) { add('push-deploy', `release.sh 会部署 ${r.unit}，本体里没有这个服务`, 'release.sh'); continue; }
      if (!s.ports.includes(r.port)) add(s.id, `release.sh 按端口 ${r.port} 做健康检查，本体里它监听 ${s.ports.join('、') || '（没有登记端口）'}`, 'release.sh');
      if (!view.deployed.includes(s.id)) add(s.id, 'release.sh 会部署它，本体里推送即部署没有「部署」它', 'release.sh');
    }
    for (const id of view.deployed) {
      const s = view.services.find((x) => x.id === id);
      if (s && list && !list.some((r) => r.unit === s.unit)) add(id, '本体说推送即部署会部署它，release.sh 的 services 里没有', 'release.sh');
    }
  }

  if (sources.units) {
    const names = Object.keys(sources.units);
    for (const name of names) {
      const label = `${where === '线上' ? '/etc/systemd/system/' : 'systemd/'}${name}`;
      const text = sources.units[name];
      // 由同名 timer 触发的 oneshot service 归在 timer 名下
      const timer = name.endsWith('.service') && names.includes(name.replace(/\.service$/, '.timer'));
      const s = byUnit.get(unitKey(name)) || (timer ? byUnit.get(name.replace(/\.service$/, '.timer')) : null);
      if (!s) { add('server', `单元 ${name} 不在本体里`, label); continue; }
      if (text === null) { add(s.id, `${where}缺少单元文件 ${name}`, label); continue; }
      if (timer) continue;
      const u = parseUnit(text);
      if (u.port && !s.ports.includes(u.port)) add(s.id, `单元里 PORT=${u.port}，本体里它监听 ${s.ports.join('、') || '（没有登记端口）'}`, label);
      if (!s.ports.length && !u.port) continue;
      for (const p of u.readWrite) if (!s.writes.includes(p)) add(s.id, `单元允许写 ${p}，本体里没有对应的「写入」关系`, label);
      for (const p of s.writes) if (!u.readWrite.includes(p)) add(s.id, `本体说它写入 ${p}，单元的 ReadWritePaths 没有放行`, label);
    }
  }

  if (sources.nginx !== undefined) {
    const label = where === '线上' ? '/etc/nginx/conf.d/personal-site.conf' : 'nginx/personal-site-https.conf';
    const locs = parseNginx(sources.nginx);
    for (const loc of locs) {
      const route = view.routes.filter((r) => loc.path.startsWith(r.path)).sort((a, b) => b.path.length - a.path.length)[0];
      if (!route) { add('nginx', `Nginx 把 ${loc.path} 转发到 :${loc.port}，本体里没有这条路由`, label); continue; }
      if (!route.ports.includes(loc.port)) add(route.id, `Nginx 把 ${loc.path} 转发到 :${loc.port}，本体里它转发到 ${route.service || '（没有）'}${route.ports.length ? `:${route.ports.join('/')}` : ''}`, label);
    }
    for (const r of view.routes) {
      if (!locs.some((l) => l.path === r.path && !l.exact)) add(r.id, `本体里有路由 ${r.path}，Nginx 配置里没有`, label);
    }
  }
  return items;
}

// 运行时漂移：端口的实际监听情况和本体对不上
export function portDrift(ontology, ports) {
  const items = [];
  const eps = [...ontology.entities.values()].filter((e) => e.class === 'Endpoint' && e.port);
  const ephemeral = [...ontology.entities.values()].find((e) => e.ephemeralPorts);
  const notes = [];
  for (const ep of eps) {
    const hits = ports.filter((p) => p.port === ep.port);
    if (!hits.length) items.push({ subject: ep.id, problem: `本体说 ${ep.label} 在监听，实际没有进程监听 ${ep.port}`, source: '运行时' });
    else if (ep.scope === 'loopback' && hits.some((p) => p.scope === 'public')) items.push({ subject: ep.id, problem: `${ep.port} 应该只听本机，实际对公网开放`, source: '运行时' });
  }
  for (const p of ports) {
    if (eps.some((ep) => ep.port === p.port)) continue;
    if (p.scope === 'loopback' && p.port >= 32768 && ephemeral) { notes.push(`${p.address}:${p.port} 是本机临时端口，按本体推断属于 ${ephemeral.label}`); continue; }
    items.push({ subject: 'server', problem: `${p.address}:${p.port}（${p.scope === 'public' ? '公网' : '本机'}）在监听，本体里没有登记`, source: '运行时' });
  }
  return { items, notes };
}

function readOr(file, fallback) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return fallback; }
}

export function repoSources(repo) {
  const dir = path.join(repo, 'systemd');
  const units = {};
  for (const f of fs.readdirSync(dir).filter((f) => /\.(service|timer)$/.test(f)).sort()) units[f] = fs.readFileSync(path.join(dir, f), 'utf8');
  return {
    where: '仓库',
    release: readOr(path.join(repo, 'deploy', 'release.sh'), ''),
    units,
    nginx: readOr(path.join(repo, 'nginx', 'personal-site-https.conf'), ''),
  };
}

export function liveSources(repo, etc = '/etc') {
  const units = {};
  for (const f of Object.keys(repoSources(repo).units)) units[f] = readOr(path.join(etc, 'systemd', 'system', f), null);
  return { where: '线上', units, nginx: readOr(path.join(etc, 'nginx', 'conf.d', 'personal-site.conf'), '') };
}

export function loadWorld(file = path.join(here, 'vfs', 'ontology', 'world.json')) {
  return Ontology.fromFile(file, { includeHidden: true });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const args = process.argv.slice(2);
  const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
  const repo = path.resolve(opt('--repo') || path.join(here, '..', '..'));
  const ontology = loadWorld();
  const items = detectDrift(ontology, repoSources(repo));
  if (args.includes('--live')) items.push(...detectDrift(ontology, liveSources(repo)));
  const view = infraView(ontology);
  const report = { checkedAt: new Date().toISOString(), commit: opt('--commit') || null, live: args.includes('--live'), checked: { services: view.services.length, routes: view.routes.length }, items };
  if (opt('--out')) fs.writeFileSync(opt('--out'), JSON.stringify(report, null, 2) + '\n');
  if (!items.length) console.log(`本体与配置一致（${view.services.length} 个服务、${view.routes.length} 条路由${report.live ? '，含线上单元和 Nginx' : ''}）`);
  for (const i of items) console.log(`漂移：${i.subject} — ${i.problem}  [${i.source}]`);
  if (args.includes('--strict') && items.length) process.exit(1);
}
