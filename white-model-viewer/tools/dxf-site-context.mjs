/* 总平面图 → 建筑白模：对位关系与环境数据（data/site-context.json）
 * 用法: node tools/dxf-site-context.mjs [总平面图.dxf] [输出.json]
 *   缺省 DXF = <repo>/Flie/输入文件/菖蒲垇项目/总平面图.dxf
 *   缺省输出 = <repo>/white-model-viewer/data/site-context.json
 *   模型基准（外墙 AABB、轴线网格、标高字段）读自 index.html 内嵌 sampleData，用于一致性核对
 *
 * 图纸图层约定（设计方给定）:
 *   WALL_OUT 较大矩形 = 建筑外墙轮廓线（对位基准，与模型墙体 AABB 对应）
 *   WALL_OUT 较小矩形 = 进水池轮廓
 *   GCD / 块 gc200 的 ATTRIB height = 高程点（图面单位 m，模型单位 mm，1:1000）
 *   SXSS = 河道岸线；DMTZ = 陡坎；ZJ = 河名文字
 * 输出内容: 对位变换（双向）、建筑轮廓、高程点（双坐标）、进水池、河道（含主河槽标识）、
 *          现场环境生成参数（environment，供 js/environment.js 读取）、陡坎、注记文字
 *
 * v2 起：写出的 JSON 会同步一份紧凑副本到 index.html 的 <script id="siteContextData">，
 *         因为 file:// 下浏览器会拦截 fetch/XHR，双击打开只能走内嵌副本。
 *         environment 各参数默认值与 white-model-viewer/js/environment.js 的 DEFAULT_PARAMS 一致。
 */
import { readFileSync, writeFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const dxfPath = process.argv[2] || fileURLToPath(new URL('../../Flie/输入文件/菖蒲垇项目/总平面图.dxf', import.meta.url));
const outPath = process.argv[3] || fileURLToPath(new URL('../data/site-context.json', import.meta.url));

const MODEL_Z0_ABS_MM = 166759;   // Z=0 = 水泵间地面绝对标高，见 docs/DATA-MODEL.md 5.1
const SITE_COORD_NOTE = '总平面图图纸坐标，单位 m；图纸无指北针，按坐标量级推断为测量坐标（X≈574.35 km 只能作 东向 easting，'
  + 'Y≈2880.46 km 只能作 北向 northing），即 X=东、Y=北；换算 1 m = 1000 mm';

/* ---------------- DXF 解析 ---------------- */
const text = new TextDecoder('utf-8').decode(readFileSync(dxfPath));   // 总平面图为 UTF-8；GBK 图纸需换 'gbk'
const lines = text.split(/\r?\n/);
const ents = [];
let cur = null;
for (let i = 0; i + 1 < lines.length; i += 2) {
  const code = parseInt(lines[i], 10);
  const val = lines[i + 1] === undefined ? '' : lines[i + 1].trim();
  if (code === 0) { cur = { type: val, pairs: [] }; ents.push(cur); } else if (cur) { cur.pairs.push([code, val]); }
}
function num(pairs, code) { const h = pairs.find(p => p[0] === code); return h ? parseFloat(h[1]) : NaN; }
function str(pairs, code) { const h = pairs.find(p => p[0] === code); return h ? h[1] : ''; }
const gi = ents.findIndex(e => e.type === 'SECTION' && str(e.pairs, 2) === 'ENTITIES');
const ge = ents.findIndex((e, i) => i > gi && e.type === 'ENDSEC');
if (gi < 0 || ge < 0) throw new Error('DXF 中没有 ENTITIES 段');
const sec = ents.slice(gi, ge);

function polyVerts(pairs) {
  const vs = []; let v = null;
  for (const [c, val] of pairs) {
    if (c === 10) { v = [parseFloat(val), 0]; vs.push(v); }
    else if (c === 20 && v) v[1] = parseFloat(val);
  }
  return vs;
}
function polylineArea(pts) {
  let a = 0;
  for (let i = 0; i < pts.length; i++) { const q = pts[(i + 1) % pts.length]; a += pts[i][0] * q[1] - q[0] * pts[i][1]; }
  return a / 2;
}

/* 把首尾相接的多段折线拼成整条岸线（图纸可能分多段画同一条岸，如补画的河道延伸段）。
 * 容差 tolM 为图面单位 m；闭合折线不参与拼接（渠道/护坡闭合圈保持原样）。
 * 拼好后统一方向：起点 Y 小的一端在前（图纸 Y=北向，即南→北）。 */
function chainPolylines(shapes, tolM) {
  const chains = shapes.map(s => ({ pts: s.pts.slice(), closed: s.closed, members: [s] }));
  let merged = true;
  while (merged) {
    merged = false;
    for (let i = 0; i < chains.length && !merged; i++) {
      if (chains[i].closed) continue;
      for (let j = i + 1; j < chains.length; j++) {
        if (chains[j].closed) continue;
        const a = chains[i].pts, b = chains[j].pts;
        const a0 = a[0], a1 = a[a.length - 1], b0 = b[0], b1 = b[b.length - 1];
        const near = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1]) <= tolM;
        let pts = null;
        if (near(a1, b0)) pts = a.concat(b.slice(1));
        else if (near(a1, b1)) pts = a.concat(b.slice(0, -1).reverse());
        else if (near(a0, b1)) pts = b.concat(a.slice(1));
        else if (near(a0, b0)) pts = b.slice().reverse().concat(a.slice(1));
        if (pts) {
          chains[i] = { pts, closed: false, members: chains[i].members.concat(chains[j].members) };
          chains.splice(j, 1);
          merged = true;
          break;
        }
      }
    }
  }
  for (const c of chains) {
    if (!c.closed && c.pts.length >= 2 && c.pts[0][1] > c.pts[c.pts.length - 1][1]) c.pts.reverse();
  }
  return chains;
}
function polylineLenM(pts) {
  let s = 0;
  for (let i = 1; i < pts.length; i++) s += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  return s;
}

/* ---------------- 采集图元 ---------------- */
const wallOut = [], sxss = [], dmtz = [], pipes = [], elevPts = [], ctrlPts = [], texts = [];
const TEXT_LAYERS = new Set(['ZJ', 'YHG_文字', 'DIM_COOR', 'DIM_ELEV', 'DIM_LEAD', 'YHJ_剖面_梁板', 'zdh']);
for (let i = 0; i < sec.length; i++) {
  const e = sec[i];
  const layer = str(e.pairs, 8);
  if (e.type === 'LWPOLYLINE' || e.type === 'LINE') {
    const pts = e.type === 'LINE' ? [[num(e.pairs, 10), num(e.pairs, 20)], [num(e.pairs, 11), num(e.pairs, 21)]] : polyVerts(e.pairs);
    const closed = e.type === 'LWPOLYLINE' && (parseInt(str(e.pairs, 70) || '0', 10) & 1) === 1;
    const shape = { layer, type: e.type, closed, pts };
    if (layer === 'WALL_OUT') wallOut.push(shape);
    else if (layer === 'SXSS') sxss.push(shape);
    else if (layer === 'DMTZ') dmtz.push(shape);
    else if (layer === '管') pipes.push(shape);
  } else if (e.type === 'INSERT' && str(e.pairs, 2) === 'gc200') {
    const h = sec[i + 1] && sec[i + 1].type === 'ATTRIB' ? num(sec[i + 1].pairs, 1) : NaN;
    elevPts.push({ x: num(e.pairs, 10), y: num(e.pairs, 20), h });
  } else if (e.type === 'POINT' && layer === 'zdh') {
    ctrlPts.push({ x: num(e.pairs, 10), y: num(e.pairs, 20) });
  } else if ((e.type === 'TEXT' || e.type === 'MTEXT') && TEXT_LAYERS.has(layer)) {
    const t = str(e.pairs, 1).replace(/\\[A-Za-z]\d(\.\d+)?;|\\P/g, ' ').replace(/\s+/g, ' ').trim();
    if (t) texts.push({ layer, text: t, x: num(e.pairs, 10), y: num(e.pairs, 20) });
  }
}
if (wallOut.length < 2) throw new Error('WALL_OUT 图层未找到「建筑外墙轮廓线 + 进水池」两个闭合矩形');
wallOut.sort((a, b) => Math.abs(polylineArea(b.pts)) - Math.abs(polylineArea(a.pts)));
const bld = wallOut[0], pool = wallOut[1];
const sxssChains = chainPolylines(sxss, 0.5).sort((a, b) => polylineLenM(b.pts) - polylineLenM(a.pts));
const badElev = elevPts.filter(p => !Number.isFinite(p.h)).length;
if (badElev) console.warn('警告: ' + badElev + ' 个 gc200 高程点缺少 height 属性');

/* ---------------- 对位变换：总平面(m) → 模型(mm) ---------------- */
// 旋转角：矩形四条边方向角折入 [0,90) 后取均值（抵消长宽边 180° 歧义与图纸微小不正交）
const folded = [];
for (let i = 0; i < bld.pts.length; i++) {
  const p = bld.pts[i], q = bld.pts[(i + 1) % bld.pts.length];
  folded.push((((Math.atan2(q[1] - p[1], q[0] - p[0]) * 180 / Math.PI) % 90) + 90) % 90);
}
const thetaDeg = folded.reduce((s, a) => s + a, 0) / folded.length;
const th = thetaDeg * Math.PI / 180, cs = Math.cos(th), sn = Math.sin(th);
const rotS2M = v => [v[0] * cs + v[1] * sn, -v[0] * sn + v[1] * cs];   // R(-θ)
const rotM2S = v => [v[0] * cs - v[1] * sn, v[0] * sn + v[1] * cs];   // R(+θ)
// 锚点：旋转后落在外墙轮廓线「西南角」（局部 X/Y 均最小）的那个角，对应模型 (0,0)
const rel = bld.pts.map(p => ({ p, q: rotS2M([p[0] - bld.pts[0][0], p[1] - bld.pts[0][1]]) }));
const anchorSite = rel.reduce((a, b) => (b.q[0] + b.q[1] < a.q[0] + a.q[1] ? b : a)).p;
const toModelMm = p => { const q = rotS2M([p[0] - anchorSite[0], p[1] - anchorSite[1]]); return [q[0] * 1000, q[1] * 1000]; };
const toSiteM = p => { const q = rotM2S([p[0] / 1000, p[1] / 1000]); return [q[0] + anchorSite[0], q[1] + anchorSite[1]]; };
const round = (v, n = 1) => Math.round(v * 10 ** n) / 10 ** n;
const r3 = v => v.map(n => round(n, 3));
const r1 = v => v.map(n => round(n, 1));

const bldMm = bld.pts.map(toModelMm);
const bldSizeMm = {
  width: round(Math.max(...bldMm.map(p => p[0])) - Math.min(...bldMm.map(p => p[0])), 1),
  length: round(Math.max(...bldMm.map(p => p[1])) - Math.min(...bldMm.map(p => p[1])), 1),
};
const poolMm = pool.pts.map(toModelMm);
const poolBox = {
  x0: round(Math.min(...poolMm.map(p => p[0])), 1), x1: round(Math.max(...poolMm.map(p => p[0])), 1),
  y0: round(Math.min(...poolMm.map(p => p[1])), 1), y1: round(Math.max(...poolMm.map(p => p[1])), 1),
};
// 对位残差：外墙轮廓线四角与理想矩形四角的偏差（图纸本身非严格正交，量级 mm）
const corners = [[0, 0], [bldSizeMm.width, 0], [bldSizeMm.width, bldSizeMm.length], [0, bldSizeMm.length]];
const residIdeal = bldMm.map(p => Math.min(...corners.map(c => Math.hypot(p[0] - c[0], p[1] - c[1]))));

/* ---------------- 模型基准（与当前白模 JSON 的一致性核对） ---------------- */
const modelRef = { wallsOuterMm: null, axisGridMm: null, axisOriginMm: null, elevationsMm: null };
try {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const m = html.match(/<script type="application\/json" id="sampleData">([\s\S]*?)<\/script>/);
  if (m) {
    const json = JSON.parse(m[1]);
    const shortType = e => String((e && e.$type) || '').split(',')[0].split('.').pop();
    const base = (json.ViewFrames || []).find(f => f.ViewKind === 4) || (json.ViewFrames || [])[0];
    const walls = (base.Elements || []).filter(e => shortType(e) === 'WallObject');
    const xs = [], ys = [];
    for (const w of walls) for (const p of (w.Outline || [])) { xs.push(p.X); ys.push(p.Y); }
    const ox = Math.min(...xs), oy = Math.min(...ys);
    modelRef.wallsOuterMm = { x0: 0, y0: 0, x1: round(Math.max(...xs) - ox, 1), y1: round(Math.max(...ys) - oy, 1) };
    const axes = (base.Elements || []).filter(e => shortType(e) === 'AxisObject');
    const gv = n => { const a = axes.find(e => e.Number === n); return a ? a.LocationLine.Start : null; };
    const a1 = gv('1'), a2 = gv('2'), aA = gv('A'), aD = gv('D');
    modelRef.axisOriginMm = a1 && aA ? { x: round(a1.X - ox, 1), y: round(aA.Y - oy, 1) } : null;
    modelRef.axisGridMm = a1 && a2 && aA && aD ? {
      x1: round(a1.X - ox, 1), x2: round(a2.X - ox, 1),
      yA: round(aA.Y - oy, 1), yD: round(aD.Y - oy, 1),
      spanXMm: round(a2.X - a1.X, 1), spanYMm: round(aD.Y - aA.Y, 1),
    } : null;
    const elevs = new Set();
    (function walk(o) { if (o && typeof o === 'object') for (const k in o) { if (/ElevationMm$/.test(k) && typeof o[k] === 'number') elevs.add(o[k]); else walk(o[k]); } })(json);
    modelRef.elevationsMm = [...elevs].sort((a, b) => a - b);
  }
} catch (e) { console.warn('警告: 未能读取 index.html 内嵌 JSON（一致性核对跳过）:', e.message); }

const consistency = modelRef.wallsOuterMm ? {
  currentModelWallsOuterMm: modelRef.wallsOuterMm,
  deltaWidthMm: round(modelRef.wallsOuterMm.x1 - bldSizeMm.width, 1),
  deltaLengthMm: round(modelRef.wallsOuterMm.y1 - bldSizeMm.length, 1),
  intakeNorthOverhangMm: round(-(modelRef.wallsOuterMm.y1 - poolBox.y1), 1),
  note: '总平面图（' + statSync(dxfPath).mtime.toISOString().slice(0, 10) + ' 版）建筑外墙轮廓线比当前模型墙体 AABB 长 '
    + round(bldSizeMm.length - modelRef.wallsOuterMm.y1, 1) + ' mm；进水池北边缘在当前模型北端外 '
    + round(poolBox.y1 - modelRef.wallsOuterMm.y1, 1) + ' mm。变换仅依赖总平面图，模型按新图重导出后本文件坐标无需修改。',
} : null;

/* ---------------- 周边环境生成参数（js/environment.js 读取；改这里即可试不同网格/水深） ----------------
 * 默认值与 white-model-viewer/js/environment.js 的 DEFAULT_PARAMS 一致。 */
const ENV_MARGIN_MM = 60000;
const envBoxRef = (() => {
  const a = modelRef.wallsOuterMm || { x0: 0, y0: 0, x1: bldSizeMm.width, y1: bldSizeMm.length };
  return {
    x0: round(a.x0 - ENV_MARGIN_MM, 1), x1: round(a.x1 + ENV_MARGIN_MM, 1),
    y0: round(a.y0 - ENV_MARGIN_MM, 1), y1: round(a.y1 + ENV_MARGIN_MM, 1),
  };
})();
const ENVIRONMENT_PARAMS = {
  marginMm: ENV_MARGIN_MM,
  gridMm: 1500,
  platformOffsetMm: 5000,
  platformSinkMm: 300,
  idwPower: 2,
  idwK: 12,
  despikeMm: 600,
  smoothIters: 8,
  smoothLambda: 0.45,
  slopeMax: 1.0,
  slopeHardIters: 20,
  slopeTarget: 0.2,
  slopeSoftIters: 12,
  bankBlend: 0.3,
  endTaperMm: 10000,
  waterDepthMm: 1000,
  waterClampMm: 200,
  waterSmoothIters: 6,
  bedMinDepthMm: 800,
  bedUnderMm: 200,
  skirtMm: 3000,
  corridorStationMm: 2000,
  corridorSampleMm: 500,
  terrainBoxModelMm: envBoxRef,
  note: '地形范围 = 模型墙体 AABB 每侧外扩 marginMm；水面 = 河床 + waterDepthMm（可改）；'
    + 'slopeTarget 1:5 取自建筑 JSON 的 IntakePoolChannelSlopeParameters(1000/5000)，slopeMax 1:1 为硬上限；'
    + 'platformSinkMm 使平台面正好等于散水底面（L.grade − 300）；'
    + 'bedMinDepthMm 是「河床面」的深度分界（槽内低于插值地面超过该值才算河床）；'
    + 'bedUnderMm 再要求整格低于当地水位该值，把网格量化的材质边界藏到水面之下（否则岸上会出现阶梯色块）；'
    + 'corridorSampleMm 同时是水面条带的纵向细分步长（岸线贴合网格交点）。'
    + '这些键都能直接在本字段里改（改完重跑工具即可；≤ 0 只有 bedUnderMm 有意义 = 关闭该限制）。'
    + 'terrainBoxModelMm 按当前内嵌模型的墙体 AABB 推得，仅供参考。',
};

/* ---------------- 组装输出 ---------------- */
const out = {
  name: '菖蒲垇项目 总平面图 → 建筑白模 对位与环境数据',
  version: 2,
  source: {
    dxf: '../Flie/输入文件/菖蒲垇项目/总平面图.dxf',
    bytes: statSync(dxfPath).size,
    mtime: statSync(dxfPath).mtime.toISOString(),
    generator: 'white-model-viewer/tools/dxf-site-context.mjs',
  },
  units: {
    site: 'm（' + SITE_COORD_NOTE + '）',
    model: 'mm（查看器 JSON 坐标系：X = 轴网 1→2 方向、Y = 轴网 A→D 方向，Z = 绝对标高×1000 − ' + MODEL_Z0_ABS_MM + '）',
    datumNote: '模型 Z=0 = 水泵间地面 = 绝对标高 166.759 m（' + MODEL_Z0_ABS_MM + ' mm）',
    orientationNote: '图纸未画指北针，X=东 / Y=北 由坐标量级推断（见 units.site）；对位变换只用到两套坐标系之间的相对关系，'
      + '不依赖真北方位。模型 +Y（长轴）= 图纸北向偏西 ' + round(thetaDeg, 4) + '°。',
  },
  alignment: {
    kind: '2D 相似变换（平移 + 旋转 + 等比缩放 1000 = 图纸 m → 模型 mm）',
    rotationDeg: round(-thetaDeg, 4),
    rotationNote: '总平面图顺时针转 ' + round(thetaDeg, 4) + '° 即与模型坐标轴重合；同名轴一一对应、不做镜像'
      + '（判据：总平面图 −X 一侧为进水池/河道，与模型中取水构筑物位于 −X 一致）',
    anchorSiteM: r3(anchorSite),
    anchorModelMm: [0, 0],
    anchorNote: '锚点 = 建筑外墙轮廓线西南角（局部坐标 X/Y 最小）= 模型墙体 AABB 原点',
    siteToModel: 'p_model = R(-' + round(thetaDeg, 4) + '°) · (p_site − anchorSiteM) × 1000',
    modelToSite: 'p_site = anchorSiteM + R(+' + round(thetaDeg, 4) + '°) · (p_model / 1000)',
  },
  building: {
    layer: 'WALL_OUT（较大矩形）',
    outlineSiteM: bld.pts.map(r3),
    outlineModelMm: bldMm.map(r1),
    sizeMm: bldSizeMm,
    edgeLengthsSiteM: bld.pts.map((p, i) => { const q = bld.pts[(i + 1) % bld.pts.length]; return round(Math.hypot(q[0] - p[0], q[1] - p[1]), 4); }),
    fitResidualMm: round(Math.max(...residIdeal), 2),
    modelAxisGridMm: modelRef.axisGridMm,
    modelAxisOriginMm: modelRef.axisOriginMm,
  },
  consistency,
  elevationPoints: {
    layer: 'GCD / 块 gc200',
    attribTag: 'height',
    pointFields: ['xSiteM', 'ySiteM', 'elevationM', 'xModelMm', 'yModelMm', 'zAbsMm', 'zModelMm'],
    count: elevPts.length,
    elevationRangeM: [round(Math.min(...elevPts.map(p => p.h)), 2), round(Math.max(...elevPts.map(p => p.h)), 2)],
    zModelNote: 'zAbsMm = 高程(m)×1000；zModelMm = zAbsMm − ' + MODEL_Z0_ABS_MM + '（查看器 Z 坐标）',
    points: elevPts.map(p => {
      const m = toModelMm([p.x, p.y]);
      return [round(p.x, 3), round(p.y, 3), round(p.h, 3), round(m[0], 1), round(m[1], 1), round(p.h * 1000, 1), round(p.h * 1000 - MODEL_Z0_ABS_MM, 1)];
    }),
  },
  intakePool: {
    layer: 'WALL_OUT（较小矩形）',
    outlineSiteM: pool.pts.map(r3),
    outlineModelMm: poolMm.map(r1),
    boundsModelMm: poolBox,
    sizeMm: { width: round(poolBox.x1 - poolBox.x0, 1), length: round(poolBox.y1 - poolBox.y0, 1) },
    offsetsMm: {
      nearEdgeToBuildingWestFace: round(-poolBox.x1, 1),
      northEdgeToBuildingNorthFace: round(bldSizeMm.length - poolBox.y1, 1),
      southEdgeToBuildingSouthFace: round(poolBox.y0, 1),
    },
  },
  riverChannel: {
    name: (texts.find(t => t.layer === 'ZJ') || {}).text || '麻桑河',
    layer: 'SXSS',
    note: '主河槽为 id 1（靠进水池一侧的岸线，紧贴进水池）与 id 2（对岸）两条岸线之间的区域；'
      + '岸线按图面端点（容差 0.5 m）把多段 SXSS 折线首尾拼成整条（segments 记录段数），闭合折线不拼接、保持原样。'
      + '其余小段为渠道 / 护坡岸线（图纸文字：引水渠道、C20 素混凝土护坡 / 护底、1:2.0 与 1:5.0 边坡）。',
    mainChannel: {
      bankIds: [1, 2],
      note: '主河槽 = id 1 与 id 2 之间的区域（宽约 26 ~ 39 m，以查看器 envCheck 的站距测量为准）。'
        + '本次图纸每条主岸由 2 段 SXSS 折线拼接而成：旧岸线 + 新补画的北西延伸段，'
        + '河道沿延伸段向西北穿出地形范围（查看器地形在范围边缘自然截断，不再收口）。'
        + '其余 SXSS 折线为渠道 / 护坡岸线，查看器只画线不做水面。若另有渠道需出水面，把它们的两条岸线 id 加进来即可。',
    },
    banks: sxssChains.map((c, i) => ({
      id: i + 1, type: c.members.every(m => m.type === 'LWPOLYLINE') ? 'LWPOLYLINE' : 'MIXED', closed: c.closed,
      vertexCount: c.pts.length, segments: c.members.length, lengthSiteM: round(polylineLenM(c.pts), 3),
      outlineSiteM: c.pts.map(r3), outlineModelMm: c.pts.map(p => r1(toModelMm(p))),
    })),
  },
  environment: ENVIRONMENT_PARAMS,
  context: {
    scarps: dmtz.map(s => ({ layer: s.layer, outlineSiteM: s.pts.map(r3), outlineModelMm: s.pts.map(p => r1(toModelMm(p))) })),
    pipes: pipes.map(s => ({ layer: s.layer, outlineSiteM: s.pts.map(r3), outlineModelMm: s.pts.map(p => r1(toModelMm(p))) })),
    controlPoints: ctrlPts.map(p => ({ name: '拟建提罐站检查点', siteM: r3([p.x, p.y]), modelMm: r1(toModelMm([p.x, p.y])) })),
    texts: texts.map(t => ({ layer: t.layer, text: t.text, siteM: r3([t.x, t.y]), modelMm: r1(toModelMm([t.x, t.y])) })),
  },
};
writeFileSync(outPath, JSON.stringify(out, null, 1));

/* ---------------- 同步内嵌副本到 index.html ----------------
 * file:// 双击打开时 fetch / 同步 XHR 都会被浏览器拦截，页面只能读内嵌那份；
 * 因此每次生成都把同一份 JSON 紧凑地写回 <script id="siteContextData">。 */
const INLINE_ID = 'siteContextData';
const htmlPath = fileURLToPath(new URL('../index.html', import.meta.url));
let inlineNote = '';
try {
  const html = readFileSync(htmlPath, 'utf8');
  const block = '<script type="application/json" id="' + INLINE_ID + '">' + JSON.stringify(out) + '</script>';
  const re = new RegExp('<script type="application/json" id="' + INLINE_ID + '">[\\s\\S]*?</script>');
  let next = null;
  if (re.test(html)) {
    next = html.replace(re, () => block);
  } else {
    const anchor = '<script src="js/families.js"></script>';
    const at = html.indexOf(anchor);
    if (at < 0) throw new Error('index.html 中找不到插入锚点 ' + anchor);
    next = html.slice(0, at) + block + '\n' + html.slice(at);
  }
  if (next !== html) writeFileSync(htmlPath, next);
  inlineNote = '已同步 index.html 内嵌副本（' + Math.round(block.length / 1024) + ' KB）';
} catch (e) {
  inlineNote = '警告: 未能同步 index.html 内嵌副本：' + e.message;
}

/* ---------------- 打印摘要 ---------------- */
const f = (v, n = 2) => v.toFixed(n);
console.log('输出:', outPath);
console.log('对位: 旋转 ' + f(-thetaDeg, 4) + '°  锚点 site' + '(' + f(anchorSite[0], 3) + ',' + f(anchorSite[1], 3) + ') → model(0,0)');
console.log('建筑外墙轮廓线: ' + f(bldSizeMm.width, 1) + ' × ' + f(bldSizeMm.length, 1) + ' mm  四角拟合残差 ' + f(Math.max(...residIdeal), 2) + ' mm');
console.log('进水池: ' + f(poolBox.x1 - poolBox.x0, 1) + ' × ' + f(poolBox.y1 - poolBox.y0, 1) + ' mm  X ' + f(poolBox.x0, 1) + '..' + f(poolBox.x1, 1)
  + '  Y ' + f(poolBox.y0, 1) + '..' + f(poolBox.y1, 1) + '  距西外墙 ' + f(-poolBox.x1, 1) + ' mm');
console.log('高程点: ' + elevPts.length + ' 个  ' + f(out.elevationPoints.elevationRangeM[0]) + ' ~ ' + f(out.elevationPoints.elevationRangeM[1]) + ' m');
const mergedBankSegs = sxssChains.filter(c => c.members.length > 1).map(c => c.members.length);
console.log('河道岸线: ' + sxssChains.length + ' 条（' + (mergedBankSegs.length ? '其中 ' + mergedBankSegs.length + ' 条由多段拼接: ' + mergedBankSegs.join('/') + ' 段' : '无多段拼接') + '）  陡坎: ' + dmtz.length + ' 段  注记: ' + texts.length + ' 条');
console.log('主河槽: 岸线 id ' + out.riverChannel.mainChannel.bankIds.join(' + ') + '（' + out.riverChannel.name.trim() + '）');
console.log('环境参数: 外扩 ' + ENVIRONMENT_PARAMS.marginMm + ' mm · 网格 ' + ENVIRONMENT_PARAMS.gridMm + ' mm · 水深 '
  + ENVIRONMENT_PARAMS.waterDepthMm + ' mm · 平台面 = 室外地坪 − ' + ENVIRONMENT_PARAMS.platformSinkMm + ' mm · 河床材质分界 '
  + ENVIRONMENT_PARAMS.bedMinDepthMm + '/' + ENVIRONMENT_PARAMS.bedUnderMm + ' mm');
console.log('地形参考范围: X ' + envBoxRef.x0 + '..' + envBoxRef.x1 + '  Y ' + envBoxRef.y0 + '..' + envBoxRef.y1 + ' mm');
console.log(inlineNote);
if (modelRef.wallsOuterMm) {
  console.log('模型墙体 AABB: ' + modelRef.wallsOuterMm.x1 + ' × ' + modelRef.wallsOuterMm.y1 + ' mm  → 长边差 ' + consistency.deltaLengthMm
    + ' mm，宽边差 ' + consistency.deltaWidthMm + ' mm，进水池北边缘超出模型北端 ' + consistency.intakeNorthOverhangMm + ' mm');
}
