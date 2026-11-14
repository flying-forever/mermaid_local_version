'use strict';
// 停止本地服务
// 用法: node stop.js [端口，默认 8787] [--force]
//
// 先走正常路径（POST /api/shutdown）。如果端口上跑的是**升级前**起的旧进程
// （没有 /api/shutdown），就按端口找到它、确认是 node 起的编辑器服务，再强制结束。
// 只有确实认出是本编辑器的旧服务才会动手，别的程序一律不碰。

const { execFileSync } = require('child_process');

const PORT = Number(process.argv[2] || 8787);

async function ping() {
  try {
    const r = await fetch('http://127.0.0.1:' + PORT + '/api/ping', { signal: AbortSignal.timeout(1500) });
    const j = await r.json().catch(() => null);
    return { status: r.status, json: j };
  } catch { return null; }
}

async function getHome() {
  try {
    const r = await fetch('http://127.0.0.1:' + PORT + '/', { signal: AbortSignal.timeout(2000) });
    return { status: r.status, body: await r.text().catch(() => '') };
  } catch { return null; }
}

async function shutdown() {
  try {
    const r = await fetch('http://127.0.0.1:' + PORT + '/api/shutdown', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'http://127.0.0.1:' + PORT },
      body: '{}',
      signal: AbortSignal.timeout(3000)
    });
    const j = await r.json().catch(() => ({}));
    return { status: r.status, json: j };
  } catch { return null; }
}

// netstat -ano 里找监听该端口的 pid（Windows）；其它平台退回 lsof
function pidOnPort() {
  try {
    if (process.platform === 'win32') {
      const out = execFileSync('netstat', ['-ano'], { encoding: 'utf8', windowsHide: true });
      for (const line of out.split(/\r?\n/)) {
        if (!/LISTENING/i.test(line)) continue;
        const cols = line.trim().split(/\s+/);
        if (cols[1] && cols[1].endsWith(':' + PORT)) {
          const pid = Number(cols[cols.length - 1]);
          if (pid > 0) return pid;
        }
      }
      return null;
    }
    const out = execFileSync('lsof', ['-ti', 'tcp:' + PORT, '-sTCP:LISTEN'], { encoding: 'utf8' });
    const pid = Number(out.trim().split(/\s+/)[0]);
    return pid > 0 ? pid : null;
  } catch { return null; }
}

function processName(pid) {
  try {
    if (process.platform === 'win32') {
      const out = execFileSync('tasklist', ['/FI', 'PID eq ' + pid, '/NH', '/FO', 'CSV'],
        { encoding: 'utf8', windowsHide: true });
      const m = out.match(/^"([^"]+)"/m);
      return m ? m[1] : '';
    }
    return execFileSync('ps', ['-o', 'comm=', '-p', String(pid)], { encoding: 'utf8' }).trim();
  } catch { return ''; }
}

function killPid(pid) {
  try {
    if (process.platform === 'win32') {
      execFileSync('taskkill', ['/F', '/PID', String(pid)], { stdio: 'ignore', windowsHide: true });
    } else {
      process.kill(pid, 'SIGTERM');
    }
    return true;
  } catch { return false; }
}

(async () => {
  const p = await ping();

  // 1. 新版服务：走优雅停止
  if (p && p.status === 200 && p.json && p.json.ok) {
    const pid = p.json.pid;
    const s = await shutdown();
    if (s && s.status === 200) {
      console.log('已停止本地服务（端口 ' + PORT + '，pid ' + pid + '）。');
      return process.exit(0);
    }
    console.log('停止请求被拒绝：' + ((s && s.json && s.json.error) || '未知原因'));
    console.log('可以手动结束它：taskkill /F /PID ' + pid);
    return process.exit(1);
  }

  // 2. 端口上没东西
  const home = await getHome();
  if (!home) {
    console.log('端口 ' + PORT + ' 上没有在运行的编辑器服务。');
    return process.exit(0);
  }

  // 3. 有 HTTP 服务但认不出 /api/ping：确认是不是本编辑器的旧版本
  const isEditor = home.status === 200 && home.body.includes('Mermaid 本地编辑器');
  if (!isEditor) {
    console.log('端口 ' + PORT + ' 被别的程序占用，不是本编辑器服务，不动它。');
    console.log('换端口启动：把 启动.cmd 里的 ' + PORT + ' 改成 8788。');
    return process.exit(1);
  }

  const pid = pidOnPort();
  if (!pid) {
    console.log('端口 ' + PORT + ' 上是本编辑器的旧版本服务，但没找到它的进程号。');
    console.log('请关掉那个命令行窗口。');
    return process.exit(1);
  }
  const name = processName(pid);
  if (!/^node(\.exe)?$/i.test(name)) {
    console.log('端口 ' + PORT + ' 上的进程是 ' + (name || '未知') + '（pid ' + pid + '），不是 node，不动它。');
    return process.exit(1);
  }
  if (killPid(pid)) {
    console.log('端口 ' + PORT + ' 上是旧版本的编辑器服务（pid ' + pid + '，没有 /api/shutdown），已结束它。');
    console.log('重新双击 启动.cmd 即可用上新版本。');
    return process.exit(0);
  }
  console.log('结束 pid ' + pid + ' 失败，可能权限不够：用管理员身份重试，或直接关掉它的命令行窗口。');
  process.exit(1);
})();
