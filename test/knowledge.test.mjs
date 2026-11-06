import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Vfs, loadSkills } from '../vfs.mjs';
import { SiteIndex, extractPage, normalizeUrl, queryTerms } from '../site.mjs';
import { Ontology } from '../ontology.mjs';
import { TOOL_DEFS, TOOL_CONTRACTS, runTool } from '../tools.mjs';
import { runShell } from '../shell.mjs';
import { buildSystem, mockProvider, runTurn } from '../agent.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const vfs = new Vfs(path.join(here, '..', 'vfs'));
const skills = loadSkills(vfs);
// 测试直接用仓库里的网站目录（和线上 /srv/www/personal 内容一致）；单独拿出 server-guide 时，依赖网站内容的几条跳过
const siteDir = process.env.GUIDE_SITE || path.join(here, '..', '..', '..', 'site');
const noSite = !fs.existsSync(path.join(siteDir, 'index.html')) && '需要网站目录（设 GUIDE_SITE）';
const site = new SiteIndex(siteDir);
const ontology = Ontology.fromFile(path.join(here, '..', 'vfs', 'ontology', 'world.json'), {
  site,
  skills,
  tools: TOOL_DEFS.map(({ name, description }) => ({ name, description, contract: TOOL_CONTRACTS[name] })),
});
const ctx = () => ({ vfs, skills, site, ontology, session: { cwd: '/', turns: [], todos: [] } });

test('extractPage：去掉导航和脚本，按标题分段', () => {
  const html = `<html><head><title>证据优先 · 刘浩的知识花园</title></head><body>
    <nav>首页 博客</nav><main><h1>证据优先</h1><p>把结论&amp;来源放在一起。</p>
    <script>alert(1)</script><h2 id="why">为什么</h2><ul><li>可复核</li><li>可追溯</li></ul></main>
    <footer>版权</footer></body></html>`;
  const page = extractPage(html);
  assert.equal(page.title, '证据优先');
  assert.deepEqual(page.sections.map((s) => s.heading), ['证据优先', '为什么']);
  assert.equal(page.sections[0].text, '把结论&来源放在一起。');
  assert.equal(page.sections[1].id, 'why');
  assert.match(page.sections[1].text, /- 可复核\n- 可追溯/);
  const all = page.sections.map((s) => s.text).join(' ');
  assert.doesNotMatch(all, /alert|版权|首页/);
});

test('normalizeUrl 与 queryTerms', () => {
  assert.deepEqual(normalizeUrl('https://example.com/blog/notes/ontology/index.html#why'), { url: '/blog/notes/ontology/', hash: 'why' });
  assert.deepEqual(normalizeUrl('resume'), { url: '/resume/', hash: '' });
  const terms = queryTerms('什么是证据优先 Text-to-SQL');
  assert.ok(terms.includes('证据') && terms.includes('text-to-sql'));
  assert.ok(!terms.includes('什么'));
});

test('SiteIndex：只索引公开页面，检索和按节读取', { skip: noSite }, () => {
  const urls = site.pages().map((p) => p.url);
  assert.ok(urls.includes('/') && urls.includes('/blog/notes/evidence-first/') && urls.includes('/resume/'));
  assert.ok(!urls.some((u) => /^\/(chat|guide|apps|assets)\//.test(u)), '私密页、导游自身和静态资源不进索引');
  const hits = site.search('证据优先');
  assert.ok(hits.length);
  assert.equal(hits[0].url, '/blog/notes/evidence-first/');
  const page = site.read('/blog/notes/evidence-first/');
  assert.ok(page.text.length > 50 && page.toc.length);
  const sec = site.read('/blog/notes/evidence-first/', page.toc[0]);
  assert.ok(sec.section && sec.text.length <= page.text.length);
  assert.equal(site.read('/chat/'), null);
});

test('本体：所有边符合 domain/range，博客图谱与运行时实体都并入', { skip: noSite }, () => {
  const { entities, edges, issues } = ontology.stats();
  assert.equal(issues, 0, JSON.stringify(ontology.issues.slice(0, 3)));
  assert.ok(entities > 50 && edges > 100);
  for (const id of ['srv-guide', 'server-guide', 'nginx', 'evidence-first', 'page:/blog/', 'tool:SiteSearch', 'skill:explain']) assert.ok(ontology.entities.has(id), id);
  // 每条边都带来源
  assert.ok(ontology.edges.every((e) => e.provenance));
  assert.ok(ontology.isA('Tool', 'Artifact'));
});

test('本体：同名时优先知识节点，边界区分软硬约束，能找关系链', { skip: noSite }, () => {
  assert.equal(ontology.resolve('证据优先').id, 'evidence-first');
  assert.equal(ontology.resolve('/blog/notes/evidence-first/').id, 'page:/blog/notes/evidence-first/');
  assert.match(ontology.entities.get('b-no-fabrication').strength, /软约束/);
  assert.match(ontology.entities.get('b-read-only').strength, /硬约束/);
  const r = ontology.query({ op: 'path', from: 'visitor', to: 'nginx' });
  assert.ok(!r.isError, r.content);
  const self = ontology.query({ op: 'entity', id: 'srv-guide' });
  assert.match(self.content, /SiteSearch/);
  assert.match(self.content, /落地了 → evidence-first/);
  assert.ok(ontology.query({ op: 'entity', id: '完全不存在的东西xyz' }).isError);
});

test('工具：SiteSearch / ReadPage / Ontology 交回依据，出错时不交', { skip: noSite }, async () => {
  const c = ctx();
  const s = await runTool('SiteSearch', { query: '人在回路' }, c);
  assert.match(s.content, /\/blog\/notes\/human-in-the-loop\//);
  assert.equal(s.evidence[0].kind, 'search');
  assert.equal(s.evidence[0].scope, 'site');
  const p = await runTool('ReadPage', { url: '/blog/notes/ontology/' }, c);
  assert.match(p.content, /起步笔记/);
  assert.deepEqual(p.evidence.map((e) => e.kind), ['page']);
  const o = await runTool('Ontology', { op: 'entity', id: 'nginx' }, c);
  assert.deepEqual(o.evidence, [{ kind: 'entity', ref: 'nginx' }]);
  const bad = await runTool('ReadPage', { url: '/chat/' }, c);
  assert.ok(bad.isError && !bad.evidence);
  const r = await runTool('Read', { path: '/server/hardware.md' }, c);
  assert.deepEqual(r.evidence, [{ kind: 'file', ref: '/server/hardware.md' }]);
  for (const t of TOOL_DEFS) assert.ok(TOOL_CONTRACTS[t.name]?.effect, `${t.name} 缺少动作契约`);
});

test('shell：site 与 onto 命令', { skip: noSite }, async () => {
  const c = ctx();
  assert.match((await runShell('site', c)).output, /已索引 \d+ 个公开页面/);
  assert.match((await runShell('site search 知识图谱', c)).output, /knowledge-graph/);
  assert.match((await runShell('site read /resume/', c)).output, /标题/);
  assert.match((await runShell('onto', c)).output, /校验：所有边都符合/);
  assert.match((await runShell('onto class Boundary', c)).output, /b-read-only/);
  assert.match((await runShell('onto path visitor nginx', c)).output, /nginx/);
  assert.match((await runShell('neofetch', c)).output, new RegExp(`${TOOL_DEFS.length} tools · ${skills.size} skills`));
});

test('系统提示包含本体论设定与两种对话方式', () => {
  const sys = buildSystem({ skills, session: { cwd: '/' } });
  for (const k of ['世界模型', '提及 ≠ 阐释 ≠ 验证', 'SiteSearch', 'ReadPage', '依据行', '软']) assert.ok(sys.includes(k), k);
});

test('runTurn：tool_result 事件带上依据；mock 能跑 /explain', { skip: noSite }, async () => {
  const session = { cwd: '/', turns: [], todos: [] };
  const events = [];
  await runTurn({
    session,
    userContent: [{ type: 'text', text: '<command-name>/explain</command-name>\n<command-args>证据优先</command-args>' }],
    provider: mockProvider(),
    ctx: { vfs, skills, site, ontology },
    onEvent: (e) => events.push(e),
  });
  const results = events.filter((e) => e.type === 'tool_result');
  assert.deepEqual(results.map((e) => e.name), ['Ontology', 'SiteSearch']);
  assert.ok(results.every((e) => e.evidence?.length));
});

test('summarizeEvidence 去重归类，空轮次标记 empty', async () => {
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'guide-test-'));
  process.env.SITE_DIR = siteDir;
  const { summarizeEvidence } = await import('../server.mjs');
  const s = summarizeEvidence([
    { kind: 'page', ref: '/blog/', title: '博客' },
    { kind: 'page', ref: '/blog/', title: '博客' },
    { kind: 'search', ref: '证据', hits: 3, scope: 'site' },
    { kind: 'observe', ref: 'Ports' },
    { kind: 'entity', ref: 'nginx' },
  ]);
  assert.equal(s.reads.length, 1);
  assert.equal(s.searches[0].hits, 3);
  assert.deepEqual(s.observed, [{ ref: 'Ports' }]);
  assert.equal(s.entities.length, 1);
  assert.equal(s.empty, false);
  assert.equal(summarizeEvidence([]).empty, true);
});
