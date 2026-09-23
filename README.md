# 20260828_Line_Cabin — 线条小屋 / 建筑白模项目

基于 CAD 插件导出的 `PlanFundingDrawing` JSON，在浏览器中生成可交互浏览的建筑白模（Three.js），
作为技术路线 **DWG → JSON → 白模 → 扩散模型渲染效果图** 的第三段；最终形态是桌面端 `.exe`，
不要求用户安装 Blender。

当前版本：**v0.3.0**（多视角预设 / depth·normal 出图通道 / 批量出图 / 线稿通道 / 门窗参数化族 / 挑檐放样 / 地形导入）。

## 目录

```text
white-model-viewer/     白模查看器（主交付物）
  index.html            页面（含内嵌示例 JSON 与素材占位，可离线双击打开）
  js/white-model.js     JSON 解析 + 参数化建模 + 渲染 + UI
  js/families.js        门窗参数化族（通用占位，等 CAD 大样替换）
  js/eaves.js           挑檐截面沿路径放样
  js/terrain.js         地形 OBJ 导入 + 双控制点配准
  lib/                  three.js r128 + OrbitControls（本地依赖）
  data/                 示例 JSON、挑檐截面
  tools/                CDP 无头截图、DXF 截面提取
Flie/输入文件/           原始输入资料（JSON、JSON 说明、DWG/DXF 图纸、解析结果）
docs/                   项目交接说明、路线图、数据模型、会话纪要
AGENTS.md               仓库工作约定（面向接手的 AI Agent）
```

## 快速开始

双击 `white-model-viewer/index.html` 即可浏览示例白模；也可以把任意 `PlanFundingDrawing` JSON 文件拖进页面加载。

需要按路径加载外部素材或出图时，起本地静态服务：

```powershell
python -m http.server 8123 --directory D:/Work/Project/20260828_Line_Cabin
# → http://localhost:8123/white-model-viewer/
# 出图参数：?static=1 固定视角、?lines=1 叠加线稿、?annot=0 去标注、
#            ?view=iso-ne 等视角预设、?channel=color/depth/normal、?bg=ffffff 背景色
```

一条命令批量出图（10 视角 × 3 通道，输出 PNG + manifest.json）：

```powershell
node white-model-viewer/tools/cdp-shot.mjs "http://localhost:8123/white-model-viewer/?annot=0" outdir --views=all --channels=color,depth,normal
```

## 文档

| 文档 | 内容 |
| --- | --- |
| [docs/PROJECT-HANDOFF.md](docs/PROJECT-HANDOFF.md) | 项目目标、当前实现、图纸事实、假设清单、限制与风险（**接手先读**） |
| [docs/ROADMAP.md](docs/ROADMAP.md) | 下一步任务、素材交付规格与验收标准 |
| [docs/DATA-MODEL.md](docs/DATA-MODEL.md) | JSON → 白模生成说明：参数读取规则、图元映射、默认形状与默认数值总表、坐标与标高约定 |
| [docs/SESSION-NOTES-2026-08-28.md](docs/SESSION-NOTES-2026-08-28.md) | 需求演变与关键决策纪要 |
| [white-model-viewer/README.md](white-model-viewer/README.md) | 查看器使用说明与素材交付规格 |
| [AGENTS.md](AGENTS.md) | 仓库工作约定（命令、Git 规则、维护约束） |
