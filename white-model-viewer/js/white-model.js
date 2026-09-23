/* 建筑白模生成器：读取 PlanFundingDrawing JSON，在 Three.js 中生成可浏览的白模。
 * 坐标约定：X 向右、Y 向上、Z 为高度；单位毫米。Z=0 对应水泵间结构标高。
 */
(function () {
'use strict';

/* ---------------- 基础工具 ---------------- */
function shortType(e) {
  const q = String(e && e.$type || '').split(',')[0];
  const s = q.split('.').pop();
  return s || 'Unknown';
}
function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
function round(v, d) { const m = Math.pow(10, d || 1); return Math.round(v * m) / m; }
function fmt(v) { return round(v, 1); }

/* ---------------- 全局状态 ---------------- */
const state = {
  groups: {},          // 图层分组
  log: [],             // 数据摘要 / 告警
  warnings: [],
  labels: [],          // 文字标签精灵
  lineOverlays: [],    // 线稿叠加层
  auxLines: [],        // 所有线条对象（辅助通道中隐藏）
  bounds: null,        // 建筑包围盒（视图预设用）
  levels: null,        // 标高表（视图预设用）
  channel: 'color',    // 出图通道 color / depth / normal
  linesOn: false,      // 线稿开关状态
  labelsOn: true,      // 文字标注开关状态
  baseBackground: null,
};

function log(msg) { state.log.push(msg); }
function warn(msg) { state.warnings.push(msg); log('⚠ ' + msg); }

/* ---------------- Three.js 初始化 ---------------- */
let renderer, scene, camera, controls;
const STATIC = /[?&]static=1/.test(location.search);
function initThree() {
  const container = document.getElementById('viewer');
  scene = new THREE.Scene();
  state.baseBackground = new THREE.Color(0xe9e9e9);
  scene.background = state.baseBackground;

  camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 10, 300000);
  camera.position.set(13000, 10000, 21500);

  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.outputEncoding = THREE.sRGBEncoding;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  container.appendChild(renderer.domElement);

  controls = new THREE.OrbitControls(camera, renderer.domElement);
  controls.target.set(3600, 7550, 3000);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.minDistance = 800;
  controls.maxDistance = 80000;
  controls.maxPolarAngle = Math.PI * 0.62;
  controls.update();

  scene.add(new THREE.HemisphereLight(0xffffff, 0xcfcfcf, 1.05));
  const sun = new THREE.DirectionalLight(0xffffff, 1.25);
  sun.position.set(12000, 22000, 10000);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  const d = 16000;
  sun.shadow.camera.left = -d;
  sun.shadow.camera.right = d;
  sun.shadow.camera.top = d;
  sun.shadow.camera.bottom = -d;
  sun.shadow.camera.far = 60000;
  scene.add(sun);

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  let framesSinceBuild = 0;
  (function animate() {
    controls.update();
    renderer.render(scene, camera);
    if (STATIC && state.modelBuilt) framesSinceBuild++;
    if (STATIC && state.modelBuilt && framesSinceBuild === 8) {
      try {
        const url = renderer.domElement.toDataURL();
        console.log('[WM] static render done, dataURL len=' + url.length +
          ' sceneChildren=' + scene.children.length +
          ' labels=' + state.labels.length +
          ' labelVisible=' + state.labels.filter(s => s.visible).length);
      } catch (e) { console.log('[WM] static render err ' + e.message); }
    }
    if (!STATIC || framesSinceBuild < 8) requestAnimationFrame(animate);
  })();
}

/* ---------------- 材质 ---------------- */
const M = {
  wall:    new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.85, metalness: 0.02 }),
  slab:    new THREE.MeshStandardMaterial({ color: 0xf3f3f3, roughness: 0.9 }),
  roof:    new THREE.MeshStandardMaterial({ color: 0xeeeeee, roughness: 0.9 }),
  column:  new THREE.MeshStandardMaterial({ color: 0xfafafa, roughness: 0.8 }),
  ground:  new THREE.MeshStandardMaterial({ color: 0xdedede, roughness: 1 }),
  annot:   new THREE.LineBasicMaterial({ color: 0x9a9a9a, transparent: true, opacity: 0.8 }),
  glass:   new THREE.MeshStandardMaterial({ color: 0xf2f2f2, roughness: 0.12, metalness: 0.05, transparent: true, opacity: 0.45 }),
  handle:  new THREE.MeshStandardMaterial({ color: 0xd4d4d4, roughness: 0.35, metalness: 0.2 }),
};

function makeGroup(name) {
  const g = new THREE.Group();
  g.name = name;
  scene.add(g);
  state.groups[name] = g;
  return g;
}

function addBox(g, x0, y0, x1, y1, z0, z1, mat, castShadow) {
  const w = x1 - x0, h = y1 - y0, d = z1 - z0;
  if (w <= 0 || h <= 0 || d <= 0) return null;
  const geo = new THREE.BoxGeometry(w, d, h);
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.set(x0 + w / 2, z0 + d / 2, y0 + h / 2);
  mesh.castShadow = castShadow !== false;
  mesh.receiveShadow = true;
  g.add(mesh);
  return mesh;
}

function addLineLoop(g, pts, z, mat) {
  if (!pts || pts.length < 2) return;
  const v = [];
  for (const p of pts) v.push(new THREE.Vector3(p.x, z, p.y));
  const geo = new THREE.BufferGeometry().setFromPoints(v);
  const line = new THREE.LineLoop(geo, mat || M.annot);
  state.auxLines.push(line);
  g.add(line);
  return line;
}

/* 斜顶盒子（坡道）：底面 zA0→zA1、顶面 zB0→zB1，沿 X 或沿 Y 方向找坡 */
function addSlopedBox(g, x0, x1, y0, y1, zA0, zA1, zB0, zB1, mat, alongY) {
  let verts;
  if (alongY) {
    verts = new Float32Array([
      x0, zA0, y0,  x1, zA0, y0,  x1, zA1, y1,  x0, zA1, y1,
      x0, zB0, y0,  x1, zB0, y0,  x1, zB1, y1,  x0, zB1, y1,
    ]);
  } else {
    verts = new Float32Array([
      x0, zA0, y0,  x1, zA1, y0,  x1, zA1, y1,  x0, zA0, y1,
      x0, zB0, y0,  x1, zB1, y0,  x1, zB1, y1,  x0, zB0, y1,
    ]);
  }
  const idx = [
    0, 1, 2, 0, 2, 3,
    4, 6, 5, 4, 7, 6,
    0, 4, 5, 0, 5, 1,
    1, 5, 6, 1, 6, 2,
    2, 6, 7, 2, 7, 3,
    3, 7, 4, 3, 4, 0,
  ];
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(verts, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  const mat2 = mat.clone();
  mat2.side = THREE.DoubleSide;
  const mesh = new THREE.Mesh(geo, mat2);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  g.add(mesh);
  return mesh;
}

/* 门口坡道楔块：截面为直角三角形——水平长边贴室外地坪、竖直短边贴墙，
 * 斜面（斜边）为行走面，坡端收成薄边。wallPos = 墙外表面顺坡向坐标，
 * dir = 出墙方向（±1），c = 宽度方向中心，alongY = 坡道沿 Y 伸出。 */
function addRampWedge(g, wallPos, dir, len, c, width, bottomZ, topZ, mat, alongY) {
  const hw = width / 2, w0 = c - hw, w1 = c + hw;
  const tip = wallPos + dir * len;
  function P(u, s, w) { return alongY ? [w, s, u] : [u, s, w]; }
  const A0 = P(wallPos, bottomZ, w0), B0 = P(tip, bottomZ, w0), C0 = P(wallPos, topZ, w0);
  const A1 = P(wallPos, bottomZ, w1), B1 = P(tip, bottomZ, w1), C1 = P(wallPos, topZ, w1);
  const faces = [
    [A0, B0, B1], [A0, B1, A1],   /* 底面：贴地 */
    [A0, C1, C0], [A0, A1, C1],   /* 墙侧面：贴墙 */
    [B0, C0, C1], [B0, C1, B1],   /* 斜面：行走面 */
    [A0, B0, C0],                 /* 两端三角形端面：封口成实体 */
    [A1, B1, C1],
  ];
  /* 以形心为基准统一修正绕序：法线一律朝外，depth/normal 通道不会丢面 */
  const all = [A0, B0, C0, A1, B1, C1];
  const o = [0, 0, 0];
  for (const p of all) for (let i = 0; i < 3; i++) o[i] += p[i] / all.length;
  function outward(tri) {
    const p0 = tri[0], p1 = tri[1], p2 = tri[2];
    const e1 = [p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]];
    const e2 = [p2[0] - p0[0], p2[1] - p0[1], p2[2] - p0[2]];
    const nx = e1[1] * e2[2] - e1[2] * e2[1];
    const ny = e1[2] * e2[0] - e1[0] * e2[2];
    const nz = e1[0] * e2[1] - e1[1] * e2[0];
    const fc = [(p0[0] + p1[0] + p2[0]) / 3 - o[0],
                (p0[1] + p1[1] + p2[1]) / 3 - o[1],
                (p0[2] + p1[2] + p2[2]) / 3 - o[2]];
    return (nx * fc[0] + ny * fc[1] + nz * fc[2]) >= 0 ? tri : [p0, p2, p1];
  }
  const verts = [];
  for (const f of faces) {
    for (const p of outward(f)) verts.push(p[0], p[1], p[2]);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(verts), 3));
  geo.computeVertexNormals();
  const mat2 = mat.clone();
  mat2.side = THREE.DoubleSide;
  const mesh = new THREE.Mesh(geo, mat2);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  g.add(mesh);
  return mesh;
}

/* 雨篷截面挤出：profile 为 [u, v] 顶点数组（u=外挑方向，v=竖向），沿 w 方向挤出长度 len
 * 坐标约定：Three.js X=x, Y=height, Z=depth（与 addBox / addLineLoop 一致） */
function addExtrudedCanopy(g, profile, cx, cy, wLen, nx, ny, baseZ, mat) {
  if (!profile || profile.length < 3) return;
  const n = profile.length;
  const mat2 = mat.clone();
  mat2.side = THREE.DoubleSide;

  /* w 方向单位向量（水平，垂直于法线） */
  const wx = -ny, wy = nx;

  const verts = [];
  const idx = [];

  /* 侧面：profile 每条边沿 w 方向挤出形成四边形 */
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const [u0, v0] = profile[i];
    const [u1, v1] = profile[j];

    const p00 = { x: cx + u0 * nx,              y: baseZ + v0, z: cy + u0 * ny };
    const p10 = { x: cx + u1 * nx,              y: baseZ + v1, z: cy + u1 * ny };
    const p11 = { x: cx + u1 * nx + wLen * wx,  y: baseZ + v1, z: cy + u1 * ny + wLen * wy };
    const p01 = { x: cx + u0 * nx + wLen * wx,  y: baseZ + v0, z: cy + u0 * ny + wLen * wy };

    const base = verts.length / 3;
    verts.push(p00.x, p00.y, p00.z, p10.x, p10.y, p10.z, p11.x, p11.y, p11.z, p01.x, p01.y, p01.z);
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }

  /* 两端面：w=0 和 w=wLen 处的 profile 多边形 */
  for (let wIdx = 0; wIdx < 2; wIdx++) {
    const w = wIdx * wLen;
    const base = verts.length / 3;
    for (let i = 0; i < n; i++) {
      const [u, v] = profile[i];
      verts.push(cx + u * nx + w * wx, baseZ + v, cy + u * ny + w * wy);
    }
    /* 三角扇 */
    for (let i = 1; i < n - 1; i++) {
      if (wIdx === 0) idx.push(base, base + i, base + i + 1);
      else idx.push(base, base + i + 1, base + i);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(verts), 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  const mesh = new THREE.Mesh(geo, mat2);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  g.add(mesh);
  return mesh;
}

/* 平面环带（Shape + 孔洞），平铺在 z 高度 */
function addShapeRing(g, outer, inner, z, mat) {
  if (!outer || outer.length < 3) return;
  const shape = new THREE.Shape();
  outer.forEach((p, i) => {
    if (i === 0) shape.moveTo(p.x, -p.y); else shape.lineTo(p.x, -p.y);
  });
  shape.closePath();
  if (inner && inner.length >= 3) {
    const hole = new THREE.Path();
    inner.forEach((p, i) => {
      if (i === 0) hole.moveTo(p.x, -p.y); else hole.lineTo(p.x, -p.y);
    });
    hole.closePath();
    shape.holes.push(hole);
  }
  const geo = new THREE.ShapeGeometry(shape, 1);
  const mat2 = mat.clone();
  mat2.side = THREE.DoubleSide;
  const mesh = new THREE.Mesh(geo, mat2);
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.y = z;
  mesh.receiveShadow = true;
  g.add(mesh);
  return mesh;
}


function addCylinder(g, cx, cy, r, z0, z1, mat, seg) {
  const geo = new THREE.CylinderGeometry(r, r, z1 - z0, seg || 12);
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.set(cx, (z0 + z1) / 2, cy);
  mesh.castShadow = true;
  g.add(mesh);
  return mesh;
}

function addTextSprite(text, x, y, z, scale, color) {
  const canvas = document.createElement('canvas');
  canvas.width = 1024;
  canvas.height = 160;
  const ctx = canvas.getContext('2d');
  ctx.font = 'bold 92px "Microsoft YaHei", "PingFang SC", sans-serif';
  ctx.fillStyle = color || 'rgba(60,60,60,0.85)';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 512, 80);
  const tex = new THREE.CanvasTexture(canvas);
  tex.minFilter = THREE.LinearFilter;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthWrite: false, transparent: true }));
  const s = scale || 1100;
  sprite.scale.set(s * 6.4, s, 1);
  sprite.position.set(x, z, y);
  scene.add(sprite);
  state.labels.push(sprite);
  return sprite;
}

/* ---------------- JSON 解析 ---------------- */
function parseDrawing(json) {
  const frames = Array.isArray(json.ViewFrames) ? json.ViewFrames : [];
  if (!frames.length) throw new Error('JSON 中没有 ViewFrames 数组');

  const data = {
    walls: [], columns: [], doors: [], windows: [],
    rooms: [], ramps: [], foundations: [],
    steelStairs: [], steelPlatform: null, ladder: null,
    sump: null, stair: null, pipes: [],
    roofOuter: null, roofEaves: null, roofCanopies: [],
    apron: null, platform: null, texts: [],
    elev: {}, counts: {}, unknown: {},
  };

  /* 1. 找基准图框（配电间平面图，含完整墙体） */
  const base = frames.find(f => f.ViewKind === 4) || frames[0];
  const wallsOfBase = (base.Elements || []).filter(e => shortType(e) === 'WallObject');
  let ox = Infinity, oy = Infinity;
  for (const w of wallsOfBase) for (const p of w.Outline || []) {
    ox = Math.min(ox, p.X); oy = Math.min(oy, p.Y);
  }
  if (!isFinite(ox)) throw new Error('基准图框中没有墙体，无法确定建筑原点');
  const baseOrigin = { x: ox, y: oy };

  /* 2. 每个图框的轴线原点（轴线 1 ∩ 轴线 A） */
  function axisOrigin(frame) {
    let a1 = null, aA = null;
    for (const e of frame.Elements || []) {
      if (shortType(e) !== 'AxisObject') continue;
      if (e.Number === '1' && !a1) a1 = e.LocationLine.Start;
      if (e.Number === 'A' && !aA) aA = e.LocationLine;
    }
    if (!a1 || !aA) return null;
    return { x: a1.X, y: aA.Start.Y };
  }
  const baseAxis = axisOrigin(base);
  if (!baseAxis) throw new Error('基准图框缺少轴线 1 / A');

  function frameOffset(frame) {
    const ao = axisOrigin(frame);
    if (!ao) return null;
    return { x: baseOrigin.x + (ao.x - baseAxis.x), y: baseOrigin.y + (ao.y - baseAxis.y) };
  }
  const baseOff = frameOffset(base);
  const rel = (p, off) => ({ x: p.X - off.x, y: p.Y - off.y });

  /* 3. 遍历图框，收集图元 */
  const wallKeys = new Set();
  const colKeys = new Set();
  const dedupKeys = new Set();

  for (const frame of frames) {
    const off = frameOffset(frame);
    if (!off) { warn('图框「' + frame.ViewTypeName + '」缺少轴线，已跳过'); continue; }
    for (const e of frame.Elements || []) {
      const t = shortType(e);
      data.counts[t] = (data.counts[t] || 0) + 1;

      switch (t) {
        case 'WallObject': {
          const xs = [], ys = [];
          for (const p of e.Outline || []) { xs.push(p.X); ys.push(p.Y); }
          if (xs.length < 2) break;
          const b = {
            x0: Math.min.apply(null, xs) - off.x,
            y0: Math.min.apply(null, ys) - off.y,
            x1: Math.max.apply(null, xs) - off.x,
            y1: Math.max.apply(null, ys) - off.y,
            kind: e.Kind,
          };
          const key = [round(b.x0), round(b.y0), round(b.x1), round(b.y1)].join(',');
          if (wallKeys.has(key)) break;
          wallKeys.add(key);
          data.walls.push(b);
          break;
        }
        case 'StructuralColumnObject': {
          const c = rel(e.InsertionPoint, off);
          const key = [round(c.x, 0), round(c.y, 0), round(e.Length, 0), round(e.Width, 0)].join(',');
          if (colKeys.has(key)) break;
          colKeys.add(key);
          data.columns.push({ x: c.x, y: c.y, l: e.Length, w: e.Width });
          break;
        }
        case 'DoorObject': {
          const mid = e.OpeningMidpoint || e.InsertionPoint;
          data.doors.push({
            cx: mid.X - off.x, cy: mid.Y - off.y,
            w: e.Width, h: e.Height,
            kind: e.Kind, exterior: !!e.IsExterior, num: e.Number,
          });
          break;
        }
        case 'WindowObject': {
          const d = e.WallDirection || { X: 1, Y: 0 };
          const cx = e.InsertionPoint.X + d.X * e.Width / 2 - off.x;
          const cy = e.InsertionPoint.Y + d.Y * e.Width / 2 - off.y;
          data.windows.push({
            cx: cx, cy: cy, w: e.Width, h: e.Height, kind: e.Kind, num: e.Number,
          });
          break;
        }
        case 'StairObject': {
          const p = rel(e.InsertionPoint, off);
          data.stair = {
            x: p.x, y: p.y, steps1: e.FirstFlightStepCount,
            len1: e.FirstFlightLength, steps2: e.SecondFlightStepCount,
            len2: e.SecondFlightLength, single: e.IsSingleFlight,
          };
          break;
        }
        case 'SteelStairObject': {
          const p = rel(e.InsertionPoint, off);
          const key = [round(p.x, 0), round(p.y, 0)].join(',');
          if (dedupKeys.has('ss:' + key)) break;
          dedupKeys.add('ss:' + key);
          data.steelStairs.push({ x: p.x, y: p.y });
          break;
        }
        case 'SteelStairPlatformObject': {
          if (data.steelPlatform) break;
          data.steelPlatform = {
            x0: e.Bounds.Min.X - off.x, y0: e.Bounds.Min.Y - off.y,
            x1: e.Bounds.Max.X - off.x, y1: e.Bounds.Max.Y - off.y,
          };
          break;
        }
        case 'SteelLadderObject': {
          if (data.ladder) break;
          const p = rel(e.InsertionPoint, off);
          const n = e.FacingNormal || { X: 0, Y: -1 };
          data.ladder = { x: p.x, y: p.y, nx: n.X, ny: n.Y };
          break;
        }
        case 'SumpPitObject': {
          if (data.sump) break;
          data.sump = {
            x0: e.Bounds.Min.X - off.x, y0: e.Bounds.Min.Y - off.y,
            x1: e.Bounds.Max.X - off.x, y1: e.Bounds.Max.Y - off.y,
            elev: e.ElevationMm,
          };
          break;
        }
        case 'PumpFoundationObject': {
          const key = [round(e.Bounds.Min.X, 0), round(e.Bounds.Min.Y, 0)].join(',');
          if (dedupKeys.has('pf:' + key)) break;
          dedupKeys.add('pf:' + key);
          data.foundations.push({
            x0: e.Bounds.Min.X - off.x, y0: e.Bounds.Min.Y - off.y,
            x1: e.Bounds.Max.X - off.x, y1: e.Bounds.Max.Y - off.y,
          });
          break;
        }
        case 'RampObject': {
          const p = rel(e.InsertionPoint, off);
          const n = e.OutwardNormal || { X: 1, Y: 0 };
          data.ramps.push({ x: p.x, y: p.y, nx: n.X, ny: n.Y, l: e.Length, w: e.Width });
          break;
        }
        case 'ApronObject': {
          if (data.apron) break;
          data.apron = {
            inner: (e.InnerOutline || []).map(p => rel(p, off)),
            outer: (e.OuterOutline || []).map(p => rel(p, off)),
          };
          break;
        }
        case 'RoomOutlineObject': {
          const pts = (e.Outline || []).map(p => rel(p, off));
          data.rooms.push({ name: e.RoomName, pts: pts });
          break;
        }
        case 'MaintenancePlatformObject': {
          if (data.platform) break;
          data.platform = {
            x0: e.Bounds.Min.X - off.x, y0: e.Bounds.Min.Y - off.y,
            x1: e.Bounds.Max.X - off.x, y1: e.Bounds.Max.Y - off.y,
          };
          break;
        }
        case 'PlanElevationAnnotationObject': {
          if (data.elev[e.Kind] === undefined) data.elev[e.Kind] = e.ElevationMm;
          break;
        }
        case 'PlanMultilineTextObject': {
          const p = rel(e.InsertionPoint, off);
          data.texts.push({ text: e.Text, x: p.x, y: p.y });
          break;
        }
        case 'RoofPolylineObject': {
          const pts = (e.Vertices || []).map(p => rel(p, off));
          if (e.Kind === 0) {
            const xs = pts.map(p => p.x), ys = pts.map(p => p.y);
            data.roofOuter = {
              x0: Math.min.apply(null, xs), y0: Math.min.apply(null, ys),
              x1: Math.max.apply(null, xs), y1: Math.max.apply(null, ys),
            };
          } else if (e.Kind === 3) {
            const xs = pts.map(p => p.x), ys = pts.map(p => p.y);
            data.roofEaves = {
              x0: Math.min.apply(null, xs), y0: Math.min.apply(null, ys),
              x1: Math.max.apply(null, xs), y1: Math.max.apply(null, ys),
            };
          } else if (e.Kind === 4 && pts.length >= 4) {
            const xs = pts.map(p => p.x), ys = pts.map(p => p.y);
            data.roofCanopies.push({
              x0: Math.min.apply(null, xs), y0: Math.min.apply(null, ys),
              x1: Math.max.apply(null, xs), y1: Math.max.apply(null, ys),
            });
          }
          break;
        }
        case 'RoofRainPipeObject': {
          const c = rel(e.Center, off);
          data.pipes.push({ x: c.x, y: c.y, r: e.Diameter / 2 });
          break;
        }
        case 'BottomStairFlightObject':
        case 'AxisObject':
        case 'RoofHatchObject':
        case 'RoofDetailBlockObject':
        case 'DrainageTrenchObject':
        case 'BreakLineObject':
        case 'IntakeForebayObject':
        case 'IntakeChannelSlopeObject':
        case 'IntakeChannelFrontSectionObject':
        case 'ElectricalRoomObject':
        case 'PumpRoomObject':
        case 'MaintenancePlatformPartitionObject':
          break; /* 非主体结构，白模忽略 */
        default:
          data.unknown[t] = (data.unknown[t] || 0) + 1;
      }
    }
  }
  /* 墙体去重：水泵间图框与配电间图框的墙相互重叠，保留被包含关系中的大墙 */
  data.walls.sort((a, b) => ((b.x1 - b.x0) * (b.y1 - b.y0)) - ((a.x1 - a.x0) * (a.y1 - a.y0)));
  const acceptedWalls = [];
  for (const w of data.walls) {
    const dup = acceptedWalls.some(big =>
      w.x0 >= big.x0 - 1 && w.x1 <= big.x1 + 1 && w.y0 >= big.y0 - 1 && w.y1 <= big.y1 + 1);
    if (!dup) acceptedWalls.push(w);
  }
  data.walls = acceptedWalls;
  return data;
}

/* ---------------- 高度体系 ---------------- */
function buildLevels(data) {
  const zBase = data.elev[0] !== undefined ? data.elev[0] : 166759;
  const L = {
    base: 0,
    south: (data.elev[1] !== undefined ? data.elev[1] : 169200) - zBase,
    grade: (data.elev[3] !== undefined ? data.elev[3] : 168900) - zBase,
    roof: (data.elev[4] !== undefined ? data.elev[4] : 173800) - zBase,
    steel: (data.elev[5] !== undefined ? data.elev[5] : 167659) - zBase,
  };
  if (data.sump) L.sump = data.sump.elev - zBase;
  return L;
}

/* 开洞中心处的楼面高度：检修平台 / 南侧区块 = 2441，水泵间 = 0
 * ySplit = 南侧区块与水泵间的分界线（由南侧房间轮廓推导），不硬编码 */
function floorAt(L, platform, ySplit, x, y) {
  if (platform &&
      x >= platform.x0 - 150 && x <= platform.x1 + 150 &&
      y >= platform.y0 - 150 && y <= platform.y1 + 150) return L.south;
  if (y < ySplit) return L.south;
  return L.base;
}

/* ---------------- 墙体开洞 ---------------- */
function carveWall(box, openings) {
  const dx = box.x1 - box.x0, dy = box.y1 - box.y0;
  const alongY = dy >= dx;
  const L = alongY ? dy : dx;
  let rects = [[0, L, box.z0, box.z1]];
  for (const op of openings) {
    const a0 = clamp(op.a0, 0, L), a1 = clamp(op.a1, 0, L);
    const z0 = clamp(op.z0, box.z0, box.z1), z1 = clamp(op.z1, box.z0, box.z1);
    if (a1 - a0 < 1 || z1 - z0 < 1) continue;
    const next = [];
    for (const r of rects) {
      if (a0 <= r[0] && r[1] <= a1 && z0 <= r[2] && r[3] <= z1) continue;
      if (a0 > r[0]) next.push([r[0], Math.min(a0, r[1]), r[2], r[3]]);
      if (a1 < r[1]) next.push([Math.max(a1, r[0]), r[1], r[2], r[3]]);
      const ca0 = Math.max(r[0], a0), ca1 = Math.min(r[1], a1);
      if (z0 > r[2] && ca1 > ca0) next.push([ca0, ca1, r[2], Math.min(z0, r[3])]);
      if (z1 < r[3] && ca1 > ca0) next.push([ca0, ca1, Math.max(z1, r[2]), r[3]]);
    }
    rects = next;
  }
  const out = [];
  for (const r of rects) {
    if (r[1] - r[0] < 1 || r[3] - r[2] < 1) continue;
    if (alongY) out.push({ x0: box.x0, x1: box.x1, y0: box.y0 + r[0], y1: box.y0 + r[1], z0: r[2], z1: r[3] });
    else out.push({ x0: box.x0 + r[0], x1: box.x0 + r[1], y0: box.y0, y1: box.y1, z0: r[2], z1: r[3] });
  }
  return out;
}

function openingIntervalOnWall(wall, cx, cy, w) {
  const dx = wall.x1 - wall.x0, dy = wall.y1 - wall.y0;
  const alongY = dy >= dx;
  let a0, a1;
  if (alongY) { a0 = cy - w / 2; a1 = cy + w / 2; }
  else { a0 = cx - w / 2; a1 = cx + w / 2; }
  const L = alongY ? dy : dx;
  if (a1 < -5 || a0 > L + 5) return null;
  const eps = 5;
  const inside = alongY
    ? (cx >= wall.x0 - eps && cx <= wall.x1 + eps && cy >= wall.y0 - eps && cy <= wall.y1 + eps)
    : (cx >= wall.x0 - eps && cx <= wall.x1 + eps && cy >= wall.y0 - eps && cy <= wall.y1 + eps);
  if (!inside) return null;
  return { a0: a0, a1: a1, L: L, alongY: alongY };
}

/* 找包含洞口（中心+宽度）的墙 */
function findHostWall(walls, cx, cy, w) {
  for (const wall of walls) {
    if (openingIntervalOnWall(wall, cx, cy, w)) return wall;
  }
  return null;
}

/* 线稿叠加通道：对主要实体组按二面角阈值（30°）提取棱边黑线，挂到各自 mesh 下 */
function buildEdgeLines() {
  const names = ['walls', 'slabs', 'columns', 'roof', 'canopies', 'stairs', 'extra', 'families'];
  const lineMat = new THREE.LineBasicMaterial({
    color: 0x000000,
    polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1,
  });
  let n = 0;
  for (const name of names) {
    const grp = state.groups[name];
    if (!grp) continue;
    grp.traverse(o => {
      if (!o.isMesh || !o.geometry || !o.geometry.attributes ||
          !o.geometry.attributes.position) return;
      let edges = null;
      try { edges = new THREE.EdgesGeometry(o.geometry, 30); }
      catch (e) { return; }
      if (!edges.attributes.position.count) { edges.dispose(); return; }
      const ls = new THREE.LineSegments(edges, lineMat);
      ls.visible = false;              /* 默认隐藏，勾选“线稿叠加”或 ?lines=1 时显示 */
      o.add(ls);
      state.lineOverlays.push(ls);
      state.auxLines.push(ls);
      n++;
    });
  }
  state.lineCount = n;
}

function setLinesVisible(on) {
  state.linesOn = !!on;
  for (const ls of state.lineOverlays) ls.visible = state.linesOn;
  const el = document.getElementById('chk_lines');
  if (el) el.checked = state.linesOn;
}

function setLabelsVisible(on) {
  state.labelsOn = !!on;
  for (const s of state.labels) s.visible = state.labelsOn && state.channel === 'color';
}

/* ---------------- 出图通道（color / depth / normal） ----------------
 * depth：自定义线性深度着色（近白远黑、背景纯黑），比 MeshDepthMaterial 的
 * 非线性屏幕深度对 ControlNet Depth 条件更友好；
 * normal：MeshNormalMaterial（视野空间法线，朝向面 ≈ 128,128,255）。
 * 两个辅助通道隐藏线稿与文字标注，且与素模共用同一相机，保证几何边界对齐。
 */
function depthMaterial() {
  if (state._depthMat) return state._depthMat;
  const mat = new THREE.ShaderMaterial({
    uniforms: { uNear: { value: 1 }, uFar: { value: 100000 } },
    vertexShader: [
      'varying float vViewZ;',
      'void main() {',
      '  vec4 mv = modelViewMatrix * vec4(position, 1.0);',
      '  vViewZ = -mv.z;',
      '  gl_Position = projectionMatrix * mv;',
      '}',
    ].join('\n'),
    fragmentShader: [
      'uniform float uNear;',
      'uniform float uFar;',
      'varying float vViewZ;',
      'void main() {',
      '  float t = clamp((vViewZ - uNear) / max(uFar - uNear, 1.0), 0.0, 1.0);',
      '  gl_FragColor = vec4(vec3(1.0 - t), 1.0);',
      '}',
    ].join('\n'),
  });
  state._depthMat = mat;
  return mat;
}

function normalMaterial() {
  if (state._normalMat) return state._normalMat;
  state._normalMat = new THREE.MeshNormalMaterial();
  return state._normalMat;
}

/* 按当前相机到目标距离收紧深度映射区间（near/far 不影响像素位置，只影响深度分布） */
function tuneDepthUniforms() {
  const m = state._depthMat;
  if (!m || !camera) return;
  const dist = camera.position.distanceTo(controls.target);
  const b = state.bounds;
  const span = b
    ? Math.max(b.x1 - b.x0, b.z1 - b.z0, b.y1 - b.y0)
    : dist;
  m.uniforms.uNear.value = Math.max(dist - span, 1);
  m.uniforms.uFar.value = dist + span * 1.2;
}

function afterCameraMove() {
  if (state.channel === 'depth') tuneDepthUniforms();
}

function setChannel(mode) {
  if (['color', 'depth', 'normal'].indexOf(mode) < 0) mode = 'color';
  state.channel = mode;
  if (mode === 'depth') {
    scene.overrideMaterial = depthMaterial();
    tuneDepthUniforms();
    scene.background = new THREE.Color(0x000000);
  } else if (mode === 'normal') {
    scene.overrideMaterial = normalMaterial();
    scene.background = new THREE.Color(0x000000);
  } else {
    scene.overrideMaterial = null;
    scene.background = state.baseBackground;
    for (const ls of state.lineOverlays) ls.visible = state.linesOn;
  }
  const aux = mode !== 'color';
  for (const ls of state.auxLines) {
    ls.visible = aux ? false
      : (state.lineOverlays.indexOf(ls) >= 0 ? state.linesOn : true);
  }
  for (const s of state.labels) s.visible = !aux && state.labelsOn;
  const sel = document.getElementById('sel_channel');
  if (sel) sel.value = mode;
  if (renderer && scene && camera) renderer.render(scene, camera);
}

/* ---------------- 视图预设（由建筑包围盒推导，适配任意 JSON） ---------------- */
const VIEW_NAMES = [
  'iso-ne', 'iso-nw', 'iso-se', 'iso-sw',
  'elev-s', 'elev-n', 'elev-w', 'elev-e',
  'persp-1', 'persp-2',
];
/* 平面方位 → Three.js 方向：JSON 的 (X,Y) 映射到 (x,z)，南 = 计划 Y 小的一侧 */
const ISO_DIRS = { 'iso-ne': [1, 1], 'iso-nw': [-1, 1], 'iso-se': [1, -1], 'iso-sw': [-1, -1] };

function applyView(name) {
  const b = state.bounds;
  if (!b || !name || VIEW_NAMES.indexOf(name) < 0) return false;
  const cx = (b.x0 + b.x1) / 2, cz = (b.z0 + b.z1) / 2;
  const cy = (b.y0 + b.y1) / 2;
  const sx = b.x1 - b.x0, sz = b.z1 - b.z0, sy = b.y1 - b.y0;
  const diag = Math.sqrt(sx * sx + sz * sz + sy * sy);
  const gradeY = state.levels ? state.levels.grade : b.y0;
  let pos = null, target = [cx, cy, cz];
  if (ISO_DIRS[name]) {
    const d = ISO_DIRS[name];
    const h = diag * 0.75;
    pos = [cx + d[0] * h, b.y1 + diag * 0.6, cz + d[1] * h];
  } else if (name.indexOf('elev-') === 0) {
    const D = Math.max(sx, sz) * 1.5;
    if (name === 'elev-s') pos = [cx, cy, b.z0 - D];
    else if (name === 'elev-n') pos = [cx, cy, b.z1 + D];
    else if (name === 'elev-w') pos = [b.x0 - D, cy, cz];
    else pos = [b.x1 + D, cy, cz];
  } else { /* persp-1 / persp-2：室外地坪 + 1700 视高 */
    const eyeY = gradeY + 1700;
    target = [cx, gradeY + 2800, cz];
    if (name === 'persp-1') pos = [cx, eyeY, b.z0 - diag * 0.8];
    else pos = [cx + diag * 0.57, eyeY, b.z0 - diag * 0.57];
  }
  camera.position.set(pos[0], pos[1], pos[2]);
  controls.target.set(target[0], target[1], target[2]);
  controls.update();
  /* 人视视角模拟真实照片：裁掉室外地坪以下的基础 / 集水坑等地下构件
   * （地面板就在 grade 高度，裁剪面下移 10mm 避免边界抖动） */
  if (name.indexOf('persp-') === 0 && state.levels) {
    renderer.clippingPlanes = [new THREE.Plane(new THREE.Vector3(0, 1, 0), -(gradeY - 10))];
  } else {
    renderer.clippingPlanes = [];
  }
  afterCameraMove();
  renderer.render(scene, camera);
  return true;
}

/* ---------------- 出图脚本接口（tools/cdp-shot.mjs 批量模式调用） ---------------- */
window.WMShot = {
  built: function () { return !!state.modelBuilt; },
  views: function () { return VIEW_NAMES.slice(); },
  view: applyView,
  cam: function (px, py, pz, tx, ty, tz) {
    renderer.clippingPlanes = [];
    camera.position.set(px, py, pz);
    controls.target.set(tx, ty, tz);
    controls.update();
    afterCameraMove();
    renderer.render(scene, camera);
    return true;
  },
  channel: setChannel,
  info: function () {
    return JSON.stringify({
      channel: state.channel,
      bounds: state.bounds,
      camera: { pos: camera.position.toArray(), target: controls.target.toArray(), fov: camera.fov },
    });
  },
};

/* 建筑外轮廓 = 全部墙体 AABB 的并集；楼板 / 门窗朝向 / 地面 / 包围盒统一以它为准 */
function wallBounds(walls) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const w of walls) {
    x0 = Math.min(x0, w.x0); y0 = Math.min(y0, w.y0);
    x1 = Math.max(x1, w.x1); y1 = Math.max(y1, w.y1);
  }
  return { x0: x0, y0: y0, x1: x1, y1: y1 };
}

/* ---------------- 模型生成 ---------------- */
function buildModel(json, extras) {
  extras = extras || {};
  const data = parseDrawing(json);
  const L = buildLevels(data);

  const G = {
    walls: makeGroup('walls'),
    slabs: makeGroup('slabs'),
    columns: makeGroup('columns'),
    roof: makeGroup('roof'),
    canopies: makeGroup('canopies'),
    stairs: makeGroup('stairs'),
    extra: makeGroup('extra'),
    ground: makeGroup('ground'),
    families: makeGroup('families'),
    annot: makeGroup('annot'),
  };

  /* ---- 房间楼面 ---- */
  for (const r of data.rooms) {
    r.floor = r.name.includes('水泵间') ? L.base : L.south;
  }

  /* ---- 建筑外轮廓 + 南侧区块（楼面为 L.south 的房间并集）---- */
  const wb = wallBounds(data.walls);
  let sr = null;
  for (const r of data.rooms) {
    if (r.floor !== L.south) continue;
    for (const p of r.pts) {
      if (!sr) sr = { x0: p.x, y0: p.y, x1: p.x, y1: p.y };
      else {
        sr.x0 = Math.min(sr.x0, p.x); sr.y0 = Math.min(sr.y0, p.y);
        sr.x1 = Math.max(sr.x1, p.x); sr.y1 = Math.max(sr.y1, p.y);
      }
    }
  }
  /* 南侧区块与水泵间的楼面分界线（南侧房间轮廓的外缘）；无南侧房间时不做该区块 */
  const ySplit = sr ? sr.y1 : wb.y0;

  /* ---- 内墙起点高度：取相邻房间的最低楼面 ---- */
  function interiorWallZ0(wall) {
    let zmin = null;
    for (const r of data.rooms) {
      let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
      for (const p of r.pts) { bx0 = Math.min(bx0, p.x); by0 = Math.min(by0, p.y); bx1 = Math.max(bx1, p.x); by1 = Math.max(by1, p.y); }
      if (wall.x0 <= bx1 + 60 && wall.x1 >= bx0 - 60 && wall.y0 <= by1 + 60 && wall.y1 >= by0 - 60) {
        zmin = zmin === null ? r.floor : Math.min(zmin, r.floor);
      }
    }
    return zmin === null ? L.base : zmin;
  }

  /* ---- 墙体 + 门窗洞口 ---- */
  for (const wall of data.walls) {
    if (wall.kind === 0) { wall.z0 = L.base; wall.z1 = L.roof; }
    else { wall.z0 = interiorWallZ0(wall); wall.z1 = L.roof; }
  }

  const openings = [];
  for (const d of data.doors) {
    const z0 = floorAt(L, data.platform, ySplit, d.cx, d.cy);
    openings.push({ type: 'door', num: d.num, kind: d.kind, exterior: d.exterior,
                    cx: d.cx, cy: d.cy, w: d.w, h: d.h, z0: z0, z1: z0 + d.h });
  }
  for (const wnd of data.windows) {
    const z0 = L.south + 900; /* 窗台统一以配电/控制间标高 +900 */
    openings.push({ type: 'win', num: wnd.num, kind: wnd.kind,
                    cx: wnd.cx, cy: wnd.cy, w: wnd.w, h: wnd.h, z0: z0, z1: z0 + wnd.h });
  }

  for (const wall of data.walls) {
    const ops = [];
    for (const op of openings) {
      const iv = openingIntervalOnWall(wall, op.cx, op.cy, op.w);
      if (!iv) continue;
      if (op.z1 < wall.z0 - 5 || op.z0 > wall.z1 + 5) continue;
      ops.push({ a0: iv.a0, a1: iv.a1, z0: op.z0, z1: op.z1, type: op.type, num: op.num });
    }
    const pieces = carveWall({ ...wall, z0: wall.z0, z1: wall.z1 }, ops);
    for (const p of pieces) addBox(G.walls, p.x0, p.y0, p.x1, p.y1, p.z0, p.z1, M.wall);
    if (ops.length) log(`墙体 [${fmt(wall.x0)},${fmt(wall.y0)}]-[${fmt(wall.x1)},${fmt(wall.y1)}] 开洞 ${ops.length} 个`);
  }

  /* ---- 楼板 ---- */
  /* 水泵间底板：整栋建筑外轮廓，厚 200 */
  addBox(G.slabs, wb.x0, wb.y0, wb.x1, wb.y1, L.base - 200, L.base, M.slab);
  /* 南侧区块室内填板：房间轮廓并集；靠建筑外缘的一侧在墙厚量级内兜到外墙面，避免墙下漏空 */
  if (sr) {
    const snap = 400;
    const sx0 = (sr.x0 - wb.x0 <= snap) ? wb.x0 : sr.x0;
    const sx1 = (wb.x1 - sr.x1 <= snap) ? wb.x1 : sr.x1;
    const sy0 = (sr.y0 - wb.y0 <= snap) ? wb.y0 : sr.y0;
    addBox(G.slabs, sx0, sy0, sx1, sr.y1, L.grade, L.south, M.slab);
    log(`楼板：底板 ${fmt(wb.x0)}×${fmt(wb.y0)} - ${fmt(wb.x1)}×${fmt(wb.y1)}（厚 200）· ` +
        `南侧填板 ${fmt(sx0)}×${fmt(sy0)} - ${fmt(sx1)}×${fmt(sr.y1)}（${fmt(L.south - L.grade)} 厚）· ` +
        `分界 y=${fmt(ySplit)}`);
  } else {
    warn('未解析到南侧房间轮廓，跳过南侧室内填板');
  }
  if (data.platform) {
    addBox(G.slabs, data.platform.x0, data.platform.y0, data.platform.x1, data.platform.y1,
           L.grade, L.south, M.slab);
  }
  if (data.steelPlatform) {
    addBox(G.slabs, data.steelPlatform.x0, data.steelPlatform.y0, data.steelPlatform.x1, data.steelPlatform.y1,
           L.steel - 40, L.steel, M.slab);
  }

  /* ---- 结构柱 ---- */
  for (const c of data.columns) {
    addBox(G.columns, c.x - c.l / 2, c.y - c.w / 2, c.x + c.l / 2, c.y + c.w / 2, L.base, L.roof, M.column);
  }

  /* ---- 屋面（屋面板 + 挑檐截面放样 + 雨篷 + 雨水管） ---- */
  if (data.roofOuter) {
    const r = data.roofOuter;
    const prof = (extras && extras.eavesProfile) || null;
    if (prof && window.WMEaves) {
      /* 屋面板覆盖建筑投影；挑檐外沿由截面沿外墙路径放样生成 */
      addBox(G.roof, r.x0, r.y0, r.x1, r.y1, L.roof - 150, L.roof, M.roof);
      const en = window.WMEaves.build(G.roof,
        { rect: { x0: r.x0, y0: r.y0, x1: r.x1, y1: r.y1 }, roofZ: L.roof },
        prof, M.roof);
      log(`挑檐：${prof.name || '自定义截面'} 放样生成 ${en} 个面`);
    } else {
      const e = data.roofEaves;
      let x0, y0, x1, y1;
      if (e) { x0 = e.x0; y0 = e.y0; x1 = e.x1; y1 = e.y1; }
      else {
        x0 = r.x0 - 500; y0 = r.y0 - 500;
        x1 = r.x1 + 500; y1 = r.y1 + 500;
      }
      addBox(G.roof, x0, y0, x1, y1, L.roof - 150, L.roof, M.roof);
    }
    for (const p of data.pipes) {
      addCylinder(G.roof, p.x, p.y, p.r, L.base, L.roof, M.roof, 10);
    }
  }

  /* ---- 楼梯 ---- */
  if (data.stair) {
    const s = data.stair;
    const n = s.steps1 || 5;
    const riser = 250, tread = s.len1 / n;
    const x0 = s.x - 500, x1 = s.x + 500;
    for (let i = 0; i < n; i++) {
      addBox(G.stairs, x0, s.y + tread * i, x1, s.y + tread * (i + 1),
             riser * i, riser * (i + 1), M.slab);
    }
  }
  for (const ss of data.steelStairs) {
    const n = 3, riser = 300, tread = 300;
    for (let i = 0; i < n; i++) {
      addBox(G.stairs, ss.x - 400, ss.y - 450 + tread * i, ss.x + 400, ss.y - 450 + tread * (i + 1),
             riser * i, riser * (i + 1), M.slab);
    }
  }
  if (data.ladder) {
    const lad = data.ladder;
    const x0 = lad.x - 300, x1 = lad.x + 300;
    const h = 3200, rungStep = 300;
    addBox(G.stairs, x0, lad.y - 30, x0 + 60, lad.y + 30, L.base, h, M.slab);
    addBox(G.stairs, x1 - 60, lad.y - 30, x1, lad.y + 30, L.base, h, M.slab);
    for (let z = 200; z < h; z += rungStep) {
      addBox(G.stairs, x0 + 60, lad.y - 30, x1 - 60, lad.y + 30, z - 20, z + 20, M.slab);
    }
  }

  /* ---- 设备基础 / 集水坑 / 坡道 ---- */
  for (const f of data.foundations) {
    addBox(G.extra, f.x0, f.y0, f.x1, f.y1, L.base, L.base + 300, M.slab);
  }
  if (data.sump) {
    const s = data.sump;
    const zB = L.sump !== undefined ? L.sump : -1500;
    addBox(G.extra, s.x0, s.y0, s.x0 + 100, s.y1, zB, L.base, M.slab);
    addBox(G.extra, s.x1 - 100, s.y0, s.x1, s.y1, zB, L.base, M.slab);
    addBox(G.extra, s.x0, s.y0, s.x1, s.y0 + 100, zB, L.base, M.slab);
    addBox(G.extra, s.x0, s.y1 - 100, s.x1, s.y1, zB, L.base, M.slab);
    addBox(G.extra, s.x0, s.y0, s.x1, s.y1, zB, zB + 100, M.slab);
  }

  /* ---- 地面 + 散水 ---- */
  const gx0 = wb.x0, gy0 = wb.y0, gx1 = wb.x1, gy1 = wb.y1;
  const groundOffset = 5000;
  const groundInner = [
    { x: gx0, y: gy0 }, { x: gx1, y: gy0 },
    { x: gx1, y: gy1 }, { x: gx0, y: gy1 },
  ];
  const groundOuter = [
    { x: gx0 - groundOffset, y: gy0 - groundOffset }, { x: gx1 + groundOffset, y: gy0 - groundOffset },
    { x: gx1 + groundOffset, y: gy1 + groundOffset }, { x: gx0 - groundOffset, y: gy1 + groundOffset },
  ];
  const groundThickness = 300;
  const gz0 = L.grade - groundThickness, gz1 = L.grade;
  addBox(G.ground, gx0 - groundOffset, gy0 - groundOffset, gx1 + groundOffset, gy0, gz0, gz1, M.ground);
  addBox(G.ground, gx0 - groundOffset, gy1, gx1 + groundOffset, gy1 + groundOffset, gz0, gz1, M.ground);
  addBox(G.ground, gx0 - groundOffset, gy0, gx0, gy1, gz0, gz1, M.ground);
  addBox(G.ground, gx1, gy0, gx1 + groundOffset, gy1, gz0, gz1, M.ground);
  addLineLoop(G.ground, groundOuter, L.grade + 10);
  addLineLoop(G.ground, groundInner, L.grade + 10);
  log(`地面/散水：内轮廓 ${fmt(gx0)}×${fmt(gy0)} - ${fmt(gx1)}×${fmt(gy1)}，外偏 ${fmt(groundOffset)} mm，厚 ${fmt(groundThickness)} mm`);

  /* ---- 房间轮廓 + 标注 ---- */
  const roomSeen = new Set();
  for (const r of data.rooms) {
    const z = r.floor + 6;
    addLineLoop(G.annot, r.pts, z);
    if (!roomSeen.has(r.name)) {
      roomSeen.add(r.name);
      const cx = r.pts.reduce((s, p) => s + p.x, 0) / r.pts.length;
      const cy = r.pts.reduce((s, p) => s + p.y, 0) / r.pts.length;
      addTextSprite(r.name, cx, cy, r.floor + 200, 1100);
    }
  }
  if (data.platform) {
    addLineLoop(G.annot, [
      { x: data.platform.x0, y: data.platform.y0 }, { x: data.platform.x1, y: data.platform.y0 },
      { x: data.platform.x1, y: data.platform.y1 }, { x: data.platform.x0, y: data.platform.y1 },
    ], L.south + 6);
    addTextSprite('检修平台', (data.platform.x0 + data.platform.x1) / 2, (data.platform.y0 + data.platform.y1) / 2, L.south + 200, 900);
  }
  if (data.sump) {
    addTextSprite('集水坑', (data.sump.x0 + data.sump.x1) / 2, (data.sump.y0 + data.sump.y1) / 2, L.base + 200, 700);
  }

  /* ---- 门窗族实例 ---- */
  if (window.WMFamilies && openings.length) {
    const bcx = (wb.x0 + wb.x1) / 2, bcy = (wb.y0 + wb.y1) / 2;
    for (const op of openings) {
      const host = findHostWall(data.walls, op.cx, op.cy, op.w);
      if (!host) continue;
      op.tw = Math.min(host.x1 - host.x0, host.y1 - host.y0);
      const alongY = (host.y1 - host.y0) >= (host.x1 - host.x0);
      op.ax = alongY ? 0 : 1;
      op.ay = alongY ? 1 : 0;
      /* 法线方向：根据洞口相对于建筑中心的位置确定朝向 */
      if (alongY) {
        /* 墙体沿 Y 方向，法线沿 X 方向 */
        op.nx = op.cx < bcx ? -1 : 1;
        op.ny = 0;
      } else {
        /* 墙体沿 X 方向，法线沿 Y 方向 */
        op.nx = 0;
        op.ny = op.cy < bcy ? -1 : 1;
      }
      op.placed = true;
    }
    const placed = openings.filter(o => o.placed);
    const famRes = window.WMFamilies.build(G.families, placed, {
      frame: M.wall, leaf: M.slab, glass: M.glass, handle: M.handle,
    });
    log(`门窗族：${famRes.total} 组（门 ${placed.filter(o => o.type === 'door').length} · 窗 ${placed.filter(o => o.type === 'win').length}）`);
  }

  /* ---- 雨篷：紧贴外墙，位于门洞上方，从墙面往外挑出 ---- */
  const canopyProfile = extras && extras.canopyProfile ? extras.canopyProfile.profile : null;
  const canopyDoors = openings.filter(op => op.type === 'door' && op.exterior && op.placed);
  for (const door of canopyDoors) {
    const canopyW = door.w + 400; /* 雨篷宽度 = 门洞宽度 + 两侧各 200mm */
    const doorTopZ = door.z0 + door.h; /* 门洞顶部标高 */

    /* 雨篷内边缘（紧贴墙面）位置：墙体外表面、门洞中心 */
    const wallOuterX = door.cx + door.nx * door.tw / 2;
    const wallOuterY = door.cy + door.ny * door.tw / 2;

    if (canopyProfile) {
      /* 放样路径与门洞顶部轮廓线共线：起点为放样长度居中于门洞中心的一端 */
      const wx = -door.ny, wy = door.nx;
      const startX = wallOuterX - wx * canopyW / 2;
      const startY = wallOuterY - wy * canopyW / 2;
      /* 使用截面（黄色轮廓线）挤出形成实体雨篷，截面 u=0 紧贴墙面，u>0 向外挑出 */
      addExtrudedCanopy(G.canopies, canopyProfile, startX, startY, canopyW, door.nx, door.ny, doorTopZ, M.roof);
    } else {
      /* 回退：无截面数据时用简单斜板 */
      const canopyD = 700;
      const slopeDrop = 50;
      if (Math.abs(door.nx) > Math.abs(door.ny)) {
        const x0 = wallOuterX, x1 = wallOuterX + door.nx * canopyD;
        const y0 = door.cy - canopyW / 2, y1 = door.cy + canopyW / 2;
        addSlopedBox(G.canopies, x0, x1, y0, y1, doorTopZ, doorTopZ - slopeDrop, doorTopZ, doorTopZ - slopeDrop, M.roof, false);
      } else {
        const x0 = door.cx - canopyW / 2, x1 = door.cx + canopyW / 2;
        const y0 = wallOuterY, y1 = wallOuterY + door.ny * canopyD;
        addSlopedBox(G.canopies, x0, x1, y0, y1, doorTopZ, doorTopZ, doorTopZ - slopeDrop, doorTopZ - slopeDrop, M.roof, true);
      }
    }
  }
  log(`雨篷：${canopyDoors.length} 组`);

  /* ---- 坡道：紧贴外门，居中于门洞，截面为直角三角形（长直角边贴地） ---- */
  const rampDoors = openings.filter(op => op.type === 'door' && op.exterior && op.placed);
  for (const door of rampDoors) {
    const rampW = door.w + 200;
    const rampL = 1500;
    if (Math.abs(door.nx) > Math.abs(door.ny)) {
      const wallX = door.cx + door.nx * door.tw / 2;
      addRampWedge(G.extra, wallX, door.nx > 0 ? 1 : -1, rampL, door.cy, rampW,
                   L.grade, L.south, M.ground, false);
    } else {
      const wallY = door.cy + door.ny * door.tw / 2;
      addRampWedge(G.extra, wallY, door.ny > 0 ? 1 : -1, rampL, door.cx, rampW,
                   L.grade, L.south, M.ground, true);
    }
  }

  /* ---- 线稿叠加通道 ---- */
  buildEdgeLines();

  /* ---- 建筑包围盒与标高表（供视图预设 / 出图脚本使用） ---- */
  let bx0 = wb.x0, by0 = wb.y0, bx1 = wb.x1, by1 = wb.y1;
  for (const r of [data.roofOuter, data.roofEaves]) {
    if (!r) continue;
    bx0 = Math.min(bx0, r.x0); by0 = Math.min(by0, r.y0);
    bx1 = Math.max(bx1, r.x1); by1 = Math.max(by1, r.y1);
  }
  state.levels = L;
  state.bounds = {
    x0: bx0, x1: bx1, z0: by0, z1: by1,
    y0: data.sump ? Math.min(L.sump, L.base - 200) : L.base - 200,
    y1: L.roof,
  };

  /* ---- 统计 ---- */
  log(`墙体 ${data.walls.length} 面（含开洞）`);
  log(`门 ${data.doors.length} 樘 / 窗 ${data.windows.length} 扇`);
  log(`结构柱 ${data.columns.length} 根`);
  log(`楼面标高：水泵间 ${fmt(L.base)} · 配电/控制间 ${fmt(L.south)} · 屋面 ${fmt(L.roof)} mm`);
  if (data.stair) log(`建筑楼梯：${data.stair.steps1} 级（单跑）`);
  log(`钢楼梯 ${data.steelStairs.length} 部 · 钢爬梯 ${data.ladder ? 1 : 0} 部`);
  const unk = Object.keys(data.unknown);
  if (unk.length) warn(`未识别的图元类型：${unk.join('、')}（已跳过）`);

  return { data, L };
}

/* ---------------- UI 绑定 ---------------- */
function bindUI() {
  const fileInput = document.getElementById('fileInput');
  const loadBtn = document.getElementById('loadBtn');
  const dropzone = document.getElementById('dropzone');
  const stats = document.getElementById('stats');
  const errEl = document.getElementById('err');
  const errMsg = document.getElementById('errMsg');

  function showError(msg) { errMsg.textContent = msg; errEl.style.display = 'flex'; }

  function clearModel() {
    for (const g of Object.values(state.groups)) {
      scene.remove(g);
      while (g.children.length) g.remove(g.children[0]);
    }
    for (const s of state.labels) scene.remove(s);
    state.groups = {}; state.labels = []; state.lineOverlays = [];
    state.log = []; state.warnings = [];
  }

  function syncRead(url) {
    try {
      const x = new XMLHttpRequest();
      x.open('GET', url, false);
      x.send(null);
      return (x.status === 200) ? x.responseText : null;
    } catch (e) { return null; }
  }

  async function resolveExtras() {
    const readJSON = async (inlineId, url) => {
      if (STATIC) {
        const txt = syncRead(url);
        if (txt !== null) { try { return JSON.parse(txt); } catch (e) {} }
      } else {
        try { const r = await fetch(url); if (r.ok) return await r.json(); } catch (e) {}
      }
      const el = document.getElementById(inlineId);
      if (el && el.textContent.trim()) { try { return JSON.parse(el.textContent); } catch (e) {} }
      return null;
    };
    const readText = async (inlineId, url) => {
      if (STATIC) {
        const txt = syncRead(url);
        if (txt !== null) return txt;
      } else {
        try { const r = await fetch(url); if (r.ok) return await r.text(); } catch (e) {}
      }
      const el = document.getElementById(inlineId);
      if (el && el.textContent.trim()) return el.textContent;
      return null;
    };
    const [eavesProfile, canopyProfile, terrainReg, terrainObj] = await Promise.all([
      readJSON('eavesProfileData', 'data/eaves-profile.json'),
      readJSON('canopyProfileData', 'data/canopy-profile.json'),
      readJSON('terrainRegData', 'data/terrain-registration.json'),
      readText('terrainObjData', 'data/terrain.obj'),
    ]);
    const terrain = (terrainReg && terrainObj) ? { reg: terrainReg, objText: terrainObj } : null;
    return { eavesProfile, canopyProfile, terrain };
  }

  function applyUrlParams() {
    const p = new URLSearchParams(location.search);
    if (p.get('lines') === '1') setLinesVisible(true);
    if (p.get('annot') === '0') {
      const g = state.groups.annot;
      if (g) g.visible = false;
      setLabelsVisible(false);
      const el = document.getElementById('chk_annot');
      if (el) el.checked = false;
    }
    const bg = p.get('bg');
    if (bg && /^[0-9a-fA-F]{6}$/.test(bg)) {
      state.baseBackground = new THREE.Color('#' + bg);
      scene.background = state.baseBackground;
    }
    const view = p.get('view');
    if (view) applyView(view);
    const ch = p.get('channel');
    if (ch) setChannel(ch);
  }

  async function build(json) {
    clearModel();
    try {
      const extras = await resolveExtras();
      const { data, L } = buildModel(json, extras);
      state.modelBuilt = true;
      applyUrlParams();
      controls.update();
      renderer.render(scene, camera);   /* 立即渲染一帧，保证截图/首帧可见 */
      stats.innerHTML =
        `<b>${json.DrawingName || '未知图纸'}</b><br>` +
        `图框 ${(json.ViewFrames || []).length} 个<br>` +
        `墙体 ${data.walls.length} · 门 ${data.doors.length} · 窗 ${data.windows.length}<br>` +
        `柱 ${data.columns.length} · 楼梯 ${data.steelStairs.length + (data.stair ? 1 : 0)}<br>` +
        `标高：泵间 ${fmt(L.base)} / 配电 ${fmt(L.south)} / 屋面 ${fmt(L.roof)} mm` +
        (state.warnings.length ? `<br><span style="color:#b23">${state.warnings.length} 条告警</span>` : '');
      document.getElementById('legend').textContent =
        'Z=0 水泵间地面 · ' + fmt(L.south) + ' 配电/控制间 · ' + fmt(L.roof) + ' 屋面 (mm)';
      dropzone.classList.remove('active');
    } catch (e) {
      showError('解析失败：' + e.message);
      console.error(e);
    }
  }

  function readFile(file) {
    const reader = new FileReader();
    reader.onload = () => {
      try { build(JSON.parse(reader.result)); }
      catch (e) { showError('JSON 解析失败：' + e.message); }
    };
    reader.onerror = () => showError('文件读取失败');
    reader.readAsText(file, 'utf-8');
  }

  loadBtn.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => { if (fileInput.files[0]) readFile(fileInput.files[0]); });

  document.addEventListener('dragover', e => { e.preventDefault(); dropzone.classList.add('active'); });
  document.addEventListener('dragleave', e => {
    if (e.target === document.documentElement) dropzone.classList.remove('active');
  });
  document.addEventListener('drop', e => {
    e.preventDefault();
    dropzone.classList.remove('active');
    if (e.dataTransfer.files && e.dataTransfer.files[0]) readFile(e.dataTransfer.files[0]);
  });

  const chkMap = {
    chk_walls: 'walls', chk_slabs: 'slabs', chk_columns: 'columns',
    chk_roof: 'roof', chk_canopies: 'canopies', chk_stairs: 'stairs', chk_extra: 'extra',
    chk_ground: 'ground', chk_families: 'families', chk_annot: 'annot',
  };
  for (const id in chkMap) {
    const el = document.getElementById(id);
    el.addEventListener('change', () => {
      const g = state.groups[chkMap[id]];
      if (g) g.visible = el.checked;
      if (chkMap[id] === 'annot') setLabelsVisible(el.checked);
    });
  }
  const chkLines = document.getElementById('chk_lines');
  if (chkLines) {
    chkLines.addEventListener('change', () => setLinesVisible(chkLines.checked));
  }

  /* 全选 / 取消全选 */
  const btnSelectAll = document.getElementById('btn_select_all');
  const btnDeselectAll = document.getElementById('btn_deselect_all');
  if (btnSelectAll) {
    btnSelectAll.addEventListener('click', () => {
      for (const id in chkMap) {
        const el = document.getElementById(id);
        if (el) { el.checked = true; const g = state.groups[chkMap[id]]; if (g) g.visible = true; }
      }
      if (chkLines) { chkLines.checked = true; setLinesVisible(true); }
      setLabelsVisible(true);
    });
  }
  if (btnDeselectAll) {
    btnDeselectAll.addEventListener('click', () => {
      for (const id in chkMap) {
        const el = document.getElementById(id);
        if (el) { el.checked = false; const g = state.groups[chkMap[id]]; if (g) g.visible = false; }
      }
      if (chkLines) { chkLines.checked = false; setLinesVisible(false); }
      setLabelsVisible(false);
    });
  }
  const selChannel = document.getElementById('sel_channel');
  if (selChannel) {
    selChannel.addEventListener('change', () => setChannel(selChannel.value));
  }

  /* 默认尝试加载示例 JSON */
  (async function loadDefault() {
    const inlineData = () => {
      const el = document.getElementById('sampleData');
      if (!el || !el.textContent.trim()) return null;
      try { return JSON.parse(el.textContent); } catch (e) { return null; }
    };
    if (STATIC) {
      /* 静态截图模式：直接读页面内嵌的示例数据，避免网络时序竞争 */
      const d = inlineData();
      if (d) { build(d); return; }
    }
    const candidates = ['data/sample.json', '../Flie/输入文件/PlanFundingDrawing_2071793a1bc84bd2bb794bcfe680f313.json'];
    for (const p of candidates) {
      try {
        const r = await fetch(p);
        if (r.ok) { build(await r.json()); return; }
      } catch (e) { /* 继续尝试 */ }
    }
    const d = inlineData();
    if (d) { build(d); return; }
    dropzone.classList.add('active');
  })();
}

initThree();
bindUI();
})();
