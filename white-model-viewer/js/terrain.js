/* 地形地面导入（v0.2）
 * 输入：
 *   terrain.obj                三角网（v / f 即可，支持 v//vn、v/vt/vn）
 *   terrain-registration.json  定位关系：
 *   {
 *     "unit": "mm",                                // 网格坐标单位（须与建筑一致或通过控制点换算）
 *     "zReference": { "groundZ": 168900, "buildingZ": 2141 }, // 同一物理高程点：地面Z ↔ 建筑Z(相对泵房地面)
 *     "points": [                                   // 至少 2 个平面控制点对（地面坐标 ↔ 建筑坐标）
 *       { "ground": { "x": .., "y": .. }, "building": { "x": .., "y": .. } },
 *       { "ground": { "x": .., "y": .. }, "building": { "x": .., "y": .. } }
 *     ]
 *   }
 * 配准：用两个点对求解 2D 相似变换（平移+旋转+等比缩放）；Z 按 zReference 换算。
 */
(function () {
'use strict';

function parseOBJ(text) {
  const verts = [], faces = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('v ')) {
      const p = line.split(/\s+/);
      verts.push([parseFloat(p[1]), parseFloat(p[2]), parseFloat(p[3])]);
    } else if (line.startsWith('f ')) {
      const idx = [];
      for (const tok of line.split(/\s+/).slice(1)) {
        if (!tok) continue;
        const i = parseInt(tok.split('/')[0], 10);
        if (i) idx.push(i > 0 ? i - 1 : verts.length + i);
      }
      if (idx.length >= 3) {
        for (let i = 1; i < idx.length - 1; i++) {
          faces.push([idx[0], idx[i], idx[i + 1]]);
        }
      }
    }
  }
  return { verts, faces };
}

function makeTransform(reg) {
  const a = reg.points[0], b = reg.points[1];
  const gx = b.ground.x - a.ground.x, gy = b.ground.y - a.ground.y;
  const bx = b.building.x - a.building.x, by = b.building.y - a.building.y;
  const gl = Math.hypot(gx, gy) || 1;
  const s = Math.hypot(bx, by) / gl;
  const angG = Math.atan2(gy, gx);
  const angB = Math.atan2(by, bx);
  const ang = angB - angG;
  const cosA = Math.cos(ang), sinA = Math.sin(ang);
  const zRef = reg.zReference || { groundZ: 168900, buildingZ: 2141 };
  const dz = zRef.buildingZ - zRef.groundZ * s;
  return function apply(gx0, gy0, gz) {
    const dx = gx0 - a.ground.x, dy = gy0 - a.ground.y;
    const rx = dx * cosA - dy * sinA;
    const ry = dx * sinA + dy * cosA;
    return {
      x: a.building.x + s * rx,
      y: a.building.y + s * ry,
      z: gz * s + dz,
    };
  };
}

/* 返回三角形数量；mesh 存到 state.terrainMesh 供线框切换 */
function build(group, objText, reg, L, mat) {
  const obj = parseOBJ(objText || '');
  if (!obj.verts.length || !obj.faces.length) return 0;
  const apply = makeTransform(reg);
  const pos = [];
  for (const f of obj.faces) {
    for (const vi of f) {
      const v = obj.verts[vi];
      const p = apply(v[0], v[1], v[2]);
      pos.push(p.x, p.z, p.y);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
  geo.computeVertexNormals();
  const mat2 = mat.clone();
  const mesh = new THREE.Mesh(geo, mat2);
  mesh.receiveShadow = true;
  mesh.name = 'terrain';
  mesh.userData.terrain = true;
  group.add(mesh);
  return obj.faces.length;
}

window.WMTerrain = { parseOBJ, makeTransform, build };
})();