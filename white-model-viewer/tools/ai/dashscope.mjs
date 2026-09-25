/* 阿里云百炼（DashScope）图像生成 / 编辑调用层。
 * 与环境无关：CLI（tools/ai-render.mjs）、页面本地桥（Electron 主进程）都 import 这一份。
 * 只实现同步路径（Qwen-Image 系列：1~3 张参考图 + 提示词 → 一张图，结果为 24 小时有效的公网 URL）。
 * 异步路径（万相 wanx2.1-imageedit，提交任务 + 轮询）仅留接口位，未实现。
 * 零依赖：只用 Node 内置 fetch / crypto / fs。
 */
import { writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';

/* ---------- 模型能力表（决定 size / n 是否可传、最多几张参考图） ---------- */

export const MODEL_CAPS = {
  'qwen-image-3.0': { acceptsSize: true, acceptsN: true, maxImages: 3, maxSide: 2048, minSide: 512 },
  'qwen-image-3.0-pro': { acceptsSize: true, acceptsN: true, maxImages: 3, maxSide: 2048, minSide: 512 },
  'qwen-image-2.0': { acceptsSize: true, acceptsN: true, maxImages: 3, maxSide: 2048, minSide: 512 },
  'qwen-image-2.0-pro': { acceptsSize: true, acceptsN: true, maxImages: 3, maxSide: 2048, minSide: 512 },
  'qwen-image-edit-plus': { acceptsSize: true, acceptsN: true, maxImages: 3, maxSide: 2048, minSide: 512 },
  'qwen-image-edit-max': { acceptsSize: true, acceptsN: true, maxImages: 3, maxSide: 2048, minSide: 512 },
  'qwen-image-edit': { acceptsSize: false, acceptsN: false, maxImages: 3, maxSide: 2048, minSide: 512 },
};

const DEFAULT_CAPS = { acceptsSize: false, acceptsN: false, maxImages: 1, maxSide: 2048, minSide: 512 };

export function capsFor(model) {
  const known = MODEL_CAPS[model];
  if (known) return { ...known, known: true };
  return { ...DEFAULT_CAPS, known: false };
}

/* ---------- 图片工具 ---------- */

export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

export function sniffMime(buf) {
  if (buf.length >= 8 && buf.readUInt32BE(0) === 0x89504e47) return 'image/png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 6 && buf.toString('ascii', 0, 3) === 'GIF') return 'image/gif';
  if (buf.length >= 2 && buf.toString('ascii', 0, 2) === 'BM') return 'image/bmp';
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  if (buf.length >= 4 && (buf.toString('ascii', 0, 4) === 'II*\u0000' || buf.toString('ascii', 0, 4) === 'MM\u0000*')) return 'image/tiff';
  return null;
}

export function imageToDataUrl(buf, mime) {
  const m = mime || sniffMime(buf);
  if (!m) throw new Error('不支持的图片格式（仅 PNG / JPEG / BMP / TIFF / WEBP / GIF）');
  if (buf.length > MAX_IMAGE_BYTES) {
    throw new Error(`图片 ${(buf.length / 1048576).toFixed(2)} MB 超过单图 10 MB 上限`);
  }
  return `data:${m};base64,${buf.toString('base64')}`;
}

export function readImageSize(buf) {
  if (buf.length >= 24 && buf.readUInt32BE(0) === 0x89504e47) {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) { i++; continue; }
      const marker = buf[i + 1];
      if (marker === 0xff || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) { i += 2; continue; }
      const len = buf.readUInt16BE(i + 2);
      const isSOF = (marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) ||
        (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf);
      if (isSOF) return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
      i += 2 + len;
    }
  }
  return null;
}

export function hashOf(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

/* 输入图提示（不阻断，只在控制台告警）：官方建议输入边长 384~2048 px */
export function checkInputImage(size) {
  const warnings = [];
  if (!size) return warnings;
  const { width: w, height: h } = size;
  if (Math.min(w, h) < 384) warnings.push(`输入图边长 ${w}×${h} 偏小（建议 384–2048 px）`);
  if (Math.max(w, h) > 2048) warnings.push(`输入图边长 ${w}×${h} 偏大（建议 384–2048 px）`);
  const ratio = Math.max(w, h) / Math.min(w, h);
  if (ratio > 8) warnings.push(`输入图长宽比 ${ratio.toFixed(2)} 超出 1:8 – 8:1`);
  return warnings;
}

/* 输出尺寸：'auto' 按输入图长宽比吸附到合法区间（边长 512–2048、长宽比 ≤8:1），
 * 显式 'W*H' 原样返回。求不出合法值（或模型不接受 size）时返回 null，交给模型自己定。 */
export function resolveSize(spec, model, inputSize) {
  const caps = capsFor(model);
  if (!caps.acceptsSize) return null;
  if (typeof spec === 'string' && /^\d+\*\d+$/.test(spec.trim())) return spec.trim();
  if (spec && spec !== 'auto') return null;
  if (!inputSize) return null;
  const { width: w0, height: h0 } = inputSize;
  let s = Math.min(caps.maxSide / Math.max(w0, h0), 1);
  s = Math.max(s, caps.minSide / Math.min(w0, h0));
  const w = Math.round(w0 * s);
  const h = Math.round(h0 * s);
  if (Math.min(w, h) < caps.minSide || Math.max(w, h) > caps.maxSide) return null;
  if (w * h < caps.minSide * caps.minSide || w * h > caps.maxSide * caps.maxSide) return null;
  if (Math.max(w, h) / Math.min(w, h) > 8) return null;
  return `${w}*${h}`;
}

/* ---------- 提示词 ---------- */

/* 提示词里的 Midjourney 风格画幅标记（--ar 16:9 / --ar 16x9 / --aspect 16:9）：
 * 本族模型的画幅由 parameters.size 决定，所以把标记从正文里剥掉，交给 sizeForRatio 换算。 */
export function parseAspectFlag(prompt) {
  const text = String(prompt || '');
  const m = /(?:^|\s)--(?:ar|aspect(?:_ratio)?)\s+(\d{1,3})\s*[:x×*]\s*(\d{1,3})\b/i.exec(text);
  if (!m) return { prompt: text, ratio: null, raw: null };
  const stripped = (text.slice(0, m.index) + text.slice(m.index + m[0].length))
    .replace(/\s{2,}/g, ' ').trim();
  const w = Number(m[1]), h = Number(m[2]);
  if (!(w > 0 && h > 0)) return { prompt: stripped, ratio: null, raw: m[0].trim() };
  return { prompt: stripped, ratio: { w, h }, raw: m[0].trim() };
}

/* 画幅比例 → 合法输出尺寸（长边顶到上限，短边等比，超出 1:8–8:1 或短边过小时返回 null） */
export function sizeForRatio(w, h, caps) {
  const c = caps || { maxSide: 2048, minSide: 512 };
  const r = Math.max(w, h) / Math.min(w, h);
  if (!isFinite(r) || r <= 0 || r > 8) return null;
  const out = w >= h
    ? { W: c.maxSide, H: Math.round(c.maxSide * h / w) }
    : { W: Math.round(c.maxSide * w / h), H: c.maxSide };
  if (Math.min(out.W, out.H) < c.minSide) return null;
  return `${out.W}*${out.H}`;
}

/* 组装最终提示词：图序说明（含视角 hint）+ 用户提示词 + 几何锁定后缀。
 * roles 是条件图角色名数组（顺序 = 送图顺序），hint 只挂在第一张上。 */
export function assemblePrompt({ prompt, suffix, roles, hint }) {
  const legend = (roles || []).map((role, i) =>
    `图${i + 1}：${role}${i === 0 && hint ? `（${hint}）` : ''}`).join('；');
  return [legend ? legend + '。' : '', String(prompt || ''), String(suffix || '')].filter(Boolean).join(' ');
}

/* ---------- 请求体 ---------- */

/* images: [{ dataUrl, role }]，顺序即 content 顺序（图在前、文字在后；只能有 1 段文字） */
export function buildSyncRequest(opts) {
  const caps = capsFor(opts.model);
  const images = opts.images || [];
  if (!images.length) throw new Error('至少需要 1 张参考图');
  if (images.length > caps.maxImages) {
    throw new Error(`模型 ${opts.model} 最多接受 ${caps.maxImages} 张参考图，当前 ${images.length} 张`);
  }
  const content = images.map(img => ({ image: img.dataUrl || img }));
  content.push({ text: opts.prompt });

  const parameters = {};
  if (caps.acceptsSize && opts.size) parameters.size = opts.size;
  if (caps.acceptsN && opts.n) parameters.n = Number(opts.n);
  if (opts.negativePrompt) parameters.negative_prompt = opts.negativePrompt;
  if (opts.promptExtend !== undefined && opts.promptExtend !== null) parameters.prompt_extend = !!opts.promptExtend;
  if (opts.watermark !== undefined && opts.watermark !== null) parameters.watermark = !!opts.watermark;
  if (opts.seed !== undefined && opts.seed !== null && opts.seed !== '') parameters.seed = Number(opts.seed);

  const body = { model: opts.model, input: { messages: [{ role: 'user', content }] } };
  if (Object.keys(parameters).length) body.parameters = parameters;
  return body;
}

export function buildAsyncRequest() {
  const e = new Error('异步接口（万相 wanx2.1-imageedit）尚未实现，见 docs/ROADMAP.md §3.2');
  e.code = 'E_NOT_IMPLEMENTED';
  throw e;
}

/* ---------- 调用与错误分类 ---------- */

function joinUrl(baseUrl, endpoint) {
  if (/^https?:\/\//i.test(endpoint || '')) return endpoint;
  return String(baseUrl || '').replace(/\/+$/, '') + '/' + String(endpoint || '').replace(/^\/+/, '');
}

function extractImageUrls(json) {
  const out = [];
  const choices = json && json.output && json.output.choices;
  if (Array.isArray(choices)) {
    for (const c of choices) {
      const content = c && c.message && c.message.content;
      if (!Array.isArray(content)) continue;
      for (const item of content) if (item && typeof item.image === 'string') out.push(item.image);
    }
  }
  return out;
}

export async function callSync({ baseUrl, endpoint, apiKey, body, timeoutSec = 180, fetchImpl = fetch }) {
  const url = joinUrl(baseUrl, endpoint);
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutSec * 1000);
  let httpStatus = 0, json = null, text = '';
  try {
    const r = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
      signal: ac.signal,
    });
    httpStatus = r.status;
    text = await r.text();
    try { json = JSON.parse(text); } catch { /* 非 JSON 响应，保留原文 */ }
  } catch (e) {
    clearTimeout(timer);
    const timeout = !!(e && (e.name === 'AbortError' || /abort/i.test(String(e && e.message))));
    return {
      ok: false, httpStatus, requestId: null, imageUrls: [], usage: null, timeout,
      rawError: timeout ? `请求超时（${timeoutSec}s，可能已计费）` : String((e && e.message) || e),
    };
  }
  clearTimeout(timer);
  const imageUrls = extractImageUrls(json);
  const ok = httpStatus >= 200 && httpStatus < 300 && imageUrls.length > 0;
  return {
    ok,
    httpStatus,
    requestId: (json && json.request_id) || null,
    imageUrls,
    usage: (json && json.usage) || null,
    timeout: false,
    rawError: ok ? null : ((json && json.message) || text.slice(0, 300) || `HTTP ${httpStatus}`),
    body: json,
  };
}

/* 返回 { code, retryable, fatal, hint }：可重试 = 限流 / 服务端错误；超时不重试（可能已计费，见调用处） */
export function classifyError(httpStatus, json, opts = {}) {
  const code = (json && json.code) || '';
  const message = (json && json.message) || '';
  const keyEnv = opts.apiKeyEnv || 'DASHSCOPE_API_KEY';

  if (httpStatus === 401 || httpStatus === 403 || /InvalidApiKey|AccessDenied|Unauthorized/i.test(code)) {
    return { code: code || `HTTP ${httpStatus}`, retryable: false, fatal: true,
      hint: `API key 无效或未授权：请检查环境变量 ${keyEnv}（或 --key-env / --key）` };
  }
  if (httpStatus === 429 || /Throttling|RateQuota|RequestsRateLimit/i.test(code)) {
    return { code: code || `HTTP ${httpStatus}`, retryable: true, fatal: false,
      hint: '触发限流，稍后重试；仍失败请降低 QPS（本工具默认串行）' };
  }
  if (/DataInspection|IpmViolation|ContentPolicy|SensitiveContent/i.test(code)) {
    return { code: code || `HTTP ${httpStatus}`, retryable: false, fatal: true,
      hint: '内容审核未通过：检查提示词或输入图中的敏感内容' };
  }
  if (httpStatus === 400 || /InvalidParameter|InvalidRequest|BadRequest|ModelNotFound|model not found/i.test(`${code} ${message}`)) {
    return { code: code || `HTTP ${httpStatus}`, retryable: false, fatal: true,
      hint: `参数或模型名不被接受（模型 ${opts.model || '?'} 的 size/n 能力见 tools/ai/dashscope.mjs 的 MODEL_CAPS）；` +
        `若提示模型不存在，说明该 baseUrl 下没有这个模型，改用业务空间域名重试：--base-url=https://<WorkspaceId>.cn-beijing.maas.aliyuncs.com｜${message}` };
  }
  if (httpStatus >= 500 || /InternalError|ServiceUnavailable|Timeout/i.test(code)) {
    return { code: code || `HTTP ${httpStatus}`, retryable: true, fatal: false,
      hint: '服务端错误，可重试' };
  }
  return { code: code || `HTTP ${httpStatus || '?'}`, retryable: false, fatal: true, hint: message };
}

export async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

/* 出图 URL 只有 24 小时有效期：拿到就立刻下载落盘 */
export async function downloadTo(url, dest, { timeoutSec = 120, retries = 2, fetchImpl = fetch } = {}) {
  let lastError = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutSec * 1000);
    try {
      const r = await fetchImpl(url, { signal: ac.signal });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const buf = Buffer.from(await r.arrayBuffer());
      if (!buf.length) throw new Error('下载到 0 字节');
      clearTimeout(timer);
      await writeFile(dest, buf);
      return { bytes: buf.length, sha256: hashOf(buf), buf };
    } catch (e) {
      clearTimeout(timer);
      lastError = e;
      if (attempt < retries) await sleep(1000 * (attempt + 1));
    }
  }
  throw new Error(`下载结果图失败：${lastError && lastError.message}`);
}

/* ---------- mock provider（零成本自检：本地假接口，出图端点回显收到的第一张条件图） ---------- */
export async function startMockProvider({ status = 200 } = {}) {
  let lastImage = null;
  const server = createServer((req, res) => {
    if (req.method === 'POST') {
      let raw = '';
      req.on('data', c => { raw += c; });
      req.on('end', () => {
        try {
          const content = JSON.parse(raw)?.input?.messages?.[0]?.content || [];
          const m = /^data:([^;]+);base64,(.*)$/.exec((content.find(c => c.image) || {}).image || '');
          if (m) lastImage = { mime: m[1], buf: Buffer.from(m[2], 'base64') };
        } catch { /* 忽略 */ }
        if (status !== 200) {
          const code = status === 401 ? 'InvalidApiKey' : status === 429 ? 'Throttling.RateQuota' : 'InternalError';
          res.writeHead(status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ request_id: 'mock-err', code, message: `mock ${status}` }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          output: { choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: [{ image: `${base}/__img/0.png` }] } }] },
          usage: { image_count: 1 }, request_id: 'mock-ok',
        }));
      });
      return;
    }
    if (String(req.url).startsWith('/__img/')) {
      if (!lastImage) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'Content-Type': lastImage.mime });
      res.end(lastImage.buf);
      return;
    }
    res.writeHead(404); res.end();
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { baseUrl: base, lastImage: () => lastImage, close: () => new Promise(r => server.close(r)) };
}
