#!/usr/bin/env node
/* AI 出图 CLI：白模截图（复用 tools/cdp-shot.mjs）→ 阿里云百炼同步图像接口 → 效果图 + run.json
 *
 * 用法：
 *   node tools/ai-render.mjs [--views=iso-ne,persp-1|all] [--channels=color[,depth,normal]]
 *        [--prompt="…"] [--prompts=file.json] [--model=] [--size=auto|W*H] [--n=1] [--seed=] [--negative=]
 *        [--base-url=https://dashscope.aliyuncs.com]     业务空间域名（如 https://<WorkspaceId>.cn-beijing.maas.aliyuncs.com）
 *        [--out=DIR] [--page=index.html] [--url=<完整URL>]
 *        [--key-env=DASHSCOPE_API_KEY] [--key=]        API key 只从环境变量读；--key 会留在命令历史里
 *        [--shots=DIR] [--skip-shots]                 复用已出好的白模图
 *        [--dry-run] [--mock[=401|429|500]] [--yes]   零成本自检 / 免确认
 *        [--wait=8] [--timeout=180] [--retries=1] [--interval=1500] [--help]
 * 默认值全部取自 data/ai-render.json；每次调用都计费，默认只出 1 视角 1 张。
 * 提示词里可带 Midjourney 风格的画幅标记（如 "--ar 16:9"）：会被剥掉正文并按它换算 size（仅 size=auto 时）。
 */
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  assemblePrompt, buildSyncRequest, callSync, capsFor, checkInputImage, classifyError, downloadTo,
  hashOf, imageToDataUrl, parseAspectFlag, readImageSize, resolveSize, sizeForRatio, sleep, startMockProvider,
} from './ai/dashscope.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const VIEWER_DIR = resolve(HERE, '..');
const CONFIG_PATH = join(VIEWER_DIR, 'data', 'ai-render.json');
const CDP_SHOT = join(HERE, 'cdp-shot.mjs');

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

function loadConfig() {
  if (!existsSync(CONFIG_PATH)) throw new Error(`未找到配置 ${CONFIG_PATH}`);
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
  } catch (e) {
    throw new Error(`配置 ${CONFIG_PATH} 不是合法 JSON：${e.message}`);
  }
}

const fileCfg = loadConfig();
const pages = { ...fileCfg };

const applyNum = (name, key) => { const v = flagVal(name); if (v !== null && v !== true) pages[key] = Number(v); };
const applyStr = (name, key) => { const v = flagVal(name); if (v !== null && v !== true) pages[key] = v; };

applyStr('model', 'model');
applyStr('base-url', 'baseUrl');
const viewsArg = flagVal('views');
const channelsArg = flagVal('channels');
const promptArg = flagVal('prompt');
const promptsFileArg = flagVal('prompts');
const sizeArg = flagVal('size');
const negativeArg = flagVal('negative');
applyNum('n', 'n');
applyNum('wait', 'waitSeconds');
applyNum('timeout', 'timeoutSec');
applyNum('retries', 'retries');
applyNum('interval', 'intervalMs');
if (flagVal('seed') !== null && flagVal('seed') !== true) pages.seed = Number(flagVal('seed'));

const dryRun = has('dry-run');
const mockArg = flagVal('mock');
const mockOn = mockArg !== null;
const mockStatus = (mockOn && mockArg !== true) ? Number(mockArg) : 200;
const yes = has('yes');
const skipShots = has('skip-shots');
const shotsArg = flagVal('shots');
const outArg = flagVal('out');

if (flagVal('json') !== null) {
  console.error('本次不支持 --json=<path>：任意 JSON 建模（?src= / WMShot.load）尚未实现，见 docs/ROADMAP.md §3.1。');
  process.exit(1);
}

/* 视角 / 通道 */
const viewsSpec = (viewsArg === null || viewsArg === true) ? String((pages.views || ['persp-1']).join(',')) : String(viewsArg);
const viewsAll = viewsSpec === 'all';
const requestedViews = viewsAll ? [] : viewsSpec.split(',').map(s => s.trim()).filter(Boolean);
const channels = ((channelsArg === null || channelsArg === true) ? (pages.channels || ['color']) : String(channelsArg).split(','))
  .map(s => s.trim()).filter(Boolean);
if (!channels.length) { console.error('至少需要 1 个通道（color / depth / normal）'); process.exit(1); }
if (channels.length > 3) { console.error(`一次最多送 3 张参考图，当前 ${channels.length} 个通道：${channels.join(',')}`); process.exit(1); }

/* 页面 URL */
function pageUrl() {
  const u = flagVal('url');
  if (u && u !== true) return String(u);
  const p = flagVal('page');
  const rel = (p && p !== true) ? String(p) : String(pages.page || 'index.html');
  const q = String(pages.query || '');
  return pathToFileURL(resolve(VIEWER_DIR, rel)).href + (q ? '?' + q : '');
}

/* 输出目录 */
function stamp() {
  const d = new Date(), p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
const outDir = resolve(outArg && outArg !== true ? String(outArg) : join(VIEWER_DIR, 'out', stamp()));
const whiteDir = join(outDir, 'white');
const requestDir = join(outDir, 'request');
const aiDir = join(outDir, 'ai');

/* ---------- 提示词 ---------- */
function hintFor(view) {
  const hints = pages.viewHints || {};
  for (const key of Object.keys(hints)) if (view.startsWith(key.replace(/\*$/, ''))) return hints[key];
  return '';
}
function buildPrompt(view, viewPrompt) {
  const roles = channels.map(c => (pages.imageRoles && pages.imageRoles[c]) || c);
  return assemblePrompt({ prompt: viewPrompt, suffix: pages.promptSuffix, roles, hint: hintFor(view) });
}
function viewPromptFor(view, promptsFile) {
  if (promptArg && promptArg !== true) return String(promptArg);
  if (promptsFile && promptsFile.views && promptsFile.views[view]) return promptsFile.views[view];
  if (promptsFile && promptsFile.default) return promptsFile.default;
  return String(pages.prompt || '');
}

/* ---------- 出白模图（复用 cdp-shot.mjs） ---------- */
async function shootWhite(url) {
  mkdirSync(whiteDir, { recursive: true });
  for (const f of readdirSync(whiteDir)) {
    if (/^[\w.-]+-[\w.-]+\.png$/i.test(f)) unlinkSync(join(whiteDir, f));   // 清掉上一轮的残留图，防旧图被当成新图
  }
  const args = [CDP_SHOT, url, whiteDir, String(pages.waitSeconds ?? 8),
    `--views=${viewsAll ? 'all' : requestedViews.join(',')}`, `--channels=${channels.join(',')}`];
  console.log(`[ai-render] 出白模图：node ${args.slice(1).join(' ')}`);
  const code = await new Promise(r => spawn(process.execPath, args, { stdio: 'inherit' }).on('exit', r));
  if (code !== 0) throw new Error(`cdp-shot 退出码 ${code}，白模截图未完成`);

  const manifestPath = join(whiteDir, 'manifest.json');
  const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : null;
  const names = manifest && manifest.views.length ? manifest.views.map(v => v.name) : requestedViews;
  if (!names.length) throw new Error('没有可渲染的视角：请检查 --views 的取值（env-* 视角需要页面 URL 带 ?env=1）');

  const missing = [];
  for (const v of names) for (const c of channels) {
    const p = join(whiteDir, `${v}-${c}.png`);
    if (!existsSync(p) || statSync(p).size === 0) missing.push(`${v}-${c}.png`);
  }
  if (missing.length) {
    throw new Error(`白模截图缺失 ${missing.length} 张：${missing.join(', ')}（env-* 视角需要 ?env=1；视角名可用 WMShot.views() 查）`);
  }
  return { manifest, names };
}

/* ---------- 主流程 ---------- */
const run = {
  version: pages.version || 1,
  provider: pages.provider || 'dashscope',
  baseUrl: pages.baseUrl, endpoint: pages.endpoint, model: pages.model,
  pageUrl: pageUrl(), outDir,
  generatedAt: new Date().toISOString(), finishedAt: null,
  dryRun, mock: mockOn,
  params: { channels, size: null, n: pages.n ?? 1, seed: pages.seed ?? null,
    promptExtend: pages.promptExtend, watermark: pages.watermark },
  prompt: { source: (promptArg && promptArg !== true) ? 'cli' : (promptsFileArg ? 'file' : 'config'), default: pages.prompt, perViewSent: {} },
  shots: { dir: whiteDir, manifest: null },
  items: [],
  summary: { requested: 0, ok: 0, failed: 0, paidCalls: 0 },
};
const writeRun = () => writeFileSync(join(outDir, 'run.json'), JSON.stringify(run, null, 2), 'utf8');

let mockSrv = null;
try {
  mkdirSync(requestDir, { recursive: true });
  mkdirSync(aiDir, { recursive: true });

  /* key：只从环境变量读（--key 仅临时覆盖，会留在命令行历史里） */
  let apiKey = '';
  const keyArg = flagVal('key');
  if (dryRun) apiKey = '(dry-run)';
  else if (keyArg && keyArg !== true) apiKey = String(keyArg);
  else if (mockOn) apiKey = 'mock-key';
  else {
    const envName = String((flagVal('key-env') && flagVal('key-env') !== true) ? flagVal('key-env') : (pages.apiKeyEnv || 'DASHSCOPE_API_KEY'));
    apiKey = process.env[envName] || '';
    if (!apiKey) {
      console.error(`未找到 API key：请设置环境变量 ${envName}，或临时用 --key=（注意会留在命令历史里）。`);
      console.error('PowerShell:  $env:' + envName + '="sk-xxxx"      CMD:  set ' + envName + '=sk-xxxx');
      process.exit(1);
    }
    console.log(`[ai-render] API key 来源：环境变量 ${envName}（${apiKey.slice(0, 3)}***）`);
  }

  let promptsFile = null;
  if (promptsFileArg && promptsFileArg !== true) {
    const p = resolve(String(promptsFileArg));
    promptsFile = JSON.parse(readFileSync(p, 'utf8'));
  }

  /* 1) 白模截图 */
  let names, manifest = null;
  if (shotsArg && shotsArg !== true) {
    const dir = resolve(String(shotsArg));
    mkdirSync(whiteDir, { recursive: true });
    const listed = readdirSync(dir);
    names = requestedViews.length
      ? requestedViews
      : [...new Set(listed.filter(f => /-.*\.png$/i.test(f)).map(f => f.replace(/-[^-]+\.png$/i, '')))]
        .filter(v => channels.some(c => listed.includes(`${v}-${c}.png`)));
    for (const v of names) for (const c of channels) {
      const src = join(dir, `${v}-${c}.png`);
      if (!existsSync(src)) throw new Error(`--shots 目录缺少 ${v}-${c}.png`);
      writeFileSync(join(whiteDir, `${v}-${c}.png`), readFileSync(src));
    }
    console.log(`[ai-render] 复用白模图：${names.length} 视角 × ${channels.length} 通道 ← ${dir}`);
  } else if (skipShots) {
    names = requestedViews;
    if (!names.length) throw new Error('--skip-shots 需要配合 --views= 指定视角');
    for (const v of names) for (const c of channels) {
      if (!existsSync(join(whiteDir, `${v}-${c}.png`))) throw new Error(`--skip-shots 但缺少 ${join(whiteDir, `${v}-${c}.png`)}`);
    }
  } else {
    ({ names, manifest } = await shootWhite(run.pageUrl));
  }
  run.shots.manifest = manifest ? join(whiteDir, 'manifest.json') : null;
  run.summary.requested = names.length;
  writeRun();

  /* 2) 组装请求 */
  const caps = capsFor(pages.model);
  if (!caps.known) console.warn(`[ai-render] 警告：模型 ${pages.model} 不在能力表中，按最保守假设处理（不接受 size/n，最多 1 张参考图）`);
  const prepared = [];
  let arNote = null;
  for (const v of names) {
    const imgs = [];
    for (const c of channels) {
      const file = `${v}-${c}.png`;
      const buf = readFileSync(join(whiteDir, file));
      const size = readImageSize(buf);
      for (const w of checkInputImage(size)) console.warn(`[ai-render] 警告（${file}）：${w}`);
      imgs.push({ role: c, file, bytes: buf.length, sha256: hashOf(buf), size,
        dataUrl: imageToDataUrl(buf) });
    }
    const primary = imgs.find(i => i.role === 'color') || imgs[0];
    /* 提示词里的 --ar 16:9 之类的画幅标记：剥出正文，并在 size=auto 时换算成输出尺寸 */
    const ar = parseAspectFlag(viewPromptFor(v, promptsFile));
    let sizeSpec = (sizeArg === null || sizeArg === true) ? pages.size : String(sizeArg);
    if ((sizeSpec === 'auto' || sizeSpec === true) && ar.ratio) {
      const s = sizeForRatio(ar.ratio.w, ar.ratio.h, caps);
      if (s) { sizeSpec = s; arNote = `提示词里的 ${ar.raw} → size ${s}`; }
      else console.warn(`[ai-render] 警告：提示词里的 ${ar.raw} 换算不出合法输出尺寸，已忽略`);
    }
    const size = resolveSize(sizeSpec, pages.model, primary.size);
    if (pages.model && !caps.acceptsSize && (sizeArg && sizeArg !== true)) {
      console.warn(`[ai-render] 警告：模型 ${pages.model} 不接受 size，已忽略 --size=${sizeArg}`);
    }
    const prompt = buildPrompt(v, ar.prompt);
    const body = buildSyncRequest({
      model: pages.model, prompt, images: imgs, size,
      n: caps.acceptsN ? (pages.n ?? 1) : undefined,
      negativePrompt: (negativeArg && negativeArg !== true) ? String(negativeArg) : pages.negativePrompt,
      promptExtend: pages.promptExtend, watermark: pages.watermark,
      seed: pages.seed,
    });
    run.params.size = size;
    prepared.push({ view: v, imgs, prompt, body, model: pages.model, size });
    writeFileSync(join(requestDir, `${v}.json`), JSON.stringify(recordOf(body, imgs), null, 2), 'utf8');
  }

  function recordOf(body, imgs) {
    const copy = JSON.parse(JSON.stringify(body));
    let i = 0;
    for (const item of copy.input.messages[0].content) {
      if (!item.image) continue;
      const m = imgs[i++];
      item.image = { file: m.file, role: m.role, bytes: m.bytes, sha256: m.sha256, size: m.size, dataUrlChars: m.dataUrl.length };
    }
    copy.__note = '此文件是实际请求体的记录（图片 base64 已替换为文件指纹），可直接用于复现；不含 API key。';
    return copy;
  }

  console.log(`[ai-render] 模型 ${pages.model}｜视角 ${names.join(', ')}｜通道 ${channels.join('+')}｜size ${run.params.size || '(模型默认)'}｜n ${run.params.n}`);
  if (arNote) console.log(`[ai-render] ${arNote}`);
  for (const p of prepared) console.log(`  · ${p.view}: ${p.imgs.map(i => `${i.file}(${i.size ? i.size.width + '×' + i.size.height : '?'})`).join(' + ')}`);

  if (dryRun) {
    console.log('[ai-render] --dry-run：已生成白模图与请求体记录，未发起任何调用。');
    for (const p of prepared) console.log(`\n[${p.view}] 送出的提示词：\n${p.prompt}`);
    run.summary.ok = 0;
    run.finishedAt = new Date().toISOString();
    writeRun();
    console.log(`\n[ai-render] 输出目录：${outDir}`);
    process.exit(0);
  }

  /* 3) 付费确认 */
  if (mockOn) {
    mockSrv = await startMockProvider({ status: mockStatus });
    pages.baseUrl = mockSrv.baseUrl;
    run.baseUrl = mockSrv.baseUrl;
    console.log(`[ai-render] --mock${mockStatus === 200 ? '' : '=' + mockStatus}：本地假接口 ${mockSrv.baseUrl}（不产生费用）`);
  } else if (!yes) {
    console.log(`\n[ai-render] 即将发起 ${prepared.length} 次付费调用（模型 ${pages.model}，每次 1 张）。`);
    if (!process.stdin.isTTY) {
      console.error('[ai-render] 非交互环境：确认无误请加 --yes 重新执行。');
      process.exit(1);
    }
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const ans = await new Promise(r => rl.question('继续？(y/N) ', r));
    rl.close();
    if (!/^y/i.test(ans.trim())) { console.log('[ai-render] 已取消。'); run.finishedAt = new Date().toISOString(); writeRun(); process.exit(0); }
  }

  /* 4) 逐视角调用 + 下载 */
  for (let idx = 0; idx < prepared.length; idx++) {
    const p = prepared[idx];
    const item = { view: p.view, hint: hintFor(p.view), conditioning: p.imgs.map(i => ({ file: i.file, role: i.role, bytes: i.bytes, sha256: i.sha256, size: i.size })),
      requestId: null, promptSent: p.prompt, ok: false, durationMs: 0, outputs: [], error: null };
    run.prompt.perViewSent[p.view] = p.prompt;
    console.log(`\n[ai-render] (${idx + 1}/${prepared.length}) ${p.view} → ${pages.baseUrl}`);
    const t0 = Date.now();
    let res = await callSync({ baseUrl: pages.baseUrl, endpoint: pages.endpoint, apiKey, body: p.body, timeoutSec: pages.timeoutSec ?? 180 });
    item.requestId = res.requestId;
    item.durationMs = Date.now() - t0;

    if (!res.ok) {
      const cls = classifyError(res.httpStatus, res.body, { apiKeyEnv: pages.apiKeyEnv, model: pages.model });
      console.error(`  失败：${cls.code}｜${res.rawError}`);
      if (cls.hint) console.error(`  提示：${cls.hint}`);
      if (cls.retryable && (pages.retries ?? 1) > 0 && !res.timeout) {
        console.log(`  等待 3s 后重试…`);
        await sleep(3000);
        res = await callSync({ baseUrl: pages.baseUrl, endpoint: pages.endpoint, apiKey, body: p.body, timeoutSec: pages.timeoutSec ?? 180 });
        item.requestId = item.requestId || res.requestId;
        if (!res.ok) console.error(`  重试仍失败：HTTP ${res.httpStatus}｜${res.rawError}`);
      }
      if (!res.ok) {
        item.error = { code: cls.code, httpStatus: res.httpStatus, message: res.rawError, hint: cls.hint || null };
        run.items.push(item);
        run.summary.failed++;
        writeRun();
        if (res.timeout || cls.fatal) { console.error('[ai-render] 致命错误，中止后续视角（已成功的效果图与 run.json 已落盘）。'); break; }
        continue;
      }
    }

    run.summary.paidCalls++;
    for (let k = 0; k < res.imageUrls.length; k++) {
      const name = res.imageUrls.length > 1 ? `${p.view}-ai${k + 1}.png` : `${p.view}-ai.png`;
      const dest = join(aiDir, name);
      try {
        const dl = await downloadTo(res.imageUrls[k], dest, { timeoutSec: 120, retries: 2 });
        const sz = readImageSize(dl.buf);
        const deviation = sz && p.imgs[0].size
          ? Math.abs((sz.width / sz.height) / (p.imgs[0].size.width / p.imgs[0].size.height) - 1) : null;
        item.outputs.push({ file: name, bytes: dl.bytes, sha256: dl.sha256, size: sz, sourceUrl: res.imageUrls[k], aspectDeviation: deviation });
        console.log(`  已保存 ${join(aiDir, name)}（${sz ? sz.width + '×' + sz.height : '尺寸未知'}，长宽比偏差 ${deviation === null ? '—' : (deviation * 100).toFixed(1) + '%'}）`);
      } catch (e) {
        item.error = { code: 'DOWNLOAD_FAILED', message: e.message, hint: '结果 URL 24 小时有效，可手动下载后重试', sourceUrl: res.imageUrls[k] };
        console.error(`  ${e.message}（URL 记在 run.json 里，24 小时内仍可手动下载）`);
      }
    }
    item.ok = item.outputs.length > 0;
    if (item.ok) run.summary.ok++;
    run.items.push(item);
    writeRun();
    if (idx < prepared.length - 1) await sleep(pages.intervalMs ?? 1500);
  }

  run.finishedAt = new Date().toISOString();
  writeRun();
  console.log(`\n[ai-render] 完成：${run.summary.ok}/${run.summary.requested} 张效果图，付费调用 ${run.summary.paidCalls} 次。`);
  console.log(`[ai-render] 输出目录：${outDir}`);
  if (run.summary.ok) {
    console.log('[ai-render] 验收建议：用识图脚本对比白模图与效果图，确认建筑几何没跑偏：');
    console.log(`  node C:/Users/lenovo/.codex/skills/claude-vision-skill/vision.js "${join(aiDir, prepared[0].view + '-ai.png')}" "与 ${join(whiteDir, prepared[0].view + '-color.png')} 对比：建筑轮廓、屋面形状、门窗数量与位置是否一致？只列差异"`);
  }
  if (run.summary.failed) process.exitCode = 1;
} catch (e) {
  console.error('[ai-render] 失败：' + e.message);
  run.finishedAt = new Date().toISOString();
  try { writeRun(); } catch { /* 输出目录可能还没建起来 */ }
  process.exitCode = 1;
} finally {
  if (mockSrv) await mockSrv.close();
}
