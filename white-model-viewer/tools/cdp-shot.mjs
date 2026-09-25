/* CDP 无头截图脚本：启动本机 Chrome，打开页面，等待渲染后截图并保存。
 * 用法1（单张，兼容旧用法）: node tools/cdp-shot.mjs <url> <输出png> [等待秒数]
 * 用法2（批量）: node tools/cdp-shot.mjs <url> <输出目录> [等待秒数] [--views=v1,v2|all] [--channels=color,depth,normal]
 *   批量模式循环 视角 × 通道，输出 <视角>-<通道>.png 与 manifest.json（含相机参数，便于跨版本比对）。
 *   批量模式依赖页面暴露的 window.WMShot 接口；不要与 ?static=1 同用（static 模式渲染 8 帧后停帧）。
 *   --pre="<表达式>" / --eval="<表达式>"：截图前 / 截图后在页面里求值并打印（如 --eval="WMShot.siteCheck()"）。
 * 依赖: 本机安装的 Chrome / Edge；Node 22+（使用内置 WebSocket）。
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, existsSync, mkdirSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const argv = process.argv.slice(2);
const url = argv[0];
const outPath = argv[1];
const waitSec = argv.find((a, i) => i >= 2 && !a.startsWith('--'));
const flags = argv.filter(a => a.startsWith('--'));
function flagVal(name) {
  const f = flags.find(f => f === '--' + name || f.startsWith('--' + name + '='));
  if (!f) return null;
  const eq = f.indexOf('=');
  return eq >= 0 ? f.slice(eq + 1) : true;
}
if (!url || !outPath) {
  console.error('用法: node cdp-shot.mjs <url> <输出png|输出目录> [等待秒数] [--views=v1,v2|all] [--channels=color,depth,normal]');
  process.exit(1);
}
const waitMs = (waitSec ? parseFloat(waitSec) : 8) * 1000;
const batch = flagVal('views') !== null || flagVal('channels') !== null || !/\.png$/i.test(outPath);
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
    expression: `JSON.stringify({ title: document.title, stats: (window.WMShot && WMShot.stats ? WMShot.stats() : ''), canvas: !!document.querySelector('canvas') })`,
    returnByValue: true,
  });
  console.log('页面状态:', evalRes.result.value);

  async function evalBool(expression) {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true });
    return r && r.result ? r.result.value : undefined;
  }

  async function waitBuilt() {
    for (let i = 0; i < 40; i++) {
      if (await evalBool('!!(window.WMShot && window.WMShot.built && window.WMShot.built())')) return true;
      await sleep(500);
    }
    return false;
  }

  async function runExpr(expr, label) {
    const r = await send('Runtime.evaluate', { expression: String(expr), returnByValue: true, awaitPromise: true });
    console.log(label + ':', JSON.stringify(r.result ? r.result.value : r, null, 2));
  }

  /* --pre：截图/批量前求值（例如先 WMShot.cam(...) 摆机位） */
  const preExpr = flagVal('pre');
  if (preExpr) {
    await waitBuilt();
    await runExpr(preExpr, 'pre 结果');
    await sleep(600);
  }

  async function runBatch() {
    for (let i = 0; i < 40; i++) {
      if (await evalBool('!!(window.WMShot && window.WMShot.built && window.WMShot.built())')) break;
      await sleep(500);
    }
    const ready = await evalBool('!!(window.WMShot && window.WMShot.built && window.WMShot.built())');
    if (!ready) throw new Error('页面模型未构建完成（window.WMShot.built() 为 false），请检查 URL 与 JSON');

    const allViews = JSON.parse(
      (await send('Runtime.evaluate', { expression: 'JSON.stringify(window.WMShot.views())', returnByValue: true })).result.value);
    const vRaw = flagVal('views');
    const vSel = (vRaw === null || vRaw === true) ? 'all' : String(vRaw);
    const views = (vSel === 'all') ? allViews : vSel.split(',').map(s => s.trim()).filter(Boolean);
    const cRaw = flagVal('channels');
    const channels = String(cRaw === true || cRaw === null ? 'color' : cRaw)
      .split(',').map(s => s.trim()).filter(Boolean);
    const outDir = resolve(outPath);
    mkdirSync(outDir, { recursive: true });

    const manifest = { url, generatedAt: new Date().toISOString(), views: [] };
    for (const v of views) {
      const ok = await evalBool(`window.WMShot.view(${JSON.stringify(v)})`);
      if (ok !== true) { console.error('未知视角，已跳过:', v); continue; }
      await sleep(600);   /* 等 OrbitControls 收敛、渲染稳定 */
      const info = JSON.parse(
        (await send('Runtime.evaluate', { expression: 'window.WMShot.info()', returnByValue: true })).result.value);
      const files = [];
      for (const c of channels) {
        await evalBool(`window.WMShot.channel(${JSON.stringify(c)})`);
        await sleep(300);
        const shot = await send('Page.captureScreenshot', { format: 'png', fromSurface: true });
        const name = `${v}-${c}.png`;
        writeFileSync(join(outDir, name), Buffer.from(shot.data, 'base64'));
        files.push(name);
        console.log('截图已保存:', join(outDir, name));
      }
      manifest.views.push({ name: v, camera: info.camera, bounds: info.bounds, files });
      await evalBool("window.WMShot.channel('color')");
      await sleep(150);
    }
    writeFileSync(join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
    console.log(`批量出图完成：${manifest.views.length} 视角 × ${channels.length} 通道 → ${outDir}`);
  }

  if (batch) {
    await runBatch();
  } else {
    const shot = await send('Page.captureScreenshot', { format: 'png', fromSurface: true });
    const out = resolve(outPath);
    writeFileSync(out, Buffer.from(shot.data, 'base64'));
    console.log('截图已保存:', out);
  }

  /* --eval="<表达式>"：在页面里跑一段 JS 并打印返回值（自检用，如 WMShot.siteCheck()） */
  const evalExpr = flagVal('eval');
  if (evalExpr) {
    await waitBuilt();
    await runExpr(evalExpr, 'eval 结果');
  }
  ws.close();
} catch (e) {
  console.error('失败:', e.message);
  process.exitCode = 1;
} finally {
  chrome.kill();
  await sleep(500);
  try { rmSync(profile, { recursive: true, force: true }); } catch { /* 忽略 */ }
}
