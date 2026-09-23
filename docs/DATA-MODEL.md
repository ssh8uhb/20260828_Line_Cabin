# 数据模型 — PlanFundingDrawing JSON → 白模

本文件回答两件事：

1. **参数怎么读**：白模实际读取了 JSON 的哪些字段、按什么规则换算成几何；
2. **读不到时怎么办**：哪些构件走默认形状、哪些尺寸是代码里写死的默认值、缺字段时怎么兜底。

字段的完整定义、类型、枚举映射请看权威文档 `Flie/输入文件/PlanFundingDrawing_JSON说明.md`，本文件不重复抄写。

代码位置：
`white-model-viewer/js/white-model.js`（parseDrawing / buildLevels / buildModel / carveWall / buildEdgeLines）、
`js/families.js`（门窗参数化族）、`js/eaves.js`（挑檐截面扫掠）、`js/terrain.js`（地形 OBJ 配准）。

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
  楼板、门窗朝向、地面/散水、包围盒、视图预设**统一以它为准**，不含任何写死的建筑尺寸。
- **南侧区块**：楼面为 `L.south` 的房间（即名称不含「水泵间」的房间）轮廓并集，样例 = 200,200 – 7000,4800。
  其外缘 `sr.y1` 作为南侧区块与水泵间的分界线（`ySplit`），用于门洞底标高推断。

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
| ApronObject | InnerOutline / OuterOutline | 当前不直接建模；地面/散水统一按建筑外墙动态生成，见第 9 节 |
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
| 门扇沿墙厚方向 | 自 `−tw/2 + 8` 起算，占 45 厚（贴室内一侧） |
| 把手高度 | 950 → 1040（高 90）；单开把手距洞口边内退 `FRAME_W + 80` |
| 把手沿墙厚方向 | `−tw/2 + 55 → −tw/2 + 85` |
| 窗中挺 | 宽 50（±25），玻璃内退 4 |

**洞口实例参数**（white-model.js 的 buildModel 里补齐，供族 builder 使用）：
`tw` = 宿主墙 AABB 短边（视为墙厚）、`ax/ay` = 沿墙方向单位向量、
`nx/ny` = 墙体外法线，**朝向按洞口相对建筑外轮廓中心 `((wb.x0+wb.x1)/2, (wb.y0+wb.y1)/2)` 的位置判定**
（样例 3600, 7550，动态推导，不写死）。

### 5.3 附属构件

| 构件 | 形状 | 尺寸来源（JSON） | 默认值 / 硬编码值 |
| --- | --- | --- | --- |
| 雨篷 | 截面沿门洞顶放样（`addExtrudedCanopy`） | canopy-profile.json（u=0 贴墙，v=0 = 门洞顶标高） | 每个**外门**一组；宽度 = 门洞宽 + 400（两侧各 200）；无截面 → 斜板挑出 700、下坠 50 |
| 门口坡道 | 直角三角形楔块（**封闭三棱柱**，8 个三角形面） | 每个**外门**一组 | 长 1500；宽 = 门宽 + 200；贴地长边 = `L.grade`；贴墙短边高 = `L.south − L.grade`（当前 300）；`RampObject` 自身字段不用 |
| 建筑楼梯踏步 | Box 序列 | StairObject.InsertionPoint、FirstFlightStepCount、FirstFlightLength | 踏步高固定 **250**；级数缺省 **5**；踏面宽 = `FirstFlightLength / 级数`；梯段宽固定 1000（±500）；首级从 z=0 起，沿 +Y 排布；`SecondFlight*` / `IsSingleFlight` 不参与建模（只建第一跑） |
| 钢梯踏步 | Box 序列 | SteelStairObject.InsertionPoint | 固定 **3 级**；踏步高 300、进深 300；宽 800（±400）；起点 `(x, y − 450)`，沿 +Y 排布 |
| 钢爬梯 | 两根立柱 + 踏棍 | SteelLadderObject.InsertionPoint | 立柱截面 60×60、间距 600；总高固定 **3200**；踏棍自 200 起每 **300** 一根，截面 480×60×40；`FacingNormal` 未使用 |
| 设备基础 | Box | PumpFoundationObject.Bounds | 高固定 300（`L.base → L.base + 300`） |
| 集水坑 | 开口盒（四壁 + 底板，非布尔运算） | SumpPitObject.Bounds、ElevationMm | 壁厚 100、底板厚 100；顶 = `L.base`；底 = ElevationMm 换算为 `L.sump`；⚠ ElevationMm 必须存在（缺失会算出 NaN 几何，代码里的 −1500 兜底实际不生效） |
| 地面 / 散水 | 4 个 Box 组成的回字形实体 | 建筑外轮廓 `wb`（全部墙体 AABB 并集） | 外偏 **5000**；厚 **300**；顶 = `L.grade`；内外轮廓线画在 `L.grade + 10` |
| 房间轮廓 / 房间名 | LineLoop + Sprite | RoomOutlineObject.Outline、RoomName | 轮廓线 z = 房间楼面 + 6；文字精灵 scale 1100；楼面 = 名称含「水泵间」→ `L.base`，否则 `L.south` |
| 检修平台标注 | LineLoop + Sprite | MaintenancePlatformObject.Bounds | 线 z = `L.south + 6`；文字「检修平台」scale 900 |
| 集水坑标注 | Sprite | SumpPitObject.Bounds 中心 | 文字「集水坑」scale 700，z = `L.base + 200` |

### 5.4 渲染与出图默认值

| 项 | 数值 |
| --- | --- |
| 相机 | PerspectiveCamera fov 45、near 10、far 300000；初始位置 (13000, 10000, 21500)，target (3600, 7550, 3000) ⚠ 硬编码（initThree 阶段还没有模型数据）；模型加载后视图预设按包围盒重新定位 |
| 背景 | `0xe9e9e9`；`?bg=RRGGBB` 可覆盖；depth / normal 通道强制纯黑 |
| 光照 | HemisphereLight(0xffffff, 0xcfcfcf, 1.05) + DirectionalLight 1.25 @ (12000, 22000, 10000)，阴影贴图 2048²、正交阴影范围 ±16000 ⚠ 硬编码 |
| 渲染器 | PCFSoftShadowMap、sRGBEncoding、ACESFilmicToneMapping、exposure 1.05、pixelRatio ≤ 2 |
| 材质 | 墙 0xffffff / 板 0xf3f3f3 / 屋面 0xeeeeee / 柱 0xfafafa / 地面 0xdedede / 玻璃 0xf2f2f2 透明 0.45 |
| 线稿叠加 | `EdgesGeometry(geo, 30)`（二面角阈值 30°）黑色线；**分组名单 8 个**：walls / slabs / columns / roof / canopies / stairs / extra / families（新增实体分组必须同步该名单，否则新构件没有线稿）；默认隐藏，`?lines=1` 或勾选显示 |
| depth 通道 | 自定义线性着色 ShaderMaterial：`uNear = max(相机到目标距离 − 建筑包围盒跨度, 1)`、`uFar = 距离 + 跨度 × 1.2`，近白远黑、背景纯黑 |
| normal 通道 | MeshNormalMaterial（视野空间法线） |
| 视图预设 | 10 个：`iso-{ne,nw,se,sw}` / `elev-{s,n,w,e}` / `persp-1` / `persp-2`，全部由 `state.bounds` 推导，不依赖硬编码尺寸 |
| persp 视角 | 视高 = `L.grade + 1700`，看向 `L.grade + 2800`；自动加水平裁剪面 `y = L.grade − 10` 裁掉地坪以下的基础 / 集水坑 |
| 场景面板 | 固定 8 个 = 上行 8 个预设（南/北/西/东立面 + 东北/西北/东南/西南鸟瞰），不存储、实时由包围盒推算；自定义镜头存 `{name, pos, target, clip}`，写入 localStorage 键 `wm.scenes.v1:<DrawingName>`（按图纸独立一套），不可用时退化为会话内存；`clip=true` 时按当前 `L.grade − 10` 重算裁剪面 |

## 6. 已解析但当前未建模的字段

| 字段 | 来源 | 状态 |
| --- | --- | --- |
| `data.ramps` | RampObject | 已解析，未建模；坡道改由外门自动生成（第 10 节） |
| `data.apron` | ApronObject.InnerOutline / OuterOutline | 已解析，未建模；地面按墙 AABB 生成（第 9 节） |
| `data.texts` | PlanMultilineTextObject | 已解析，未绘制；页面只显示 RoomOutlineObject 的房间名 |
| `data.roofCanopies` | RoofPolylineObject Kind = 4 | 已解析，未建模；雨篷改由外门自动生成（5.3） |
| `data.counts` | 所有图元计数 | 仅统计，不参与建模 |
| terrain（`data/terrain.obj` + `data/terrain-registration.json`） | `js/terrain.js` | 解析与双控制点配准（平移+旋转+等比缩放）已实现，但 **buildModel 尚未接入**，当前样例不渲染地形 |

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
| SumpPitObject.ElevationMm | 165259 | −1500 | 集水坑底（必填；`L.sump` 未定义时的 −1500 兜底实际不会触发） |

⚠ 索引来自 `Kind` 枚举而非数组顺序；换项目前要对照 JSON 说明文档核对 Kind 含义。

## 8. 墙体开洞（不使用布尔运算）

- 把墙视为轴对齐矩形，判断长边方向（`dy >= dx` 则沿 Y）。
- 洞口在墙上的位置区间 = 中心 ± Width/2；再叠加高度区间 [z0, z1]。
- carveWall() 用区间切割把墙拆成若干方块（左/右/上/下四块），洞口不生成实体。
- 洞口归属墙面用 `openingIntervalOnWall()` 判定：洞口中心需落在墙 AABB 内（容差 5 mm），返回 null 表示该墙不承载此洞口。
- 门洞底标高由 `floorAt(L, platform, ySplit, x, y)` 推断：检修平台范围内（容差 150 mm）或 `y < ySplit` 视为 +2441 楼面，否则水泵间地面 0。
  `ySplit` = 南侧房间轮廓的外缘（`sr.y1`，样例 4800），动态推导；无南侧房间时取 `wb.y0`（即不用 +2441 楼面）。
- 窗洞底标高统一 = 配电/控制间结构标高（`L.south`）+ **900 mm**，不随窗户所在楼面变化。

## 9. 地面与散水

- 地面/散水统一生成为回字形实体环带，不直接使用 `ApronObject` 的 InnerOutline / OuterOutline。
- 内轮廓 = 所有墙体的 AABB（建筑外墙）。
- 外轮廓 = 内轮廓向外偏移 **5000 mm**（5m）。
- 环带为实体，顶标高 = `L.grade`，厚度 **300 mm**（向下生成）；内外轮廓线同时绘制线框（标高 `L.grade + 10`）以增强可见性。

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

## 12. 修改指引

- **换项目时先看这些**：标高 Kind 枚举与 §7 表的对应关系、初始相机与平行光位置（initThree 里硬编码）、
  南侧区块是否真由「非水泵间房间」定义（若新项目的房间命名不同，`ySplit` 与南侧填板会一起失效）。
  建筑尺寸类参数（楼板、地面、门窗朝向、包围盒）已全部改为按墙体 AABB 动态推导，无需逐项目修改。
- 新增/修改图元映射：改 white-model.js 的 parseDrawing()，并同步本文件第 3、4、5 节。
- 新增实体分组：除了在 buildModel 里建组，还要把组名加进 index.html 的图层勾选框与
  `buildEdgeLines()` 的分组名单，否则没有线稿叠加。
- 新增外部素材（挑檐截面 / 雨篷截面 / 地形）：既要放 `data/` 下的文件，也要在 index.html 内嵌同样内容的
  `<script type="application/json" id="...">` 占位，否则 file:// 打开会缺数据。
- 采集到新样本时，先跑一次并在控制台看 `data.unknown`，确认是否有新图元类型未处理。
