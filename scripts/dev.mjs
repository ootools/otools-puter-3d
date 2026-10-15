/**
 * 开发服务器：合成 .build/ 后跑 `vite`（HMR），端口 5517。
 * ------------------------------------------------------------------
 *   node scripts/dev.mjs
 *
 * 注意：开发态下宿主不在，页面会退回上游的浏览器本地存储（OPFS），
 * 导入/导出走浏览器自己的对话框。要看宿主的真实行为，用
 * `node scripts/build.mjs && pwsh -File scripts/deploy-to-otools.ps1`。
 *
 * 想要「假宿主」调试宿主桥本身，见 README「开发」一节里的
 * `window.otoolsVideo` 桩示例。
 */
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';

import { repoRoot, prepareTree, viteBin } from './tree.mjs';

const { buildDir } = prepareTree();
const vite = viteBin();
if (!vite) {
  console.error('找不到 vite。先在仓库根执行：npm install');
  process.exit(1);
}

console.log(`\n$ vite  (root=${path.relative(repoRoot, buildDir)})`);
const status = spawnSync(process.execPath, [vite], { cwd: buildDir, stdio: 'inherit' }).status ?? 1;
process.exit(status);
