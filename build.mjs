// build.mjs — 用 esbuild 打包 editor.js（含 docx / jspdf），并把扩展静态文件复制到 dist/。
import * as esbuild from 'esbuild';
import { cpSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const src = path.join(root, 'src');
const dist = path.join(root, 'dist');

// jsPDF 的可选依赖（仅 .html() 渲染时用到，本扩展用不到）——替换为空模块避免打包报错
const stubPlugin = {
  name: 'stub-optional-deps',
  setup(b) {
    b.onResolve({ filter: /^(html2canvas|canvg|dompurify)$/ }, (a) => ({
      path: a.path,
      namespace: 'stub',
    }));
    b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
      contents: 'export default {};',
      loader: 'js',
    }));
  },
};

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

await esbuild.build({
  entryPoints: [path.join(src, 'editor.js')],
  bundle: true,
  outfile: path.join(dist, 'editor.js'),
  platform: 'browser',
  format: 'iife',
  target: ['chrome110'],
  legalComments: 'none',
  logLevel: 'info',
  plugins: [stubPlugin],
});

for (const f of ['manifest.json', 'background.js', 'content.js', 'editor.html', 'editor.css']) {
  cpSync(path.join(src, f), path.join(dist, f));
}

const icons = path.join(src, 'icons');
if (existsSync(icons)) {
  cpSync(icons, path.join(dist, 'icons'), { recursive: true });
}

console.log('\n✅ 构建完成 → 加载 dist/ 目录到 Chrome 即可（chrome://extensions → 加载已解压的扩展程序）');
