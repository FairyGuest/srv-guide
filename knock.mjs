// 敲门声：把 Nginx 访问日志和 SSH 登录日志数成按天的统计——哪类扫描、多少次、单日来自多少个地址。
// 采集由 server-knock.timer 每小时跑一次：deploy 用户 + CAP_DAC_READ_SEARCH（只读），断网，只能写 KNOCK_DIR。
// 落盘的只有计数：IP 只在内存里去重数个数；路径、用户名、客户端只留规则认得出来的那部分。
//   node knock.mjs --collect     读日志，合并进 KNOCK_DIR/knock.json
// server.mjs 的 GET /api/guide/knock 用 createKnock() 读汇总，访客的请求不会触发采集。
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const TZ_MS = 8 * 3600 * 1000;
const KEEP_DAYS = 120;
const MAX_READ = 64 * 1024 * 1024;

// 不公开的服务一律不计、不展示；自己的接口返回 4xx 是正常业务，也不算敲门
const PRIVATE = /^\/(api\/)?chat(\/|$)/i;
const OWN_API = /^\/api\/(guide|market|demo)\//;
const NEVER_SHOW = /chat|3002|私密|聊天/i;
// 样本里也不出现任何地址：想借道去的 IP、路径里夹带的 IP 都丢掉
const LOOKS_LIKE_IP = /\d+\.\d+\.\d+\.\d+|[0-9a-f]{0,4}:[0-9a-f]{0,4}:/i;
const showable = (s) => Boolean(s) && !NEVER_SHOW.test(s) && !LOOKS_LIKE_IP.test(s);

export const HTTP_KINDS = [
  { id: 'proxy', name: '找免费代理的', blurb: '把这里当成代理服务器：CONNECT、带完整地址的请求、SOCKS 握手。样本是它们想借道去的地方。' },
  { id: 'garbage', name: '说错协议的', blurb: '对着 HTTP 端口讲 TLS、RDP，或者连上来一句话不说。' },
  { id: 'ai', name: '找 AI 接口的', blurb: '找没上锁的 MCP 服务、OpenAI 兼容接口和本地大模型。' },
  { id: 'secrets', name: '翻抽屉的', blurb: '找忘了删的 .env、.git、云服务密钥和备份文件。' },
  { id: 'wordpress', name: 'WordPress 猎人', blurb: '默认这是个 WordPress 站：装机页、登录页、xmlrpc。' },
  { id: 'traversal', name: '路径穿越', blurb: '用 ../ 和各种编码过的点号，想从 cgi-bin 一路走到 /bin/sh。' },
  { id: 'devices', name: '找路由器和摄像头的', blurb: '路由器、光猫、摄像头、VPN 网关和 SAP、GeoServer 这类中间件的已知漏洞。' },
  { id: 'php', name: 'PHP 老漏洞', blurb: 'phpunit 的 eval-stdin、ThinkPHP、phpMyAdmin，十年前的漏洞还在被批量试。' },
  { id: 'ops', name: '摸运维后台的', blurb: 'Docker API、Spring Actuator、Jenkins、Nacos、server-status 这类不该对外的管理口。' },
  { id: 'crawler', name: '例行公事的爬虫', blurb: 'robots.txt、sitemap、security.txt：不算攻击，只是来登记一下。' },
  { id: 'other', name: '没认出来的', blurb: '其他返回 4xx 的请求：不属于上面任何一类，这个站上也没有这个页面。' },
];

export const SSH_KINDS = [
  { id: 'key', name: '试钥匙的', blurb: '报上一个真实存在的账号（几乎都是 root）来试。这台机器只认公钥，没带对钥匙就被关在门外。' },
  { id: 'invalid', name: '编用户名的', blurb: '猜这台机器上有 ubuntu、admin、oracle 这样的账号，其实没有。' },
  { id: 'hangup', name: '敲了就跑的', blurb: '连上 22 端口，一句完整的话没说就断开：大多是端口扫描器在确认门开着。' },
  { id: 'protocol', name: '说错协议的', blurb: '对着 SSH 端口发 HTTP 请求、乱码，或者还在说 SSH-1。' },
  { id: 'oldkey', name: '带着老古董的', blurb: '只会 ssh-rsa、ssh-dss 这类早就停用的算法，谈不拢。' },
];

const HTTP_RULES = [
  ['ai', /^\/(api\/)?(mcp|sse|messages)\/?$|\/v1\/(models|completions|chat\/completions|responses|embeddings)$|^\/(ollama|openai)(\/|$)|^\/api\/(tags|generate|ps|version)$/i],
  ['secrets', /\/\.(env|git|aws|ssh|svn|hg|docker|npmrc|htpasswd|vscode|DS_Store|bash_history|kube)|\/(credentials|secrets?|id_rsa|id_ed25519)(\.\w+)?$|\.(sql|bak|old|swp|zip|tar|tgz|gz|7z|rar)$|\/(config|settings|appsettings|parameters)\.(json|ya?ml|ini|xml)$/i],
  ['wordpress', /\/(wp-[\w-]+|wordpress)(\/|\.php|$)|\/xmlrpc\.php/i],
  ['traversal', /\.\.\/|%2e|%%32%65|%c0%ae|\/etc\/passwd/i],
  ['devices', /^\/(HNAP1|boaform|GponForm|goform|setup\.cgi|sdk|evox|webui|cgi-bin|onvif|ISAPI|tmUnblock\.cgi|developmentserver|geoserver|manager\/html|remote\/login|global-protect|dana-na|owa|ecp|login\.cgi|device\.rsp|nmaplowercheck\d*|stssys\.htm|Portal0000\.htm|ztp|scripts|cgi)(\/|\.|$)/i],
  ['php', /\.php\d?(\/|$)|phpmyadmin|phpunit|\/pma(\/|$)|thinkphp|\/vendor\//i],
  ['ops', /^\/(containers\/json|version|info|actuator|server-status|server-info|metrics|v2\/_catalog|api\/v1\/(pods|namespaces|nodes)|solr|jenkins|console|_cat|druid|nacos|jmx-console|debug|swagger[\w.-]*|api-docs|v3\/api-docs|graphql|telescope|_profiler|login\.action|struts|hudson)(\/|$)/i],
  ['crawler', /^\/(robots\.txt|sitemap(_index)?\.xml|favicon\.ico|\.well-known\/security\.txt|security\.txt|ads\.txt|humans\.txt|apple-touch-icon[\w-]*\.png)$/i],
];

// 客户端只按名字表归类，原始 User-Agent 不落盘
const AGENTS = [
  ['zgrab', /zgrab/i], ['masscan', /masscan/i], ['Nmap', /nmap/i], ['Nuclei', /nuclei/i], ['Censys', /censys/i],
  ['Shodan', /shodan/i], ['Palo Alto Expanse', /expanse|paloalto/i], ['LeakIX', /l9(explore|tcpid|scan)|leakix/i],
  ['Infrawatch', /infrawatch/i], ['Modat', /modat/i], ['InternetMeasurement', /internet-?measurement/i], ['libredtail', /libredtail/i],
  ['curl', /^curl\//i], ['Wget', /wget/i], ['Python', /python|aiohttp|httpx|urllib/i], ['Go', /^Go-http-client/i],
  ['Java', /^Java\/|okhttp|Apache-HttpClient/i], ['Node.js', /node-fetch|axios|undici/i],
  ['自称浏览器', /^Mozilla\/5\.0/], ['不报名字', /^-?$/],
];

const MON = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
function nginxTime(s) {
  const m = /^(\d{2})\/(\w{3})\/(\d{4}):(\d{2}):(\d{2}):(\d{2}) ([+-])(\d{2})(\d{2})$/.exec(s);
  if (!m || !(m[2] in MON)) return NaN;
  const off = (m[7] === '-' ? -1 : 1) * (Number(m[8]) * 60 + Number(m[9])) * 60000;
  return Date.UTC(Number(m[3]), MON[m[2]], Number(m[1]), Number(m[4]), Number(m[5]), Number(m[6])) - off;
}

export const dayOf = (ms) => new Date(ms + TZ_MS).toISOString().slice(0, 10);
const hourOf = (ms) => new Date(ms + TZ_MS).getUTCHours();

const LINE = /^(\S+) \S+ \S+ \[([^\]]+)\] "([^"]*)" (\d{3}) \S+ "[^"]*" "([^"]*)"/;

// 一行访问日志 → { at, ip, kind, sample, agent }；不是敲门（正常访问、自己的接口、不公开的服务）返回 null
export function classifyHttp(line) {
  const m = LINE.exec(line);
  if (!m) return null;
  const [, ip, time, raw, statusText, ua] = m;
  const at = nginxTime(time);
  const status = Number(statusText);
  if (!Number.isFinite(at) || status < 400) return null;
  const agent = (AGENTS.find(([, re]) => re.test(ua)) || ['其他'])[0];
  const hit = (kind, sample) => ({ at, ip, kind, sample, agent });
  if (/^\\x0[45]\\x01/.test(raw)) return hit('proxy', 'SOCKS 握手');
  if (raw === '' || /\\x[0-9a-f]{2}/i.test(raw)) {
    return hit('garbage', raw === '' ? '一言不发' : /^\\x16\\x03/.test(raw) ? 'TLS 握手' : /mstshash/i.test(raw) ? 'RDP 连接' : '乱码');
  }
  const [method, target = '', proto = ''] = raw.split(' ');
  if (!/^[A-Z]{3,10}$/.test(method)) return hit('garbage', '乱码');
  if (method === 'CONNECT' || /^https?:\/\//i.test(target) || /^[\w.-]+:\d+$/.test(target)) {
    const host = /^(?:https?:\/\/)?([\w.-]+)/i.exec(target)?.[1] || '';
    return hit('proxy', /^[a-z0-9.-]{3,60}$/i.test(host) ? host.toLowerCase() : null);
  }
  if (!target.startsWith('/') || !/^HTTP\/\d/.test(proto)) return hit('garbage', '乱码');
  const p = target.split('?')[0];
  if (PRIVATE.test(p) || OWN_API.test(p)) return null;
  const kind = (HTTP_RULES.find(([, re]) => re.test(p)) || ['other'])[0];
  return hit(kind, kind === 'other' ? null : samplePath(p));
}

function samplePath(p) {
  if (/eval-stdin\.php$/i.test(p)) return '…/phpunit/…/eval-stdin.php';
  if (/^\/cgi-bin\/(\.%2e|%%32%65)/i.test(p)) return '/cgi-bin/../../…/bin/sh';
  return /^[A-Za-z0-9/._~%+-]{1,64}$/.test(p) ? p : null;
}

const SSH_LINE = /^(\S+) \S+ sshd(?:-session)?\[\d+\]: (.*)$/;
const SSH_RULES = [
  ['accepted', /^Accepted \S+ for \S+ from (\S+) port \d+/, 1, 0],
  ['key', /^(?:Connection closed by|Disconnected from) authenticating user (\S+) (\S+) port \d+/, 2, 1],
  ['invalid', /^Invalid user (\S*) from (\S+) port \d+/, 2, 1],
  ['hangup', /^Connection (?:reset|closed) by (\S+) port \d+(?: \[preauth\])?\s*$/, 1, 0],
  ['protocol', /^banner exchange: Connection from (\S+) port \d+: (?:invalid format|could not read protocol version)/, 1, 0],
  ['oldkey', /^Unable to negotiate with (\S+) port \d+: no matching/, 1, 0],
];

// 一行 /var/log/secure → { at, ip, kind, user }；与敲门无关的返回 null
export function classifySsh(line) {
  const m = SSH_LINE.exec(line);
  if (!m) return null;
  const at = Date.parse(m[1]);
  if (!Number.isFinite(at)) return null;
  for (const [kind, re, ipAt, userAt] of SSH_RULES) {
    const r = re.exec(m[2]);
    if (r) return { at, ip: r[ipAt], kind, user: userAt ? r[userAt] : null };
  }
  return null;
}

function bucket() {
  return { total: 0, ips: new Set(), kinds: {}, extra: new Map(), hours: Array(24).fill(0) };
}
function bump(map, key) { if (key) map.set(key, (map.get(key) || 0) + 1); }
const top = (map, n) => [...map].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, n);

function add(b, ev, sample, extra) {
  b.total++;
  b.ips.add(ev.ip);
  b.hours[hourOf(ev.at)]++;
  const k = (b.kinds[ev.kind] ||= { n: 0, ips: new Set(), samples: new Map() });
  k.n++;
  k.ips.add(ev.ip);
  if (showable(sample)) bump(k.samples, sample);
  if (showable(extra)) bump(b.extra, extra);
}

function finish(b, extraName, extraTop) {
  return {
    total: b.total,
    sources: b.ips.size,
    hours: b.hours,
    kinds: Object.fromEntries(Object.entries(b.kinds).map(([id, k]) => [id, { n: k.n, sources: k.ips.size, samples: top(k.samples, 6) }])),
    [extraName]: top(b.extra, extraTop),
  };
}

// 用户名是对方随便填的：只留像账号名的那种，并去掉这台机器上真有的账号（root 人尽皆知，保留）
const USERNAME = /^[a-z_][a-z0-9_.-]{0,23}$/;

export function aggregate({ nginx = [], secure = [], localUsers = [] } = {}) {
  const hide = new Set(localUsers.filter((u) => u !== 'root'));
  const days = new Map();
  const day = (at) => {
    const d = dayOf(at);
    if (!days.has(d)) days.set(d, { http: bucket(), ssh: bucket() });
    return days.get(d);
  };
  for (const line of nginx) {
    const ev = classifyHttp(line);
    if (ev) add(day(ev.at).http, ev, ev.sample, ev.agent);
  }
  const ssh = secure.map(classifySsh).filter(Boolean);
  // 自己人不算：成功登录过的地址，同一批日志里的其他记录都跳过
  const friends = new Set(ssh.filter((e) => e.kind === 'accepted').map((e) => e.ip));
  for (const ev of ssh) {
    if (ev.kind === 'accepted' || friends.has(ev.ip)) continue;
    const user = ev.user && USERNAME.test(ev.user) && !hide.has(ev.user) ? ev.user : null;
    add(day(ev.at).ssh, ev, null, user);
  }
  const out = {};
  for (const [d, v] of [...days].sort()) out[d] = { http: finish(v.http, 'agents', 12), ssh: finish(v.ssh, 'users', 16) };
  return out;
}

// 日志会轮转掉，所以同一天以计数更多的那次为准；只留最近 KEEP_DAYS 天
export function mergeDays(stored = {}, fresh = {}) {
  const out = { ...stored };
  for (const [d, v] of Object.entries(fresh)) {
    const old = out[d] || {};
    out[d] = {
      http: !old.http || v.http.total >= old.http.total ? v.http : old.http,
      ssh: !old.ssh || v.ssh.total >= old.ssh.total ? v.ssh : old.ssh,
    };
  }
  return Object.fromEntries(Object.entries(out).sort().slice(-KEEP_DAYS));
}

function readLog(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    // 压缩过的旧日志只能从头解；没压缩的太大就只读末尾
    const len = file.endsWith('.gz') ? size : Math.min(size, MAX_READ);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    const text = (file.endsWith('.gz') ? zlib.gunzipSync(buf) : buf).toString('latin1');
    return text.split('\n');
  } finally {
    fs.closeSync(fd);
  }
}

function logFiles(dir, base) {
  try {
    return fs.readdirSync(dir).filter((f) => f === base || f.startsWith(`${base}-`) || f.startsWith(`${base}.`)).map((f) => path.join(dir, f));
  } catch {
    return [];
  }
}

export function collect({
  nginxDir = '/var/log/nginx',
  secureFile = '/var/log/secure',
  passwd = '/etc/passwd',
  dir = process.env.KNOCK_DIR || '/srv/data/knock',
  now = Date.now(),
} = {}) {
  const nginx = logFiles(nginxDir, 'access.log').flatMap(readLog);
  const secure = logFiles(path.dirname(secureFile), path.basename(secureFile)).flatMap(readLog);
  let localUsers = [];
  try { localUsers = fs.readFileSync(passwd, 'utf8').split('\n').map((l) => l.split(':')[0]).filter(Boolean); } catch {}
  const file = path.join(dir, 'knock.json');
  let stored = {};
  try { stored = JSON.parse(fs.readFileSync(file, 'utf8')).days || {}; } catch {}
  const days = mergeDays(stored, aggregate({ nginx, secure, localUsers }));
  const data = { version: 1, updatedAt: new Date(now).toISOString(), lines: { nginx: nginx.length, secure: secure.length }, days };
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(data) + '\n');
  fs.renameSync(`${file}.tmp`, file);
  return data;
}

function sumKinds(list, kinds) {
  return kinds.map((k) => {
    const samples = new Map();
    let n = 0;
    let peak = 0;
    let last = null;
    for (const { date, b } of list) {
      const x = b?.kinds?.[k.id];
      if (!x) continue;
      n += x.n;
      peak = Math.max(peak, x.sources);
      last = date;
      for (const [s, c] of x.samples) if (showable(s)) samples.set(s, (samples.get(s) || 0) + c);
    }
    return { ...k, n, peakSources: peak, lastSeen: last, samples: top(samples, 6) };
  });
}

function sumChannel(list, kinds, extraName, extraTop) {
  const hours = Array(24).fill(0);
  const extra = new Map();
  let total = 0;
  let peak = 0;
  for (const { b } of list) {
    if (!b) continue;
    total += b.total;
    peak = Math.max(peak, b.sources);
    b.hours.forEach((h, i) => { hours[i] += h; });
    for (const [s, c] of b[extraName] || []) if (showable(s)) extra.set(s, (extra.get(s) || 0) + c);
  }
  return { total, peakSources: peak, hours, kinds: sumKinds(list, kinds), [extraName]: top(extra, extraTop) };
}

// 给页面看的视图：最近 30 天每天的总数，最近 7 天的分类、样本、时段
export function publicView(data, now = Date.now()) {
  if (!data?.days) return { installed: false };
  const today = dayOf(now);
  const dates = [];
  for (let i = 29; i >= 0; i--) dates.push(dayOf(now - i * 86400000));
  const known = Object.keys(data.days).sort();
  const week = dates.slice(-7);
  const pick = (ch) => week.map((date) => ({ date, b: data.days[date]?.[ch] }));
  return {
    installed: true,
    updatedAt: data.updatedAt,
    since: known[0] || null,
    today,
    days: dates.map((date) => ({ date, http: data.days[date]?.http.total ?? null, ssh: data.days[date]?.ssh.total ?? null })),
    week: {
      from: week[0],
      to: week[6],
      http: sumChannel(pick('http'), HTTP_KINDS, 'agents', 10),
      ssh: sumChannel(pick('ssh'), SSH_KINDS, 'users', 16),
    },
  };
}

export function createKnock({ file = path.join(process.env.KNOCK_DIR || '/srv/data/knock', 'knock.json'), ttl = 60_000, now = () => Date.now() } = {}) {
  let cached = null;
  let at = 0;
  return () => {
    if (cached && now() - at < ttl) return cached;
    let data = null;
    try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
    cached = publicView(data, now());
    at = now();
    return cached;
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]) && process.argv.includes('--collect')) {
  const data = collect();
  const days = Object.keys(data.days);
  const last = data.days[days.at(-1)];
  console.log(`敲门声：读了 ${data.lines.nginx} 行访问日志、${data.lines.secure} 行 SSH 日志，共 ${days.length} 天；${days.at(-1) || '-'} HTTP ${last?.http.total ?? 0} 次、SSH ${last?.ssh.total ?? 0} 次`);
}
