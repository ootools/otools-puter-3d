/**
 * 跑上游的测试套件（vitest），但**跑在合成后的构建树上**。
 * ------------------------------------------------------------------
 *   node scripts/test.mjs              全量
 *   node scripts/test.mjs export home  只跑匹配的文件
 *
 * 这一点很关键：上游的 100 多个测试文件测的是 `src/**`。跑在 `.build/` 上，
 * 它们测的就是**移植后的代码**——overlay 换掉的 main.js、edits 改过的
 * home/editor/export-dialog、以及被删掉评审之后剩下的部分。上游的回归
 * 因此直接变成了移植层的回归。
 *
 * 已知会有少数用例跟移植点相冲（比如断言「登录后可以存到 Puter」）。这些在
 * 移植层没有意义，改法是改测试——但**不要改 upstream/ 里的测试**，而是在
 * `shell/overlay/tests/` 里放一份替换版（overlay 机制对测试目录同样生效）。
 */
import process from 'node:process';
import { spawnSync } from 'node:child_process';

import { prepareTree, vitestBin } from './tree.mjs';

const { buildDir } = prepareTree();
const vitest = vitestBin();
if (!vitest) {
  console.error('找不到 vitest。先在仓库根执行：npm install');
  process.exit(1);
}

const filters = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const args = [vitest, 'run', ...filters];

console.log(`\n$ vitest run ${filters.join(' ')}`.trimEnd());
const status = spawnSync(process.execPath, args, { cwd: buildDir, stdio: 'inherit' }).status ?? 1;
process.exit(status);
