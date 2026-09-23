# AGENTS.md — 本仓库工作约定（面向 AI Agent）

本文件供在本仓库中工作的 AI Agent（Codex / Cursor 等）自动读取。人类读者请先看 docs/PROJECT-HANDOFF.md。

## 项目是什么

把 CAD 端设计插件导出的 PlanFundingDrawing JSON，转成可在浏览器交互浏览的建筑白模（Three.js）。
它是技术路线 `DWG → JSON → 白模 → 扩散模型渲染效果图` 的第三段，最终产品形态是**桌面端 .exe，
不要求用户电脑安装 Blender**。

## 硬约束（改代码前先读）

1. **无构建工具**：原生 JS + 本地 three.js r128，没有 npm / webpack / 打包步骤。除非用户明确要求，
   不要引入构建工具或依赖 CDN。
2. **file:// 必须可用**：white-model-viewer/index.html 双击即可看到白模。示例 JSON、挑檐占位截面、
   地面样例均以 `<script type="application/json" id="...">` 内嵌在页面中。**新增外部素材时，必须同时在
   页面内嵌一份占位数据**，否则离线打开会失效。
3. **单位统一 mm**；Z=0 = 水泵间地面（绝对标高 166759）。建筑坐标由三个图框按轴线 1 ∩ A 对齐。
4. 不提交第三方参考仓库副本（pure-line-room/ 已在 .gitignore 排除），不提交仓库根目录的无关文件。
5. 改任何一个构件的建模逻辑或默认数值时，**必须同步更新 docs/DATA-MODEL.md 的第 5 节默认值总表**；
   改素材规格时同步更新 docs/ROADMAP.md 与 white-model-viewer/README.md。

## 目录速览

```text
white-model-viewer/     主交付物（白模查看器）
  index.html            页面 + 内嵌示例数据 + 内嵌素材占位
  js/white-model.js     JSON 解析 + 参数化建模 + 渲染 + UI
  js/families.js        门窗参数化族
  js/eaves.js           挑檐截面沿路径放样
  js/terrain.js         地形 OBJ 导入 + 双控制点配准
  lib/                  three.js r128 + OrbitControls（本地依赖）
  data/                 示例 JSON、挑檐截面
  tools/                CDP 无头截图、DXF 截面提取
Flie/输入文件/           原始输入资料（JSON / JSON 说明 / DWG / DXF）
docs/                   交接说明、路线图、数据模型、会话纪要
```

## 改完必须自检

```powershell
# 1) 语法检查
Set-Location white-model-viewer
node --check js/white-model.js; node --check js/families.js
node --check js/eaves.js; node --check js/terrain.js

# 2) 渲染截图（需本机有 Chrome/Edge；输出到临时目录，不要提交进仓库）
node tools/cdp-shot.mjs "file:///D:/Work/Project/20260828_Line_Cabin/white-model-viewer/index.html?static=1&lines=1" "$env:TEMP/wm-check.png" 8

# 3) 批量出图自检（10 视角 × 3 通道，输出目录 + manifest.json，同样不进仓库）
node tools/cdp-shot.mjs "file:///D:/Work/Project/20260828_Line_Cabin/white-model-viewer/index.html?annot=0" "$env:TEMP/wm-batch" --views=all --channels=color,depth,normal

# 4) 或起本地静态服务
python -m http.server 8123 --directory D:/Work/Project/20260828_Line_Cabin
#    → http://localhost:8123/white-model-viewer/
```

判定标准：截图非黑屏、门窗/屋面/楼梯齐全、页面统计栏数字与 JSON 一致
（当前样本：图框 3、墙体 6、门 5、窗 7、柱 8、楼梯 4）。

**动了门窗族几何（js/families.js）再加一步**：页面 Console 跑 `JSON.stringify(WMShot.familyCheck())`，
要求 `offenders = 0`（样例基线 78 块）。门窗构件凸出墙面的坑与坐标约定见 docs/DATA-MODEL.md 5.2。

需要交叉验证图片内容时，用本机识图脚本（用户全局规则要求：禁止回复「无法识别图片」）：

```powershell
node C:/Users/lenovo/.codex/skills/claude-vision-skill/vision.js "$env:TEMP/wm-check.png" "请描述这张建筑白模截图"
```

## Git 约定

- 操作仓库前先登记目录（沙箱用户与目录所有者不一致会触发 dubious ownership）：
  `git config --global --add safe.directory "D:/Work/Project/20260828_Line_Cabin"`
- 远程走 **HTTPS + Windows 凭据管理器**（https://github.com/ssh8uhb/20260828_Line_Cabin.git）；
  本机没有 SSH 密钥，不要用 SSH 地址。
- 分支前缀 codex/；里程碑打 tag vX.Y.Z；推送主分支后单独推送 tag。
- 提交信息用中文，格式 `<type>: <说明>`；多行信息写入 UTF-8 文件后用 `git commit -F`。

## 已知环境坑

- exec 工具偶发 helper_unknown_error: setup refresh had errors，重试通常即可。
- apply_patch 需直接调用 codex.exe 的 --codex-run-as-apply-patch 并传入 UTF-8 patch 文本；
  经 .bat 包装器传多行参数会失败；超长 patch 会被策略拦截，需分段或改用 Node REPL 写文件。
- Start-Process 在本机沙箱可能被策略拦截；起本地服务改用长时间运行的命令会话。
- CDP 截图脚本结束时会打印 [chrome-exit] null SIGTERM，属正常退出。

## 文档索引

- docs/PROJECT-HANDOFF.md — 项目目标、当前实现、图纸事实、假设清单、限制与风险
- docs/ROADMAP.md — 下一步任务、素材交付规格与验收标准
- docs/DATA-MODEL.md — PlanFundingDrawing JSON → 白模的生成说明：参数读取规则、图元映射、
  默认形状与默认数值总表（含硬编码清单）、坐标与标高等约定
- docs/SESSION-NOTES-2026-08-28.md — 需求演变与关键决策纪要
