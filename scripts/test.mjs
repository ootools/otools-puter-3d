/**
 * 跑测试。**默认只跑移植层自己的测试**，上游套件要显式开。
 * ------------------------------------------------------------------
 *   node scripts/test.mjs                只跑移植层测试（CI 用的就是这个）
 *   node scripts/test.mjs --upstream     再加上游的测试套件
 *   node scripts/test.mjs i18n           在默认范围里按名字过滤
 *   node scripts/test.mjs --upstream export home   上游套件里只跑匹配的文件
 *
 * ## 为什么默认不跑上游那900 多个测试
 *
 * 这个插件的定位是**把上游应用搬进 OTools 宿主，不改它的核心逻辑**。文档
 * 引擎、表格引擎、演示文稿渲染这些代码原样来自上游（`upstream/` 有内容哈希
 * 锁定，`scripts/sync-upstream.mjs --check` 会验），它们的行为对不对由上游负责。
 * 我们的回归责任只有两层：
 *
 *   1. **移植层能构建**：`prepareTree()` 成功——overlay 目标存在、
 *      `edits.mjs` 每条都命中预期次数、`drop.mjs` 删完不缺文件。上游改了
 *      那些代码导致移植失配，会在这里直接炸，而不是变成发布包里一个说不清
 *      的行为差异。
 *   2. **移植层自己的代码对**：`shell/tests/` 下的用例（宿主桥、多语言、
 *      本地磁盘后端等）。
 *
 * 上游套件在这个前提下有两个硬伤，跑它只会得到一片和移植无关的红：
 *
 *   - **夹具没进快照**。`sync-upstream.mjs` 的 `EXCLUDE_PATHS` 裁掉了
 *     `tests/fixtures` 与 `public/fixtures`（在上游是 303 MB / 9868 个 .docx
 *     样本，不值得让仓库从 51 MB 涨到 350 MB）。于是 documents 有 638 个
 *     测试在 import 期就`readFileSync()` 读夹具、直接 ENOENT 崩掉。
 *   - **断言基于 Puter 的产品形态**。比如上游断言 `canSignOut('web')`
 *     为真，而插件版根本没有 Puter 账号这回事（`shell/overlay/src/` 把它
 *     换成了恒 false）。这类冲突要靠人工判断「是移植改对了还是改坏了」，
 *     不是 CI 该自动判的。
 *
 * 想跑上游套件、亲自核对某个模块时，用 `--upstream`。它的结果是**参考**
 * 而不是门禁：看到失败要先判断是不是上面这两类原因。
 */
import process from 'node:process';
import { spawnSync } from 'node:child_process';

import { prepareTree, vitestBin } from './tree.mjs';

const argv = process.argv.slice(2);
const withUpstream = argv.includes('--upstream');
const filters = argv.filter((a) => !a.startsWith('--'));

const { buildDir } = prepareTree();
const vitest = vitestBin();
if (!vitest) {
  console.error('找不到 vitest。先在仓库根执行：npm install');
  process.exit(1);
}

const args = [vitest, 'run'];

// 移植层自己的测试在 .build/tests/ 下，文件名就是 shell/tests/ 里的那些。
// 用位置参数把它们捞出来；`--upstream` 时不加限制，交给 vite.config.js 的
// include/exclude 去管（那里会剔掉依赖夹具的用例）。
if (!withUpstream) {
  const layer = filters.length
    ? filters
    : ['tests/i18n.test.js', 'tests/dom-i18n.test.js'];
  args.push(...layer);
} else {
  args.push(...filters);
}

const scope = withUpstream ? '移植层 + 上游' : '仅移植层';
console.log(`\n$ ${args.join(' ')}   （范围：${scope}）`.trimEnd());
const status = spawnSync(process.execPath, args, { cwd: buildDir, stdio: 'inherit' }).status ?? 1;

if (!withUpstream) {
  console.log('\n提示：上游测试套件不在默认范围内（见本文件顶部说明）。');
  console.log('      需要时用 `node scripts/test.mjs --upstream`，结果是参考而非门禁。');
}
process.exit(status);