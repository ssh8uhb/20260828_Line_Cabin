# 路线图 — 下一步任务

> 更新于 v0.3.0。完成任务后请同步更新本文件状态、white-model-viewer/README.md，必要时更新 docs/DATA-MODEL.md。

## 0. 优先级总览

| # | 任务 | 依赖 | 状态 |
| --- | --- | --- | --- |
| 1.1 | 挑檐真实截面放样 | 用户：截面 DXF + 对齐说明 | 管线已就绪，等素材 |
| 1.2 | 门窗族替换为真实大样 | 用户：各类门窗 DXF 大样 | 管线已就绪，等素材 |
| 1.3 | 真实地形地面 | 用户：三角网 OBJ + 控制点对 | 管线已就绪，等素材 |
| 2.1 | 多视角自动截图导出 | 无 | **已完成（v0.3.0）** |
| 2.2 | depth / normal 通道导出 | 无 | **已完成（v0.3.0）** |
| 3.1 | JSON → 白模批量出图（无界面） | 2.1 | 批量框架已就绪，剩任意 JSON 路径加载（?src=）与失败报错 |
| 3.2 | 扩散模型联调（截图 + 提示词 → 效果图） | 2.x、3.1 | 未开始 |
| 3.3 | Electron 打包 .exe | 3.1、3.2 | 未开始 |
| 4.1 | 第二个样本回归验证 | 用户：其它项目的 JSON | 未开始 |
| 4.2 | 未处理图元补齐 | 4.1 | 未开始 |

## 1. 素材替换三件套（依赖用户提供素材）

### 1.1 挑檐真实截面放样

- **输入依赖**：放样截面 DXF 1 份 + 文字说明（放样路径取哪条边线、截面原点对齐哪个点、截面朝内还是朝外）。
- **实现步骤**：用 `node white-model-viewer/tools/dxf-profile.mjs 截面.dxf out.json` 提取几何 →
  整理成 `{ name, pathType, unit, profile: [[u, v], ...] }` → 覆盖 white-model-viewer/data/eaves-profile.json，
  **同时更新 index.html 内 `#eavesProfileData` 的同一份内容**。
- **截面坐标约定**：u = 距外墙面的水平外挑距离（向外为正，mm）；v = 相对屋面结构标高（向上为正、向下为负，mm）。
- **验收标准**：从四角平视检查，挑檐与墙、屋面板闭合，角部无破面、无缝隙；与截面图对照形状吻合。
- **建议改动位置**：js/eaves.js（若需支持非矩形路径或多段截面再扩展）。

### 1.2 门窗参数化族替换

- **输入依赖**：各类门窗 2D CAD 大样（DXF，立面为主，含平面开向更好）。
- **现状**：js/families.js 内置 6 个通用族（door-single / door-double / door-bidir / win-fixed / win-2sash / win-fm），
  按 `Kind` 与宽度自动匹配（窗宽 ≥ 1200 用双扇，否则固定窗；Kind=1 用防火观察窗族）。
- **实现步骤**：按大样尺寸改写各族 builder（框料宽 70 / 门扇厚 45 / 玻璃厚 8 等参数集中放在文件顶部），
  保持 `window.WMFamilies.build(group, openings, mats)` 接口不变。
- **验收标准**：遍历 12 个洞口，族实例不穿墙、开向正确、尺寸与洞口一致（当前样本：门 5 樘、窗 7 扇）。

### 1.3 真实地形地面

- **输入依赖**：三角网 OBJ（建议 mm 为单位，v/f 即可）+ 控制点对 JSON。
- **文件命名**：white-model-viewer/data/terrain.obj 与 white-model-viewer/data/terrain-registration.json；
  同时把两者的样例内容内嵌到 index.html（`#terrainObjData` / `#terrainRegData`）保证离线可用。
- **注册文件格式**：

```json
{
  "unit": "mm",
  "zReference": { "groundZ": 168900, "buildingZ": 2141 },
  "points": [
    { "ground": { "x": 0, "y": 0 }, "building": { "x": 0, "y": 0 } },
    { "ground": { "x": 10000, "y": 0 }, "building": { "x": 10000, "y": 0 } }
  ]
}
```

- **语义**：两个控制点对求 2D 相似变换（平移 + 旋转 + 等比缩放，不做非等比/错切）；
  `zReference.groundZ` 是地面网格基准点的绝对标高，`buildingZ` 是该点对应的白模本地高度（Z=0 为水泵间地面 166759），
  实现为 `z_local = gz * s + (buildingZ - groundZ * s)`。建议地面 OBJ 与建筑同为 mm，使 s ≈ 1、Z 不被二次缩放。
- **验收标准**：建筑墙底与地面高程吻合（室外标高 2141 处对齐）、网格无翻转、无穿模；
  推荐控制点取轴线 1/A 与 2/D 交点处的地面实际点。
- **建议改动位置**：js/terrain.js（现在已能解析 OBJ 并做配准，缺少的是真实数据与可选的线框/阴影开关）。

## 2. 出图能力增强

### 2.1 多视角自动截图导出 — ✅ v0.3.0 已完成

- **实现**：js/white-model.js 内置 10 个视角预设（由建筑包围盒自动推算，适配任意 JSON）：
  `iso-ne / iso-nw / iso-se / iso-sw`（四角鸟瞰）、`elev-s / elev-n / elev-w / elev-e`（四向立面）、
  `persp-1 / persp-2`（室外地坪 + 1700mm 视高的人视，带地坪裁剪：地坪以下基础/集水坑不出现）。
  单视角可用 `?view=iso-ne` 直接出图；批量用 tools/cdp-shot.mjs 批量模式（驱动页面内 window.WMShot API）。
- **用法**：`node tools/cdp-shot.mjs "…/index.html" 输出目录 --views=all --channels=color`
  （`--views=` 逗号分隔或 all；`--channels=` 逗号分隔）。输出 `视角-通道.png` + `manifest.json`
  （记录每视角相机 pos/target/fov 与包围盒，保证跨版本可比对）。
- **验收**：一条命令产出 10 × 通道数 张 PNG，命名含视角标识 ✅；manifest 记录相机参数 ✅。

### 2.2 depth / normal 通道导出 — ✅ v0.3.0 已完成

- **实现**：页面内"出图通道"下拉（素模 / 深度 / 法线）或 `?channel=depth|normal`。
  depth 用自定义线性深度 ShaderMaterial（近白远黑、纯黑背景，比 MeshDepthMaterial 的非线性屏幕深度
  更适合 ControlNet Depth）；normal 用 MeshNormalMaterial（视空间法线，朝向面的 RGB ≈ 128,128,255）。
  两通道下线稿/标注自动隐藏，同一相机渲染，几何边界与素模严格对齐。
- **验收**：输出图与素模同机位逐像素对齐 ✅；depth 背景纯黑 ✅。

## 3. 流水线产品化

### 3.1 JSON → 白模批量出图（无界面）

- **目标**：命令行/服务模式：输入 JSON → 输出多视角截图（可选线稿/depth），不打开界面。
- **做法**：用 cdp-shot.mjs 的 CDP 能力跑 headless 流程，或在 Node 端用无头浏览器加载同一 index.html；
  页面已支持 `?static=1` 固定帧出图，适合批处理。
- **验收标准**：给定一个 JSON 路径，一条命令产出完整素材目录；失败时有明确报错（缺图框/缺轴线等）。

### 3.2 扩散模型联调（截图 + 提示词 → 效果图）

- **目标**：把白模截图 + 外立面材质/风格提示词，通过扩散模型生成建筑效果图。
- **方案对比（待定）**：本地部署（SD + ControlNet，需 GPU，可离线、可批量）vs 云 API（无需 GPU，
  但需联网与计费）。产品要装到用户电脑上，若走本地部署需要评估用户显卡门槛；
  **这条路线是产品可行性的关键决策点，先与用户确认再动手**。
- **验收标准**：给定同一白模 + 不同提示词，输出风格可控、建筑几何不跑偏；同一输入可复现。

### 3.3 Electron 打包 .exe

- **目标**：打包成桌面端应用，用户无需安装 Node / Chrome / Blender。
- **做法**：Electron 主进程加载本地页面 + 内置无头浏览器截图能力；Three.js 部分直接复用现有 index.html。
- **验收标准**：干净 Windows 机器上双击可运行，能加载 JSON、浏览白模、导出素材图。

## 4. 工程质量

### 4.1 第二个样本回归验证

- 目前所有字段假设只在一个 JSON 样本上验证过。拿到第二个项目（不同图框组合、不同 Kind 取值）时，
  先跑一遍并检查：控制台 warning、data.unknown 统计、标高表是否正确、门窗是否全部落位。

### 4.2 未处理图元补齐

- 视产品需要，逐步补齐 RoofHatchObject（屋面检修孔）、DrainageTrenchObject（排水沟）、
  Intake* 系列（取水/前池）、BottomStairFlightObject 等图元的建模。

## 5. 素材交付规格（给项目负责人的清单）

1. **挑檐**：截面 DXF 1 份 + 说明（放样路径取哪条边线、截面原点对齐哪个点、朝内还是朝外）。
2. **门窗**：各类门窗的 2D CAD 大样 DXF（立面为主，含平面开向更好）；若有 3D 模型（SU）可作为辅助参考，
   但参数化族仍以 2D 尺寸为准，便于按洞口自动缩放。
3. **地面**：三角网 OBJ + 2 个控制点对（地面坐标 ↔ 建筑坐标，单位 mm）+ 高程基准说明；
   若地面高程与建筑不是同一基准，额外提供 1 个高程对应点。
