/* 门窗参数化族（v0.2）
 * 当前为通用占位族：单开门 / 双开门 / 双向单开门 / 固定窗 / 双扇窗 / 防火观察窗。
 * 后续拿到 2D CAD 大样后，用真实几何替换对应 builder 即可，调用接口不变。
 *
 * 洞口实例 op：
 *   cx, cy  洞口中心（建筑平面坐标，mm）
 *   z0, h   洞口底标高与高度
 *   w       洞口宽度（沿墙方向）
 *   tw      墙厚（洞口深度方向）
 *   ax, ay  沿墙方向单位向量（平面）
 *   nx, ny  墙体外法线单位向量（平面）
 *   type    'door' | 'win'
 *   kind    DoorObject.Kind / WindowObject.Kind
 *   num     编号（M1824 / C1518 ...）
 */
(function () {
'use strict';

const FRAME_W = 70;   /* 框料宽度 */
const LEAF_T = 45;    /* 门扇厚度 */
const GLASS_T = 8;    /* 玻璃厚度 */

function defaultMats() {
  const std = o => new THREE.MeshStandardMaterial(o);
  return {
    frame: std({ color: 0xffffff, roughness: 0.75 }),
    leaf:  std({ color: 0xfcfcfc, roughness: 0.6 }),
    glass: std({ color: 0xf4f4f4, roughness: 0.15, metalness: 0.05, transparent: true, opacity: 0.42 }),
    handle: std({ color: 0xcfcfcf, roughness: 0.4, metalness: 0.3 }),
  };
}

function pickFamily(op) {
  if (op.type === 'door') {
    if (op.kind === 0) return 'door-double';
    if (op.kind === 2) return 'door-bidir';
    return 'door-single';
  }
  if (op.kind === 1) return 'win-fm';
  return (op.w >= 1200) ? 'win-2sash' : 'win-fixed';
}

/* 在洞口局部坐标（u=沿墙、v=高度、n=墙厚/法线）里添加一块长方体 */
function addPiece(g, op, u0, u1, v0, v1, n0, n1, mat) {
  const du = u1 - u0, dv = v1 - v0, dn = n1 - n0;
  if (du <= 0.5 || dv <= 0.5 || dn <= 0.5) return;
  const geo = new THREE.BoxGeometry(du, dv, dn);
  const mesh = new THREE.Mesh(geo, mat);

  const U = new THREE.Vector3(op.ax, 0, op.ay).normalize();
  const V = new THREE.Vector3(0, 1, 0);
  /* n 正方向指向室内（外法线反方向） */
  const N = new THREE.Vector3(-op.nx, 0, -op.ny).normalize();
  const m = new THREE.Matrix4().makeBasis(U, V, N);
  mesh.quaternion.setFromRotationMatrix(m);

  const um = (u0 + u1) / 2, vm = (v0 + v1) / 2, nm = (n0 + n1) / 2;
  mesh.position.set(
    op.cx + um * op.ax + nm * (-op.nx),
    op.z0 + vm,
    op.cy + um * op.ay + nm * (-op.ny)
  );
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.userData.familyPiece = true;
  g.add(mesh);
}


/* 门扇：n 偏移到室内一侧（外法线反方向） */
function doorLeaf(g, op, mats, u0, u1) {
  const h = op.h, t = op.tw;
  const n0 = -t / 2 + 8, n1 = n0 + LEAF_T;
  addPiece(g, op, u0, u1, 6, h - FRAME_W - 4, n0, n1, mats.leaf);
}

function doorHandle(g, op, mats, uPos) {
  const t = op.tw;
  addPiece(g, op, uPos - 6, uPos + 6, 950, 1040, -t / 2 + 55, -t / 2 + 85, mats.handle);
}

function buildDoorSingle(g, op, mats) {
  const w = op.w, half = w / 2, t = op.tw, h = op.h;
  doorFrame(g, op, mats);
  doorLeaf(g, op, mats, -(w - FRAME_W * 2 - 10) / 2, (w - FRAME_W * 2 - 10) / 2);
  doorHandle(g, op, mats, half - FRAME_W - 80);
}

function buildDoorDouble(g, op, mats) {
  const w = op.w, half = w / 2, t = op.tw, h = op.h;
  doorFrame(g, op, mats);
  const leafW = (w - FRAME_W * 2 - 12) / 2;
  doorLeaf(g, op, mats, -leafW - 1, -3);      /* 左扇 */
  doorLeaf(g, op, mats, 3, leafW + 1);        /* 右扇 */
  doorHandle(g, op, mats, -half + FRAME_W + 80);
  doorHandle(g, op, mats, half - FRAME_W - 80);
}

function buildDoorBidir(g, op, mats) {
  const w = op.w, half = w / 2;
  buildDoorSingle(g, op, mats);
  /* 双向开启：内侧再放一只把手，示意双向 */
  doorHandle(g, op, mats, half - FRAME_W - 80);
  addPiece(g, op, half - FRAME_W - 86, half - FRAME_W - 74, 950, 1040,
           -op.tw / 2 - 85, -op.tw / 2 - 55, mats.handle);
}

function doorFrame(g, op, mats) {
  const w = op.w, h = op.h, half = w / 2, t = op.tw;
  const fr = mats.frame;
  addPiece(g, op, -half, -half + FRAME_W, 0, h, -t / 2, t / 2, fr);        /* 左框 */
  addPiece(g, op, half - FRAME_W, half, 0, h, -t / 2, t / 2, fr);          /* 右框 */
  addPiece(g, op, -half, half, h - FRAME_W, h, -t / 2, t / 2, fr);         /* 上框 */
}

/* ---------- 窗族 ---------- */
function windowFrame(g, op, mats) {
  const w = op.w, h = op.h, half = w / 2, t = op.tw;
  const fr = mats.frame;
  addPiece(g, op, -half, -half + FRAME_W, 0, h, -t / 2, t / 2, fr);
  addPiece(g, op, half - FRAME_W, half, 0, h, -t / 2, t / 2, fr);
  addPiece(g, op, -half, half, 0, FRAME_W, -t / 2, t / 2, fr);
  addPiece(g, op, -half, half, h - FRAME_W, h, -t / 2, t / 2, fr);
}

function glassPane(g, op, mats, u0, u1, v0, v1) {
  addPiece(g, op, u0, u1, v0, v1, -GLASS_T / 2, GLASS_T / 2, mats.glass);
}

function buildWindowSingle(g, op, mats) {
  const w = op.w, h = op.h, half = w / 2;
  windowFrame(g, op, mats);
  glassPane(g, op, mats, -half + FRAME_W + 4, half - FRAME_W - 4, FRAME_W + 4, h - FRAME_W - 4);
}

function buildWindow2Sash(g, op, mats) {
  const w = op.w, h = op.h, half = w / 2;
  const t = op.tw;
  windowFrame(g, op, mats);
  /* 中挺（竖梃） */
  addPiece(g, op, -25, 25, FRAME_W, h - FRAME_W, -t / 2 + 8, t / 2 - 8, mats.frame);
  const uIn = half - FRAME_W - 4;
  glassPane(g, op, mats, -uIn, -30, FRAME_W + 4, h - FRAME_W - 4);
  glassPane(g, op, mats, 30, uIn, FRAME_W + 4, h - FRAME_W - 4);
}

function buildWindowFM(g, op, mats) {
  buildWindowSingle(g, op, mats);   /* 防火观察窗：单块玻璃，与固定窗同构 */
}

const BUILDERS = {
  'door-single': buildDoorSingle,
  'door-double': buildDoorDouble,
  'door-bidir': buildDoorBidir,
  'win-fixed': buildWindowSingle,
  'win-2sash': buildWindow2Sash,
  'win-fm': buildWindowFM,
};

window.WMFamilies = {
  pickFamily: pickFamily,
  /* 返回 { total, byFamily } */
  build(group, openings, mats) {
    const m = mats || defaultMats();
    const byFamily = {};
    let total = 0;
    for (const op of openings) {
      const fam = pickFamily(op);
      const fn = BUILDERS[fam];
      if (!fn) continue;
      fn(group, op, m);
      byFamily[fam] = (byFamily[fam] || 0) + 1;
      total++;
    }
    return { total, byFamily };
  },
};
})();
