# 20260828_Line_Cabin — 线条小屋 / 建筑白模项目

基于 CAD 插件导出的 `PlanFundingDrawing` JSON，在浏览器中生成可交互浏览的建筑白模（Three.js），
作为技术路线 **DWG → JSON → 白模 → 扩散模型渲染效果图** 的第三段；最终形态是桌面端 `.exe`，
不要求用户安装 Blender。

当前版本：**v0.4.0**（2026-09-25，tag `v0.4.0`）。v0.3.0 之后新增：**周边环境渲染**——由总平面图对位数据插值出
地形面 / 河床面 / 水面，面板「载入周边环境（默认数据）」或 `?env=1` 载入，新增「周边鸟瞰 / 河道视角」两个视角预设；
**道路 / 护坡**——按总平面图 `DLSS` / `DLSS-斜坡` 图层生成（DLSS 整环只出一块实体，材质 `road`，
面板两个开关；场地轮廓只作顶面高程分界、不出实体），原「地面 / 散水」实体已删除
（见 docs/DATA-MODEL.md 第 12、13、14 节）。

## 目录

```text
white-model-viewer/     白模查看器（主交付物）
  index.html            页面（含内嵌示例 JSON 与素材占位，可离线双击打开）
  js/white-model.js     JSON 解析 + 参数化建模 + 渲染 + UI
  js/families.js        门窗参数化族（通用占位，等 CAD 大样替换）
  js/eaves.js           挑檐截面沿路径放样
  js/environment.js     周边环境：地形面 / 河床面 / 水面
  js/siteworks.js       道路 / 护坡（总平面图 DLSS、DLSS-斜坡 图层）
  js/ai-panel.js        AI 效果图面板（视角勾选 / 提示词 / 出图进度，与本地桥通信）
  js/terrain.js         地形 OBJ 导入 + 双控制点配准（未接线）
  start-ai-bridge.cmd   双击起 AI 出图本地桥并打开页面（Windows 快捷入口）
  lib/                  three.js r128 + OrbitControls（本地依赖）
  data/                 示例 JSON、挑檐/雨篷截面、场地环境数据（site-context.json）、
                        AI 出图默认值（ai-render.json）
  tools/                CDP 无头截图、DXF 截面提取、总平面图对位数据生成与校验图、
                        AI 出图 CLI（ai-render.mjs）与本地桥（ai-bridge.mjs）
Flie/输入文件/           原始输入资料（JSON、JSON 说明、DWG/DXF 图纸、解析结果）
docs/                   项目交接说明、路线图、数据模型、会话纪要
AGENTS.md               仓库工作约定（面向接手的 AI Agent）
```

## 快速开始

双击 `white-model-viewer/index.html` 即可浏览示例白模；也可以把任意 `PlanFundingDrawing` JSON 文件拖进页面加载。

需要按路径加载外部素材、周边环境出图或批量出图时，起本地静态服务：

```powershell
python -m http.server 8123 --directory D:/Work/Project/20260828_Line_Cabin
# → http://localhost:8123/white-model-viewer/
# 出图参数：?static=1 固定视角、?lines=1 叠加线稿、?annot=0 去标注、
#            ?env=1 载入周边环境（含道路/护坡；页面默认已载入，加不加都一样）、
#            ?ui=0 只留三维画面（AI 出图用，隐藏面板与提示条）、
#            ?view=iso-ne 等视角预设（含 env-iso/env-river）、?channel=color/depth/normal、?bg=ffffff 背景色
```

一条命令批量出图（12 视角 × 3 通道，输出 PNG + manifest.json）：

```powershell
node white-model-viewer/tools/cdp-shot.mjs "http://localhost:8123/white-model-viewer/?annot=0" outdir --views=all --channels=color,depth,normal
```

## AI 效果图（白模 → 扩散模型渲染）

在页面上勾选视角、改提示词、点「开始出图」，出图由本地桥在后台调用阿里云百炼：

```powershell
# 最省事：双击 white-model-viewer\start-ai-bridge.cmd
#   起桥（默认 http://127.0.0.1:8787）并自动打开页面；key 只留在启动的那个窗口里
#   有 white-model-viewer\.dashscope-key 文件时直接读它（已 gitignore，勿提交）
cd white-model-viewer
.\start-ai-bridge.cmd                    # 真出图，需要 DASHSCOPE_API_KEY 或 .dashscope-key
.\start-ai-bridge.cmd --mock             # 零成本假接口，出图直接回显白模截图，用来验证链路
```

不想开页面时，也可以用命令行直接出图（结果落在 `white-model-viewer/out/<时间戳>/`）：

```powershell
cd white-model-viewer
node tools/ai-render.mjs --views=iso-ne,elev-s --dry-run   # 只出白模图与请求体记录，不发任何付费请求
node tools/ai-render.mjs --views=iso-ne --channels=color --mock   # 零成本假接口
node tools/ai-render.mjs --views=iso-ne --yes              # 真跑（计费）
```

说明见 [docs/DATA-MODEL.md](docs/DATA-MODEL.md) 第 5.7 节与 [docs/ROADMAP.md](docs/ROADMAP.md) 第 3.2 节。

## 文档

| 文档 | 内容 |
| --- | --- |
| [docs/PROJECT-HANDOFF.md](docs/PROJECT-HANDOFF.md) | 项目目标、当前实现、图纸事实、假设清单、限制与风险（**接手先读**） |
| [docs/ROADMAP.md](docs/ROADMAP.md) | 下一步任务、素材交付规格与验收标准 |
| [docs/DATA-MODEL.md](docs/DATA-MODEL.md) | JSON → 白模生成说明：参数读取规则、图元映射、默认形状与默认数值总表、坐标与标高约定、场地环境对位（§12）、周边环境渲染（§13）、道路/护坡（§14）、AI 出图（§5.7） |
| [docs/SESSION-NOTES-2026-08-28.md](docs/SESSION-NOTES-2026-08-28.md) | 需求演变与关键决策纪要 |
| [white-model-viewer/README.md](white-model-viewer/README.md) | 查看器使用说明与素材交付规格 |
| [AGENTS.md](AGENTS.md) | 仓库工作约定（命令、Git 规则、维护约束） |
