# PlanFundingDrawing JSON 数据说明

## 1. 文档用途

本文档说明 `PlanFundingDrawing` 导出 JSON 的数据结构，供其他程序读取该 JSON 后执行 CAD 出图、图形分析、统计、数据交换或其他生成动作。

## 2. 总体约定

- 文件编码：UTF-8（无 BOM）。
- JSON 格式：缩进格式，使用 Newtonsoft.Json 序列化。
- 坐标系：二维世界坐标系，`X` 向右、`Y` 向上。
- 长度、坐标、宽高、直径及标高：除字段另有说明外，单位均为毫米（mm）。
- 角度：当前样本没有直接输出角度，方向由二维向量表示。
- 枚举：以整数输出，不是枚举名称字符串。
- `null`：表示该字段在本次生成流程中没有数据，不应当按空字符串或数字 0 处理。
- 图元多态：`ViewFrames[].Elements[]` 中每个对象通过 `$type` 区分具体图元类型。
- 所有具体图元都具有 `Bounds` 字段。部分仅表示插入点或辅助信息的图元可能具有零宽或零高包围框，使用方不应强制认为包围框一定有面积。

## 3. 当前样本概览

当前 JSON 包含 3 个图框、146 个图元、30 种具体图元类型。

| ViewKind | ViewTypeName | 图元数 | 图元组成                                                                                                                                                       |
| --------:| ------------ | ---:| ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 3        | 水泵间平面图       | 39  | 轴线 6、底部梯段 1、排水沟 1、标高 2、文字 6、水泵基础 4、房间轮廓 1、钢爬梯 1、钢楼梯 3、钢楼梯平台 1、结构柱 8、集水坑 1、墙体 4                                                                             |
| 4        | 配电间平面图       | 76  | 散水 1、轴线 6、折断线 1、门 5、排水沟 1、电气房间 2、引水渠道前段 1、渠道护坡 2、进水前池 1、检修平台 1、检修平台分隔 1、标高 6、文字 9、水泵基础 4、水泵房 1、坡道 3、房间轮廓 3、建筑楼梯 1、钢爬梯 1、钢楼梯 3、钢楼梯平台 1、结构柱 8、集水坑 1、墙体 6、窗 7 |
| 5        | 屋面平面图        | 31  | 轴线 6、标高 1、屋面大样块 3、屋面填充 1、屋面多段线 14、雨水管 6                                                                                                                    |

## 4. 顶层结构

| 字段                                 | 类型                 | 含义                                   |
| ---------------------------------- | ------------------ | ------------------------------------ |
| `DrawingName`                      | `string`           | 图纸名称，通常不含扩展名。                        |
| `DrawingPath`                      | `string`           | 目标 DWG 路径。该路径属于生成机器，换机器后可能不可直接使用。    |
| `SourceDrawingPath`                | `string \| null`   | 从已有 DWG 反向读取时的源图纸路径；正向生成时通常为 `null`。 |
| `WaterMachineSourceDrawingPath`    | `string \| null`   | 水泵房图元来源的水机提资 DWG 路径。                 |
| `ElectricalSourceDrawingPath`      | `string \| null`   | 控制间、配电间图元来源的电气提资 DWG 路径。             |
| `IntakePoolChannelSlopeParameters` | `object \| null`   | 进水池渠道找坡参数。                           |
| `DrawElementBounds`                | `boolean`          | 生成 CAD 时是否绘制红色调试包围框。                 |
| `ViewFrames`                       | `array<ViewFrame>` | 图纸中的图框集合。                            |

`IntakePoolChannelSlopeParameters`：

| 字段               | 类型       | 含义                        |
| ---------------- | -------- | ------------------------- |
| `SlopeHeightAMm` | `number` | 坡高 a，等于引水渠道护坡顶标高减去进水池底标高。 |
| `SlopeLengthBMm` | `number` | 坡长 b，按坡高和配置的坡度分母计算。       |

## 5. 图框 ViewFrame

每个 `ViewFrames[]` 元素的结构如下：

| 字段                | 类型               | 含义                                       |
| ----------------- | ---------------- | ---------------------------------------- |
| `Source`          | `object \| null` | 原始 CAD 图框实体快照。当前样本均为 `null`；第三方程序一般可以忽略。 |
| `ViewKind`        | `integer`        | 视图类型枚举，映射见下文。                            |
| `ViewTypeName`    | `string`         | 面向用户的视图名称。                               |
| `Bounds`          | `BoundingBox2D`  | 图框的外包框。                                  |
| `LeftBottomPoint` | `Point2D`        | 图框左下角，图框内图元布置时使用的坐标偏移基点。                 |
| `Elements`        | `array<object>`  | 图框内的图元集合；通过 `$type` 判断具体类型。              |

`ViewKind` 映射：

| 数值  | 名称                     | 含义     |
| ---:| ---------------------- | ------ |
| 0   | `Unknown`              | 未识别视图  |
| 1   | `FundingPlan`          | 提资平面图  |
| 2   | `FundingSection`       | 提资剖面图  |
| 3   | `PumpRoomPlan`         | 水泵间平面图 |
| 4   | `DistributionRoomPlan` | 配电间平面图 |
| 5   | `RoofPlan`             | 屋面平面图  |

## 6. 公共几何结构

### Point2D / Vector2D

点和向量都使用相同的 JSON 外形：

```json
{
  "X": 29862.62538353006,
  "Y": 12280.000000001251
}
```

- 点表示世界坐标位置。
- 向量表示方向，不表示坐标位置；名称包含 `Normal` 或 `Direction` 的字段通常是单位向量。

### Line2D

```json
{
  "Start": { "X": 26062.625, "Y": 7380.0 },
  "End": { "X": 33262.625, "Y": 7380.0 }
}
```

### BoundingBox2D

```json
{
  "Min": { "X": 20262.625, "Y": 6980.0 },
  "Max": { "X": 39062.625, "Y": 7780.0 }
}
```

`Min` 是左下角，`Max` 是右上角。包围框适合快速定位、碰撞筛选和视图缩放，但复杂图元的精确几何应读取其轮廓、边线或顶点字段。

## 7. `$type` 图元类型标识

`Elements` 是不同图元类型的混合集合，单个元素示例：

```json
{
  "$type": "ViewPlanCreate.Models.PlanFunding.AxisObject, LZ.ViewPlanCreate",
  "LocationLine": {
    "Start": { "X": 26062.625, "Y": 7380.0 },
    "End": { "X": 33262.625, "Y": 7380.0 }
  },
  "Number": "A",
  "Bounds": {
    "Min": { "X": 20262.625, "Y": 6980.0 },
    "Max": { "X": 39062.625, "Y": 7780.0 }
  }
}
```

建议读取 `$type` 中逗号前类型全名的最后一段作为稳定的分发键。例如上例应得到 `AxisObject`。不要依赖程序集名称后续永远不变。

非 .NET 程序可以把 `$type` 当作普通类型判别字段；不必理解 Newtonsoft.Json 的元数据机制。

## 8. 图元字段说明

下表中的每种图元都额外包含公共字段 `Bounds: BoundingBox2D`。

| `$type` 短名称                          | 专有字段                                                                                                                                                                                      | 用途和说明                                                   |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| `AxisObject`                         | `LocationLine: Line2D`、`Number: string`                                                                                                                                                   | 建筑轴线；数字通常表示竖向轴，字母通常表示横向轴。                               |
| `PumpRoomObject`                     | `InsertionPoint: Point2D`                                                                                                                                                                 | 水泵房图块；插入点对应进水池轮廓线右下角。                                   |
| `PumpFoundationObject`               | 无                                                                                                                                                                                         | 水泵基础的轴对齐矩形轮廓，精确范围直接使用 `Bounds`。                         |
| `ElectricalRoomObject`               | `RoomKind: integer`、`PlaceContentCentroidAtTop: boolean`、`InsertionPoint: Point2D`                                                                                                        | 控制间或配电间图块。插入点为旋转后房间轮廓左上角。                               |
| `MaintenancePlatformPartitionObject` | `Name: string`、`LocationLine: Line2D`                                                                                                                                                     | 检修平台与相邻区域的开放分隔线。                                        |
| `MaintenancePlatformObject`          | 无                                                                                                                                                                                         | 检修平台区域，主要用于表达集水坑、排水沟等的遮挡范围，使用 `Bounds`。                 |
| `SteelLadderObject`                  | `InsertionPoint: Point2D`、`FacingNormal: Vector2D`                                                                                                                                        | 钢爬梯图块及朝向房间内部的方向。                                        |
| `SteelStairObject`                   | `InsertionPoint: Point2D`                                                                                                                                                                 | 平台钢楼梯；插入点是资源图块右侧中心点的对齐位置。                               |
| `SteelStairPlatformObject`           | 无                                                                                                                                                                                         | 钢楼梯平台矩形轮廓，使用 `Bounds`。                                  |
| `BottomStairFlightObject`            | `InsertionPoint: Point2D`、`Direction: Vector2D`                                                                                                                                           | 水泵间平面底部梯段图块。                                            |
| `StairObject`                        | `IsSingleFlight: boolean`、`InsertionPoint: Point2D`、`FirstFlightStepCount: integer`、`SecondFlightStepCount: integer`、`FirstFlightLength: number`、`SecondFlightLength: number`             | 建筑单跑或双跑楼梯及其动态参数；单跑时二跑数量和长度为 0。                          |
| `StructuralColumnObject`             | `InsertionPoint: Point2D`、`Length: number`、`Width: number`                                                                                                                                | 结构柱；插入点为柱中心，长度沿 X，宽度沿 Y。                                |
| `SumpPitObject`                      | `ElevationMm: number`、`ApplyOcclusion: boolean`                                                                                                                                           | 集水坑；闭合轮廓由 `Bounds` 表达。遮挡开关用于 CAD 生成。                    |
| `DrainageTrenchObject`               | `BoundaryLines: array<Line2D>`、`ApplyOcclusion: boolean`                                                                                                                                  | 排水沟最终边线集合；可能是基础周边及连接沟，也可能是房间周圈沟。                        |
| `WallObject`                         | `Kind: integer`、`GenerateHatch: boolean`、`Outline: array<Point2D>`                                                                                                                        | 墙体矩形轮廓；顶点按墙中心线方向排列。`GenerateHatch=true` 表示 CAD 阶段按并集填充。 |
| `RoomOutlineObject`                  | `RoomName: string`、`Outline: array<Point2D>`                                                                                                                                              | 房间净空间闭合轮廓；顶点按闭合环排列，首尾点不重复。                              |
| `DoorObject`                         | `BlockName: string`、`Number: string`、`Kind: integer`、`IsExterior: boolean`、`Width: number`、`Height: number`、`InsertionPoint: Point2D`、`OpeningMidpoint: Point2D`、`FacingNormal: Vector2D` | 门图块及门洞信息。双开门插入点为门洞中心，单开门/双向单开门插入点为铰点。                   |
| `RampObject`                         | `InsertionPoint: Point2D`、`OutwardNormal: Vector2D`、`Length: number`、`Width: number`                                                                                                      | 室外坡道；方向从外墙指向室外，长度沿室外方向，宽度沿外墙方向。                         |
| `ApronObject`                        | `InnerOutline: array<Point2D>`、`OuterOutline: array<Point2D>`                                                                                                                             | 建筑散水。内轮廓为外墙外边矩形，外轮廓为偏移后的散水边界；两组角点一一对应。                  |
| `WindowObject`                       | `BlockName: string`、`Number: string`、`Kind: integer`、`Width: number`、`Height: number`、`InsertionPoint: Point2D`、`WallDirection: Vector2D`                                                 | 外窗或内窗。插入点为窗左侧中心，`WallDirection` 是窗宽对齐的沿墙单位方向。           |
| `PlanElevationAnnotationObject`      | `Kind: integer`、`InsertionPoint: Point2D`、`ElevationMm: number`、`TextSuffix: string`                                                                                                      | 平面标高标注；`ElevationMm` 始终使用毫米，显示时可自行换算为米。                 |
| `PlanMultilineTextObject`            | `Text: string`、`InsertionPoint: Point2D`、`ApplyOcclusion: boolean`                                                                                                                        | 平面多行文字；遮挡开关供 CAD 生成阶段使用。                                |
| `IntakeForebayObject`                | `Length: number`、`Width: number`、`InsertionPoint: Point2D`                                                                                                                                | 平面进水前池图块；长对应 X 向尺寸，宽对应 Y 向尺寸。                           |
| `IntakeChannelSlopeObject`           | `Side: integer`、`Width: number`、`InsertionPoint: Point2D`                                                                                                                                 | 引水渠道上/下护坡图块；`Width` 对应渠道找坡坡长 b。                         |
| `IntakeChannelFrontSectionObject`    | `UpperSlopeWidth: number`、`LowerSlopeWidth: number`、`ChannelWidth: number`、`Length: number`、`InsertionPoint: Point2D`                                                                     | 总平引水渠道前段动态块参数。当前业务中 `Length` 通常为 5000 mm。               |
| `BreakLineObject`                    | `HalfLength: number`、`InsertionPoint: Point2D`                                                                                                                                            | 折断线动态块；`HalfLength` 同时用于“半长1”和“半长2”。                    |
| `RoofPolylineObject`                 | `Kind: integer`、`Closed: boolean`、`Vertices: array<Point2D>`                                                                                                                              | 屋面二维多段线；顶点按绘制顺序排列。                                      |
| `RoofHatchObject`                    | `OuterBoundaryVertices: array<Point2D>`、`InnerBoundaryVertices: array<Point2D>`                                                                                                           | 屋面填充边界；内边界用于形成孔洞。                                       |
| `RoofRainPipeObject`                 | `Center: Point2D`、`Diameter: number`                                                                                                                                                      | 屋面雨水管圆。                                                 |
| `RoofDetailBlockObject`              | `BlockName: string`、`InsertionPoint: Point2D`、`Scale: number`                                                                                                                             | 屋面大样资源图块及统一缩放比例。                                        |

## 9. 枚举值映射

同名 `Kind` 字段在不同图元中含义不同，必须先根据 `$type` 判断图元类型，再解释枚举值。

### ElectricalRoomObject.RoomKind

| 值   | 含义                     |
| ---:| ---------------------- |
| 0   | 控制间 `ControlRoom`      |
| 1   | 配电间 `DistributionRoom` |

### WallObject.Kind

| 值   | 含义              |
| ---:| --------------- |
| 0   | 建筑外墙 `Exterior` |
| 1   | 建筑内墙 `Interior` |
| 2   | 剪力墙 `Shear`     |

### DoorObject.Kind

| 值   | 含义                                |
| ---:| --------------------------------- |
| 0   | 平面双开门 `DoubleDoor`                |
| 1   | 平面单开门 `SingleDoor`                |
| 2   | 平面双向单开门 `BidirectionalSingleDoor` |

### WindowObject.Kind

| 值   | 含义                      |
| ---:| ----------------------- |
| 0   | 外窗 `Exterior`           |
| 1   | 水泵间与控制间之间的内窗 `Interior` |

### IntakeChannelSlopeObject.Side

| 值   | 含义            |
| ---:| ------------- |
| 0   | 进水池下侧 `Lower` |
| 1   | 进水池上侧 `Upper` |

### PlanElevationAnnotationObject.Kind

| 值   | 含义                                     |
| ---:| -------------------------------------- |
| 0   | 水泵间结构标高 `PumpRoom`                     |
| 1   | 控制室或配电间结构标高 `ElectricalRoom`           |
| 2   | 检修平台结构标高 `MaintenancePlatform`         |
| 3   | 室外地坪标高 `OutdoorGround`                 |
| 4   | 屋面结构标高 `Roof`                          |
| 5   | 钢楼梯平台结构标高 `SteelStairPlatform`         |
| 6   | 双跑楼梯平台结构标高 `DoubleFlightStairPlatform` |

### RoofPolylineObject.Kind

| 值   | 含义                      |
| ---:| ----------------------- |
| 0   | 外墙投影 `WallProjection`   |
| 1   | 挑檐偏移线 `EavesOffset`     |
| 2   | 挑檐内边线 `EavesInner`      |
| 3   | 挑檐外边线 `EavesOuter`      |
| 4   | 雨篷 `Canopy`             |
| 5   | 主分水线 `MainWatershed`    |
| 6   | 天沟分水线 `GutterWatershed` |

## 10. 读取示例

### C# / Newtonsoft.Json

项目内部或引用了 `LZ.ViewPlanCreate` 模型程序集的程序，可以使用与导出时相同的设置反序列化：

```csharp
using System.IO;
using Newtonsoft.Json;
using ViewPlanCreate.Models.PlanFunding;

var settings = new JsonSerializerSettings
{
    TypeNameHandling = TypeNameHandling.Auto,
    ReferenceLoopHandling = ReferenceLoopHandling.Ignore
};

var json = File.ReadAllText(jsonPath);
var drawing = JsonConvert.DeserializeObject<PlanFundingDrawing>(json, settings);

foreach (var frame in drawing.ViewFrames)
{
    foreach (var element in frame.Elements)
    {
        if (element is AxisObject axis)
        {
            // 使用 axis.LocationLine、axis.Number 等生成目标内容。
        }
    }
}
```

> 安全提示：`TypeNameHandling` 只应对可信的内部 JSON 使用。不要用以上配置直接反序列化来源不明或可被外部人员修改的 JSON。

### JavaScript / TypeScript

不依赖 .NET 模型时，可以按 `$type` 手工分发：

```javascript
const fs = require("fs");
const drawing = JSON.parse(fs.readFileSync(jsonPath, "utf8"));

function getShortType(element) {
  const qualifiedName = (element.$type || "").split(",")[0];
  return qualifiedName.split(".").pop();
}

for (const frame of drawing.ViewFrames || []) {
  for (const element of frame.Elements || []) {
    switch (getShortType(element)) {
      case "AxisObject":
        // 使用 element.LocationLine 和 element.Number。
        break;
      case "RoomOutlineObject":
        // 使用 element.Outline 生成闭合轮廓。
        break;
      case "RoofRainPipeObject":
        // 使用 element.Center 和 element.Diameter 生成圆。
        break;
    }
  }
}
```

## 11. 用于其他生成动作时的建议

1. 先按 `ViewFrames` 分图框处理，不要把不同视图中的图元直接混在一起。
2. 先读取 `$type`，再解析该类型专有字段；不能仅凭某个字段名猜测图元类型。
3. 精确生成优先使用 `Outline`、`Vertices`、`BoundaryLines`、`LocationLine` 等几何字段；`Bounds` 主要用于快速范围计算。
4. 路径字段是生成机器上的绝对路径。跨电脑使用时，应重新映射或让使用者选择对应 DWG/资源文件。
5. 浮点坐标可能包含计算误差，例如 `12280.000000001251`。比较坐标时应使用容差，建议 0.001 mm 或根据下游业务精度设置，不要直接使用浮点相等判断。
6. 闭合轮廓通常不会重复首点。下游创建多段线或面时，应显式设置闭合，而不是自行追加首点后仍保留闭合标志。
7. 当前 JSON 没有独立的模式版本号。后续模型可能新增字段或图元类型，读取程序应忽略无法识别的字段，并为未知 `$type` 保留日志或兜底处理。
8. `ApplyOcclusion`、`GenerateHatch` 和 `DrawElementBounds` 是生成行为开关，不是几何本身。
9. 当前样本的 `Source` 为 `null`。第三方程序不应依赖该字段存在可解析的 CAD 实体。

## 12. 最小校验规则

使用 JSON 执行生成前，建议至少检查：

- 顶层对象不为空，`ViewFrames` 为数组。
- 每个图框具有可识别的 `ViewKind`、有效的 `Bounds` 和 `Elements` 数组。
- 每个图元具有 `$type` 和 `Bounds`；未知类型记录告警并跳过，不要导致整个文件处理失败。
- 点必须同时具有数值型 `X`、`Y`。
- 线必须具有 `Start`、`End` 两个有效点。
- 多段线或轮廓至少具有满足生成要求的顶点数。
- 所有用于尺寸、坐标和标高的数值必须是有限数，不能是 `NaN` 或无穷大。
- 需要使用源 DWG 或资源块时，先确认相关路径在当前机器可访问。

---

本文档描述的是当前 `PlanFundingDrawing` 模型及指定 JSON 样本。若代码模型发生变化，应同步更新本说明。
