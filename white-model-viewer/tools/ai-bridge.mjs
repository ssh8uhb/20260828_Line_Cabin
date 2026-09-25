#!/usr/bin/env node
/* AI 出图本地桥：给 file:// 打开的查看器页面提供「页面内截图 → 百炼出图」的转发服务。
 *
 * 为什么需要它：file:// 页面的 origin 是 null，浏览器直连 dashscope.aliyuncs.com 会被 CORS 拦下；
 * 而且 API key 只能留在 Node 侧（不进页面、不进 localStorage、不回给前端）。桥只绑 127.0.0.1。
 *
 * 用法：
 *   $env:DASHSCOPE_API_KEY="sk-xxx"; node tools/ai-bridge.mjs [--port=8787] [--out=DIR]
 *        [--model=] [--mock] [--max-calls=12] [--help]
 *   页面里打开「AI 效果图」面板即可：未检测到桥时按钮置灰。
 *
 * 路由（全部只服务本机页面）：
 *   GET  /health                → { ok: true }
 *   GET  /ai-render/config      → 配置 + keyPresent（**不含 key**）
 *   POST /ai-render             → 页面截图 + 提示词 → 出图落盘 → 返回结果图 URL
 *   GET  /ai-render/image/<id>  → 结果图 PNG（id 由本进程签发，不接受路径）
 * 默认值取自 data/ai-render.json；--mock 用本地假接口，零成本跑通整条链路。
 */
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  assemblePrompt, buildSyncRequest, callSync, capsFor, checkInputImage, classifyError, downloadTo,
  hashOf, imageToDataUrl, MAX_IMAGE_BYTES, MODEL_CAPS, parseAspectFlag, readImageSize, resolveSize,
  sizeForRatio, sleep, sniffMime, startMockProvider,
} from './ai/dashscope.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const VIEWER_DIR = resolve(HERE, '..');
const CONFIG_PATH = join(VIEWER_DIR, 'data', 'ai-render.json');

/* ---------- 参数 ---------- */
const argv = process.argv.slice(2);
const flags = argv.filter(a => a.startsWith('--'));
function flagVal(name) {
  const f = flags.find(f => f === '--' + name || f.startsWith('--' + name + '='));
  if (!f) return null;
  const eq = f.indexOf('=');
  return eq >= 0 ? f.slice(eq + 1) : true;
}
const has = name => flagVal(name) !== null;

if (has('help')) {
  console.log(readFileSync(import.meta.url, 'utf8').split('*/')[0].replace(/^#![^\n]*\n/, ''));
  process.exit(0);
}
if (!existsSync(CONFIG_PATH)) { console.error(`未找到配置 ${CONFIG_PATH}`); process.exit(1); }
const pages = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
for (const [flag, key] of [['model', 'model'], ['base-url', 'baseUrl'], ['endpoint', 'endpoint']]) {
  const v = flagVal(flag);
  if (v !== null && v !== true) pages[key] = String(v);
}
const mockOn = has('mock');
const host = String((flagVal('host') && flagVal('host') !== true) ? flagVal('host') : (pages.bridge && pages.bridge.host) || '127.0.0.1');
const port = Number((flagVal('port') && flagVal('port') !== true) ? flagVal('port') : (pages.bridge && pages.bridge.port) || 8787);
const maxCalls = Number((flagVal('max-calls') && flagVal('max-calls') !== true) ? flagVal('max-calls') : 12);

function stamp() {
  const d = new Date(), p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
const outRoot = resolve((flagVal('out') && flagVal('out') !== true) ? String(flagVal('out')) : join(VIEWER_DIR, 'out'));
const runDir = join(outRoot, 'page-' + stamp());
const whiteDir = join(runDir, 'white');
const requestDir = join(runDir, 'request');
const aiDir = join(runDir, 'ai');

/* ---------- key：只从环境变量读 ---------- */
let apiKey = '';
if (mockOn) apiKey = 'mock-key';
else {
  const envName = String((flagVal('key-env') && flagVal('key-env') !== true) ? flagVal('key-env') : (pages.apiKeyEnv || 'DASHSCOPE_API_KEY'));
  apiKey = process.env[envName] || '';
  if (!apiKey) {
    console.error(`未找到 API key：请设置环境变量 ${envName} 后重启桥。`);
    console.error('PowerShell:  $env:' + envName + '="sk-xxxx"; node tools/ai-bridge.mjs');
    process.exit(1);
  }
}
const keyPresent = !!apiKey;
const caps = capsFor(pages.model);

/* ---------- 会话记录 ---------- */
const run = {
  version: pages.version || 1,
  provider: pages.provider || 'dashscope',
  baseUrl: pages.baseUrl, endpoint: pages.endpoint, model: pages.model,
  source: 'page', outDir: runDir,
  generatedAt: new Date().toISOString(), finishedAt: null,
  dryRun: false, mock: mockOn,
  params: { channels: pages.channels || ['color'], size: null, n: pages.n ?? 1, seed: pages.seed ?? null,
    promptExtend: pages.promptExtend, watermark: pages.watermark },
  prompt: { source: 'page', default: pages.prompt, perViewSent: {} },
  shots: { dir: whiteDir, source: 'page-canvas' },
  items: [],
  summary: { requested: 0, ok: 0, failed: 0, paidCalls: 0 },
};
let runStarted = false;
function writeRun() {
  if (!runStarted) return;
  writeFileSync(join(runDir, 'run.json'), JSON.stringify(run, null, 2), 'utf8');
}
function startRun(payload) {
  if (runStarted) return;
  mkdirSync(whiteDir, { recursive: true });
  mkdirSync(requestDir, { recursive: true });
  mkdirSync(aiDir, { recursive: true });
  run.page = {
    url: (payload.doc && payload.doc.href) || null,
    title: (payload.doc && payload.doc.title) || null,
    drawing: (payload.doc && (payload.doc.name || payload.doc.drawing)) || null,
  };
  runStarted = true;
  writeRun();
}

/* ---------- 结果图登记表（只服务本进程写过的文件） ---------- */
const images = new Map();   // id -> { file, mime }

/* ---------- 出图 ---------- */
class HttpError extends Error {
  constructor(status, code, message, extra) { super(message); this.status = status; this.code = code; this.extra = extra || {}; }
}

async function render(payload) {
  if (run.summary.paidCalls >= maxCalls && !mockOn) {
    throw new HttpError(429, 'E_MAX_CALLS', `本次桥会话已发起 ${run.summary.paidCalls} 次付费调用（上限 ${maxCalls}），请重启桥或调大 --max-calls`);
  }
  const view = String(payload.view || '').trim();
  if (!view) throw new HttpError(400, 'E_NO_VIEW', '缺少 view（渲染视角名）');
  const rawChannels = (Array.isArray(payload.channels) && payload.channels.length) ? payload.channels : (pages.channels || ['color']);
  const channels = rawChannels.map(String).filter(c => ['color', 'depth', 'normal'].indexOf(c) >= 0);
  if (!channels.length) throw new HttpError(400, 'E_NO_CHANNEL', '至少需要 1 个条件图通道（color / depth / normal）');
  if (channels.length > caps.maxImages) throw new HttpError(400, 'E_TOO_MANY_IMAGES', `模型 ${pages.model} 最多接受 ${caps.maxImages} 张条件图，当前 ${channels.length} 张`);

  startRun(payload);

  /* 1) 条件图：页面给的是 data URL，解码后校验大小/边长，再统一按 PNG/JPEG 原样回填请求 */
  const imgs = [];
  for (const c of channels) {
    const dataUrl = payload.images && payload.images[c];
    if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:')) throw new HttpError(400, 'E_NO_IMAGE', `缺少通道 ${c} 的截图（页面未送出或通道名为空）`);
    const comma = dataUrl.indexOf(',');
    const mime = dataUrl.slice(5, dataUrl.indexOf(';', 5));
    const buf = Buffer.from(dataUrl.slice(comma + 1), 'base64');
    if (!buf.length) throw new HttpError(400, 'E_EMPTY_IMAGE', `通道 ${c} 的截图是空图`);
    if (buf.length > MAX_IMAGE_BYTES) throw new HttpError(413, 'E_IMAGE_TOO_LARGE', `通道 ${c} 的截图 ${(buf.length / 1048576).toFixed(2)} MB 超过单图 10 MB 上限`);
    if (!sniffMime(buf)) throw new HttpError(415, 'E_IMAGE_FORMAT', `通道 ${c} 的截图不是支持的图片格式（收到 ${mime}）`);
    const size = readImageSize(buf);
    const file = `${view}-${c}.png`;
    writeFileSync(join(whiteDir, file), buf);
    imgs.push({ role: c, file, bytes: buf.length, sha256: hashOf(buf), size, dataUrl: imageToDataUrl(buf) });
  }
  const primary = imgs.find(i => i.role === 'color') || imgs[0];
  for (const i of imgs) for (const w of checkInputImage(i.size)) console.warn(`[ai-bridge] 警告（${i.file}）：${w}`);

  /* 2) 提示词 + 尺寸 */
  const ar = parseAspectFlag(payload.prompt === undefined || payload.prompt === null ? pages.prompt : payload.prompt);
  let sizeSpec = payload.size || pages.size;
  if ((sizeSpec === 'auto' || !sizeSpec) && ar.ratio) {
    const s = sizeForRatio(ar.ratio.w, ar.ratio.h, caps);
    if (s) sizeSpec = s; else console.warn(`[ai-bridge] 警告：提示词里的 ${ar.raw} 换算不出合法输出尺寸，已忽略`);
  }
  const size = resolveSize(sizeSpec || 'auto', pages.model, primary.size);
  const roles = imgs.map(i => (pages.imageRoles && pages.imageRoles[i.role]) || i.role);
  const prompt = assemblePrompt({ prompt: ar.prompt, suffix: pages.promptSuffix, roles, hint: String(payload.hint || '') });
  const n = caps.acceptsN ? Number(payload.n || pages.n || 1) : undefined;

  const body = buildSyncRequest({
    model: pages.model, prompt, images: imgs, size, n,
    negativePrompt: payload.negativePrompt === undefined ? pages.negativePrompt : payload.negativePrompt,
    promptExtend: pages.promptExtend, watermark: pages.watermark, seed: pages.seed,
  });

  const item = {
    view, label: payload.label || null, hint: payload.hint || null,
    conditioning: imgs.map(i => ({ file: i.file, role: i.role, bytes: i.bytes, sha256: i.sha256, size: i.size })),
    requestId: null, promptSent: prompt, ok: false, durationMs: 0, outputs: [], error: null,
  };
  run.params.size = size;
  run.prompt.perViewSent[view] = prompt;
  run.summary.requested++;
  const record = JSON.parse(JSON.stringify(body));
  let k = 0;
  for (const c of record.input.messages[0].content) {
    if (!c.image) continue;
    const m = imgs[k++];
    c.image = { file: m.file, role: m.role, bytes: m.bytes, sha256: m.sha256, size: m.size, dataUrlChars: m.dataUrl.length };
  }
  record.__note = '此文件是实际请求体的记录（图片 base64 已替换为文件指纹），可直接用于复现；不含 API key。';
  writeFileSync(join(requestDir, `${view}.json`), JSON.stringify(record, null, 2), 'utf8');

  /* 3) 调用（付费）+ 下载 */
  console.log(`[ai-bridge] ${view} → ${pages.baseUrl}｜条件图 ${imgs.map(i => i.role).join('+')}｜size ${size || '(模型默认)'}｜n ${n ?? '(模型默认)'}`);
  const t0 = Date.now();
  let res = await callSync({ baseUrl: pages.baseUrl, endpoint: pages.endpoint, apiKey, body, timeoutSec: pages.timeoutSec ?? 180 });
  item.requestId = res.requestId;
  if (!res.ok && (pages.retries ?? 1) > 0 && !res.timeout) {
    const cls = classifyError(res.httpStatus, res.body, { apiKeyEnv: pages.apiKeyEnv, model: pages.model });
    if (cls.retryable) {
      console.warn(`[ai-bridge] ${view} 失败（${cls.code}），3s 后重试一次…`);
      await sleep(3000);
      res = await callSync({ baseUrl: pages.baseUrl, endpoint: pages.endpoint, apiKey, body, timeoutSec: pages.timeoutSec ?? 180 });
      item.requestId = item.requestId || res.requestId;
    }
  }
  item.durationMs = Date.now() - t0;
  if (!res.ok) {
    const cls = classifyError(res.httpStatus, res.body, { apiKeyEnv: pages.apiKeyEnv, model: pages.model });
    item.error = { code: cls.code, httpStatus: res.httpStatus, message: res.rawError, hint: cls.hint || null };
    run.items.push(item); run.summary.failed++; writeRun();
    console.error(`[ai-bridge] ${view} 失败：${cls.code}｜${res.rawError}`);
    throw new HttpError(cls.fatal ? 502 : 503, cls.code, res.rawError, { hint: cls.hint, retryable: cls.retryable, requestId: item.requestId });
  }
  run.summary.paidCalls++;

  let out = null, deviation = null;
  const url = res.imageUrls[0];
  const file = `${view}-ai.png`;
  try {
    const dl = await downloadTo(url, join(aiDir, file), { timeoutSec: 120, retries: 2 });
    const sz = readImageSize(dl.buf);
    deviation = sz && primary.size
      ? Math.abs((sz.width / sz.height) / (primary.size.width / primary.size.height) - 1) : null;
    out = { file, bytes: dl.bytes, sha256: dl.sha256, size: sz, sourceUrl: url, aspectDeviation: deviation };
    item.outputs.push(out);
    item.ok = true;
    run.summary.ok++;
  } catch (e) {
    item.error = { code: 'DOWNLOAD_FAILED', message: e.message, hint: '结果 URL 24 小时有效，可手动下载后重试', sourceUrl: url };
    run.items.push(item); run.summary.failed++; writeRun();
    throw new HttpError(502, 'DOWNLOAD_FAILED', e.message, { sourceUrl: url });
  }
  run.items.push(item);
  writeRun();

  const id = randomBytes(9).toString('hex');
  images.set(id, { file: join(aiDir, file), mime: 'image/png' });
  console.log(`[ai-bridge] ${view} 完成：${join(aiDir, file)}（${out.size ? out.size.width + '×' + out.size.height : '尺寸未知'}，长宽比偏差 ${deviation === null ? '—' : (deviation * 100).toFixed(1) + '%'}）｜累计付费 ${run.summary.paidCalls} 次`);
  return {
    ok: true, view, requestId: item.requestId, durationMs: item.durationMs,
    imageId: id, url: `/ai-render/image/${id}`, file: join(aiDir, file),
    size: out.size, bytes: out.bytes, sha256: out.sha256, aspectDeviation: out.aspectDeviation,
    promptSent: prompt, dir: runDir, callsUsed: run.summary.paidCalls, maxCalls,
  };
}

/* ---------- HTTP ---------- */
function sendJson(res, status, obj) {
  const buf = Buffer.from(JSON.stringify(obj), 'utf8');
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': buf.length });
  res.end(buf);
}
function readBody(req, limit = 48 * 1024 * 1024) {
  return new Promise((ok, bad) => {
    let size = 0; const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > limit) { bad(new HttpError(413, 'E_BODY_TOO_LARGE', `请求体超过 ${(limit / 1048576) | 0} MB`)); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => ok(Buffer.concat(chunks).toString('utf8')));
    req.on('error', bad);
  });
}

let busy = false;
const server = createServer(async (req, res) => {
  /* file:// 页面的 origin 是 null：放开 CORS，并允许「本地网络访问」预检（Chrome PNA） */
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Private-Network', 'true');
  const url = new URL(req.url, 'http://' + host);
  const path = url.pathname;

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  try {
    if (req.method === 'GET' && path === '/health') return sendJson(res, 200, { ok: true, model: pages.model, mock: mockOn });

    if (req.method === 'GET' && path === '/ai-render/config') {
      return sendJson(res, 200, {
        ok: true,
        version: pages.version || 1,
        provider: pages.provider || 'dashscope',
        baseUrl: pages.baseUrl, endpoint: pages.endpoint, model: pages.model,
        models: Object.keys(MODEL_CAPS),
        apiKeyEnv: pages.apiKeyEnv || 'DASHSCOPE_API_KEY',
        keyPresent, mock: mockOn,
        caps: { maxImages: caps.maxImages, maxSide: caps.maxSide, minSide: caps.minSide, acceptsSize: caps.acceptsSize, acceptsN: caps.acceptsN },
        captureSize: pages.captureSize || '1600*900',
        channels: pages.channels || ['color'],
        imageRoles: pages.imageRoles || {}, viewHints: pages.viewHints || {}, viewLabels: pages.viewLabels || {},
        prompt: pages.prompt || '', promptSuffix: pages.promptSuffix || '', negativePrompt: pages.negativePrompt || '',
        size: pages.size || 'auto', n: pages.n ?? 1, promptExtend: pages.promptExtend, watermark: pages.watermark,
        maxCalls, callsUsed: run.summary.paidCalls, callsOk: run.summary.ok, outRoot, dir: runStarted ? runDir : null,
      });
    }

    if (req.method === 'GET' && path.startsWith('/ai-render/image/')) {
      const id = path.slice('/ai-render/image/'.length);
      const hit = images.get(id);
      if (!hit || !existsSync(hit.file)) return sendJson(res, 404, { ok: false, code: 'E_NO_IMAGE', message: '结果图不存在或已过期（重启桥后需重新出图）' });
      const buf = readFileSync(hit.file);
      res.writeHead(200, { 'Content-Type': hit.mime, 'Content-Length': buf.length, 'Cache-Control': 'no-store' });
      return res.end(buf);
    }

    if (req.method === 'POST' && path === '/ai-render') {
      if (busy) return sendJson(res, 409, { ok: false, code: 'E_BUSY', message: '已有出图任务在进行中，请等它结束' });
      let payload;
      try { payload = JSON.parse(await readBody(req)); }
      catch (e) { return sendJson(res, e.status || 400, { ok: false, code: e.code || 'E_BAD_JSON', message: e.message }); }
      busy = true;
      try {
        const out = await render(payload);
        return sendJson(res, 200, out);
      } catch (e) {
        if (e instanceof HttpError) return sendJson(res, e.status, { ok: false, code: e.code, message: e.message, ...e.extra });
        console.error('[ai-bridge] 内部错误：', e);
        return sendJson(res, 500, { ok: false, code: 'E_INTERNAL', message: String(e && e.message || e) });
      } finally { busy = false; }
    }

    sendJson(res, 404, { ok: false, code: 'E_NOT_FOUND', message: `未知路由 ${req.method} ${path}` });
  } catch (e) {
    console.error('[ai-bridge] 请求处理失败：', e);
    sendJson(res, 500, { ok: false, code: 'E_INTERNAL', message: String(e && e.message || e) });
  }
});

let mockSrv = null;
if (mockOn) {
  mockSrv = await startMockProvider({ status: 200 });
  pages.baseUrl = mockSrv.baseUrl;
  run.baseUrl = mockSrv.baseUrl;
}
server.listen(port, host, () => {
  const viewer = pathToFileURL(join(VIEWER_DIR, pages.page || 'index.html')).href + (pages.query ? '?' + pages.query : '');
  console.log(`[ai-bridge] 就绪：http://${host}:${port} ｜ 模型 ${pages.model} ｜ key ${mockOn ? '不需要（--mock）' : keyPresent ? '已就绪' : '缺失'}${mockOn ? ' ｜ --mock（零成本假接口 ' + pages.baseUrl + '）' : ''}`);
  console.log(`[ai-bridge] 付费上限：本会话 ${maxCalls} 次（--max-calls=N 可调）｜输出目录：${outRoot}`);
  console.log(`[ai-bridge] 查看器：${viewer}`);
});
server.on('error', e => { console.error('[ai-bridge] 启动失败：' + e.message); process.exit(1); });

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    console.log(`\n[ai-bridge] 退出（出图 ${run.summary.ok} 张，付费调用 ${run.summary.paidCalls} 次）`);
    if (runStarted) { run.finishedAt = new Date().toISOString(); try { writeRun(); } catch { /* 忽略 */ } }
    if (mockSrv) await mockSrv.close();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 500);
  });
}
