# 建筑白模查看器（PlanFundingDrawing JSON → Three.js）

把 CAD 插件导出的 `PlanFundingDrawing` JSON 在浏览器中生成可交互浏览的建筑白模。

![预览](preview.png)

## 直接使用

双击打开 `index.html` 即可（已内置示例数据，无需服务器）。

也可以把任意 JSON 拖进页面，或点击“选择 / 拖入 JSON 文件”加载：
- 文件通过本地读取，不会上传到任何服务器；
- 页面内置一份示例 JSON（`data/sample.json` 的同名副本），可直接体验。

## 操作

- 左键拖拽：旋转视角
- 右键拖拽：平移
- 滚轮：缩放
- 左侧面板：按构件类型显示/隐藏，包括：
  - 墙体、楼板、结构柱、屋面、楼梯、基础/集水坑/坡道、房间标注
  - **线稿叠加（黑线通道）**：对主要构件按二面角阈值(30°)提取棱边黑线，素模/线稿一键切换
  - **门窗构件**：框/扇/玻璃等参数化族实例（当前为通用占位族，CAD 大样到位后替换）
  - **出图通道**：素模（彩色）/ 深度 depth / 法线 normal，供 AI 渲染条件图使用（见下文）
  - **场景（视角镜头）**：10 个固定视角一键切换 + 自定义镜头保存/删除（见下文）
  - **AI 效果图（阶段③）**：勾选机位 + 提示词 → 本地桥 → 百炼出效果图（需先起 `tools/ai-bridge.mjs`，见下文）
  - **周边环境（总平面图）**：见下文「周边环境渲染」——载入 / 更换 / 清除场地数据，及地形面 / 河床面 / 水面 / 道路 / 护坡 / 环境线六个显示开关

## 已实现的建模逻辑（对应 JSON 图元）

| JSON 图元 | 白模处理 |
| --- | --- |
| `WallObject` | 矩形轮廓墙体；外墙/内墙按标高起止；门、窗洞口按“沿墙区间 + 高度区间”切割墙体（参数化拆板，不用布尔运算） |
| `DoorObject` / `WindowObject` | 墙上开洞 + 在洞口内摆放参数化门窗族（框/扇/玻璃/把手），按洞口宽高缩放、按墙方向与法线定向 |
| `StructuralColumnObject` | 结构柱（全高） |
| `PlanElevationAnnotationObject` | 读取标高生成层高体系：水泵间 0 / 配电控制间 2441 / 室外 2141 / 屋面 7041 mm |
| `StairObject` / `SteelStairObject` / `SteelStairPlatformObject` / `SteelLadderObject` | 参数化楼梯、钢梯、钢爬梯 |
| `RoomOutlineObject` / `MaintenancePlatformObject` | 房间轮廓线 + 文字标注 |
| `RampObject` / `ApronObject` | 室外坡道（找坡）、散水范围（原「地面 / 散水」白模实体已删除，周边地面改按总平面图 DLSS 图层生成，见下文） |
| `SumpPitObject` / `PumpFoundationObject` | 集水坑（下沉坑）、设备基础 |
| `RoofPolylineObject` / `RoofRainPipeObject` | 屋面板 + **挑檐截面沿外墙路径放样**（默认平板占位截面，真实 DXF 截面到位后替换）+ 雨篷 + 雨水管 |

三个图框（水泵间/配电间/屋面）通过轴线 1/A 对齐到同一建筑坐标系；重复图元（水泵间图框与配电间图框的重叠墙、柱）自动去重。

## v0.2 素材交付规格（替换占位数据）

### 1. 挑檐放样截面（替换 `data/eaves-profile.json`）
- 提供截面 **DXF** 1 份 + 文字说明（放样路径取哪条边线、截面原点对齐哪个点、朝内还是朝外）。
- 用 `tools/dxf-profile.mjs` 提取几何：`node tools/dxf-profile.mjs 截面.dxf 输出.json`
- 手工整理为：`{ "name": "...", "pathType": "wallFace", "unit": "mm", "profile": [[u,v],...] }`，u=距外墙路径的水平外挑(mm)，v=相对屋面结构标高（向下为负）。

### 2. 门窗 CAD 大样（替换 `js/families.js` 中的几何 builder）
- 提供各类门窗 2D CAD 大样（DXF，立面为主，含平面开向更好）。
- 族选择按 `DoorObject/WindowObject.Kind` 与宽度自动匹配：单开门/双开门/双向单开门/固定窗/双扇窗/防火观察窗。

### 3. 地面三角网（可选，未提供时使用平面地面）
- `data/terrain.obj`：OBJ 三角网（v/f 即可）。
- `data/terrain-registration.json`：定位关系
  ```json
  {
    "unit": "mm",
    "zReference": { "groundZ": 168900, "buildingZ": 2141 },
    "points": [
      { "ground": { "x": .., "y": .. }, "building": { "x": .., "y": .. } },
      { "ground": { "x": .., "y": .. }, "building": { "x": .., "y": .. } }
    ]
  }
  ```
  两个控制点对求解 2D 相似变换；Z 按 zReference 换算（建议取轴线 1/A 与 2/D 交点处的地面实际点）。

## 静态出图（AI 渲染输入）

本地静态服务方式：

```bash
python -m http.server 8123
# 打开 http://localhost:8123/white-model-viewer/
```

无头截图（需要本机 Chrome，Node 22+）：

```bash
node tools/cdp-shot.mjs "http://localhost:8123/white-model-viewer/?static=1" out.png 8
```

`?static=1` 渲染数帧后停止，便于稳定截图；URL 参数：

| 参数 | 作用 |
| --- | --- |
| `env=1` | 载入周边环境（地形面 / 河床面 / 水面 / 道路 / 护坡，用内嵌副本，离线可用） |
| `lines=1` | 出图含黑色线稿叠加 |
| `annot=0` | 隐藏房间标注（文字 + 房间轮廓线），得到纯净条件图 |
| `ui=0` | 只留三维画面：隐藏左侧面板、底部提示条与右下标高表（**AI 出图条件图必加**，否则模型会把面板文字画进效果图） |
| `bg=ffffff` | 背景色（6 位 hex） |
| `view=名字` | 应用视角预设（见下表），如 `?view=iso-ne` |
| `channel=…` | 出图通道 `color` / `depth` / `normal`，如 `?channel=depth` |

### 视角预设（12 个，按建筑包围盒自动推算，适配任意 JSON）

| 名称 | 内容 |
| --- | --- |
| `iso-ne / iso-nw / iso-se / iso-sw` | 四角鸟瞰 |
| `elev-s / elev-n / elev-w / elev-e` | 南 / 北 / 西 / 东立面（正视） |
| `persp-1 / persp-2` | 人视（室外地坪 + 1700mm 视高；自动裁掉地坪以下的基础/集水坑，画面如真实照片） |
| `env-iso / env-river` | 周边鸟瞰（覆盖整个地形盒）/ 河道视角（河槽中心线上方 40 m 沿槽看下游）；**需先载入周边环境**，不套用人视裁剪面 |

### 场景（左侧面板「场景（视角镜头）」区域）

场景 = 一个固定存储的镜头（相机位置 + 目标点 + 是否裁剪地坪以下）。

| 类型 | 内容 | 存储 |
| --- | --- | --- |
| 固定场景（10 个，不可删除） | 4 个正立面：南立面 / 北立面 / 西立面 / 东立面；4 个角部向下鸟瞰：东北 / 西北 / 东南 / 西南鸟瞰；2 个周边视角：周边鸟瞰 / 河道视角（**未载入周边环境时置灰**） | 不存储，由建筑包围盒（周边视角用地形盒）实时推算（等价于 `?view=` 的 `elev-{s,n,w,e}`、`iso-{ne,nw,se,sw}` 与 `env-iso/env-river`） |
| 自定义场景（任意个） | 点击「＋ 存为当前镜头」，弹窗命名后保存当前镜头；点名称应用，点 `×` 删除 | 浏览器 localStorage，键 `wm.scenes.v1:<DrawingName>`，**每张 JSON 图纸独立一套**；localStorage 不可用时退化为会话内存 |

出图脚本接口同样可用：`window.WMShot.scenes()` 读取（含存储键与自定义列表）、`WMShot.saveScene(name)`、
`WMShot.applyScene({pos,target,clip})`。

### 出图通道

| 通道 | 说明 |
| --- | --- |
| `color`（素模） | 白模渲染；配合 `lines=1` 可加黑色棱边线稿 |
| `depth` | 线性深度：近白远黑、纯黑背景（ControlNet Depth 友好） |
| `normal` | 视空间法线：朝向面的 RGB ≈ (128,128,255)（ControlNet Normal 规范） |

depth / normal 通道自动隐藏线稿与标注，与素模同一相机渲染，逐像素对齐。

### 批量出图（一次产出多视角 × 多通道）

输出路径是目录（或加 `--` 开头参数）时进入批量模式，驱动页面内 `window.WMShot` 接口循环截图：

```bash
# 全部 12 视角 × 3 通道 = 36 张 + manifest.json
node tools/cdp-shot.mjs "http://localhost:8123/white-model-viewer/?annot=0" 输出目录 --views=all --channels=color,depth,normal

# 只出指定视角 / 通道
node tools/cdp-shot.mjs "http://localhost:8123/white-model-viewer/" 输出目录 --views=iso-ne,elev-s --channels=color,depth
```

输出文件命名 `视角-通道.png`（如 `iso-ne-depth.png`）；同时写 `manifest.json`，记录每个视角的
相机 pos / target / fov 与建筑包围盒，保证不同版本之间的出图可以逐像素比对。
`--views=` 逗号分隔或 `all`；`--channels=` 逗号分隔；末尾数字是页面加载等待秒数（默认 8）。

### 门窗族几何自检（改了 js/families.js 就跑到 0 为止）

```js
// 页面 Console 直接执行；也可由 CDP 探针调用
JSON.stringify(WMShot.familyCheck())   // → {"pieces":78,"offenders":0,"detail":[]}
```

`pieces` = 门窗族块体总数，`offenders` = 越出洞口范围（凸出墙面 / 越过洞口边）的块数，
**必须为 0**；非 0 时 `detail` 给出洞口号、族名与实测 u/v/n 区间。
样例基线：78 块 / 0 越界。规则与「左手基导致构件朝向退化」的成因见 docs/DATA-MODEL.md 5.2。

### 周边环境几何自检（改了 js/environment.js 就跑到指标达标为止）

```js
// 页面 Console 直接执行；也可由 CDP 探针调用
JSON.stringify(WMShot.envCheck())   // → {nanCount, slopeMax, spikeMaxMm, platform, hole, water, counts, …}
```

关键指标：`nanCount = 0`、`slopeMax ≤ 1.0`（1:1）、`spikeMaxMm ≤ 600`、
`platform.devMaxMm = 0`（平台严格 = `L.grade − 500`，范围 = 场地轮廓内部）、`water.aboveLandCount = 0`（水面不越岸）。
样例基线（v0.4.0，建筑 + 周边环境）：地形 13920 三角 / 河床 1794 / 水面 632 / 裙边 704，
坡度最大 0.417、去刺残差 280 mm。参数含义、算法顺序与已知问题见 docs/DATA-MODEL.md 第 13 节。

### 道路 / 护坡几何自检（改了 js/siteworks.js 就跑到指标达标为止）

```js
// 页面 Console 直接执行；也可由 CDP 探针调用
JSON.stringify(WMShot.siteCheck())   // → {ok, issues, flatDevMm, roadSeamDevMm, slopeThkMinMm, …}
```

关键指标：`ok = true`（`issues` 空）、`flatDevMm = 0`（建筑范围内顶面严格齐平室外地坪）、
`roadSeamDevMm = 0`、`roadGapMaxMm = 0`（底面没离开地形）、`platformGapMm = 0`（DLSS 面底面与地形平台齐平）、
`slopeThkMinMm ≥ 499`、`roadRaiseMm` 下限 ≥ −1（道路没埋进自然地面）、`roadTopDown` / `slopeTopDown` = 0（顶面绕序）。
样例基线（v0.4.0，建筑 + 周边环境）：DLSS 面 18760 三角（10152 顶点）/ 护坡 1352 三角（830 顶点，
落差 3879 mm）、`roadRaiseMm` [50, 953]。
参数含义、算法与已知问题见 docs/DATA-MODEL.md 第 14 节。

## AI 效果图（阶段③：白模截图 + 提示词 → 效果图）

把上面的静态出图能力接到**阿里云百炼（DashScope）同步图像接口**：出白模截图 → 带提示词送模型 → 下载效果图。
两种用法共用同一份调用层 `tools/ai/dashscope.mjs`（Node 侧零依赖）：
**① 页面面板**（`tools/ai-bridge.mjs` 本地桥 + 页面「AI 效果图」区域，所见即所得、可渲自定义镜头）；
**② 命令行**（`tools/ai-render.mjs`，批量、可脚本化、run.json 可追溯）。

```bash
# 1) 设置 API key（只从环境变量读；key 不进仓库、不进 run.json、不进页面）
#    PowerShell:  $env:DASHSCOPE_API_KEY="sk-xxxx"       CMD:  set DASHSCOPE_API_KEY=sk-xxxx

# 2) 零成本自检：只出白模图 + 请求体记录 + run.json，不发任何请求、不需要 key
node tools/ai-render.mjs --views=iso-ne,elev-s --dry-run
node tools/ai-render.mjs --views=iso-ne --mock        # 本地假接口，跑通「调用→下载→落盘」全链路

# 3) 真出图（每次调用都计费；不加 --yes 会先打印调用次数并要求确认）
node tools/ai-render.mjs --views=iso-ne                        # 默认：1 视角 × 素模单图（iso-ne = 东北鸟瞰）
node tools/ai-render.mjs --views=persp-1,persp-2,iso-ne --channels=color,depth --yes
```

### 页面里出图（推荐给人看/调风格）

最省事的方式：**双击 `start-ai-bridge.cmd`** —— 它会起桥并自动打开白模页面（带 `?env=1`）。
key 没设时会提示粘贴（只留在这个窗口的内存里）；想彻底免输入，就在 `white-model-viewer/` 下建一个
`.dashscope-key` 文件、第一行写 key（已在 `.gitignore` 里，不会被提交）。关掉那个窗口即停止服务。

也可以手动起（等价）：

```bash
# 终端 A：起本地桥（只绑 127.0.0.1；页面直连百炼会被 CORS 拦，且 key 必须留在 Node 侧）
$env:DASHSCOPE_API_KEY="sk-xxxx"; node tools/ai-bridge.mjs            # 默认 http://127.0.0.1:8787
$env:DASHSCOPE_API_KEY="sk-xxxx"; node tools/ai-bridge.mjs --mock     # 零成本：本地假接口，出图直接回显白模截图
# 终端 B / 双击页面：打开 white-model-viewer/index.html（页面面板截图走 canvas，不带面板；CLI 的 ?ui=0 同效）
```

面板「AI 效果图（阶段③）」区域：勾选要渲染的视角（12 个预设 + 自定义镜头，`看` 按钮只切机位不入队）→
改提示词（`恢复默认提示词` 从页面内嵌的 `#aiRenderData`——`data/ai-render.json` 的副本——读回）→
`生成效果图（N 次调用）`（弹窗确认后逐张发起）。
页面**自己截图**（`WMShot.capture`，默认 1600×900，逐通道导出 dataURL）后 POST 给本地桥，桥调用百炼、落盘、回图。
未启动桥时按钮置灰并显示启动命令；桥没读到 key 时提示环境变量名。

| 端点 | 作用 |
| --- | --- |
| `GET /ai-render/config` | 配置 + `keyPresent`（**不回传 key**）+ 本会话已用调用数 |
| `POST /ai-render` | `{view,label,hint,channels,images:{color:dataURL,…},prompt,doc}` → 出图落盘 → 返回结果图 URL |
| `GET /ai-render/image/<id>` | 结果图 PNG（id 由桥签发，不接受路径） |

桥的安全与成本约定：只绑 `127.0.0.1`；key 只在桥进程内存里；CORS 只放行本地页面；
`--max-calls=N`（默认 12）限制**单次桥会话**的付费调用数；出图产物落在 `out/page-<时间戳>/`（同 CLI 的四件套）。

输出目录（默认 `out/<年月日-时分秒>/`，页面桥为 `out/page-<年月日-时分秒>/`，都在 `.gitignore` 里）：

| 文件 | 内容 |
| --- | --- |
| `white/<视角>-<通道>.png` + `manifest.json` | 白模截图（CLI 走 `tools/cdp-shot.mjs`，相机参数在 manifest 里；页面桥走页面内截图） |
| `request/<视角>.json` | **实际请求体**记录（图片 base64 换成文件指纹 `{file,bytes,sha256,size}`），可复现、不含 key |
| `ai/<视角>-ai.png` | 效果图（`--n > 1` 时为 `-ai1.png` / `-ai2.png`…） |
| `run.json` | 模型 / 参数 / 每次调用的 requestId / 输入与输出 sha256 / 长宽比偏差 / 付费调用次数（桥另有 `source:"page"`） |

参数与提示词默认值在 `data/ai-render.json`（命令行逐项覆盖，含义见 `docs/DATA-MODEL.md` 第 5.7 节）：

| 常用参数 | 说明 |
| --- | --- |
| `prompt` / `promptSuffix` | 提示词主体 / 固定后缀（只改材质灯光配景、锁死几何与构图） |
| `prompt` 里的 `--ar W:H` | Midjourney 风格画幅标记：**从正文里剥掉**，`size=auto` 时按它换算输出尺寸（如 `--ar 16:9` → `2048*1152`） |
| `views` / `channels` | 默认 `["iso-ne"]` / `["color"]`；`channels` 最多 3 个，同时决定**截哪些通道**与**送哪几张条件图**（顺序即图序，第 1 张带视角提示词） |
| `model` | 默认 `qwen-image-3.0`；同族可换 `qwen-image-3.0-pro` / `qwen-image-2.0-pro` / `qwen-image-edit-plus`（是否支持 `size`/`n` 见 `tools/ai/dashscope.mjs` 的 `MODEL_CAPS`） |
| `size` | `auto`（默认，按输入图长宽比吸附到 512–2048 的合法档位）或显式 `W*H`（星号分隔；总面积需在 512²–2048² 之间、长宽比 1:8–8:1） |
| `bridge` / `captureSize` | 页面桥的 `host:port` / 页面内截图尺寸（默认 `127.0.0.1:8787` / `1600*900`，页面内嵌副本里的同名值要一起改） |
| `page` / `query` | CLI 截图用的页面与查询串：默认 `index.html?env=1&annot=0&lines=1&ui=0`。**`ui=0` 不能去掉**——cdp-shot 截的是整个视口，带面板会被模型画进效果图（页面面板走 canvas 截图，不受影响）；用 `--page=` 换页面时也要带上 |

命令行：`--views=`（名字或 `all`）、`--channels=color[,depth,normal]`、`--prompt=` / `--prompts=<file.json>`（按视角覆盖）、
`--model=`、`--base-url=`（业务空间域名）、`--size=`、`--n=`、`--seed=`、`--negative=`、`--out=DIR`、`--page=` / `--url=`、
`--shots=DIR`（复用已出的白模图）、`--skip-shots`、`--wait=`、`--timeout=`、`--retries=`、`--interval=`、
`--key-env=` / `--key=`、`--dry-run`、`--mock[=401|429|500]`、`--yes`。
桥的命令行：`--port=`、`--host=`、`--out=DIR`、`--model=`、`--base-url=`、`--max-calls=N`、`--mock`。

成本与安全约定：**默认只出 1 张**；不加 `--yes`（CLI）或不在页面弹窗确认时不会发起调用；超时**不自动重试**
（可能已计费），只有限流 / 5xx 才重试；结果图 URL 官方只保留 24 小时，脚本**拿到就立即下载**，
失败时把 URL 记进 `run.json` 供手动补救。

验收判据（首次联调）：`ai/<视角>-ai.png` 生成成功、长宽比与输入偏差 ≤ 5%，**建筑轮廓 / 体量 / 屋面形状 /
门窗数量与位置与白模一致**，材质灯光天空配景明显变化；`run.json` 的 `summary.paidCalls` 等于实际调用次数。
目视比对可用本机识图脚本，例如：

```bash
node C:/Users/lenovo/.codex/skills/claude-vision-skill/vision.js out/<ts>/ai/iso-ne-ai.png "与 out/<ts>/white/iso-ne-color.png 对比：建筑轮廓、屋面形状、门窗数量与位置是否一致？只列差异"
```

已知限制：① 单次最多 3 张参考图、单图 ≤ 10 MB；② 输出边长受模型限制在 512–2048（要更高清需二次超分）；
③ 几何保真靠提示词与线稿/depth 条件图，不是严格的 ControlNet 约束；④ 当前只能渲页面默认加载的样例 JSON
（`?src=` 任意路径加载属 ROADMAP 3.1，尚未实现，`--json=` 会明确报错）；
⑤ 页面桥是**本机工具**：只绑 127.0.0.1、不带鉴权，别绑到 0.0.0.0 或转发到公网。

## 文件结构

```text
white-model-viewer/
  index.html            页面（含内嵌示例 JSON 与挑檐数据占位）
  js/white-model.js     JSON 解析 + 参数化建模 + 渲染
  js/families.js        门窗参数化族（通用占位，CAD 大样到位后替换几何）
  js/eaves.js           挑檐截面沿路径放样
  js/environment.js     周边环境：高程点插值地形面 + 河床面 + 水面 + 环境线
  js/siteworks.js       道路 / 护坡：总平面图 DLSS、DLSS-斜坡 图层
  js/terrain.js         地形 OBJ 导入 + 双控制点配准（未接线）
  js/ai-panel.js        AI 效果图面板（视角勾选 / 提示词 / 出图进度与预览，与 tools/ai-bridge.mjs 通信）
  lib/                  three.js r128 + OrbitControls（本地依赖）
  data/sample.json      示例 JSON
  data/eaves-profile.json   挑檐默认占位截面
  data/canopy-profile.json  雨篷默认占位截面
  data/site-context.json    总平面图对位与环境数据（高程点 / 进水池 / 河道 / 场地轮廓 / 道路 / 护坡，见下节）
  data/ai-render.json   AI 出图的提示词与默认参数（Node 侧读取；页面面板读 index.html 里的内嵌副本，改一处要同步另一处）
  tools/cdp-shot.mjs    CDP 无头截图脚本
  tools/ai-render.mjs   AI 出图 CLI（白模截图 → 百炼图像接口 → 效果图 + run.json）
  tools/ai-bridge.mjs   AI 出图本地桥（页面 → 百炼，只绑 127.0.0.1，key 只留在 Node 侧）
  start-ai-bridge.cmd   双击起桥 + 自动打开页面（Windows 快捷入口；key 缺失时会提示粘贴）
  tools/ai/dashscope.mjs 百炼同步接口调用层（请求体 / 提示词 / 调用 / 错误分类 / 下载 / mock，零依赖）
  tools/dxf-profile.mjs DXF 截面几何提取
  tools/dxf-site-context.mjs  总平面图 DXF → data/site-context.json（同时同步 index.html 内嵌副本）
  tools/site-context-plot.mjs 对位校验图（自包含 HTML，用 cdp-shot 截图查看）
```

（`data/elevation-profiles.json`、`data/facade-components.json` 为 `立面构件.dxf` 提取的备用素材，
当前版本尚未被 buildModel 读取。）

## 场地环境数据与周边环境渲染

`data/site-context.json`（v3）把 `Flie/输入文件/菖蒲垇项目/总平面图.dxf` 里的场地信息换算到**模型坐标系（mm）**，
查看器据此渲染建筑周边的地形 / 河床 / 水面与道路 / 护坡。

```bash
cd white-model-viewer
node tools/dxf-site-context.mjs     # 重新解析 DXF（图纸更新后执行），同时同步 index.html 内嵌副本，并打印一致性告警
node tools/site-context-plot.mjs    # 生成对位校验图 HTML（默认写系统临时目录）
node tools/cdp-shot.mjs "file:///<临时目录>/site-context-check.html" site-context.png 6
```

面板操作（左侧「周边环境（总平面图）」）：

| 按钮 / 开关 | 作用 |
| --- | --- |
| **载入周边环境（默认数据）** | 用内嵌 `#siteContextData`（= `data/site-context.json` 副本）生成地形 / 河床 / 水面与道路 / 护坡，并切到「周边鸟瞰」视角 |
| **选择文件…** | 换用另一份 `site-context.json`（可用于其它项目） |
| **清除** | 移除环境几何、恢复建筑视角 |
| 显示控制：周边地形面 / 河道河床面 / 河道水面 / 道路（DLSS 面）/ 护坡（场地→河床）/ 环境线（岸线 / 轮廓） | 六个开关分别控制各分组；「全选 / 取消」会一并切换。DLSS 面（场地轮廓外那一圈 + 建筑周边）是**一整块实体**，开关只切换材质可见性 |

出图用法（与 `?env=1` 等价，脚本接口还能中途载入）：

```bash
node tools/cdp-shot.mjs "file:///D:/Work/Project/20260828_Line_Cabin/white-model-viewer/index.html?env=1&annot=0&view=env-iso" out.png 8
node tools/cdp-shot.mjs "file:///D:/Work/Project/20260828_Line_Cabin/white-model-viewer/index.html?env=1&annot=0" outdir --views=all --channels=color,depth,normal
```

脚本接口：`WMShot.env()`（`{on, bounds, stats}`）、`WMShot.loadEnv(sc?)`、`WMShot.clearEnv()`、`WMShot.envCheck()`、
`WMShot.site()`（`{on, stats}`）、`WMShot.loadSite(sc?)`、`WMShot.clearSite()`、`WMShot.siteCheck()`（道路 / 护坡验收指标）。

生成规则：地形面 = 578 个高程点 IDW 插值（去刺 + 拉普拉斯平滑 + 坡度约束），范围 = 建筑外墙 AABB 每侧外扩 60 m；
河床面 = 主河槽（岸线 id 1 + id 2）内高程点插值、与地面取 min（不会冒出「假土包」）；两条主岸由图纸上多段
首尾相接的 SXSS 折线端点拼接（容差 0.5 m），岸线沿北西延伸段穿出地形盒、河道在盒边自然截断；
水面 = 河床 + 水深（默认 1000 mm，`environment.waterDepthMm` 可调）；
场地平台面 = `L.grade − 500`（正好是 DLSS 面底面），建筑外墙范围内挖空不出面；地块四周 3 m 裙边。

道路 / 护坡（`js/siteworks.js`，用总平面图 `DLSS` / `DLSS-斜坡` 图层）：
DLSS 面 = `DLSS` 整环只出一块实体，顶面在场地轮廓内严格齐平室外地坪、轮廓外跟随地形
（在 5 m 过渡带内平滑到室外地坪，整体抬离自然地面 50 mm）；护坡 = `DLSS-斜坡` 环（从场地标高斜到河床）。
**场地轮廓内那一块不再单独出实体**：早先按三角形重心把 DLSS 面分成「场地」「道路」两个材质岛、
各建一块实体，交界处两片重合立侧面在人视图里闪成棋盘格斜纹带（2026-09-24 修复）；分岛后
场地边界上又出现锯齿状明暗斜带，2026-09-25 按用户要求删除场地实体，只留一块 DLSS 面（材质 `road`）。
厚度统一 500 mm。算法顺序、默认值总表与假设见 `docs/DATA-MODEL.md` 第 14 节与第 5.6 节。

内容：`alignment`（对位变换：平移 + 旋转 3.2962° + ×1000，锚点 = 建筑西南角 ↔ 模型 (0,0)）、
`building`（外墙轮廓线与尺寸）、`elevationPoints`（578 个高程点，含总平面图 m 坐标与模型 mm 坐标）、
`intakePool`（进水池轮廓与净距）、`riverChannel`（麻桑河岸线 + `mainChannel` 主河槽定义；一条岸可拆成多段
折线首尾相接，生成器按端点 0.5 m 容差自动拼成整条，`segments` 字段记段数，闭合折线不参与拼接）、
`environment`（环境渲染默认参数）、`siteWorks`（道路 / 护坡的参数）、`site`（场地轮廓，只作顶面高程分界与「建筑范围」判据）、
`roads`（DLSS 整环与分好的 6 段道路折线）、`slopes`（DLSS-斜坡 护坡折线）、
`context`（陡坎 / 管道 / 控制点 / 注记）、`consistency`（与当前模型的尺寸差异自检）。

坐标与公式、图层约定、以及「总平面图与当前 JSON 版本不一致（长边差 2802.6 mm）」的说明见
`docs/DATA-MODEL.md` 第 12 节。校验图判读要点：Y = 0 基准线同时穿过总平面图轮廓线与模型 AABB 的南边。