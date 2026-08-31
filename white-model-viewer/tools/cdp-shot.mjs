/* CDP 无头截图脚本：启动本机 Chrome，打开页面，等待渲染后截图并保存。
 * 用法: node tools/cdp-shot.mjs <url> <输出png> [等待秒数]
 * 依赖: 本机安装的 Chrome / Edge；Node 22+（使用内置 WebSocket）。
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const [url, outFile, waitSec] = process.argv.slice(2);
if (!url || !outFile) {
  console.error('用法: node cdp-shot.mjs <url> <输出png> [等待秒数]');
  process.exit(1);
}
const waitMs = (waitSec ? parseFloat(waitSec) : 8) * 1000;
const profile = mkdtempSync(join(tmpdir(), 'cdp-shot-'));

const candidates = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
];
const exe = candidates.find(p => {
  try { return existsSync(p); } catch { return false; }
});
if (!exe) { console.error('未找到 Chrome/Edge'); process.exit(1); }

function findFreePort() {
  return new Promise((res, rej) => {
    const srv = createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => res(port));
    });
    srv.on('error', rej);
  });
}

const port = await findFreePort();
const chrome = spawn(exe, [
  '--headless=new', '--no-sandbox', '--disable-gpu', '--enable-unsafe-swiftshader',
  '--window-size=1500,1000', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
  'about:blank',
], { stdio: ['ignore', 'pipe', 'pipe'] });

const actualPort = port;
chrome.on('error', e => console.error('[spawn-error]', e.message));
chrome.on('exit', (code, sig) => console.error('[chrome-exit]', code, sig));

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
async function waitEndpoint() {
  const base = () => `http://127.0.0.1:${actualPort}`;
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`${base()}/json/version`);
      if (r.ok) return;
    } catch { /* retry */ }
    await sleep(250);
  }
  throw new Error('Chrome DevTools 端点未就绪');
}

let msgId = 0;
const pending = new Map();
function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  const ready = new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = () => rej(new Error('WebSocket 连接失败'));
  });
  ws.onmessage = ev => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id);
      pending.delete(m.id);
      m.error ? reject(new Error(m.error.message)) : resolve(m.result);
    }
  };
  function send(method, params = {}) {
    const id = ++msgId;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
  }
  return { ws, ready, send };
}

try {
  await waitEndpoint();
  const list = await (await fetch(`http://127.0.0.1:${actualPort}/json/list`)).json();
  const page = list.find(t => t.type === 'page');
  if (!page) throw new Error('没有可用页面目标');

  const { ws, ready, send } = connect(page.webSocketDebuggerUrl);
  await ready;
  await send('Page.enable');
  await send('Runtime.enable');

  await send('Page.navigate', { url });
  await sleep(waitMs);

  const evalRes = await send('Runtime.evaluate', {
    expression: `JSON.stringify({ title: document.title, stats: (document.getElementById('stats')||{}).innerText || '', canvas: !!document.querySelector('canvas') })`,
    returnByValue: true,
  });
  console.log('页面状态:', evalRes.result.value);

  const shot = await send('Page.captureScreenshot', { format: 'png', fromSurface: true });
  const out = resolve(outFile);
  writeFileSync(out, Buffer.from(shot.data, 'base64'));
  console.log('截图已保存:', out);
  ws.close();
} catch (e) {
  console.error('失败:', e.message);
  process.exitCode = 1;
} finally {
  chrome.kill();
  await sleep(500);
  try { rmSync(profile, { recursive: true, force: true }); } catch { /* 忽略 */ }
}
