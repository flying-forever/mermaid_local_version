'use strict';
// 停止本地服务：POST /api/shutdown 到指定端口
// 用法: node stop.js [端口，默认 8787]

const PORT = Number(process.argv[2] || 8787);

(async () => {
  try {
    const res = await fetch('http://127.0.0.1:' + PORT + '/api/shutdown', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
      signal: AbortSignal.timeout(3000)
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok) console.log('已通知服务停止（端口 ' + PORT + '）。');
    else console.log('停止失败：' + (data.error || ('HTTP ' + res.status)));
  } catch {
    console.log('端口 ' + PORT + ' 上没有在运行的编辑器服务。');
  }
  // 等它真的退出，再报告
  await new Promise(r => setTimeout(r, 700));
  process.exit(0);
})();
