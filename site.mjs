// 网站内容索引：读取已发布的静态页（/srv/www/personal），抽出正文、按标题分段，供 SiteSearch / ReadPage 使用。
// 只读、只索引公开页面：未公开的页面、演示应用、静态资源和导游自身不进索引，带 noindex 的页面也跳过。
import fs from 'node:fs';
import path from 'node:path';

const EXCLUDE_TOP = new Set(['chat', 'apps', 'assets', 'guide']);
const DROP_TAGS = ['script', 'style', 'nav', 'aside', 'footer', 'svg', 'noscript', 'button', 'template', 'form', 'canvas'];
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', middot: '·', mdash: '—', ndash: '–', hellip: '…', rarr: '→', larr: '←' };
const CJK = /[㐀-鿿]/;
// 几乎每页都有、对检索没有区分度的词
const STOP = new Set(['什么', '怎么', '如何', '这个', '那个', '一个', '哪些', '为什么', '可以', '我们', '你们', '一下', '有没', '没有', '关于', '介绍', '是什', '么是', '的是', '吗？', '主人', '网站', '他的', '你的', '有哪', '讲讲', '说说']);

export function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1));
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

const stripTags = (s) => decodeEntities(s.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();

// 把一页 HTML 变成 { title, sections: [{ id, heading, level, text }] }
export function extractPage(html) {
  const docTitle = stripTags(/<title>([\s\S]*?)<\/title>/i.exec(html)?.[1] || '');
  let body = /<main\b[^>]*>([\s\S]*)<\/main>/i.exec(html)?.[1] ?? /<body\b[^>]*>([\s\S]*)<\/body>/i.exec(html)?.[1] ?? html;
  body = body.replace(/<!--[\s\S]*?-->/g, '');
  for (const tag of DROP_TAGS) body = body.replace(new RegExp(`<${tag}\\b[\\s\\S]*?<\\/${tag}>`, 'gi'), ' ');
  body = body
    .replace(/<h([1-4])\b([^>]*)>([\s\S]*?)<\/h\1>/gi, (m, level, attrs, inner) => {
      const id = /\bid="([^"]*)"/.exec(attrs)?.[1] || '';
      return `\n\u0001${level}\u0002${id}\u0002${stripTags(inner)}\n`;
    })
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<(?:td|th)\b[^>]*>/gi, ' | ')
    .replace(/<br\s*\/?>|<\/(?:p|div|section|article|li|tr|ul|ol|table|blockquote|pre|header|dd|dt)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
  body = decodeEntities(body);

  const sections = [];
  const seen = new Set();
  let cur = { id: '', heading: '', level: 0, lines: [] };
  for (const raw of body.split('\n')) {
    const line = raw.replace(/[ \t ]+/g, ' ').trim();
    // 跑马灯之类的装饰会把同一行重复多次
    if (!line || line === '-' || (line[0] !== '\u0001' && line.length > 20 && seen.has(line))) continue;
    seen.add(line);
    if (line[0] === '\u0001') {
      const [level, id, heading] = line.slice(1).split('\u0002');
      if (cur.heading || cur.lines.length) sections.push(cur);
      cur = { id, heading, level: Number(level), lines: [] };
    } else {
      cur.lines.push(line);
    }
  }
  if (cur.heading || cur.lines.length) sections.push(cur);
  // 「本体论与领域建模 · 刘浩的知识花园」只留前半；「刘浩 · Agent 工坊」这种保持原样
  const title = docTitle.replace(/ · 刘浩(?:的知识花园)?$/, '') || stripTags(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i.exec(html)?.[1] || '');
  return {
    title,
    sections: sections.map(({ lines, ...s }) => ({ ...s, text: lines.join('\n') })).filter((s) => s.text || s.level > 1),
  };
}

// 查询词：英文/数字按词，中文取二元组（短词整体也算一个），去掉无区分度的词。
export function queryTerms(query) {
  const terms = new Set();
  for (const run of String(query).toLowerCase().match(/[a-z0-9][a-z0-9.+#-]*|[㐀-鿿]+/g) || []) {
    if (CJK.test(run)) {
      if (run.length <= 4 && !STOP.has(run)) terms.add(run);
      for (let i = 0; i < run.length - 1; i++) {
        const bi = run.slice(i, i + 2);
        if (!STOP.has(bi)) terms.add(bi);
      }
      if (run.length === 1) terms.add(run);
    } else if (run.length >= 2) {
      terms.add(run);
    }
  }
  return [...terms];
}

const count = (hay, needle) => {
  let n = 0;
  for (let i = hay.indexOf(needle); i >= 0 && n < 6; i = hay.indexOf(needle, i + needle.length)) n++;
  return n;
};

function snippet(text, terms, width = 110) {
  const lower = text.toLowerCase();
  let at = -1;
  for (const t of [...terms].sort((a, b) => b.length - a.length)) {
    at = lower.indexOf(t);
    if (at >= 0) break;
  }
  const start = Math.max(0, at - 30);
  const s = text.slice(start, start + width).replace(/\n/g, ' ');
  return `${start > 0 ? '…' : ''}${s}${start + width < text.length ? '…' : ''}`;
}

export function normalizeUrl(input) {
  let u = String(input || '').trim();
  u = u.replace(/^https?:\/\/[^/]+/i, '');
  const hashAt = u.indexOf('#');
  const hash = hashAt >= 0 ? decodeURIComponent(u.slice(hashAt + 1)) : '';
  u = (hashAt >= 0 ? u.slice(0, hashAt) : u).split('?')[0].replace(/index\.html$/, '');
  if (!u.startsWith('/')) u = `/${u}`;
  if (!u.endsWith('/')) u = `${u}/`;
  return { url: u.replace(/\/{2,}/g, '/'), hash };
}

export class SiteIndex {
  constructor(rootDir, { ttlMs = 5 * 60 * 1000 } = {}) {
    this.root = rootDir;
    this.ttlMs = ttlMs;
    this.loadedAt = 0;
    this.byUrl = new Map();
  }

  #scan(dir, rel, out) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      if (e.isDirectory()) {
        if (!rel && EXCLUDE_TOP.has(e.name)) continue;
        this.#scan(path.join(dir, e.name), rel ? `${rel}/${e.name}` : e.name, out);
      } else if (e.name === 'index.html') {
        out.push({ file: path.join(dir, e.name), url: rel ? `/${rel}/` : '/' });
      }
    }
  }

  refresh(force = false) {
    if (!force && Date.now() - this.loadedAt < this.ttlMs) return this;
    const found = [];
    this.#scan(this.root, '', found);
    const next = new Map();
    for (const { file, url } of found) {
      let html;
      try { html = fs.readFileSync(file, 'utf8'); } catch { continue; }
      if (/<meta[^>]+name=["']robots["'][^>]+noindex/i.test(html)) continue;
      const page = extractPage(html);
      next.set(url, { url, ...page, chars: page.sections.reduce((n, s) => n + s.text.length, 0) });
    }
    this.byUrl = next;
    this.loadedAt = Date.now();
    return this;
  }

  pages() {
    this.refresh();
    return [...this.byUrl.values()].sort((a, b) => a.url.localeCompare(b.url));
  }

  page(url) {
    this.refresh();
    return this.byUrl.get(normalizeUrl(url).url) || null;
  }

  search(query, limit = 6) {
    this.refresh();
    const terms = queryTerms(query);
    if (!terms.length) return [];
    const whole = String(query).trim().toLowerCase();
    const hits = [];
    for (const page of this.byUrl.values()) {
      const title = page.title.toLowerCase();
      const titleScore = terms.reduce((n, t) => n + (title.includes(t) ? t.length : 0), 0);
      for (const s of page.sections) {
        const text = s.text.toLowerCase();
        const heading = s.heading.toLowerCase();
        let score = 0;
        for (const t of terms) score += count(text, t) * Math.min(t.length, 4) + (heading.includes(t) ? 3 * t.length : 0);
        if (!score) continue;
        if (whole.length >= 2 && (text.includes(whole) || heading.includes(whole))) score += 12;
        score += titleScore * 2;
        hits.push({ url: page.url, title: page.title, heading: s.heading, anchor: s.id, score, snippet: snippet(s.text || s.heading, terms) });
      }
    }
    hits.sort((a, b) => b.score - a.score);
    const perPage = new Map();
    const out = [];
    for (const h of hits) {
      const n = perPage.get(h.url) || 0;
      if (n >= 2) continue;
      perPage.set(h.url, n + 1);
      out.push(h);
      if (out.length >= limit) break;
    }
    return out;
  }

  // 读一页（或其中一节）：section 可以是锚点 id、标题文字，或 URL 里的 #片段
  read(input, section = '') {
    this.refresh();
    const { url, hash } = normalizeUrl(input);
    const page = this.byUrl.get(url);
    if (!page) return null;
    const want = String(section || hash || '').trim();
    let sections = page.sections;
    if (want) {
      const i = page.sections.findIndex((s) => s.id === want || (s.heading && (s.heading === want || s.heading.includes(want))));
      if (i >= 0) {
        // 带上该节的下级小节
        const level = page.sections[i].level || 9;
        let j = i + 1;
        while (j < page.sections.length && page.sections[j].level > level) j++;
        sections = page.sections.slice(i, j);
      }
    }
    const text = sections.map((s) => (s.heading ? `${'#'.repeat(Math.max(1, s.level))} ${s.heading}${s.id ? `  {#${s.id}}` : ''}\n${s.text}` : s.text)).join('\n\n');
    return { url, title: page.title, section: sections !== page.sections ? sections[0].heading : '', text, toc: page.sections.filter((s) => s.level >= 2).map((s) => s.heading) };
  }
}
