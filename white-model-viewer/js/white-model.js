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
};

function log(msg) { state.log.push(msg); }
function warn(msg) { state.warnings.push(msg); log('⚠ ' + msg); }

/* ---------------- Three.js 初始化 ---------------- */
let renderer, scene, camera, controls;
const STATIC = /[?&]static=1/.test(location.search);
function initThree() {
  const container = document.getElementById('viewer');
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0xe9e9e9);

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
  g.add(new THREE.LineLoop(geo, mat || M.annot));
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

/* 平面环带（Shape + 孔洞），平铺在 z 高度 */
function addShapeRing(g, outer, inner, z, mat) {
  if (!outer || outer.length < 3) return;
  const shape = new THREE.Shape();
  outer.forEach((p, i) => {
    if (i === 0) shape.moveTo(p.x, p.y); else shape.lineTo(p.x, p.y);
  });
  shape.closePath();
  if (inner && inner.length >= 3) {
    const hole = new THREE.Path();
    inner.forEach((p, i) => {
      if (i === 0) hole.moveTo(p.x, p.y); else hole.lineTo(p.x, p.y);
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

/* 开洞中心处的楼面高度：检修平台 / 南侧房间 = 2441，水泵间 = 0 */
function floorAt(L, platform, x, y) {
  if (platform &&
      x >= platform.x0 - 150 && x <= platform.x1 + 150 &&
      y >= platform.y0 - 150 && y <= platform.y1 + 150) return L.south;
  if (y < 4800) return L.south;
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

/* ---------------- 模型生成 ---------------- */
function buildModel(json) {
  const data = parseDrawing(json);
  const L = buildLevels(data);

  const G = {
    walls: makeGroup('walls'),
    slabs: makeGroup('slabs'),
    columns: makeGroup('columns'),
    roof: makeGroup('roof'),
    stairs: makeGroup('stairs'),
    extra: makeGroup('extra'),
    ground: makeGroup('ground'),
    annot: makeGroup('annot'),
  };

  /* ---- 房间楼面 ---- */
  for (const r of data.rooms) {
    r.floor = r.name.includes('水泵间') ? L.base : L.south;
  }

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
    const z0 = floorAt(L, data.platform, d.cx, d.cy);
    openings.push({ type: 'door', num: d.num, cx: d.cx, cy: d.cy, w: d.w, z0: z0, z1: z0 + d.h });
  }
  for (const wnd of data.windows) {
    const floor = floorAt(L, data.platform, wnd.cx, wnd.cy);
    const z0 = floor + 900; /* 窗台高 900 */
    openings.push({ type: 'win', num: wnd.num, cx: wnd.cx, cy: wnd.cy, w: wnd.w, z0: z0, z1: z0 + wnd.h });
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
  addBox(G.slabs, 0, 0, 7200, 15100, L.base - 200, L.base, M.slab);
  addBox(G.slabs, 0, 0, 7200, 4800, L.grade, L.south, M.slab);
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

  /* ---- 屋面 ---- */
  if (data.roofOuter) {
    const e = data.roofEaves;
    let x0, y0, x1, y1;
    if (e) { x0 = e.x0; y0 = e.y0; x1 = e.x1; y1 = e.y1; }
    else {
      x0 = data.roofOuter.x0 - 500; y0 = data.roofOuter.y0 - 500;
      x1 = data.roofOuter.x1 + 500; y1 = data.roofOuter.y1 + 500;
    }
    addBox(G.roof, x0, y0, x1, y1, L.roof - 150, L.roof, M.roof);
    for (const c of data.roofCanopies) {
      addBox(G.roof, c.x0, c.y0, c.x1, c.y1, L.roof - 150, L.roof, M.roof);
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
  for (const r of data.ramps) {
    /* 由外墙处（门标高 2441）向外降到室外地坪（2141），板厚 100 */
    const alongX = Math.abs(r.nx) > Math.abs(r.ny);
    const topWall = L.south, topOuter = L.grade;
    if (alongX) {
      const x0 = r.nx > 0 ? r.x : r.x - r.l;
      const x1 = x0 + r.l;
      addSlopedBox(G.extra, x0, x1, r.y - r.w / 2, r.y + r.w / 2,
                   topWall - 100, topOuter - 100, topWall, topOuter, M.ground, false);
    } else {
      const y0 = r.ny > 0 ? r.y : r.y - r.l;
      const y1 = y0 + r.l;
      addSlopedBox(G.extra, r.x - r.w / 2, r.x + r.w / 2, y0, y1,
                   topWall - 100, topOuter - 100, topWall, topOuter, M.ground, true);
    }
  }

  /* ---- 地面 + 散水 ---- */
  /* 地面开洞避开下沉的水泵间（北半部） */
  addShapeRing(G.ground,
    [{ x: -4000, y: -4000 }, { x: 12000, y: -4000 }, { x: 12000, y: 20000 }, { x: -4000, y: 20000 }],
    [{ x: 0, y: 4800 }, { x: 7200, y: 4800 }, { x: 7200, y: 15100 }, { x: 0, y: 15100 }],
    L.grade, M.ground);
  if (data.apron) {
    addShapeRing(G.ground, data.apron.outer, data.apron.inner, L.grade + 5, M.ground);
    addLineLoop(G.ground, data.apron.outer, L.grade + 10);
  }

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
    state.groups = {}; state.labels = []; state.log = []; state.warnings = [];
  }

  function build(json) {
    clearModel();
    try {
      const { data, L } = buildModel(json);
      state.modelBuilt = true;
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
    chk_roof: 'roof', chk_stairs: 'stairs', chk_extra: 'extra',
    chk_ground: 'ground', chk_annot: 'annot',
  };
  for (const id in chkMap) {
    const el = document.getElementById(id);
    el.addEventListener('change', () => {
      const g = state.groups[chkMap[id]];
      if (g) g.visible = el.checked;
      for (const s of state.labels) s.visible = document.getElementById('chk_annot').checked;
    });
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
