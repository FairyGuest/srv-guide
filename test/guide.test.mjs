import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Vfs, loadSkills, parseSkill } from '../vfs.mjs';
import { runShell, splitArgs } from '../shell.mjs';
import { parseProcNetTcp } from '../system.mjs';
import { runTool } from '../tools.mjs';
import { anthropicProvider, buildMessages, mockProvider, repairTurn, runTurn } from '../agent.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const vfs = new Vfs(path.join(here, '..', 'vfs'));
const skills = loadSkills(vfs);
const newSession = () => ({ cwd: '/', turns: [], todos: [] });

test('vfs 路径解析不会逃出根目录', () => {
  assert.equal(vfs.resolve('../../etc/passwd', '/server'), '/etc/passwd');
  assert.equal(vfs.isFile('/etc/passwd'), false);
  assert.equal(vfs.resolve('~/server/../site', '/lab'), '/site');
  assert.equal(vfs.resolve('hardware.md', '/server'), '/server/hardware.md');
  assert.ok(vfs.isFile('/server/hardware.md'));
  assert.ok(vfs.list('/').includes('server/'));
});

test('skill 都能解析出名字和描述', () => {
  assert.deepEqual([...skills.keys()].sort(), ['boundary', 'deploy-plan', 'explain', 'health-check', 'ontology', 'tour']);
  for (const s of skills.values()) assert.ok(s.description && s.body, s.name);
  assert.ok(skills.get('deploy-plan').argumentHint);
  const { meta, body } = parseSkill('---\nname: x\ndescription: y\n---\n正文');
  assert.equal(meta.name, 'x');
  assert.equal(body.trim(), '正文');
});

test('shell：参数拆分、cd/cat、拒绝管道与越权', async () => {
  assert.deepEqual(splitArgs(`grep "nginx 配置" /server`), ['grep', 'nginx 配置', '/server']);
  const session = newSession();
  await runShell('cd server', { vfs, session });
  assert.equal(session.cwd, '/server');
  assert.match((await runShell('cat hardware.md', { vfs, session })).output, /\S/);
  assert.match((await runShell('cat ../../etc/passwd', { vfs, session })).output, /没有那个文件|No such/);
  const piped = await runShell('cat hardware.md | sh', { vfs, session });
  assert.doesNotMatch(piped.output, /# /);
  assert.match((await runShell('sudo rm -rf /', { vfs, session })).output, /sudoers/);
  assert.match((await runShell('rm hardware.md', { vfs, session })).output, /只读|Read-only/);
  assert.equal((await runShell('clear', { vfs, session })).clear, true);
  assert.match((await runShell('nosuchcmd', { vfs, session })).output, /command not found/);
});

test('解析 /proc/net/tcp 的监听端口', () => {
  const text = [
    '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode',
    '   0: 00000000:0016 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 1 1',
    '   1: 0100007F:0BBB 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 2 1',
    '   2: 0100007F:0BB8 0100007F:D431 01 00000000:00000000 00:00000000 00000000  1000        0 3 1',
  ].join('\n');
  const ports = parseProcNetTcp(text, false);
  assert.deepEqual(ports.map((p) => [p.address, p.port]), [['0.0.0.0', 22], ['127.0.0.1', 3003]]);
});

test('工具：Read 带行号、TodoWrite 写入会话、未知工具报错', async () => {
  const session = newSession();
  const ctx = { vfs, skills, session };
  const r = await runTool('Read', { path: '/server/hardware.md', limit: 2 }, ctx);
  assert.match(r.content, /^\s*1\t/);
  const t = await runTool('TodoWrite', { todos: [{ content: 'a', status: 'in_progress' }] }, ctx);
  assert.ok(!t.isError);
  assert.equal(session.todos.length, 1);
  assert.ok((await runTool('Bash', { cmd: 'id' }, ctx)).isError);
  assert.ok((await runTool('Read', { path: '/nope' }, ctx)).isError);
});

test('repairTurn 去掉悬空的 tool_use 并保持交替', () => {
  const t1 = [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }, { role: 'assistant', content: [{ type: 'tool_use', id: 'a', name: 'LS', input: {} }] }];
  repairTurn(t1);
  assert.deepEqual(t1[1].content, [{ type: 'text', text: '（本轮被中断）' }]);
  const t2 = [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }];
  repairTurn(t2);
  assert.equal(t2.at(-1).role, 'assistant');
});

test('buildMessages 压缩旧工具结果并去掉旧 thinking', () => {
  const big = 'x'.repeat(2000);
  const turn = (i) => [
    { role: 'user', content: [{ type: 'text', text: `q${i}` }] },
    { role: 'assistant', content: [{ type: 'thinking', thinking: 'hmm', signature: 's' }, { type: 'tool_use', id: `t${i}`, name: 'LS', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: `t${i}`, content: big }] },
    { role: 'assistant', content: [{ type: 'text', text: `a${i}` }] },
  ];
  const session = { turns: Array.from({ length: 10 }, (_, i) => turn(i)) };
  const msgs = buildMessages(session);
  assert.equal(msgs.length, 6 * 4);
  assert.equal(msgs[0].content[0].text, 'q4');
  const results = msgs.filter((m) => m.content[0]?.type === 'tool_result').map((m) => m.content[0].content.length);
  assert.ok(results[0] < 500, '旧结果应被压缩');
  assert.equal(results.at(-1), 2000, '最近的结果保持完整');
  assert.ok(!msgs.slice(0, -4).some((m) => m.content.some((b) => b.type === 'thinking')));
  assert.ok(msgs.at(-3).content.some((b) => b.type === 'thinking'), '当前轮保留 thinking');
});

function sseResponse(events) {
  const text = events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
  const bytes = new TextEncoder().encode(text);
  // 故意切成小块，覆盖跨 chunk 的事件拼接
  const chunks = [];
  for (let i = 0; i < bytes.length; i += 7) chunks.push(bytes.slice(i, i + 7));
  return { ok: true, status: 200, body: (async function* () { yield* chunks; })() };
}

test('anthropicProvider 解析流式文本与工具调用', async () => {
  let sent;
  const provider = anthropicProvider({
    baseUrl: 'https://example.test/anthropic/',
    apiKey: 'k',
    model: 'm',
    fetchImpl: async (url, init) => {
      sent = { url, body: JSON.parse(init.body) };
      return sseResponse([
        { type: 'message_start', message: { usage: { input_tokens: 120, output_tokens: 1 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '我去看看' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'tu1', name: 'Read', input: {} } },
        { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"path":"/ser' } },
        { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: 'ver"}' } },
        { type: 'content_block_stop', index: 1 },
        { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 30 } },
        { type: 'message_stop' },
      ]);
    },
  });
  const events = [];
  const r = await provider.stream({ system: 's', tools: [], messages: [], onEvent: (e) => events.push(e) });
  assert.equal(sent.url, 'https://example.test/anthropic/v1/messages');
  assert.equal(sent.body.stream, true);
  assert.equal(r.stopReason, 'tool_use');
  assert.deepEqual(r.usage, { input: 120, output: 30 });
  assert.deepEqual(r.content, [{ type: 'text', text: '我去看看' }, { type: 'tool_use', id: 'tu1', name: 'Read', input: { path: '/server' } }]);
  assert.deepEqual(events.map((e) => e.type), ['text', 'tool_pending']);
});

test('anthropicProvider 把 HTTP 错误转成 ProviderError', async () => {
  const provider = anthropicProvider({ baseUrl: 'https://x', apiKey: 'k', model: 'm', fetchImpl: async () => ({ ok: false, status: 401, text: async () => 'bad key' }) });
  await assert.rejects(provider.stream({ messages: [], onEvent() {} }), (err) => err.status === 401);
});

test('runTurn + mock provider 跑完 health-check 流程', async () => {
  const session = newSession();
  const events = [];
  const usage = { input: 0, output: 0 };
  await runTurn({
    session,
    userContent: [{ type: 'text', text: '<command-name>/health-check</command-name>' }],
    provider: mockProvider(),
    ctx: { vfs, skills },
    onEvent: (e) => events.push(e),
    usage,
  });
  const tools = events.filter((e) => e.type === 'tool_result').map((e) => e.name);
  assert.deepEqual(tools, ['TodoWrite', 'SystemInfo', 'TodoWrite', 'Ports', 'TodoWrite', 'ServiceHealth', 'TodoWrite']);
  assert.ok(usage.input > 0 && usage.output > 0);
  const turn = session.turns[0];
  assert.equal(turn.at(-1).role, 'assistant');
  assert.equal(turn.at(-1).content[0].type, 'text');
});

test('runTurn 中断后会话仍然合法', async () => {
  const session = newSession();
  const controller = new AbortController();
  const run = runTurn({
    session,
    userContent: [{ type: 'text', text: '<command-name>/tour</command-name>' }],
    provider: mockProvider(),
    ctx: { vfs, skills },
    onEvent: () => {},
    signal: controller.signal,
  });
  setTimeout(() => controller.abort(), 500);
  await assert.rejects(run);
  const turn = session.turns[0];
  turn.forEach((m, i) => assert.equal(m.role, i % 2 ? 'assistant' : 'user'));
  assert.equal(turn.at(-1).role, 'assistant');
  assert.ok(!turn.at(-1).content.some((b) => b.type === 'tool_use'));
});
