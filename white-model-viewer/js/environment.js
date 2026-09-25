/* 建筑周边环境（总平面图）：高程点 → 地形三角网 + 主河槽「河床面 / 水面」(v0.1)
 *
 * 输入: white-model-viewer/data/site-context.json（v2，由 tools/dxf-site-context.mjs 生成）
 * 用法: WMEnv.build({ data, THREE, level, wallAabb, params })
 *       → { terGeo, bedGeo, waterGeo, skirtGeo, lines, stats, warnings }
 *
 * 约定（与 docs/DATA-MODEL.md 第 12 节一致）:
 *   单位 mm；平面 X/Y 与查看器 JSON 同一套坐标，Z = 绝对标高×1000 − 166759（与白模同一个 Z）
 *   地形范围 = 模型墙体 AABB 每侧外扩 params.marginMm，边界对齐到网格
 *   平台（场平）= 场地轮廓（site-context 的 site.outlineModelMm，DLSS 场地）内部压平，
 *     面高 = 室外地坪 − params.platformSinkMm（= DLSS 面底面，js/siteworks.js 的 roadThkMm 500
 *     正好坐在上面）；建筑外墙 AABB 内部挖空，否则会把下沉的水泵间埋掉
 *   主河槽 = riverChannel.mainChannel.bankIds 两条岸线之间；河床由槽内高程点插值，
 *     槽内底面取 min(河床, 地面) 并往两岸平滑过渡，保证河道永远低于两侧地面、不出现假土包
 *   水面 = 河床最低点 + params.waterDepthMm，并被「较低岸顶 − params.waterClampMm」压住，
 *     水面边界由水面与该断面地形网格的交点求出（岸线自然收口，不越岸）
 *
 * 纯数学部分（resolveParams / corridorFrame / infoIn / buildField / sampleSurface / waterProfile）
 * 不依赖 THREE，Node 侧可 require 直接跑数值自检。
 */
(function () {
'use strict';

/* ---------------- 参数 ---------------- */
const DEFAULT_PARAMS = {
  marginMm: 60000,          // 地形范围：墙体 AABB 每侧外扩
  gridMm: 1500,             // 地形网格间距
  platformSinkMm: 500,      // 平台面 = 室外地坪 − 该值（= DLSS 面厚度 roadThkMm，面正好坐在平台上）
  idwPower: 2,
  idwK: 12,                 // IDW 参与的最近点数
  despikeMm: 600,           // 3×3 中值去刺阈值
  smoothIters: 8,
  smoothLambda: 0.45,
  slopeMax: 1.0,            // 硬上限：1:1
  slopeTarget: 0.2,         // 目标坡 1:5（摊开场平到自然地面的落差）
  slopeSoftIters: 12,
  slopeHardIters: 20,
  bankBlend: 0.3,           // 槽宽外侧该比例作为岸坡过渡带
  endTaperMm: 10000,        // 河槽自由端的收口渐变长度（避免河道端头出现断崖）
  bedMinDepthMm: 800,       // 低于两侧地面超过该值才算「河床」（材质分区用）
  bedUnderMm: 200,          // 河床材质只保留「低于当地水位该值」的格子（把材质边界藏到水面之下）
  waterDepthMm: 1000,       // 水面 = 河床 + 水深（数据文件可改）
  waterClampMm: 200,        // 水面不得高于较低岸顶 − 该值
  waterSmoothIters: 6,      // 水位沿程平滑轮数（去掉逐站取 min 造成的台阶）
  skirtMm: 3000,            // 地块四周裙边高度
  corridorStationMm: 2000,  // 河槽断面间距
  corridorSampleMm: 500,    // 断面上的采样间距（同时是水面条带的纵向细分步长）
};

function resolveParams(envData) {
  const p = {};
  for (const k in DEFAULT_PARAMS) p[k] = DEFAULT_PARAMS[k];
  if (envData && typeof envData === 'object') {
    for (const k in DEFAULT_PARAMS) {
      if (typeof envData[k] === 'number' && isFinite(envData[k]) && envData[k] > 0) p[k] = envData[k];
    }
    /* bedUnderMm ≤ 0 = 关闭「河床只在水面之下」的限制（河床铺满整个开凿河槽） */
    if (typeof envData.bedUnderMm === 'number' && isFinite(envData.bedUnderMm)) p.bedUnderMm = envData.bedUnderMm;
  }
  return p;
}

/* ---------------- 基础几何 ---------------- */
const clamp = (v, a, b) => (v < a ? a : (v > b ? b : v));
const lerp = (a, b, t) => a + (b - a) * t;
const smoothstep = (t) => { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); };
const dist2 = (ax, ay, bx, by) => (ax - bx) * (ax - bx) + (ay - by) * (ay - by);

function polyOf(banks, id) {
  const b = (banks || []).find(x => x.id === id);
  if (!b || !b.outlineModelMm || b.outlineModelMm.length < 2) return null;
  return b.outlineModelMm.map(p => [p[0], p[1]]);
}

/* 折线上离 (x,y) 最近的点：返回点、距离与沿折线的弧长 */
function closestOnPolyline(poly, x, y) {
  let best = { x: poly[0][0], y: poly[0][1], d: Infinity, arc: 0 };
  let arc = 0;
  for (let i = 0; i + 1 < poly.length; i++) {
    const ax = poly[i][0], ay = poly[i][1];
    const bx = poly[i + 1][0], by = poly[i + 1][1];
    const vx = bx - ax, vy = by - ay;
    const L2 = vx * vx + vy * vy;
    const seg = Math.sqrt(L2);
    let t = L2 > 0 ? ((x - ax) * vx + (y - ay) * vy) / L2 : 0;
    t = clamp(t, 0, 1);
    const px = ax + t * vx, py = ay + t * vy;
    const d = Math.hypot(x - px, y - py);
    if (d < best.d) best = { x: px, y: py, d: d, arc: arc + t * seg };
    arc += seg;
  }
  return best;
}

/* 段与轴对齐矩形求交（Liang–Barsky 参数区间），无交返回 null */
function clipSegToRect(ax, ay, bx, by, rect) {
  let t0 = 0, t1 = 1;
  const dx = bx - ax, dy = by - ay;
  const p = [-dx, dx, -dy, dy];
  const q = [ax - rect.x0, rect.x1 - ax, ay - rect.y0, rect.y1 - ay];
  for (let i = 0; i < 4; i++) {
    if (Math.abs(p[i]) < 1e-9) { if (q[i] < 0) return null; continue; }
    const r = q[i] / p[i];
    if (p[i] < 0) { if (r > t1) return null; if (r > t0) t0 = r; }
    else { if (r < t0) return null; if (r < t1) t1 = r; }
  }
  return [t0, t1];
}

/* 折线按矩形裁剪，返回若干段落在矩形内的折线（用于把岸线/轮廓线裁到地形范围内） */
function clipPolylineToRect(pts, rect) {
  const runs = [];
  let cur = null;
  for (let i = 0; i + 1 < pts.length; i++) {
    const ax = pts[i][0], ay = pts[i][1];
    const bx = pts[i + 1][0], by = pts[i + 1][1];
    const iv = clipSegToRect(ax, ay, bx, by, rect);
    if (!iv) { cur = null; continue; }
    const p0 = [lerp(ax, bx, iv[0]), lerp(ay, by, iv[0])];
    const p1 = [lerp(ax, bx, iv[1]), lerp(ay, by, iv[1])];
    if (cur && dist2(cur[cur.length - 1][0], cur[cur.length - 1][1], p0[0], p0[1]) < 1) cur.push(p1);
    else { cur = [p0, p1]; runs.push(cur); }
  }
  return runs.filter(r => r.length >= 2);
}

/* 把格子矩形按「挖空矩形」的边界切成子矩形，返回落在挖空区之外的部分（两个矩形都轴对齐） */
function cutLines(a, b, lo, hi) {
  const cuts = [];
  if (lo > a && lo < b) cuts.push(lo);
  if (hi > a && hi < b) cuts.push(hi);
  cuts.sort((p, q) => p - q);
  return [a].concat(cuts, [b]);
}
function splitCellOutsideRect(x0, y0, x1, y1, rect) {
  const xs = cutLines(x0, x1, rect.x0, rect.x1);
  const ys = cutLines(y0, y1, rect.y0, rect.y1);
  const out = [];
  for (let i = 0; i + 1 < xs.length; i++) {
    for (let j = 0; j + 1 < ys.length; j++) {
      const cx = (xs[i] + xs[i + 1]) / 2, cy = (ys[j] + ys[j + 1]) / 2;
      if (cx > rect.x0 && cx < rect.x1 && cy > rect.y0 && cy < rect.y1) continue;   // 落在挖空区内
      out.push([xs[i], ys[j], xs[i + 1], ys[j + 1]]);
    }
  }
  return out;
}
const insideRect = (x, y, rect) => (x > rect.x0 && x < rect.x1 && y > rect.y0 && y < rect.y1);
/* 点是否在闭合折线（[[x,y],...]）内：射线法 */
function pointInRing(ring, x, y) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i], b = ring[j];
    if (((a[1] > y) !== (b[1] > y)) && (x < (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]) + a[0])) inside = !inside;
  }
  return inside;
}

/* ---------------- 主河槽骨架 ---------------- */
/* 沿 bankIds[0] 逐顶点向 bankIds[1] 求最近点取中点得到中心线，再按 corridorStationMm 重采样成断面。
 * 每个断面记录两岸端点 pA/pB、槽宽、以及沿链路的弧长（供 infoIn 定位）。 */
function corridorFrame(banks, bankIds, params, box) {
  const A = polyOf(banks, bankIds[0]);
  const B = polyOf(banks, bankIds[1]);
  if (!A || !B) return null;
  const mid = A.map(p => {
    const c = closestOnPolyline(B, p[0], p[1]);
    return [(p[0] + c.x) / 2, (p[1] + c.y) / 2];
  });
  /* 中心线按弧长重采样 */
  const stations = [];
  let acc = 0, next = 0;
  for (let i = 0; i + 1 < mid.length; i++) {
    const ax = mid[i][0], ay = mid[i][1];
    const bx = mid[i + 1][0], by = mid[i + 1][1];
    const seg = Math.hypot(bx - ax, by - ay);
    if (seg < 1e-6) continue;
    while (next <= acc + seg) {
      const t = (next - acc) / seg;
      stations.push([lerp(ax, bx, t), lerp(ay, by, t)]);
      next += params.corridorStationMm;
    }
    acc += seg;
  }
  if (!stations.length) return null;
  const last = mid[mid.length - 1];
  if (dist2(stations[stations.length - 1][0], stations[stations.length - 1][1], last[0], last[1]) > 1) stations.push(last);

  const st = [];
  let arc = 0;
  for (let i = 0; i < stations.length; i++) {
    const s = stations[i];
    const a = closestOnPolyline(A, s[0], s[1]);
    const b = closestOnPolyline(B, s[0], s[1]);
    if (i > 0) arc += Math.hypot(s[0] - stations[i - 1][0], s[1] - stations[i - 1][1]);
    st.push({ x: s[0], y: s[1], ax: a.x, ay: a.y, bx: b.x, by: b.y, w: Math.hypot(b.x - a.x, b.y - a.y), arc: arc });
  }
  /* 只在落在 box 内的自由端做收口渐变（另一端若在地形范围外则无需收口） */
  const inBox = p => (p[0] > box.x0 - 1 && p[0] < box.x1 + 1 && p[1] > box.y0 - 1 && p[1] < box.y1 + 1);
  return {
    A: A, B: B, stations: st, totalArc: arc,
    taperStart: inBox(stations[0]),
    taperEnd: inBox(stations[stations.length - 1]),
    taperEndMm: params.endTaperMm,
    bbox: {
      x0: Math.min(...st.map(s => Math.min(s.ax, s.bx))) - 20000,
      x1: Math.max(...st.map(s => Math.max(s.ax, s.bx))) + 20000,
      y0: Math.min(...st.map(s => Math.min(s.ay, s.by))) - 20000,
      y1: Math.max(...st.map(s => Math.max(s.ay, s.by))) + 20000,
    },
  };
}

/* 定位：返回最近断面序号、横向参数 lat（0=pA 岸、1=pB 岸）、是否落在槽内 */
function infoIn(frame, x, y) {
  if (!frame) return { inside: false, lat: 0, i: -1, taper: 0 };
  const st = frame.stations;
  let bi = 0, bt = 0, bd = Infinity, barc = 0;
  for (let i = 0; i + 1 < st.length; i++) {
    const ax = st[i].x, ay = st[i].y, bx = st[i + 1].x, by = st[i + 1].y;
    const vx = bx - ax, vy = by - ay;
    const L2 = vx * vx + vy * vy;
    let t = L2 > 0 ? ((x - ax) * vx + (y - ay) * vy) / L2 : 0;
    t = clamp(t, 0, 1);
    const px = ax + t * vx, py = ay + t * vy;
    const d = dist2(x, y, px, py);
    if (d < bd) { bd = d; bi = i; bt = t; barc = st[i].arc + t * (st[i + 1].arc - st[i].arc); }
  }
  /* 横向参数用「最近断面的 A→B 方向」投影：横向 0 = 岸 A，1 = 岸 B（越界夹到 ±0.5） */
  const a = st[bi];
  const ex = a.bx - a.ax, ey = a.by - a.ay;
  const L2 = ex * ex + ey * ey;
  let lat = L2 > 0 ? ((x - a.ax) * ex + (y - a.ay) * ey) / L2 : 0;
  lat = clamp(lat, -0.5, 1.5);
  const inside = (lat > 0 && lat < 1);
  /* 自由端收口：靠近端点时把开凿强度渐变到 0，避免河道端头出现断崖 */
  const T = Math.max(1, frame.taperEndMm || 0);
  let taper = 1;
  if (frame.taperStart) taper = Math.min(taper, smoothstep(barc / T));
  if (frame.taperEnd) taper = Math.min(taper, smoothstep((frame.totalArc - barc) / T));
  return { inside: inside, lat: lat, i: bi, barc: barc, taper: taper };
}

/* ---------------- 高程场 ---------------- */
function idw(points, x, y, k, power) {
  const best = [];
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    const d2v = dist2(p[0], p[1], x, y);
    if (d2v < 1) return p[2];
    if (best.length === k && d2v >= best[best.length - 1].d2) continue;
    let j = best.length;
    best.push({ d2: d2v, z: p[2] });
    while (j > 0 && best[j - 1].d2 > best[j].d2) { const t = best[j - 1]; best[j - 1] = best[j]; best[j] = t; j--; }
    if (best.length > k) best.pop();
  }
  if (!best.length) return NaN;
  let sw = 0, sz = 0;
  for (const b of best) { const w = 1 / Math.pow(b.d2, power / 2); sw += w; sz += w * b.z; }
  return sz / sw;
}

/* 生成地形网格高程：ctx = { data, level:{grade}, wallAabb, params } */
function buildField(ctx) {
  const params = ctx.params;
  const wall = ctx.wallAabb;
  const warnings = [];
  const g = params.gridMm;
  /* 网格边界对齐到 gridMm：向外取整，保证地形盒全覆盖 墙体 AABB ± marginMm */
  const snapLo = v => Math.floor(v / g) * g;
  const snapHi = v => Math.ceil(v / g) * g;
  const box = {
    x0: snapLo(wall.x0 - params.marginMm), x1: snapHi(wall.x1 + params.marginMm),
    y0: snapLo(wall.y0 - params.marginMm), y1: snapHi(wall.y1 + params.marginMm),
  };
  const nx = Math.round((box.x1 - box.x0) / g);
  const ny = Math.round((box.y1 - box.y0) / g);
  const vw = nx + 1, vh = ny + 1;
  const z = new Float64Array(vw * vh);
  const pin = new Uint8Array(vw * vh);
  const hole = new Uint8Array(vw * vh);
  const depth = new Float32Array(vw * vh);

  const platformZ = ctx.level.grade - params.platformSinkMm;
  /* 压平范围必须与场地轮廓一致 —— 早先用「墙体 AABB 外扩 platformOffsetMm」的矩形，
     矩形越出场地轮廓到河道一侧，把岸坡抬成 1.2 m 高的台地（实测 +1238 mm / 108 m²）
     并啃出 −491 mm 的凹坑，与护坡、地形互相穿插成碎片。改成按场地轮廓逐点判断。 */
  const siteRing = (ctx.data && ctx.data.site && Array.isArray(ctx.data.site.outlineModelMm) &&
                    ctx.data.site.outlineModelMm.length >= 3) ? ctx.data.site.outlineModelMm : null;
  if (!siteRing) warnings.push('site-context 里没有场地轮廓（site.outlineModelMm），地形不做场平压平');

  /* 主河槽骨架 */
  const mc = (ctx.data.riverChannel && ctx.data.riverChannel.mainChannel) || {};
  const bankIds = Array.isArray(mc.bankIds) && mc.bankIds.length >= 2 ? mc.bankIds : [1, 2];
  let frame = corridorFrame(ctx.data.riverChannel ? ctx.data.riverChannel.banks : null, bankIds, params, box);
  if (!frame) warnings.push('未能从 site-context 取出主河槽岸线（bankIds=' + bankIds.join(',') + '），跳过河道建模');
  if (frame) frame.taperEndMm = params.endTaperMm;

  /* 高程点分类：槽内点 → 河床场，槽外点 → 地面场 */
  const all = (ctx.data.elevationPoints && ctx.data.elevationPoints.points) || [];
  const ptsIn = [], ptsOut = [];
  for (const p of all) {
    const x = p[3], y = p[4], zz = p[6];
    if (!isFinite(x) || !isFinite(y) || !isFinite(zz)) continue;
    if (x < box.x0 || x > box.x1 || y < box.y0 || y > box.y1) continue;   // 范围外的点不参与
    if (frame && infoIn(frame, x, y).inside) ptsIn.push([x, y, zz]);
    else ptsOut.push([x, y, zz]);
  }
  if (!ptsIn.length) warnings.push('河槽内没有高程点，河床按两侧地面推得');

  const band = clamp(params.bankBlend, 0.02, 0.49);
  let nanFallback = 0;
  for (let j = 0; j < vh; j++) {
    const y = box.y0 + j * g;
    for (let i = 0; i < vw; i++) {
      const x = box.x0 + i * g;
      const idx = j * vw + i;
      if (insideRect(x, y, wall)) { hole[idx] = 1; }
      if (siteRing && pointInRing(siteRing, x, y)) {
        pin[idx] = 1;
        z[idx] = platformZ;
        continue;
      }
      const land = idw(ptsOut, x, y, params.idwK, params.idwPower);
      const zb = land;
      let info = null;
      if (frame && x > frame.bbox.x0 && x < frame.bbox.x1 && y > frame.bbox.y0 && y < frame.bbox.y1) {
        info = infoIn(frame, x, y);
      }
      if (info && info.inside) {
        const bed = ptsIn.length ? idw(ptsIn, x, y, params.idwK, params.idwPower) : land;
        const w = smoothstep(info.lat / band) * smoothstep((1 - info.lat) / band) * info.taper;
        const chan = Math.min(bed, land);
        z[idx] = lerp(land, chan, w);
        depth[idx] = land - z[idx];
      } else {
        z[idx] = zb;
      }
      if (!isFinite(z[idx])) { z[idx] = isFinite(land) ? land : platformZ; nanFallback++; }
    }
  }
  if (nanFallback) warnings.push(nanFallback + ' 个网格点高程插值失败，已回退到两侧地面/平台高程');

  const zi = (i, j) => j * vw + i;
  const free = idx => (!pin[idx] && !hole[idx]);
  const nbrs = (i, j) => {
    const out = [];
    if (i > 0) out.push(zi(i - 1, j));
    if (i < nx) out.push(zi(i + 1, j));
    if (j > 0) out.push(zi(i, j - 1));
    if (j < ny) out.push(zi(i, j + 1));
    return out;
  };

  /* 3×3 中值：winAt 返回升序邻域窗口（含自身），不足 5 个点返回 null */
  const winAt = (i, j) => {
    const win = [];
    for (let dj = -1; dj <= 1; dj++) {
      for (let di = -1; di <= 1; di++) {
        const ii = i + di, jj = j + dj;
        if (ii < 0 || ii > nx || jj < 0 || jj > ny) continue;
        const k = zi(ii, jj);
        if (hole[k]) continue;
        win.push(z[k]);
      }
    }
    if (win.length < 5) return null;
    win.sort((a, b) => a - b);
    return win;
  };
  const medianDev = (i, j) => {
    const win = winAt(i, j);
    if (!win) return 0;
    return Math.abs(z[zi(i, j)] - win[Math.floor(win.length / 2)]);
  };

  /* 1) 去刺：3×3 中值与自身差超阈值则拉回中值（去掉个别异常高程点造成的尖点/尖坑） */
  let spikeRaw = 0;
  for (let j = 0; j < vh; j++) {
    for (let i = 0; i < vw; i++) {
      const idx = zi(i, j);
      if (!free(idx)) continue;
      const win = winAt(i, j);
      if (!win) continue;
      const med = win[Math.floor(win.length / 2)];
      const dev = Math.abs(z[idx] - med);
      spikeRaw = Math.max(spikeRaw, dev);
      if (dev > params.despikeMm) z[idx] = med;
    }
  }

  /* 2) 受约束拉普拉斯平滑：坡度大的地方少平滑（保住岸坡），平台/挖空区不动 */
  for (let it = 0; it < params.smoothIters; it++) {
    const src = z.slice();
    for (let j = 0; j < vh; j++) {
      for (let i = 0; i < vw; i++) {
        const idx = zi(i, j);
        if (!free(idx)) continue;
        const nb = nbrs(i, j).filter(k => !hole[k]);
        if (!nb.length) continue;
        let sum = 0, slope = 0;
        for (const k of nb) {
          sum += src[k];
          slope = Math.max(slope, Math.abs(src[k] - src[idx]) / g);
        }
        const avg = sum / nb.length;
        const lam = params.smoothLambda * (1 - clamp(slope / params.slopeMax, 0, 0.85));
        z[idx] = src[idx] + lam * (avg - src[idx]);
      }
    }
  }

  /* 3) 软坡度：超过目标坡（1:5）的地方往目标坡拉，把场平到自然地面的落差摊成缓坡 */
  for (let it = 0; it < params.slopeSoftIters; it++) {
    const src = z.slice();
    for (let j = 0; j < vh; j++) {
      for (let i = 0; i < nx; i++) {
        relaxEdge(zi(i, j), zi(i + 1, j), src, params.slopeTarget, 0.5);
      }
    }
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < vw; i++) {
        relaxEdge(zi(i, j), zi(i, j + 1), src, params.slopeTarget, 0.5);
      }
    }
  }

  /* 4) 硬坡度：超过 1:1 的边两端取均值，保证没有墙状突变 */
  let slopeMax = 0;
  for (let it = 0; it < params.slopeHardIters; it++) {
    const src = z.slice();
    for (let j = 0; j < vh; j++) {
      for (let i = 0; i < nx; i++) {
        relaxEdge(zi(i, j), zi(i + 1, j), src, params.slopeMax, 1.0);
      }
    }
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < vw; i++) {
        relaxEdge(zi(i, j), zi(i, j + 1), src, params.slopeMax, 1.0);
      }
    }
  }

  /* 统计：最终坡度、去刺残差、NaN、平台偏差、范围 */
  let nanCount = 0, zMin = Infinity, zMax = -Infinity, platformDev = 0, platformCnt = 0, holeCnt = 0;
  let spikeMax = 0;
  for (let j = 0; j < vh; j++) {
    for (let i = 0; i < vw; i++) {
      const idx = zi(i, j);
      if (hole[idx]) { holeCnt++; continue; }
      if (!isFinite(z[idx])) { nanCount++; z[idx] = platformZ; }
      zMin = Math.min(zMin, z[idx]);
      zMax = Math.max(zMax, z[idx]);
      if (pin[idx] && !hole[idx]) { platformDev = Math.max(platformDev, Math.abs(z[idx] - platformZ)); platformCnt++; }
      spikeMax = Math.max(spikeMax, medianDev(i, j));
      if (i < nx) slopeMax = Math.max(slopeMax, Math.abs(z[zi(i + 1, j)] - z[idx]) / g);
      if (j < ny) slopeMax = Math.max(slopeMax, Math.abs(z[zi(i, j + 1)] - z[idx]) / g);
    }
  }

  /* 松紧边：把 |dz| 超过 limit·dx 的边往限值拉；pinned 顶点不动 */
  function relaxEdge(a, b, src, limit, w) {
    if (hole[a] || hole[b]) return;
    const dx = g;
    const dz = src[b] - src[a];
    const lim = limit * dx;
    const excess = Math.abs(dz) - lim;
    if (excess <= 0) return;
    const s = dz > 0 ? 1 : -1;
    const pa = pin[a], pb = pin[b];
    if (pa && pb) return;
    const share = (pa || pb) ? excess : excess / 2;
    if (!pa) z[a] += s * share * w;
    if (!pb) z[b] -= s * share * w;
  }

  return {
    box: box, nx: nx, ny: ny, vw: vw, vh: vh, gridMm: g,
    z: z, pin: pin, hole: hole, depth: depth,
    wall: wall, platformRing: siteRing, platformZ: platformZ,
    frame: frame, bankIds: bankIds, ptsIn: ptsIn, ptsOut: ptsOut,
    stats: {
      box: box, nx: nx, ny: ny, verts: vw * vh, nanCount: nanCount,
      zMinMm: Math.round(zMin), zMaxMm: Math.round(zMax),
      slopeMax: Math.round(slopeMax * 1000) / 1000,
      spikeMaxMm: Math.round(spikeMax), spikeRawMm: Math.round(spikeRaw),
      platform: { devMaxMm: Math.round(platformDev * 10) / 10, count: platformCnt },
      hole: { count: holeCnt },
      corridor: frame ? {
        stations: frame.stations.length,
        widthMinMm: Math.round(Math.min(...frame.stations.map(s => s.w))),
        widthMaxMm: Math.round(Math.max(...frame.stations.map(s => s.w))),
        inCorridorPts: ptsIn.length, outPts: ptsOut.length,
      } : null,
    },
    warnings: warnings,
  };
}

/* 取网格面上的高程（双线性）；落在挖空区返回 NaN */
function sampleSurface(field, x, y) {
  const { box, gridMm, nx, ny, vw } = field;
  const fx = (x - box.x0) / gridMm, fy = (y - box.y0) / gridMm;
  const i = clamp(Math.floor(fx), 0, nx - 1), j = clamp(Math.floor(fy), 0, ny - 1);
  const u = clamp(fx - i, 0, 1), v = clamp(fy - j, 0, 1);
  const z00 = field.z[j * vw + i], z10 = field.z[j * vw + i + 1];
  const z01 = field.z[(j + 1) * vw + i], z11 = field.z[(j + 1) * vw + i + 1];
  if (field.hole[j * vw + i] || field.hole[j * vw + i + 1] ||
      field.hole[(j + 1) * vw + i] || field.hole[(j + 1) * vw + i + 1]) return NaN;
  return lerp(lerp(z00, z10, u), lerp(z01, z11, u), v);
}

/* ---------------- 水面 ---------------- */
/* 第一步：逐断面取「河床最低点 + 水深」，并被「较低岸顶 − waterClampMm」压住；
 * 第二步：沿程平滑（逐站独立取 min 会出锯齿），平滑后重新压回岸顶限制；
 * 第三步：在最终网格面上求水面与地形的交点，得到该断面的水面线段（岸线自然收口）。 */
function waterProfile(field, params) {
  const frame = field.frame;
  const out = { segs: [], clamped: 0, smoothed: 0, surfMinMm: Infinity, surfMaxMm: -Infinity, gapMinMm: Infinity, gapMaxMm: 0, aboveLandCount: 0, skipped: 0 };
  if (!frame) return out;
  const rect = field.box;
  const depth = params.waterDepthMm;

  /* ---- 阶段 1：断面采样 + 初始水位 ---- */
  const raw = [];
  for (let i = 0; i < frame.stations.length; i++) {
    const s = frame.stations[i];
    const iv = clipSegToRect(s.ax, s.ay, s.bx, s.by, rect);
    if (!iv) continue;                                        // 断面完全在地形范围外
    if (iv[1] - iv[0] < 1e-6) continue;
    const K = Math.max(4, Math.round((s.w * (iv[1] - iv[0])) / params.corridorSampleMm));
    const px = [], py = [], pz = [];
    let bedMin = Infinity;
    for (let k = 0; k <= K; k++) {
      const t = lerp(iv[0], iv[1], k / K);
      const x = lerp(s.ax, s.bx, t), y = lerp(s.ay, s.by, t);
      const zz = sampleSurface(field, x, y);
      if (!isFinite(zz)) { px.push(null); py.push(null); pz.push(NaN); continue; }
      px.push(x); py.push(y); pz.push(zz);
      if (t >= 0 && t <= 1) bedMin = Math.min(bedMin, zz);
    }
    if (!isFinite(bedMin)) { out.skipped++; continue; }
    const zA = sampleSurface(field, s.ax, s.ay), zB = sampleSurface(field, s.bx, s.by);
    const landMin = Math.min(isFinite(zA) ? zA : Infinity, isFinite(zB) ? zB : Infinity);
    const cap = isFinite(landMin) ? landMin - params.waterClampMm : Infinity;
    const wl0 = Math.min(bedMin + depth, cap);
    if (wl0 <= bedMin + 1) { out.skipped++; continue; }        // 水位低于河床：该断面无水
    if (wl0 < bedMin + depth - 1e-6) out.clamped++;
    raw.push({ i: i, bedMin: bedMin, cap: cap, wl: wl0, px: px, py: py, pz: pz, K: K });
  }
  if (!raw.length) return finishWater(out);

  /* ---- 阶段 2：沿程平滑（真实水面连续变化，逐站独立取 min 会出现台阶锯齿） ---- */
  const iters = Math.max(0, Math.round(params.waterSmoothIters));
  for (let it = 0; it < iters; it++) {
    const src = raw.map(r => r.wl);
    for (let k = 1; k + 1 < raw.length; k++) raw[k].wl = (src[k - 1] + 2 * src[k] + src[k + 1]) / 4;
    for (const r of raw) r.wl = Math.min(r.wl, r.cap);          // 平滑不得越岸
  }

  /* ---- 阶段 3：水面线与地形网格的交点 ---- */
  let smoothedMax = 0;
  for (let k = 0; k < raw.length; k++) {
    const r = raw[k];
    if (r.wl <= r.bedMin + 1) { out.skipped++; continue; }      // 平滑后低于河床：无水
    const K = r.K, px = r.px, py = r.py, pz = r.pz, wl = r.wl;
    let kA = -1, kB = -1;
    for (let m = 0; m <= K; m++) { if (isFinite(pz[m]) && pz[m] < wl) { kA = m; break; } }
    for (let m = K; m >= 0; m--) { if (isFinite(pz[m]) && pz[m] < wl) { kB = m; break; } }
    if (kA < 0 || kB < 0 || kB <= kA) { out.skipped++; continue; }
    const interp = (m, dir) => {
      const m2 = m + dir;
      if (m2 < 0 || m2 > K || !isFinite(pz[m2])) return [px[m], py[m]];
      const t = (wl - pz[m]) / (pz[m2] - pz[m]);
      return [lerp(px[m], px[m2], clamp(t, 0, 1)), lerp(py[m], py[m2], clamp(t, 0, 1))];
    };
    out.segs.push({ i: r.i, wl: wl, a: interp(kA, -1), b: interp(kB, +1) });
    out.surfMinMm = Math.min(out.surfMinMm, wl);
    out.surfMaxMm = Math.max(out.surfMaxMm, wl);
    const gap = wl - r.bedMin;
    out.gapMinMm = Math.min(out.gapMinMm, gap);
    out.gapMaxMm = Math.max(out.gapMaxMm, gap);
    if (isFinite(r.cap) && wl > r.cap + 1e-6) out.aboveLandCount++;
  }
  for (let k = 1; k + 1 < raw.length; k++) smoothedMax = Math.max(smoothedMax, Math.abs(raw[k].wl - raw[k - 1].wl));
  out.smoothed = Math.round(smoothedMax);                       // 平滑后相邻断面最大水位差
  return finishWater(out);
}

/* 在「两站之间插值出来的断面」上重新求水面与地形的两个交点（细采样），
 * 返回 a/b 为 [X,Y]（高程由水位决定）。用于把水面条带沿槽细分，避免长四边形把岸线拉成折线锯齿。
 * 断面先按地形盒裁剪：网格外的采样会被 sampleSurface 夹到边界，不裁会让水面伸出地块悬空。 */
function sectionShore(field, f0, f1, t, wl, sampleMm) {
  const ax = lerp(f0.ax, f1.ax, t), ay = lerp(f0.ay, f1.ay, t);
  const bx = lerp(f0.bx, f1.bx, t), by = lerp(f0.by, f1.by, t);
  const iv = clipSegToRect(ax, ay, bx, by, field.box);
  if (!iv || iv[1] - iv[0] < 1e-6) return null;
  const K = Math.max(4, Math.round((Math.hypot(bx - ax, by - ay) * (iv[1] - iv[0])) / sampleMm));
  const pz = [];
  for (let m = 0; m <= K; m++) {
    const s = lerp(iv[0], iv[1], m / K);
    pz.push(sampleSurface(field, lerp(ax, bx, s), lerp(ay, by, s)));
  }
  let kA = -1, kB = -1;
  for (let m = 0; m <= K; m++) if (isFinite(pz[m]) && pz[m] < wl) { kA = m; break; }
  for (let m = K; m >= 0; m--) if (isFinite(pz[m]) && pz[m] < wl) { kB = m; break; }
  if (kA < 0 || kB <= kA) return null;
  const tt = (m, d) => {
    const m2 = m + d;
    let f = m / K;
    if (m2 >= 0 && m2 <= K && isFinite(pz[m2])) f = lerp(m / K, m2 / K, clamp((wl - pz[m]) / (pz[m2] - pz[m]), 0, 1));
    return lerp(iv[0], iv[1], f);
  };
  const tA = tt(kA, -1), tB = tt(kB, +1);
  return { a: [lerp(ax, bx, tA), lerp(ay, by, tA)], b: [lerp(ax, bx, tB), lerp(ay, by, tB)] };
}

function finishWater(out) {
  if (!isFinite(out.surfMinMm)) { out.surfMinMm = null; out.surfMaxMm = null; }
  if (!isFinite(out.gapMinMm)) { out.gapMinMm = null; out.gapMaxMm = null; }
  out.surfMinMm = out.surfMinMm === null ? null : Math.round(out.surfMinMm);
  out.surfMaxMm = out.surfMaxMm === null ? null : Math.round(out.surfMaxMm);
  out.gapMinMm = out.gapMinMm === null ? null : Math.round(out.gapMinMm);
  out.gapMaxMm = out.gapMaxMm === null ? null : Math.round(out.gapMaxMm);
  return out;
}

/* ---------------- 网格 → 几何 ---------------- */
/* 共用一套顶点坐标：地形面与河床面按格子分材质，边界严丝合缝（不重叠、不留缝） */
function build(ctx) {
  const THREE = ctx.THREE;
  const params = ctx.params;
  const field = buildField(ctx);
  const warnings = field.warnings.slice();
  const { nx, ny, vw, vh, z, hole, gridMm: g, box, depth } = field;
  const waterLift = 20;         // 水面相对水位抬升：岸线交点落在网格面上，抬 20 mm 避免共面闪烁与折线切岸
  const lineLift = 20;          // 环境线贴地抬升

  const groups = {
    terrain: { pos: [], idx: [], map: new Map(), tris: 0 },
    bed: { pos: [], idx: [], map: new Map(), tris: 0 },
  };
  function vid(grp, x, y, zz) {
    const key = x + '|' + y;
    let id = grp.map.get(key);
    if (id === undefined) {
      id = grp.pos.length / 3;
      grp.pos.push(x, zz, y);
      grp.map.set(key, id);
    }
    return id;
  }
  function quad(grp, c) {
    /* c = [[x,y,z]×4] 按平面逆时针（v00→v01→v11→v10）给出，法线朝上 */
    const a = vid(grp, c[0][0], c[0][1], c[0][2]);
    const b = vid(grp, c[1][0], c[1][1], c[1][2]);
    const d = vid(grp, c[2][0], c[2][1], c[2][2]);
    const e = vid(grp, c[3][0], c[3][1], c[3][2]);
    grp.idx.push(a, b, d, a, d, e);
    grp.tris += 2;
  }
  const bil = (u, v, z00, z10, z01, z11) =>
    lerp(lerp(z00, z10, u), lerp(z01, z11, u), v);

  /* 水位按断面索引查表（无水的断面为 NaN）。河床材质除「槽内、低于两侧地面 bedMinDepthMm」外，
   * 还要求整格都低于当地水位（z 最大角点 < wl − bedUnderMm）：网格 1.5 m 量化，材质边界若露在
   * 岸上就是一圈阶梯色块（实测成片「梯田」），藏到水面之下后可见岸线只由水面条带定义。 */
  const wp = waterProfile(field, params);
  const stations = field.frame ? field.frame.stations : null;
  const wlAtSt = new Float64Array(stations ? stations.length : 0).fill(NaN);
  for (const s of wp.segs) wlAtSt[s.i] = s.wl;

  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const i00 = j * vw + i, i10 = i00 + 1, i01 = i00 + vw, i11 = i01 + 1;
      if (hole[i00] && hole[i10] && hole[i01] && hole[i11]) continue;
      const x0 = box.x0 + i * g, x1 = x0 + g, y0 = box.y0 + j * g, y1 = y0 + g;
      const cen = info4(field, (x0 + x1) / 2, (y0 + y1) / 2);
      const carve = (depth[i00] + depth[i10] + depth[i01] + depth[i11]) / 4;
      const wl = cen && cen.i >= 0 && cen.i < wlAtSt.length ? wlAtSt[cen.i] : NaN;
      const zTop = Math.max(z[i00], z[i10], z[i01], z[i11]);
      const underWater = params.bedUnderMm <= 0
        ? true : (isFinite(wl) && zTop < wl - params.bedUnderMm);
      const isBed = underWater && cen && cen.inside && carve > params.bedMinDepthMm;
      const grp = isBed ? groups.bed : groups.terrain;
      const parts = splitCellOutsideRect(x0, y0, x1, y1, field.wall);
      for (const p of parts) {
        const c = [];
        const us = [(p[0] - x0) / g, (p[2] - x0) / g];
        const vs = [(p[1] - y0) / g, (p[3] - y0) / g];
        const zs = [
          bil(us[0], vs[0], z[i00], z[i10], z[i01], z[i11]),
          bil(us[0], vs[1], z[i00], z[i10], z[i01], z[i11]),
          bil(us[1], vs[1], z[i00], z[i10], z[i01], z[i11]),
          bil(us[1], vs[0], z[i00], z[i10], z[i01], z[i11]),
        ];
        c.push([p[0], p[1], zs[0]]);
        c.push([p[0], p[3], zs[1]]);
        c.push([p[2], p[3], zs[2]]);
        c.push([p[2], p[1], zs[3]]);
        quad(grp, c);
      }
    }
  }
  function info4(f, x, y) {
    if (!f.frame) return null;
    const b = f.frame.bbox;
    if (x < b.x0 || x > b.x1 || y < b.y0 || y > b.y1) return null;
    return infoIn(f.frame, x, y);
  }

  /* 水面：断面之间连成条带（只在相邻断面间连，避免跨断面拉出斜条）。
   * 条带沿槽按 corridorSampleMm 细分：站距 2 m、槽宽 27–36 m 的单个四边形会把
   * 岸线拉成米级锯齿（实测二阶差分 ≈1 m），细分后岸线贴合网格真实交点（≈0.1 m）。 */
  const wpos = [], widx = [];
  let prev = null, wRev = null;
  const wStep = Math.max(100, params.corridorSampleMm);
  const put = (from, to) => {
    const base = wpos.length / 3;
    /* 顶点按 (X, 高程, Y) 入缓冲；a/b 是 [X,Y]，高程用本站水位 + waterLift */
    const za = from.wl + waterLift, zb = to.wl + waterLift;
    const fa = [from.a[0], za, from.a[1]], fb = [from.b[0], za, from.b[1]];
    const ta = [to.a[0], zb, to.a[1]], tb = [to.b[0], zb, to.b[1]];
    if (wRev === null) {
      /* 绕序由数据决定：横向(岸A→岸B) × 纵向(本站→下站) 的 2D 叉积 > 0 时需反向才能让法线朝上 */
      const ux = fb[0] - fa[0], uz = fb[2] - fa[2];
      const vx = ta[0] - fa[0], vz = ta[2] - fa[2];
      wRev = (ux * vz - uz * vx) > 0;
    }
    if (!wRev) wpos.push(fa[0], fa[1], fa[2], fb[0], fb[1], fb[2], tb[0], tb[1], tb[2], ta[0], ta[1], ta[2]);
    else wpos.push(fb[0], fb[1], fb[2], fa[0], fa[1], fa[2], ta[0], ta[1], ta[2], tb[0], tb[1], tb[2]);
    widx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  };
  for (let k = 0; k + 1 < wp.segs.length; k++) {
    const s0 = wp.segs[k], s1 = wp.segs[k + 1];
    if (!stations || s1.i !== s0.i + 1) continue;          // 中间有干断面：断开
    const f0 = stations[s0.i], f1 = stations[s1.i];
    const n = Math.max(1, Math.round(Math.hypot(f1.x - f0.x, f1.y - f0.y) / wStep));
    let cur = { a: s0.a, b: s0.b, wl: s0.wl };
    for (let q = 1; q <= n; q++) {
      const t = q / n;
      let nxt;
      if (q === n) nxt = { a: s1.a, b: s1.b, wl: s1.wl };
      else {
        const wl = lerp(s0.wl, s1.wl, t);
        const sh = sectionShore(field, f0, f1, t, wl, wStep);
        nxt = sh ? { a: sh.a, b: sh.b, wl: wl } : null;
      }
      if (!nxt) continue;                                   // 该细分断面找不到交点：跨过去（下一片更长）
      put(cur, nxt);
      cur = nxt;
    }
  }

  /* 裙边：地块四周沿地形面往下 skirtMm，避免低视角看到背面/悬空 */
  const spos = [], sidx = [];
  const edge = [];
  for (let i = 0; i <= nx; i++) edge.push([box.x0 + i * g, box.y0]);
  for (let j = 1; j <= ny; j++) edge.push([box.x1, box.y0 + j * g]);
  for (let i = nx - 1; i >= 0; i--) edge.push([box.x0 + i * g, box.y1]);
  for (let j = ny - 1; j >= 1; j--) edge.push([box.x0, box.y0 + j * g]);
  for (let e = 0; e < edge.length; e++) {
    const p = edge[e], q = edge[(e + 1) % edge.length];
    const zp = sampleSurface(field, p[0], p[1]), zq = sampleSurface(field, q[0], q[1]);
    if (!isFinite(zp) || !isFinite(zq)) continue;
    const base = spos.length / 3;
    spos.push(p[0], zp, p[1], q[0], zq, q[1], q[0], zq - params.skirtMm, q[1], p[0], zp - params.skirtMm, p[1]);
    /* 逆时针走边 → 该绕序法线朝外 */
    sidx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }

  function geo(pos, idx) {
    const g2 = new THREE.BufferGeometry();
    g2.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    if (idx.length) g2.setIndex(idx);
    g2.computeVertexNormals();
    g2.computeBoundingSphere();
    return g2;
  }

  /* 环境线：轮廓/岸线贴地 */
  const lines = [];
  const surfPt = (x, y) => {
    const zz = sampleSurface(field, x, y);
    return isFinite(zz) ? [x, zz + lineLift, y] : null;
  };
  const rectLoop = (r) => {
    const pts = [[r.x0, r.y0], [r.x1, r.y0], [r.x1, r.y1], [r.x0, r.y1]];
    const out = [];
    for (const p of pts) { const q = surfPt(p[0], p[1]); if (q) out.push(q); }
    return out.length >= 3 ? out : null;
  };
  const push = (pts) => { if (pts && pts.length >= 2) lines.push({ pts: pts }); };
  push(rectLoop(box));
  /* 场平轮廓线不再画：那里已被 DLSS 面盖住（道路/护坡的顶面轮廓由 js/siteworks.js 出线） */
  push(rectLoop(field.wall));
  const pool = ctx.data.intakePool && ctx.data.intakePool.boundsModelMm;
  if (pool) push(rectLoop(pool));
  const banks = (ctx.data.riverChannel && ctx.data.riverChannel.banks) || [];
  const mainIds = field.bankIds;
  for (const b of banks) {
    const poly = (b.outlineModelMm || []).map(p => [p[0], p[1]]);
    if (poly.length < 2) continue;
    const runs = clipPolylineToRect(poly, box);
    for (const run of runs) {
      const pts = [];
      for (const p of run) { const q = surfPt(p[0], p[1]); if (q) pts.push(q); }
      push(pts);
    }
  }
  const lineRuns = lines.length;

  return {
    terGeo: geo(groups.terrain.pos, groups.terrain.idx),
    bedGeo: geo(groups.bed.pos, groups.bed.idx),
    waterGeo: geo(wpos, widx),
    skirtGeo: geo(spos, sidx),
    lines: lines,
    field: field,
    stats: Object.assign({}, field.stats, {
      water: {
        stations: wp.segs.length, clamped: wp.clamped, skipped: wp.skipped, maxStepMm: wp.smoothed,
        surfMinMm: wp.surfMinMm, surfMaxMm: wp.surfMaxMm,
        gapMinMm: wp.gapMinMm, gapMaxMm: wp.gapMaxMm, aboveLandCount: wp.aboveLandCount,
        reversed: !!wRev,
      },
      counts: {
        terrainTris: groups.terrain.tris, bedTris: groups.bed.tris,
        waterTris: widx.length / 3, skirtTris: sidx.length / 3,
        terrainVerts: groups.terrain.pos.length / 3, bedVerts: groups.bed.pos.length / 3,
        lineRuns: lineRuns, mainBankIds: mainIds.slice(),
      },
    }),
    warnings: warnings,
  };
}

const api = {
  version: '0.1',
  DEFAULT_PARAMS: DEFAULT_PARAMS,
  resolveParams: resolveParams,
  corridorFrame: corridorFrame,
  infoIn: infoIn,
  buildField: buildField,
  sampleSurface: sampleSurface,
  waterProfile: waterProfile,
  clipPolylineToRect: clipPolylineToRect,
  build: build,
};

if (typeof window !== 'undefined') window.WMEnv = api;
if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
