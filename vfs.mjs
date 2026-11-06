// 只读虚拟文件系统：启动时把 vfs/ 目录整体读进内存，之后所有访问都只在这棵树里进行，
// 不会触及真实磁盘路径，访客也就无法借路径穿越读到别的文件。
import fs from 'node:fs';
import path from 'node:path';

export class Vfs {
  constructor(rootDir) {
    this.files = new Map();
    this.dirs = new Map([['/', new Set()]]);
    this.#load(rootDir, '/');
  }

  #load(realDir, virtualDir) {
    for (const entry of fs.readdirSync(realDir, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const real = path.join(realDir, entry.name);
      const virtual = virtualDir === '/' ? `/${entry.name}` : `${virtualDir}/${entry.name}`;
      this.dirs.get(virtualDir).add(entry.name + (entry.isDirectory() ? '/' : ''));
      if (entry.isDirectory()) {
        this.dirs.set(virtual, new Set());
        this.#load(real, virtual);
      } else {
        this.files.set(virtual, fs.readFileSync(real, 'utf8').replace(/\r\n/g, '\n'));
      }
    }
  }

  // 把访客输入的路径解析成虚拟树里的绝对路径；`..` 最多退到根目录。
  resolve(input = '.', cwd = '/') {
    let p = String(input).trim() || '.';
    if (p === '~' || p.startsWith('~/')) p = '/' + p.slice(1);
    const parts = (p.startsWith('/') ? p : `${cwd}/${p}`).split('/');
    const stack = [];
    for (const part of parts) {
      if (!part || part === '.') continue;
      if (part === '..') stack.pop();
      else stack.push(part);
    }
    return '/' + stack.join('/');
  }

  isDir(p) { return this.dirs.has(p); }
  isFile(p) { return this.files.has(p); }
  read(p) { return this.files.get(p); }

  list(p) {
    const entries = this.dirs.get(p);
    if (!entries) return null;
    return [...entries].sort((a, b) => (b.endsWith('/') - a.endsWith('/')) || a.localeCompare(b));
  }

  allFiles(under = '/') {
    const prefix = under === '/' ? '/' : `${under}/`;
    return [...this.files.keys()].filter((f) => under === '/' || f.startsWith(prefix)).sort();
  }

  tree(p = '/', prefix = '') {
    const lines = [];
    const entries = this.list(p) || [];
    entries.forEach((name, i) => {
      const last = i === entries.length - 1;
      lines.push(`${prefix}${last ? '└── ' : '├── '}${name}`);
      if (name.endsWith('/')) {
        const child = p === '/' ? `/${name.slice(0, -1)}` : `${p}/${name.slice(0, -1)}`;
        lines.push(...this.tree(child, prefix + (last ? '    ' : '│   ')));
      }
    });
    return lines;
  }

  grep(needle, under = '/') {
    const q = String(needle).toLowerCase();
    const hits = [];
    for (const file of this.allFiles(under)) {
      this.files.get(file).split('\n').forEach((line, i) => {
        if (line.toLowerCase().includes(q)) hits.push(`${file}:${i + 1}: ${line.trim()}`);
      });
    }
    return hits;
  }
}

// 解析 SKILL.md 的 frontmatter（只支持简单的 key: value）。
export function parseSkill(text) {
  const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text);
  if (!match) return { meta: {}, body: text };
  const meta = {};
  for (const line of match[1].split('\n')) {
    const kv = /^([\w-]+):\s*(.*)$/.exec(line);
    if (kv) meta[kv[1]] = kv[2].trim();
  }
  return { meta, body: match[2].trim() };
}

export function loadSkills(vfs) {
  const skills = new Map();
  for (const file of vfs.allFiles('/skills')) {
    if (!file.endsWith('/SKILL.md')) continue;
    const { meta, body } = parseSkill(vfs.read(file));
    const name = meta.name || file.split('/').at(-2);
    skills.set(name, { name, description: meta.description || '', argumentHint: meta['argument-hint'] || '', body, path: file });
  }
  return skills;
}
