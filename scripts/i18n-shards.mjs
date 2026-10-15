#!/usr/bin/env node
/**
 * i18n 缺口分片工具。
 * ------------------------------------------------------------------
 * 全量补词有几千条，一次性盯着屏幕改不动，也没法中途保存进度。这个脚本把
 * 「缺口」和「译文」在中间用一个 JSON 文件衔接起来：
 *
 *   --export [目录前缀]   导出未覆盖的缺口成 JSON 分片，可反复调用、按目录分批
 *   --apply               把 JSON 里的译文合并进词典（跳过空值与重复键）
 *   --status              看当前进度：词典多少条、还剩多少缺口
 *   --visible             只导出「用户可能看到」的缺口（滤掉 vendor/engine 等内部文案）
 *
 * 分片 JSON 结构：
 *   {
 *     "repo": "otools-puter-documents",
 *     "exportedAt": "2026-10-15T10:00:00.000Z",
 *     "items": [
 *       { "key": "Align left", "count": 3, "files": ["upstream/src/ui/toolbar.js"] }
 *     ]
 *   }
 *
 * 翻译时只需在 items 里加一个 `zh` 字段，然后 `--apply`。
 *
 * 设计取舍：
 *   - **不校验译文质量**。这里只做机械合并，语义校对靠人（或 review 时看 diff）。
 *   - **保留已有译文**。`--apply` 只加不删，避免误覆盖手工精修过的词条。
 *   - **键必须逐字符一致**。含省略号 `…`、弯引号 `’`、末尾 `...` 的差异都会让
 *     译文静默失效，所以导出时原样带出，应用时原样写入。
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const catalogPath = path.join(repoRoot, 'shell', 'src', 'otools', 'i18n.zh-CN.js');
const commonPath = path.join(repoRoot, 'shell', 'src', 'otools', 'i18n.common.zh-CN.js');
const upstreamSrc = path.join(repoRoot, 'upstream', 'src');
const shardDir = path.join(repoRoot, '.i18n-shards');

const has = (name) => process.argv.includes(`--${name}`);
const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && !process.argv[i + 1]?.startsWith('--') ? process.argv[i + 1] : null;
};

const SRC_EXTS = new Set(['.js', '.mjs', '.ts', '.tsx', '.jsx', '.vue', '.svelte']);

// 与 i18n-report.mjs 保持一致：界面文案形状判定
const NOT_UI = [
  /^[.#][\w.\-:[\]="' >+~,()]*$/,
  /^[a-z0-9]+(?:[A-Z][a-z0-9]*)+$/,
  /^[a-z][a-z0-9-]*$/,
  /^(?:https?:|\/|\.\/|\.\.\/|data:|blob:|@)/,
  /^[A-Z0-9_]+$/,
  /^[\w-]+\/[\w.+-]+$/,
  /^(?:Arrow|Digit|Numpad|Key)[A-Za-z]+$/,
  /^[\w.-]+\.(?:js|json|css|png|svg|mp4|mp3|wav|cube|tflite|task|wasm|txt)$/,
  /^\d/,
  /[{}<>=;|&$]/,
  /^[\w-]*[._][\w-]*$/,
];

const CONTEXT_RULES = [
  { re: /(?:^|[\s{,(])(?:label|title|heading|hint|note|description|placeholder|text|okLabel|cancelLabel|confirm|cancel|ok|tip|unit|why|reason|message|empty|sub|body|summary)\s*:\s*(['"])((?:[^'"\\\n]|\\.){2,140})\1/g, group: 2 },
  { re: /['"](?:aria-label|data-tip|aria-labelledby|aria-describedby)['"]\s*:\s*(['"])((?:[^'"\\\n]|\\.){2,140})\1/g, group: 2 },
  { re: /\bh\(\s*(['"])[^'"]*\1\s*,\s*(['"])((?:[^'"\\\n]|\\.){3,140})\2/g, group: 3 },
  { re: /\bh\(\s*(['"])[^'"]*\1\s*,\s*\{[^{}]*\}\s*,\s*(['"])((?:[^'"\\\n]|\\.){3,140})\2/g, group: 3 },
  { re: /\bemptyState\(\s*(['"])[^'"]*\1\s*,\s*(['"])((?:[^'"\\\n]|\\.){3,140})\2/g, group: 3 },
  { re: /\.textContent\s*=\s*(['"])((?:[^'"\\\n]|\\.){3,140})\1/g, group: 2 },
  { re: /\b(?:alert|confirm|toast|notify|status|message|error)\(\s*(['"])((?:[^'"\\\n]|\\.){3,140})\1/g, group: 2 },
  { re: /(?:^|\s)(?:title|label|name|text)\s*=\s*(['"])((?:[^'"\\\n]|\\.){2,140})\1/g, group: 2 },
];

// 内部实现细节：vendor 第三方库、engine 引擎内部报错——用户看不到
const INTERNAL_DIR = /^(vendor|engine)\//;

function walk(dir, out = []) {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    const st = fs.statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (SRC_EXTS.has(path.extname(name).toLowerCase())) out.push(full);
  }
  return out;
}

function extractFrom(source) {
  const found = new Map();
  for (const rule of CONTEXT_RULES) {
    const re = new RegExp(rule.re.source, rule.re.flags);
    let m;
    while ((m = re.exec(source))) {
      const raw = m[rule.group];
      if (!raw) continue;
      const v = raw.replace(/\\'/g, "'").replace(/\\"/g, '"').replace(/\\n/g, ' ');
      if (v.length < 3 || v.length > 120) continue;
      if (!/[A-Za-z一-龥]/.test(v)) continue;
      if (NOT_UI.some((p) => p.test(v))) continue;
      if (v.includes('${')) continue;
      if (!found.has(v)) found.set(v, []);
      found.get(v).push(rule.group);
    }
  }
  return found;
}

/** 读词典（含 common 合并），返回 Map<key, zh>。 */
function readDict(file) {
  if (!fs.existsSync(file)) return new Map();
  const src = fs.readFileSync(file, 'utf8');
  const re = /^\s*(?:'((?:[^'\\\n]|\\.)+)'|"((?:[^"\\\n]|\\.)+)"|([A-Za-z_$][\w$]*))\s*:\s*(?:'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)")\s*,?\s*$/gm;
  const out = new Map();
  let m;
  while ((m = re.exec(src))) {
    const k = m[1] ?? m[2] ?? m[3];
    if (!out.has(k)) out.set(k, m[4] ?? m[5] ?? '');
  }
  return out;
}

function loadCatalog() {
  const own = readDict(catalogPath);
  const common = readDict(commonPath);
  const all = new Map(common);
  for (const [k, v] of own) all.set(k, v); // 同键以项目词典为准
  return { all, own };
}

/** 扫出所有候选文案 + 来源文件。 */
function scanCandidates() {
  const result = new Map(); // key -> { files:Set, count }
  for (const file of walk(upstreamSrc)) {
    const src = fs.readFileSync(file, 'utf8');
    const found = extractFrom(src);
    const rel = path.relative(repoRoot, file);
    for (const [text] of found) {
      if (!result.has(text)) result.set(text, { files: new Set(), count: 0 });
      const e = result.get(text);
      e.files.add(rel);
      e.count++;
    }
  }
  return result;
}

function doExport(prefix, visibleOnly) {
  const { all } = loadCatalog();
  const cands = scanCandidates();
  const items = [];
  for (const [key, info] of cands) {
    if (all.has(key)) continue;
    const isInternal = [...info.files].every((f) => {
      const m = f.match(/upstream\/src\/(.+)$/);
      return m && INTERNAL_DIR.test(m[1]);
    });
    if (visibleOnly && isInternal) continue;
    if (prefix && ![...info.files].some((f) => f.includes(prefix))) continue;
    items.push({
      key,
      count: info.count,
      files: [...info.files].slice(0, 3),
      zh: '', // 填在这里，然后 --apply
    });
  }
  items.sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));

  fs.mkdirSync(shardDir, { recursive: true });
  const name = prefix ? prefix.replace(/[\/\\]/g, '_') : 'all';
  const out = path.join(shardDir, `${name}.json`);
  fs.writeFileSync(out, JSON.stringify({
    repo: path.basename(repoRoot),
    exportedAt: new Date().toISOString(),
    total: items.length,
    items,
  }, null, 2), 'utf8');

  console.log(`导出 ${items.length} 条 → ${path.relative(repoRoot, out)}`);
  if (items.length) {
    console.log('前 10 条：');
    for (const it of items.slice(0, 10)) console.log(`  [${it.count}] ${it.key}`);
  }
}

function doApply() {
  if (!fs.existsSync(shardDir)) {
    console.error('没有 .i18n-shards 目录，先跑 --export');
    process.exit(1);
  }
  const files = fs.readdirSync(shardDir).filter((f) => f.endsWith('.json'));
  if (!files.length) {
    console.error('没有分片 JSON');
    process.exit(1);
  }

  // 收集所有译文；同一 key 冲突时报错而不是静默取一个
  const merged = new Map();
  const conflicts = [];
  let translated = 0;
  for (const f of files) {
    const shard = JSON.parse(fs.readFileSync(path.join(shardDir, f), 'utf8'));
    for (const it of shard.items || []) {
      const zh = (it.zh || '').trim();
      if (!zh) continue;
      if (zh === it.key) continue; // 没真翻
      if (merged.has(it.key) && merged.get(it.key) !== zh) {
        conflicts.push(`${it.key}: "${merged.get(it.key)}" vs "${zh}"（${f}）`);
        continue;
      }
      if (!merged.has(it.key)) translated++;
      merged.set(it.key, zh);
    }
  }

  if (conflicts.length) {
    console.error(`译文冲突 ${conflicts.length} 处，需人工裁决：`);
    for (const c of conflicts.slice(0, 10)) console.error('  ' + c);
    process.exit(1);
  }
  if (!translated) {
    console.log('没有填任何译文（zh 字段为空）');
    return;
  }

  const { own } = loadCatalog();
  const added = [...merged].filter(([k]) => !own.has(k));
  const updated = [...merged].filter(([k]) => own.has(k));

  appendToCatalog(added);

  console.log(`新增 ${added.length} 条，更新 ${updated.length} 条（更新需手工合并，脚本只追加新增）`);
  if (updated.length) {
    console.log('\n以下键词典里已有，脚本未覆盖，请人工确认：');
    for (const [k, v] of updated.slice(0, 10)) console.log(`  ${k} → ${v}`);
  }
}

/** 把新增词条追加到词典文件末尾（分区内）。 */
function appendToCatalog(entries) {
  if (!entries.length) return;
  let src = fs.readFileSync(catalogPath, 'utf8');
  const block = entries
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([k, v]) => `  ${quoteKey(k)}: ${quoteKey(v)},`)
    .join('\n');
  const marker = '\n  /* ------------------------------------------------- 续：批量补充的界面文案 */ */';
  const section = `\n  /* ------------------------------------------------- 续：批量补充的界面文案 */\n${block}\n`;
  if (src.includes('续：批量补充的界面文案')) {
    // 已有分区：替换掉旧内容
    const start = src.indexOf('  /* ------------------------------------------------- 续：批量补充的界面文案');
    const end = src.lastIndexOf('};');
    src = src.slice(0, start) + section.trimStart() + src.slice(end);
  } else {
    const end = src.lastIndexOf('};');
    src = src.slice(0, end).replace(/\n+$/, '\n') + section + src.slice(end);
  }
  fs.writeFileSync(catalogPath, src, 'utf8');
  console.log(`已写入 ${path.relative(repoRoot, catalogPath)}`);
}

function quoteKey(s) {
  return /^[A-Za-z_$][\w$]*$/.test(s) && !/[.…’']/.test(s)
    ? s
    : `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

function doStatus() {
  const { all, own } = loadCatalog();
  const cands = scanCandidates();
  const missing = [];
  let internal = 0;
  for (const [key, info] of cands) {
    if (all.has(key)) continue;
    const isInternal = [...info.files].every((f) => {
      const m = f.match(/upstream\/src\/(.+)$/);
      return m && INTERNAL_DIR.test(m[1]);
    });
    if (isInternal) internal++;
    else missing.push(key);
  }
  const total = cands.size;
  console.log(`候选文案：${total} 条`);
  console.log(`词典条目：${all.size}（本项目 ${own.size} + 通用 ${all.size - own.size}）`);
  console.log(`已覆盖：${total - missing.length - internal}/${total}`);
  console.log(`未覆盖-用户可见：${missing.length}`);
  console.log(`未覆盖-内部实现：${internal}`);
}

if (has('export')) doExport(arg('export'), has('visible'));
else if (has('apply')) doApply();
else if (has('status')) doStatus();
else {
  console.log(`用法：
  node scripts/i18n-shards.mjs --status              看进度
  node scripts/i18n-shards.mjs --export [前缀]       导出缺口到 .i18n-shards/
  node scripts/i18n-shards.mjs --export views --visible   只导用户可见 + 按目录筛
  node scripts/i18n-shards.mjs --apply               把填好的译文合并进词典`);
}
