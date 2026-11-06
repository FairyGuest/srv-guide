// srv-guide 网页终端：仿 Claude Code 的交互。纯原生 JS，所有 DOM 都由脚本生成，兼容本站 CSP。
(() => {
  'use strict';

  const API = '/api/guide';
  const $ = (id) => document.getElementById(id);
  const els = {
    screen: $('screen'), log: $('log'), spinner: $('spinner'), glyph: $('spinner-glyph'), verb: $('spinner-verb'),
    meta: $('spinner-meta'), input: $('input'), inputbox: $('inputbox'), prompt: $('prompt'), palette: $('palette'),
    hint: $('hint'), status: $('status'), chips: $('chips'), title: $('title'),
  };

  const state = {
    session: null,
    meta: null,
    cwd: '/',
    running: false,
    ctrl: null,
    history: loadHistory(),
    histIdx: -1,
    draft: '',
    pal: { items: [], index: 0, kind: null },
    expandAll: false,
  };

  // ---------- 小工具 ----------

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function nearBottom() {
    const s = els.screen;
    return s.scrollHeight - s.scrollTop - s.clientHeight < 120;
  }

  function scrollDown(force) {
    if (force || nearBottom()) requestAnimationFrame(() => { els.screen.scrollTop = els.screen.scrollHeight; });
  }

  function loadHistory() {
    try { return JSON.parse(localStorage.getItem('srv-guide-history') || '[]'); } catch { return []; }
  }

  function pushHistory(v) {
    if (state.history[state.history.length - 1] !== v) state.history.push(v);
    state.history = state.history.slice(-50);
    try { localStorage.setItem('srv-guide-history', JSON.stringify(state.history)); } catch { /* 隐私模式 */ }
    state.histIdx = -1;
  }

  async function api(pathname, body) {
    const res = await fetch(API + pathname, {
      method: body ? 'POST' : 'GET',
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.error || `HTTP ${res.status}`), { status: res.status });
    return data;
  }

  // ---------- Markdown（先转义再排版，不信任任何模型输出） ----------

  function inline(s) {
    return s.split(/(`[^`\n]+`)/g).map((part) => {
      if (part.length > 2 && part.startsWith('`') && part.endsWith('`')) return `<code>${esc(part.slice(1, -1))}</code>`;
      return esc(part)
        .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
        .replace(/\[([^\]]+)\]\(((?:https?:\/\/|\/)[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
        .replace(/(^|[\s（(])(https?:\/\/[^\s<)）]+)/g, '$1<a href="$2" target="_blank" rel="noopener noreferrer">$2</a>')
        // 回答里引用的站内页面（/blog/…、/projects/ 等）直接可点
        .replace(/(^|[\s（(：:，、])(\/(?:blog|projects|resume|lab)\/[\w./#%-]*)/g, '$1<a href="$2" target="_blank" rel="noopener">$2</a>');
    }).join('');
  }

  const isListLine = (l) => /^\s*([-*+]|\d+[.)])\s+/.test(l);
  const isTableRow = (l) => /^\s*\|.*\|\s*$/.test(l);
  const isTableSep = (l) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(l);
  const cells = (l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());

  function md(src) {
    const lines = src.replace(/\r/g, '').split('\n');
    const out = [];
    let i = 0;
    while (i < lines.length) {
      const l = lines[i];
      if (/^\s*```/.test(l)) {
        const buf = [];
        i++;
        while (i < lines.length && !/^\s*```/.test(lines[i])) buf.push(lines[i++]);
        i++;
        out.push(`<pre class="code"><code>${esc(buf.join('\n'))}</code></pre>`);
        continue;
      }
      if (isTableRow(l) && i + 1 < lines.length && isTableSep(lines[i + 1])) {
        const head = cells(l);
        i += 2;
        const rows = [];
        while (i < lines.length && isTableRow(lines[i])) rows.push(cells(lines[i++]));
        out.push(`<table><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`);
        continue;
      }
      const h = /^(#{1,6})\s+(.*)$/.exec(l);
      if (h) { out.push(`<h${Math.min(4, h[1].length)}>${inline(h[2])}</h${Math.min(4, h[1].length)}>`); i++; continue; }
      if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(l)) { out.push('<hr>'); i++; continue; }
      if (isListLine(l)) {
        const ordered = /^\s*\d/.test(l);
        const items = [];
        while (i < lines.length && (isListLine(lines[i]) || (/^\s{2,}\S/.test(lines[i]) && items.length))) {
          const m = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(lines[i]);
          if (m) items.push({ depth: Math.floor(m[1].length / 2), text: m[3] });
          else items[items.length - 1].text += ' ' + lines[i].trim();
          i++;
        }
        const tag = ordered ? 'ol' : 'ul';
        out.push(`<${tag}>${items.map((it) => `<li${it.depth ? ` class="d${Math.min(3, it.depth)}"` : ''}>${inline(it.text)}</li>`).join('')}</${tag}>`);
        continue;
      }
      if (/^>\s?/.test(l)) {
        const buf = [];
        while (i < lines.length && /^>\s?/.test(lines[i])) buf.push(lines[i++].replace(/^>\s?/, ''));
        out.push(`<blockquote>${buf.map(inline).join('<br>')}</blockquote>`);
        continue;
      }
      if (!l.trim()) { i++; continue; }
      const buf = [];
      while (i < lines.length && lines[i].trim() && !/^\s*```/.test(lines[i]) && !/^#{1,6}\s/.test(lines[i]) && !isListLine(lines[i]) && !(isTableRow(lines[i]) && isTableSep(lines[i + 1] || '')) && !/^>\s?/.test(lines[i])) buf.push(lines[i++]);
      out.push(`<p>${buf.map(inline).join('<br>')}</p>`);
    }
    return out.join('');
  }

  // ---------- 记录区 ----------

  function addEntry(kind, mark) {
    const root = el('div', `entry ${kind}`);
    root.append(el('span', 'mark', mark));
    const body = el('div', 'body');
    root.append(body);
    els.log.append(root);
    scrollDown();
    return { root, body };
  }

  function addUser(text) {
    const e = addEntry('user', '>');
    e.body.textContent = text;
    scrollDown(true);
  }

  function addSystem(text, tone) {
    const e = addEntry(`system${tone ? ` ${tone}` : ''}`, '⎿');
    e.body.textContent = text;
    return e;
  }

  function addAssistant() {
    const e = addEntry('assistant', '●');
    e.body.className = 'body md';
    let raw = '';
    let queued = false;
    return {
      append(text) {
        raw += text;
        if (queued) return;
        queued = true;
        requestAnimationFrame(() => { queued = false; e.body.innerHTML = md(raw); scrollDown(); });
      },
      set(text) { raw = text; e.body.innerHTML = md(raw); scrollDown(); },
    };
  }

  function addThinking() {
    const e = addEntry('thinking', '✻');
    const toggle = el('span', 'toggle', '思考过程（点击展开）');
    const body = el('div', 'think-body');
    body.hidden = true;
    toggle.addEventListener('click', () => { body.hidden = !body.hidden; toggle.textContent = body.hidden ? '思考过程（点击展开）' : '思考过程'; });
    e.body.append(toggle, body);
    return { append(t) { body.textContent += t; } };
  }

  const TOOL_LABEL = { TodoWrite: '更新任务清单' };
  const TOOL_VERB = {
    SystemInfo: '数一数内存条', Ports: '清点端口', ServiceHealth: '挨个敲门问候服务', Read: '翻阅档案',
    LS: '巡视目录', Grep: '大海捞针', Skill: '翻开技能书', TodoWrite: '列清单',
    SiteSearch: '翻主人的博客', ReadPage: '逐字读原文', Ontology: '查世界模型',
  };

  function toolArgs(name, input) {
    if (!input) return '';
    if (name === 'Grep') return `"${input.pattern || ''}"${input.path ? `, ${input.path}` : ''}`;
    if (name === 'Skill') return input.name || '';
    if (name === 'SiteSearch') return `"${input.query || ''}"`;
    if (name === 'ReadPage') return `${input.url || ''}${input.section ? ` › ${input.section}` : ''}`;
    if (name === 'Ontology') {
      const op = input.op || '';
      if (op === 'path' || (input.from && input.to)) return `path: ${input.from} → ${input.to}`;
      const arg = input.id || input.query || '';
      return [op, input.class ? `class=${input.class}` : '', arg].filter(Boolean).join(' ');
    }
    if (input.path) return input.path;
    return '';
  }

  const tools = new Map();

  function toolEntry(id, name) {
    if (tools.has(id)) return tools.get(id);
    const e = addEntry('tool running', '●');
    const head = el('div', 'tool-head');
    const b = el('b', null, TOOL_LABEL[name] || name);
    const args = el('span', 'args', '');
    head.append(b, args);
    e.body.append(head);
    const t = { e, name, args, sub: null, out: null };
    tools.set(id, t);
    return t;
  }

  function toolStart({ id, name, input }) {
    const t = toolEntry(id, name);
    const a = toolArgs(name, input);
    t.args.textContent = a ? `(${a})` : name === 'TodoWrite' ? '' : '()';
    spinnerVerb(TOOL_VERB[name]);
  }

  function toolResult({ id, name, summary, output, isError, ms, todos }) {
    const t = toolEntry(id, name);
    t.e.root.classList.remove('running');
    t.e.root.classList.add(isError ? 'err' : 'ok');
    if (name === 'TodoWrite' && Array.isArray(todos)) {
      const ul = el('ul', 'todos');
      for (const todo of todos) {
        const li = el('li', todo.status);
        li.append(el('span', 'box', todo.status === 'completed' ? '☒' : todo.status === 'in_progress' ? '◼' : '☐'), el('span', null, todo.content));
        ul.append(li);
      }
      t.e.body.append(ul);
      scrollDown();
      return;
    }
    const sub = el('div', 'tool-sub');
    const text = el('span', null);
    text.append(el('span', 'sum', summary || '完成'), el('span', 'hint', ` · ${ms}ms${output ? ' · 点击展开' : ''}`));
    sub.append(el('span', 'elbow', '  ⎿'), text);
    t.e.body.append(sub);
    if (output) {
      const pre = el('pre', 'tool-out', output);
      pre.hidden = !state.expandAll;
      t.e.body.append(pre);
      sub.addEventListener('click', () => { pre.hidden = !pre.hidden; });
    }
    scrollDown();
  }

  function addShell(cmd) {
    const e = addEntry('shell', '!');
    e.body.append(el('span', 'cmd', cmd));
    return e;
  }

  // 本轮依据：由后端根据工具实际读过的东西生成，不是模型自述
  function addEvidence(ev) {
    const e = addEntry('system evidence', '⎿');
    e.body.append(el('span', 'label', '依据 '));
    if (ev.empty) {
      e.body.append(el('span', 'none', '本轮没有读取任何资料，以上回答只来自模型本身'));
      return;
    }
    const groups = [];
    const group = (name, items) => {
      if (!items.length) return;
      const g = el('span', 'group');
      g.append(el('span', 'kind', name));
      items.forEach((node, i) => { if (i) g.append(document.createTextNode('、')); g.append(node); });
      groups.push(g);
    };
    const MAX = 6;
    const more = (list) => (list.length > MAX ? [el('span', 'more', `等 ${list.length} 项`)] : []);
    group('读过 ', [...ev.reads.slice(0, MAX).map((r) => {
      if (r.kind !== 'page') return el('code', null, r.ref);
      const a = el('a', null, r.title ? `${r.title}` : r.ref);
      a.href = r.ref;
      a.target = '_blank';
      a.rel = 'noopener';
      a.title = r.ref;
      return a;
    }), ...more(ev.reads)]);
    group('检索 ', [...ev.searches.slice(0, MAX).map((s) => el('span', null, `“${s.ref}”${s.scope === 'site' ? '（网站' : '（资料'} ${s.hits} 条）`)), ...more(ev.searches)]);
    group('实测 ', ev.observed.map((o) => el('span', null, o.ref)));
    group('世界模型 ', [...ev.entities.slice(0, MAX).map((x) => el('span', null, x.kind === 'model' ? `op=${x.ref}` : x.ref)), ...more(ev.entities)]);
    groups.forEach((g, i) => { if (i) e.body.append(el('span', 'sep', ' · ')); e.body.append(g); });
  }

  function panel(build) {
    const e = addEntry('system accent', '⎿');
    const p = el('div', 'panel');
    build(p);
    e.body.append(p);
    scrollDown(true);
  }

  function kv(p, rows) {
    const dl = el('dl', 'kv');
    for (const [k, v] of rows) dl.append(el('dt', null, k), el('dd', null, v));
    p.append(dl);
  }

  // ---------- 欢迎页 ----------

  // 纯 ASCII 的 figlet "small" 字形：方块/制表符在中文字体回退时宽度不一，会把横幅挤乱
  const LETTERS = {
    S: [' ___ ', '/ __|', '\\__ \\', '|___/'],
    R: [' ___ ', '| _ \\', '|   /', '|_|_\\'],
    V: ['__   __', '\\ \\ / /', ' \\ V / ', '  \\_/  '],
    '-': ['     ', ' ___ ', '|___|', '     '],
    G: ['  ___ ', ' / __|', '| (_ |', ' \\___|'],
    U: [' _   _ ', '| | | |', '| |_| |', ' \\___/ '],
    I: [' ___ ', '|_ _|', ' | | ', '|___|'],
    D: [' ___  ', '|   \\ ', '| |) |', '|___/ '],
    E: [' ___ ', '| __|', '| _| ', '|___|'],
  };

  function banner(word) {
    return LETTERS.S.map((_, row) => row).map((row) => [...word].map((c) => LETTERS[c][row]).join('')).join('\n');
  }

  function renderWelcome(compact) {
    if (!compact) {
      const pre = el('pre', 'banner', banner('SRV-GUIDE'));
      pre.setAttribute('aria-label', 'srv-guide');
      els.log.append(pre);
    }
    const box = el('div', 'welcome');
    const hello = el('div', 'hello');
    hello.append(el('b', null, '✻ '), document.createTextNode('欢迎来到 '), el('b', null, 'srv-guide'), document.createTextNode('！我是住在这台服务器上的导游 agent：可以带你看服务器，也可以陪你聊这个网站上的项目和博客。'));
    box.append(hello, el('div', 'sub', '/help 查看命令 · /tour 带你逛一圈 · /explain 证据优先 讲讲博客里的概念'), el('div', 'cwd', `cwd: ${state.cwd}   model: ${state.meta ? state.meta.model : '…'}`));
    els.log.append(box);
    if (compact) return;
    const tips = el('div', 'tips');
    tips.append(document.createTextNode('上手提示：'));
    const ol = el('ol');
    for (const [code, text] of [
      ['这台服务器跑了哪些服务？', ' 直接用中文提问，我会调用工具现场查'],
      ['主人的博客怎么看本体论？', ' 我会先搜、再读原文，回答附页面链接'],
      ['/', ' 打开命令面板，skill 也在里面'],
      ['!onto srv-guide', ' 以 ! 开头进入只读沙盒 shell，看看我在世界模型里的样子'],
    ]) {
      const li = el('li');
      li.append(el('code', null, code), document.createTextNode(text));
      ol.append(li);
    }
    tips.append(ol);
    els.log.append(tips);
    const note = state.meta && MODE_NOTE[state.meta.mode];
    if (note) els.log.append(el('div', 'mode-note', note));
  }

  // ---------- 状态栏与 spinner ----------

  const MODE_NOTE = {
    mock: '※ 本地演示：没有配置模型 Key，回答由规则生成，工具和数据是真的。',
    offline: '※ 导游暂时没接入模型，提问不可用；! 开头的 shell 命令照常能用。',
  };
  const modelLabel = (m) => ({ mock: '本地演示', offline: '未接入模型' }[m.mode] || m.model);

  function renderStatus() {
    const m = state.meta;
    if (!m) { els.status.textContent = '连接中…'; return; }
    const q = m.quota;
    els.status.textContent = `${modelLabel(m)} · 今日额度 ${q.ipTurnsLeft}/${q.ipTurnsLimit}`;
    els.status.className = q.ipTurnsLeft <= 5 ? 'warn' : '';
    els.title.textContent = `visitor@srv-guide: ${state.cwd}`;
  }

  const GLYPHS = ['·', '✢', '✳', '✶', '✻', '✽', '✻', '✶', '✳', '✢'];
  const VERBS = ['思考中', '巡视机房', '擦拭风扇', '校对证书', '整理网线', '询问 Nginx', '泡一杯茶', '组织语言', '回忆架构图', '清点 token'];
  const spin = { timer: null, started: 0, tokens: 0, streamed: 0, frame: 0, verbAt: 0 };

  function spinnerVerb(v) {
    els.verb.textContent = `${v || VERBS[Math.floor(Math.random() * VERBS.length)]}…`;
    spin.verbAt = Date.now();
  }

  function spinnerStart() {
    Object.assign(spin, { started: Date.now(), tokens: 0, streamed: 0, frame: 0 });
    spinnerVerb();
    els.spinner.hidden = false;
    clearInterval(spin.timer);
    spin.timer = setInterval(() => {
      spin.frame = (spin.frame + 1) % GLYPHS.length;
      els.glyph.textContent = GLYPHS[spin.frame];
      if (Date.now() - spin.verbAt > 4000) spinnerVerb();
      const secs = Math.floor((Date.now() - spin.started) / 1000);
      const tokens = spin.tokens + Math.round(spin.streamed / 1.6);
      els.meta.textContent = `(${secs}s · ↓ ${tokens} tokens · esc 中断)`;
    }, 120);
  }

  function spinnerStop() {
    clearInterval(spin.timer);
    els.spinner.hidden = true;
  }

  function setRunning(on) {
    state.running = on;
    els.inputbox.classList.toggle('busy', on);
    if (on) spinnerStart(); else spinnerStop();
    els.input.placeholder = on ? '正在执行… 按 Esc 中断' : '试试“内存还够再部署一个服务吗？”';
  }

  // ---------- SSE ----------

  async function* readSse(body) {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buffer.indexOf('\n\n')) >= 0) {
        const raw = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        let event = 'message';
        let data = '';
        for (const line of raw.split('\n')) {
          if (line.startsWith('event:')) event = line.slice(6).trim();
          else if (line.startsWith('data:')) data += line.slice(5).trim();
        }
        if (data) yield { event, data: JSON.parse(data) };
      }
    }
  }

  // ---------- 动作 ----------

  async function ensureSession() {
    if (state.session) return;
    const data = await api('/session', {});
    state.session = data.id;
    state.meta = data;
    state.cwd = data.cwd || '/';
    renderStatus();
  }

  async function ask(input) {
    addUser(input);
    setRunning(true);
    const ctrl = new AbortController();
    state.ctrl = ctrl;
    let current = null;
    let thinking = null;
    let gotDone = false;
    try {
      await ensureSession();
      const res = await fetch(`${API}/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ session: state.session, input }),
        signal: ctrl.signal,
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        if (res.status === 404) state.session = null;
        addSystem(data.error || `请求失败（HTTP ${res.status}）`, 'error');
        return;
      }
      for await (const { event, data } of readSse(res.body)) {
        switch (event) {
          case 'text':
            thinking = null;
            if (!current) current = addAssistant();
            current.append(data.text);
            spin.streamed += data.text.length;
            break;
          case 'thinking':
            if (!thinking) thinking = addThinking();
            thinking.append(data.text);
            break;
          case 'tool_pending':
            current = null;
            thinking = null;
            toolEntry(data.id, data.name);
            spinnerVerb(TOOL_VERB[data.name]);
            break;
          case 'tool_start':
            toolStart(data);
            break;
          case 'tool_result':
            toolResult(data);
            spinnerVerb();
            break;
          case 'skill':
            addSystem(`已加载 skill：${data.name}${data.args ? `（参数：${data.args}）` : ''}`, 'accent');
            break;
          case 'attach':
            addSystem(`已读取 ${data.path}（${data.lines} 行）放入上下文`);
            break;
          case 'usage':
            spin.tokens = data.output;
            spin.streamed = 0;
            break;
          case 'notice':
            addSystem(data.text, 'warn');
            break;
          case 'interrupted':
            addSystem('已中断 · 你想让我换个方向吗？', 'warn');
            break;
          case 'error':
            addSystem(data.message, 'error');
            break;
          case 'evidence':
            addEvidence(data);
            break;
          case 'done':
            gotDone = true;
            if (state.meta) {
              state.meta.quota = data.quota;
              state.meta.session = data.session;
            }
            renderStatus();
            break;
          default:
            break;
        }
      }
      if (!gotDone && !ctrl.signal.aborted) addSystem('连接意外断开了。', 'error');
    } catch (err) {
      if (ctrl.signal.aborted) addSystem('已中断 · 你想让我换个方向吗？', 'warn');
      else addSystem(`无法连接 srv-guide 后端：${err.message}`, 'error');
    } finally {
      for (const t of tools.values()) if (t.e.root.classList.contains('running')) { t.e.root.classList.remove('running'); t.e.root.classList.add('err'); }
      tools.clear();
      state.ctrl = null;
      setRunning(false);
      scrollDown();
    }
  }

  function highlightShell(cmd, output) {
    const pre = el('pre');
    if (/^(ls|ll|tree)\b/.test(cmd)) pre.innerHTML = esc(output).replace(/(^|\s|── )([^\s/]+\/)(?=\s|$)/gm, '$1<span class="dir">$2</span>');
    else pre.textContent = output;
    return pre;
  }

  async function shell(cmd) {
    const e = addShell(cmd);
    try {
      await ensureSession();
      const data = await api('/shell', { session: state.session, cmd });
      if (data.clear) { els.log.textContent = ''; return; }
      state.cwd = data.cwd || state.cwd;
      renderStatus();
      if (data.output) e.body.append(highlightShell(cmd, data.output));
    } catch (err) {
      if (err.status === 404) state.session = null;
      e.body.append(el('pre', null, err.message));
    }
    scrollDown(true);
  }

  function showHelp() {
    panel((p) => {
      p.append(el('h4', null, '输入方式'));
      kv(p, [
        ['直接提问', '用中文问这台服务器，或者聊聊网站上的项目、简历和博客笔记'],
        ['/命令', '内置命令与 skill，输入 / 弹出面板'],
        ['!命令', '只读沙盒 shell（!help 查看可用命令，含 !site 和 !onto），不消耗对话额度'],
        ['@路径', '把虚拟文件系统里的文件放进上下文'],
      ]);
      p.append(el('h4', null, '内置命令'));
      kv(p, BUILTINS.filter((b) => !b.hidden).map((b) => [`/${b.name}`, b.description]));
      if (state.meta) {
        p.append(el('h4', null, 'Skill'));
        kv(p, state.meta.skills.map((s) => [`/${s.name}${s.argumentHint ? ' …' : ''}`, s.description]));
      }
      p.append(el('h4', null, '快捷键'));
      kv(p, SHORTCUTS);
    });
  }

  const SHORTCUTS = [
    ['Enter', '发送'], ['Shift+Enter', '换行'], ['Esc', '中断执行 / 关闭面板 / 清空输入'], ['↑ ↓', '历史输入'],
    ['Tab', '补全命令或文件'], ['Ctrl+O', '展开 / 收起全部工具输出'], ['Ctrl+L', '清屏（保留上下文）'],
  ];

  const BUILTINS = [
    { name: 'help', description: '显示帮助', run: showHelp },
    {
      name: 'clear',
      description: '清空对话与上下文，开始新会话',
      async run() {
        if (state.session) await api('/clear', { session: state.session }).catch(() => {});
        if (state.meta && state.meta.session) state.meta.session = { turns: 0, tokens: 0 };
        els.log.textContent = '';
        renderWelcome(true);
        addSystem('上下文已清空。');
      },
    },
    {
      name: 'skills',
      description: '列出我会的 skill',
      run() {
        if (!state.meta) return addSystem('还没连上后端。', 'error');
        panel((p) => {
          p.append(el('h4', null, `Skill（${state.meta.skills.length}）· 存放在 /skills/<名字>/SKILL.md`));
          kv(p, state.meta.skills.map((s) => [`/${s.name}${s.argumentHint ? ` ${s.argumentHint}` : ''}`, s.description]));
        });
      },
    },
    {
      name: 'tools',
      description: '列出我能调用的工具和它们的动作契约',
      run() {
        if (!state.meta) return addSystem('还没连上后端。', 'error');
        panel((p) => {
          p.append(el('h4', null, `工具（${state.meta.tools.length}）· 效果 / 读取范围 / 由什么守住`));
          kv(p, state.meta.tools.map((t) => [t.name, t.contract ? `${t.contract.effect} · 读 ${t.contract.reads} · ${t.contract.guard}` : t.description]));
          p.append(el('div', 'note', '本体说“有什么”，契约说“能做什么”，程序决定“真的能做什么”。每轮回答末尾的「依据」行由程序根据工具实际读到的东西生成。'));
        });
      },
    },
    {
      name: 'status',
      description: '查看会话、模型与额度',
      async run() {
        try { if (state.session) Object.assign(state.meta, await api(`/meta?session=${encodeURIComponent(state.session)}`)); } catch { /* 用缓存 */ }
        const m = state.meta;
        if (!m) return addSystem('还没连上后端。', 'error');
        renderStatus();
        panel((p) => {
          p.append(el('h4', null, 'srv-guide 状态'));
          kv(p, [
            ['模型', MODE_NOTE[m.mode] ? MODE_NOTE[m.mode].replace(/^※ /, '') : m.model],
            ['会话', state.session ? state.session.slice(0, 8) : '-'],
            ['当前目录', state.cwd],
            ['本会话', m.session ? `${m.session.turns}/${m.limits.sessionTurns} 轮 · ${m.session.tokens} tokens` : '-'],
            ['今日额度', `${m.quota.ipTurnsLeft}/${m.quota.ipTurnsLimit} 轮`],
            ['全站预算', `剩余约 ${m.quota.budgetLeftPct}%`],
            ['单轮上限', `${m.limits.maxSteps} 步工具调用 · 输入 ${m.limits.inputChars} 字`],
          ]);
        });
      },
    },
    {
      name: 'cost',
      description: '查看本会话的 token 消耗',
      run() {
        const m = state.meta;
        if (!m) return addSystem('还没连上后端。', 'error');
        addSystem(`本会话 ${m.session ? m.session.tokens : 0} tokens · 今日还能问 ${m.quota.ipTurnsLeft} 轮 · 账单由主人买单，谢谢手下留情 🙏`);
      },
    },
    { name: 'model', description: '查看当前模型', run() { addSystem(`当前模型：${state.meta ? state.meta.model : '未知'}。访客不能切换模型（主人的钱包说不行）。`); } },
    {
      name: 'history',
      description: '查看输入历史',
      run() {
        if (!state.history.length) return addSystem('还没有历史输入。');
        panel((p) => kv(p, state.history.slice(-15).map((h, i, a) => [String(state.history.length - a.length + i + 1), h])));
      },
    },
    {
      name: 'about',
      description: '我是怎么实现的',
      async run() {
        try {
          await ensureSession();
          const data = await api('/shell', { session: state.session, cmd: 'cat /guide/how-i-work.md' });
          addAssistant().set(data.output);
        } catch (err) { addSystem(err.message, 'error'); }
      },
    },
    {
      name: 'exit',
      description: '告别',
      run() { addSystem('再见 👋 这个终端会一直开着。想联系主人可以去 /resume/ 或 GitHub。'); },
    },
    { name: 'init', hidden: true, description: '', run() { addSystem('这里是只读服务器，没有仓库可以 init。不过你的好奇心值得一个 ⭐', 'warn'); } },
  ];

  async function submit(raw) {
    const value = raw.trim();
    if (!value) return;
    if (state.running) { addSystem('上一轮还在执行，按 Esc 中断后再试。', 'warn'); return; }
    pushHistory(value);
    els.chips.hidden = true;
    if (value.startsWith('!')) return shell(value.slice(1).trim() || 'help');
    if (value.startsWith('/')) {
      const m = /^\/(\S+)\s*([\s\S]*)$/.exec(value);
      const builtin = m && BUILTINS.find((b) => b.name === m[1]);
      if (builtin) { addUser(value); return builtin.run(m[2]); }
      if (m && state.meta && !state.meta.skills.some((s) => s.name === m[1])) {
        addUser(value);
        return addSystem(`未知命令：/${m[1]}。输入 /help 查看可用命令。`, 'error');
      }
    }
    return ask(value);
  }

  // ---------- 命令面板与补全 ----------

  function mentionToken() {
    const caret = els.input.selectionStart;
    const before = els.input.value.slice(0, caret);
    const m = /(^|\s)@([\w./~-]*)$/.exec(before);
    return m ? { start: caret - m[2].length - 1, query: m[2] } : null;
  }

  function computePalette() {
    const v = els.input.value;
    if (/^\/\S*$/.test(v)) {
      const q = v.slice(1).toLowerCase();
      const items = [
        ...BUILTINS.filter((b) => !b.hidden).map((b) => ({ value: `/${b.name}`, desc: b.description, run: true })),
        ...((state.meta && state.meta.skills) || []).map((s) => ({ value: `/${s.name}`, desc: s.description, tag: 'skill', needsArg: !!s.argumentHint, run: true })),
      ].filter((it) => it.value.slice(1).toLowerCase().includes(q))
        .sort((a, b) => a.value.slice(1).toLowerCase().startsWith(q) ? (b.value.slice(1).toLowerCase().startsWith(q) ? 0 : -1) : 1);
      return { kind: 'slash', items };
    }
    const mention = mentionToken();
    if (mention && state.meta && state.meta.files) {
      const q = mention.query.toLowerCase().replace(/^\//, '');
      const items = state.meta.files.filter((f) => f.toLowerCase().includes(q)).slice(0, 12).map((f) => ({ value: f, desc: '' }));
      return { kind: 'mention', items, mention };
    }
    return { kind: null, items: [] };
  }

  function renderPalette() {
    const pal = computePalette();
    const prev = state.pal.items[state.pal.index];
    state.pal = { ...pal, index: Math.max(0, pal.items.findIndex((it) => prev && it.value === prev.value)) };
    els.palette.textContent = '';
    if (!pal.items.length) { els.palette.hidden = true; return; }
    pal.items.forEach((it, i) => {
      const row = el('div', `item${i === state.pal.index ? ' active' : ''}`);
      row.setAttribute('role', 'option');
      const name = el('span', 'name', it.value);
      if (it.tag) name.append(el('span', 'tag', it.tag));
      row.append(name, el('span', 'desc', it.desc));
      row.addEventListener('mousedown', (ev) => { ev.preventDefault(); state.pal.index = i; choosePalette(true); });
      els.palette.append(row);
    });
    els.palette.hidden = false;
  }

  function movePalette(delta) {
    const n = state.pal.items.length;
    state.pal.index = (state.pal.index + delta + n) % n;
    [...els.palette.children].forEach((row, i) => row.classList.toggle('active', i === state.pal.index));
    els.palette.children[state.pal.index].scrollIntoView({ block: 'nearest' });
  }

  function choosePalette(execute) {
    const it = state.pal.items[state.pal.index];
    if (!it) return;
    if (state.pal.kind === 'mention') {
      const { start } = state.pal.mention;
      const v = els.input.value;
      const caret = els.input.selectionStart;
      const insert = `@${it.value.replace(/^\//, '')} `;
      els.input.value = v.slice(0, start) + insert + v.slice(caret);
      const pos = start + insert.length;
      els.input.setSelectionRange(pos, pos);
      onInput();
      return;
    }
    if (execute && !it.needsArg) {
      els.input.value = '';
      onInput();
      submit(it.value);
      return;
    }
    els.input.value = `${it.value} `;
    onInput();
  }

  function closePalette() {
    els.palette.hidden = true;
    state.pal = { items: [], index: 0, kind: null };
  }

  // ---------- 输入框 ----------

  function autosize() {
    els.input.style.height = 'auto';
    els.input.style.height = `${els.input.scrollHeight}px`;
  }

  function onInput() {
    autosize();
    const v = els.input.value;
    const bash = v.startsWith('!');
    els.inputbox.classList.toggle('bash', bash);
    els.prompt.textContent = bash ? '!' : '>';
    els.hint.className = bash ? 'bash' : '';
    els.hint.textContent = bash ? '! shell 模式 · 只读沙盒 · 不消耗额度' : v.startsWith('/') ? 'Enter 执行 · Tab 补全 · ↑↓ 选择' : '? 快捷键 · / 命令 · ! shell · @ 文件';
    renderPalette();
  }

  els.input.addEventListener('input', onInput);
  els.input.addEventListener('click', renderPalette);

  els.input.addEventListener('keydown', (ev) => {
    const palOpen = !els.palette.hidden && state.pal.items.length;
    if (ev.isComposing || ev.keyCode === 229) return;

    if (ev.key === 'Escape') {
      ev.preventDefault();
      if (state.running && state.ctrl) { state.ctrl.abort(); return; }
      if (palOpen) { closePalette(); return; }
      els.input.value = '';
      onInput();
      return;
    }
    if (palOpen && (ev.key === 'ArrowDown' || ev.key === 'ArrowUp')) { ev.preventDefault(); movePalette(ev.key === 'ArrowDown' ? 1 : -1); return; }
    if (palOpen && ev.key === 'Tab') { ev.preventDefault(); choosePalette(false); return; }
    if (ev.key === 'Enter' && !ev.shiftKey) {
      ev.preventDefault();
      if (palOpen) {
        const it = state.pal.items[state.pal.index];
        const typed = els.input.value.trim();
        // 已经完整输入了命令（可能带参数）就直接执行
        if (state.pal.kind === 'slash' && it && typed !== it.value) { choosePalette(true); return; }
        if (state.pal.kind === 'mention') { choosePalette(false); return; }
      }
      const v = els.input.value;
      els.input.value = '';
      onInput();
      closePalette();
      submit(v);
      return;
    }
    if (ev.key === '?' && !els.input.value) { ev.preventDefault(); panel((p) => { p.append(el('h4', null, '快捷键')); kv(p, SHORTCUTS); }); return; }
    if ((ev.key === 'ArrowUp' || ev.key === 'ArrowDown') && !palOpen) {
      const v = els.input.value;
      const caret = els.input.selectionStart;
      const atEdge = ev.key === 'ArrowUp' ? !v.slice(0, caret).includes('\n') : !v.slice(caret).includes('\n');
      if (!atEdge || !state.history.length) return;
      ev.preventDefault();
      if (state.histIdx === -1) state.draft = v;
      const n = state.history.length;
      let idx = state.histIdx === -1 ? n : state.histIdx;
      idx += ev.key === 'ArrowUp' ? -1 : 1;
      if (idx < 0) idx = 0;
      if (idx >= n) { state.histIdx = -1; els.input.value = state.draft; } else { state.histIdx = idx; els.input.value = state.history[idx]; }
      onInput();
      closePalette();
    }
  });

  document.addEventListener('keydown', (ev) => {
    if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'o') {
      ev.preventDefault();
      state.expandAll = !state.expandAll;
      document.querySelectorAll('.tool-out').forEach((pre) => { pre.hidden = !state.expandAll; });
    } else if (ev.ctrlKey && ev.key.toLowerCase() === 'l') {
      ev.preventDefault();
      els.log.textContent = '';
    } else if (ev.ctrlKey && ev.key.toLowerCase() === 'c' && !String(window.getSelection())) {
      if (state.running && state.ctrl) { ev.preventDefault(); state.ctrl.abort(); }
      else if (document.activeElement === els.input && els.input.value) { ev.preventDefault(); els.input.value = ''; onInput(); }
    } else if (ev.key === 'Escape' && state.running && state.ctrl && document.activeElement !== els.input) {
      state.ctrl.abort();
    }
  });

  els.screen.addEventListener('mouseup', (ev) => {
    if (String(window.getSelection())) return;
    if (ev.target.closest('a, button, .tool-sub, .toggle, .palette, textarea')) return;
    els.input.focus();
  });

  els.chips.addEventListener('click', (ev) => {
    const btn = ev.target.closest('button[data-run]');
    if (!btn) return;
    const cmd = btn.dataset.run;
    if (cmd.startsWith('/deploy-plan')) { els.input.value = cmd; onInput(); els.input.focus(); closePalette(); return; }
    submit(cmd);
  });

  // ---------- 启动 ----------

  async function boot() {
    renderStatus();
    try {
      await ensureSession();
      renderWelcome(false);
    } catch (err) {
      renderWelcome(false);
      addSystem(`暂时连不上 srv-guide 后端（${err.message}）。! 命令和提问都需要后端，请稍后刷新。`, 'error');
    }
    // 从活本体页点「问导游」过来：只把问题填进输入框，等访客自己按回车
    const ask = new URLSearchParams(location.search).get('ask');
    if (ask) {
      els.input.value = ask.replace(/\s+/g, ' ').trim().slice(0, 200);
      autosize();
      history.replaceState(null, '', location.pathname);
    }
    els.input.focus();
    scrollDown(true);
  }

  boot();
})();
