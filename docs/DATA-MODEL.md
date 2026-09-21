# 数据模型 — PlanFundingDrawing JSON → 白模

本文件只回答一件事：**白模实际读取了 JSON 的哪些字段、怎么用它们建模**。
字段的完整定义、类型、枚举映射请看权威文档 Flie/输入文件/PlanFundingDrawing_JSON说明.md，本文件不重复抄写。

代码位置：white-model-viewer/js/white-model.js（parseDrawing / buildLevels / buildModel）。

## 1. 顶层结构

| 字段 | 是否使用 | 用途 |
| --- | --- | --- |
| DrawingName | 使用 | 页面标题与统计栏 |
| ViewFrames[] | 使用 | 唯一的数据入口；每个图框含 ViewKind / ViewTypeName / Elements[] |
| DrawElementBounds | 未使用 | 可用于视图自适应，当前用固定相机 |
| DrawingPath / SourceDrawingPath / WaterMachineSourceDrawingPath / ElectricalSourceDrawingPath | 未使用 | 图纸溯源信息 |
| IntakePoolChannelSlopeParameters | 未使用 | 取水/前池相关参数 |

## 2. 坐标系与单位

- 单位统一 **mm**；JSON 是二维平面数据：`X, Y` → Three.js 的 `(x, z)`，高度方向为 `y`。
- **基准图框**：优先 ViewKind = 4（配电间平面图，含完整墙体），否则取 ViewFrames[0]。
- **建筑原点**：基准图框所有 WallObject.Outline 的最小 X / 最小 Y。
- **图框对齐**：每个图框取自己的轴线 `1`（AxisObject.Number = "1" 的 LocationLine.Start）与轴线 `A`
  （Number = "A" 的 LocationLine.Start.Y）交点，平移到基准图框的轴线交点。缺轴线的图框会被跳过并记 warning。
- **Z=0** = 水泵间地面（绝对标高 166759）；所有标高换算为相对 166759 的本地高度。

## 3. 图元 → 白模处理

代码用 `$type` 的最后一段做类型分派（例如 `"ViewPlanCreate.Models.PlanFunding.DoorObject, LZ.ViewPlanCreate"` → `DoorObject`）。

| 图元（$type 短名） | 读取的关键字段 | 白模处理 |
| --- | --- | --- |
| WallObject | Outline[]、Kind | 取轮廓 AABB 作为矩形墙；Kind=0 为外墙（从基准标高到屋面），其它为内墙（起始标高按所在房间楼面推断） |
| StructuralColumnObject | InsertionPoint、Length、Width | 结构柱，全高 |
| DoorObject | OpeningMidpoint/InsertionPoint、Width、Height、Kind、IsExterior、FacingNormal | 生成门洞 + 摆放门族（Kind 0 双开 / 1 单开 / 2 双向） |
| WindowObject | InsertionPoint、WallDirection、Width、Height、Kind | 生成窗洞 + 摆放窗族；洞口中心 = InsertionPoint + WallDirection × Width/2 |
| StairObject | InsertionPoint、First/SecondFlightStepCount、First/SecondFlightLength、IsSingleFlight | 建筑楼梯（踏步高 250 为假设值，踏步宽按梯段长等分） |
| SteelStairObject | InsertionPoint | 钢楼梯（按位置去重） |
| SteelStairPlatformObject | 位置与范围 | 钢梯平台 |
| SteelLadderObject | 位置 | 钢爬梯 |
| SumpPitObject | 轮廓、elev | 集水坑（下沉坑，坑底标高参与标高体系） |
| PumpFoundationObject | 轮廓 | 设备基础 |
| RampObject | InsertionPoint、方向、Length、Width | 室外坡道 |
| ApronObject | outer / inner 轮廓 | 散水环带（贴室外地坪） |
| RoomOutlineObject | 轮廓、名称 | 房间轮廓线 + 文字标注 |
| MaintenancePlatformObject | 轮廓 | 检修平台（楼板） |
| PlanElevationAnnotationObject | Kind、ElevationMm | 标高体系来源，见第 4 节 |
| PlanMultilineTextObject | 位置、文本 | 图面文字标注 |
| RoofPolylineObject | Kind、Vertices[] | Kind 0 = 屋面外轮廓；Kind 3 = 挑檐外沿（无截面放样时使用）；Kind 4 = 雨篷 |
| RoofRainPipeObject | Center、Diameter | 雨水管（圆柱） |
| 其它（AxisObject / RoofHatchObject / DrainageTrenchObject / BreakLineObject / Intake* / BottomStairFlightObject …） | — | 未建模，仅计入 data.unknown 统计 |

## 4. 标高读取规则

- 读到 PlanElevationAnnotationObject 时按 **Kind 做索引**：`data.elev[Kind] = ElevationMm`（同类取首个）。
- buildLevels() 的映射（绝对标高 mm → 相对 Z=0 的本地高度）：

| 索引 | 绝对标高 | 本地 Z | 含义 |
| --- | --- | --- | --- |
| elev[0] | 166759 | 0 | 基准：水泵间地面 |
| elev[1] | 169200 | +2441 | 配电间 / 控制间 / 检修平台楼面 |
| elev[3] | 168900 | +2141 | 室外地坪 |
| elev[4] | 173800 | +7041 | 屋面 |
| elev[5] | 167659 | +900 | 钢梯平台 |
| SumpPitObject.elev | 165259 | -1500 | 集水坑底 |

⚠ 索引来自 `Kind` 枚举而非数组顺序；换项目前要对照 JSON 说明文档核对 Kind 含义。

## 5. 墙体开洞（不使用布尔运算）

- 把墙视为轴对齐矩形，判断长边方向（`dy >= dx` 则沿 Y）。
- 洞口在墙上的位置区间 = 中心 ± Width/2；再叠加高度区间 [z0, z1]。
- carveWall() 用区间切割把墙拆成若干方块（左/右/上/下四块），洞口不生成实体。
- 洞口归属墙面用 `openingIntervalOnWall()` 判定：洞口中心需落在墙 AABB 内（容差 5 mm），返回 null 表示该墙不承载此洞口。
- 门洞底标高由 `floorAt(L, platform, x, y)` 推断：检修平台范围内或 y < 4800 视为 +2441 楼面，否则水泵间地面 0。
- 窗洞底标高 = 所在楼面 + **900（假设值）**。

## 6. 去重规则

同一构件在多个图框重复出现时按 key 去重：墙 = 轮廓 AABB 取整；柱 = 位置 + Length + Width；钢梯 = 位置。

## 7. 修改指引

- 新增/修改图元映射：改 white-model.js 的 parseDrawing()，并同步本文件的第 3 节表。
- 新增外部素材（挑檐截面 / 地形）：既要放 data/ 下的文件，也要在 index.html 内嵌同样内容的
  `<script type="application/json" id="...">` 占位，否则 file:// 打开会缺数据。
- 采集到新样本时，先跑一次并在控制台看 data.unknown，确认是否有新图元类型未处理。
