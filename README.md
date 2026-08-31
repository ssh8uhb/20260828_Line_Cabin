# 20260828_Line_Cabin — 线条小屋 / 建筑白模项目

基于 CAD 插件导出的 `PlanFundingDrawing` JSON，在浏览器中生成可交互浏览的建筑白模（Three.js）。

## 目录

```text
white-model-viewer/   白模查看器（主交付物）
  index.html          页面（含内嵌示例 JSON，可离线双击打开）
  js/white-model.js   JSON 解析 + 参数化建模 + 渲染
  lib/                three.js r128 + OrbitControls（本地依赖）
  data/sample.json    示例 JSON
  tools/cdp-shot.mjs  无头浏览器截图脚本
```

## 快速开始

双击 `white-model-viewer/index.html` 即可浏览示例白模；也可以把任意 `PlanFundingDrawing` JSON 文件拖进页面加载。

详见 [white-model-viewer/README.md](white-model-viewer/README.md)。
