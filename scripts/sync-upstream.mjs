/**
 * 同步上游快照到 `upstream/`，并写下 `upstream.lock.json`。
 * ------------------------------------------------------------------
 *   node scripts/sync-upstream.mjs                 从 GitHub 稀疏拉取最新 main
 *   node scripts/sync-upstream.mjs --ref <ref>     拉指定分支/标签/提交
 *   node scripts/sync-upstream.mjs --from <dir>    用本机已有的 everything 克隆
 *   node scripts/sync-upstream.mjs --check         只校验 upstream/ 与 lock 是否一致
 *
 * 为什么不是 `git subtree`？
 * -------------------------
 * otools-cadcraft 用的是 `git subtree`，因为上游 `storytold/cadcraft` 是一个
 * 独立仓库。这里的上游不同：Video Studio 是 `HeyPuter/everything` **单体仓库**
 * 里的一个子目录（`src/video-studio`），同一个仓库里还有 40 多个别的应用，
 * 整个 checkout 约 1.7 GB。`git subtree` 只能整仓拉，挂进来会让本仓库每次
 * clone 都变成 1.7 GB —— 为了一个 17 MB 的目录付这个代价没有道理。
 *
 * 所以这里用「稀疏检出 + 快照 + 内容哈希锁定」：
 *   - `upstream/` 是 `src/video-studio` 在某个提交上的**原样快照**，
 *     与 subtree 一样：**不要就地改**，改动一律进 `shell/`；
 *   - `upstream.lock.json` 记下仓库、子路径、提交号、提交时间与整棵树的
 *     内容哈希，`--check` 能验证快照有没有被动过；
 *   - 更新上游就是重跑本脚本，然后用 `git diff upstream/` 看上游改了什么。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const UPSTREAM_DIR = path.join(repoRoot, 'upstream');
const LOCK_PATH = path.join(repoRoot, 'upstream.lock.json');

/** 上游仓库与要移植的子目录。 */
const REPO = 'HeyPuter/everything';
const REPO_URL = `https://github.com/${REPO}.git`;
const SSH_URL = `git@github.com:${REPO}.git`;
/** 本插件移植的是上游单体仓库里的这一个子目录。 */
const SUBPATH = 'src/3d';

/** 不进入快照的东西：上游自己的构建产物与本地夹具。 */
const EXCLUDE = new Set(['node_modules', '.dev-media', 'dist', 'target', 'e2e']);
/** 按项目裁掉的额外路径（构建产物、评审 worker 之类）。 */
const EXCLUDE_PATHS = ["docs/screenshots"];

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : fallback;
}
const has = (name) => process.argv.includes(`--${name}`);

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...options });
  if (result.error || result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} 失败：${result.error?.message || result.stderr || result.stdout}`);
  }
  return (result.stdout || '').trim();
}

/** 递归收集文件（相对路径，POSIX 分隔符），跳过排除项。 */
function walk(dir, base = dir, out = []) {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    const relative = path.relative(base, full).split(path.sep).join('/');
    // 任一路径段命中排除名就跳过：node_modules/、dist/、wasm/target/、.dev-media/…
    if (relative.split('/').some((part) => EXCLUDE.has(part))) continue;
    if (EXCLUDE_PATHS.some((p) => relative === p || relative.startsWith(`${p}/`))) continue;
    const stat = fs.lstatSync(full);
    if (stat.isDirectory()) walk(full, base, out);
    else if (stat.isFile()) out.push(relative);
  }
  return out;
}

/** 整棵树的内容哈希：路径 + 大小 + 内容，按路径排序。 */
function treeHash(dir) {
  const files = walk(dir).sort();
  const hash = createHash('sha256');
  for (const relative of files) {
    const data = fs.readFileSync(path.join(dir, relative));
    hash.update(relative);
    hash.update('\0');
    hash.update(String(data.length));
    hash.update('\0');
    hash.update(createHash('sha256').update(data).digest());
    hash.update('\n');
  }
  return { hash: hash.digest('hex'), files: files.length };
}

function readLock() {
  if (!fs.existsSync(LOCK_PATH)) return null;
  try {
    return JSON.parse(fs.readFileSync(LOCK_PATH, 'utf8'));
  } catch {
    return null;
  }
}

function check() {
  if (!fs.existsSync(UPSTREAM_DIR)) {
    console.error('✗ upstream/ 不存在，先跑一次同步。');
    process.exit(1);
  }
  const lock = readLock();
  if (!lock) {
    console.error('✗ upstream.lock.json 不存在或无法解析。');
    process.exit(1);
  }
  const { hash, files } = treeHash(UPSTREAM_DIR);
  if (hash !== lock.treeHash) {
    console.error('✗ upstream/ 与 upstream.lock.json 不一致（有人就地改过上游快照？）');
    console.error(`  lock: ${lock.treeHash}`);
    console.error(`  实际: ${hash}（${files} 个文件，lock 记的是 ${lock.fileCount} 个）`);
    console.error('  移植改动请放 shell/；如果是故意改的，重跑同步脚本刷新 lock。');
    process.exit(1);
  }
  console.log(`✓ upstream/ 与 lock 一致：${REPO} ${SUBPATH} @ ${lock.commit.slice(0, 12)}，${files} 个文件`);
}

/** 删掉目录下所有空的子目录（删不掉就算了，空目录不影响任何事）。 */
function pruneEmptyDirs(dir) {
  if (!fs.existsSync(dir)) return;
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    if (fs.statSync(full).isDirectory()) {
      pruneEmptyDirs(full);
      if (fs.readdirSync(full).length === 0) {
        try {
          fs.rmdirSync(full);
        } catch {
          /* 忽略 */
        }
      }
    }
  }
}

/**
 * 稀疏克隆上游。
 *
 * `--filter=blob:none + --sparse`：只下要的那棵子树，1.7 GB 的仓库几秒就够。
 *
 * 先试 https，失败再试 ssh：https 是规范地址（写进 lock 的 url 就是它），
 * 但在某些网络环境里 https 的 CONNECT 隧道会被代理挡掉，而 ssh 通。两条都不通
 * 才真的失败——报错里把两条都列出来，省得排查时再猜是哪条路的问题。
 */
function cloneSparse(ref, tempDir) {
  const args = ['clone', '--depth', '1', '--filter=blob:none', '--sparse', '--branch', ref];
  const attempts = [REPO_URL, SSH_URL];
  let lastError = '';
  for (const url of attempts) {
    const result = spawnSync('git', [...args, url, tempDir], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (!result.error && result.status === 0) return;
    lastError = result.error?.message || result.stderr || result.stdout || '';
    console.warn(`  ${url} 克隆失败，换下一条：${String(lastError).trim().split('\n')[0]}`);
    // 失败会留下一个半初始化的目录，下一次尝试会因为「目录非空」直接失败。
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
  throw new Error(`两条路都克隆不了 ${REPO}：\n${lastError}`);
}

function main() {
  if (has('check')) {
    check();
    return;
  }

  const from = arg('from');
  const ref = arg('ref', 'main');
  let sourceDir = null;
  let tempDir = null;

  if (from) {
    sourceDir = path.resolve(from, SUBPATH);
    if (!fs.existsSync(sourceDir)) throw new Error(`--from 里没有 ${SUBPATH}：${sourceDir}`);
  } else {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'otools-puter-upstream-'));
    console.log(`稀疏克隆 ${REPO} @ ${ref} → ${tempDir}`);
    cloneSparse(ref, tempDir);
    run('git', ['-C', tempDir, 'sparse-checkout', 'set', SUBPATH]);
    sourceDir = path.join(tempDir, SUBPATH);
  }

  const cloneRoot = path.dirname(path.dirname(sourceDir));
  const commit = run('git', ['-C', cloneRoot, 'rev-parse', 'HEAD']);
  const commitDate = run('git', ['-C', cloneRoot, 'log', '-1', '--format=%cI']);

  // 覆盖式同步：先拷新内容，再删「源里已经没有」的残留。
  // 不做「先删光再拷」——一是快，二是失败时不会留下半个空目录。
  console.log(`同步 ${sourceDir} → upstream/`);
  fs.mkdirSync(UPSTREAM_DIR, { recursive: true });
  const wanted = walk(sourceDir).sort();
  for (const relative of wanted) {
    const target = path.join(UPSTREAM_DIR, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(sourceDir, relative), target);
  }
  const have = new Set(wanted);
  let removed = 0;
  for (const relative of walk(UPSTREAM_DIR)) {
    if (have.has(relative)) continue;
    fs.rmSync(path.join(UPSTREAM_DIR, relative), { force: true });
    removed += 1;
  }
  pruneEmptyDirs(UPSTREAM_DIR);

  const { hash, files } = treeHash(UPSTREAM_DIR);
  const lock = {
    repo: REPO,
    url: REPO_URL,
    subpath: SUBPATH,
    ref,
    commit,
    commitDate,
    fetchedAt: new Date().toISOString(),
    fileCount: files,
    treeHash: hash,
    note: `upstream/ 是此提交下 ${SUBPATH} 的原样快照，不要就地修改；移植改动放 shell/。`,
  };
  fs.writeFileSync(LOCK_PATH, `${JSON.stringify(lock, null, 2)}\n`);

  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });

  console.log(`\n✓ 已同步 ${files} 个文件${removed ? `（清掉 ${removed} 个残留）` : ''}`);
  console.log(`  ${REPO} ${SUBPATH} @ ${commit.slice(0, 12)}（${commitDate}）`);
  console.log(`  treeHash ${hash.slice(0, 16)}…`);
  console.log('\n下一步：git diff upstream/ 看上游改了什么，然后把变化同步进 shell/。');
}

try {
  main();
} catch (error) {
  console.error(`\n同步失败：${error.message}`);
  process.exit(1);
}
