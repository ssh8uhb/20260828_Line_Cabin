/* 道路 / 护坡（总平面图 DLSS、DLSS-斜坡 图层）v1
 *
 * 输入: white-model-viewer/data/site-context.json 的 site / roads / slopes 字段
 *      + WMEnv.build() 得到的地形场（道路与护坡贴地取样）
 * 用法: WMSite.build({ data, THREE, level, wallAabb, groundZ, params })
 *       → { roadGeo, slopeGeo, stats, warnings }
 *       WMSite.siteCheck(state)
 *
 * 约定（与 docs/DATA-MODEL.md 第 14 节一致）:
 *   单位 mm；平面 X/Y 与查看器 JSON 同一套坐标，Z = 绝对标高×1000 − 166759（与白模同一 Z）
 *   DLSS 面 = roads 整环（先按地形盒裁剪），一趟三角化出一块实体，只有「道路」一个材质岛。
 *          场地轮廓（site）只当内部的一条描线用，不再单独出实体：DLSS 面本身是一个连通面，
 *          场地轮廓与道路外环是同一条 CAD 线上的两条描线（实测 88.7 m 场地边界全部贴在
 *          道路外环上），早先按平面位置把它拆成「场地」「道路」两个材质岛时，分界按三角形
 *          重心判定，在场地轮廓上留下一条锯齿状的明暗斜带（人视图里像棋盘格斜纹带）。
 *   建筑范围（site 多边形内）: 顶面 = level.grade（室外地坪，平的），与建筑周边齐平；
 *          建筑墙体 AABB 处挖空（否则会把下沉的水泵间埋掉），与地形平台的挖空一致
 *   道路范围（site 之外的 DLSS 面）: 顶面沿地形面起伏，靠 site 边界 roadBlendMm 内
 *          过渡到 level.grade（正好在边界上取到室外地坪，与建筑周边齐平无台阶），
 *          整体再抬 roadLiftMm（不抬会与地形面共面闪烁）
 *   底面 = 顶面 − roadThkMm；siteThkMm 只作为护坡在无地形数据时的兜底标高参考
 *   护坡 = slopes 环；坡顶线（环的首尾连线，落在场地西边界）取 level.grade，
 *          坡底外边界取地形/河床面，中间按「到坡顶线距离 : 到外边界距离」线性过渡；
 *          底面至少埋入自然地面 groundClearMm（顶面离地时自动加厚，不会悬空）
 * 纯数学部分（resolveParams / refineMesh / clipRectRing）不依赖 THREE，Node 侧可 require 跑数值自检。
 */
(function () {
'use strict';

const DEFAULT_PARAMS = {
  siteThkMm: 500,       // 护坡无地形数据时的兜底标高参考（DLSS 面的厚度见 roadThkMm）
  roadThkMm: 500,       // DLSS 面（场地 + 道路）的厚度
  slopeThkMm: 500,      // 护坡实体厚度下限
  roadLiftMm: 50,       // 道路顶面高出自然地面的量
  roadBlendMm: 5000,    // 道路靠场地边界该距离内过渡到室外地坪
  groundClearMm: 50,    // 护坡底面至少埋入自然地面的深度
  triMaxMm: 2000,       // 顶面三角细分目标边长（与地形网格同量级）
  triMaxRounds: 7,      // 细分轮数上限
  wallInsetMm: 50,      // 场地挖空边（建筑外墙 AABB）向内收的量：让场地塞进墙体内部，避免与墙面共面闪烁
};

function resolveParams(src) {
  const p = {};
  for (const k in DEFAULT_PARAMS) p[k] = DEFAULT_PARAMS[k];
  if (src && typeof src === 'object') {
    for (const k in DEFAULT_PARAMS) {
      if (typeof src[k] === 'number' && isFinite(src[k]) && src[k] > 0) p[k] = src[k];
    }
  }
  return p;
}

/* ---------------- 基础几何 ---------------- */
const clamp = (v, a, b) => (v < a ? a : (v > b ? b : v));
const lerp = (a, b, t) => a + (b - a) * t;
const smoothstep = t => { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); };

function ringAreaMm2(ring) {
  let a = 0;
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i], q = ring[(i + 1) % ring.length];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
}
function pointInRing(ring, x, y) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i], b = ring[j];
    if (((a[1] > y) !== (b[1] > y)) && (x < (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]) + a[0])) inside = !inside;
  }
  return inside;
}
/* 折线上离 (x,y) 最近的点 */
function closestOnRing(ring, x, y) {
  const n = ring.length;
  let best = { x: ring[0][0], y: ring[0][1], d: Infinity };
  for (let i = 0; i < n; i++) {
    const a = ring[i], b = ring[(i + 1) % n];
    const vx = b[0] - a[0], vy = b[1] - a[1];
    const L2 = vx * vx + vy * vy;
    let t = L2 > 0 ? ((x - a[0]) * vx + (y - a[1]) * vy) / L2 : 0;
    t = clamp(t, 0, 1);
    const px = a[0] + t * vx, py = a[1] + t * vy;
    const d = Math.hypot(x - px, y - py);
    if (d < best.d) best = { x: px, y: py, d: d };
  }
  return best;
}
function distToRing(ring, x, y) { return closestOnRing(ring, x, y).d; }

/* 开口折线（不连首尾）上离 (x,y) 最近的点 */
function closestOnChain(chain, x, y) {
  let best = { x: chain[0][0], y: chain[0][1], d: Infinity };
  for (let i = 0; i + 1 < chain.length; i++) {
    const a = chain[i], b = chain[i + 1];
    const vx = b[0] - a[0], vy = b[1] - a[1];
    const L2 = vx * vx + vy * vy;
    let t = L2 > 0 ? ((x - a[0]) * vx + (y - a[1]) * vy) / L2 : 0;
    t = clamp(t, 0, 1);
    const px = a[0] + t * vx, py = a[1] + t * vy;
    const d = Math.hypot(x - px, y - py);
    if (d < best.d) best = { x: px, y: py, d: d };
  }
  return best;
}
function distToChain(chain, x, y) { return closestOnChain(chain, x, y).d; }
/* 点到线段的距离 */
function distToSeg(a, b, x, y) {
  const vx = b[0] - a[0], vy = b[1] - a[1];
  const L2 = vx * vx + vy * vy;
  let t = L2 > 0 ? ((x - a[0]) * vx + (y - a[1]) * vy) / L2 : 0;
  t = clamp(t, 0, 1);
  return Math.hypot(x - (a[0] + t * vx), y - (a[1] + t * vy));
}

/* 凸窗口裁剪（Sutherland–Hodgman）：闭环 vs 矩形，用于把道路裁到地形盒内 */
function clipRectRing(ring, rect) {
  const edges = [
    { in: p => p[0] >= rect.x0, cut: (a, b) => [rect.x0, slide(a, b, rect.x0, 0)] },
    { in: p => p[0] <= rect.x1, cut: (a, b) => [rect.x1, slide(a, b, rect.x1, 0)] },
    { in: p => p[1] >= rect.y0, cut: (a, b) => [slide(a, b, rect.y0, 1), rect.y0] },
    { in: p => p[1] <= rect.y1, cut: (a, b) => [slide(a, b, rect.y1, 1), rect.y1] },
  ];
  let out = ring.map(p => [p[0], p[1]]);
  for (const e of edges) {
    const inp = out, next = [];
    for (let i = 0; i < inp.length; i++) {
      const a = inp[i], b = inp[(i + 1) % inp.length];
      const ia = e.in(a), ib = e.in(b);
      if (ia) next.push(a);
      if (ia !== ib) next.push(e.cut(a, b));
    }
    out = next;
    if (!out.length) return [];
  }
  return out;
}
/* 线段 a→b 与直线（分量 axis = v）的交点：返回另一分量的值 */
function slide(a, b, v, axis) {
  const o = 1 - axis;
  const d = b[axis] - a[axis];
  const t = Math.abs(d) < 1e-12 ? 0 : (v - a[axis]) / d;
  return a[o] + (b[o] - a[o]) * t;
}

/* 折线加密：长于 stepMm 的段等分（闭合环；三角网边界与顶面轮廓线都先用它铺点） */
function densifyRing(pts, stepMm) {
  const out = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const k = Math.max(1, Math.ceil(L / stepMm));
    for (let j = 0; j < k; j++) out.push([lerp(a[0], b[0], j / k), lerp(a[1], b[1], j / k)]);
  }
  return out;
}

/* 三角形细化：按最长边打断，共享边的三角形同步打断（不产生 T 型缝）。
 * verts = [[x,y],…]，tris = [[i,j,k],…]，返回同样的结构。纯数学，不依赖 THREE。 */
function refineMesh(verts, tris, maxEdge, maxRounds) {
  let V = verts.map(p => [p[0], p[1]]);
  let T = tris.map(t => t.slice());
  const midCache = new Map();
  const key = (a, b) => (a < b ? a + '_' + b : b + '_' + a);
  for (let round = 0; round < (maxRounds || 7); round++) {
    const mark = new Set();
    for (const t of T) {
      for (let e = 0; e < 3; e++) {
        const a = t[e], b = t[(e + 1) % 3];
        const L = Math.hypot(V[a][0] - V[b][0], V[a][1] - V[b][1]);
        if (L > maxEdge) mark.add(key(a, b));
      }
    }
    if (!mark.size) break;
    const midOf = k => {
      let m = midCache.get(k);
      if (m === undefined) {
        const [a, b] = k.split('_').map(Number);
        m = V.length;
        V.push([(V[a][0] + V[b][0]) / 2, (V[a][1] + V[b][1]) / 2]);
        midCache.set(k, m);
      }
      return m;
    };
    const next = [];
    for (const t of T) {
      const cuts = [];
      for (let e = 0; e < 3; e++) {
        const k = key(t[e], t[(e + 1) % 3]);
        if (mark.has(k)) cuts.push({ e: e, m: midOf(k) });
      }
      if (!cuts.length) { next.push(t); continue; }
      const mAt = e => { const c = cuts.find(x => x.e === e); return c ? c.m : -1; };
      if (cuts.length === 3) {
        const m01 = mAt(0), m12 = mAt(1), m20 = mAt(2);
        next.push([t[0], m01, m20], [m01, t[1], m12], [m20, m12, t[2]], [m01, m12, m20]);
      } else if (cuts.length === 2) {
        const e0 = cuts[0].e, e1 = cuts[1].e;
        /* 两条被打断的边相邻时把三角形切成 3 块；不相邻（e0=0,e1=2）等价，统一按相邻处理 */
        const A = t[e0], B = t[(e0 + 1) % 3], C = t[(e0 + 2) % 3];
        const mA = mAt(e0);                       // 边 A→B 的中点
        if (e1 === (e0 + 1) % 3) {                // 边 B→C 也打断
          const mB = mAt(e1);
          next.push([A, mA, C], [mA, B, mB], [mA, mB, C]);
        } else {                                   // 边 C→A 也打断
          const mC = mAt(e1);
          next.push([A, mA, mC], [mA, B, mC], [B, C, mC]);
        }
      } else {
        const e0 = cuts[0].e;
        const v0 = t[e0], v1 = t[(e0 + 1) % 3], v2 = t[(e0 + 2) % 3];
        next.push([v0, cuts[0].m, v2], [cuts[0].m, v1, v2]);
      }
    }
    T = next;
  }
  return { verts: V, tris: T };
}

/* ---------------- 薄板网格 ---------------- */
/* 由「外轮廓 + 若干洞」生成实体薄板：顶面按 zTopOf 起伏、底面 = bottomOf、四周立侧面。
 * 顶面三角先按 maxEdgeMm 细化（保证顶面能贴合地形），侧面沿真实边界生成（无缝隙）。
 * opt.regionOf(x, y) 给定时，同一趟三角化按平面位置拆成若干几何体（材质岛）；
 * 当前 DLSS 面只用一块实体（不传 regionOf），场地轮廓只参与顶面高程规则。 */
function buildSlab(THREE, opt) {
  /* 边界先按最大边长加密：earcut 的直接产物在细长条（道路）上会留下上百米的长边，
   * 全靠 refineMesh 打断会指数级膨胀（实测 8 万三角形），加密后只需 1~2 轮 */
  const dens = ring => (opt.maxEdgeMm > 0 ? densifyRing(ring, opt.maxEdgeMm) : ring.slice());
  const contour = dens(opt.outer).map(p => new THREE.Vector2(p[0], p[1]));
  const holes = (opt.holes || []).map(h => dens(h).map(p => new THREE.Vector2(p[0], p[1])));
  const faces = THREE.ShapeUtils.triangulateShape(contour, holes);
  const flat = [];
  for (const c of contour) flat.push([c.x, c.y]);
  for (const h of holes) for (const c of h) flat.push([c.x, c.y]);
  /* earcut 在洞与外环贴得很近处会切出横跨洞的大三角（实测：道路环沿场地东边界走，
   * 一个 11 m² 的三角三顶点全落在洞边上、内部横跨场地，顶面与场地顶面共面 → 远景里闪成"梳齿"带）。
   * 所以洞必须严格落在外环内部：只挖建筑外墙 AABB（远离道路外环）。
   * 场地轮廓不当洞（见 build() 里道路段的说明）。下面的重心过滤是兜底：
   * 真出现完全落在洞里的三角时宁可丢掉（洞由实体填充，不会露空）。 */
  const holeRings2 = holes.map(h => h.map(p => [p.x, p.y]));
  const faces2 = faces.filter(f => {
    const a = flat[f[0]], b = flat[f[1]], c = flat[f[2]];
    const gx = (a[0] + b[0] + c[0]) / 3, gy = (a[1] + b[1] + c[1]) / 3;
    for (let k = 0; k < holeRings2.length; k++) if (pointInRing(holeRings2[k], gx, gy)) return false;
    return true;
  });
  let verts = flat, tris = faces2.map(f => [f[0], f[1], f[2]]);
  if (opt.maxEdgeMm > 0) {
    const r = refineMesh(verts, tris, opt.maxEdgeMm, opt.maxRounds);
    verts = r.verts; tris = r.tris;
  }
  const n = verts.length;
  const top = new Float64Array(n), bot = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const x = verts[i][0], y = verts[i][1];
    /* 顶面高程、底面高程都由调用方决定 */
    const zt = opt.zTopOf(x, y);
    top[i] = zt;
    bot[i] = opt.bottomOf(x, y, zt);
  }
  /* 区域划分：只决定每个三角形/侧面归到哪个材质岛，不影响几何与高程 */
  const regionOf = opt.regionOf || null;
  const nRegion = regionOf ? Math.max(1, opt.regionCount | 0) : 1;
  const triRegion = new Uint8Array(tris.length);
  for (let i = 0; i < tris.length; i++) {
    const a = verts[tris[i][0]], b = verts[tris[i][1]], c = verts[tris[i][2]];
    triRegion[i] = regionOf ? regionOf((a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3) : 0;
  }
  /* 侧面：只被一个三角形用到的边 = 边界边；洞边跳过（见下） */
  const edgeUse = new Map();
  for (let ti = 0; ti < tris.length; ti++) {
    const t = tris[ti];
    for (let e = 0; e < 3; e++) {
      const a = t[e], b = t[(e + 1) % 3];
      const k = a < b ? a + '_' + b : b + '_' + a;
      const rec = edgeUse.get(k);
      if (rec) rec.n++;
      else edgeUse.set(k, { n: 1, a: a, b: b, c: t[(e + 2) % 3], ti: ti });
    }
  }
  /* 洞边的侧墙一律不生成：洞总是被别的实体填满（洞是建筑外墙 AABB），
   * 洞壁和填洞实体的外壁在同一位置完全共面，两面深度相等 → 人视图里闪成"梳齿"花带。
   * 判据必须用几何位置而不是顶点索引区间：refineMesh 会在洞的边上插中点，洞边于是变成
   * 「原洞顶点 + 新增中点」的组合，两端不同时落在洞顶点区间里，索引法漏掉这类边
   * （实测道路仍留有整圈洞壁）。加密与细化都只在线段内部取点，所以端点落在洞折线上即边在洞上。 */
  const holeRings = (opt.holes || []).map(h => h.map(p => [p[0], p[1]]));
  const wallSkipTolMm = 1;
  const onHole = i => {
    const x = verts[i][0], y = verts[i][1];
    for (let k = 0; k < holeRings.length; k++) if (distToRing(holeRings[k], x, y) < wallSkipTolMm) return true;
    return false;
  };
  /* 侧面写成 [顶点号, 层次] 列表（层次 0 = 顶面点，1 = 底面点），拆区域时按同一套索引取坐标 */
  const walls = [];
  for (const rec of edgeUse.values()) {
    if (rec.n !== 1) continue;
    if (onHole(rec.a) && onHole(rec.b)) continue;
    const a = rec.a, b = rec.b, c = rec.c;
    /* 外向水平法线：垂直于 a→b，且背离该三角形（三角形第三个顶点在里侧） */
    let nx = verts[b][1] - verts[a][1], ny = -(verts[b][0] - verts[a][0]);
    if (nx * (verts[c][0] - verts[a][0]) + ny * (verts[c][1] - verts[a][1]) > 0) { nx = -nx; ny = -ny; }
    const P = (i, layer) => [verts[i][0], layer ? bot[i] : top[i], verts[i][1]];
    const p0 = P(a, 0), p1 = P(a, 1), p2 = P(b, 1);
    const ux = p1[0] - p0[0], uy = p1[1] - p0[1], uz = p1[2] - p0[2];
    const vx = p2[0] - p0[0], vy = p2[1] - p0[1], vz = p2[2] - p0[2];
    const wx = uy * vz - uz * vy, wz = ux * vy - uy * vx;
    const quad = [[a, 0], [a, 1], [b, 1], [b, 0]];
    if (wx * nx + wz * ny < 0) quad.reverse();
    walls.push({ quad: quad, region: triRegion[rec.ti] });
  }
  const regions = [];
  for (let r0 = 0; r0 < nRegion; r0++) regions.push(emitRegion(THREE, verts, top, bot, tris, triRegion, walls, r0));
  return { regions: regions, verts: n, top: top, bot: bot, verts2: verts, walls: walls };
}

/* 把一个材质岛的三角面与侧面写成一个 BufferGeometry。
 * 顶面点、底面点各自独立（法线不互相污染），侧面用新顶点（硬边）。 */
function emitRegion(THREE, verts, top, bot, tris, triRegion, walls, region) {
  const pos = [], idx = [], used = [];
  const usedSet = new Set();
  const map = new Map();
  const at = (i, layer) => {
    const k = i * 2 + layer;
    let m = map.get(k);
    if (m === undefined) {
      m = pos.length / 3;
      map.set(k, m);
      pos.push(verts[i][0], layer ? bot[i] : top[i], verts[i][1]);
    }
    return m;
  };
  /* 顶面法线朝上（three.js 坐标 (x, 高度, y)：ny = uz·vx − ux·vz，u/v 取平面坐标，不含高度）；
   * 这里必须用平面 y 而不是高度：用高度算的话平面/近平面三角形恒得 0 或反号，顶面会被翻成朝下，
   * 结果顶面被背面剔除、地形从板里穿出来（截图里的碎块），平面场地整块变为朝下。 */
  let areaMm2 = 0, faceCount = 0;
  for (let ti = 0; ti < tris.length; ti++) {
    if (triRegion[ti] !== region) continue;
    const t = tris[ti];
    const a = verts[t[0]], b = verts[t[1]], c = verts[t[2]];
    const nyv = (b[1] - a[1]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[1] - a[1]);
    areaMm2 += Math.abs(nyv) / 2;
    const f = nyv > 0 ? t : [t[0], t[2], t[1]];
    idx.push(at(f[0], 0), at(f[1], 0), at(f[2], 0));
    idx.push(at(f[2], 1), at(f[1], 1), at(f[0], 1));
    faceCount++;
    for (const i of t) if (!usedSet.has(i)) { usedSet.add(i); used.push(i); }
  }
  let wallQuads = 0;
  for (const w of walls) {
    if (w.region !== region) continue;
    const base = pos.length / 3;
    for (const q of w.quad) pos.push(verts[q[0]][0], q[1] ? bot[q[0]] : top[q[0]], verts[q[0]][1]);
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    wallQuads++;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  return { geo: geo, tris: faceCount * 2 + wallQuads * 2, faceCount: faceCount, wallQuads: wallQuads, verts: used, areaMm2: areaMm2, vertexCount: map.size };
}

/* ---------------- 组装 ---------------- */
function build(ctx) {
  const THREE = ctx.THREE;
  const params = resolveParams(ctx.params);
  const level = ctx.level || {};
  const grade = isFinite(level.grade) ? level.grade : 300;   // 模型惯例：室外地坪 = 绝对标高 168.900 → Z 2141
  const wall = ctx.wallAabb;
  const groundZ = typeof ctx.groundZ === 'function' ? ctx.groundZ : () => null;
  const data = ctx.data || {};
  const warnings = [];
  const out = { roadGeo: null, slopeGeo: null, warnings: warnings, params: params };
  /* 顶面轮廓线（画在实体顶面之上 20 mm；环境线里的地形盒/建筑轮廓由 js/environment.js 出） */
  const LINE_LIFT = 20;
  const lines = [];
  const pushRing = (ring, zOf, stepMm) => {
    if (!ring || ring.length < 3) return;
    const pts = densifyRing(ring, stepMm).map(p => [p[0], zOf(p[0], p[1]) + LINE_LIFT, p[1]]);
    lines.push({ pts: pts });
  };

  const ground = (x, y) => {
    const z = groundZ(x, y);
    return (z === null || z === undefined || !isFinite(z)) ? null : z;
  };

  /* --- DLSS 面：只出一块实体（场地轮廓仅参与高程规则，见文件头 2026-09-25 说明）---
   * 场地轮廓与道路外环是同一条 CAD 线上的两条描线（实测场地 88.7 m 边界全部贴在道路外环上，
   * 逐段距离 0~1.5 mm）。早先按两者各建一块实体时，交界处必定出现两片位置重合的立侧面：
   * 深度相等 → 逐像素互抢 → 人视图里闪成一条棋盘格斜纹带（实测道路有 35 片侧墙 67.2 m
   * 正压在场地轮廓上，场地有 4 片 65.5 m 压在道路外环上）；合并成一块板后交界处只由
   * 三角网内部承担、没有重复面，但按三角形重心分岛又在场地轮廓上留下锯齿状明暗斜带。 */
  let siteRing = null;
  const siteIn = data.site && data.site.outlineModelMm;
  if (siteIn && siteIn.length >= 3) siteRing = siteIn.map(p => [p[0], p[1]]);
  else warnings.push('site-context 里没有场地轮廓（site），DLSS 面实体跳过');

  if (data.roads && data.roads.outlineModelMm && data.roads.outlineModelMm.length >= 3 && siteRing) {
    const box = (ctx.envBox ? ctx.envBox : null) || (ctx.field ? ctx.field.box : null);
    let outer = data.roads.outlineModelMm.map(p => [p[0], p[1]]);
    /* 挖空只用建筑外墙 AABB，**不挖场地轮廓**：场地轮廓与道路外环时而贴合、时而相交，
     * 拿它当洞时 earcut 会在两者之间的窄颈里切出一堆细长/退化三角形（实测 1484 个），
     * 描边似的在边界上留下毛刺与暗线；建筑范围本来就要跟着这块面一起建模，
     * 分界只由「顶面高程规则」处理，与三角化细节无关。 */
    let holes = [];
    if (wall && isFinite(wall.x0)) {
      const k = params.wallInsetMm;
      holes.push([[wall.x0 + k, wall.y0 + k], [wall.x1 - k, wall.y0 + k], [wall.x1 - k, wall.y1 - k], [wall.x0 + k, wall.y1 - k]]);
    }
    if (box) {
      outer = clipRectRing(outer, box);
      holes = holes.map(h => clipRectRing(h, box)).filter(h => h.length >= 3);
    } else {
      warnings.push('未给地形盒，道路未裁剪（可能伸出地形范围）');
    }
    if (outer.length >= 3) {
      const dSite = (x, y) => distToRing(siteRing, x, y);
      const zTopRaw = (x, y) => {
        const d = dSite(x, y);
        const w = smoothstep(d / params.roadBlendMm);
        const g = ground(x, y);
        const base = (g === null) ? grade : g;
        return lerp(grade, base, w) + params.roadLiftMm * w;
      };
      /* 顶面高程规则：建筑范围（site 多边形内）一律室外地坪（平的），范围外按 smoothstep 在
       * roadBlendMm 内与自然地面融合、整体抬 roadLiftMm（道路沿地形平滑起伏、与建筑周边平滑过渡）。
       * 在 site 轮廓上两者给出同一个值（d = 0 时 smoothstep = 0，zTopRaw = grade），
       * 所以边界处没有台阶、也没有共面（同一块面，不存在两个面抢深度的问题）。
       * 建筑范围内不能直接沿用 zTopRaw：地形平台只覆盖 site 轮廓内部，靠边一圈的地形网格点
       * 落在轮廓外、插值回自然地面（可能高于室外地坪），照着它抬就会让路面钻到室外地坪之上。 */
      const zTopOf = (x, y) => (pointInRing(siteRing, x, y) ? grade : zTopRaw(x, y));
      const slab = buildSlab(THREE, {
        outer: outer, holes: holes, maxEdgeMm: params.triMaxMm, maxRounds: params.triMaxRounds,
        zTopOf: zTopOf,
        bottomOf: (x, y, zt) => {
          const floor = zt - params.roadThkMm;
          const g = ground(x, y);
          return (g === null) ? floor : Math.min(floor, g - params.groundClearMm);
        },
      });
      const roadIsl = slab.regions[0];
      /* 道路范围统计：顶面高程范围、相对自然地面的抬升（起伏幅度）、底面间隙、
       * 以及 site 轮廓上的顶面偏差（建筑周边应当严格齐平室外地坪） */
      let zMin = Infinity, zMax = -Infinity, raiseMin = Infinity, raiseMax = -Infinity;
      let roadGapMaxMm = 0, seamDevMaxMm = 0, flatDevMaxMm = 0;
      for (const i of roadIsl.verts) {
        const x = slab.verts2[i][0], y = slab.verts2[i][1], zt = slab.top[i];
        zMin = Math.min(zMin, zt); zMax = Math.max(zMax, zt);
        const g = ground(x, y);
        if (g !== null) {
          raiseMin = Math.min(raiseMin, zt - g); raiseMax = Math.max(raiseMax, zt - g);
          roadGapMaxMm = Math.max(roadGapMaxMm, slab.bot[i] - g);
        }
        if (pointInRing(siteRing, x, y)) flatDevMaxMm = Math.max(flatDevMaxMm, Math.abs(zt - grade));
        else if (distToRing(siteRing, x, y) <= 5) seamDevMaxMm = Math.max(seamDevMaxMm, Math.abs(zt - grade));
      }
      out.roadGeo = roadIsl.geo;
      out.roadStats = {
        vertexCount: roadIsl.vertexCount, tris: roadIsl.tris, wallQuads: roadIsl.wallQuads,
        areaM2: Math.round(Math.abs(ringAreaMm2(outer)) / 1e4) / 100,
        thkMm: params.roadThkMm, liftMm: params.roadLiftMm, blendMm: params.roadBlendMm,
        topMinZmm: Math.round(zMin), topMaxZmm: Math.round(zMax),
        topDropMm: Math.round(zMax - zMin),
        raiseMinMm: isFinite(raiseMin) ? Math.round(raiseMin) : null,
        raiseMaxMm: isFinite(raiseMax) ? Math.round(raiseMax) : null,
        gapMaxMm: Math.round(roadGapMaxMm),
        seamDevMaxMm: Math.round(seamDevMaxMm * 10) / 10,
        flatDevMaxMm: Math.round(flatDevMaxMm * 10) / 10,
        clipped: !!box, memberIds: data.roads.memberIds || [],
      };
      pushRing(outer, zTopOf, 1500);
    }
  } else if (!siteRing) {
    /* 上面已提示 */
  } else {
    warnings.push('site-context 里没有道路轮廓（roads），DLSS 面跳过');
  }

  /* --- 护坡 --- */
  const slopes = [];
  const slopeIn = data.slopes || [];
  for (let si = 0; si < slopeIn.length; si++) {
    const ring = (slopeIn[si].outlineModelMm || []).map(p => [p[0], p[1]]);
    if (ring.length < 4) continue;
    /* 坡顶线 = 环的首尾连线；坡底外边界 = 环上其余折线（开口链，首尾连线不在其中） */
    const topA = ring[ring.length - 1], topB = ring[0];
    const bottomChain = ring.slice();
    /* 表面 = 到坡顶线 / 到坡底外边界两个距离场的比值插值：
     * 坡顶线上取场地标高、坡底边界上取当地地形/河床标高，中间线性过渡（连续且两端严格贴合） */
    const zTopOf = (x, y) => {
      const dTop = distToSeg(topA, topB, x, y);
      const dBot = distToChain(bottomChain, x, y);
      const tt = dTop / Math.max(1e-6, dTop + dBot);
      const g = ground(x, y);
      const zb = (g === null) ? grade - params.siteThkMm : g;
      return lerp(grade, zb, tt);
    };
    const slab = buildSlab(THREE, {
      outer: ring, holes: [], maxEdgeMm: params.triMaxMm, maxRounds: params.triMaxRounds,
      zTopOf: zTopOf,
      bottomOf: (x, y, zt) => {
        const floor = zt - params.slopeThkMm;
        const g = ground(x, y);
        return (g === null) ? floor : Math.min(floor, g - params.groundClearMm);
      },
    });
    const v2 = slab.verts2;
    let zMin = Infinity, zMax = -Infinity, thkMin = Infinity;
    for (let i = 0; i < v2.length; i++) {
      zMin = Math.min(zMin, slab.top[i]); zMax = Math.max(zMax, slab.top[i]);
      thkMin = Math.min(thkMin, slab.top[i] - slab.bot[i]);
    }
    slopes.push({
      vertexCount: v2.length, tris: slab.tris, wallQuads: slab.wallQuads,
      areaM2: Math.abs(ringAreaMm2(ring)) / 1e6,
      topMinZmm: Math.round(zMin), topMaxZmm: Math.round(zMax),
      dropMm: Math.round(zMax - zMin), thkMinMm: Math.round(thkMin),
      id: slopeIn[si].id || (si + 1),
    });
    const sgeo = slab.regions[0].geo;
    if (!out.slopeGeo) out.slopeGeo = sgeo;
    else out.slopeGeos = (out.slopeGeos || [out.slopeGeo]).concat([sgeo]);
    pushRing(ring, zTopOf, 1500);
  }
  out.slopeStats = slopes;
  out.lines = lines;
  if (!slopes.length) warnings.push('site-context 里没有护坡环（slopes），护坡实体跳过');
  if (data.site && data.site.areaM2 && siteRing) {
    const dev = Math.abs(ringAreaMm2(siteRing)) / 1e6 - data.site.areaM2;
    if (Math.abs(dev) > 1) warnings.push('场地轮廓面积与 site-context 记录差 ' + dev.toFixed(1) + ' m²');
  }
  return out;
}

/* ---------------- 自检 ----------------
 * 检查: 顶点无 NaN / 顶面三角形法线朝上 / 建筑周边顶面严格等于室外地坪 /
 *       道路抬升在合理区间 / 实体厚度不小于设定值 / 底面不离开地形 */
function siteCheck(state) {
  const r = state && state.result;
  const out = { params: null, counts: {}, issues: [], ok: true };
  if (!r) return { ok: false, issues: ['未生成道路实体'], counts: {} };
  out.params = r.params;
  const scan = (geo, name) => {
    if (!geo) return null;
    const p = geo.getAttribute('position').array;
    let nan = 0, zMin = Infinity, zMax = -Infinity;
    for (let i = 1; i < p.length; i += 3) {
      if (!isFinite(p[i])) { nan++; continue; }
      zMin = Math.min(zMin, p[i]); zMax = Math.max(zMax, p[i]);
    }
    out.counts[name + 'Verts'] = p.length / 3;
    const idx = geo.index ? geo.index.array : null;
    out.counts[name + 'Tris'] = (idx ? idx.length : p.length / 3) / 3;
    if (nan) out.issues.push(name + ' 顶点有 ' + nan + ' 个 NaN');
    /* 顶面朝向（buildSlab 每 6 个索引一组：前 3 顶面、后 3 底面）：
     * 法线用平面坐标算，ny = (b.y−a.y)(c.x−a.x) − (b.x−a.x)(c.y−a.y) < 0 = 朝下。
     * 顶面被翻成朝下会被背面剔除，地形从板里穿出来（表面碎块）。面积 < 1000 mm² 的
     * 退化碎片忽略：三角化在共线点处会产生零面积三角形，朝向无意义。 */
    let downTris = 0, downAreaMm2 = 0;
    if (idx) {
      for (let k = 0; k + 5 < idx.length; k += 6) {
        const i0 = idx[k] * 3, i1 = idx[k + 1] * 3, i2 = idx[k + 2] * 3;
        const ax = p[i0], ay = p[i0 + 2];
        const ny = (p[i1 + 2] - ay) * (p[i2] - ax) - (p[i1] - ax) * (p[i2 + 2] - ay);
        const area = Math.abs(ny) / 2;
        if (area < 1000) continue;
        if (ny < 0) { downTris++; downAreaMm2 += area; }
      }
    }
    out.counts[name + 'TopDown'] = downTris;
    if (downTris) out.issues.push(name + ' 顶面有 ' + downTris + ' 个朝向错误的三角形（面积 ' + (downAreaMm2 / 1e6).toFixed(2) + ' m²）');
    return { nan: nan, zMin: zMin, zMax: zMax, downTris: downTris };
  };
  scan(r.roadGeo, 'road');
  if (r.slopeGeos) {
    for (let i = 0; i < r.slopeGeos.length; i++) scan(r.slopeGeos[i], i ? 'slope' + (i + 1) : 'slope');
  } else {
    scan(r.slopeGeo, 'slope');
  }
  const grade = state.level && isFinite(state.level.grade) ? state.level.grade : null;
  if (r.roadStats) {
    out.roadTopDropMm = r.roadStats.topDropMm;
    out.roadRaiseMm = [r.roadStats.raiseMinMm, r.roadStats.raiseMaxMm];
    out.roadGapMaxMm = r.roadStats.gapMaxMm;
    out.roadSeamDevMm = r.roadStats.seamDevMaxMm;
    /* 建筑范围（site 多边形内）的顶面必须严格齐平室外地坪；轮廓线附近那一圈顶点
     * 落在 roadBlendMm 过渡带里（d = 0 处正好取到室外地坪），偏差只作信息项 */
    out.flatDevMm = r.roadStats.flatDevMaxMm;
    if (r.roadStats.flatDevMaxMm > 1) out.issues.push('建筑范围内顶面偏离室外地坪 ' + r.roadStats.flatDevMaxMm + ' mm');
    if (r.roadStats.raiseMinMm !== null && r.roadStats.raiseMinMm < -1) out.issues.push('道路顶面低于自然地面 ' + r.roadStats.raiseMinMm + ' mm');
    if (r.roadStats.gapMaxMm > 1) out.issues.push('道路底面离开地形 ' + r.roadStats.gapMaxMm + ' mm（悬空）');
    if (r.roadStats.seamDevMaxMm > 1) out.issues.push('site 轮廓上顶面偏离室外地坪 ' + r.roadStats.seamDevMaxMm + ' mm');
  }
  if (r.slopeStats) {
    out.slopeThkMinMm = Math.min(...r.slopeStats.map(s => s.thkMinMm));
    if (out.slopeThkMinMm < r.params.slopeThkMm - 1) out.issues.push('护坡最小厚度 ' + out.slopeThkMinMm + ' mm 小于 ' + r.params.slopeThkMm + ' mm');
    out.slopeDropMm = r.slopeStats.map(s => s.dropMm);
  }
  /* DLSS 面的名义底面（顶面 − roadThkMm）应当与地形平台齐平：platformSinkMm（js/environment.js）
   * 与 roadThkMm（本文件）必须一致，否则建筑周边会露出平台边或埋进平台 */
  if (state.platformZ != null && r.roadStats && grade !== null) {
    out.platformGapMm = Math.round(grade - r.roadStats.thkMm - state.platformZ);
    if (Math.abs(out.platformGapMm) > 1) out.issues.push('DLSS 面底面与地形平台相差 ' + out.platformGapMm + ' mm');
  }
  out.ok = !out.issues.length;
  return out;
}

const api = {
  version: '1.0',
  DEFAULT_PARAMS: DEFAULT_PARAMS,
  resolveParams: resolveParams,
  ringAreaMm2: ringAreaMm2,
  pointInRing: pointInRing,
  closestOnRing: closestOnRing,
  clipRectRing: clipRectRing,
  refineMesh: refineMesh,
  build: build,
  siteCheck: siteCheck,
};

if (typeof window !== 'undefined') window.WMSite = api;
if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
