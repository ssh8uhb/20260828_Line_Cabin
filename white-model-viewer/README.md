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
  - 墙体、楼板、结构柱、屋面、楼梯、基础/集水坑/坡道、地面、房间标注
  - **线稿叠加（黑线通道）**：对主要构件按二面角阈值(30°)提取棱边黑线，素模/线稿一键切换
  - **门窗构件**：框/扇/玻璃等参数化族实例（当前为通用占位族，CAD 大样到位后替换）

## 已实现的建模逻辑（对应 JSON 图元）

| JSON 图元 | 白模处理 |
| --- | --- |
| `WallObject` | 矩形轮廓墙体；外墙/内墙按标高起止；门、窗洞口按“沿墙区间 + 高度区间”切割墙体（参数化拆板，不用布尔运算） |
| `DoorObject` / `WindowObject` | 墙上开洞 + 在洞口内摆放参数化门窗族（框/扇/玻璃/把手），按洞口宽高缩放、按墙方向与法线定向 |
| `StructuralColumnObject` | 结构柱（全高） |
| `PlanElevationAnnotationObject` | 读取标高生成层高体系：水泵间 0 / 配电控制间 2441 / 室外 2141 / 屋面 7041 mm |
| `StairObject` / `SteelStairObject` / `SteelStairPlatformObject` / `SteelLadderObject` | 参数化楼梯、钢梯、钢爬梯 |
| `RoomOutlineObject` / `MaintenancePlatformObject` | 房间轮廓线 + 文字标注 |
| `RampObject` / `ApronObject` | 室外坡道（找坡）、散水范围 |
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

`?static=1` 渲染数帧后停止，便于稳定截图；参数：
- `lines=1`：出图含黑色线稿叠加
- `bg=ffffff`：背景色（hex）

## 文件结构

```text
white-model-viewer/
  index.html            页面（含内嵌示例 JSON 与挑檐数据占位）
  js/white-model.js     JSON 解析 + 参数化建模 + 渲染
  js/families.js        门窗参数化族（通用占位，CAD 大样到位后替换几何）
  js/eaves.js           挑檐截面沿路径放样
  js/terrain.js         地形 OBJ 导入 + 双控制点配准
  lib/                  three.js r128 + OrbitControls（本地依赖）
  data/sample.json      示例 JSON
  data/eaves-profile.json 挑檐默认占位截面
  tools/cdp-shot.mjs    CDP 无头截图脚本
  tools/dxf-profile.mjs DXF 截面几何提取
```