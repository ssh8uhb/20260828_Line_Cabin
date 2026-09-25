# 项目交接说明 — 线条小屋 / 建筑白模（20260828_Line_Cabin）

> 交接版本：v0.5.0（tag `v0.5.0`，见 §2 与 §9）　最后更新：2026-09-25
> 面向对象：接手的 AI Agent（Codex / Cursor 等）与项目负责人。
> 仓库工作约定见根目录 AGENTS.md；下一步任务见 docs/ROADMAP.md；数据映射见 docs/DATA-MODEL.md。

## 1. 项目目标

把建筑平面图纸自动转成 AI 可渲染的效果图素材，最终做成**桌面端产品（.exe）**，**不要求用户电脑安装
Blender 或其他建模软件**。

技术路线分四段，本项目负责第 2 段：

| 段 | 做什么 | 由谁完成 | 现状 |
| --- | --- | --- | --- |
| ① DWG → JSON | 用 CAD 端设计插件从图纸导出 PlanFundingDrawing JSON | 用户侧的 CAD 插件（已有，可解释、可复现） | 已具备 |
| ② JSON → 白模 | 在浏览器端用 Three.js 参数化建模，可交互浏览、可截图 | **本项目** | **v0.3.0 可运行** |
| ③ 白模截图 + 提示词 → 效果图 | 扩散模型（外立面材质、风格提示词）渲染 | 本项目后续 | 未开始 |
| ④ 产品化 | 打包成 .exe 桌面端（Electron 方案） | 本项目后续 | 未开始 |

第 1 段的前提是：JSON 由设计插件导出，字段有明确的业务含义（可解释、合理），只是缺少文档说明。
因此遇到不确定字段时，**优先去问用户或对照 Flie/输入文件/PlanFundingDrawing_JSON说明.md，不要凭字段名猜**。

## 2. 当前实现（v0.5.0：白模 + 周边环境 + AI 出图链路）

主交付物是 white-model-viewer/，一个不依赖任何构建工具、可双击打开的单页应用。

| 能力 | 代码位置 | 说明 |
| --- | --- | --- |
| JSON 解析与坐标对齐 | js/white-model.js 的 parseDrawing() | 遍历 ViewFrames，按轴线 1 ∩ A 把三个图框对齐到同一坐标系，重复图元去重 |
| 标高体系 | buildLevels() | 由 PlanElevationAnnotationObject 的 Kind 索引生成层高表，Z=0 = 水泵间地面 |
| 参数化建模 | buildModel() | 墙体（含门窗洞口拆板）、楼板、结构柱、屋面、楼梯/钢梯/爬梯、基础/集水坑/坡道、房间标注 |
| 显示样式（素模/线稿/深度/法线） | setDisplayStyle() → setChannel() / setLinesVisible() | 面板「显示样式」栏四选一。线稿 = 对实体按 30° 二面角阈值提取黑色棱边：建筑八个分组（walls/slabs/columns/roof/canopies/stairs/extra/families，新增实体分组须同步 `BUILDING_EDGE_GROUPS`）+ 周边 terrain/riverBed/riverWater/road/slope；默认素模（无线稿），可随时切 |
| 视角预设（12 个） | applyView() | iso-ne/nw/se/sw 鸟瞰、elev-s/n/w/e 立面、persp-1/2 人视（地坪 + 1700 视高，裁掉地坪以下构件）、env-iso/env-river 周边鸟瞰/河道视角（需载入周边环境）；由建筑包围盒自动推算，适配任意 JSON |
| 场景面板 | renderScenePanel() / applyScene() | 左侧面板「场景列表」栏：10 个固定场景（4 正立面 + 4 角部鸟瞰 + 周边鸟瞰/河道视角，后者未载入环境时置灰）+ 自定义镜头（存相机位置/目标点/裁剪状态）；按 `DrawingName` 分别写入 localStorage（键 `wm.scenes.v1:<DrawingName>`），不可用时退化为会话内存 |
| 出图通道 | setChannel() / depthMaterial() | color 素模 / depth 线性深度（近白远黑，自定义 ShaderMaterial）/ normal 视空间法线（MeshNormalMaterial）；同一相机逐像素对齐，辅助通道自动隐藏线稿与标注（env 视角下深度跨度取「建筑 ∪ 地形盒」并集）。面板入口只有「显示样式」四选一，`?channel=` 与 `WMShot.channel()/style()` 供脚本使用 |
| 批量出图接口 | window.WMShot + tools/cdp-shot.mjs | 页面暴露 built/views/view/cam/channel/style/info/doc/stats/scenes/saveScene/applyScene/capture/settle/familyCheck/env/loadEnv/clearEnv/envCheck/site/loadSite/clearSite/siteCheck；脚本批量模式循环 视角 × 通道 截图并写 manifest.json（相机参数） |
| 门窗参数化族 | js/families.js | 6 个通用族，按 Kind 与宽度自动匹配，按洞口尺寸缩放、按墙向/法线定向；族内几何统一用洞口局部坐标 u/v/n（正 n 指向室内），`WMShot.familyCheck()` 逐块校核「构件不许凸出墙面」（样例基线 78 块 / 0 越界） |
| 挑檐截面放样 | js/eaves.js + tools/dxf-profile.mjs | 截面沿屋面外轮廓矩形放样，角部按偏移处理；DXF 截面提取工具已就绪 |
| 地形导入 | js/terrain.js | OBJ 三角网 + 双控制点相似变换（平移/旋转/等比缩放）+ 高程换算（未接线） |
| 场地环境数据（总平面图对位） | tools/dxf-site-context.mjs → data/site-context.json（v3） | 由 `总平面图.dxf` 解析出模型↔总平面图对位变换（平移+旋转 3.2962°+×1000）、578 个高程点、进水池、麻桑河岸线、陡坎与注记，以及场地轮廓（DLSS 里含建筑的那一圈）/ 道路（DLSS 整环）/ 护坡（DLSS-斜坡）折线，全部换算为模型 mm 坐标；生成时同步 index.html 内嵌副本（见 docs/DATA-MODEL.md 第 12 节） |
| 周边环境渲染（地形/河床/水面） | js/environment.js + white-model.js 的 buildEnv() | 用高程点插值生成地形面（去刺/平滑/坡度约束）、按槽内点插值出河床面、河床 + 水深生成水面；外墙 AABB 每侧外扩 60 m、平台面 = `L.grade − 500`、建筑范围挖空、地块四周 3 m 裙边；**页面首次建模后自动载入**（也保留「文件管理」栏的 `载入环境文件` 按钮与 `?env=1`），`WMShot.envCheck()` 出验收指标（见 docs/DATA-MODEL.md 第 13 节） |
| 道路 / 护坡 | js/siteworks.js + white-model.js 的 buildSite() | DLSS 整环只出一块实体：顶面在场地轮廓（`site` 多边形）内严格齐平室外地坪、轮廓外跟随地形（5 m 过渡带内平滑回室外地坪、整体抬离自然地面 50 mm）；护坡 = `DLSS-斜坡` 环（场地标高斜到河床）。**早先按三角形重心把 DLSS 面分成「场地」「道路」两个材质岛、各建一块实体，交界处两片重合立侧面会闪棋盘格斜纹带（2026-09-24 修复）；分岛后场地边界上又出现锯齿状明暗斜带，2026-09-25 按用户要求删除场地实体**；厚度统一 500 mm，面板 road/slope 两个开关，`WMShot.siteCheck()` 出验收指标（见 docs/DATA-MODEL.md 第 14 节） |
| 出图模式 | applyUrlParams() + STATIC | ?static=1 渲染数帧后停住；?env=1 载入周边环境（地形/河床/水面/道路/护坡，用内嵌副本，离线可用；**已经是页面默认行为**）；?lines=1 带线稿（等价面板「显示样式 → 线稿」）；?annot=0 去标注；?ui=0 只留三维画面（隐藏面板/提示条，AI 出图的条件图必须加）；?view= 视角预设；?channel= 出图通道（面板入口只有「显示样式」四选一，脚本用 URL 参数或 `WMShot.channel()`）；?bg=RRGGBB 设背景 |
| 离线可用 | index.html 内嵌 #sampleData / #eavesProfileData / #siteContextData | 双击 file:// 打开即可看到示例白模；周边环境与场地数据也是内嵌副本，`?env=1` 离线可用 |
| AI 出图（阶段③） | tools/ai-render.mjs（CLI）+ tools/ai-bridge.mjs + js/ai-panel.js（页面面板）+ tools/ai/dashscope.mjs（调用层）+ data/ai-render.json | 白模截图 → **阿里云百炼同步图像接口**（默认 `qwen-image-3.0`，1~3 张参考图）→ 效果图 + `run.json`；两条入口共用同一调用层：CLI 复用 `cdp-shot` 截图，页面面板由页面自己截图（`WMShot.capture`）后 POST 给**只绑 127.0.0.1** 的本地桥；提示词与参数默认值在 `data/ai-render.json`（页面读内嵌副本，见 docs/DATA-MODEL.md §5.7）；API key 只从环境变量读、只在桥进程内存里，`--dry-run` / `--mock` 可零成本自检，CLI 非 TTY 要 `--yes`、页面弹窗确认调用次数、桥 `--max-calls` 限会话调用数；异步接口（万相）与高清超分未实现 |

占位数据说明：门窗族是通用占位几何、挑檐是 500×150 平板占位截面、地形是周边环境（高程点插值生成，
未接入三角网 OBJ）。管线已打通，等用户提供素材后替换即可，见 docs/ROADMAP.md。
场地环境（河道 / 地形 / 水面 / 道路 / 护坡）已接入渲染（ROADMAP 1.4 完成大半），余下进水池池体、陡坎与管道。
原「地面 / 散水」回字形实体已按用户要求删除（与外圈 DLSS 面重叠、混淆）。

## 3. 架构与数据流

```text
页面加载
  → loadDefault(): 依次尝试 内嵌 #sampleData / data/sample.json / Flie/输入文件/*.json
  → build(json)
      → resolveExtras(): 读挑檐截面（data/eaves-profile.json）、地形注册与网格（data/terrain*.{json,obj}）、
                         周边环境数据（内嵌 #siteContextData / data/site-context.json）
      → buildModel(json, extras)
          → parseDrawing(json)   // 图元 → 中间数据结构 data（见 docs/DATA-MODEL.md）
          → buildLevels(data)    // 标高体系 L
          → 各构件建模，写入 9 个分组: walls/slabs/columns/roof/canopies/stairs/extra/families/annot
          → buildEdgeLines(BUILDING_EDGE_GROUPS)   // 线稿（默认随「显示样式」开关显隐）
      → applyUrlParams(): 应用 ?env=1 / ?lines=1 / ?annot=0 / ?ui=0 / ?view= / ?channel= / ?bg=RRGGBB
      → buildEnv(sc): 周边环境（WMEnv.build → 地形/河床/水面/环境线 4 个分组 + 三者的线稿），模型重建后自动重载
      → buildSite(sc): 道路/护坡（WMSite.build → road/slope 2 个分组 + 线稿），?env=1 时与 buildEnv 一起执行
  → 用户可拖入其它 JSON 文件重新构建
```

渲染：Three.js r128（lib/three.min.js）+ OrbitControls，无 UI 框架，无模块打包，全部挂在 window 上的
命名空间里（window.WMFamilies / window.WMEaves / window.WMTerrain / window.WMEnv / window.WMSite）。

## 4. 运行与出图

```powershell
# 直接看：双击 white-model-viewer/index.html（离线，使用内嵌示例数据）

# 起本地服务（可读取 data/ 下的外部素材文件）
python -m http.server 8123 --directory D:/Work/Project/20260828_Line_Cabin
# → http://localhost:8123/white-model-viewer/

# 无头截图（单视角，需本机 Chrome/Edge + Node 22+）
node white-model-viewer/tools/cdp-shot.mjs "http://localhost:8123/white-model-viewer/?static=1&lines=1" out.png 8

# 批量出图：12 视角 × 3 通道（color/depth/normal），输出 PNG + manifest.json
node white-model-viewer/tools/cdp-shot.mjs "http://localhost:8123/white-model-viewer/?annot=0" outdir --views=all --channels=color,depth,normal

# 带周边环境（地形/河床/水面 + 道路/护坡）的单视角截图与批量出图
node white-model-viewer/tools/cdp-shot.mjs "file:///D:/Work/Project/20260828_Line_Cabin/white-model-viewer/index.html?env=1&annot=0" "$env:TEMP/wm-env.png" 8
node white-model-viewer/tools/cdp-shot.mjs "file:///D:/Work/Project/20260828_Line_Cabin/white-model-viewer/index.html?env=1&annot=0" "$env:TEMP/wm-env-batch" --views=all --channels=color,depth,normal
```

### AI 出图（阶段③：白模截图 + 提示词 → 效果图）

```powershell
# API key 只从环境变量读（key 不进仓库 / 不进 run.json / 不进页面）
$env:DASHSCOPE_API_KEY = "sk-xxxx"

# 零成本自检：出白模图 + 请求体记录 + run.json，不发请求、不需要 key
node white-model-viewer/tools/ai-render.mjs --views=iso-ne,elev-s --dry-run
node white-model-viewer/tools/ai-render.mjs --views=iso-ne --mock        # 本地假接口跑通全链路

# 真出图（每次调用都计费；不加 --yes 先打印调用次数并要求确认）
node white-model-viewer/tools/ai-render.mjs --views=persp-1                        # 默认 1 视角 × 素模单图
node white-model-viewer/tools/ai-render.mjs --views=persp-1,persp-2 --channels=color,depth --yes
```

产物在 `white-model-viewer/out/<时间戳>/`（已 gitignore）：`white/`（白模图 + manifest）、`request/`（实际请求体，
base64 换成文件指纹）、`ai/`（效果图）、`run.json`（模型 / 参数 / requestId / 输入输出 sha256 / 付费次数）。
提示词与默认参数改 `white-model-viewer/data/ai-render.json`；页面面板读的是 `index.html` 里的内嵌副本
`<script type="application/json" id="aiRenderData">`（file:// 离线可用），**改一处要同步另一处**。

页面里出图（所见即所得，可渲自定义镜头）：

```powershell
# 最省事：双击 white-model-viewer\start-ai-bridge.cmd（起桥 + 自动打开页面；
#         key 没设时会提示粘贴，也可预放 white-model-viewer\.dashscope-key，已 gitignore）
# 手动等价命令：
# 终端 A：起本地桥（只绑 127.0.0.1；页面直连百炼会被 CORS 拦，key 也必须留在 Node 侧）
$env:DASHSCOPE_API_KEY = "sk-xxxx"; node white-model-viewer/tools/ai-bridge.mjs          # 默认 http://127.0.0.1:8787
$env:DASHSCOPE_API_KEY = "sk-xxxx"; node white-model-viewer/tools/ai-bridge.mjs --mock   # 零成本：本地假接口，结果图直接回显白模截图
# 终端 B / 直接双击：打开 white-model-viewer/index.html → 左侧面板「渲染出图」栏
#   勾选视角（12 个预设 + 自定义镜头，`看` 只切机位不入队）→ 改提示词 → 生成效果图（N 次调用，条件图固定素模）
```

桥的端点：`GET /health`、`GET /ai-render/config`（配置 + `keyPresent`，**不回传 key**）、`POST /ai-render`
（`{view,label,hint,channels,images,prompt,doc}` → 出图落盘 → 返回结果图 URL）、`GET /ai-render/image/<id>`。
产物在 `out/page-<时间戳>/`（run.json 里 `source:"page"`，另记页面 URL 与图纸名）。

URL 参数：?static=1 固定视角出图（渲染 8 帧后停止）；?env=1 载入周边环境（默认数据，用页面内嵌副本，
离线可用；**页面打开时已自动载入，加不加都一样**）；?lines=1 叠加黑色线稿；?annot=0 隐藏房间标注；
?ui=0 只留三维画面（隐藏左侧面板与底部提示条；**AI 出图的条件图必须加**，否则模型会把面板文字一起画进效果图）；
?view=iso-ne 等切换 12 个视角预设（iso-ne/nw/se/sw、elev-s/n/w/e、persp-1/2、env-iso/env-river）；?channel=color/depth/normal
切换出图通道；?bg=ffffff 背景色（6 位 hex）。人视视角（persp-*）自动用地坪裁剪面隐藏室外地坪以下的
基础/集水坑；批量模式下 window.WMShot 驱动 live 页面，manifest.json 记录每张图的相机参数便于跨版本比对。

左上角标题与浏览器标签页标题（`<title>`）都是「生成效果图」，面板分五栏折叠，默认只展开「文件管理」，
且**同时只展开一栏**（打开新的自动收起旧的，`details` 的 toggle 事件实现）：
**文件管理**（载入建筑文件 / 载入环境文件 / 选择文件… / 清除环境）、**模型列表**（构件与环境的显示开关，
底部只显示告警条数）、**场景列表**（10 固定场景 + 自定义镜头）、**显示样式**（素模 / 线稿 / 深度 / 法线 四选一）、
**渲染出图**（出图场景选择 / 提示词 / 生成效果图）。面板不再显示构件数量统计与右下标高表；自检脚本读 `WMShot.stats()`。

### 关于线稿与 AI 出图

线稿（黑线）对扩散模型的作用是**增强结构可读性**，属于可选通道，不是必需：ControlNet 类模型用
Lineart/Canny 条件时，清晰的棱边线能显著提高“几何不走形”的概率；纯 img2img 或 depth 条件时，素模本身已够用。
因此实现上保持“素模默认 + 线稿可切”（面板「显示样式」栏，线稿覆盖建筑与周边环境全部模型）。
页面出图固定送素模截图（`channels: ["color"]`）；要试 depth / normal 条件就走命令行
`node tools/ai-render.mjs --channels=color,depth[,normal]`（最多 3 张参考图）。

## 5. 从 JSON 中解析出的图纸事实（事实，非假设）

样本：Flie/输入文件/PlanFundingDrawing_2071793a1bc84bd2bb794bcfe680f313.json（图纸名 平面图提资_20260831）。

- **三个图框**：水泵间平面图（ViewKind=3）、配电间平面图（ViewKind=4，作为基准图框）、屋面平面图（ViewKind=5）。
- **坐标对齐规则**：各图框以自己的轴线 `1` 与轴线 `A` 的交点作为原点，平移到基准图框的轴线交点；
  基准图框的建筑物原点取其墙体轮廓的最小 X/Y。因此建模坐标系原点在基准图框的建筑角点。
- **建筑外包**：7200 × 15100（mm），外墙厚 200（由 WallObject.Outline 直接得出，非假设）。
- **标高体系**（绝对标高，mm）：水泵间地面 166759（= 建模 Z 0）、配电/控制间 169200（+2441）、
  室外地坪 168900（+2141）、屋面 173800（+7041）、钢梯平台 167659（+900）、集水坑底 165259（-1500）。
- **构件统计**（Console 读 `JSON.stringify(WMShot.stats())`；面板按用户要求已去掉统计栏）：图框 3、墙体 6、门 5、窗 7、柱 8（400×400）、楼梯 4（钢梯 3 + 建筑楼梯 1）、
  钢爬梯 1、坡道 3、基础 4、集水坑 1、雨水管 6、雨篷 3。
- **门窗清单**（尺寸与编号均直接读自 JSON，非假设）：

| 编号 | 类型 | 宽 × 高 (mm) | Kind | 备注 |
| --- | --- | --- | --- | --- |
| M1824 | 门 | 1800 × 2400 | 0（双开） | 外门，法线 (1,0) |
| FM甲1824 | 门 | 1800 × 2400 | 0（双开） | 外门，法线 (1,0) |
| M1024 | 门 | 1000 × 2400 | 1（单开） | 外门，法线 (0,-1) |
| FM甲1024 | 门 | 1000 × 2400 | 1（单开） | 内门，法线 (0,1) |
| FM甲1024 | 门 | 1000 × 2400 | 2（双向） | 内门，法线 (1,0) |
| XC1518 | 窗 | 1500 × 1800 | 0 | 方向 (0,1) |
| C1518 × 5 | 窗 | 1500 × 1800 | 0 | 其中 2 樘方向 (1,0)，3 樘方向 (0,1) |
| FM甲1024 | 内窗 | 1000 × 2400 | 1 | 防火观察窗，方向 (1,0) |

### 从总平面图（DXF，2026-09-24 版）解析出的事实

样本：`Flie/输入文件/菖蒲垇项目/总平面图.dxf`（UTF-8，单位 **m**）。原始数据与换算结果见
`white-model-viewer/data/site-context.json`（docs/DATA-MODEL.md 第 12 节）。

- **对位**：建筑外墙轮廓线（图层 `WALL_OUT` 较大矩形）7005.4 × 17902.6 mm；西南角
  (574350.811, 2880461.595) m ↔ 模型 (0, 0)，两套坐标相差 3.2962° 旋转（同名轴一一对应，不做镜像）。
  图纸无指北针，`X=东 / Y=北` 由坐标量级推断（574.35 km 只能作东向、2880.46 km 只能作北向）。
- **进水池**：`WALL_OUT` 较小矩形，2800.5 × 8600.1 mm，位于建筑西侧 **10 m**（东边到建筑西外墙面 10000.5 mm，
  图纸标注 10000），北边缘在建筑北外墙面以南 1053.2 mm。
- **河道**：麻桑河（图层 `SXSS` 共 18 条岸线折线），主河槽靠进水池一侧的岸线紧贴进水池，其余为渠道 / 护坡岸线
  （图纸文字：引水渠道、C20 素混凝土护坡 / 护底、1:2.0 与 1:5.0 边坡）。
- **高程点**：图层 `GCD` 的块 `gc200` 共 578 个，`height` 属性 = 高程值（163.05 – 175.47 m）。
- **其它**：`DMTZ` 陡坎 3 条（在建筑与进水池之间南北向穿过）、出水主管管道线 1 条、控制点 2 个、注记 40 条。
- **场地 / 道路**（图层 `DLSS`）：整环多段线 85 顶点 1317.0 m²，其中含建筑的那一圈（8 顶点 495.9 m²，
  生成器记为 `site`）是**场地轮廓**——只作顶面高程分界与「建筑范围」判据，不再单独出实体；其余部分为**道路**
  （6 段端点拼接、自交 0）；场地 8 条边（88.7 m）全部贴在整环折线上（0 – 1.5 mm）。
- **护坡**（图层 `DLSS-斜坡`）：开口折线 9 顶点（首尾连线 = 坡顶线，与场地轮廓距离 0.0 mm），187.8 m²。
- **与当前模型不一致（重要）**：总平面图的建筑外墙轮廓比当前内嵌 JSON 的墙体 AABB（7200 × 15100）
  长边多 **2802.6 mm**，进水池北边缘超出当前模型北端 **1749.4 mm**。两者的取水构筑物位置也不同
  （旧 JSON 取水构筑物在 X −14100…−7613，新图进水池在 X −12801…−10001）。
  **建议按新图纸重新导出 PlanFundingDrawing JSON**；对位数据只依赖总平面图，不需要改。

## 6. 已采用的假设（**待用户确认**，不要当成图纸事实）

这些是为了先跑通管线拍定的默认值，代码中都有明确常量位置，确认后应改成从 JSON 读取或写进数据文件：

| 假设 | 取值 | 代码位置 | 影响 |
| --- | --- | --- | --- |
| 窗台高 | 900 mm | white-model.js 里洞口生成处 | 所有窗洞下沿高度 |
| 门洞下沿标高 | 由 floorAt() 推断（检修平台/南侧房间 = 2441，水泵间 = 0） | white-model.js floorAt() | 门的位置高低 |
| 内墙起始标高 | 自 +2441 起（按所在房间楼面） | white-model.js interiorWallZ0() | 内墙高度 |
| 楼梯踏步高 | 250 mm（踏步宽按 JSON 梯段长等分） | white-model.js 楼梯段 | 楼梯形态 |
| 平屋面 | 不做找坡（屋面为平板 + 挑檐放样） | white-model.js 屋面段 | 屋面造型 |
| 楼板厚度 | 水泵间底板 200 mm；南侧室内填板 = `L.south − L.grade`（当前 300 mm）；屋面板 150 mm；平面范围按墙体 AABB / 房间轮廓推导 | white-model.js 楼板/屋面段 | 剖面厚度 |
| 挑檐放样路径 | 屋面外轮廓矩形（RoofPolylineObject Kind=0），截面自外墙面向外放样 | white-model.js 屋面段 + js/eaves.js | 挑檐形状 |
| 门窗族几何 | 6 个通用族（框 70 / 门扇厚 45 / 玻璃厚 8） | js/families.js | 门窗细节 |
| 地形范围 | 建筑外墙 AABB 每侧外扩 60 m（127 × 135 m） | `environment.marginMm` | 周边环境覆盖范围 |
| 场地平台标高 | 平台面 = `L.grade − 500`（正好是 DLSS 面底面），范围 = 场地轮廓（DLSS）内部；建筑外墙范围内挖空不出面 | `environment.platformSinkMm` | 建筑与地形衔接 |
| 场地 / 道路厚度 | 500 mm（DLSS 面只出一块实体，只能有一个厚度）；顶面在场地轮廓内 = 室外地坪（平）；轮廓外跟随地形、抬离自然地面 50 mm、5 m 过渡带回室外地坪 | `siteWorks.roadThkMm / roadLiftMm / roadBlendMm` | 道路形态 |
| 护坡厚度 | 500 mm（无地形数据时坡底取 `L.grade − siteThkMm`；顶面离地时自动加厚不悬空） | `siteWorks.slopeThkMm / siteThkMm / groundClearMm` | 护坡形态 |
| 场地轮廓不出实体 | 场地轮廓只用于顶面高程分界与「建筑范围」判据（`siteCheck().flatDevMm` 校验齐平），DLSS 面整环一块实体、材质 `road`；面板只剩 road / slope 两个开关 | `js/siteworks.js` 的 `pointInRing(siteRing, …)` | 建筑周边地面的外观 |
| 水深 | 水面 = 河床 + **1000 mm**（未按水文资料） | `environment.waterDepthMm` | 河道水位 |
| 主河槽岸线 | 两条主岸各由 2 段 SXSS 折线端点拼接（容差 0.5 m）；其余 SXSS 折线（渠道/护坡）只画线不做水面 | `riverChannel.mainChannel.bankIds` | 河道范围 |
| 进水池 | 只画轮廓线，不做池体（足迹基本落在主河槽内） | — | 取水构筑物形态 |

## 7. 已知限制与风险

- **门窗是占位几何**：只按洞口宽高缩放通用族，没有真实门窗分格、开启扇位置，需要 2D CAD 大样替换。
- **挑檐是占位截面**：500×150 平板，真实放样截面（DXF）到位后替换。
- **道路 / 护坡是图纸轮廓、不是几何近似**：直接取总平面图 `DLSS` / `DLSS-斜坡` 图层（多段线已由用户修剪成闭合图形），
  DLSS 整环只出一块实体（2026-09-24 修掉了「场地」「道路」各建实体时交界处的棋盘格斜纹带；
  2026-09-25 又按用户要求删掉了分岛后场地边界上的锯齿状明暗斜带，即删除场地实体）。
  仍依赖两份图纸版本收敛（见下条）。真实带高程三角网（OBJ）导入管线已就绪，但当前样例未启用。
- **墙体按轴对齐矩形（AABB）处理**：由 Outline 的 min/max 得到矩形，**不支持斜墙/异形墙**；若后续样本出现斜墙，需要改成多边形与定向开洞。
- **不做布尔运算**：墙体开洞用“沿墙区间 + 高度区间”的参数化拆板实现，避免依赖 CSG 库；
  洞口若跨越多个墙段或与墙端过近，可能出现拆板边界不理想。
- **线稿是几何棱边**：按 30° 二面角阈值生成，不是工程制图的投影线（看不到被遮挡轮廓），出图效果以实际观感为准；
  地形 / 道路这类近似光滑的大面只有边界与陡坡处出线，不会满屏噪声（分组建线稿，重复载入环境时旧线稿随分组回收）。
- **单一样本**：目前只验证过一个 JSON 样本，字段假设（如 Kind 含义、轴线编号）尚未在第二个项目上验证。
- **未使用的图元类型**：parseDrawing 会统计未处理类型（data.unknown），当前样本里包含
  BottomStairFlightObject、RoofHatchObject、DrainageTrenchObject、BreakLineObject、Intake* 系列等，均未建模。
- **图纸版本不一致（待用户处理）**：`总平面图.dxf`（2026-09-24）的建筑比页面内嵌 JSON（2026-08-31 导出）
  长边多 2802.6 mm，进水池北边缘超出当前模型北端 1749.4 mm。当前地形按总平面图、建筑按内嵌 JSON 生成，
  **两侧并非同一版设计**；建议按新图重新导出 JSON，`data/site-context.json` 的对位只依赖总平面图，重导出后无需修改。
- **周边环境是插值地貌，不是实测地形**：地形面由 578 个高程点 IDW 插值 + 去刺/平滑/坡度约束生成
  （1.5 m 网格），河床面由槽内点插值、水面 = 河床 + 水深（默认 1 m）。因此**不能当作土方量或防洪依据**；
  平台（场地）外缘与总平面图东南侧「地面硬化」高程点存在 0.9 – 1.2 m 台阶，属两份图纸版本差。
  验收基线与已知问题见 docs/DATA-MODEL.md 第 13 节；道路 / 护坡见第 14 节。
- **AI 出图是「提示词 + 参考图」，不是 ControlNet 强约束**：单次最多 3 张参考图（单图 ≤ 10 MB），
  输出边长受模型限制在 512–2048，几何保真靠 `promptSuffix` 锁死 + 线稿 / 深度条件图，仍可能出现构件偏差；
  出图 URL 官方只保留 24 小时，脚本拿到即立即下载。模型能力表与参数默认值见 docs/DATA-MODEL.md §5.7。
  提示词尾部的 `--ar W:H` 由脚本剥出并折算成输出尺寸（默认 `16:9` → `2048*1152`），不属于提示词正文。
- **页面出图的本地桥是「本机工具」**：`tools/ai-bridge.mjs` 只绑 `127.0.0.1`、不带鉴权，绝不要绑 `0.0.0.0`
  或做端口转发；key 只在桥进程内存里，页面拿不到（`/ai-render/config` 只回 `keyPresent`）。
  打包成 .exe 后应把它并进 Electron 主进程 IPC，不再要求用户手动起 Node。
- **页面出图只支持已加载的单个模型**：面板截图取的是页面当前相机与当前场景（含自定义镜头），
  但不能像 CLI 那样换 JSON 批量跑（`?src=` 见 ROADMAP 3.1，尚未实现）。

## 8. 素材现状与交付规格

已入库：原始 JSON、JSON 说明（含枚举映射）、DWG 与 DXF 图纸、解析结果 docx（均在 Flie/输入文件/）。

已就绪的数据资产：`white-model-viewer/data/site-context.json`（总平面图对位 + 高程点 + 进水池 + 河道，
由 `tools/dxf-site-context.mjs` 生成，无需用户再提供素材）。

待用户提供（规格详见 docs/ROADMAP.md 与 white-model-viewer/README.md）：

1. 挑檐：放样截面 DXF + 对齐说明（路径取哪条边、截面原点对齐点、朝内/朝外）。
2. 门窗：各类门窗 2D CAD 大样 DXF（立面为主，含平面开向更好）。
3. 地面：三角网 OBJ + 两个控制点对（地面坐标 ↔ 建筑坐标）+ 高程基准说明。

## 9. 版本历史

| 版本 | commit | 内容 |
| --- | --- | --- |
| v0.1.0 | e6c8857 | 白模查看器首版：JSON → Three.js 参数化白模、离线双击可用、CDP 截图脚本 |
| — | 6d1b253 | 上传输入文件（JSON / JSON 说明 / DWG / DXF / 解析结果） |
| v0.2.0 | 5867b3a | 线稿通道、门窗参数化族、挑檐截面放样 + DXF 提取工具、地形导入 |
| v0.3.0 | e9e43ab…273d642（tag `v0.3.0`，2026-09-25 补打） | 多视角预设（10）+ depth/normal 出图通道 + 批量出图（WMShot / cdp-shot 批量模式）+ 人视地坪裁剪 + ?annot=0 + 场景面板（8 固定场景 + 按图纸持久化的自定义镜头）+ 修复西/北墙窗框横穿墙厚凸出墙面（addPiece 左手基退化 + 双向门内侧把手越界）+ 门窗族几何自检 `WMShot.familyCheck()` |
| v0.4.0 | 2026-09-25（tag `v0.4.0`） | 周边环境渲染：`js/environment.js`（高程点插值地形面 + 河床面 + 水面，去刺/平滑/坡度约束/平台挖空）、`?env=1` 与面板「载入周边环境（默认数据）」、env-iso / env-river 两个视角预设（共 12 个）、4 个显示控制复选框、`WMShot.env()/loadEnv()/clearEnv()/envCheck()`、site-context v2（`mainChannel` + `environment` 参数块，生成时同步内嵌副本）、河床/水面材质边界藏到水位之下（`bedUnderMm`，修掉 1.5 m 网格量化的阶梯色块）；<br>道路 / 护坡：`js/siteworks.js`（总平面图 `DLSS` / `DLSS-斜坡` 图层，整环只出一块实体）、`WMShot.site()/loadSite()/clearSite()/siteCheck()`、site-context v3（`site` / `roads` / `slopes` / `siteWorks`）、删除原「地面 / 散水」实体、**修掉场地与道路各建实体时交界处的棋盘格斜纹带**、**修掉护坡几何从未进场景的 bug**（`buildSlab` 的几何在 `regions[0].geo`，原先误取 `slab.geo` → 恒为 undefined）、**按用户要求删除场地实体**（分岛后场地边界闪锯齿状明暗斜带；DLSS 面改为整环一块实体、材质 `road`，面板只剩 road / slope 两个开关） |

| v0.5.0 | 982a537（tag `v0.5.0`，2026-09-25 用户验收后打） | **AI 效果图链路**（白模 → 阿里云百炼 qwen-image → 效果图）：`tools/ai/dashscope.mjs` 调用层（同步图像接口 + `MODEL_CAPS` 能力表）、`tools/ai-render.mjs` CLI（`--views/--channels/--prompt/--dry-run/--mock/--yes`，复用 cdp-shot 截图）、`tools/ai-bridge.mjs` 本地桥（**只绑 127.0.0.1**，key 只从环境变量读、只在桥进程内存里、绝不回传页面）+ `js/ai-panel.js` 页面面板、`data/ai-render.json` 默认值（页面读 index.html 内嵌副本）、`start-ai-bridge.cmd` 双击起桥、提示词尾部 `--ar` 折算输出尺寸、产物 `out/<时间戳>|page-<时间戳>/{white,request,ai,run.json}`；<br>**左栏重构**：五栏互斥折叠（文件管理 / 模型列表 / 场景列表 / 显示样式 / 渲染出图，默认只展开第一栏）、标题与浏览器标签页统一为「生成效果图」、新增**显示样式**四选一（素模 / 线稿 / 深度 / 法线，线稿覆盖建筑 8 组 + 周边 terrain/riverBed/riverWater/road/slope）、删除重复控件（模型列表的线稿勾选框、渲染出图的条件图勾选框——页面出图固定送素模截图）、去掉出图通道下拉 / 构件数量统计栏 / 右下标高表（数量改由 `WMShot.stats()` 提供）、`WMShot` 新增 `style()`、`info()` 增加 `style/lines/edgeCounts` |

提交信息格式：`<type>: <中文说明>`；里程碑同时打 tag 并推送。

## 10. 环境与 Git 约定

- 仓库：https://github.com/ssh8uhb/20260828_Line_Cabin.git（远程名 origin，分支 main）。
- 推送方式：**HTTPS + Windows 凭据管理器**（本机没有 SSH 密钥，SSH 地址不可用）。
- 操作前登记目录：`git config --global --add safe.directory "D:/Work/Project/20260828_Line_Cabin"`
  （已写入用户全局 ~/.codex/AGENTS.md 规则：每个新项目登记一次）。
- 运行环境：Node 22+（本机 v24.15.0）、Python 3（本机 3.14.4，用于静态服务）、本机 Chrome/Edge（用于截图）。

## 11. 下一步

见 docs/ROADMAP.md：① **AI 出图（3.2）**—— CLI 与页面面板均已就绪（零成本 `--dry-run` / `--mock` 自检通过），
下一步用真实 key 出一次图并验收（`node white-model-viewer/tools/ai-render.mjs --views=iso-ne --yes`，
或起 `tools/ai-bridge.mjs` 后在页面里生成），验收通过后再打 tag；
② 高清超分（输出边长上限 2048）；③ 异步接口（万相 `wanx2.1-imageedit`）；④ JSON→白模批处理补齐
（3.1：`?src=` 任意路径加载）；⑤ Electron 打包 .exe（3.3，同时把本地桥并进主进程 IPC）。素材替换三件套（挑檐 / 门窗 / 地形）仍等用户提供素材。
总平面图与模型 JSON 的版本差异（§5、§7）需用户按新图重新导出 PlanFundingDrawing JSON 后才收敛。
