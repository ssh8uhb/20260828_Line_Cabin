/* 对位校验图生成：读 data/site-context.json，输出自包含 HTML（数据内联），用 cdp-shot 截图查看
 * 用法: node tools/site-context-plot.mjs [data/site-context.json] [输出.html]
 *       node tools/cdp-shot.mjs "file:///<输出.html>" 校验图.png 6
 * 输出默认写到系统临时目录（校验产物不进仓库）；页面本身可直接双击用 file:// 打开。
 * 图中内容: 模型坐标系下的建筑外墙轮廓线(红)、模型墙体 AABB(橙虚线)、进水池(青)、
 *          SXSS 河道岸线(蓝)、DMTZ 陡坎(品红)、旧 JSON 取水构筑物(黄虚线)、高程点、注记文字、
 *          角点坐标标签、长度差尺寸线；右下角小图显示河道全貌
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const inPath = process.argv[2] || fileURLToPath(new URL('../data/site-context.json', import.meta.url));
const outPath = process.argv[3] || join(tmpdir(), 'wm-site', 'site-context-check.html');
const D = JSON.parse(readFileSync(inPath, 'utf8'));

const html = `<!doctype html><meta charset="utf-8">
<title>对位校验图 - ${D.name}</title>
<style>html,body{margin:0;background:#0d0d10}</style>
<canvas id="a" width="1480" height="980"></canvas>
<script id="data" type="application/json">${JSON.stringify(D)}</script>
<script>
const D = JSON.parse(document.getElementById('data').textContent);
const ctx = document.getElementById('a').getContext('2d');
const W = 1480, H = 980;
const C = { bank:'#3b8cff', scarp:'#ff3bd1', site:'#ff2d2d', model:'#ff9900', pool:'#00e5e0', old:'#e0c060', text:'#ffd479' };
const MW = D.consistency.currentModelWallsOuterMm;
function panel(box, rect) {
  const s = Math.min(rect[2] / ((box[2]-box[0])/1000), rect[3] / ((box[3]-box[1])/1000));
  const X = mm => rect[0] + (mm/1000 - box[0]/1000) * s;
  const Y = mm => rect[1] + rect[3] - (mm/1000 - box[1]/1000) * s;
  return { X, Y, s };
}
function txt(t, x, y, c, fo) { ctx.fillStyle = c; ctx.font = fo || '12px monospace'; ctx.fillText(t, x, y); }
function tag(t, x, y, c) { ctx.strokeStyle = c; ctx.lineWidth = 1.4; ctx.beginPath(); ctx.arc(x, y, 4, 0, 6.284); ctx.stroke();
  const w = ctx.measureText(t).width; ctx.fillStyle = '#000c'; ctx.fillRect(x + 6, y - 14, w + 10, 16); txt(t, x + 11, y - 2, c, 'bold 12px monospace'); }
function draw(f, detail) {
  const path = p => { ctx.beginPath(); p.forEach((q, i) => i ? ctx.lineTo(f.X(q[0]), f.Y(q[1])) : ctx.moveTo(f.X(q[0]), f.Y(q[1]))); };
  for (const b of D.riverChannel.banks) { ctx.strokeStyle = C.bank; ctx.lineWidth = detail ? 2.4 : 1.2; path(b.outlineModelMm); ctx.stroke();
    if (detail) { const m = b.outlineModelMm[Math.floor(b.outlineModelMm.length / 2)]; txt('SXSS#' + b.id, f.X(m[0]) + 5, f.Y(m[1]) - 5, '#7fb7ff', 'bold 12px monospace'); } }
  ctx.strokeStyle = C.scarp; ctx.lineWidth = detail ? 2 : 1;
  for (const s of D.context.scarps) { path(s.outlineModelMm); ctx.stroke(); }
  ctx.save(); ctx.setLineDash([4, 5]); ctx.strokeStyle = C.old; ctx.lineWidth = 1.3;
  for (const objs of [[[-14100,5115,-7613,13215],[-14113,1465,-7821,6965],[-14113,12715,-7821,18215]]]) {
    for (const [x0, y0, x1, y1] of objs) ctx.strokeRect(f.X(x0), f.Y(y1), f.X(x1) - f.X(x0), f.Y(y0) - f.Y(y1));
  }
  ctx.restore();
  if (detail) txt('旧 JSON 取水构筑物（' + (D.source.mtime || '').slice(0, 10) + ' 之前的版本）', f.X(-14200) - 8, f.Y(18600), C.old, '12px monospace');
  ctx.save(); ctx.setLineDash([9, 6]); ctx.strokeStyle = C.model; ctx.lineWidth = detail ? 3 : 1.4;
  ctx.strokeRect(f.X(MW.x0), f.Y(MW.y1), f.X(MW.x1) - f.X(MW.x0), f.Y(MW.y0) - f.Y(MW.y1)); ctx.restore();
  ctx.strokeStyle = C.site; ctx.lineWidth = detail ? 3.4 : 1.5; path(D.building.outlineModelMm); ctx.closePath(); ctx.stroke();
  path(D.intakePool.outlineModelMm); ctx.closePath(); ctx.fillStyle = 'rgba(0,229,224,0.22)'; ctx.fill();
  ctx.strokeStyle = C.pool; ctx.lineWidth = detail ? 3 : 1.5; ctx.stroke();
  const lo = D.elevationPoints.elevationRangeM[0], hi = D.elevationPoints.elevationRangeM[1];
  for (const q of D.elevationPoints.points) {
    const x = f.X(q[3]), y = f.Y(q[4]); if (x < 0 || y < 0 || x > W || y > H) continue;
    const t = (q[2] - lo) / (hi - lo); ctx.fillStyle = 'hsl(' + (230 - 230 * t) + ',95%,58%)';
    ctx.beginPath(); ctx.arc(x, y, detail ? 4 : 2, 0, 6.284); ctx.fill();
    if (detail && Math.abs(q[3]) < 13000 && Math.abs(q[4] - 6000) < 13000) txt(q[2].toFixed(2), x + 6, y - 4, '#efefef', '11px monospace');
  }
  for (const t of D.context.texts) { const x = f.X(t.modelMm[0]), y = f.Y(t.modelMm[1]); if (x < 0 || y < 0 || x > W || y > H) continue; txt(t.text, x, y, C.text, '12px sans-serif'); }
}
function dimH(f, xa, xb, ymm, t, c) { const y = f.Y(ymm); ctx.strokeStyle = c; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(f.X(xa), y - 7); ctx.lineTo(f.X(xa), y + 7); ctx.moveTo(f.X(xb), y - 7); ctx.lineTo(f.X(xb), y + 7); ctx.moveTo(f.X(xa), y); ctx.lineTo(f.X(xb), y); ctx.stroke();
  ctx.textAlign = 'center'; txt(t, (f.X(xa) + f.X(xb)) / 2, y - 6, c, 'bold 13px monospace'); ctx.textAlign = 'left'; }
ctx.fillStyle = '#0d0d10'; ctx.fillRect(0, 0, W, H);
const f1 = panel([-16000, -4000, 12000, 20000], [30, 30, 1420, 920]);
// Y=0 基准线
ctx.save(); ctx.setLineDash([10, 6]); ctx.strokeStyle = '#ffffff88'; ctx.lineWidth = 1.5;
ctx.beginPath(); ctx.moveTo(f1.X(-16000), f1.Y(0)); ctx.lineTo(f1.X(12000), f1.Y(0)); ctx.stroke(); ctx.restore();
draw(f1, true);
txt('Y = 0 基准线（模型墙体 AABB 南边缘 = 总平面图外墙轮廓线西南角）', f1.X(-15500), f1.Y(0) - 8, '#ffffffaa', '13px monospace');
for (const q of D.building.outlineModelMm) tag('(' + q[0].toFixed(1) + ',' + q[1].toFixed(1) + ')', f1.X(q[0]), f1.Y(q[1]), '#ff8080');
for (const [x, y] of [[MW.x0, MW.y0], [MW.x1, MW.y0], [MW.x1, MW.y1], [MW.x0, MW.y1]]) tag('(' + x + ',' + y + ')', f1.X(x), f1.Y(y), '#ffb347');
for (const q of D.intakePool.outlineModelMm) tag('(' + q[0].toFixed(0) + ',' + q[1].toFixed(0) + ')', f1.X(q[0]), f1.Y(q[1]), '#5ff0d8');
dimH(f1, 0, MW.x1, -2200, '模型宽 ' + MW.x1, C.model);
dimH(f1, 0, D.building.sizeMm.width, -3500, '总平面图宽 ' + D.building.sizeMm.width.toFixed(0), C.site);
dimH(f1, -12801, -10001, 6000, '2800', C.pool);
dimH(f1, -10001, 0, 10500, '10000', C.pool);
ctx.save(); ctx.setLineDash([5, 4]); ctx.strokeStyle = C.site; ctx.lineWidth = 1.2;
ctx.beginPath(); ctx.moveTo(f1.X(3200), f1.Y(15100)); ctx.lineTo(f1.X(3200), f1.Y(17903)); ctx.stroke(); ctx.restore();
ctx.beginPath(); ctx.moveTo(f1.X(3200) - 8, f1.Y(15100)); ctx.lineTo(f1.X(3200) + 8, f1.Y(15100));
ctx.moveTo(f1.X(3200) - 8, f1.Y(17903)); ctx.lineTo(f1.X(3200) + 8, f1.Y(17903)); ctx.stroke();
txt((D.building.sizeMm.length - MW.y1).toFixed(0), f1.X(3200) + 12, (f1.Y(15100) + f1.Y(17903)) / 2 + 4, C.site, 'bold 14px monospace');
txt('红=总平面图建筑外墙轮廓线（' + D.building.sizeMm.width.toFixed(0) + '×' + D.building.sizeMm.length.toFixed(0) + '，西南角落在 (0,0)）', 40, 30, '#ff6b6b', '13px monospace');
txt('橙虚线=当前模型墙体 AABB ' + MW.x1 + '×' + MW.y1 + '（南边缘同为 Y=0，北端短 ' + (D.building.sizeMm.length - MW.y1).toFixed(0) + '）', 40, 50, '#ffb347', '13px monospace');
txt('模型坐标（mm），主图 X −16..12 m、Y −4..20 m，' + f1.s.toFixed(2) + ' px/m', 40, 960, '#bbb', '13px monospace');
txt('旋转 ' + D.alignment.rotationDeg + '°　锚点 ' + D.alignment.anchorSiteM.join(', ') + ' (m) → 模型 (0,0)', 900, 30, '#bbb', '13px monospace');
// 小图：河道全貌
const f2 = panel([-175000, -175000, 75000, 65000], [1200, 60, 250, 250]);
ctx.fillStyle = '#151519'; ctx.fillRect(1200, 60, 250, 250); draw(f2, false);
ctx.strokeStyle = '#333'; ctx.strokeRect(1200, 60, 250, 250);
txt('河道全貌 X −175..75　Y −175..65 m', 1202, 326, '#777', '10px monospace');
window.__ready = true;
</script>`;
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, html);
console.log('已生成对位校验图 HTML:', outPath);
console.log('截图: node tools/cdp-shot.mjs "file:///' + outPath.replace(/\\/g, '/') + '" 对位校验.png 6');
