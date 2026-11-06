// srv-guide：服务器导游 agent 的 HTTP 后端。零第三方依赖，只监听本机，由 Nginx 代理 /api/guide/。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Vfs, loadSkills } from './vfs.mjs';
import { TOOL_DEFS, TOOL_CONTRACTS } from './tools.mjs';
import { SiteIndex } from './site.mjs';
import { Ontology } from './ontology.mjs';
import { runShell } from './shell.mjs';
import { createLive } from './live.mjs';
import { createKnock } from './knock.mjs';
import { anthropicProvider, mockProvider, runTurn, ProviderError } from './agent.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.PORT || 3003);
const HOST = process.env.HOST || '127.0.0.1';
const DATA_DIR = process.env.DATA_DIR || '/srv/data/server-guide';
const VFS_DIR = process.env.VFS_DIR || path.join(here, 'vfs');
// 已发布的网站目录：线上是 /srv/www/personal，本地开发时退回仓库里的 site/
const SITE_DIR = [process.env.SITE_DIR, '/srv/www/personal', path.join(here, '..', '..', 'site')].find((d) => d && fs.existsSync(d)) || path.join(here, '..', '..', 'site');
const LLM_API_KEY = process.env.LLM_API_KEY || '';
const LLM_BASE_URL = process.env.LLM_BASE_URL || 'https://api.deepseek.com/anthropic';
const LLM_MODEL = process.env.LLM_MODEL || 'deepseek-flash';
const LLM_MAX_TOKENS = Number(process.env.LLM_MAX_TOKENS || 1500);
// 线上只用真实模型：没有 Key 时进入 offline（提问会提示未接入模型）；规则式 mock 只在显式设置 GUIDE_PROVIDER=mock 时用于本地预览。
const PROVIDER = process.env.GUIDE_PROVIDER || (LLM_API_KEY ? 'live' : 'offline');

const LIMITS = {
  ipTurnsPerDay: Number(process.env.GUIDE_IP_TURNS || 30),
  dailyTokens: Number(process.env.GUIDE_DAILY_TOKENS || 2_000_000),
  maxSteps: Number(process.env.GUIDE_MAX_STEPS || 8),
  maxConcurrent: Number(process.env.GUIDE_MAX_CONCURRENT || 6),
  inputChars: 1000,
  sessionTurns: 40,
  sessionsPerIpHour: 30,
  maxSessions: 1000,
  sessionTtlMs: 2 * 60 * 60 * 1000,
  bodyBytes: 16 * 1024,
  attachChars: 6000,
};

const vfs = new Vfs(VFS_DIR);
const skills = loadSkills(vfs);
const site = new SiteIndex(SITE_DIR);
const toolInfo = TOOL_DEFS.map(({ name, description }) => ({ name, description, contract: TOOL_CONTRACTS[name] }));
const ontology = Ontology.fromFile(path.join(VFS_DIR, 'ontology', 'world.json'), { site, skills, tools: toolInfo });
const ctx = { vfs, skills, site, ontology };
// 活本体页的数据；GUIDE_LIVE_HEALTH 只给本地预览改健康检查地址用（JSON：{"实体 id": "url"}）
// 采集用完整本体（含不公开的服务，端口对账才不会误报），live.mjs 输出前再把它们剔掉
const liveWorld = Ontology.fromFile(path.join(VFS_DIR, 'ontology', 'world.json'), { includeHidden: true });
const liveSnapshot = createLive(liveWorld, { dataDir: DATA_DIR, health: process.env.GUIDE_LIVE_HEALTH ? JSON.parse(process.env.GUIDE_LIVE_HEALTH) : {} });
// 敲门声：只读 server-knock.timer 写好的汇总，访客请求不会触发采集
const knock = createKnock({ file: path.join(process.env.KNOCK_DIR || '/srv/data/knock', 'knock.json') });
const provider = PROVIDER === 'live' && LLM_API_KEY
  ? anthropicProvider({ baseUrl: LLM_BASE_URL, apiKey: LLM_API_KEY, model: LLM_MODEL, maxTokens: LLM_MAX_TOKENS })
  : PROVIDER === 'mock' ? mockProvider() : { kind: 'offline', model: '未接入模型' };

fs.mkdirSync(DATA_DIR, { recursive: true });
const USAGE_PATH = path.join(DATA_DIR, 'usage.json');
const LOG_PATH = path.join(DATA_DIR, 'turns.jsonl');
const SALT_PATH = path.join(DATA_DIR, 'salt');

const salt = (() => {
  try { return fs.readFileSync(SALT_PATH, 'utf8').trim(); } catch {
    const s = crypto.randomBytes(16).toString('hex');
    fs.writeFileSync(SALT_PATH, s, { mode: 0o600 });
    return s;
  }
})();

// ---------- 额度 ----------

const shanghaiDate = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });

const usage = (() => {
  try {
    const u = JSON.parse(fs.readFileSync(USAGE_PATH, 'utf8'));
    if (u.date === shanghaiDate()) return u;
  } catch { /* 首次启动或文件损坏 */ }
  return { date: shanghaiDate(), tokens: 0, turns: 0, ips: {} };
})();

function rollDay() {
  const today = shanghaiDate();
  if (usage.date !== today) Object.assign(usage, { date: today, tokens: 0, turns: 0, ips: {} });
}

let saveTimer = null;
function saveUsage() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const tmp = `${USAGE_PATH}.tmp`;
    fs.writeFile(tmp, JSON.stringify(usage), (err) => { if (!err) fs.rename(tmp, USAGE_PATH, () => {}); });
  }, 500);
}

function quotaFor(ipHash) {
  rollDay();
  const used = usage.ips[ipHash] || 0;
  return {
    ipTurnsLeft: Math.max(0, LIMITS.ipTurnsPerDay - used),
    ipTurnsLimit: LIMITS.ipTurnsPerDay,
    budgetLeftPct: Math.max(0, Math.round(100 - (usage.tokens / LIMITS.dailyTokens) * 100)),
  };
}

// ---------- 会话 ----------

const sessions = new Map();
const sessionBuckets = new Map();
let running = 0;

function newSession(ipHash) {
  if (sessions.size >= LIMITS.maxSessions) {
    const oldest = [...sessions.values()].filter((s) => !s.busy).sort((a, b) => a.last - b.last)[0];
    if (oldest) sessions.delete(oldest.id);
  }
  const s = { id: crypto.randomUUID(), ipHash, cwd: '/', turns: [], todos: [], busy: false, abort: null, created: Date.now(), last: Date.now(), turnCount: 0, tokens: 0 };
  sessions.set(s.id, s);
  return s;
}

setInterval(() => {
  const cutoff = Date.now() - LIMITS.sessionTtlMs;
  for (const s of sessions.values()) if (!s.busy && s.last < cutoff) sessions.delete(s.id);
  const hourAgo = Date.now() - 3600_000;
  for (const [ip, list] of sessionBuckets) {
    const kept = list.filter((t) => t > hourAgo);
    if (kept.length) sessionBuckets.set(ip, kept); else sessionBuckets.delete(ip);
  }
}, 10 * 60 * 1000).unref();

// ---------- HTTP 工具 ----------

function clientIp(req) {
  const remote = req.socket.remoteAddress || '';
  const loopback = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
  const real = req.headers['x-real-ip'];
  return loopback && typeof real === 'string' && real ? real.trim() : remote || 'unknown';
}

const hashIp = (ip) => crypto.createHash('sha256').update(salt + ip).digest('hex').slice(0, 16);

function json(res, status, body) {
  if (res.writableEnded) return;
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > LIMITS.bodyBytes) { reject(Object.assign(new Error('请求过大'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch { reject(Object.assign(new Error('JSON 无效'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

function getSession(body, ipHash) {
  const s = sessions.get(String(body.session || ''));
  if (!s || s.ipHash !== ipHash) return null;
  s.last = Date.now();
  return s;
}

function meta(ipHash, session) {
  return {
    model: provider.model,
    mode: provider.kind,
    cwd: session?.cwd || '/',
    skills: [...skills.values()].map(({ name, description, argumentHint }) => ({ name, description, argumentHint })),
    tools: toolInfo,
    files: vfs.allFiles(),
    limits: { maxSteps: LIMITS.maxSteps, inputChars: LIMITS.inputChars, sessionTurns: LIMITS.sessionTurns },
    quota: quotaFor(ipHash),
    session: session ? { turns: session.turnCount, tokens: session.tokens } : null,
  };
}

function logTurn(entry) {
  fs.appendFile(LOG_PATH, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n', () => {});
}

// 把本轮所有工具交回的依据去重、归类，作为 evidence 事件发给前端，也写进日志。
// 这一行由程序生成，不经过模型：模型说“我读过”不算数，工具真的读过才算。
export function summarizeEvidence(items) {
  const groups = { reads: [], searches: [], observed: [], entities: [] };
  const seen = new Set();
  for (const ev of items) {
    if (!ev?.ref) continue;
    const key = `${ev.kind}:${ev.ref}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (ev.kind === 'file' || ev.kind === 'page') groups.reads.push({ kind: ev.kind, ref: ev.ref, title: ev.title });
    else if (ev.kind === 'search') groups.searches.push({ ref: ev.ref, hits: ev.hits ?? 0, scope: ev.scope });
    else if (ev.kind === 'observe') groups.observed.push({ ref: ev.ref });
    else if (ev.kind === 'entity' || ev.kind === 'model') groups.entities.push({ kind: ev.kind, ref: ev.ref });
  }
  return { ...groups, empty: !seen.size };
}

// 把访客输入组装成 user 消息：/skill 展开为 skill 说明，@路径 附上文件内容。
export function buildUserContent(input, session, emit, evidence = []) {
  const blocks = [];
  let text = input;
  const slash = /^\/([\w-]+)(?:\s+([\s\S]*))?$/.exec(input);
  if (slash) {
    const skill = skills.get(slash[1]);
    if (!skill) return { error: `未知命令：/${slash[1]}，输入 /help 查看可用命令` };
    const args = (slash[2] || '').trim();
    emit('skill', { name: skill.name, args });
    text = `<command-name>/${skill.name}</command-name>\n<command-args>${args}</command-args>\n\n用户通过斜杠命令运行了 skill「${skill.name}」${args ? `，参数：${args}` : ''}。以下是该 skill 的说明，请照做：\n\n${skill.body}`;
  }
  blocks.push({ type: 'text', text });
  const mentions = [...input.matchAll(/(?:^|\s)@([\w./~-]+)/g)].map((m) => m[1]).slice(0, 3);
  for (const m of mentions) {
    const p = vfs.resolve(m, session.cwd);
    if (!vfs.isFile(p)) continue;
    const content = vfs.read(p).slice(0, LIMITS.attachChars);
    emit('attach', { path: p, lines: content.split('\n').length });
    evidence.push({ kind: 'file', ref: p });
    blocks.push({ type: 'text', text: `<file path="${p}">\n${content}\n</file>` });
  }
  return { blocks };
}

function friendlyError(err) {
  if (err.name === 'AbortError' || err.name === 'TimeoutError' || err.message === 'aborted') return '已中断';
  if (err instanceof ProviderError) {
    if (err.status === 401 || err.status === 403) return '模型服务鉴权失败，主人可能需要更新 API Key。';
    if (err.status === 402 || /balance|insufficient/i.test(err.message)) return '模型账户余额不足，今天先到这里。';
    if (err.status === 429) return '模型服务限流了，稍等几秒再试。';
    return `模型服务出错（${err.status}）。`;
  }
  return '服务器内部错误。';
}

// ---------- 路由 ----------

async function handleChat(req, res, ipHash) {
  const body = await readBody(req);
  const session = getSession(body, ipHash);
  if (!session) return json(res, 404, { error: '会话不存在或已过期，请刷新页面' });
  const input = String(body.input || '').trim();
  if (!input) return json(res, 400, { error: '输入为空' });
  if (input.length > LIMITS.inputChars) return json(res, 400, { error: `输入太长了（上限 ${LIMITS.inputChars} 字）` });
  if (provider.kind === 'offline') return json(res, 503, { error: '导游还没接入模型（服务器未配置 LLM_API_KEY）。! 开头的 shell 命令仍然可用。' });
  if (session.busy) return json(res, 409, { error: '上一轮还在进行中，按 Esc 中断后再试' });
  if (session.turnCount >= LIMITS.sessionTurns) return json(res, 429, { error: '这个会话的轮次用完了，输入 /clear 开始新会话' });
  const quota = quotaFor(ipHash);
  if (quota.ipTurnsLeft <= 0) return json(res, 429, { error: `今天的 ${LIMITS.ipTurnsPerDay} 轮对话额度用完了，明天再来。! 开头的 shell 命令不受影响。` });
  if (quota.budgetLeftPct <= 0) return json(res, 429, { error: '全站今日的模型预算已用完，明天再来。! 开头的 shell 命令不受影响。' });
  if (running >= LIMITS.maxConcurrent) return json(res, 503, { error: '同时在线提问的人有点多，稍等几秒再试' });

  res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', 'x-accel-buffering': 'no', connection: 'keep-alive' });
  const emit = (event, data) => { if (!res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); };

  const evidence = [];
  const built = buildUserContent(input, session, emit, evidence);
  if (built.error) { emit('error', { message: built.error }); res.end(); return; }

  // 先占用额度，防止并发绕过
  usage.ips[ipHash] = (usage.ips[ipHash] || 0) + 1;
  usage.turns++;
  session.turnCount++;
  session.busy = true;
  running++;
  const controller = new AbortController();
  session.abort = controller;
  res.on('close', () => controller.abort());
  const keepalive = setInterval(() => { if (!res.writableEnded) res.write(': ping\n\n'); }, 15000);

  const turnUsage = { input: 0, output: 0 };
  const toolsUsed = [];
  let status = 'ok';
  try {
    await runTurn({
      session,
      userContent: built.blocks,
      provider,
      ctx,
      signal: controller.signal,
      maxSteps: LIMITS.maxSteps,
      usage: turnUsage,
      onEvent: (ev) => {
        if (ev.type === 'tool_start') toolsUsed.push(ev.name);
        if (ev.type === 'tool_result' && ev.evidence) evidence.push(...ev.evidence);
        const { type, evidence: _ev, ...data } = ev;
        emit(type, data);
      },
    });
  } catch (err) {
    status = controller.signal.aborted ? 'aborted' : 'error';
    if (status === 'error') console.error('[turn]', err);
    emit(status === 'aborted' ? 'interrupted' : 'error', { message: friendlyError(err) });
  } finally {
    clearInterval(keepalive);
    running--;
    session.busy = false;
    session.abort = null;
    const tokens = turnUsage.input + turnUsage.output;
    session.tokens += tokens;
    usage.tokens += tokens;
    saveUsage();
    const basis = summarizeEvidence(evidence);
    logTurn({ ip: ipHash, session: session.id.slice(0, 8), input: input.slice(0, 300), tools: toolsUsed, evidence: evidence.map((e) => `${e.kind}:${e.ref}`).slice(0, 30), usage: turnUsage, status });
    if (status === 'ok') emit('evidence', basis);
    emit('done', { usage: turnUsage, quota: quotaFor(ipHash), session: { turns: session.turnCount, tokens: session.tokens } });
    res.end();
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const ipHash = hashIp(clientIp(req));
  try {
    if (req.method === 'GET' && url.pathname === '/health') {
      return json(res, 200, { status: 'ok', service: 'server-guide', mode: provider.kind, model: provider.model, pages: site.pages().length, sessions: sessions.size, running, uptimeSeconds: Math.floor(process.uptime()) });
    }
    if (req.method === 'GET' && url.pathname === '/meta') {
      const s = sessions.get(url.searchParams.get('session') || '');
      return json(res, 200, meta(ipHash, s && s.ipHash === ipHash ? s : null));
    }
    if (req.method === 'GET' && url.pathname === '/live') {
      return json(res, 200, await liveSnapshot());
    }
    if (req.method === 'GET' && url.pathname === '/knock') return json(res, 200, knock());
    if (req.method !== 'POST') return json(res, 404, { error: 'not found' });

    if (url.pathname === '/session') {
      const list = sessionBuckets.get(ipHash) || [];
      const hourAgo = Date.now() - 3600_000;
      const recent = list.filter((t) => t > hourAgo);
      if (recent.length >= LIMITS.sessionsPerIpHour) return json(res, 429, { error: '新建会话太频繁了，稍后再试' });
      recent.push(Date.now());
      sessionBuckets.set(ipHash, recent);
      const s = newSession(ipHash);
      return json(res, 200, { id: s.id, ...meta(ipHash, s) });
    }
    if (url.pathname === '/chat') return await handleChat(req, res, ipHash);

    const body = await readBody(req);
    const session = getSession(body, ipHash);
    if (!session) return json(res, 404, { error: '会话不存在或已过期，请刷新页面' });

    if (url.pathname === '/shell') {
      const result = await runShell(String(body.cmd || '').slice(0, 300), { ...ctx, session });
      return json(res, 200, { ...result, cwd: session.cwd });
    }
    if (url.pathname === '/clear') {
      session.abort?.abort();
      session.turns = [];
      session.todos = [];
      session.turnCount = 0;
      return json(res, 200, { ok: true });
    }
    if (url.pathname === '/interrupt') {
      session.abort?.abort();
      return json(res, 200, { ok: true });
    }
    return json(res, 404, { error: 'not found' });
  } catch (err) {
    if (!err.status) console.error('[http]', err);
    if (res.headersSent) { res.end(); return; }
    return json(res, err.status || 500, { error: err.status ? err.message : '服务器内部错误' });
  }
});

server.requestTimeout = 0;
server.headersTimeout = 15000;

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  server.listen(PORT, HOST, () => console.log(`server-guide listening on http://${HOST}:${PORT} (provider: ${provider.kind}, model: ${provider.model})`));
}

export { server, sessions, usage, site, ontology };
