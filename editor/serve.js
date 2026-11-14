'use strict';
// Mermaid 本地编辑器 —— 静态服务 + 文件读写 API
// 用法: node serve.js [端口] [要打开的文件 | noopen]

const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const EDITOR_DIR = __dirname;
const DOC_ROOT = path.resolve(__dirname, '..');   // 文档根目录：editor 的上一级
const PORT = Number(process.argv[2] || 8787);
// 拖到 启动.cmd 上时，cmd 可能把引号原样传进来，这里统一去掉
const OPEN_ARG = process.argv[3] === 'noopen' ? ''
  : (process.argv[3] || '').trim().replace(/^"+|"+$/g, '');
const MAX_BODY = 32 * 1024 * 1024;

const TEXT_EXT = new Set(['.md', '.mmd', '.markdown', '.mermaid', '.txt']);

/* ---------- 工具 ---------- */

function insideRoot(p) {
  const abs = path.resolve(p);
  const rel = path.relative(DOC_ROOT, abs);
  if (!rel) return abs;                                   // DOC_ROOT 本身
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return abs;
}

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body)
  });
  res.end(body);
}

function sendText(res, code, text) {
  res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(text);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('内容过大（>32MB）')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
      catch (e) { reject(new Error('请求体不是合法 JSON')); }
    });
    req.on('error', reject);
  });
}

/* ---------- API ---------- */

async function apiList(res, url) {
  const raw = url.searchParams.get('dir') || '';
  const dir = raw ? insideRoot(raw) : DOC_ROOT;
  if (!dir) return sendJson(res, 403, { error: '路径不在允许范围内' });

  let st;
  try { st = await fsp.stat(dir); } catch { return sendJson(res, 404, { error: '目录不存在：' + dir }); }
  if (!st.isDirectory()) return sendJson(res, 400, { error: '不是目录：' + dir });

  const dirents = await fsp.readdir(dir, { withFileTypes: true });
  const entries = [];
  for (const d of dirents) {
    if (d.name.startsWith('.') || d.name === 'node_modules') continue;
    const full = path.join(dir, d.name);
    if (d.isDirectory()) {
      entries.push({ name: d.name, path: full, dir: true });
    } else if (TEXT_EXT.has(path.extname(d.name).toLowerCase())) {
      try {
        const f = await fsp.stat(full);
        entries.push({ name: d.name, path: full, dir: false, size: f.size, mtime: f.mtimeMs });
      } catch { /* 读不到就跳过 */ }
    }
  }
  entries.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name, 'zh') : (a.dir ? -1 : 1)));

  const up = path.dirname(dir);
  sendJson(res, 200, {
    dir,
    root: DOC_ROOT,
    parent: insideRoot(up) && up !== dir ? up : null,
    entries
  });
}

async function apiRead(res, body) {
  const abs = insideRoot(body.path || '');
  if (!abs) return sendJson(res, 403, { error: '路径不在允许范围内' });
  let text, st;
  try {
    st = await fsp.stat(abs);
    text = await fsp.readFile(abs, 'utf8');
  } catch (e) {
    return sendJson(res, 404, { error: '读取失败：' + e.message });
  }
  if (!st.isFile()) return sendJson(res, 400, { error: '不是文件：' + abs });
  sendJson(res, 200, {
    path: abs,
    rel: path.relative(DOC_ROOT, abs),
    text,
    size: st.size,
    mtime: st.mtimeMs
  });
}

async function apiSave(res, body) {
  const abs = insideRoot(body.path || '');
  if (!abs) return sendJson(res, 403, { error: '路径不在允许范围内' });
  if (typeof body.text !== 'string') return sendJson(res, 400, { error: '缺少 text 字段' });
  if (!TEXT_EXT.has(path.extname(abs).toLowerCase())) {
    return sendJson(res, 400, { error: '只允许写入 .md / .mmd / .txt 等文本文件' });
  }
  try {
    const st = await fsp.stat(abs).catch(() => null);
    if (st && !st.isFile()) return sendJson(res, 400, { error: '目标不是文件：' + abs });
    if (!st && !fs.existsSync(path.dirname(abs))) {
      return sendJson(res, 400, { error: '目录不存在：' + path.dirname(abs) });
    }
    await fsp.writeFile(abs, body.text, 'utf8');
    const after = await fsp.stat(abs);
    console.log('[save] ' + path.relative(DOC_ROOT, abs) + '  ' + after.size + 'B');
    sendJson(res, 200, {
      path: abs,
      rel: path.relative(DOC_ROOT, abs),
      size: after.size,
      mtime: after.mtimeMs
    });
  } catch (e) {
    sendJson(res, 500, { error: '写入失败：' + e.message });
  }
}

/* ---------- 静态文件 ---------- */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.md': 'text/markdown; charset=utf-8',
  '.mmd': 'text/plain; charset=utf-8'
};

function serveStatic(req, res, rel) {
  const file = path.join(EDITOR_DIR, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(EDITOR_DIR)) { res.writeHead(403); return res.end('forbidden'); }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('404 ' + rel); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' });
    res.end(buf);
  });
}

/* ---------- 路由 ---------- */

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const host = (req.headers.host || '').replace(/:\d+$/, '');
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(host)) {
    return sendText(res, 403, 'forbidden host');
  }

  const p = url.pathname;
  try {
    if (p === '/api/list') return await apiList(res, url);
    if (p === '/api/read' && req.method === 'POST') return await apiRead(res, await readBody(req));
    if (p === '/api/save' && req.method === 'POST') return await apiSave(res, await readBody(req));
    if (p === '/api/root') return sendJson(res, 200, { root: DOC_ROOT, editor: EDITOR_DIR });
    if (p.startsWith('/api/')) return sendJson(res, 404, { error: '未知接口 ' + p });
    return serveStatic(req, res, p === '/' ? '/index.html' : decodeURIComponent(p));
  } catch (e) {
    if (!res.headersSent) sendJson(res, 500, { error: e.message });
    else res.end();
  }
});

server.on('error', err => {
  if (err.code === 'EADDRINUSE') {
    console.error('端口 ' + PORT + ' 已被占用。改用其它端口：node serve.js 8788');
    process.exit(1);
  }
  throw err;
});

server.listen(PORT, '127.0.0.1', () => {
  let url = 'http://127.0.0.1:' + PORT + '/';
  if (OPEN_ARG) {
    const abs = path.resolve(OPEN_ARG);
    url += '?file=' + encodeURIComponent(abs);
    console.log('待打开文件: ' + abs);
  }
  console.log('Mermaid 本地编辑器: ' + url);
  console.log('文档根目录: ' + DOC_ROOT);
  console.log('按 Ctrl+C 停止');
  require('child_process').spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
});
