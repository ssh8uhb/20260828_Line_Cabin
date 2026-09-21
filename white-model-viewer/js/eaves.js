/* 挑檐截面沿闭合路径扫掠（v0.2）
 * 用“环形偏移扫掠”生成：挑檐 = 截面(距路径水平外挑 u, 相对板顶竖向 v) 沿建筑外围矩形路径扫掠。
 * 截面文件 eaves-profile.json 结构：
 * {
 *   "name": "挑檐截面名称",
 *   "pathType": "wallFace",            // 放样路径：wallFace=建筑外墙外包矩形
 *   "profile": [[u,v], ...],           // 闭合截面顶点；u=向外水平距离(mm)，v=相对屋面结构标高(向下为负)
 *   "unit": "mm"
 * }
 * 真实截面到位后，用 tools/dxf-profile.mjs 从 DXF 提取几何并生成该文件。
 */
(function () {
'use strict';

const TOL = 0.5;

/* 路径矩形沿法线方向偏移 u（u>0 外扩，u<0 内缩）后得到的角点（CCW） */
function offsetCorners(rect, u) {
  return [
    { x: rect.x0 - u, y: rect.y0 - u },
    { x: rect.x1 + u, y: rect.y0 - u },
    { x: rect.x1 + u, y: rect.y1 + u },
    { x: rect.x0 - u, y: rect.y1 + u },
  ];
}

/* 把三角形顶点列表加入组；verts 为 [x,y,z] 三元组数组 */
function addTriangles(g, verts, mat) {
  if (verts.length < 3) return;
  const arr = [];
  for (const p of verts) arr.push(p.x, p.y, p.z);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(arr), 3));
  geo.computeVertexNormals();
  const mesh = new THREE.Mesh(geo, mat);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  g.add(mesh);
}

function quad(g, p0, p1, p2, p3, mat) {
  addTriangles(g, [p0, p1, p2, p0, p2, p3], mat);
}

/* 相邻两个偏移矩形之间的带状面（每直边 1 个四边形） */
function addBand(g, cA, cB, zA, zB, mat) {
  const n = Math.min(cA.length, cB.length);
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    quad(g,
      { x: cA[i].x, y: zA, z: cA[i].y },
      { x: cA[j].x, y: zA, z: cA[j].y },
      { x: cB[j].x, y: zB, z: cB[j].y },
      { x: cB[i].x, y: zB, z: cB[i].y },
      mat);
  }
}

/* u 固定的竖向面：沿偏移矩形四边生成单层竖面（双面材质） */
function addVerticalBand(g, rect, u, z0, z1, mat) {
  const x0 = rect.x0 - u, y0 = rect.y0 - u;
  const x1 = rect.x1 + u, y1 = rect.y1 + u;
  const sides = [
    /* 南边 y=y0：x 从 x0 到 x1 */
    [[x0, y0, x1, y0]],
    /* 东边 x=x1：y 从 y0 到 y1 */
    [[x1, y0, x1, y1]],
    /* 北边 y=y1：x 从 x1 到 x0 */
    [[x1, y1, x0, y1]],
    /* 西边 x=x0：y 从 y1 到 y0 */
    [[x0, y1, x0, y0]],
  ];
  for (const s of sides) {
    const [a0, b0, a1, b1] = s[0];
    quad(g,
      { x: a0, y: z0, z: b0 },
      { x: a1, y: z0, z: b1 },
      { x: a1, y: z1, z: b1 },
      { x: a0, y: z1, z: b0 },
      mat);
  }
}

/* 返回生成的面数 */
function build(group, opts, profile, mat) {
  const rect = opts.rect;
  const roofZ = opts.roofZ;
  const pts = (profile && (profile.profile || profile.points)) || null;
  if (!Array.isArray(pts) || pts.length < 3) return 0;
  const mat2 = mat.clone();
  mat2.side = THREE.DoubleSide;

  const n = pts.length;
  let count = 0;
  for (let i = 0; i < n; i++) {
    const A = pts[i], B = pts[(i + 1) % n];
    const u0 = A[0], u1 = B[0], v0 = A[1], v1 = B[1];
    if (Math.abs(u0 - u1) <= TOL) {
      addVerticalBand(group, rect, u0, roofZ + Math.min(v0, v1), roofZ + Math.max(v0, v1), mat2);
      count += 4;
    } else {
      addBand(group, offsetCorners(rect, u0), offsetCorners(rect, u1),
              roofZ + v0, roofZ + v1, mat2);
      count += 4;
    }
  }
  return count;
}

window.WMEaves = { build: build };
})();