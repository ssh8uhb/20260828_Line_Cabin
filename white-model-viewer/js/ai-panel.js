/* AI 效果图面板（阶段③）：当前机位的白模截图 + 提示词 → 阿里云百炼（DashScope）→ 写实效果图。
 *
 * 为什么走本地桥：file:// 页面的 origin 是 null，浏览器直连 dashscope.aliyuncs.com 会被 CORS 拦下；
 * 而且 API key 只能留在 Node 侧。页面只跟 127.0.0.1 上的 tools/ai-bridge.mjs 说话，桥负责调用与落盘。
 * 离线默认值（提示词 / 桥端口 / 截图尺寸 / 视角中文名）内嵌在 index.html 的 #aiRenderData 里；
 * 桥连上后以桥的 /ai-render/config 为准（但桥不回传 key，只回 keyPresent）。
 */
(function () {
  'use strict';

  const inline = (() => {
    const el = document.getElementById('aiRenderData');
    if (!el || !el.textContent.trim()) return null;
    try { return JSON.parse(el.textContent); } catch (e) {
      console.warn('[ai-panel] #aiRenderData 不是合法 JSON：' + e.message);
      return null;
    }
  })();
  const statsEl = document.getElementById('ai_stats');
  const promptEl = document.getElementById('ai_prompt');
  const viewsEl = document.getElementById('ai_views');
  const goBtn = document.getElementById('ai_go');
  const outEl = document.getElementById('ai_out');
  const prevEl = document.getElementById('ai_preview');
  if (!inline || !statsEl || !promptEl || !viewsEl || !goBtn || !outEl || !prevEl) {
    console.warn('[ai-panel] 面板元素或内嵌默认值缺失，AI 效果图面板未启用');
    return;
  }

  const bridgeCfg = inline.bridge || {};
  const BASE = 'http://' + (bridgeCfg.host || '127.0.0.1') + ':' + (bridgeCfg.port || 8787);
  const START_CMD = 'node tools/ai-bridge.mjs';

  let cfg = inline;
  let bridgeOK = false, keyPresent = false, bridgeErr = '';
  let views = [], selected = new Set(), busy = false, promptDirty = false;
  let lastResults = [];

  const $ = id => document.getElementById(id);
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const esc = s => String(s === undefined || s === null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  function setStatus(html) { statsEl.innerHTML = html; }

  function refreshStatus() {
    if (!bridgeOK) {
      setStatus(`<span class="ai-bad">未检测到本地服务</span><br>先运行：<code>${START_CMD}</code><br>` +
        (bridgeErr ? `<span class="ai-dim">（${esc(bridgeErr)}）</span>` : ''));
      return;
    }
    const used = `${cfg.callsOk || 0} 张 / ${cfg.callsUsed || 0} 次调用`;
    setStatus(`<span class="ai-ok">已连接本地服务</span>（${esc(cfg.model)}${cfg.mock ? ' · mock' : ''}）<br>` +
      `key ${keyPresent ? '已就绪' : '<span class="ai-bad">缺失</span>'}${keyPresent ? '' : `，请设 <code>${esc(cfg.apiKeyEnv || 'DASHSCOPE_API_KEY')}</code> 后重启桥`}<br>` +
      `本会话已出图 ${used}（上限 ${cfg.maxCalls || '—'} 次付费调用）`);
  }

  /* ---------- 视角列表：12 个预设 + 自定义镜头 ---------- */
  function hintFor(key) {
    const hints = Object.assign({}, inline.viewHints, cfg.viewHints || {});
    for (const k of Object.keys(hints)) {
      if (key.indexOf(String(k).replace(/\*$/, '')) === 0) return hints[k];
    }
    return '';
  }
  function envOn() {
    try { return !!(window.WMShot && JSON.parse(WMShot.env()).on); } catch (e) { return false; }
  }
  function buildViews() {
    const labels = Object.assign({}, inline.viewLabels, cfg.viewLabels || {});
    const names = (window.WMShot && WMShot.views) ? WMShot.views() : Object.keys(labels);
    const out = names.map(n => ({
      key: n, label: labels[n] || n, hint: hintFor(n), needEnv: /^env-/.test(n),
      apply: () => window.WMShot.view(n),
    }));
    try {
      const sc = JSON.parse(window.WMShot.scenes());
      (sc.custom || []).forEach((s, i) => out.push({
        key: 'custom-' + (i + 1), label: '自定义：' + s.name, hint: '', needEnv: false,
        apply: () => window.WMShot.applyScene(s),
      }));
    } catch (e) { /* 没有自定义场景 */ }
    return out;
  }
  function renderViews() {
    const haveEnv = envOn();
    viewsEl.innerHTML = '';
    for (const v of views) {
      v.disabled = !!(v.needEnv && !haveEnv);
      const row = document.createElement('div');
      row.className = 'ai-vrow';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = selected.has(v.key);
      cb.disabled = v.disabled;
      cb.addEventListener('change', () => {
        if (cb.checked) selected.add(v.key); else selected.delete(v.key);
        syncGo();
      });
      const nm = document.createElement('span');
      nm.className = 'ai-vname';
      nm.textContent = v.label;
      nm.addEventListener('click', () => {
        if (cb.disabled) return;
        cb.checked = !cb.checked;
        cb.dispatchEvent(new Event('change'));
      });
      const key = document.createElement('span');
      key.className = 'ai-vkey';
      key.textContent = v.key;
      const eye = document.createElement('button');
      eye.type = 'button';
      eye.className = 'sbtn ai-eye';
      eye.textContent = '看';
      eye.title = v.disabled ? '需先载入周边环境' : '把镜头切到这个机位（不入渲染队列）';
      eye.disabled = v.disabled;
      eye.addEventListener('click', () => {
        if (window.WMShot.settle) WMShot.settle();
        v.apply();
      });
      row.appendChild(cb);
      row.appendChild(nm);
      row.appendChild(key);
      row.appendChild(eye);
      viewsEl.appendChild(row);
    }
  }

  /* ---------- 按钮 / 状态联动 ---------- */
  function pickedChannels() {
    const chs = ['color'];
    for (const c of ['depth', 'normal']) {
      const el = $('ai_ch_' + c);
      if (el && el.checked) chs.push(c);
    }
    return chs;
  }
  function syncGo() {
    const n = selected.size;
    const can = bridgeOK && keyPresent && n > 0 && !busy;
    goBtn.disabled = !can;
    goBtn.textContent = busy ? '出图中…' : (n > 0 ? `生成效果图（${n} 次调用）` : '生成效果图');
    goBtn.title = !bridgeOK ? `未连接本地服务：先运行 ${START_CMD}`
      : !keyPresent ? '本地服务没有读到 API key'
        : n === 0 ? '先在上面的列表里勾选要渲染的视角'
          : `把 ${n} 个机位的白模截图 + 提示词发给百炼（每次调用计费 1 张额度）`;
  }

  /* ---------- 出图 ---------- */
  async function postRender(payload) {
    const r = await fetch(BASE + '/ai-render', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    });
    let j = null;
    try { j = await r.json(); } catch (e) { throw new Error(`本地服务返回非 JSON（HTTP ${r.status}）`); }
    if (!j || !j.ok) {
      throw new Error(`${(j && j.code) || 'HTTP ' + r.status}：${(j && j.message) || ''}` +
        (j && j.hint ? `\n${j.hint}` : ''));
    }
    return j;
  }

  function showResult(v, out) {
    prevEl.innerHTML = '';
    const img = document.createElement('img');
    img.src = BASE + out.url;
    img.alt = v.label;
    img.title = '点击在新标签页打开原图';
    img.addEventListener('click', () => window.open(BASE + out.url, '_blank'));
    prevEl.appendChild(img);
    const cap = document.createElement('div');
    cap.className = 'ai-cap';
    const dim = out.size ? `${out.size.width}×${out.size.height}` : '尺寸未知';
    const dev = (out.aspectDeviation === null || out.aspectDeviation === undefined)
      ? '—' : (out.aspectDeviation * 100).toFixed(1) + '%';
    cap.innerHTML = `${esc(v.label)}（${esc(v.key)}）· ${dim} · 长宽比偏差 ${dev}<br><span class="ai-path">${esc(out.file)}</span>`;
    prevEl.appendChild(cap);
  }

  async function generate() {
    const picked = Array.from(selected).map(k => views.find(v => v.key === k)).filter(Boolean);
    if (!picked.length) return;
    const chans = pickedChannels();
    const msg = `将向阿里云百炼发起 ${picked.length} 次付费调用（模型 ${cfg.model}，每次出 1 张图）。\n\n` +
      `视角：${picked.map(p => p.label).join(' / ')}\n条件图：${chans.join(' + ')}\n` +
      `截图尺寸：${cfg.captureSize || '1600*900'}\n\n继续？`;
    if (!window.confirm(msg)) return;

    busy = true; syncGo();
    const done = [];
    try {
      for (let i = 0; i < picked.length; i++) {
        const v = picked[i];
        setStatus(`（${i + 1}/${picked.length}）${esc(v.label)}：摆机位 + 截图…`);
        if (window.WMShot.settle) WMShot.settle();
        if (v.apply() === false) throw new Error(`${v.label}：机位不可用（周边环境视角需要先载入周边环境）`);
        await sleep(200);
        const cap = window.WMShot.capture(cfg.captureSize || '1600*900', chans);
        if (!cap) throw new Error('页面尚未完成建模，无法截图');
        setStatus(`（${i + 1}/${picked.length}）${esc(v.label)}：请求百炼…（截图 ${cap.size.width}×${cap.size.height}）`);
        const out = await postRender({
          view: v.key, label: v.label, hint: v.hint, channels: chans, images: cap.images,
          prompt: promptEl.value.trim(),
          doc: JSON.parse(window.WMShot.doc()),
        });
        done.push({ v, out });
        showResult(v, out);
        outEl.innerHTML = done.map(d =>
          `<div>· ${esc(d.v.label)} → <span class="ai-path">${esc(d.out.file)}</span></div>`).join('');
      }
      setStatus(`<span class="ai-ok">完成 ${done.length}/${picked.length} 张</span><br>` +
        `输出目录：<span class="ai-path">${esc(done[0].out.dir)}</span>`);
      const again = await fetch(BASE + '/ai-render/config', { cache: 'no-store' }).then(r => r.json()).catch(() => null);
      if (again && again.ok) { cfg = again; }
    } catch (e) {
      setStatus(`<span class="ai-bad">失败</span>：${esc(e.message).replace(/\n/g, '<br>')}` +
        (done.length ? `<br>（已完成 ${done.length} 张，见下方预览；剩余已中止）` : ''));
    } finally {
      busy = false; syncGo();
    }
  }

  /* ---------- 初始化 ---------- */
  async function probe() {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 2500);
    try {
      const r = await fetch(BASE + '/ai-render/config', { cache: 'no-store', signal: ac.signal });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const j = await r.json();
      if (!j.ok) throw new Error(j.message || 'config 读取失败');
      cfg = j; bridgeOK = true; keyPresent = !!j.keyPresent; bridgeErr = '';
    } catch (e) {
      bridgeOK = false; keyPresent = false;
      bridgeErr = (e && e.name === 'AbortError') ? '连接超时' : String((e && e.message) || e);
    } finally { clearTimeout(timer); }
    if (!promptDirty) promptEl.value = String(cfg.prompt || inline.prompt || '');
    views = buildViews();
    const want = Array.isArray(cfg.views) && cfg.views.length ? cfg.views : (inline.views || []);
    selected = new Set(want.filter(k => views.some(v => v.key === k)));
    if (!selected.size && views.length) selected.add('iso-ne');
    renderViews();
    refreshStatus();
    syncGo();
  }

  promptEl.addEventListener('input', () => { promptDirty = true; });
  $('ai_reset').addEventListener('click', () => {
    promptEl.value = String(cfg.prompt || inline.prompt || '');
    promptDirty = false;
    promptEl.focus();
  });
  $('ai_all').addEventListener('click', () => {
    for (const v of views) if (!v.disabled) selected.add(v.key);
    renderViews(); syncGo();
  });
  $('ai_none').addEventListener('click', () => { selected.clear(); renderViews(); syncGo(); });
  for (const c of ['depth', 'normal']) {
    const el = $('ai_ch_' + c);
    if (el) el.addEventListener('change', syncGo);
  }
  goBtn.addEventListener('click', generate);

  probe();
})();
