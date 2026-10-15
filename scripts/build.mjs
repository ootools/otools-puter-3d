/**
 * 构建 OTools 插件前端。
 * ------------------------------------------------------------------
 *   node scripts/build.mjs            合成 .build/ → vite build → dist/
 *   node scripts/build.mjs --tree     只合成 .build/，不跑 vite（排查移植改动时用）
 *   node scripts/build.mjs --minify=0 关掉压缩（读产物、比对差异时用）
 *
 * 产物 `dist/` 就是 `plugin.json` 的 `entry: dist/index.html` 指向的东西，
 * 由宿主用 `otools-plugin://<uuid>/dist/index.html` 提供。
 *
 * 依赖（`npm install` 一次即可）：vite、@fontsource/*、lucide、mediabunny、
 * @mediapipe/tasks-vision。不需要 Rust、不需要 Puter。
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { build as viteBuild } from 'vite';

import { repoRoot, distDir, prepareTree, sweepDist, collectEmitted, viteBin } from './tree.mjs';

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const has = (name) => process.argv.includes(`--${name}`);

async function main() {
  const { buildDir } = prepareTree();
  if (has('tree')) {
    console.log(`\n只合成了构建树：${path.relative(repoRoot, buildDir)}`);
    return;
  }
  if (!viteBin()) {
    console.error('找不到 vite。先在仓库根执行：npm install');
    process.exit(1);
  }

  console.log('\n$ vite build');
  // 走 Vite 的 JS API 而不是命令行：返回值里带着本次 emit 出来的每个文件名，
  // 这正是 sweepDist 需要的「产出清单」（见 tree.mjs 里 sweepDist 的注释）。
  const emitted = collectEmitted(await viteBuild({
    root: buildDir,
    build: arg('minify') === '0' ? { minify: false } : {},
  }));

  const swept = sweepDist(emitted);
  if (swept.skipped) {
    console.log(`dist/ 清扫：跳过（${swept.stale ? `有 ${swept.stale} 个残留，超过上限` : '没有产出清单'}）。需要干净产物请手动删掉 dist/。`);
  } else if (swept.removed) {
    console.log(`dist/ 清扫：删掉 ${swept.removed} 个上一次构建的残留`);
  }

  // 入口自检：plugin.json 的 entry 必须真的存在，而且必须带着宿主桥的痕迹。
  const entry = path.join(distDir, 'index.html');
  if (!fs.existsSync(entry)) {
    console.error(`构建产物里没有 ${path.relative(repoRoot, entry)}，但 plugin.json 的 entry 指向它。`);
    process.exit(1);
  }
  const html = fs.readFileSync(entry, 'utf8');
  if (!html.includes('./assets/')) {
    console.error('入口 HTML 里没有相对路径的 assets/ 引用——宿主用 otools-plugin:// 提供插件，必须是相对路径。');
    process.exit(1);
  }
  if (/<script[^>]+src=["'][^"']*puter\.com/i.test(html)) {
    console.error('入口 HTML 里还有指向 puter.com 的 <script src>——插件不应该加载 Puter SDK。');
    process.exit(1);
  }

  const size = (file) => `${(fs.statSync(file).size / 1048576).toFixed(2)} MB`;
  const total = [];
  const walkDist = (dir, base = dir) => {
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      if (fs.statSync(full).isDirectory()) walkDist(full, base);
      else total.push([path.relative(base, full).split(path.sep).join('/'), fs.statSync(full).size]);
    }
  };
  walkDist(distDir);
  total.sort((a, b) => b[1] - a[1]);
  const bytes = total.reduce((sum, [, n]) => sum + n, 0);
  console.log(`\ndist/ 共 ${total.length} 个文件，${(bytes / 1048576).toFixed(2)} MB。最大的几个：`);
  for (const [name, n] of total.slice(0, 8)) console.log(`  ${size(path.join(distDir, name))}  ${name}`);
  console.log('\n下一步：node scripts/pack-plugin.mjs 打包，或 node scripts/serve-dist.mjs 本地预览。');
}

try {
  await main();
} catch (error) {
  console.error(`\n构建失败：${error.message}`);
  process.exit(1);
}
