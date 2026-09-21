/* 从 DXF 提取截面几何（放样截面 / 门窗大样通用）
 * 用法: node tools/dxf-profile.mjs <输入.dxf> <输出.json>
 * 支持实体: LWPOLYLINE(含 bulge 圆弧)、LINE、ARC、CIRCLE
 * 输出: { dxf, unit, polylines:[{kind, closed, points:[[x,y],...]}], entityCounts }
 */
import { readFileSync, writeFileSync } from 'node:fs';

function entities(text) {
  const lines = text.split(/\r?\n/);
  const ents = [];
  let cur = null;
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const code = parseInt(lines[i], 10);
    const val = lines[i + 1] === undefined ? '' : lines[i + 1].trim();
    if (code === 0) {
      cur = { type: val, pairs: [] };
      ents.push(cur);
    } else if (cur) {
      cur.pairs.push([code, val]);
    }
  }
  return ents;
}

function num(pairs, code) {
  const hit = pairs.find(p => p[0] === code);
  return hit ? parseFloat(hit[1]) : NaN;
}

function polyVerts(pairs) {
  const vs = [];
  let v = null;
  for (const [code, val] of pairs) {
    if (code === 10) { v = [parseFloat(val), 0, 0]; vs.push(v); }
    else if (code === 20 && v) v[1] = parseFloat(val);
    else if (code === 42 && v) v[2] = parseFloat(val);
  }
  return vs;
}

function arcByCenter(cx, cy, r, a0, sweep, n) {
  const out = [];
  for (let i = 0; i <= n; i++) {
    const a = a0 + sweep * (i / n);
    out.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  }
  return out;
}

function arcByAngles(cx, cy, r, a0deg, a1deg) {
  const a0 = a0deg * Math.PI / 180, a1 = a1deg * Math.PI / 180;
  let sweep = a1 - a0;
  const n = Math.max(2, Math.ceil(Math.abs(sweep) / (5 * Math.PI / 180)));
  return arcByCenter(cx, cy, r, a0, sweep, n);
}

/* 带 bulge 的段 P0->P1 */
function bulgeArc(p0, p1, b) {
  const x0 = p0[0], y0 = p0[1], x1 = p1[0], y1 = p1[1];
  const dx = x1 - x0, dy = y1 - y0;
  const d = Math.hypot(dx, dy);
  if (d < 1e-9) return [];
  const theta = 4 * Math.atan(b);
  const r = d * (1 + b * b) / (4 * Math.abs(b));
  const mx = (x0 + x1) / 2, my = (y0 + y1) / 2;
  const perpX = -dy / d, perpY = dx / d;
  const dist = d * (1 - b * b) / (4 * b);
  const cx = mx + perpX * dist, cy = my + perpY * dist;
  const a0 = Math.atan2(y0 - cy, x0 - cx);
  const a1 = Math.atan2(y1 - cy, x1 - cx);
  let sweep = a1 - a0;
  /* 使扫掠方向与 bulge 符号一致 */
  while ((b > 0 && sweep <= 0) || (b < 0 && sweep >= 0)) {
    sweep += (b > 0 ? 2 : -2) * Math.PI;
  }
  const n = Math.max(2, Math.ceil(Math.abs(sweep) / (5 * Math.PI / 180)));
  return arcByCenter(cx, cy, r, a0, sweep, n);
}

function expandPolyline(verts, closed) {
  const pts = [];
  const cnt = verts.length;
  if (cnt < 2) return pts;
  const step = (i) => {
    const v = verts[i];
    const j = (i + 1) % cnt;
    const nv = verts[j];
    const p0 = [v[0], v[1]];
    pts.push(p0);
    const bulge = v[2] || 0;
    if (Math.abs(bulge) > 1e-9) {
      const arc = bulgeArc(p0, [nv[0], nv[1]], bulge);
      for (let k = 1; k < arc.length - 1; k++) pts.push(arc[k]);
    }
  };
  for (let i = 0; i < (closed ? cnt : cnt - 1); i++) step(i);
  if (closed) pts.push([verts[0][0], verts[0][1]]);
  return pts;
}

function main() {
  const [inFile, outFile] = process.argv.slice(2);
  if (!inFile || !outFile) {
    console.error('用法: node tools/dxf-profile.mjs <输入.dxf> <输出.json>');
    process.exit(1);
  }
  const text = readFileSync(inFile, 'utf8');
  const ents = entities(text);
  const polylines = [];
  const counts = {};
  for (const e of ents) {
    counts[e.type] = (counts[e.type] || 0) + 1;
    if (e.type === 'LWPOLYLINE') {
      const fl = e.pairs.find(p => p[0] === 70);
      const flags = fl ? parseInt(fl[1], 10) : 0;
      const vs = polyVerts(e.pairs);
      if (vs.length < 2) continue;
      const closed = (flags & 1) === 1;
      polylines.push({ kind: 'LWPOLYLINE', closed, points: expandPolyline(vs, closed) });
    } else if (e.type === 'LINE') {
      const x0 = num(e.pairs, 10), y0 = num(e.pairs, 20);
      const x1 = num(e.pairs, 11), y1 = num(e.pairs, 21);
      if (!isNaN(x0) && !isNaN(x1)) polylines.push({ kind: 'LINE', closed: false, points: [[x0, y0], [x1, y1]] });
    } else if (e.type === 'ARC') {
      const cx = num(e.pairs, 10), cy = num(e.pairs, 20), r = num(e.pairs, 40);
      const a0 = num(e.pairs, 50), a1 = num(e.pairs, 51);
      if (!isNaN(r) && !isNaN(a0) && !isNaN(a1)) {
        polylines.push({ kind: 'ARC', closed: false, points: arcByAngles(cx, cy, r, a0, a1) });
      }
    } else if (e.type === 'CIRCLE') {
      const cx = num(e.pairs, 10), cy = num(e.pairs, 20), r = num(e.pairs, 40);
      if (!isNaN(r)) polylines.push({ kind: 'CIRCLE', closed: true, points: arcByCenter(cx, cy, r, 0, 2 * Math.PI, 72) });
    }
  }
  const out = { dxf: inFile, unit: 'mm（按源图约定）', polylines, entityCounts: counts };
  writeFileSync(outFile, JSON.stringify(out, null, 2));
  console.log(`已提取 ${polylines.length} 条折线/圆弧，实体统计:`, JSON.stringify(counts));
}

main();