/**
 * 合成构建树（build tree）。
 * ------------------------------------------------------------------
 * 这是整个插件构建的核心，也是「`upstream/` 一行都不改」这句话的实现方式：
 *
 *   .build/  =  upstream/            （上游快照，原样拷贝）
 *            +  shell/overlay/       （整文件替换：入口 HTML、vite 配置、main.js）
 *            +  shell/src/           （新增模块：宿主桥、本地磁盘后端、界面胶水）
 *            +  shell/edits.mjs      （外科手术式字符串替换，逐条校验命中次数）
 *            -  shell/drop.mjs       （删除只服务 Puter 云 / 在线评审的文件）
 *
 * 合成完成后 `.build/` 是一个正常的 Vite 工程，可以直接 build / dev / test。
 * 任何一步对不上（overlay 目标不存在、edit 命中次数不符、drop 之后缺文件），
 * 都在这里立刻失败并说清楚是哪一条——上游改动引起的移植失配应该在 CI 上炸，
 * 而不是变成发布包里一个说不清的行为差异。
 *
 * 为什么是「就地覆盖 + 清扫」而不是「先删光再拷」：
 * 一是快（第二次构建只写真正变化的文件）；二是不会出现「删到一半失败留下
 * 一个残缺的构建树」这种状态——每一次 prepareTree 结束，`.build/` 要么是
 * 上一次的完整结果，要么是这一次的完整结果。清扫只删「上一次有、这一次
 * 不该有」的文件，数量本来就很少；真需要重来一次，手动删掉 `.build/` 即可。
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { edits } from '../shell/edits.mjs';
import { drops, keep } from '../shell/drop.mjs';

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const buildDir = path.join(repoRoot, '.build');
export const distDir = path.join(repoRoot, 'dist');

/** 清扫时一次删太多文件就停下来问人（避免误删整棵树）。 */
const SWEEP_LIMIT = 40;

const log = (...args) => console.log(...args);

/** 递归列出目录下的文件（相对路径，POSIX 分隔符）。 */
function walk(dir, base = dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    const stat = fs.lstatSync(full);
    if (stat.isDirectory()) walk(full, base, out);
    else if (stat.isFile()) out.push(path.relative(base, full).split(path.sep).join('/'));
  }
  return out;
}

/** 删掉目录下所有空的子目录（只删空目录；删不掉就算了，空目录不影响 vite）。 */
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
          /* 空目录留着也无所谓 */
        }
      }
    }
  }
}

function mustExist(target, what) {
  if (!fs.existsSync(target)) {
    throw new Error(`${what}不存在：${path.relative(repoRoot, target)}\n（先跑 node scripts/sync-upstream.mjs 拉上游快照）`);
  }
}

function readUpstreamLock() {
  const lockPath = path.join(repoRoot, 'upstream.lock.json');
  if (!fs.existsSync(lockPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  } catch (err) {
    throw new Error(`upstream.lock.json 解析失败：${err.message}`);
  }
}

/** 把 source 下的文件按相对路径拷到 dest（覆盖同名，自动建父目录）。 */
function copyInto(source, dest, { prefix = '', skip = null } = {}) {
  const files = walk(source);
  const copied = [];
  for (const relative of files) {
    if (skip && skip(relative)) continue;
    const target = path.join(dest, prefix, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(source, relative), target);
    copied.push(prefix ? `${prefix}/${relative}` : relative);
  }
  return { files, copied };
}

/** 路径是否落在某个被删条目下。 */
function underDrop(relative) {
  return drops.some((drop) => relative === drop || relative.startsWith(`${drop}/`));
}

/**
 * 删除一批文件。
 *
 * 刻意**不删目录**：一是递归删目录在这种带删除守卫的环境里会被拦，
 * 二是空目录对 vite 没有任何影响。文件级的删除数量本来就是可控的
 * （被删的只有评审/云那几块），所以这里只删文件，目录交给
 * pruneEmptyDirs 顺手收尾。
 */
function removeFilesUnder(root, relative) {
  const full = path.join(root, relative);
  if (!fs.existsSync(full)) return 0;
  const stat = fs.lstatSync(full);
  if (stat.isFile()) {
    fs.rmSync(full, { force: true });
    return 1;
  }
  let removed = 0;
  for (const nested of walk(full)) {
    fs.rmSync(path.join(full, nested), { force: true });
    removed += 1;
  }
  return removed;
}

/**
 * 合成 `.build/`。
 * @returns {{buildDir: string, stats: object}}
 */
export function prepareTree() {
  const upstreamDir = path.join(repoRoot, 'upstream');
  mustExist(upstreamDir, '上游快照 upstream/');
  fs.mkdirSync(buildDir, { recursive: true });

  // 1) 上游快照 → .build/（覆盖式；被删条目直接不拷，上游删掉的文件由后面的清扫收尾）
  const { files: upstreamFiles } = copyInto(upstreamDir, buildDir, { skip: underDrop });

  // 2) shell/overlay/ → .build/（整文件替换；目标必须已存在，否则就是路径写错了）
  const overlayDir = path.join(repoRoot, 'shell', 'overlay');
  const overlayFiles = fs.existsSync(overlayDir) ? walk(overlayDir) : [];
  for (const relative of overlayFiles) {
    const target = path.join(buildDir, relative);
    if (!fs.existsSync(target)) {
      throw new Error(`shell/overlay/${relative} 没有对应的上游文件。新增模块请放 shell/src/，不要放 overlay/。`);
    }
    fs.copyFileSync(path.join(overlayDir, relative), target);
  }

  // 3) shell/src/ → .build/src/（新增模块；不允许覆盖上游文件）
  const srcDir = path.join(repoRoot, 'shell', 'src');
  const addedFiles = fs.existsSync(srcDir) ? copyInto(srcDir, path.join(buildDir, 'src')).copied : [];
  for (const relative of addedFiles) {
    if (upstreamFiles.includes(`src/${relative}`)) {
      throw new Error(`shell/src/${relative} 会覆盖上游的 src/${relative}。要覆盖请放 shell/overlay/src/${relative}。`);
    }
  }

  // 3b) shell/tests/ → .build/tests/（移植层自己的测试；同样不许覆盖上游的测试）
  // 放在 tests/ 下是为了让 `node scripts/test.mjs` 一次跑完两边——上游的回归
  // 与移植层的回归在同一个 vitest 进程里。
  const testsDir = path.join(repoRoot, 'shell', 'tests');
  const addedTests = fs.existsSync(testsDir) ? copyInto(testsDir, path.join(buildDir, 'tests')).copied : [];
  for (const relative of addedTests) {
    if (upstreamFiles.includes(`tests/${relative}`)) {
      throw new Error(`shell/tests/${relative} 会覆盖上游的 tests/${relative}。要替换上游测试请放 shell/overlay/tests/${relative}。`);
    }
  }

  // 4) 逐条应用 edits.mjs
  const failures = [];
  for (const edit of edits) {
    const target = path.join(buildDir, edit.file);
    if (!fs.existsSync(target)) {
      failures.push(`${edit.file}：文件不存在`);
      continue;
    }
    const before = fs.readFileSync(target, 'utf8');
    const expect = edit.expect ?? 1;
    const hits = before.split(edit.find).length - 1;
    if (hits !== expect) {
      failures.push(`${edit.file}：命中 ${hits} 次，期望 ${expect} 次\n    原因：${edit.why}\n    查找片段：${JSON.stringify(edit.find.slice(0, 140))}`);
      continue;
    }
    if (edit.find === edit.replace) {
      failures.push(`${edit.file}：find 与 replace 相同（空改动）\n    原因：${edit.why}`);
      continue;
    }
    fs.writeFileSync(target, before.split(edit.find).join(edit.replace));
  }
  if (failures.length) {
    throw new Error(`有 ${failures.length} 条移植改动对不上上游（上游大概改了这段代码）：\n  - ${failures.join('\n  - ')}`);
  }

  // 5) 收尾：上一次构建留下的、属于被删条目的文件（正常情况下是 0 个）
  let dropped = 0;
  for (const relative of drops) dropped += removeFilesUnder(buildDir, relative);
  for (const relative of keep) {
    if (!fs.existsSync(path.join(buildDir, relative))) {
      throw new Error(`删完之后缺少必需文件：${relative}（检查 shell/drop.mjs 与 shell/edits.mjs）`);
    }
  }

  // 6) 清扫：删掉「上一次构建有、这一次不该有」的残留（上游删文件、改了 overlay 路径…）
  const expected = new Set();
  for (const relative of upstreamFiles) if (!underDrop(relative)) expected.add(relative);
  for (const relative of overlayFiles) expected.add(relative);
  for (const relative of addedFiles) expected.add(`src/${relative}`);
  for (const relative of addedTests) expected.add(`tests/${relative}`);
  const stale = walk(buildDir).filter((relative) => !expected.has(relative));
  if (stale.length > SWEEP_LIMIT) {
    throw new Error(`构建树里有 ${stale.length} 个不该存在的文件（上限 ${SWEEP_LIMIT}）。\n这通常是上游一次删了很多文件。请手动删掉 .build/ 后重跑。`);
  }
  for (const relative of stale) fs.rmSync(path.join(buildDir, relative), { force: true });
  pruneEmptyDirs(buildDir);

  const lock = readUpstreamLock();
  const stats = { files: upstreamFiles.length, overlay: overlayFiles.length, added: addedFiles.length, tests: addedTests.length, patched: edits.length, dropped, swept: stale.length };
  log(`合成 .build/：上游 ${stats.files} 个文件，覆盖 ${stats.overlay} 个，新增 ${stats.added} 个模块 + ${stats.tests} 个测试，改动 ${stats.patched} 条，删除 ${stats.dropped} 项，清扫 ${stats.swept} 个残留`);
  if (lock?.commit) {
    log(`上游：${lock.repo} ${lock.subpath} @ ${String(lock.commit).slice(0, 12)}（${lock.commitDate || '日期未知'}）`);
  }
  return { buildDir, stats };
}

/**
 * 构建产物目录的清扫。
 *
 * Vite 的 `emptyOutDir` 会把 dist/ 整个删掉——在 CI 上没问题，但在本地开发时
 * 那是一次几百个文件的批量删除，既慢又危险。所以配置里关掉了它，改在这里按
 * **「这一次构建真正产出了什么」** 做差集：留在 dist/ 但不在产出清单里的文件删掉。
 *
 * 关键在于清单必须来自**构建的输出**（Vite 的 JS API 会把 emit 出来的每个文件
 * 报回来），而不是来自「构建之后 dist/ 里有什么」——后者会把上一轮的残留一起
 * 记进清单，于是差集永远为空，旧 chunk 会一轮一轮堆下去。
 *
 * @param {Set<string>} emitted 本次构建产出的文件（相对 dist/ 的路径）
 */
export function sweepDist(emitted) {
  const keep = emitted instanceof Set ? emitted : new Set(emitted || []);
  const onDisk = walk(distDir);
  if (!keep.size) {
    // 没有产出清单就别动——宁可留几个旧 chunk，也不要误删整个 dist/。
    return { files: onDisk.length, removed: 0, skipped: true };
  }
  const stale = onDisk.filter((relative) => !keep.has(relative));
  if (stale.length > SWEEP_LIMIT) {
    return { files: onDisk.length, removed: 0, skipped: true, stale: stale.length };
  }
  for (const relative of stale) {
    const target = path.join(distDir, relative);
    if (fs.existsSync(target)) fs.rmSync(target, { force: true });
  }
  pruneEmptyDirs(distDir);
  return { files: onDisk.length - stale.length, removed: stale.length };
}

/**
 * 从 Vite JS API 的返回值里收集「本次构建产出了哪些文件」（相对 dist/ 的路径）。
 *
 * rollup 的 output 里只有打包产物；`public/` 是 vite 自己拷到 dist/ 根下的，
 * 不在 output 里，所以要另外算上——否则它们会被当成残留删掉。
 */
export function collectEmitted(result) {
  const emitted = new Set();
  const outputs = Array.isArray(result) ? result : [result];
  for (const out of outputs) {
    for (const item of out?.output || []) {
      if (item && item.fileName) emitted.add(String(item.fileName).split(path.sep).join('/'));
    }
  }
  const publicDir = path.join(buildDir, 'public');
  if (fs.existsSync(publicDir)) for (const relative of walk(publicDir)) emitted.add(relative);
  return emitted;
}

/** 找 Vite 的可执行入口（仓库根 node_modules 里那份）。 */
export function viteBin() {
  const candidates = [
    path.join(repoRoot, 'node_modules', 'vite', 'bin', 'vite.js'),
    path.join(repoRoot, 'node_modules', '.bin', 'vite'),
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return null;
}

export function vitestBin() {
  const candidates = [
    path.join(repoRoot, 'node_modules', 'vitest', 'vitest.mjs'),
    path.join(repoRoot, 'node_modules', '.bin', 'vitest'),
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return null;
}

export { walk };
