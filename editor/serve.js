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
// 页面与本服务之间的接口协议号：/api/ping 会把它报出去，
// 页面据此判断“端口上跑的是不是旧版本”，避免升级后老进程卡住新页面。
const PROTO = 2;

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

/* ---------- 生命周期：停止服务 / 重复启动 ---------- */

// 只接受编辑器页面自己的请求（跨站 POST 送 JSON 本来就会触发预检失败，这里再兜一层）
function sameOrigin(req) {
  const o = req.headers.origin;
  if (!o) return true;                                   // curl / node 直接调用
  return o === 'http://127.0.0.1:' + PORT ||
         o === 'http://localhost:' + PORT ||
         o === 'http://[::1]:' + PORT;
}

function stopServer(code = 0) {
  console.log('[stop] 收到停止请求，服务退出');
  server.close(() => process.exit(code));
  setTimeout(() => process.exit(code), 1000).unref();    // 还有 keep-alive 连接时兜底
}

// 端口被占用时，先弄清占用者是谁：本服务（新版）/ 本服务（旧版）/ 别的东西
function httpGetText(pathname, timeout = 900) {
  return new Promise(resolve => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path: pathname, timeout }, res => {
      let s = '';
      res.on('data', d => (s += d));
      res.on('end', () => resolve({ status: res.statusCode, body: s }));
    });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
  });
}

async function probePort() {
  const ping = await httpGetText('/api/ping');
  if (ping && ping.status === 200) {
    try {
      const j = JSON.parse(ping.body);
      if (j && j.ok) return { kind: 'mine', pid: j.pid, proto: Number(j.proto) || 1, root: j.root };
    } catch { /* 落到下面继续判断 */ }
  }
  // 没有 /api/ping：看看这个端口是不是还在吐本编辑器的老页面
  const home = await httpGetText('/', 1200);
  if (home && home.status === 200 && home.body.includes('Mermaid 本地编辑器')) {
    return { kind: 'legacy', pid: null };
  }
  return { kind: 'other', pid: null };
}

function portHint() {
  return '停掉它：双击 停止.cmd，或 node editor/stop.js ' + PORT + '，或关掉它的命令行窗口。';
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
    if (p === '/api/ping') {
      return sendJson(res, 200, {
        ok: true, name: 'mermaid-local-editor',
        proto: PROTO, pid: process.pid, port: PORT, root: DOC_ROOT
      });
    }
    if (p === '/api/shutdown' && req.method === 'POST') {
      if (!sameOrigin(req)) return sendJson(res, 403, { error: '只接受编辑器页面自己的请求' });
      sendJson(res, 200, { ok: true, message: '服务正在停止' });
      return setTimeout(() => stopServer(0), 150);
    }
    if (p.startsWith('/api/')) return sendJson(res, 404, { error: '未知接口 ' + p });
    return serveStatic(req, res, p === '/' ? '/index.html' : decodeURIComponent(p));
  } catch (e) {
    if (!res.headersSent) sendJson(res, 500, { error: e.message });
    else res.end();
  }
});

function editorUrl() {
  let url = 'http://127.0.0.1:' + PORT + '/';
  if (OPEN_ARG) url += '?file=' + encodeURIComponent(path.resolve(OPEN_ARG));
  return url;
}

function openPage(url) {
  if (process.env.MMD_NO_OPEN) return;          // 无界面环境/测试用：只起服务不拉浏览器
  require('child_process')
    .spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' })
    .unref();
}

server.on('error', async err => {
  if (err.code === 'EADDRINUSE') {
    const info = await probePort();
    if (info.kind === 'mine' && info.proto >= PROTO) {
      // 重复双击了 启动.cmd：确认是老朋友就直接打开它，不报错
      console.log('端口 ' + PORT + ' 上已经有编辑器服务在运行（pid ' + info.pid + '），直接打开它。');
      console.log('要停掉它：页面右上角「停止服务」，或双击 停止.cmd');
      openPage(editorUrl());
      return setTimeout(() => process.exit(0), 500);
    }
    if (info.kind === 'mine') {
      console.error('端口 ' + PORT + ' 上的编辑器服务是旧版本（接口协议 ' + info.proto +
        '，当前需要 ' + PROTO + '，pid ' + info.pid + '）。');
      console.error(portHint());
      return process.exit(1);
    }
    if (info.kind === 'legacy') {
      console.error('端口 ' + PORT + ' 上跑的是旧版本的编辑器服务（没有 /api/ping，是升级前起的进程）。');
      console.error(portHint());
      return process.exit(1);
    }
    console.error('端口 ' + PORT + ' 被其它程序占用了。换一个端口：把 启动.cmd 里的 8787 改成 8788，');
    console.error('或手动：node editor/serve.js 8788');
    process.exit(1);
    return;
  }
  throw err;
});

server.listen(PORT, '127.0.0.1', () => {
  const url = editorUrl();
  if (OPEN_ARG) console.log('待打开文件: ' + path.resolve(OPEN_ARG));
  console.log('Mermaid 本地编辑器: ' + url);
  console.log('文档根目录: ' + DOC_ROOT);
  console.log('停止：页面右上角「停止服务」，或双击 停止.cmd，或 Ctrl+C');
  openPage(url);
});
