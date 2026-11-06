// 世界模型：把三种来源的知识合成一张带类型的图，供 Ontology 工具和 `!onto` 命令查询。
//   设定   vfs/ontology/world.json：类、关系（domain / range）、服务器上的对象、边界与执行机制
//   笔记   网站 blog/graph.json：博客「Agent 学习本体」的节点和关系（属性 / 双链）
//   运行时 工具（带动作契约）、skill、已发布页面，从代码和网站自动生成
// 每条边都带来源；构建时按 domain / range 校验，不合规的边会列在 schema 里，而不是悄悄吞掉。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { queryTerms, normalizeUrl } from './site.mjs';

const HIDDEN_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'private', 'hidden.json');

// 不公开服务的清单是可选的：文件不存在就当没有。GUIDE_HIDDEN_FILE 可以指到别处（测试用 private/hidden.example.json）
export function loadHidden(file = process.env.GUIDE_HIDDEN_FILE || HIDDEN_FILE) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return { entities: [], edges: [] };
    throw error;
  }
}

const KIND_CLASS = { concept: 'Concept', pattern: 'Pattern', practice: 'Practice', article: 'Article' };
const ORIGIN_LABEL = { frontmatter: '笔记·属性', wikilink: '笔记·双链' };
const MAX_EDGES_SHOWN = 24;
const COLLAPSE = ['has_tool', 'has_skill'];

export class Ontology {
  constructor({ world, site = null, tools = [], skills = new Map() }) {
    this.world = world;
    this.site = site;
    this.tools = tools;
    this.skills = skills;
    this.builtFor = -1;
    this.build();
  }

  // includeHidden：再并入 private/hidden.json 里不公开的服务（实体带 hidden: true）。
  // 那个文件不在 vfs 里，导游读不到；只有部署时的漂移对账和活本体的内部采集会用它。
  static fromFile(file, { includeHidden = false, ...opts } = {}) {
    const world = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (includeHidden) {
      const extra = loadHidden();
      world.entities = [...world.entities, ...extra.entities.map((e) => ({ ...e, hidden: true }))];
      world.edges = [...world.edges, ...extra.edges];
    }
    return new Ontology({ ...opts, world });
  }

  // 网站索引刷新后（页面或博客图谱可能变了）才重建
  #fresh() {
    if (this.site) this.site.refresh();
    const stamp = this.site?.loadedAt ?? 0;
    if (stamp !== this.builtFor) this.build();
    return this;
  }

  stats() {
    this.#fresh();
    return { entities: this.entities.size, edges: this.edges.length, classes: Object.keys(this.classes).length, issues: this.issues.length };
  }

  build() {
    const w = this.world;
    this.classes = w.classes;
    this.relations = w.relations;
    this.entities = new Map();
    this.edges = [];
    const add = (e) => { if (!this.entities.has(e.id)) this.entities.set(e.id, e); };

    for (const e of w.entities) add({ ...e, provenance: '设定' });

    // 运行时：已发布页面
    const pages = this.site ? this.site.pages() : [];
    for (const p of pages) add({ id: `page:${p.url}`, class: 'Page', label: p.title, url: p.url, summary: `网站页面 ${p.url}`, provenance: '运行时' });

    // 笔记：博客图谱
    this.graph = null;
    if (this.site) {
      try { this.graph = JSON.parse(fs.readFileSync(path.join(this.site.root, 'blog', 'graph.json'), 'utf8')); } catch { /* 网站没有博客图谱 */ }
    }
    const noteId = new Map();
    if (this.graph) {
      const stages = this.graph.schema?.stages || {};
      for (const n of this.graph.nodes || []) {
        const id = this.entities.has(n.id) ? `note:${n.id}` : n.id;
        noteId.set(n.id, id);
        add({
          id, class: KIND_CLASS[n.kind] || 'Concept', label: n.title, aliases: n.aliases || [], tags: n.tags || [],
          summary: n.summary || '', url: n.url, stage: n.stage, stageLabel: stages[n.stage] || n.stage, updated: n.updated, provenance: '笔记',
        });
        if (n.url) this.edges.push({ source: id, target: `page:${normalizeUrl(n.url).url}`, relation: 'published_as', provenance: '运行时' });
      }
      for (const e of this.graph.edges || []) {
        this.edges.push({ source: noteId.get(e.source) || e.source, target: noteId.get(e.target) || e.target, relation: e.relation, provenance: ORIGIN_LABEL[e.origin] || '笔记' });
      }
    }

    // 运行时：工具与 skill
    for (const t of this.tools) {
      add({ id: `tool:${t.name}`, class: 'Tool', label: t.name, summary: t.description, contract: t.contract, provenance: '运行时' });
      this.edges.push({ source: 'srv-guide', target: `tool:${t.name}`, relation: 'has_tool', provenance: '运行时' });
      for (const r of t.contract?.readsEntities || []) this.edges.push({ source: `tool:${t.name}`, target: r, relation: 'reads', provenance: '运行时' });
    }
    for (const s of this.skills.values()) {
      add({ id: `skill:${s.name}`, class: 'Skill', label: `/${s.name}`, summary: s.description, provenance: '运行时' });
      this.edges.push({ source: 'srv-guide', target: `skill:${s.name}`, relation: 'has_skill', provenance: '运行时' });
    }

    for (const e of w.edges) this.edges.push({ ...e, provenance: '设定' });
    for (const e of w.entities) {
      for (const tool of e.observe || []) this.edges.push({ source: `tool:${tool}`, target: e.id, relation: 'observes', provenance: '设定' });
    }

    this.issues = this.#validate();
    const bad = new Set(this.issues.map((i) => i.edge));
    this.edges = this.edges.filter((e) => !bad.has(e));
    this.out = new Map();
    this.in = new Map();
    for (const e of this.edges) {
      if (!this.out.has(e.source)) this.out.set(e.source, []);
      if (!this.in.has(e.target)) this.in.set(e.target, []);
      this.out.get(e.source).push(e);
      this.in.get(e.target).push(e);
    }
    for (const e of this.entities.values()) if (e.class === 'Boundary') e.strength = this.#strength(e.id);
    this.builtFor = this.site?.loadedAt ?? 0;
    return this;
  }

  isA(cls, ancestor) {
    for (let c = cls; c; c = this.classes[c]?.parent) if (c === ancestor) return true;
    return false;
  }

  classChain(cls) {
    const chain = [];
    for (let c = cls; c; c = this.classes[c]?.parent) chain.unshift(c);
    return chain;
  }

  #validate() {
    const issues = [];
    for (const edge of this.edges) {
      const rel = this.relations[edge.relation];
      const s = this.entities.get(edge.source);
      const t = this.entities.get(edge.target);
      let problem = '';
      if (!rel) problem = `未定义的关系 ${edge.relation}`;
      else if (!s) problem = `起点 ${edge.source} 不存在`;
      else if (!t) problem = `终点 ${edge.target} 不存在`;
      else if (!rel.domain.some((d) => this.isA(s.class, d))) problem = `${s.id}（${s.class}）不在 ${edge.relation} 的 domain ${rel.domain.join('/')} 内`;
      else if (!rel.range.some((r) => this.isA(t.class, r))) problem = `${t.id}（${t.class}）不在 ${edge.relation} 的 range ${rel.range.join('/')} 内`;
      if (problem) issues.push({ edge, problem });
    }
    return issues;
  }

  // 边界的强度：只由提示词守住 = 软约束；有程序或配置参与 = 硬约束
  #strength(id) {
    const by = (this.out.get(id) || []).filter((e) => e.relation === 'enforced_by').map((e) => e.target);
    if (!by.length) return '未声明执行机制';
    const soft = by.filter((m) => m === 'm-prompt').length;
    if (soft === by.length) return '软约束（只靠提示词）';
    return soft ? '硬约束（程序兜底 + 提示词引导）' : '硬约束（程序 / 配置执行）';
  }

  // 页面对应的博客笔记节点（如果它是一篇笔记或文章）
  noteForUrl(url) {
    this.#fresh();
    const pageId = `page:${normalizeUrl(url).url}`;
    const edge = (this.in.get(pageId) || []).find((e) => e.relation === 'published_as' && this.isA(this.entities.get(e.source)?.class, 'KnowledgeNode'));
    return edge ? this.entities.get(edge.source) : null;
  }

  resolveClass(name) {
    if (!name) return null;
    const q = String(name).trim().toLowerCase();
    return Object.keys(this.classes).find((k) => k.toLowerCase() === q || this.classes[k].label.toLowerCase() === q) || null;
  }

  resolve(ref) {
    this.#fresh();
    const raw = String(ref || '').trim();
    if (!raw) return null;
    if (this.entities.has(raw)) return this.entities.get(raw);
    for (const prefix of ['tool:', 'skill:', 'note:']) if (this.entities.has(prefix + raw)) return this.entities.get(prefix + raw);
    if (raw.startsWith('/') || raw.startsWith('page:') || /^https?:/.test(raw)) {
      const p = this.entities.get(`page:${normalizeUrl(raw.replace(/^page:/, '')).url}`);
      if (p) return p;
    }
    const q = raw.toLowerCase().replace(/^\//, '');
    // 笔记和它的页面同名时，先给知识节点；页面只在没有别的同名对象时才返回
    let pageHit = null;
    for (const e of this.entities.values()) {
      if (e.label.toLowerCase().replace(/^\//, '') === q || (e.aliases || []).some((a) => a.toLowerCase() === q)) {
        if (e.class !== 'Page') return e;
        pageHit ||= e;
      }
    }
    if (pageHit) return pageHit;
    const [best, second] = this.find(raw, null, 2);
    // 只靠说明里零星几个字撞上的不算：至少要在名称、别名或标签上命中
    return best && best.score >= 6 && (!second || best.score > second.score * 1.5) ? this.entities.get(best.id) : null;
  }

  find(query, cls = null, limit = 12) {
    this.#fresh();
    const klass = cls ? this.resolveClass(cls) : null;
    const q = String(query || '').trim().toLowerCase();
    const terms = q ? queryTerms(q) : [];
    const out = [];
    for (const e of this.entities.values()) {
      if (klass && !this.isA(e.class, klass)) continue;
      let score = q ? 0 : 1;
      if (q) {
        const label = e.label.toLowerCase();
        const aliases = (e.aliases || []).map((a) => a.toLowerCase());
        const tags = (e.tags || []).map((a) => a.toLowerCase());
        const summary = (e.summary || '').toLowerCase();
        if (e.id === q) score += 100;
        if (label === q) score += 80;
        if (aliases.includes(q)) score += 70;
        if (label.includes(q)) score += 30;
        if (aliases.some((a) => a.includes(q))) score += 20;
        if (tags.some((a) => a.includes(q))) score += 15;
        if (summary.includes(q)) score += 8;
        for (const t of terms) score += (label.includes(t) ? 4 : 0) + (tags.some((a) => a.includes(t)) ? 2 : 0) + (summary.includes(t) ? 1 : 0);
      }
      if (score > 0) out.push({ id: e.id, label: e.label, class: e.class, score });
    }
    return out.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).slice(0, limit);
  }

  // 无向 BFS，返回从 from 到 to 的一条最短关系链
  path(fromRef, toRef, maxDepth = 5) {
    const from = this.resolve(fromRef);
    const to = this.resolve(toRef);
    if (!from || !to) return { from, to, steps: null };
    const prev = new Map([[from.id, null]]);
    let frontier = [from.id];
    for (let depth = 0; depth < maxDepth && frontier.length && !prev.has(to.id); depth++) {
      const next = [];
      for (const id of frontier) {
        const around = [...(this.out.get(id) || []).map((e) => [e.target, e, '→']), ...(this.in.get(id) || []).map((e) => [e.source, e, '←'])];
        for (const [other, edge, dir] of around) {
          if (prev.has(other)) continue;
          prev.set(other, { id, edge, dir });
          next.push(other);
        }
      }
      frontier = next;
    }
    if (!prev.has(to.id)) return { from, to, steps: [] };
    const steps = [];
    for (let cur = to.id; prev.get(cur); cur = prev.get(cur).id) steps.unshift({ ...prev.get(cur), to: cur });
    return { from, to, steps };
  }

  // ---------- 给模型和 shell 看的文本 ----------

  label(id) {
    const e = this.entities.get(id);
    if (!e) return id;
    const cls = this.classes[e.class]?.label || e.class;
    return e.label === id ? `${id}（${cls}）` : `${id} ${e.label}（${cls}）`;
  }

  formatSchema() {
    this.#fresh();
    const counts = {};
    for (const e of this.entities.values()) counts[e.class] = (counts[e.class] || 0) + 1;
    const total = (cls) => Object.keys(this.classes).filter((c) => this.isA(c, cls)).reduce((n, c) => n + (counts[c] || 0), 0);
    const lines = [`${this.world.title} v${this.world.version}：${this.entities.size} 个实体，${this.edges.length} 条关系`, '', '原则：'];
    for (const p of this.world.principles || []) lines.push(`- ${p}`);
    lines.push('', '类（括号里是实体数，含子类）：');
    const walk = (cls, depth) => {
      const c = this.classes[cls];
      lines.push(`${'  '.repeat(depth)}${cls} ${c.label}（${total(cls)}）${c.note ? ` — ${c.note}` : ''}`);
      for (const child of Object.keys(this.classes).filter((k) => this.classes[k].parent === cls)) walk(child, depth + 1);
    };
    walk('Thing', 0);
    lines.push('', '关系（domain → range）：');
    for (const [name, r] of Object.entries(this.relations)) {
      lines.push(`- ${name} ${r.label}：${r.domain.join('/')} → ${r.range.join('/')}${r.meaning ? `。${r.meaning}` : ''}`);
    }
    const prov = {};
    for (const e of this.edges) prov[e.provenance] = (prov[e.provenance] || 0) + 1;
    lines.push('', `边的来源：${Object.entries(prov).map(([k, v]) => `${k} ${v}`).join('，')}`);
    lines.push(this.issues.length
      ? `校验：${this.issues.length} 条边不符合 domain/range 或指向不存在的实体，已排除：\n${this.issues.slice(0, 8).map((i) => `  ✘ ${i.edge.source} -${i.edge.relation}-> ${i.edge.target}：${i.problem}`).join('\n')}`
      : '校验：所有边都符合 domain / range，没有悬空引用。');
    return lines.join('\n');
  }

  formatEntity(e) {
    this.#fresh();
    const cls = this.classes[e.class];
    const lines = [
      `${e.id}  「${e.label}」  [${cls?.label || e.class}]  来源：${e.provenance}`,
      `类：${this.classChain(e.class).map((c) => this.classes[c].label).join(' › ')}`,
    ];
    if (e.summary) lines.push(`说明：${e.summary}`);
    if (e.aliases?.length) lines.push(`别名：${e.aliases.join('、')}`);
    if (e.tags?.length) lines.push(`标签：${e.tags.join('、')}`);
    if (e.stage) lines.push(`阶段：${e.stageLabel}${e.updated ? `（更新 ${e.updated}）` : ''}${e.stage === 'seed' ? ' —— 起步笔记，观点还在形成，不要当成结论或成果' : ''}`);
    if (e.url) lines.push(`页面：${e.url}`);
    if (e.strength) lines.push(`强度：${e.strength}`);
    if (e.contract) {
      const c = e.contract;
      lines.push(`动作契约：效果 ${c.effect}；读取 ${c.reads}；由 ${c.guard} 守住`);
    }
    const observers = (this.in.get(e.id) || []).filter((x) => x.relation === 'observes').map((x) => x.source.replace(/^tool:/, ''));
    if (observers.length) lines.push(`可实测：${observers.join('、')}（想知道它此刻的状态，调用这些工具）`);
    const fmt = (list, dir) => {
      const shown = list.filter((x) => x.relation !== 'observes' || dir === '→');
      // 工具和 skill 往往一来就是十几条，压成一行，把位置留给更有信息量的关系
      const rows = [];
      const rest = [];
      for (const rel of COLLAPSE) {
        const group = dir === '→' ? shown.filter((x) => x.relation === rel) : [];
        if (group.length > 2) rows.push(`  ${this.relations[rel]?.label || rel} → ${group.map((x) => x.target.replace(/^(tool|skill):/, '')).join('、')}  [${group[0].provenance}]`);
        else rest.push(...group);
      }
      rest.push(...shown.filter((x) => dir !== '→' || !COLLAPSE.includes(x.relation)));
      for (const x of rest.slice(0, MAX_EDGES_SHOWN)) {
        const other = dir === '→' ? x.target : x.source;
        const rel = this.relations[x.relation]?.label || x.relation;
        rows.push(`  ${rel} ${dir} ${this.label(other)}  [${x.provenance}]${x.note ? ` ${x.note}` : ''}`);
      }
      if (rest.length > MAX_EDGES_SHOWN) rows.push(`  …还有 ${rest.length - MAX_EDGES_SHOWN} 条`);
      return rows;
    };
    const outs = fmt(this.out.get(e.id) || [], '→');
    const ins = fmt(this.in.get(e.id) || [], '←');
    if (outs.length) lines.push('出向关系：', ...outs);
    if (ins.length) lines.push('入向关系：', ...ins);
    if (!outs.length && !ins.length) lines.push('（没有与它相连的关系）');
    return lines.join('\n');
  }

  formatPath({ from, to, steps }) {
    if (!from || !to) return `找不到实体：${!from ? '起点' : '终点'}`;
    if (!steps.length) return `${from.id} 与 ${to.id} 在 5 步之内没有关系链。没有路径也是一种信息：它们在这个模型里并不相干。`;
    const parts = [from.id];
    for (const s of steps) {
      const rel = this.relations[s.edge.relation]?.label || s.edge.relation;
      parts.push(s.dir === '→' ? ` —${rel}→ ${s.to}` : ` ←${rel}— ${s.to}`);
    }
    return `${parts.join('')}\n\n逐步：\n${steps.map((s) => `  ${this.label(s.edge.source)} ${this.relations[s.edge.relation]?.label || s.edge.relation} ${this.label(s.edge.target)}  [${s.edge.provenance}]`).join('\n')}`;
  }

  // Ontology 工具与 !onto 共用的入口；返回 { content, summary, entities, isError }
  query({ op = '', id = '', query = '', from = '', to = '', class: cls = '' } = {}) {
    this.#fresh();
    op = String(op || (from && to ? 'path' : id ? 'entity' : query || cls ? 'find' : 'schema'));
    if (op === 'schema') return { content: this.formatSchema(), summary: `${this.entities.size} 个实体 · ${this.edges.length} 条关系 · ${Object.keys(this.classes).length} 个类`, entities: [] };
    if (op === 'entity') {
      const e = this.resolve(id || query);
      if (!e) {
        const near = this.find(id || query, null, 6);
        return { content: `没有实体「${id || query}」。${near.length ? `相近的：${near.map((n) => n.id).join('、')}` : '用 op=find 搜索。'}`, summary: '没有这个实体', entities: [], isError: true };
      }
      const degree = (this.out.get(e.id) || []).length + (this.in.get(e.id) || []).length;
      return { content: this.formatEntity(e), summary: `${e.id} · ${this.classes[e.class]?.label || e.class} · ${degree} 条关系`, entities: [e.id] };
    }
    if (op === 'find') {
      const klass = cls ? this.resolveClass(cls) : null;
      if (cls && !klass) return { content: `没有类「${cls}」。可用：${Object.keys(this.classes).join('、')}`, summary: '没有这个类', entities: [], isError: true };
      const hits = this.find(query, klass, 20);
      const body = hits.map((h) => `${h.id}  「${h.label}」  ${this.classes[h.class]?.label || h.class}`).join('\n');
      return { content: body || '没有匹配的实体', summary: `${hits.length} 个实体${klass ? `（${this.classes[klass].label}）` : ''}`, entities: [] };
    }
    if (op === 'path') {
      const r = this.path(from, to);
      return { content: this.formatPath(r), summary: r.steps?.length ? `${r.steps.length} 步关系链` : r.steps ? '没有关系链' : '找不到实体', entities: r.steps?.length ? [r.from.id, ...r.steps.map((s) => s.to)] : [], isError: !r.steps };
    }
    return { content: `未知 op：${op}。可用 schema / find / entity / path`, summary: `未知 op：${op}`, entities: [], isError: true };
  }
}
