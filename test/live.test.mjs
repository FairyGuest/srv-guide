import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectDrift, portDrift, repoSources, infraView, loadWorld, parseNginx, parseReleaseServices } from '../drift.mjs';
import { parseSystemdShow, listeningPorts } from '../system.mjs';
import { Ontology } from '../ontology.mjs';
import { buildSnapshot, createLive, parseDeployLog } from '../live.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
process.env.GUIDE_HIDDEN_FILE ||= path.join(here, '..', 'private', 'hidden.example.json');
// 漂移对账要读整站仓库的 deploy/、systemd/、nginx/；单独拿出 server-guide 时这两条跳过
const repo = process.env.GUIDE_REPO || path.join(here, '..', '..', '..');
const noRepo = !fs.existsSync(path.join(repo, 'deploy', 'release.sh')) && '需要整站仓库（设 GUIDE_REPO）';
const world = loadWorld();

test('仓库里的配置和本体没有漂移', { skip: noRepo }, () => {
  assert.deepEqual(detectDrift(world, repoSources(repo)), []);
  const view = infraView(world);
  assert.ok(view.services.some((s) => s.id === 'market-watch' && s.ports.includes(3004) && s.writes.includes('/srv/data/market-watch')));
  assert.ok(view.routes.some((r) => r.path === '/api/market/' && r.service === 'market-watch'));
});

test('配置被改了就报漂移', { skip: noRepo }, () => {
  const src = repoSources(repo);
  const release = src.release.replace('market-watch:market-watch:market-watch:3004', 'market-watch:market-watch:market-watch:3005 extra:extra:extra-svc:3009');
  const units = { ...src.units, 'market-watch.service': src.units['market-watch.service'].replace('ReadWritePaths=/srv/data/market-watch', 'ReadWritePaths=/srv/data/market-watch /srv/www/personal') };
  const nginx = src.nginx.replace('proxy_pass http://127.0.0.1:3004', 'proxy_pass http://127.0.0.1:3010');
  const items = detectDrift(world, { release, units, nginx });
  const has = (subject, word) => items.some((i) => i.subject === subject && i.problem.includes(word));
  assert.ok(has('market-watch', '3005'));
  assert.ok(has('push-deploy', 'extra-svc'));
  assert.ok(has('market-watch', '/srv/www/personal'));
  assert.ok(has('route-api-market', ':3010'));
  // 线上缺单元文件
  assert.ok(detectDrift(world, { where: '线上', units: { 'market-watch.service': null } }).some((i) => i.problem.includes('缺少单元文件')));
});

test('parseNginx 能读带嵌套块的 location', () => {
  const locs = parseNginx('location /api/market/ {\n  limit_except GET { deny all; }\n  proxy_pass http://127.0.0.1:3004/;\n}\nlocation = /api/chat/upload { proxy_pass http://127.0.0.1:3002; }');
  assert.deepEqual(locs, [{ path: '/api/market/', exact: false, port: 3004 }, { path: '/api/chat/upload', exact: true, port: 3002 }]);
  assert.equal(parseReleaseServices('services=(a:b:c:1 d:e:f:2)\n').length, 2);
});

test('端口漂移：没人听、本机端口外泄、未登记端口；临时端口只记一笔', () => {
  const ports = [
    { address: '0.0.0.0', port: 22, scope: 'public' }, { address: '0.0.0.0', port: 80, scope: 'public' }, { address: '0.0.0.0', port: 443, scope: 'public' },
    { address: '127.0.0.1', port: 3000, scope: 'loopback' }, { address: '0.0.0.0', port: 3002, scope: 'public' }, { address: '127.0.0.1', port: 3003, scope: 'loopback' },
    { address: '127.0.0.1', port: 34435, scope: 'loopback' }, { address: '0.0.0.0', port: 8080, scope: 'public' },
  ];
  const { items, notes } = portDrift(world, ports);
  assert.ok(items.some((i) => i.subject === 'ep-3004' && i.problem.includes('没有进程')));
  assert.ok(items.some((i) => i.subject === 'ep-3002' && i.problem.includes('公网')));
  assert.ok(items.some((i) => i.problem.includes('8080')));
  assert.ok(!items.some((i) => i.problem.includes('34435')));
  assert.equal(notes.length, 1);
});

test('parseSystemdShow：按 Id 分块，时间按东八区', () => {
  const text = 'Id=market-watch.service\nLoadState=loaded\nActiveState=active\nSubState=running\nMemoryCurrent=41943040\nMemoryMax=268435456\nNRestarts=0\nActiveEnterTimestamp=Wed 2026-11-04 16:45:09 CST\n\nNextElapseUSecRealtime=Thu 2026-11-05 03:12:00 CST\nId=personal-certbot-renew.timer\nActiveState=active\nMemoryMax=infinity\n';
  const s = parseSystemdShow(text);
  assert.equal(s['market-watch'].memory, 41943040);
  assert.equal(s['market-watch'].since, '2026-11-04T08:45:09.000Z');
  assert.equal(s['personal-certbot-renew.timer'].memoryMax, null);
  assert.equal(s['personal-certbot-renew.timer'].nextTrigger, '2026-11-04T19:12:00.000Z');
});

const now = Date.parse('2026-11-04T09:00:00Z');
const fakeDeps = (over = {}) => ({
  now,
  systemdShow: async (units) => Object.fromEntries(units.map((u) => [u.replace(/\.service$/, ''), { load: 'loaded', active: 'active', sub: 'running', memory: 30 * 1024 * 1024, memoryMax: null, restarts: 0, since: '2026-11-04T08:00:00.000Z' }])),
  probe: async (t) => ({ name: t.name, ok: true, status: 200, ms: 3, body: t.name === 'market-watch' ? { mode: 'live', model: 'deepseek-flash', runs: 2, lastCheck: '2026-11-04T08:30:00.000Z' } : {} }),
  listeningPorts: () => ({ sample: false, ports: [22, 80, 443].map((port) => ({ address: '0.0.0.0', port, scope: 'public' })).concat([3000, 3002, 3003, 3004, 3005].map((port) => ({ address: '127.0.0.1', port, scope: 'loopback' }))) }),
  systemInfo: () => ({ os: 'OpenCloudOS 9', kernel: '6.6', uptimeSeconds: 86400, loadavg: [0.1, 0.1, 0.1], cpu: { cores: 2 }, memory: { total: 4e9, available: 3e9, swapTotal: 0, swapFree: 0 }, disk: { total: 5e10, available: 4e10 } }),
  scan: () => ({ exists: true, newest: '2026-11-04T08:59:00.000Z', entries: 3 }),
  readText: (f) => (f.endsWith('deployed.log') ? '20261104-154959 35ec1a4b3a7f6bbfeae8e89580e3f4410a3e36fd \n20261104-164408 37219f38dcd10278b8cf1a5a9d940241caccb4da 盯盘：加 lastCheck\n' : f.endsWith('drift.json') ? JSON.stringify({ checkedAt: '2026-11-04T08:44:00Z', commit: '37219f38', live: true, items: [] }) : null),
  ...over,
});

test('活本体快照：全部正常时没有红点，路由跟着服务走', async () => {
  const snap = await buildSnapshot(world, { deps: fakeDeps() });
  const node = (id) => snap.nodes.find((n) => n.id === id);
  assert.equal(snap.summary.down, 0);
  assert.equal(node('market-watch').state, 'ok');
  assert.ok(node('market-watch').facts.some(([k, v]) => k === '上次盯盘' && v.includes('30 分钟前')));
  assert.ok(node('market-watch').boundaries.includes('b-write-scope'));
  assert.equal(node('route-api-market').state, 'ok');
  assert.equal(node('push-deploy').sub, '上次 11-04 16:44 · 37219f38');
  assert.equal(snap.deploys[0].subject, '盯盘：加 lastCheck');
  assert.ok(snap.edges.some((e) => e.source === 'market-watch' && e.relation === 'writes' && e.target === 'ds-market'));
  assert.ok(snap.boundaries['b-write-scope'].enforcedBy.length);
  assert.ok(!snap.nodes.some((n) => n.class === 'Boundary' || n.class === 'Page'));
});

test('活本体快照：服务挂了变红，转发到它的路由也红，漂移让节点变黄', async () => {
  const deps = fakeDeps({
    probe: async (t) => (t.name === 'market-watch' ? { name: t.name, ok: false, status: 0, ms: 2500, error: 'timeout' } : { name: t.name, ok: true, status: 200, ms: 3 }),
    readText: (f) => (f.endsWith('drift.json') ? JSON.stringify({ items: [{ subject: 'personal-demo', problem: '单元里 PORT=3005', source: 'x' }] }) : null),
  });
  const snap = await buildSnapshot(world, { deps });
  const node = (id) => snap.nodes.find((n) => n.id === id);
  assert.equal(node('market-watch').state, 'down');
  assert.equal(node('route-api-market').state, 'down');
  assert.equal(node('personal-demo').state, 'warn');
  assert.equal(node('push-deploy').state, 'idle');
  assert.equal(snap.drift.items[0].when, '部署时');
});

test('createLive：缓存期内并发请求只采集一次', async () => {
  let calls = 0;
  const live = createLive(world, { deps: fakeDeps({ systemdShow: async () => { calls++; return {}; } }) });
  const [a, b] = await Promise.all([live(), live()]);
  assert.equal(a, b);
  await live();
  assert.equal(calls, 1);
  assert.deepEqual(parseDeployLog('garbage\n'), []);
});

test('不公开的服务：导游的本体和端口列表里没有，活本体快照里也一个字都不漏', async () => {
  const pub = Ontology.fromFile(path.join(here, '..', 'vfs', 'ontology', 'world.json'), {});
  assert.ok(!pub.entities.has('personal-chat') && !pub.entities.has('ep-3002'));
  assert.ok(world.entities.get('personal-chat').hidden);
  assert.ok(!listeningPorts().ports.some((p) => p.port === 3002));
  assert.ok(listeningPorts({ includeHidden: true }).ports.some((p) => p.port === 3002));
  const deps = fakeDeps({
    readText: (f) => (f.endsWith('deployed.log')
      ? '20261104-164408 37219f38dcd10278b8cf1a5a9d940241caccb4da 修 personal-chat 的上传\n'
      : f.endsWith('drift.json') ? JSON.stringify({ items: [{ subject: 'personal-chat', problem: '单元里 PORT=3005', source: 'x' }, { subject: 'nginx', problem: 'Nginx 把 /api/chat/upload 转发到 :3002', source: 'x' }] }) : null),
  });
  const snap = await buildSnapshot(world, { deps });
  const text = JSON.stringify(snap);
  assert.ok(!/chat|3002|私密/i.test(text), text.match(/.{40}(chat|3002|私密).{40}/i)?.[0]);
  assert.equal(snap.drift.items.length, 0);
  assert.equal(snap.deploys[0].subject, '（内部改动）');
});
