// 本地试玩：起后端（server.mjs），再在 8080 上提供网页终端，并把 /api/guide/* 转给后端。
// 线上由 Nginx 做同样的事：静态文件走 /guide/，location /api/guide/ 去掉前缀转发到 127.0.0.1:3003。
//   node dev.mjs            没有 LLM_API_KEY 时用离线模式（只能用 ! 命令和 skill 的固定流程）
//   GUIDE_PROVIDER=mock node dev.mjs   用脚本化的假模型走一遍工具调用
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.DEV_PORT || process.env.PORT || 8080);
const API_PORT = Number(process.env.GUIDE_API_PORT || 3003);
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'srv-guide-'));
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

const backend = spawn(process.execPath, [path.join(here, 'server.mjs')], {
  stdio: 'inherit',
  env: { DATA_DIR: scratch, KNOCK_DIR: scratch, SITE_DIR: path.join(here, 'web'), ...process.env, PORT: String(API_PORT), HOST: '127.0.0.1' },
});

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname.startsWith('/api/guide/')) {
    const upstream = http.request({ host: '127.0.0.1', port: API_PORT, method: req.method, path: url.pathname.slice('/api/guide'.length) + url.search, headers: req.headers }, (r) => {
      res.writeHead(r.statusCode, r.headers);
      r.pipe(res);
    });
    upstream.on('error', () => { res.writeHead(502); res.end('后端还没起来'); });
    return req.pipe(upstream);
  }
  if (url.pathname === '/') { res.writeHead(302, { Location: '/guide/' }); return res.end(); }
  const rel = url.pathname.endsWith('/') ? url.pathname + 'index.html' : url.pathname;
  const file = path.join(here, 'web', path.normalize(rel).replace(/^([/\\])+/, ''));
  if (!file.startsWith(path.join(here, 'web')) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end('not found'); }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});

server.listen(PORT, '127.0.0.1', () => console.log(`打开 http://127.0.0.1:${PORT}/guide/`));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { backend.kill(); server.close(); process.exit(0); });
