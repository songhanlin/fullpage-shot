# 整页截图 · 裁剪导出

一个 Chrome 扩展（Manifest V3）：对任意网页进行**整页滚动截图**，在编辑器里像微信图片裁剪一样**自由框选裁剪**，再一键导出为 **Word / PDF / PNG**。功能类似 GoFullPage，但裁剪、导出全部本地完成，**无需登录、无需付费**。

## 功能

- 📸 **整页截图**：自动滚动页面逐屏抓取并拼接为一张长图
- ✂️ **微信式裁剪**：默认框选整页，拖拽四边/四角调整选区，框内可整体移动
- 💾 **保存裁剪 / 撤销**：把图片裁成当前选区，可多次裁剪，支持撤销回退
- 📄 **导出 Word / PDF**：图片按页宽铺满，内容过长自动分页
- 🖼️ **导出 PNG**：保存当前选区的原图

## 安装（普通用户，无需 Node 环境）

1. 打开本仓库的 [Releases](../../releases) 页面，下载最新版的 `fullpage-shot.zip`
2. 解压，得到一个 `fullpage-shot` 文件夹（里面有 `manifest.json` 等文件）
3. 打开 Chrome，地址栏输入 `chrome://extensions/` 回车
4. 打开右上角的「**开发者模式**」开关
5. 点「**加载已解压的扩展程序**」，选择第 2 步解压出的那个文件夹
6. 工具栏出现扩展图标，即安装成功

> Chrome 不允许从应用商店之外直接安装 `.crx`/`.zip`，「加载已解压的扩展程序」是商店外唯一的安装方式，属于正常用法。浏览器重启后扩展依然在，只是偶尔会弹一次「开发者模式扩展」的提示，可忽略。

## 使用

1. 打开任意网页，点击工具栏上的扩展图标
2. 页面自动滚动截图，完成后自动打开编辑器标签页
3. 编辑器默认已框选整页：拖拽四边/四角的把手调整选区，框内拖动可整体移动
4. 点「保存裁剪」把图片裁成当前选区（可重复裁剪，「撤销」回退，「框选整页」重置选区）
5. 点「导出 Word / PDF / PNG」即可下载，导出内容即当前选区

## 从源码构建（开发者）

```bash
npm install        # 安装依赖（docx / jspdf / esbuild）
npm run build      # 生成图标 + 打包，输出到 dist/
npm run pack       # 在 build 基础上额外打出 fullpage-shot.zip
```

构建后，在 `chrome://extensions/` →「加载已解压的扩展程序」选择 `dist/` 目录即可。

## 项目结构

```
src/
  manifest.json    扩展清单（MV3）
  background.js    Service Worker：调用 captureVisibleTab 抓取每屏
  content.js       注入页面：滚动页面、隐藏固定元素与滚动条
  editor.html/.css 裁剪导出编辑器界面
  editor.js        拼接长图、框选交互、导出 Word/PDF/PNG
  icons/           扩展图标（由 scripts/gen-icons.mjs 生成）
build.mjs          esbuild 打包脚本
scripts/gen-icons.mjs  纯 Node 生成 PNG 图标
```

## 已知限制

- `chrome://`、扩展商店等特殊页面无法截图
- 极长页面（拼接高度超过约 24000px）会按比例缩小以适配浏览器画布上限
- 固定/吸顶元素仅在第一屏保留，其余屏隐藏以避免重复出现
- 懒加载内容依赖滚动触发；个别站点加载较慢时可能需要重试

## 许可证

[MIT](LICENSE) © songhanlin
