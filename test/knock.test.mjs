import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { classifyHttp, classifySsh, aggregate, mergeDays, publicView, collect, createKnock, HTTP_KINDS } from '../knock.mjs';

const ng = (ip, req, status, ua = 'Mozilla/5.0 zgrab/0.x', time = '04/Nov/2026:10:15:00 +0800') =>
  `${ip} - - [${time}] "${req}" ${status} 153 "-" "${ua}"`;
const ss = (msg, time = '2026-11-04T18:18:44.493627+08:00') => `${time} VM-0-140-opencloudos sshd[1234]: ${msg}`;

const NGINX = [
  ng('203.0.113.7', 'GET /wordpress/wp-admin/setup-config.php HTTP/1.1', 404),
  ng('203.0.113.7', 'GET /wp-admin/install.php HTTP/1.1', 404),
  ng('198.51.100.2', 'GET /.git/config HTTP/1.1', 404, 'curl/8.4.0'),
  ng('198.51.100.3', 'GET /.env.production HTTP/1.1', 404, 'python-requests/2.31'),
  ng('198.51.100.4', 'POST /vendor/phpunit/phpunit/src/Util/PHP/eval-stdin.php HTTP/1.1', 404),
  ng('198.51.100.5', 'GET /cgi-bin/.%2e/.%2e/.%2e/bin/sh HTTP/1.1', 400),
  ng('198.51.100.6', 'GET /HNAP1 HTTP/1.1', 404),
  ng('198.51.100.7', 'POST /mcp HTTP/1.1', 404),
  ng('198.51.100.8', 'GET /containers/json HTTP/1.1', 404, 'Go-http-client/1.1'),
  ng('198.51.100.9', 'CONNECT dnspod.qcloud.com:443 HTTP/1.1', 400),
  ng('198.51.100.9', 'GET http://httpbin.org/get HTTP/1.1', 400),
  ng('198.51.100.9', 'CONNECT 192.0.2.44:443 HTTP/1.1', 400),
  ng('198.51.100.10', '\\x16\\x03\\x01\\x02\\x00\\x01\\x00', 400, '-'),
  ng('198.51.100.11', '\\x05\\x01\\x00', 400, '-'),
  ng('198.51.100.12', '', 400, '-'),
  ng('198.51.100.13', 'GET /robots.txt HTTP/1.1', 404, 'Mozilla/5.0 (compatible; CensysInspect/1.1)'),
  ng('198.51.100.14', 'GET /some/odd/page HTTP/1.1', 404),
  ng('198.51.100.15', 'GET /a/10.0.0.1/b.php HTTP/1.1', 404),
  // 下面这些都不算敲门
  ng('198.51.100.20', 'GET / HTTP/1.1', 200),
  ng('198.51.100.21', 'GET /api/guide/ask HTTP/1.1', 429),
  ng('198.51.100.22', 'GET /chat/ HTTP/1.1', 404),
  ng('198.51.100.22', 'POST /api/chat/upload HTTP/1.1', 413),
  'not a log line',
];

const SECURE = [
  ss('Connection closed by authenticating user root 203.0.113.50 port 41022 [preauth]'),
  ss('Connection closed by authenticating user root 203.0.113.51 port 41023 [preauth]'),
  ss('Invalid user oracle from 203.0.113.52 port 50000'),
  ss('Invalid user deploy from 203.0.113.53 port 50001'),
  ss('Invalid user lighthouse from 203.0.113.53 port 50002'),
  ss('Invalid user $(reboot) from 203.0.113.53 port 50003'),
  ss('Connection reset by 203.0.113.54 port 50004 [preauth]'),
  ss('banner exchange: Connection from 203.0.113.55 port 50005: invalid format'),
  ss('Unable to negotiate with 203.0.113.56 port 50006: no matching host key type found. Their offer: ssh-rsa,ssh-dss [preauth]'),
  // 主人自己：成功登录过，这个地址的其他记录都不算
  ss('Accepted publickey for root from 192.0.2.10 port 52000 ssh2: ED25519 SHA256:xxxx'),
  ss('Connection closed by authenticating user root 192.0.2.10 port 52001 [preauth]'),
  ss('Server listening on 0.0.0.0 port 22.'),
];

test('HTTP：常见扫描各归各类，样本只留认得出的部分', () => {
  const kinds = NGINX.map(classifyHttp).map((e) => e && [e.kind, e.sample]);
  assert.deepEqual(kinds.slice(0, 18), [
    ['wordpress', '/wordpress/wp-admin/setup-config.php'],
    ['wordpress', '/wp-admin/install.php'],
    ['secrets', '/.git/config'],
    ['secrets', '/.env.production'],
    ['php', '…/phpunit/…/eval-stdin.php'],
    ['traversal', '/cgi-bin/../../…/bin/sh'],
    ['devices', '/HNAP1'],
    ['ai', '/mcp'],
    ['ops', '/containers/json'],
    ['proxy', 'dnspod.qcloud.com'],
    ['proxy', 'httpbin.org'],
    ['proxy', '192.0.2.44'],
    ['garbage', 'TLS 握手'],
    ['proxy', 'SOCKS 握手'],
    ['garbage', '一言不发'],
    ['crawler', '/robots.txt'],
    ['other', null],
    ['php', '/a/10.0.0.1/b.php'],
  ]);
  assert.deepEqual(kinds.slice(18), [null, null, null, null, null]);
  assert.equal(classifyHttp(NGINX[2]).agent, 'curl');
  assert.equal(classifyHttp(NGINX[15]).agent, 'Censys');
});

test('SSH：试钥匙、编用户名、敲了就跑、说错协议、老算法', () => {
  const kinds = SECURE.map(classifySsh).map((e) => e && e.kind);
  assert.deepEqual(kinds, ['key', 'key', 'invalid', 'invalid', 'invalid', 'invalid', 'hangup', 'protocol', 'oldkey', 'accepted', 'key', null]);
  assert.equal(classifySsh(SECURE[2]).user, 'oracle');
});

test('汇总：不存 IP、不露本机账号、不露不公开的服务、自己人不算', () => {
  const days = aggregate({ nginx: NGINX, secure: SECURE, localUsers: ['root', 'nobody', 'lighthouse', 'deploy'] });
  assert.deepEqual(Object.keys(days), ['2026-11-04']);
  const d = days['2026-11-04'];
  assert.equal(d.http.total, 18);
  assert.equal(d.http.sources, 15);
  assert.equal(d.http.hours[10], 18);
  assert.equal(d.http.kinds.wordpress.n, 2);
  assert.equal(d.http.kinds.wordpress.sources, 1);
  assert.equal(d.http.kinds.proxy.n, 4);
  assert.deepEqual(d.http.kinds.proxy.samples.map(([s]) => s).sort(), ['SOCKS 握手', 'dnspod.qcloud.com', 'httpbin.org']);
  assert.equal(d.http.kinds.php.samples.length, 1);
  assert.equal(d.ssh.total, 9);
  assert.equal(d.ssh.hours[18], 9);
  assert.equal(d.ssh.kinds.key.n, 2);
  assert.deepEqual(d.ssh.users, [['root', 2], ['oracle', 1]]);
  const text = JSON.stringify(days);
  assert.ok(!/\d+\.\d+\.\d+\.\d+/.test(text), text.match(/.{30}\d+\.\d+\.\d+\.\d+.{30}/)?.[0]);
  assert.ok(!/chat|deploy|lighthouse|reboot/i.test(text));
});

test('合并：同一天以计数更多的那次为准，只留 120 天', () => {
  const a = { http: { total: 10 }, ssh: { total: 5 } };
  const b = { http: { total: 7 }, ssh: { total: 9 } };
  assert.deepEqual(mergeDays({ '2026-11-04': a }, { '2026-11-04': b })['2026-11-04'], { http: a.http, ssh: b.ssh });
  const many = {};
  for (let i = 0; i < 130; i++) many[`2026-${String(1 + Math.floor(i / 28)).padStart(2, '0')}-${String(1 + (i % 28)).padStart(2, '0')}`] = a;
  const kept = mergeDays(many, {});
  assert.equal(Object.keys(kept).length, 120);
  assert.equal(Object.keys(kept)[0], '2026-01-11');
});

test('页面视图：30 天柱子、最近 7 天的分类，没装好时说没装好', () => {
  assert.deepEqual(publicView(null), { installed: false });
  const days = aggregate({ nginx: NGINX, secure: SECURE });
  const view = publicView({ updatedAt: '2026-11-04T12:00:00Z', days }, Date.parse('2026-11-05T02:00:00Z'));
  assert.equal(view.days.length, 30);
  assert.deepEqual(view.days.at(-2), { date: '2026-11-04', http: 18, ssh: 9 });
  assert.deepEqual(view.days.at(-1), { date: '2026-11-05', http: null, ssh: null });
  assert.equal(view.week.to, '2026-11-05');
  assert.equal(view.week.http.kinds.length, HTTP_KINDS.length);
  const wp = view.week.http.kinds.find((k) => k.id === 'wordpress');
  assert.equal(wp.n, 2);
  assert.equal(wp.lastSeen, '2026-11-04');
  assert.ok(wp.name && wp.blurb);
  assert.equal(view.week.ssh.total, 9);
});

test('collect：读轮转过的日志（含 .gz），写 knock.json；createKnock 只读文件', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'knock-'));
  const logs = path.join(tmp, 'nginx');
  fs.mkdirSync(logs);
  fs.writeFileSync(path.join(logs, 'access.log'), NGINX.slice(0, 10).join('\n') + '\n');
  fs.writeFileSync(path.join(logs, 'access.log-20261104.gz'), zlib.gzipSync(NGINX.slice(10).join('\n') + '\n'));
  fs.writeFileSync(path.join(logs, 'error.log'), 'nope\n');
  fs.writeFileSync(path.join(tmp, 'secure'), SECURE.join('\n') + '\n');
  fs.writeFileSync(path.join(tmp, 'passwd'), 'root:x:0:0::/root:/bin/bash\ndeploy:x:1001:1001::/home/deploy:/bin/bash\n');
  const dir = path.join(tmp, 'data');
  const data = collect({ nginxDir: logs, secureFile: path.join(tmp, 'secure'), passwd: path.join(tmp, 'passwd'), dir, now: Date.parse('2026-11-04T12:00:00Z') });
  assert.equal(data.days['2026-11-04'].http.total, 18);
  const stored = JSON.parse(fs.readFileSync(path.join(dir, 'knock.json'), 'utf8'));
  assert.equal(stored.days['2026-11-04'].ssh.total, 9);
  assert.ok(!fs.existsSync(path.join(dir, 'knock.json.tmp')));
  let t = Date.parse('2026-11-04T12:00:00Z');
  const knock = createKnock({ file: path.join(dir, 'knock.json'), now: () => t });
  assert.equal(knock().week.http.total, 18);
  assert.equal(createKnock({ file: path.join(tmp, 'missing.json') })().installed, false);
  fs.rmSync(tmp, { recursive: true, force: true });
});
