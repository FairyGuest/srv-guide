// 活本体：世界模型里的基础设施部分（人、机器、服务、端点、数据目录、外部服务、流水线），配上实时状态，给 /lab/live/ 画图。
// 只读：systemctl show、本机健康检查、/proc、stat 数据目录，再读 release.sh 留在 DATA_DIR 里的部署记录和漂移报告。
// 不调用模型，不接受访客参数；结果缓存几秒，并发请求共用同一次采集。
import fs from 'node:fs';
import path from 'node:path';
import { systemdShow, probe, listeningPorts, systemInfo, fmtBytes, fmtDuration } from './system.mjs';
import { portDrift } from './drift.mjs';

const GRAPH_CLASSES = new Set(['Person', 'Machine', 'Service', 'Endpoint', 'DataStore', 'ExternalService', 'Pipeline']);
const STATED = new Set(['Machine', 'Service', 'Endpoint', 'DataStore', 'Pipeline']);
const SCAN_LIMIT = 500;

function readText(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return null; }
}

// 「20261104-164408 <sha> <说明>」，最新的在前
export function parseDeployLog(text) {
  const out = [];
  for (const line of String(text || '').split('\n')) {
    const m = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2}) ([0-9a-f]{7,40})(?: (.*))?$/.exec(line.trim());
    if (m) out.push({ at: new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}+08:00`).toISOString(), commit: m[7], subject: (m[8] || '').trim().slice(0, 120) });
  }
  return out.reverse();
}

// 目录是否存在、最近一次改动（目录本身和第一层条目里最新的 mtime）
export function scanDir(dir) {
  try {
    const st = fs.statSync(dir);
    if (!st.isDirectory()) return { exists: false };
    let newest = st.mtimeMs;
    let entries = 0;
    for (const name of fs.readdirSync(dir).slice(0, SCAN_LIMIT)) {
      entries++;
      try { newest = Math.max(newest, fs.lstatSync(path.join(dir, name)).mtimeMs); } catch { /* 条目刚被删 */ }
    }
    return { exists: true, newest: new Date(newest).toISOString(), entries };
  } catch (err) {
    return err.code === 'EACCES' || err.code === 'EPERM' ? { exists: null } : { exists: false };
  }
}

const ago = (iso, now) => {
  const s = (now - Date.parse(iso)) / 1000;
  if (!(s >= 0)) return '';
  if (s < 90) return '刚刚';
  if (s < 3600) return `${Math.round(s / 60)} 分钟前`;
  if (s < 86400 * 2) return `${Math.round(s / 3600)} 小时前`;
  return `${Math.round(s / 86400)} 天前`;
};

const clock = (iso) => {
  const d = new Date(Date.parse(iso) + 8 * 3600 * 1000);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(5, 16).replace('T', ' ');
};

function serviceStatus(e, unit, health, ctx) {
  const facts = [];
  let state = 'unknown';
  let sub = '';
  if (unit) {
    if (unit.load === 'not-found') return { state: 'down', sub: '单元没装', facts: [['systemd', `${e.unit} 不存在`]] };
    facts.push(['systemd', `${unit.active}${unit.sub ? ` / ${unit.sub}` : ''}`]);
    state = unit.active === 'active' ? 'ok' : ['activating', 'reloading', 'deactivating'].includes(unit.active) ? 'warn' : 'down';
    if (e.unit.endsWith('.timer')) {
      if (unit.lastTrigger) facts.push(['上次触发', `${clock(unit.lastTrigger)}（${ago(unit.lastTrigger, ctx.now)}）`]);
      if (unit.nextTrigger) facts.push(['下次触发', clock(unit.nextTrigger)]);
      sub = unit.nextTrigger ? `下次 ${clock(unit.nextTrigger)}` : unit.active;
    } else {
      if (unit.since && state === 'ok') facts.push(['已运行', fmtDuration((ctx.now - Date.parse(unit.since)) / 1000)]);
      if (unit.memory) facts.push(['内存', unit.memoryMax ? `${fmtBytes(unit.memory)} / 上限 ${fmtBytes(unit.memoryMax)}` : fmtBytes(unit.memory)]);
      if (unit.restarts) facts.push(['自动重启', `${unit.restarts} 次`]);
      sub = state === 'ok' ? [unit.since && `运行 ${fmtDuration((ctx.now - Date.parse(unit.since)) / 1000).split(' ').slice(0, 2).join(' ')}`, unit.memory && fmtBytes(unit.memory)].filter(Boolean).join(' · ') : unit.active;
    }
  } else if (!ctx.sample) {
    facts.push(['systemd', '读不到']);
  }
  if (e.health === 'self') {
    facts.push(['健康检查', '就是我自己']);
    if (state === 'unknown') { state = 'ok'; sub = `运行 ${fmtDuration(process.uptime()).split(' ').slice(0, 2).join(' ')}`; }
  } else if (health) {
    facts.push(['健康检查', health.ok ? `${health.status} · ${health.ms}ms` : `失败（${health.error || health.status}）`]);
    if (!health.ok) { state = 'down'; sub = unit?.active === 'active' ? '进程在，健康检查失败' : '健康检查失败'; }
    else if (state === 'unknown') { state = 'ok'; sub = `健康 · ${health.ms}ms`; }
    const b = health.body || {};
    if (e.id === 'market-watch') {
      if (b.mode) facts.push(['模式', b.mode === 'live' ? `真实模型 ${b.model || ''}`.trim() : b.mode]);
      if (typeof b.runs === 'number') facts.push(['已复盘', `${b.runs} 个交易日`]);
      if (b.asOf) facts.push(['最新数据', b.asOf]);
      if (b.lastCheck) facts.push(['上次盯盘', `${clock(b.lastCheck)}（${ago(b.lastCheck, ctx.now)}）`]);
      if (b.running) facts.push(['现在', '正在跑当天的辩论']);
      if (b.lastError) facts.push(['最近错误', String(b.lastError).slice(0, 120)]);
      if (b.lastCheck && state === 'ok') sub = `上次盯盘 ${ago(b.lastCheck, ctx.now)}`;
    }
  }
  if (state === 'unknown' && ctx.sample) sub = '预览环境读不到 systemd';
  return { state, sub, facts };
}

function endpointStatus(e, ctx, ontology) {
  if (e.port) {
    const hits = ctx.ports.filter((p) => p.port === e.port);
    if (!hits.length) return { state: 'down', sub: '没有进程监听', facts: [['端口', String(e.port)], ['监听', '无']] };
    const scopes = [...new Set(hits.map((p) => (p.scope === 'public' ? '公网' : p.scope === 'loopback' ? '本机' : '其他')))];
    const leak = e.scope === 'loopback' && hits.some((p) => p.scope === 'public');
    return { state: leak ? 'warn' : 'ok', sub: `监听中 · ${scopes.join('/')}`, facts: [['端口', String(e.port)], ['监听地址', hits.map((p) => p.address).join('、')], ['应当', e.scope === 'public' ? '对公网开放' : '只听本机']] };
  }
  if (e.path) {
    const target = (ontology.out.get(e.id) || []).find((x) => x.relation === 'proxies_to');
    const t = target && ctx.nodes.get(target.target);
    const label = t ? t.label : '（无）';
    return { state: t ? t.state : 'unknown', sub: `→ ${label}`, facts: [['路径', e.path], ['转发到', label]], derived: true };
  }
  return { state: 'unknown', sub: '', facts: [] };
}

function dataStatus(e, ctx) {
  const d = ctx.scan(e.path);
  if (d.exists === null) return { state: 'unknown', sub: '沙箱里看不到', facts: [['路径', e.path]] };
  if (!d.exists) return ctx.sample ? { state: 'unknown', sub: '预览环境没有这个目录', facts: [['路径', e.path]] } : { state: 'down', sub: '目录不存在', facts: [['路径', e.path]] };
  return { state: 'ok', sub: `最近改动 ${ago(d.newest, ctx.now)}`, facts: [['路径', e.path], ['最近改动', `${clock(d.newest)}（${ago(d.newest, ctx.now)}）`], ['第一层条目', d.entries >= SCAN_LIMIT ? `${SCAN_LIMIT}+` : String(d.entries)]] };
}

function machineStatus(info, ctx) {
  const mem = info.memory;
  const used = mem.total - mem.available;
  const facts = [['系统', info.os], ['内核', info.kernel], ['已开机', fmtDuration(info.uptimeSeconds)], ['CPU', `${info.cpu.cores} 核`], ['负载', info.loadavg.join(' / ')], ['内存', `${fmtBytes(used)} / ${fmtBytes(mem.total)}`]];
  if (mem.swapTotal) facts.push(['交换', `${fmtBytes(mem.swapTotal - mem.swapFree)} / ${fmtBytes(mem.swapTotal)}`]);
  if (info.disk) facts.push(['磁盘', `${fmtBytes(info.disk.total - info.disk.available)} / ${fmtBytes(info.disk.total)}`]);
  const tight = mem.available / mem.total < 0.1 || (info.disk && info.disk.available / info.disk.total < 0.1) || info.loadavg[0] > info.cpu.cores * 1.5;
  return { state: tight ? 'warn' : 'ok', sub: `内存 ${Math.round((used / mem.total) * 100)}% · 负载 ${info.loadavg[0]}${ctx.sample ? ' · 预览' : ''}`, facts };
}

export async function buildSnapshot(ontology, opts = {}) {
  const deps = {
    systemdShow, probe, listeningPorts, systemInfo, scan: scanDir, readText, now: Date.now(), ...opts.deps,
  };
  const dataDir = opts.dataDir || '/srv/data/server-guide';
  const healthOverride = opts.health || {};
  // 传进来的是完整本体（端口对账要知道不公开的服务占了哪些端口），画图和输出只用公开的部分
  const hidden = [...ontology.entities.values()].filter((e) => e.hidden);
  const hiddenIds = new Set(hidden.map((e) => e.id));
  const marks = hidden.flatMap((e) => [e.id, e.unit, e.path, e.port && `:${e.port}`, e.label]).filter((m) => m && String(m).length >= 4).map(String);
  const leaks = (text) => /chat|私密|聊天/i.test(text || '') || marks.some((m) => String(text || '').includes(m));
  const ents = [...ontology.entities.values()].filter((e) => GRAPH_CLASSES.has(e.class) && !hiddenIds.has(e.id));
  const ids = new Set(ents.map((e) => e.id));
  const units = ents.filter((e) => e.unit).map((e) => e.unit);
  const targets = ents.filter((e) => e.health && e.health !== 'self').map((e) => ({ name: e.id, url: healthOverride[e.id] || e.health, json: true }));

  const [systemd, checks] = await Promise.all([deps.systemdShow(units), Promise.all(targets.map((t) => deps.probe(t)))]);
  const { sample, ports } = deps.listeningPorts({ includeHidden: true });
  const ctx = { now: deps.now, ports, sample: systemd === null, scan: deps.scan, nodes: new Map() };
  const healthBy = new Map(checks.map((c) => [c.name, c]));
  const unitBy = (u) => systemd && systemd[u.replace(/\.service$/, '')];

  const deploys = parseDeployLog(deps.readText(path.join(dataDir, 'deployed.log'))).map((d) => (leaks(d.subject) ? { ...d, subject: '（内部改动）' } : d));
  let report = null;
  try { report = JSON.parse(deps.readText(path.join(dataDir, 'drift.json')) || 'null'); } catch { report = null; }
  const runtime = portDrift(ontology, ports);
  const shown = (i) => !hiddenIds.has(i.subject) && !leaks(i.problem);
  const driftItems = [...(report?.items || []).filter(shown).map((i) => ({ ...i, when: '部署时' })), ...runtime.items.filter(shown).map((i) => ({ ...i, when: '现在' }))];
  const notes = runtime.notes.filter((n) => !leaks(n));

  const info = deps.systemInfo();
  const relOut = (id) => (ontology.out.get(id) || []);
  // 派生状态的节点（路由）要等它转发到的服务先算完
  const order = [...ents].sort((a, b) => Number(Boolean(a.path)) - Number(Boolean(b.path)));
  for (const e of order) {
    let s = { state: 'idle', sub: e.short && e.short !== e.label ? e.short : '', facts: [] };
    if (e.class === 'Service') s = serviceStatus(e, unitBy(e.unit || ''), healthBy.get(e.id), ctx);
    else if (e.class === 'Endpoint') s = endpointStatus(e, ctx, ontology);
    else if (e.class === 'DataStore') s = dataStatus(e, ctx);
    else if (e.class === 'Machine') s = machineStatus(info, ctx);
    else if (e.class === 'Pipeline') {
      const last = deploys[0];
      s = last
        ? { state: 'ok', sub: `上次 ${clock(last.at)} · ${last.commit.slice(0, 8)}`, facts: [['上次部署', `${clock(last.at)}（${ago(last.at, ctx.now)}）`], ['提交', last.commit.slice(0, 8)], ...(last.subject ? [['说明', last.subject]] : []), ['最近记录', `${deploys.length} 次`]] }
        : { state: 'idle', sub: '还没有部署记录', facts: [] };
    } else if (e.class === 'ExternalService') {
      s = { state: 'idle', sub: e.host || '', facts: [['域名', e.host || '—'], ['探测', '不主动探测，免得替访客发外部请求']] };
    }
    const drift = driftItems.filter((i) => i.subject === e.id);
    if (drift.length && s.state === 'ok') s.state = 'warn';
    const boundaries = relOut(e.id).filter((x) => x.relation === 'constrained_by').map((x) => x.target);
    const node = { id: e.id, class: e.class, label: e.label, short: e.short || null, summary: e.summary || '', state: s.state, sub: s.sub, facts: s.facts, boundaries, drift: drift.length };
    for (const k of ['unit', 'port', 'scope', 'path', 'host', 'url']) if (e[k] !== undefined) node[k] = e[k];
    ctx.nodes.set(e.id, node);
  }
  const nodes = ents.map((e) => ctx.nodes.get(e.id));

  const edges = ontology.edges.filter((x) => ids.has(x.source) && ids.has(x.target)).map((x) => ({ source: x.source, target: x.target, relation: x.relation }));
  const boundaries = {};
  for (const id of new Set(nodes.flatMap((n) => n.boundaries))) {
    const b = ontology.entities.get(id);
    if (!b) continue;
    boundaries[id] = { label: b.label, summary: b.summary || '', strength: b.strength || null, enforcedBy: relOut(id).filter((x) => x.relation === 'enforced_by').map((x) => ontology.label(x.target)) };
  }
  const summary = { ok: 0, warn: 0, down: 0, unknown: 0 };
  for (const n of nodes) if (STATED.has(n.class) && summary[n.state] !== undefined) summary[n.state]++;

  return {
    generatedAt: new Date(ctx.now).toISOString(),
    sample: ctx.sample || sample,
    summary,
    nodes,
    edges,
    relations: Object.fromEntries(Object.entries(ontology.relations).map(([k, v]) => [k, v.label || k])),
    classes: Object.fromEntries([...GRAPH_CLASSES].map((c) => [c, ontology.classes[c]?.label || c])),
    boundaries,
    drift: {
      checkedAt: report?.checkedAt || null, commit: report?.commit || null, live: Boolean(report?.live),
      checked: report ? { services: ents.filter((e) => e.class === 'Service' && e.unit).length, routes: ents.filter((e) => e.class === 'Endpoint' && e.path).length } : null,
      items: driftItems, notes,
    },
    deploys: deploys.slice(0, 10),
  };
}

export function createLive(ontology, { ttl = 10_000, ...opts } = {}) {
  let cached = null;
  let at = 0;
  let pending = null;
  return function snapshot() {
    if (cached && Date.now() - at < ttl) return Promise.resolve(cached);
    if (!pending) {
      pending = buildSnapshot(ontology, opts)
        .then((s) => { cached = s; at = Date.now(); return s; })
        .finally(() => { pending = null; });
    }
    return pending;
  };
}
