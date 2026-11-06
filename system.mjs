// 只读的系统指标：全部来自 os 模块、/proc 与本机健康检查接口，不拼接任何访客输入，不起 shell。
import os from 'node:os';
import fs from 'node:fs';
import { execFile } from 'node:child_process';

const IS_LINUX = process.platform === 'linux';

export const KNOWN_PORTS = {
  22: 'sshd',
  80: 'nginx',
  443: 'nginx',
  3000: 'personal-demo',
  3001: '(预留) compose 演示',
  3003: 'server-guide',
  3004: 'market-watch',
};

const DEFAULT_TARGETS = [
  { name: 'nginx', url: 'http://127.0.0.1/healthz' },
  { name: 'personal-demo', url: 'http://127.0.0.1:3000/health' },
  { name: 'market-watch', url: 'http://127.0.0.1:3004/health' },
];
const DEFAULT_UNITS = ['nginx', 'personal-demo', 'server-guide', 'market-watch', 'docker', 'personal-certbot-renew.timer', 'server-knock.timer'];
// 不公开的服务（本体里标了 hidden）的端口：默认不出现在端口列表里，只有活本体的漂移对账会要完整列表
export const HIDDEN_PORTS = new Set([3002]);

function readText(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return null; }
}

export function fmtBytes(n) {
  const units = ['B', 'K', 'M', 'G', 'T'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n >= 10 || i === 0 ? Math.round(n) : n.toFixed(1)}${units[i]}`;
}

export function fmtDuration(sec) {
  sec = Math.floor(sec);
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return [d && `${d} 天`, h && `${h} 小时`, `${m} 分钟`].filter(Boolean).join(' ');
}

function osName() {
  const release = readText('/etc/os-release');
  const pretty = release && /^PRETTY_NAME="?([^"\n]+)"?/m.exec(release);
  return pretty ? pretty[1] : `${os.type()} ${os.release()}`;
}

function memory() {
  const info = readText('/proc/meminfo');
  if (info) {
    const kb = (key) => Number((new RegExp(`^${key}:\\s+(\\d+)`, 'm').exec(info) || [])[1] || 0) * 1024;
    return { total: kb('MemTotal'), available: kb('MemAvailable'), swapTotal: kb('SwapTotal'), swapFree: kb('SwapFree') };
  }
  return { total: os.totalmem(), available: os.freemem(), swapTotal: 0, swapFree: 0 };
}

function disk() {
  try {
    const s = fs.statfsSync(IS_LINUX ? '/' : process.cwd());
    return { total: s.blocks * s.bsize, available: s.bavail * s.bsize, free: s.bfree * s.bsize };
  } catch {
    return null;
  }
}

export function systemInfo() {
  const cpus = os.cpus();
  return {
    os: osName(),
    kernel: os.release(),
    arch: os.arch(),
    uptimeSeconds: Math.floor(os.uptime()),
    loadavg: os.loadavg().map((n) => Number(n.toFixed(2))),
    cpu: { cores: cpus.length, model: (cpus[0]?.model || 'unknown').trim() },
    memory: memory(),
    disk: disk(),
    node: process.version,
    guideRss: process.memoryUsage().rss,
  };
}

function hexToIpv4(hex) {
  return [6, 4, 2, 0].map((i) => parseInt(hex.slice(i, i + 2), 16)).join('.');
}

function hexToIpv6(hex) {
  // /proc 里的 IPv6 是 4 个 32 位小端字
  const bytes = [];
  for (let w = 0; w < 4; w++) {
    const word = hex.slice(w * 8, w * 8 + 8);
    for (let b = 3; b >= 0; b--) bytes.push(word.slice(b * 2, b * 2 + 2));
  }
  if (bytes.slice(0, 10).every((b) => b === '00') && bytes[10] === 'FF' && bytes[11] === 'FF') {
    return bytes.slice(12).map((b) => parseInt(b, 16)).join('.');
  }
  const groups = [];
  for (let i = 0; i < 16; i += 2) groups.push(parseInt(bytes[i] + bytes[i + 1], 16).toString(16));
  const joined = groups.join(':');
  if (joined === '0:0:0:0:0:0:0:0') return '::';
  if (joined === '0:0:0:0:0:0:0:1') return '::1';
  return joined.replace(/(^|:)0(:0)+(:|$)/, '::');
}

export function parseProcNetTcp(text, v6) {
  const out = [];
  for (const line of text.split('\n').slice(1)) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 4 || cols[3] !== '0A') continue;
    const [addrHex, portHex] = cols[1].split(':');
    out.push({ address: v6 ? hexToIpv6(addrHex) : hexToIpv4(addrHex), port: parseInt(portHex, 16), family: v6 ? 'tcp6' : 'tcp' });
  }
  return out;
}

const SAMPLE_PORTS = [
  { address: '0.0.0.0', port: 22, family: 'tcp' },
  { address: '0.0.0.0', port: 80, family: 'tcp' },
  { address: '0.0.0.0', port: 443, family: 'tcp' },
  { address: '127.0.0.1', port: 3000, family: 'tcp' },
  { address: '127.0.0.1', port: 3002, family: 'tcp' },
  { address: '127.0.0.1', port: 3003, family: 'tcp' },
  { address: '127.0.0.1', port: 3004, family: 'tcp' },
];

export function listeningPorts({ includeHidden = false } = {}) {
  const v4 = readText('/proc/net/tcp');
  const sample = v4 === null;
  const raw = sample ? SAMPLE_PORTS : [...parseProcNetTcp(v4, false), ...parseProcNetTcp(readText('/proc/net/tcp6') || '', true)];
  const seen = new Set();
  const ports = [];
  for (const p of raw.sort((a, b) => a.port - b.port)) {
    const key = `${p.address}:${p.port}`;
    if (seen.has(key) || (!includeHidden && HIDDEN_PORTS.has(p.port))) continue;
    seen.add(key);
    const isPublic = p.address === '0.0.0.0' || p.address === '::';
    const isLoopback = p.address.startsWith('127.') || p.address === '::1';
    ports.push({ ...p, scope: isPublic ? 'public' : isLoopback ? 'loopback' : 'other', service: KNOWN_PORTS[p.port] || '未登记' });
  }
  return { sample, ports };
}

function systemctlStates(units) {
  if (!IS_LINUX) return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile('systemctl', ['is-active', ...units], { timeout: 2500 }, (err, stdout) => {
      const lines = String(stdout || '').trim().split('\n');
      if (lines.length !== units.length) return resolve(null);
      resolve(Object.fromEntries(units.map((u, i) => [u, lines[i].trim()])));
    });
  });
}

export async function probe(target) {
  const started = Date.now();
  try {
    const res = await fetch(target.url, { signal: AbortSignal.timeout(2500), redirect: 'manual' });
    const out = { name: target.name, ok: res.status < 400, status: res.status, ms: Date.now() - started };
    // 需要时顺带读健康接口返回的 JSON（只取对象，读不出来就算了）
    if (target.json) {
      try { const body = await res.json(); if (body && typeof body === 'object') out.body = body; } catch { /* 不是 JSON */ }
    }
    return out;
  } catch (err) {
    return { name: target.name, ok: false, status: 0, ms: Date.now() - started, error: err.name === 'TimeoutError' ? 'timeout' : 'unreachable' };
  }
}

const SHOW_PROPS = ['Id', 'LoadState', 'ActiveState', 'SubState', 'MemoryCurrent', 'MemoryMax', 'ActiveEnterTimestamp', 'NRestarts', 'LastTriggerUSec', 'NextElapseUSecRealtime'];

// systemd 的时间戳形如 "Wed 2026-11-04 16:45:09 CST"；这台机器在东八区
export function parseSystemdTime(s) {
  const m = /(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})/.exec(s || '');
  return m ? new Date(`${m[1]}T${m[2]}+08:00`).toISOString() : null;
}

export function parseSystemdShow(text) {
  const out = {};
  for (const block of String(text).split(/\n\s*\n/)) {
    const p = {};
    for (const line of block.split('\n')) {
      const i = line.indexOf('=');
      if (i > 0) p[line.slice(0, i)] = line.slice(i + 1).trim();
    }
    if (!p.Id) continue;
    const num = (v) => (/^\d+$/.test(v || '') ? Number(v) : null);
    out[p.Id.replace(/\.service$/, '')] = {
      load: p.LoadState || null, active: p.ActiveState || null, sub: p.SubState || null,
      memory: num(p.MemoryCurrent), memoryMax: num(p.MemoryMax), restarts: num(p.NRestarts),
      since: parseSystemdTime(p.ActiveEnterTimestamp), lastTrigger: parseSystemdTime(p.LastTriggerUSec), nextTrigger: parseSystemdTime(p.NextElapseUSecRealtime),
    };
  }
  return out;
}

// 只读：systemctl show 不需要任何权限；拿不到（非 Linux）时返回 null
export function systemdShow(units) {
  if (!IS_LINUX || !units.length) return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile('systemctl', ['show', '-p', SHOW_PROPS.join(','), ...units], { timeout: 2500 }, (err, stdout) => {
      resolve(stdout ? parseSystemdShow(stdout) : null);
    });
  });
}

export async function serviceHealth({ targets, units } = {}) {
  const list = targets || (process.env.GUIDE_HEALTH_TARGETS ? JSON.parse(process.env.GUIDE_HEALTH_TARGETS) : DEFAULT_TARGETS);
  const [checks, systemd] = await Promise.all([Promise.all(list.map(probe)), systemctlStates(units || DEFAULT_UNITS)]);
  checks.push({ name: 'server-guide', ok: true, status: 200, ms: 0, note: '就是我自己' });
  return { checks, systemd };
}
