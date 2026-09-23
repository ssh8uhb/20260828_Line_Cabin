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
  - **出图通道**：素模（彩色）/ 深度 depth / 法线 normal，供 AI 渲染条件图使用（见下文）

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

`?static=1` 渲染数帧后停止，便于稳定截图；URL 参数：

| 参数 | 作用 |
| --- | --- |
| `lines=1` | 出图含黑色线稿叠加 |
| `annot=0` | 隐藏房间标注（文字 + 房间轮廓线），得到纯净条件图 |
| `bg=ffffff` | 背景色（6 位 hex） |
| `view=名字` | 应用视角预设（见下表），如 `?view=iso-ne` |
| `channel=…` | 出图通道 `color` / `depth` / `normal`，如 `?channel=depth` |

### 视角预设（10 个，按建筑包围盒自动推算，适配任意 JSON）

| 名称 | 内容 |
| --- | --- |
| `iso-ne / iso-nw / iso-se / iso-sw` | 四角鸟瞰 |
| `elev-s / elev-n / elev-w / elev-e` | 南 / 北 / 西 / 东立面（正视） |
| `persp-1 / persp-2` | 人视（室外地坪 + 1700mm 视高；自动裁掉地坪以下的基础/集水坑，画面如真实照片） |

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
# 全部 10 视角 × 3 通道 = 30 张 + manifest.json
node tools/cdp-shot.mjs "http://localhost:8123/white-model-viewer/?annot=0" 输出目录 --views=all --channels=color,depth,normal

# 只出指定视角 / 通道
node tools/cdp-shot.mjs "http://localhost:8123/white-model-viewer/" 输出目录 --views=iso-ne,elev-s --channels=color,depth
```

输出文件命名 `视角-通道.png`（如 `iso-ne-depth.png`）；同时写 `manifest.json`，记录每个视角的
相机 pos / target / fov 与建筑包围盒，保证不同版本之间的出图可以逐像素比对。
`--views=` 逗号分隔或 `all`；`--channels=` 逗号分隔；末尾数字是页面加载等待秒数（默认 8）。

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