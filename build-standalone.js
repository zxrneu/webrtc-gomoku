'use strict';
/*
 * 单文件构建：把 public/ 下的 index.html + style.css + game-core.js + app.js
 * 合成为一个 HTML 文件（全部内联，无外部依赖），输出到 dist/gomoku-standalone.html。
 *
 * 用途：通过 GitHub Release / 微信互发文件分发，对方双击即可打开，
 *      使用内置「手动信令」模式互发连接码建立 P2P 直连（无需任何服务器）。
 *
 * 用法：node build-standalone.js
 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, 'public');
const outDir = path.join(__dirname, 'dist');
const outFile = path.join(outDir, 'gomoku-standalone.html');

const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');

// 防止内联内容意外闭合外层标签
const escJs = (s) => s.replace(/<\/script/gi, '<\\/script');
const escCss = (s) => s.replace(/<\/style/gi, '<\\/style');

let html = read('index.html');

const inlined = [
  [/<link rel="stylesheet" href="style\.css">/i, () => `<style>\n${escCss(read('style.css'))}\n</style>`],
  [/<script src="qrcode\.min\.js"><\/script>/i, () => `<script>\n${escJs(read('qrcode.min.js'))}\n</script>`],
  [/<script src="jsqr\.min\.js"><\/script>/i, () => `<script>\n${escJs(read('jsqr.min.js'))}\n</script>`],
  [/<script src="game-core\.js"><\/script>/i, () => `<script>\n${escJs(read('game-core.js'))}\n</script>`],
  [/<script src="app\.js"><\/script>/i, () => `<script>\n${escJs(read('app.js'))}\n</script>`],
];

for (const [re, fn] of inlined) {
  if (!re.test(html)) {
    console.error(`构建失败：index.html 中未找到匹配 ${re}`);
    process.exit(1);
  }
  html = html.replace(re, fn);
}

// 构建信息注释（不依赖构建时间，保证可复现构建）
const stamp = `<!-- 单文件版 · 由 build-standalone.js 生成 · 源码见同仓库 public/ -->`;
html = html.replace('</head>', `  ${stamp}\n</head>`);

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(outFile, html);

const kb = (fs.statSync(outFile).size / 1024).toFixed(1);
const htmlTagsOnly = html.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '');
const refs = htmlTagsOnly.match(/(?:src|href)="(?!data:|#|https?:)[^"]+"/g);
if (refs && refs.length) {
  console.error('构建警告：仍存在外部引用', refs);
  process.exit(1);
}
console.log(`OK -> ${path.relative(process.cwd(), outFile)} (${kb} KB, 无外部依赖)`);

