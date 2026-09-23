# 项目交接说明 — 线条小屋 / 建筑白模（20260828_Line_Cabin）

> 交接版本：v0.3.0（tag 待打）　最后更新：2026-09-21
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

## 2. 当前实现（v0.3.0）

主交付物是 white-model-viewer/，一个不依赖任何构建工具、可双击打开的单页应用。

| 能力 | 代码位置 | 说明 |
| --- | --- | --- |
| JSON 解析与坐标对齐 | js/white-model.js 的 parseDrawing() | 遍历 ViewFrames，按轴线 1 ∩ A 把三个图框对齐到同一坐标系，重复图元去重 |
| 标高体系 | buildLevels() | 由 PlanElevationAnnotationObject 的 Kind 索引生成层高表，Z=0 = 水泵间地面 |
| 参数化建模 | buildModel() | 墙体（含门窗洞口拆板）、楼板、结构柱、屋面、楼梯/钢梯/爬梯、基础/集水坑/坡道、散水、房间标注 |
| 素模 + 线稿双通道 | buildEdgeLines() / setLinesVisible() | 对实体按 30° 二面角阈值提取黑色棱边；覆盖 walls/slabs/columns/roof/canopies/stairs/extra/families 八个分组（新增实体分组时需同步该名单）；默认隐藏，可切换 |
| 视角预设（10 个） | applyView() | iso-ne/nw/se/sw 鸟瞰、elev-s/n/w/e 立面、persp-1/2 人视（地坪 + 1700 视高，裁掉地坪以下构件）；由建筑包围盒自动推算，适配任意 JSON |
| 场景面板 | renderScenePanel() / applyScene() | 左侧面板「场景（视角镜头）」：8 个固定场景（4 正立面 + 4 角部鸟瞰，即上行 8 个预设）+ 自定义镜头（存相机位置/目标点/裁剪状态）；按 `DrawingName` 分别写入 localStorage（键 `wm.scenes.v1:<DrawingName>`），不可用时退化为会话内存 |
| 出图通道 | setChannel() / depthMaterial() | color 素模 / depth 线性深度（近白远黑，自定义 ShaderMaterial）/ normal 视空间法线（MeshNormalMaterial）；同一相机逐像素对齐，辅助通道自动隐藏线稿与标注 |
| 批量出图接口 | window.WMShot + tools/cdp-shot.mjs | 页面暴露 built/views/view/cam/channel/info/scenes/saveScene/applyScene/familyCheck；脚本批量模式循环 视角 × 通道 截图并写 manifest.json（相机参数） |
| 门窗参数化族 | js/families.js | 6 个通用族，按 Kind 与宽度自动匹配，按洞口尺寸缩放、按墙向/法线定向 |
| 挑檐截面放样 | js/eaves.js + tools/dxf-profile.mjs | 截面沿屋面外轮廓矩形放样，角部按偏移处理；DXF 截面提取工具已就绪 |
| 地形导入 | js/terrain.js | OBJ 三角网 + 双控制点相似变换（平移/旋转/等比缩放）+ 高程换算 |
| 出图模式 | applyUrlParams() + STATIC | ?static=1 渲染数帧后停住；?lines=1 带线稿；?annot=0 去标注；?view= 视角预设；?channel= 出图通道；?bg=RRGGBB 设背景 |
| 离线可用 | index.html 内嵌 #sampleData / #eavesProfileData | 双击 file:// 打开即可看到示例白模 |

占位数据说明：门窗族是通用占位几何、挑檐是 500×150 平板占位截面、地面是平面（未接入真实地形网格）。
管线已打通，等用户提供素材后替换即可，见 docs/ROADMAP.md。

## 3. 架构与数据流

```text
页面加载
  → loadDefault(): 依次尝试 内嵌 #sampleData / data/sample.json / Flie/输入文件/*.json
  → build(json)
      → resolveExtras(): 读挑檐截面（data/eaves-profile.json）、地形注册与网格（data/terrain*.{json,obj}）
      → buildModel(json, extras)
          → parseDrawing(json)   // 图元 → 中间数据结构 data（见 docs/DATA-MODEL.md）
          → buildLevels(data)    // 标高体系 L
          → 各构件建模，写入 9 个分组: walls/slabs/columns/roof/stairs/extra/ground/families/annot
          → buildEdgeLines()     // 线稿叠加通道（默认隐藏）
      → applyUrlParams(): 应用 ?lines=1 / ?annot=0 / ?view= / ?channel= / ?bg=RRGGBB
  → 用户可拖入其它 JSON 文件重新构建
```

渲染：Three.js r128（lib/three.min.js）+ OrbitControls，无 UI 框架，无模块打包，全部挂在 window 上的
命名空间里（window.WMFamilies / window.WMEaves / window.WMTerrain）。

## 4. 运行与出图

```powershell
# 直接看：双击 white-model-viewer/index.html（离线，使用内嵌示例数据）

# 起本地服务（可读取 data/ 下的外部素材文件）
python -m http.server 8123 --directory D:/Work/Project/20260828_Line_Cabin
# → http://localhost:8123/white-model-viewer/

# 无头截图（单视角，需本机 Chrome/Edge + Node 22+）
node white-model-viewer/tools/cdp-shot.mjs "http://localhost:8123/white-model-viewer/?static=1&lines=1" out.png 8

# 批量出图：10 视角 × 3 通道（color/depth/normal），输出 PNG + manifest.json
node white-model-viewer/tools/cdp-shot.mjs "http://localhost:8123/white-model-viewer/?annot=0" outdir --views=all --channels=color,depth,normal
```

URL 参数：?static=1 固定视角出图（渲染 8 帧后停止）；?lines=1 叠加黑色线稿；?annot=0 隐藏房间标注；
?view=iso-ne 等切换 10 个视角预设（iso-ne/nw/se/sw、elev-s/n/w/e、persp-1/2）；?channel=color/depth/normal
切换出图通道；?bg=ffffff 背景色（6 位 hex）。人视视角（persp-*）自动用地坪裁剪面隐藏室外地坪以下的
基础/集水坑；批量模式下 window.WMShot 驱动 live 页面，manifest.json 记录每张图的相机参数便于跨版本比对。

### 关于线稿通道与 AI 出图

线稿（黑线）对扩散模型的作用是**增强结构可读性**，属于可选通道，不是必需：ControlNet 类模型用
Lineart/Canny 条件时，清晰的棱边线能显著提高“几何不走形”的概率；纯 img2img 或 depth 条件时，素模本身已够用。
因此实现上保持“素模默认 + 线稿可切”，出图时按所选扩散模型的条件类型决定是否叠加。

## 5. 从 JSON 中解析出的图纸事实（事实，非假设）

样本：Flie/输入文件/PlanFundingDrawing_2071793a1bc84bd2bb794bcfe680f313.json（图纸名 平面图提资_20260831）。

- **三个图框**：水泵间平面图（ViewKind=3）、配电间平面图（ViewKind=4，作为基准图框）、屋面平面图（ViewKind=5）。
- **坐标对齐规则**：各图框以自己的轴线 `1` 与轴线 `A` 的交点作为原点，平移到基准图框的轴线交点；
  基准图框的建筑物原点取其墙体轮廓的最小 X/Y。因此建模坐标系原点在基准图框的建筑角点。
- **建筑外包**：7200 × 15100（mm），外墙厚 200（由 WallObject.Outline 直接得出，非假设）。
- **标高体系**（绝对标高，mm）：水泵间地面 166759（= 建模 Z 0）、配电/控制间 169200（+2441）、
  室外地坪 168900（+2141）、屋面 173800（+7041）、钢梯平台 167659（+900）、集水坑底 165259（-1500）。
- **构件统计**（页面统计栏实时显示）：图框 3、墙体 6、门 5、窗 7、柱 8（400×400）、楼梯 4（钢梯 3 + 建筑楼梯 1）、
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

## 7. 已知限制与风险

- **门窗是占位几何**：只按洞口宽高缩放通用族，没有真实门窗分格、开启扇位置，需要 2D CAD 大样替换。
- **挑檐是占位截面**：500×150 平板，真实放样截面（DXF）到位后替换。
- **地面/散水为几何近似**：按建筑外墙 AABB 外偏 5 m 生成 300 mm 厚回字形实体，不使用 ApronObject 轮廓；
  真实带高程三角网（OBJ）导入管线已就绪，但当前样例未启用。
- **墙体按轴对齐矩形（AABB）处理**：由 Outline 的 min/max 得到矩形，**不支持斜墙/异形墙**；若后续样本出现斜墙，需要改成多边形与定向开洞。
- **不做布尔运算**：墙体开洞用“沿墙区间 + 高度区间”的参数化拆板实现，避免依赖 CSG 库；
  洞口若跨越多个墙段或与墙端过近，可能出现拆板边界不理想。
- **线稿是几何棱边**：按 30° 二面角阈值生成，不是工程制图的投影线（看不到被遮挡轮廓），出图效果以实际观感为准。
- **单一样本**：目前只验证过一个 JSON 样本，字段假设（如 Kind 含义、轴线编号）尚未在第二个项目上验证。
- **未使用的图元类型**：parseDrawing 会统计未处理类型（data.unknown），当前样本里包含
  BottomStairFlightObject、RoofHatchObject、DrainageTrenchObject、BreakLineObject、Intake* 系列等，均未建模。

## 8. 素材现状与交付规格

已入库：原始 JSON、JSON 说明（含枚举映射）、DWG 与 DXF 图纸、解析结果 docx（均在 Flie/输入文件/）。

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
| v0.3.0 | （待提交） | 多视角预设（10）+ depth/normal 出图通道 + 批量出图（WMShot / cdp-shot 批量模式）+ 人视地坪裁剪 + ?annot=0 + 场景面板（8 固定场景 + 按图纸持久化的自定义镜头）+ 修复西/北墙窗框横穿墙厚凸出墙面（addPiece 左手基退化 + 双向门内侧把手越界）+ 门窗族几何自检 `WMShot.familyCheck()` |

提交信息格式：`<type>: <中文说明>`；里程碑同时打 tag 并推送。

## 10. 环境与 Git 约定

- 仓库：https://github.com/ssh8uhb/20260828_Line_Cabin.git（远程名 origin，分支 main）。
- 推送方式：**HTTPS + Windows 凭据管理器**（本机没有 SSH 密钥，SSH 地址不可用）。
- 操作前登记目录：`git config --global --add safe.directory "D:/Work/Project/20260828_Line_Cabin"`
  （已写入用户全局 ~/.codex/AGENTS.md 规则：每个新项目登记一次）。
- 运行环境：Node 22+（本机 v24.15.0）、Python 3（本机 3.14.4，用于静态服务）、本机 Chrome/Edge（用于截图）。

## 11. 下一步

见 docs/ROADMAP.md：素材替换三件套 → JSON→白模批处理补齐（?src= 任意路径加载）→ 扩散模型联调 → Electron 打包 .exe。
