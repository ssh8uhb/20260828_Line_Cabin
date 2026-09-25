# 数据模型 — PlanFundingDrawing JSON → 白模

本文件回答两件事：

1. **参数怎么读**：白模实际读取了 JSON 的哪些字段、按什么规则换算成几何；
2. **读不到时怎么办**：哪些构件走默认形状、哪些尺寸是代码里写死的默认值、缺字段时怎么兜底。

字段的完整定义、类型、枚举映射请看权威文档 `Flie/输入文件/PlanFundingDrawing_JSON说明.md`，本文件不重复抄写。

代码位置：
`white-model-viewer/js/white-model.js`（parseDrawing / buildLevels / buildModel / carveWall / buildEdgeLines）、
`js/families.js`（门窗参数化族）、`js/eaves.js`（挑檐截面扫掠）、`js/terrain.js`（地形 OBJ 配准，未接线）、
`js/environment.js`（周边环境：地形面 / 河床面 / 水面，见第 13 节）、
`js/siteworks.js`（道路 / 护坡：总平面图 DLSS、DLSS-斜坡 图层，见第 14 节）、
`tools/dxf-site-context.mjs`（总平面图 DXF → 场地环境数据，见第 12 节）。

## 1. 顶层结构

| 字段 | 是否使用 | 用途 |
| --- | --- | --- |
| DrawingName | 使用 | 页面标题与统计栏 |
| ViewFrames[] | 使用 | 唯一的数据入口；每个图框含 ViewKind / ViewTypeName / Elements[] |
| DrawElementBounds | 未使用 | 可用于视图自适应，当前用固定相机 |
| DrawingPath / SourceDrawingPath / WaterMachineSourceDrawingPath / ElectricalSourceDrawingPath | 未使用 | 图纸溯源信息 |
| IntakePoolChannelSlopeParameters | 未使用 | 取水/前池相关参数 |

## 2. 坐标系、单位与图框对齐

- 单位统一 **mm**；JSON 是二维平面数据：`X, Y` → Three.js 的 `(x, z)`，高度方向为 `y`。
- **基准图框**：优先 ViewKind = 4（配电间平面图，含完整墙体），否则取 ViewFrames[0]。
- **建筑原点**：基准图框所有 WallObject.Outline 的最小 X / 最小 Y（即建筑外墙西南角 → 本地 (0, 0)）。
- **图框对齐**：每个图框取自己的轴线 `1`（AxisObject.Number = "1" 的 LocationLine.Start）与轴线 `A`
  （Number = "A" 的 LocationLine.Start.Y）交点，平移到基准图框的轴线交点：
  `off = 基准原点 + (本图框轴线交点 − 基准图框轴线交点)`，所有坐标按 `点 − off` 转本地。
  缺轴线 `1` 或 `A` 的图框**整框跳过**并记 warning。
- **Z=0** = 水泵间地面（绝对标高 166759）；所有标高换算为相对 166759 的本地高度。
- **建筑外轮廓**：`wallBounds(data.walls)` = 全部墙体 AABB 的并集（样例 = 0,0 – 7200,15100）。
  楼板、门窗朝向、场地/道路、包围盒、视图预设**统一以它为准**，不含任何写死的建筑尺寸。
- **南侧区块**：楼面为 `L.south` 的房间（即名称不含「水泵间」的房间）轮廓并集，样例 = 200,200 – 7000,4800。
  其外缘 `sr.y1` 作为南侧区块与水泵间的分界线（`ySplit`），用于门洞底标高推断。
- **场地（总平面图）对位**：模型坐标与总平面图坐标的换算、高程点 / 进水池 / 河道的原始数据见第 12 节
  （`data/site-context.json`，v3；已由 `js/environment.js` 接入周边环境渲染、`js/siteworks.js` 接入道路 / 护坡，
  见第 13、14 节）。

## 3. 参数读取通则

1. **类型分派**：取 `$type` 逗号前部分 → 按 `.` 取最后一段做类型名
   （`"ViewPlanCreate.Models.PlanFunding.DoorObject, LZ.ViewPlanCreate"` → `DoorObject`）。
   未命中任何 case 的类型计入 `data.unknown`，只统计不建模（页面末尾打 warning）。
2. **两种几何读法，优先第一种**：
   - **区间字段**（`Outline[]` / `Vertices[]` / `Bounds.Min/Max`）→ 取 AABB 当矩形/包围盒用；
   - **定位字段**（`InsertionPoint` / `Center` / `OpeningMidpoint` + `Width` / `Height` / `Length`）
     → 按中心点 + 尺寸建形体。
   注意：**轮廓只取 AABB**，即 L 形 / 斜墙都退化为包围矩形，模型不还原真实轮廓形状。
3. **单例构件只取首个**：`sump` / `platform` / `steelPlatform` / `ladder` / `apron` 遇到第二个同类直接跳过；
   `stair`（StairObject）是**后写覆盖**，即取最后一个。
4. **容差约定**（判定是否相交时的放宽量）：

   | 位置 | 容差 | 用途 |
   | --- | --- | --- |
   | 洞口归属墙 | 5 mm | 洞口中心须落在墙 AABB 内，否则该墙不承载此洞口 |
   | 墙去重 | 1 mm | 判断小墙是否被大墙完全包含 |
   | 内墙找相邻房间 | 60 mm | 内墙与房间轮廓相交判定 |
   | 门洞楼面推断 | 150 mm | 判定洞口是否在检修平台范围内 |
   | 截面放样竖向合并 | 0.5 mm | 挑檐截面相邻点 u 相同则识别为竖面 |

5. **外部素材的加载顺序**（`resolveExtras()`）：先 fetch `data/*.json`（或 `?static=1` 时同步 XHR），
   失败再读页面内嵌的 `<script type="application/json" id="...">` 占位。
   因此**新增外部素材必须在 index.html 内嵌一份同内容占位**，否则 file:// 打开会缺数据。

## 4. 图元 → 白模处理

代码用 `$type` 最后一段做类型分派。

| 图元（$type 短名） | 读取的关键字段 | 白模处理 |
| --- | --- | --- |
| WallObject | Outline[]、Kind | 取轮廓 AABB 作为矩形墙；Kind=0 为外墙（从基准标高到屋面），其它为内墙（起始标高按所在房间楼面推断） |
| StructuralColumnObject | InsertionPoint、Length、Width | 结构柱，全高 |
| DoorObject | OpeningMidpoint/InsertionPoint、Width、Height、Kind、IsExterior | 生成门洞 + 摆放门族（Kind 0 双开 / 1 单开 / 2 双向） |
| WindowObject | InsertionPoint、WallDirection、Width、Height、Kind | 生成窗洞 + 摆放窗族；洞口中心 = InsertionPoint + WallDirection × Width/2 |
| StairObject | InsertionPoint、FirstFlightStepCount、FirstFlightLength | 建筑楼梯（踏步高 250 为假设值，踏步宽按梯段长等分） |
| SteelStairObject | InsertionPoint | 钢楼梯（按位置去重） |
| SteelStairPlatformObject | Bounds | 钢梯平台 |
| SteelLadderObject | InsertionPoint | 钢爬梯 |
| SumpPitObject | Bounds、ElevationMm | 集水坑（下沉坑，坑底标高参与标高体系） |
| PumpFoundationObject | Bounds | 设备基础 |
| RampObject | InsertionPoint、方向、Length、Width | 当前不直接建模；坡道改为按外门自动生成，见第 10 节 |
| ApronObject | InnerOutline / OuterOutline | 当前不直接建模；原「地面 / 散水」已删除，建筑周边场地与道路改按总平面图 DLSS 图层生成，见第 9 / 14 节 |
| RoomOutlineObject | Outline、RoomName | 房间轮廓线 + 文字标注 |
| MaintenancePlatformObject | Bounds | 检修平台（楼板） |
| PlanElevationAnnotationObject | Kind、ElevationMm | 标高体系来源，见第 7 节 |
| PlanMultilineTextObject | InsertionPoint、Text | 仅解析入 `data.texts`，当前不绘制 |
| RoofPolylineObject | Kind、Vertices[] | Kind 0 = 屋面外轮廓；Kind 3 = 挑檐外沿（无截面时用）；Kind 4 = 雨篷（仅解析，未建模） |
| RoofRainPipeObject | Center、Diameter | 雨水管（圆柱） |
| 其它（AxisObject / RoofHatchObject / RoofDetailBlockObject / DrainageTrenchObject / BreakLineObject / ElectricalRoomObject / PumpRoomObject / MaintenancePlatformPartitionObject / Intake* / BottomStairFlightObject …） | — | 未建模，仅计入 `data.unknown` 统计 |

**雨篷建模规则**（`addExtrudedCanopy()`，位于 js/white-model.js）：
- 每个外门（`exterior && placed`）生成一个雨篷，截面取自 `data/canopy-profile.json`（从
  `立面构件.dxf` 黄色轮廓线提取，`[u,v]` 局部坐标，u=0 为紧贴墙面，u 增大方向为向外挑出，
  v=0 为门洞顶标高）。
- 放样路径与门洞顶部轮廓线共线，长度 = 门洞宽度 + 两侧各 200mm（共 +400mm），以门洞中心对称展开。
- 雨篷底面（u=0 一侧）紧贴墙体外表面，标高对齐门洞顶部（`doorTopZ = door.z0 + door.h`）。
- 无截面数据时回退为简单斜板（挑出 700mm、单侧下坠 50mm）。

## 5. 默认形状与默认数值总表

本节是「哪些构件用默认形状、哪些尺寸是代码写死的」的权威清单，**改建模逻辑或换项目时逐行核对**。

### 5.1 结构主体

| 构件 | 形状 | 尺寸来源（JSON） | 默认值 / 硬编码值 |
| --- | --- | --- | --- |
| 墙体 | 轴对齐 Box（开洞处被区间切割成多块 Box） | WallObject.Outline 的 AABB | 底标高：外墙 `L.base`，内墙 = 相邻房间最低楼面（找不到相邻房间回退 `L.base`）；顶标高一律 `L.roof`；厚度 = AABB 短边（JSON 无墙厚字段） |
| 结构柱 | Box | InsertionPoint 为中心，Length（X 向）、Width（Y 向） | 全高 `L.base → L.roof`；**不读旋转角**，柱截面恒按轴对齐摆放 |
| 水泵间底板 | Box | 建筑外轮廓 `wb`（墙体 AABB 并集） | 厚 200，`L.base − 200 → L.base`；平面范围 = `wb`，动态推导 |
| 南侧区块室内填板 | Box | 南侧房间轮廓并集 `sr`（楼面为 `L.south` 的房间） | `L.grade → L.south`（厚度由标高差决定）；外缘一侧若与建筑外轮廓相差 ≤ **400**（墙厚量级）则兜到外墙面，避免墙下漏空；无南侧房间时跳过并告警 |
| 检修平台楼板 | Box | MaintenancePlatformObject.Bounds | `L.grade → L.south`（厚度由标高差决定） |
| 钢梯平台板 | Box | SteelStairPlatformObject.Bounds | 板厚固定 40：`L.steel − 40 → L.steel` |
| 屋面板 | Box | RoofPolylineObject Kind=0 的 AABB | 板厚固定 150，顶面 = `L.roof` |
| 挑檐 | 截面沿外墙矩形路径环形扫掠（`WMEaves.build`） | `data/eaves-profile.json` 的 `profile[[u,v]]`；u = 水平外挑量，v = 相对屋面标高（向下为负） | 无截面文件时：有 Kind=3 → 用它做一块平板；Kind=3 也没有 → 屋面板四周各外扩 **500** |
| 雨水管 | 圆柱 | RoofRainPipeObject.Center、Diameter/2 | 从 `L.base` 到 `L.roof`，调用处径向分段 **10**（addCylinder 自身默认 12） |

### 5.2 门窗族（js/families.js）

**族的选择规则**（`pickFamily`）：

| 输入 | 选中族 |
| --- | --- |
| 门 Kind = 0 | door-double（双扇平开） |
| 门 Kind = 2 | door-bidir（双向单开：单开门 + 内侧加一只把手示意） |
| 门 其它 / Kind 缺失 | door-single（单扇平开） |
| 窗 Kind = 1 | win-fm（防火观察窗，与固定窗同构） |
| 窗 Width ≥ 1200 | win-2sash（双扇窗，含中挺） |
| 窗 Width < 1200 | win-fixed（固定窗 / 单扇） |

**族内固定尺寸**（单位 mm，全部硬编码，2D 大样到位后替换对应 builder 即可，调用接口不变）：

| 项 | 数值 |
| --- | --- |
| 框料宽 FRAME_W | 70 |
| 门扇厚 LEAF_T | 45 |
| 玻璃厚 GLASS_T | 8 |
| 单开门扇宽 | 洞口宽 − 2×70 − 10 |
| 双开门扇宽 | (洞口宽 − 2×70 − 12) / 2 |
| 门扇高度区间 | 6 → 洞口高 − 74（`h − FRAME_W − 4`） |
| 门扇沿墙厚方向 | 自 `−tw/2 + 8` 起算，占 45 厚（贴**室外**侧；`n` 正向指向室内） |
| 把手高度 | 950 → 1040（高 90）；单开把手距洞口边内退 `FRAME_W + 80` |
| 把手沿墙厚方向 | 室外侧把手 `−tw/2 + 55 → −tw/2 + 85`（贴门扇室内面）；door-bidir 的示意把手 `+tw/2 − 85 → +tw/2 − 55`（贴室内墙面） |
| 窗中挺 | 宽 50（±25）；沿墙厚方向 `−tw/2 + 8 → tw/2 − 8`；玻璃内退 4 |

**洞口实例参数**（white-model.js 的 buildModel 里补齐，供族 builder 使用）：
`tw` = 宿主墙 AABB 短边（视为墙厚）、`ax/ay` = 沿墙方向单位向量、
`nx/ny` = 墙体外法线，**朝向按洞口相对建筑外轮廓中心 `((wb.x0+wb.x1)/2, (wb.y0+wb.y1)/2)` 的位置判定**
（样例 3600, 7550，动态推导，不写死）。

**构件局部坐标（`addPiece` 的 u/v/n，族几何的唯一表达方式）**：

| 轴 | 含义 | 允许范围 |
| --- | --- | --- |
| u | 沿墙方向，0 = 洞口中心 | `±w/2`（框料正好到 ±w/2，不许越过洞口边） |
| v | 高度方向，0 = 洞口下沿 `op.z0` | `0 → op.h` |
| n | 墙厚方向，**正方向指向室内**（= 外法线反方向） | `−tw/2（室外墙面） → +tw/2（室内墙面）` |

**硬约束：门窗构件一律不许凸出墙面**——所有块体的 n 必须落在 `[−tw/2, +tw/2]` 内。
一旦越界，外观就是「窗框 / 门扇 / 把手悬在墙外」，且越界越多越像“框料横穿墙厚、沿墙宽度伸出一截”。
新增族或改族内尺寸后必须复核，不能只看正面截图。

**已知坑：左手基导致构件朝向退化（v0.2 引入、v0.3.0 修复）**

- 现象：西北 / 东北鸟瞰图上，窗的框料、玻璃、中挺变成一块块**横跨墙厚、宽度伸出墙面**的板；
  正面立面图反而看着“差不多”，只有鸟瞰和近景才明显。
- 根因：`addPiece` 里把 `U=(ax,0,ay)`、`V=(0,1,0)`、`N=(−nx,0,−ny)` 直接当基，
  其行列式 `det[U,V,N] = nx·ay − ny·ax`。**西墙（nx=−1）与北墙（ny=+1）上 det = −1，是左手基**；
  `Matrix4.makeBasis` + `Quaternion.setFromRotationMatrix` 遇到含反射的矩阵会走退化分支
  （trace 分支给出 w≈0 的四元数，实际退化成单位旋转），构件被摆成未旋转的姿态。
- 规避：**不要假设 U×V=N**。显式取 `Ux = V×N`（与 U 同轴）当局部 x 轴构造基，得到保证的右手基；
  盒体关于自身中心对称，轴向量整体取反不改变占用范围，构件仍落在规定区间内。
  同类问题在任何“把局部坐标搭到世界坐标”的地方都要注意（坡道、挑檐、雨篷的放样也各有一份自己的构造）。

**复核方法（改族几何 / 改朝向构造后必做）**：

```js
// 页面 Console（或 CDP 探针）：offenders 为 0 表示没有构件越出洞口范围
JSON.stringify(WMShot.familyCheck())   // → {"pieces":78,"offenders":0,"detail":[]}
```

`offenders > 0` 时 `detail` 列出越界块的洞口号、族名与实测 u/v/n 区间（最多 10 条），
按上面的允许范围逐项排查。样例的合格基线是 **78 块构件、0 越界**。
目视复核补充：西北 / 东北鸟瞰 + 西 / 北立面近景（这两侧正是左手基的墙），
看框料是否齐平贴墙、把手是否落在墙面之间。

### 5.3 附属构件

| 构件 | 形状 | 尺寸来源（JSON） | 默认值 / 硬编码值 |
| --- | --- | --- | --- |
| 雨篷 | 截面沿门洞顶放样（`addExtrudedCanopy`） | canopy-profile.json（u=0 贴墙，v=0 = 门洞顶标高） | 每个**外门**一组；宽度 = 门洞宽 + 400（两侧各 200）；无截面 → 斜板挑出 700、下坠 50 |
| 门口坡道 | 直角三角形楔块（**封闭三棱柱**，8 个三角形面） | 每个**外门**一组 | 长 1500；宽 = 门宽 + 200；贴地长边 = `L.grade`；贴墙短边高 = `L.south − L.grade`（当前 300）；`RampObject` 自身字段不用 |
| 建筑楼梯踏步 | Box 序列 | StairObject.InsertionPoint、FirstFlightStepCount、FirstFlightLength | 踏步高固定 **250**；级数缺省 **5**；踏面宽 = `FirstFlightLength / 级数`；梯段宽固定 1000（±500）；首级从 z=0 起，沿 +Y 排布；`SecondFlight*` / `IsSingleFlight` 不参与建模（只建第一跑） |
| 钢梯踏步 | Box 序列 | SteelStairObject.InsertionPoint | 固定 **3 级**；踏步高 300、进深 300；宽 800（±400）；起点 `(x, y − 450)`，沿 +Y 排布 |
| 钢爬梯 | 两根立柱 + 踏棍 | SteelLadderObject.InsertionPoint | 立柱截面 60×60、间距 600；总高固定 **3200**；踏棍自 200 起每 **300** 一根，截面 480×60×40；`FacingNormal` 未使用 |
| 设备基础 | Box | PumpFoundationObject.Bounds | 高固定 300（`L.base → L.base + 300`） |
| 集水坑 | 开口盒（四壁 + 底板，非布尔运算） | SumpPitObject.Bounds、ElevationMm | 壁厚 100、底板厚 100；顶 = `L.base`；底 = ElevationMm 换算为 `L.sump`；ElevationMm 缺失或非数值时回退 −1500 并在统计栏告警 |
| ~~地面 / 散水~~ | — | — | **已删除**（2026-09-24）：原回字形环带与新场地/道路重叠、混淆，用户要求删除；建筑周边场地与道路改由总平面图 DLSS 图层生成，见第 14 节 |
| 房间轮廓 / 房间名 | LineLoop + Sprite | RoomOutlineObject.Outline、RoomName | 轮廓线 z = 房间楼面 + 6；文字精灵 scale 1100；楼面 = 名称含「水泵间」→ `L.base`，否则 `L.south` |
| 检修平台标注 | LineLoop + Sprite | MaintenancePlatformObject.Bounds | 线 z = `L.south + 6`；文字「检修平台」scale 900 |
| 集水坑标注 | Sprite | SumpPitObject.Bounds 中心 | 文字「集水坑」scale 700，z = `L.base + 200` |

### 5.4 渲染与出图默认值

| 项 | 数值 |
| --- | --- |
| 相机 | PerspectiveCamera fov 45、near 10、far 600000；初始位置 (13000, 10000, 21500)，target (3600, 7550, 3000) ⚠ 硬编码（initThree 阶段还没有模型数据）；模型加载后视图预设按包围盒重新定位；OrbitControls `maxDistance = 260000` |
| 背景 | `0xe9e9e9`；`?bg=RRGGBB` 可覆盖；depth / normal 通道强制纯黑 |
| 光照 | HemisphereLight(0xffffff, 0xcfcfcf, 1.05) + DirectionalLight 1.25 @ (12000, 22000, 10000)，阴影贴图 2048²、正交阴影范围 ±16000 ⚠ 硬编码；**载入周边环境后改为 ±90000**（`setShadowExtent`，灯位不动：原点 ±90 m 已覆盖地形盒） |
| 渲染器 | PCFSoftShadowMap、sRGBEncoding、ACESFilmicToneMapping、exposure 1.05、pixelRatio ≤ 2 |
| 材质 | 墙 0xffffff / 板 0xf3f3f3 / 屋面 0xeeeeee / 柱 0xfafafa / 坡道 0xdedede / 玻璃 0xf2f2f2 透明 0.45；周边环境：地形 0x5c5c5c / 河床 0x444444 / 水面 0x38508c（roughness 0.15、透明 0.8、双面）/ 环境线 0x9a9a9a；道路 0x5a5a5a / 护坡 0x707070（两张面均 DoubleSide + `polygonOffset −1/−1`：它们与地形到处近共面，不加偏置远场会闪成"梳齿"带） |
| 线稿叠加 | `EdgesGeometry(geo, 30)`（二面角阈值 30°）黑色线；**分组名单 8 个**：walls / slabs / columns / roof / canopies / stairs / extra / families（新增实体分组必须同步该名单，否则新构件没有线稿）；默认隐藏，`?lines=1` 或勾选显示 |
| depth 通道 | 自定义线性着色 ShaderMaterial：`uNear = max(相机到目标距离 − 包围盒跨度, 1)`、`uFar = 距离 + 跨度 × 1.2`，近白远黑、背景纯黑；跨度取建筑包围盒，**载入周边环境后取「建筑 ∪ 地形盒」并集**（≈136 m，深度分辨率随之降到 ≈1.2 m/级，水面与河床的 1 m 落差已落到量化极限以下） |
| normal 通道 | MeshNormalMaterial（视野空间法线） |
| 视图预设 | 12 个：`iso-{ne,nw,se,sw}` / `elev-{s,n,w,e}` / `persp-1` / `persp-2` / `env-iso`（周边鸟瞰）/ `env-river`（河道视角），全部由 `state.bounds`（env 两个用 `state.envBounds`）推导，不依赖硬编码尺寸；env 两个需要先载入周边环境 |
| persp 视角 | 视高 = `L.grade + 1700`，看向 `L.grade + 2800`；自动加水平裁剪面 `y = L.grade − 10` 裁掉地坪以下的基础 / 集水坑（env 视角不加裁剪面） |
| 场景面板 | 固定 10 个 = 南/北/西/东立面 + 东北/西北/东南/西南鸟瞰 + 周边鸟瞰/河道视角（env 两个在未载入周边环境时置灰），不存储、实时由包围盒推算；自定义镜头存 `{name, pos, target, clip}`，写入 localStorage 键 `wm.scenes.v1:<DrawingName>`（按图纸独立一套），不可用时退化为会话内存；`clip=true` 时按当前 `L.grade − 10` 重算裁剪面 |

### 5.5 周边环境（js/environment.js）

默认值在 `js/environment.js` 的 `DEFAULT_PARAMS`，**`data/site-context.json` 的 `environment` 字段逐项覆盖**
（`resolveParams()` 只接受 `number` 且 `> 0` 的值，唯一例外是 `bedUnderMm` 允许 ≤ 0；生成器把本表整份写进数据文件，
所以改默认值要同时改 `DEFAULT_PARAMS` 与 `tools/dxf-site-context.mjs` 的 `ENVIRONMENT_PARAMS`，再重跑生成器 + 本节）。
几何生成算法与坐标约定见第 13 节。

| 参数 | 默认 | 含义 |
| --- | --- | --- |
| `marginMm` | 60000 | 地形范围：建筑墙体 AABB 每侧外扩 |
| `gridMm` | 1500 | 地形网格间距（当前样例实测：地形面 13920 三角 / 7284 顶点、河床面 1794 三角、水面 632 三角） |
| `platformSinkMm` | 500 | 平台面 = `L.grade − 500`。**平台范围 = `site-context.json` 的场地轮廓（DLSS）内部**（建筑外墙 AABB 挖空），整圈 pin 住不参与平滑；该值与 `roadThkMm` 一致，场地正好坐在平台上（第 14 节） |
| `idwPower` / `idwK` | 2 / 12 | 高程点插值（IDW）幂次 / 最近点个数 |
| `despikeMm` | 600 | 3×3 中值去刺阈值（实测把 1387 mm 的原始刺压到 280 mm） |
| `smoothIters` / `smoothLambda` | 8 / 0.45 | 受约束拉普拉斯平滑轮数 / 系数 |
| `slopeMax` / `slopeHardIters` | 1.0 / 20 | 硬坡度上限（1:1）与迭代轮数；当前样例实测最大坡 **0.417**（≈1:2.4），`slopeMax` 上限即自检阈值 |
| `slopeTarget` / `slopeSoftIters` | 0.2 / 12 | 目标坡 1:5（摊开场平到自然地面的落差）与迭代轮数 |
| `bankBlend` | 0.3 | 槽宽两侧各 30% 作为岸坡过渡带 |
| `endTaperMm` | 10000 | 河槽自由端收口渐变长度（避免端头断崖） |
| `bedMinDepthMm` | 800 | 河床材质分界：槽内低于插值地面超过该值才算河床 |
| `bedUnderMm` | 200 | 河床材质还要整格低于当地水位该值（把材质边界藏到水面之下）；**≤ 0 = 关闭该限制**，河床铺满整个开凿河槽（岸上会出现网格量化的阶梯色块，见第 13 节假设 3） |
| `waterDepthMm` | 1000 | 水深：水面 = 河床最低点 + 该值（数据文件可调） |
| `waterClampMm` | 200 | 水面不得高于较低岸顶 − 该值（本例 16 个断面受此限制） |
| `waterSmoothIters` | 6 | 水位沿程平滑轮数（去掉逐站取 min 造成的台阶） |
| `skirtMm` | 3000 | 地块四周裙边高度 |
| `corridorStationMm` / `corridorSampleMm` | 2000 / 500 | 河槽断面间距 / 断面采样间距（后者同时是水面条带的纵向细分步长） |

**为什么环境材质用深灰**：当前光照（Hemisphere 1.05 + Directional 1.25）+ ACESFilmic（exposure 1.05）+ sRGB 下，
入射面亮度是压缩的——实测 albedo 0/32/64/128/255 分别渲染成 14/161/203/229/243（8 位灰度），
**albedo ≳ 0.4 一律糊成近白**。因此地形/河床/水面必须用 0x5c5c5c / 0x444444 / 0x38508c 级别的深色，
换成浅灰就会和建筑白模分不开。

### 5.6 道路 / 护坡（js/siteworks.js）

默认值在 `js/siteworks.js` 的 `DEFAULT_PARAMS`，**`data/site-context.json` 的 `siteWorks` 字段逐项覆盖**
（`resolveParams()` 只接受 `number` 且 `> 0` 的值）。生成器把本表整份写进数据文件，
所以改默认值要同时改 `DEFAULT_PARAMS` 与 `tools/dxf-site-context.mjs` 的 `SITEWORKS_PARAMS`，再重跑生成器 + 本节。
几何规则与验收见第 14 节。

| 参数 | 默认 | 含义 |
| --- | --- | --- |
| `roadThkMm` | 500 | **DLSS 面（场地轮廓内 + 道路）的厚度** —— 整块面只出一块实体，只能有一个厚度 |
| `siteThkMm` | 500 | 仅作护坡在无地形数据时的兜底标高参考（`L.grade − siteThkMm`），与 `roadThkMm` 保持一致 |
| `slopeThkMm` | 500 | 护坡实体厚度下限（底面埋入地形不足时自动加厚，见第 14 节） |
| `roadLiftMm` | 50 | 道路顶面高出自然地形的量（不抬会与地形面共面闪烁） |
| `roadBlendMm` | 5000 | 道路在靠场地轮廓该距离内过渡到室外地坪（`smoothstep`），保证边界处无台阶 |
| `groundClearMm` | 50 | 底面至少埋入自然地形的深度（道路 / 护坡共用） |
| `triMaxMm` / `triMaxRounds` | 2000 / 7 | 顶面三角细分目标边长 / 细分轮数上限（长边中点细分，公共边不裂） |
| `wallInsetMm` | 50 | 挖空（建筑外墙 AABB）向内收的量：让实体伸进墙体内部，避免与墙面共面闪烁 |

## 6. 已解析但当前未建模的字段

| 字段 | 来源 | 状态 |
| --- | --- | --- |
| `data.ramps` | RampObject | 已解析，未建模；坡道改由外门自动生成（第 10 节） |
| `data.apron` | ApronObject.InnerOutline / OuterOutline | 已解析，未建模；原「地面 / 散水」实体已删除，场地改由总平面图 DLSS 生成（第 9、14 节） |
| `data.texts` | PlanMultilineTextObject | 已解析，未绘制；页面只显示 RoomOutlineObject 的房间名 |
| `data.roofCanopies` | RoofPolylineObject Kind = 4 | 已解析，未建模；雨篷改由外门自动生成（5.3） |
| `data.counts` | 所有图元计数 | 仅统计，不参与建模 |
| terrain（`data/terrain.obj` + `data/terrain-registration.json`） | `js/terrain.js` | 解析与双控制点配准（平移+旋转+等比缩放）已实现，但 **buildModel 尚未接入**，当前样例不渲染地形（地形改由总平面图高程点插值生成，见第 13 节） |
| site-context（`data/site-context.json`） | `tools/dxf-site-context.mjs` 从总平面图 DXF 提取 | 对位变换、578 个高程点、进水池、河道岸线、陡坎与注记均已解析成坐标数据；**v2 起 `js/environment.js` 已接入**，面板「载入周边环境（默认数据）」生成地形面 / 河床面 / 水面；**v3 起 `js/siteworks.js` 已接入**，同一次载入还生成道路 / 护坡（见第 12、13、14 节） |

## 7. 标高读取规则

- 读到 PlanElevationAnnotationObject 时按 **Kind 做索引**：`data.elev[Kind] = ElevationMm`（同类取首个）。
- buildLevels() 的映射（绝对标高 mm → 相对 Z=0 的本地高度），括号内为**字段缺失时的默认绝对标高**：

| 索引 | 绝对标高 | 本地 Z | 含义 |
| --- | --- | --- | --- |
| elev[0]（缺省 166759） | 166759 | 0 | 基准：水泵间地面 |
| elev[1]（缺省 169200） | 169200 | +2441 | 配电间 / 控制间 / 检修平台楼面 |
| elev[3]（缺省 168900） | 168900 | +2141 | 室外地坪 |
| elev[4]（缺省 173800） | 173800 | +7041 | 屋面 |
| elev[5]（缺省 167659） | 167659 | +900 | 钢梯平台 |
| SumpPitObject.ElevationMm | 165259 | −1500 | 集水坑底（缺失 / 非数值时回退 −1500 并告警） |

⚠ 索引来自 `Kind` 枚举而非数组顺序；换项目前要对照 JSON 说明文档核对 Kind 含义。

## 8. 墙体开洞（不使用布尔运算）

- 把墙视为轴对齐矩形，判断长边方向（`dy >= dx` 则沿 Y）。
- 洞口在墙上的位置区间 = 中心 ± Width/2；再叠加高度区间 [z0, z1]。
- carveWall() 用区间切割把墙拆成若干方块（左/右/上/下四块），洞口不生成实体。
- 洞口归属墙面用 `openingIntervalOnWall()` 判定：洞口中心需落在墙 AABB 内（容差 5 mm），返回 null 表示该墙不承载此洞口。
- 门洞底标高由 `floorAt(L, platform, ySplit, x, y)` 推断：检修平台范围内（容差 150 mm）或 `y < ySplit` 视为 +2441 楼面，否则水泵间地面 0。
  `ySplit` = 南侧房间轮廓的外缘（`sr.y1`，样例 4800），动态推导；无南侧房间时取 `wb.y0`（即不用 +2441 楼面）。
- 窗洞底标高统一 = 配电/控制间结构标高（`L.south`）+ **900 mm**，不随窗户所在楼面变化。

## 9. 道路与周边场地（原「地面 / 散水」已删除）

- 2026-09-24 起**不再生成**原「地面 / 散水」回字形环带（用户要求删除：它与按总平面图 DLSS 图层生成的
  场地/道路重叠、混淆）；`ApronObject` 的 InnerOutline / OuterOutline 依旧不直接使用。
- 2026-09-25 起**不再生成**「场地（室外场地）」实体（用户要求删除：它与道路是同一条 CAD 线上的两条
  描线，分材质岛后交界处会闪出棋盘格斜纹带）。建筑周边的地面由 DLSS 面的建筑范围部分承担，顶面同
  `L.grade`，几何规则见第 14 节。
- 道路 / 护坡由总平面图图层 `DLSS` / `DLSS-斜坡` 生成，几何规则见第 14 节，参数见 5.6。

## 10. 门口坡道

- 不为 `RampObject` 单独建模，改由**外门**（`IsExterior && 已定位`）自动生成，随门窗一起移动。
- 截面为**直角三角形**楔块：水平长直角边（1500 mm）贴室外地坪（`L.grade`），
  竖直短直角边贴墙外表面（高 `L.south - L.grade` = 300 mm），斜边为行走面，坡端收成薄边。
- 宽度 = 门洞宽 + 两侧各 100 mm；居中于门洞，沿墙外法线方向从墙外表面向外伸出。
- 由 `addRampWedge()` 生成**封闭三棱柱实体**：底面 2 个三角形 + 贴墙竖面 2 个三角形 + 斜面 2 个三角形
  + **两端三角端面各 1 个**，共 8 个三角形；绕序按“法线朝外”以形心为基准统一修正，
  保证 depth / normal 通道（FrontSide 覆盖材质）下不出现空洞。

## 11. 去重规则

同一构件在多个图框重复出现时按 key 去重：

| 构件 | key | 说明 |
| --- | --- | --- |
| 墙 | 轮廓 AABB 取整（0.1 mm） | 去重后还做一次**包含去重**：按面积从大到小排序，被已有大墙完全包含（±1 mm）的小墙丢弃 |
| 柱 | x, y, Length, Width | |
| 钢梯 | x, y | |
| 设备基础 | Bounds.Min.x, Bounds.Min.y | |
| 钢梯平台 / 爬梯 / 集水坑 / 检修平台 / 楼梯 / 地面轮廓 | — | 单例，取首个（楼梯取最后一个） |

## 12. 场地环境数据（总平面图对位）

来源图纸 `Flie/输入文件/菖蒲垇项目/总平面图.dxf`（**UTF-8** 编码，与其它 GBK 图纸不同），
由 `white-model-viewer/tools/dxf-site-context.mjs` 解析后输出 `white-model-viewer/data/site-context.json`
（**版本 3**，含全部原始点坐标，约 94 KB），并自动把紧凑格式的同一份 JSON 写回 index.html 的
`<script type="application/json" id="siteContextData">`（file:// 下 fetch / 同步 XHR 会被浏览器拦截，
内嵌副本才是双击可用的路径，约 56 KB）。v2 起由 `js/environment.js` 消费，生成地形 / 河床 / 水面（第 13 节）；
**v3 起新增 `site` / `roads` / `slopes` / `siteWorks` 四段**，由 `js/siteworks.js` 生成道路 / 护坡（第 14 节）。

### 12.1 图层 / 图块约定（图纸方给定）

| 图层 / 图块 | 含义 | 读取字段 |
| --- | --- | --- |
| `WALL_OUT` **较大**矩形 | 建筑外墙轮廓线，用于模型对位 | LWPOLYLINE 顶点 |
| `WALL_OUT` **较小**矩形 | 进水池位置 | LWPOLYLINE 顶点 |
| `SXSS` | 河道岸线（成对出现 = 左右岸；**一条岸可拆成多段折线首尾相接**，生成器按端点 0.5 m 容差自动拼成整条，闭合折线不参与拼接） | LWPOLYLINE / LINE 顶点 |
| `DLSS` | 场地 + 道路轮廓（已由用户修剪成闭合图形）：整环 = 道路外轮廓，其中**含建筑的那一圈** = 场地 | LWPOLYLINE 顶点（多段，需按端点拼接 / 判定包含建筑） |
| `DLSS-斜坡` | 场地 → 河床的护坡范围（多段线首尾相接成环；**生成时取首尾连线为坡顶线**，落在场地西边界上、按场地标高，其余为坡底外边界） | LWPOLYLINE 顶点 |
| 块 `gc200`（图层 `GCD`） | 高程点 | ATTRIB `height` = 高程值，**单位 m** |
| `DMTZ` | 陡坎（斜坡）线 | 折线顶点 |
| `ZJ` / `YHG_文字` / `DIM_*` | 河道名（麻桑河）、设计注记、尺寸与标高标注 | TEXT 内容 + 位置 |
| `zdh` | 控制点（拟建提罐站检查点 1/2） | POINT 位置 |

> **关于方位**：图纸没有画指北针。`X=东 / Y=北` 是从坐标量级推断的（X ≈ 574.35 km 只能作东向 easting，
> Y ≈ 2880.46 km 只能作北向 northing），不是图纸标注。对位变换只用两套坐标系之间的**相对关系**，
> 不依赖真北方位；建筑长轴（模型 +Y）与图纸北向相差 3.2962°（偏西）。
> 对应关系为**同名轴一一对应、不做镜像**，判据：总平面图 −X 一侧是进水池 / 河道，与模型里取水构筑物在 −X 一致。

### 12.2 对位变换（相似变换：平移 + 旋转 + 等比缩放 ×1000）

- **缩放 1000**：总平面图单位 m → 模型 mm。
- **旋转 θ = 3.29622°**：由建筑外墙轮廓线的四条边长方向角得到（角度先折叠到 `[0, 90)` 再取平均，
  避免 180° 歧义）。总平面图 → 模型为 **R(−3.2962°)**。
- **锚点**：旋转后 `(x + y)` 最小的建筑矩形角点（= 图纸上的西南角）
  `site (574350.811, 2880461.595) m` ↔ `model (0, 0)`，即模型墙体 AABB 原点。

| 方向 | 公式 |
| --- | --- |
| 总平面图 → 模型 | `p_model = R(−3.2962°) · (p_site − anchorSiteM) × 1000` |
| 模型 → 总平面图 | `p_site = anchorSiteM + R(+3.2962°) · (p_model / 1000)` |

- **高程换算**：`zAbsMm = 高程(m) × 1000`，`zModelMm = zAbsMm − 166759`（与第 7 节的 Z=0 基准一致）。
- **精度自检**：变换往返误差 0.000000 mm；拟合残差 `fitResidualMm` 5.19 mm；建筑轮廓线在模型坐标系内
  轴对齐误差 ≤ 3.6 mm（图纸本身的量取误差）。尺寸链交叉校核：进水池靠建筑一侧的边 → 建筑西外墙面
  = 10000.5 mm（图纸标注 10000）、池宽 2800.5 mm（标注 2800）。

### 12.3 JSON 结构

| 段 | 内容 |
| --- | --- |
| `source` | 源 DXF 路径、字节数、修改时间、生成器脚本 |
| `units` | 两套坐标系的单位与轴定义、Z 基准、方位说明（`orientationNote`：图纸无指北针，方位为推断） |
| `alignment` | 变换类型、rotationDeg、锚点（两种坐标系）、两个方向的公式字符串 |
| `building` | 建筑外墙轮廓线（`outlineSiteM` / `outlineModelMm`）、尺寸、四边边长、残差、模型轴线网格 |
| `consistency` | 与**当前模型**的差异自检（见 12.4） |
| `elevationPoints` | 578 个高程点，`pointFields = [xSiteM, ySiteM, elevationM, xModelMm, yModelMm, zAbsMm, zModelMm]`，高程区间 163.05 – 175.47 m |
| `intakePool` | 进水池轮廓（两种坐标）、包围盒、尺寸、与建筑三边的净距 |
| `riverChannel` | 河道名称（麻桑河）、`mainChannel`（主河槽 = 岸线 id 1 靠进水池一侧 + id 2 对岸，水面只在这两条之间生成）；2 条岸线（各由 2 段 SXSS 折线端点拼接：旧岸线 + 补画的北西延伸段，`segments` 字段记段数，岸线方向统一南→北、按链长排序取前两条为主河槽） |
| `environment` | v2 新增：周边环境生成参数（第 5.5 节的覆盖值；缺项用 `DEFAULT_PARAMS`），查看器用 `resolveParams(environment)` 合并（只接受 `number` 且 `> 0`，`bedUnderMm` 例外允许 ≤ 0） |
| `siteWorks` | v3 新增：道路 / 护坡生成参数（第 5.6 节的覆盖值；规则同上）+ `note` 说明字符串（第 14 节） |
| `site` | v3 新增：场地轮廓 = DLSS 图层里含建筑的那一圈（`layer` / `sourcePolylineId` / `vertexCount` / `areaM2` / `closureMm` / `closureNote`，两种坐标系各一份点表；闭合段是路口封口线，图纸未勾闭合标志）。**只作顶面高程分界与「建筑范围」判据，不出实体**（第 14.2 节） |
| `roads` | v3 新增：DLSS 整环（`memberIds`（6 段）/ `outerAreaM2` 1317.0 / `areaM2` 821.0（整环 − 场地，仅作参考）/ `selfIntersections` 0 / `note`）；查看器按整环出一块实体，不再按这个分界拆材质岛 |
| `slopes` | v3 新增：护坡环数组（DLSS-斜坡），每项 `id` / `vertexCount` / `areaM2` / `topEdgeToSiteOutlineMm` / `topEdgeNote` |
| `context` | `scarps`（DMTZ 陡坎 3 条）、`pipes`（出水主管 1 条）、`controlPoints`（2 个）、`texts`（40 条注记，含模型坐标） |

### 12.4 与当前模型的不一致（重要）

`consistency` 段是自动比对结果，当前样例（总平面图 2026-09-24 版 vs 页面内嵌 JSON 2026-08-31 版）：

| 项 | 数值 | 说明 |
| --- | --- | --- |
| 宽 | 总平面图 7005.4 vs 模型 7200 mm | 差 194.6 mm，量级属图纸差异 |
| 长 | 总平面图 17902.6 vs 模型 15100 mm | **差 2802.6 mm**，与 2026-09-22 立面图轴线总长 17700 一致 |
| 进水池北边缘 | 超出当前模型北端 **1749.4 mm** | 直接后果：按旧模型建场地会把水池切掉一截 |

旧的 `IntakeForebayObject` / `IntakeChannelSlopeObject` 位置同样与新图不符（旧 JSON 中取水构筑物在
X −14100…−7613，新图进水池在 X −12801…−10001）。

**结论：对位变换只依赖总平面图，模型按新图重新导出 JSON 后本文件坐标无需修改**；
在重新导出前，不要把 `site-context.json` 的开发环境几何与当前模型混用。

### 12.5 工具与校验图

```powershell
Set-Location white-model-viewer
node tools/dxf-site-context.mjs                       # 重新解析 DXF → data/site-context.json（会打印一致性问题）
node tools/site-context-plot.mjs                      # 生成对位校验图 HTML（默认输出到系统临时目录）
node tools/cdp-shot.mjs "file:///<临时目录>/site-context-check.html" site-context.png 6
```

校验图（模型坐标系，mm）画出了：建筑外墙轮廓线（红）、模型墙体 AABB（橙虚线）、进水池（青）、
SXSS 岸线（蓝）、DMTZ 陡坎（品红）、旧 JSON 取水构筑物（黄虚线）、578 个高程点、注记文字、
角点坐标标签与长度差尺寸线；右下角小图为河道全貌。判读要点：**Y = 0 基准线应同时穿过总平面图
轮廓线的南边与模型 AABB 的南边**，红色与橙色虚线在 X 方向基本重合、仅在 Y 方向差出 2803 mm。

## 13. 周边环境渲染（地形面 / 河床面 / 水面）

`js/environment.js`（`WMEnv`，纯数学部分不依赖 THREE，可在 Node 里直接跑数值自检）
把 `data/site-context.json`（v3）变成三张面 + 环境线，由 `white-model.js` 的 `buildEnv()` 挂材质建组。
**只在查看器里渲染，不导出网格**，沿用 color / depth / normal 三通道出图。

### 13.1 输入

| 字段 | 用途 |
| --- | --- |
| `elevationPoints.points` | 578 个高程点 `[xSiteM, ySiteM, elevM, xModelMm, yModelMm, zAbsMm, zModelMm]`，只用后三列 |
| `riverChannel.banks[]` | 岸线折线（`id` / `outlineModelMm`）；**主河槽 = `mainChannel.bankIds`（本例 1 + 2）**，槽宽 26.3 – 39.1 m。每条主岸由图纸上多段首尾相接的 SXSS 折线拼接而成（生成器按端点 0.5 m 容差自动拼，`segments` 记段数），本例岸线沿北西延伸段穿出地形盒 |
| `intakePool` | 进水池轮廓，只画线 |
| `context.scarps / pipes / texts` | 陡坎 / 管道 / 注记，只画线或不画 |
| `environment` | 第 5.5 节的参数 |
| `level.grade`、`wallAabb` | 由调用方传入：室外地坪标高、墙体 AABB（平台面与挖空范围都从它推） |

### 13.2 算法（按执行顺序）

1. **河槽骨架** `corridorFrame()`：沿岸线 A 取站、对每站求到岸线 B 的最近点 → 中心线点对 + 槽宽，
   按 `corridorStationMm`（2 m）重采样；`infoIn(x,y)` 用「投影到最近断面」判定 `inside` 与横向参数 `lat`
   （0 = 岸 A，1 = 岸 B），并给出自由端收口系数 `taper`。不做多边形求交，越界靠后续裁剪。
2. **分类高程点**：先丢掉地形盒外的点（578 → 304），盒内再按 `infoIn().inside` 分成槽内（本例 35）与槽外（269）。
   全部 578 个点按槽内 / 槽外分是 123 / 455，但只有盒内点参与插值（`stats.corridor.inCorridorPts / outPts` 报的是盒内数）。
3. **两套高程场**：槽外 IDW → `fLand`，槽内 IDW → `fBed`。**槽内底面 = `lerp(fLand, min(fBed, fLand), w(lat))`**，
   `w` 在内侧 70% 为 1、两条岸线处为 0（`bankBlend` 过渡）——取 `min` 保证河道永远低于两侧地面
   （槽内偶发的高程点不会冒出「假土包」），两端与地面无缝衔接，天然形成岸坡。
4. **平台与挖空**：**场地轮廓内部** = 平台面 `L.grade − platformSinkMm`（500 mm，正好是 DLSS 面底面），
   **整圈 pin 住**，后续平滑 / 坡度约束不得改动；**墙体 AABB 内的顶点标记为空洞**（不出面），
   否则 168600 的平台面会把 Z=0 的水泵间埋掉。平台范围 = 场地轮廓（第 14 节），
   不再外扩 `platformOffsetMm`（该参数已删除，随原「地面 / 散水」一起作废）。
5. **去刺 + 平滑 + 坡度约束**（跳过 pin 与空洞）：3×3 中值去刺（阈值 `despikeMm`）→ 受约束拉普拉斯
   （`smoothIters` / `smoothLambda`，坡度大处减小 λ 以保坡）→ 软坡度（超 `slopeTarget` 按 0.5 权重拉近，
   `slopeSoftIters` 轮）→ 硬坡度（超 `slopeMax` 取两端均值，`slopeHardIters` 轮）。
   ⚠ **网格分辨率与平滑尺度耦合**：拉普拉斯的作用长度 ∝ `gridMm·√iters`，加密网格反而更不平滑——
   实测 `slopeMax` 在 gridMm 1500 / 1000 / 750 / 500 下为 0.659 / 0.96 / 1.0 / 1.075（旧平台口径实测，
   现平台缩小到场地轮廓内部后为 0.417），所以本轮**否掉了网格加密**，保持 1.5 m。
6. **水位**：每站 `wl = min(槽内最低点 + waterDepthMm, 较低岸顶 − waterClampMm)`，再沿程平滑
   （`waterSmoothIters`，去掉逐站取 min 的台阶）；本例 80 个有水断面（18 个受岸顶限制，2 个跳过，走廊共 170 站）。
7. **水面**：用**最终网格表面** `sampleSurface()` 在每个断面上找 `surface < wl` 的两次穿越 → 岸线交点；
   水位低于整个断面则不生成该站水面。相邻两站（站序必须真的相邻）之间连成四边形，并按
   `corridorSampleMm`（0.5 m）**纵向细分**：单个四边形把岸线拉成了米级锯齿（实测二阶差分 ≈1 m），
   细分后再按「两站插值出的断面」重求交点，岸线误差降到 ≈0.1 m。水面比水位抬 **20 mm**（`waterLift`），
   交点在网格面上，抬升避免共面闪烁。断面先按地形盒裁剪，否则水面会伸出地块悬空。
8. **河床面**：与地形面**共用同一套顶点坐标**、按格子分材质（`info inside && 低于两侧地面 bedMinDepthMm
   && 整格低于当地水位 bedUnderMm`），边界无缝隙、不重叠、无 z-fighting，只在材质上区分（本例 1794 三角）。
   `bedUnderMm` 的作用见假设 3。
9. **环境线**（`envLines`）：地形盒四周、建筑外墙 AABB 矩形、进水池矩形、各条 SXSS 岸线（盒内裁切），
   全部按 `sampleSurface()` 抬 20 mm 贴地（`lineLift`，本例 4 段）。⚠ 场平（平台）轮廓线**不在这里画**：
   那里已被 DLSS 面盖住，DLSS 外环与护坡环的顶面轮廓由 `js/siteworks.js` 出线（第 14.3 节）。
10. **裙边**：地形盒四周沿边向下 `skirtMm`（3 m）的竖直面，避免低视角看到面的背面 / 悬空。

### 13.3 验收与自检

```powershell
Set-Location white-model-viewer
node --check js/environment.js
node tools/dxf-site-context.mjs                       # 重生成 v3 数据 + 同步 index.html 内嵌副本
node tools/cdp-shot.mjs "file:///.../index.html?env=1&annot=0" "$env:TEMP/wm-env.png" 8
node tools/cdp-shot.mjs "file:///.../index.html?env=1&annot=0" "$env:TEMP/wm-env-batch" --views=all --channels=color,depth,normal
```

页面 Console 跑 `JSON.stringify(WMShot.envCheck())`，当前基线（`data/site-context.json` v3）：

| 指标 | 基线 | 要求 |
| --- | --- | --- |
| `nanCount` | 0 | 0（不出现 NaN 几何） |
| `slopeMax` | 0.417 | ≤ 1.0（1:1） |
| `spikeMaxMm` / `spikeRawMm` | 280 / 1387 | ≤ 600（去刺后的剩余起伏） |
| `platform.devMaxMm` | 0 | 0（平台严格 = `L.grade − 500`，范围 = 场地轮廓内部） |
| `hole.count` | 40 顶点 | 建筑范围挖空 |
| `water.aboveLandCount` | 0 | 0（水面不越岸） |
| `water.gapMinMm ~ gapMaxMm` | 1 ~ 1166 | 未受 clamp 处 ≈ `waterDepthMm` |
| `water.maxStepMm` | 190 | 相邻站水位差不出现台阶 |
| `counts` | 地形 13920 / 河床 1794 / 水面 632 / 裙边 704（三角），环境线 4 段 | 均 > 0 |
| 建筑基线不回归 | 图框 3、墙体 6、门 5、窗 7、柱 8、楼梯 4；`familyCheck().offenders = 0`（78 块） | 不变 |

### 13.4 假设与已知问题

1. **主河槽两条岸线各由 2 段 SXSS 折线端点拼接**（用户 2026-09-24 补画的北西延伸段接在旧岸线端点，
   容差 0.5 m）；延伸段沿西北方向穿出地形盒，**河道在盒边自然截断、两端不再收口**（`taperStart/End = false`）。
   其余 SXSS 折线为渠道 / 护坡岸线，只画线不做水面；若它们需要出水面，改 `riverChannel.mainChannel.bankIds` 即可。
2. **进水池不单独做坑底**：其足迹基本落在主河槽内、池内 3 个高程点与河床同量级，只画轮廓线；
   要按结构建模应在建筑 JSON 侧处理。
3. **河床 / 地形的材质边界是网格量化的**（材质按格子分配，1.5 m 网格 → 边界呈 1.5 m 阶梯）：
   边界若露在岸上，肉眼就是一圈「梯田」色块（实测过 `bedUnderMm ≤ 0` 的版本）。
   现默认 `bedUnderMm = 200`，边界藏在水面之下，可见岸线只由水面条带定义；
   代价是河床材质只覆盖水下部分（在 color 通道里表现为水色的深浅变化，dry 河段是地形色）。
4. **平台面取 `L.grade − 500`**：与 DLSS 面底面（`roadThkMm`）齐平；但总平面图东南侧「地面硬化」高程点
   169.5 – 169.8 m 比平台高 0.9 – 1.2 m，场地外缘会出现缓坡台阶（两份图纸版本不一致所致，
   重导 JSON 后自然消失）。
5. **两侧数据来自不同版本**：总平面图（2026-09-24）与内嵌模型 JSON（2026-08-31）长边差 2802.6 mm，
   地形按总平面图生成、建筑按模型生成，见 12.4。**不要**在重新导出模型前把两者当作同一版设计使用。
6. **depth 通道在 env 下分辨率下降**：跨度按「建筑 ∪ 地形盒」取（≈136 m），约 1.2 m/级，
   水面与河床的 1 m 落差已在量化极限附近；normal 通道里水面是法线朝上的平面，靠色差也不易分辨。
   要靠色差区分水面请用 color 通道。

## 14. 道路 / 护坡（总平面图 DLSS、DLSS-斜坡）

代码：`white-model-viewer/js/siteworks.js`（`WMSite.build()` / `WMSite.siteCheck()`，IIFE 挂 `window.WMSite`，
Node 侧可 require 跑数值自检）。参数见 5.6，数据见第 12 节，材质与分组见 5.4。

### 14.1 输入范围

| 对象 | 来源图层 | 形态 | 当前样例 |
| --- | --- | --- | --- |
| 场地轮廓 | `DLSS`（含建筑的那一圈） | 闭合圈（含路口封口段）。**只作为顶面高程的分界与「建筑范围」的判据，不出实体** | 8 顶点 / 495.9 m² / 封口段 3662.2 mm |
| 道路（DLSS 面） | `DLSS` 整环 | 6 段端点拼接 | 整环 85 顶点 1317.0 m²，自交 0；**浏览器侧还要按地形盒裁掉西南向伸出的走廊**，裁剪后 DLSS 面网格面积 ≈ 920.6 m²（与 1317.0 不可直接比） |
| 护坡 | `DLSS-斜坡` | 开口折线（首尾连线 = 坡顶线） | 9 顶点 / 187.8 m² / 坡顶线离场地轮廓 0.0 mm |

### 14.2 DLSS 面只出一块实体（重要）

- 场地轮廓的 8 条边（88.7 m）**全部贴在 DLSS 整环折线上**（逐段距离 0 – 1.5 mm）——两者是同一条
  CAD 线上的两条描线，不是两块实体。
- **曾经把这块面按三角形重心 `pointInRing(site)` 拆成「场地」「道路」两个材质岛**（各建一块实体时交界处
  必然出现两片位置重合的立侧面：实测道路 35 片 67.2 m 压在场地轮廓上、场地 4 片 65.5 m 压在道路外环上，
  深度值相等 → 逐像素抢深度 → 人视图里闪成一条**棋盘格斜纹带**）。分岛后虽然没有了重复面，但分界按
  三角形重心判定，在场地轮廓上留下一条**锯齿状的明暗斜带**（跨分界三角形各归一侧），人视图里仍表现为
  棋盘格斜纹带。
- 2026-09-25 按用户要求**删除「场地（室外场地）」实体**：整块 DLSS 面只做一趟三角化、只出一个材质岛
  （道路），场地轮廓仅参与高程规则。外轮廓 = DLSS 整环（先按地形盒裁剪），洞 = 建筑外墙 AABB
  （内收 `wallInsetMm`；**不把场地轮廓当洞**，否则 earcut 会在两者之间的窄颈里切出上千个细长退化
  三角形）。交界处不再有材质分界，斜带随之消失。
- 建筑范围内（场地轮廓内）的地面仍由这块面承担，顶面严格齐平 `L.grade`（`flatDevMm` = 0），
  所以删掉场地实体后建筑周边**不会露出地形平台**（平台在该面之下 500 mm）。

### 14.3 高程规则

| 范围 | 顶面 | 底面 |
| --- | --- | --- |
| 场地轮廓内（建筑周边） | `L.grade`（平的） | 顶面 − `roadThkMm`（名义底面 = 地形平台面 `L.grade − platformSinkMm`，`platformGapMm` = 0；实际底面还额外埋入 `groundClearMm`） |
| 场地轮廓外（道路） | `lerp(L.grade, 自然地面, w) + roadLiftMm × w`，`w = smoothstep(d / roadBlendMm)`，`d` = 到场地轮廓的距离 | `min(顶面 − roadThkMm, 自然地面 − groundClearMm)` |
| 护坡 | `lerp(L.grade, 坡底标高, t)`，`t` = 到坡顶线距离 ÷（到坡顶线距离 + 到坡底外边界距离）；无地形数据时坡底取 `L.grade − siteThkMm` | `min(顶面 − slopeThkMm, 自然地面 − groundClearMm)`（顶面离地时自动加厚，不悬空） |

- 在场地轮廓上 `d = 0` → `w = 0` → 道路顶面正好 = `L.grade`，与建筑周边同值：**边界处既没有台阶也没有共面**
  （本来就是同一块面）。自检指标 `roadSeamDevMm` = 0。
- 场地范围内**不能**沿用「跟随地形」的规则：地形平台只覆盖场地轮廓内部，靠边一圈的地形网格点落在轮廓外、
  插值回自然地面（可能高于室外地坪），照它抬会让路面钻到室外地坪之上。
- 顶面轮廓线：DLSS 外环与护坡环各画一条折线（抬 `LINE_LIFT = 20 mm`），并入「环境线」分组（同一根线控开关）。

### 14.4 与其它构件的关系

- **与地形**：DLSS 面名义底面与地形平台齐平（`platformGapMm` = 0，两边同深 500 mm）；道路顶面抬 `roadLiftMm`（50 mm）避免与地形面共面闪烁；
  护坡底面至少埋入 `groundClearMm`。
- **与建筑**：挖空 = 建筑外墙 AABB 内收 `wallInsetMm`（与地形平台的挖空一致），避免与墙面共面闪烁；
  洞边不生成立侧面（洞由建筑填满，两面共面会闪成花带）。
- **与河床 / 水面**：护坡坡底外边界贴地形/河床面（第 13 节）。

### 14.5 验收与自检

```powershell
Set-Location white-model-viewer
node --check js/siteworks.js
node tools/dxf-site-context.mjs                        # 重生成 v3 数据 + 同步 index.html 内嵌副本
node tools/cdp-shot.mjs "file:///.../index.html?env=1&annot=0" "$env:TEMP/wm-site.png" 8
node tools/cdp-shot.mjs "file:///.../index.html?env=1&annot=0" "$env:TEMP/wm-site-batch" --views=all --channels=color,depth,normal
```

页面 Console 跑 `JSON.stringify(WMShot.siteCheck())`，当前基线（`data/site-context.json` v3 + 内嵌模型的墙体 AABB）：

| 指标 | 基线 | 要求 |
| --- | --- | --- |
| `ok` | true（`issues` 空） | 无 issue |
| `flatDevMm` | 0 | 场地轮廓内（建筑周边）顶面严格 = `L.grade` |
| `roadSeamDevMm` | 0 | ≤ 1（场地轮廓上顶面与 `L.grade` 无错台） |
| `roadGapMaxMm` | 0 | ≤ 1（底面没有离开地形悬空） |
| `roadRaiseMm` | 50 ~ 953 | 下限 ≥ −1（道路没埋进自然地面） |
| `slopeThkMinMm` | 500 | ≥ `slopeThkMm` − 1 |
| `roadTopDown` / `slopeTopDown` | 0 / 0 | 顶面没有朝下的三角形（绕序自检） |
| `platformGapMm` | 0 | DLSS 面名义底面与地形平台齐平 |
| 计数（浏览器侧） | DLSS 面 18760 三角（10152 顶点）/ 护坡 1352 三角（830 顶点） | 与页面日志一致 |

### 14.6 假设与已知问题

1. 场地轮廓的封口段是图纸未勾闭合标志、由工具补出来的**路口封口线**（3662.2 mm）；其正确性由
   「DLSS 整环 = 6 段拼接、自交 0、`roadSeamDevMm` = 0」间接确认。
2. 顶面高程在场地轮廓上的过渡带（`roadBlendMm` = 5 m）内连续变化，`roadSeamDevMm` = 0，无台阶。
3. 材质只剩 `M.road`（0x5a5a5a）与 `M.slope`（0x707070）两张面 + 环境线（`M.site` 0x808080 已随场地实体删除）。
4. 挖空按**内嵌模型**的墙体 AABB（7200 × 15100）走，而总平面图建筑轮廓是 7005.4 × 17902.6
   （第 12.4 节，长边差 2802.6 mm）：重导模型 JSON 后这些数字会自动跟随，代码不用改。

## 15. 修改指引

- **换项目时先看这些**：标高 Kind 枚举与 §7 表的对应关系、初始相机与平行光位置（initThree 里硬编码）、
  南侧区块是否真由「非水泵间房间」定义（若新项目的房间命名不同，`ySplit` 与南侧填板会一起失效）。
  建筑尺寸类参数（楼板、门窗朝向、包围盒）已全部改为按墙体 AABB 动态推导，无需逐项目修改；
  道路 / 护坡按总平面图图层生成（第 14 节），换项目只需换 `site-context.json`。
- 新增/修改图元映射：改 white-model.js 的 parseDrawing()，并同步本文件第 3、4、5 节。
- 新增/修改门窗族几何：族内坐标只能用 u/v/n（见 5.2），改完**必须**跑 `WMShot.familyCheck()`
  确认 `offenders = 0`，并目视西北/东北鸟瞰；朝向构造别假设 U×V=N，要用 `V×N` 显式取右手基。
- 新增实体分组：除了在 buildModel 里建组，还要把组名加进 index.html 的图层勾选框与
  `buildEdgeLines()` 的分组名单，否则没有线稿叠加。
- 新增外部素材（挑檐截面 / 雨篷截面 / 地形）：既要放 `data/` 下的文件，也要在 index.html 内嵌同样内容的
  `<script type="application/json" id="...">` 占位，否则 file:// 打开会缺数据（`site-context.json` 的内嵌副本
  由 `tools/dxf-site-context.mjs` 自动写回，不要手改）。
- 改周边环境算法或参数：改 `js/environment.js`，同步本文件 5.5 / 13 节与 `tools/dxf-site-context.mjs` 的
  `ENVIRONMENT_PARAMS`（两处默认值必须一致），并重跑生成器刷新数据文件与内嵌副本。
- 改道路 / 护坡算法或参数：改 `js/siteworks.js`，同步本文件 5.6 / 14 节与生成器的 `SITEWORKS_PARAMS`
  （两处默认值必须一致），并重跑生成器刷新数据文件与内嵌副本。⚠ **DLSS 面只出一块实体**
  （14.2）：不要再把它按 `site` 轮廓拆成两个材质岛，分界处会重新闪出棋盘格斜纹带。
- 面板开关与分组：`chk_road` / `chk_slope` 两个复选框分别控制 DLSS 面与护坡，
  改分组名要同步 index.html 的复选框、`renderScenePanel()` 与 5.4 表。
- 采集到新样本时，先跑一次并在控制台看 `data.unknown`，确认是否有新图元类型未处理。
- 总平面图更新后重跑 `tools/dxf-site-context.mjs`（第 12 节）；建筑图纸重新导出 JSON 后，
  核对 `consistency` 段的 `deltaWidthMm` / `deltaLengthMm` / `intakeNorthOverhangMm` 是否收敛到 0 附近，
  未收敛说明两份图纸不同版本，不要把两者混用。
