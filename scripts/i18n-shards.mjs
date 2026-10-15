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
import { pathToFileURL } from 'node:url';
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
      // `\\n` 必须还原成**真换行**，不能替换成空格。
      // 上游 tooltip 原文就是 `标题\\n说明`，渲染时按真换行 split
      // （3d 的 showTip()、presentation 的 tooltip 组件都是）。
      // 抹成空格的话词典键与 DOM 属性值逐字符不等，**运行时永远匹配不上**——
      // 提取阶段看不出任何异常，译文也确实写进去了，就是不生效。
      const v = raw.replace(/\\'/g, "'").replace(/\\"/g, '"').replace(/\\n/g, '\n');
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

/**
 * 读词典文件，返回 Map<key, zh>。
 *
 * 参数是**文件路径**。要解析已经读进内存的源码请用 `parseDict`——
 * 早先这里只有 `readDict(file)`，而重写词典的代码顺手把源码字符串传了进去，
 * `fs.existsSync(<整篇源码>)` 当然是 false，于是「读回现有词典」恒为空，
 * 每写一次就把原有词条全丢掉（2400 条 → 197 条），而语法校验照样通过。
 */
function readDict(file) {
  if (!fs.existsSync(file)) return new Map();
  return parseDict(fs.readFileSync(file, 'utf8'));
}

/**
 * 解析词典源码，返回 Map<key, zh>。
 *
 * 用**顺序扫描**而不是行正则：词典里的值可能跨行（长句、含换行的提示），
 * `^…$` 的多行锚点会漏掉它们。
 */
function parseDict(src) {
  const out = new Map();

  let i = 0;
  const isKeyStart = (c) => c === "'" || c === '"' || /[A-Za-z_$]/.test(c);

  while (i < src.length) {
    const c = src[i];
    // 注释
    if (c === '/' && src[i + 1] === '/') {
      const nl = src.indexOf('\n', i);
      i = nl < 0 ? src.length : nl + 1;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      const close = src.indexOf('*/', i);
      i = close < 0 ? src.length : close + 2;
      continue;
    }
    // `...spread` 之类，跳过
    if (c === '.' && src[i + 1] === '.' && src[i + 2] === '.') {
      i += 3;
      continue;
    }
    // 候选的 key
    if (isKeyStart(c)) {
      const parsed = readStringToken(src, i);
      if (parsed) {
        let j = parsed.end;
        while (j < src.length && /\s/.test(src[j])) j++;
        if (src[j] === ':') {
          j++;
          while (j < src.length && /\s/.test(src[j])) j++;
          const val = readStringToken(src, j);
          if (val) {
            if (!out.has(parsed.value)) out.set(parsed.value, val.value);
            i = val.end;
            continue;
          }
        }
        i = parsed.end;
        continue;
      }
    }
    i++;
  }
  return out;
}

/** 从 `i` 处读一个字符串字面量（单/双引号、裸标识符），返回 { value, end }。 */
function readStringToken(src, i) {
  const c = src[i];
  if (c === "'" || c === '"') {
    let j = i + 1;
    let raw = '';
    while (j < src.length) {
      if (src[j] === '\\') { raw += src[j] + src[j + 1]; j += 2; continue; }
      if (src[j] === c) return { value: unescapeStr(raw), end: j + 1 };
      raw += src[j];
      j++;
    }
    return null; // 未闭合
  }
  if (/[A-Za-z_$]/.test(c)) {
    let j = i;
    while (j < src.length && /[\w$]/.test(src[j])) j++;
    return { value: src.slice(i, j), end: j };
  }
  return null;
}

/** 把 JS 字符串字面量的转义还原（只处理词典里会出现的几种）。 */
function unescapeStr(s) {
  return s
    .replace(/\\'/g, "'")
    .replace(/\\"/g, '"')
    .replace(/\\n/g, '\n')
    .replace(/\\\\/g, '\\');
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

  // 收集所有译文。
  //
  // 冲突**不中断整批**：早先的实现遇到任一冲突就 exit(1)，结果一条都没写进去——
  // 而 `--export` 产出的 all.json 与人工分片天然会重叠（同一 key 两处译文），
  // 于是「补最后几条」这种日常操作会静默失败，词典看着没变。
  // 现在改成：冲突项跳过并记录，其余照常合并。
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
    console.warn(`跳过 ${conflicts.length} 处译文冲突（取先出现的那个），其余照常合并：`);
    for (const c of conflicts.slice(0, 10)) console.warn('  ' + c);
    if (conflicts.length > 10) console.warn(`  …… 另有 ${conflicts.length - 10} 处`);
  }
  if (!translated) {
    console.log('没有填任何译文（zh 字段为空）');
    return;
  }

  const { own } = loadCatalog();
  const added = [...merged].filter(([k]) => !own.has(k));
  const updated = [...merged].filter(([k]) => own.has(k));

  // 写前断言：`原有 + 新增` 必须一条不少。
  //
  // 这道断言是被真实事故逼出来的：`appendToCatalog` 会**读回现有词典再整体重写**，
  // 而读回用的扫描器一旦漏读（跨行值、引号转义等），每跑一次就丢一批，
  // 词典从 2400 条一路缩到 197 条——每次都「语法校验通过」，因为截断后的文件
  // 仍是合法 JS。跑第 3 次才察觉，此时原有词条已经找不回来了。
  //
  // 所以：**先算清楚应有几条，写完再数一遍对不上就中止**，
  // 宁可这次不写，也不能把词典改小。
  const expected = own.size + added.length;
  // 串在 .then 里：校验没过就 process.exit 了，这里不会执行，
  // 也就不会出现「词典其实是坏的，却先打印了『新增 N 条』」这种误导输出。
  return appendToCatalog(added, expected).then(() => {
    console.log(`新增 ${added.length} 条，更新 ${updated.length} 条（更新需手工合并，脚本只追加新增）`);
    if (updated.length) {
      console.log('\n以下键词典里已有，脚本未覆盖，请人工确认：');
      for (const [k, v] of updated.slice(0, 10)) console.log(`  ${k} → ${v}`);
    }
  });
}

/**
 * 把新增词条写进词典。
 *
 * **不做「就地替换已有分区」，改成整份重写。**
 *
 * 原来的做法是找到上次写的分区、算准偏移、原地替换。听着省事，实际上
 * 这条路径反复出问题：词典的键和值里有任意字符串（含引号、反斜杠、
 * 花括号），任何基于字节偏移或花括号配平的计算都可能被这些字符带偏，
 * 结果是**词条被整段截断**——词典从 2600 条悄悄缩回 470 条，
 * 而文件仍是合法 JS，语法校验照样通过。
 *
 * 偏移计算本身就是不必要的复杂度：分片的 `key` 是唯一事实来源，
 * 直接「原有条目 + 本次新增」重新序列化一份，天然幂等，
 * 跑第 1 次和第 10 次结果完全一致。
 */
function appendToCatalog(entries, expectedTotal) {
  if (!entries.length) return;
  const src = fs.readFileSync(catalogPath, 'utf8');

  // 切出对象字面量的**内容区间**（不含 `export default {` 与闭合 `}`），
  // 中间的注释与既有分区全部丢弃，换成一份干净的「原有 + 新增」。
  const body = readDictBody(src);
  if (body === null) throw new Error('词典文件里找不到 export default 对象，先检查文件语法');

  const own = parseDict(src);
  const merged = new Map();
  for (const [k, v] of own) if (!merged.has(k)) merged.set(k, v);
  for (const [k, v] of entries) if (!merged.has(k)) merged.set(k, v);

  if (expectedTotal != null && merged.size < expectedTotal) {
    console.warn(
      `注意：合并后应得 ${expectedTotal} 条，实际 ${merged.size} 条` +
      `（有 ${expectedTotal - merged.size} 个键重复或冲突，按先出现的取值）`,
    );
  }

  const block = [...merged]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([k, v]) => `  ${quoteLiteral(k, { asKey: true })}: ${quoteLiteral(v)},`)
    .join('\n');

  const out = `${body.head}export default {\n  ...common,\n${block}\n};\n${body.tail}`;
  // 覆盖之前先留一份原件：verifyCatalogSyntax 校验失败时要靠它真正还原，
  // 否则「已撤销」只是一句话，坏文件还留在原地。
  const backupPath = `${catalogPath}.bak`;
  fs.copyFileSync(catalogPath, backupPath);
  fs.writeFileSync(catalogPath, out, 'utf8');
  // 必须 await：校验是异步 import，不等它落地就删备份、报「已写入」，
  // 结果是校验失败时备份已经没了，坏文件留在原地——「撤销」根本执行不了。
  return verifyCatalogSyntax(expectedTotal, backupPath).then(() => {
    fs.rmSync(backupPath, { force: true });
    console.log(`已写入 ${path.relative(repoRoot, catalogPath)}（本次新增 ${entries.length} 条）`);
  });
}

/**
 * 取 `export default { … }` 的头尾两段（头 = 到 `{` 为止，尾 = 从 `}` 起）。
 *
 * 扫描时必须**跳过字符串字面量与注释**：词典里到处是 `'…'`、`"…"`，
 * 里面的花括号会让人工配平算错位置（曾导致词条被整段截断）。
 */
function readDictBody(src) {
  const start = src.indexOf('export default');
  if (start < 0) return null;
  const objStart = src.indexOf('{', start);
  let depth = 0, objEnd = -1;
  for (let i = objStart; i < src.length; i++) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') {
      const nl = src.indexOf('\n', i);
      i = nl < 0 ? src.length : nl;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      const close = src.indexOf('*/', i);
      i = close < 0 ? src.length : close + 1;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      const q = c;
      i++;
      while (i < src.length) {
        if (src[i] === '\\') i++;
        else if (src[i] === q) break;
        i++;
      }
      continue;
    }
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) { objEnd = i; break; }
    }
  }
  if (objEnd < 0) return null;
  // 保留 `export default {` 之前的全部内容（含文件头注释与 common 导入）
  const head = src.slice(0, objStart).replace(/export default\s*$/, '');
  const tail = src.slice(objEnd + 1);
  return { head, tail };
}

/**
 * 写完立刻验证词典。
 *
 * 两道检查，缺一不可：
 *   1. **能不能加载** —— 词典是运行时加载的，一个引号没转义对就是整个插件白屏。
 *   2. **条目数对不对** —— 只查语法查不出「内容被截断」：整体重写时读回
 *      用的是 `readDict`，一旦它漏读（跨行值、转义），每跑一次丢一批，
 *      词典从 2400 条缩到 197 条，而文件**仍是合法 JS**，语法校验照样通过。
 *      所以这里用**独立于 readDict 的方式**数：直接 import 出来的对象键数。
 */
function verifyCatalogSyntax(expectedTotal, backupPath) {
  const fileUrl = pathToFileURL(catalogPath).href;
  return import(`${fileUrl}?t=${Date.now()}`) // 加时间戳绕开 ESM 模块缓存
    .then((m) => {
      const dict = m.default || {};
      const n = Object.keys(dict).length;
      console.log(`语法校验通过，词典可加载（${n} 条）`);
      if (expectedTotal && n < expectedTotal) {
        console.error(
          `\n条目数异常：写入后只剩 ${n} 条，少于应有的 ${expectedTotal} 条。` +
          '\n读回词典的扫描器漏读了，本次写入不可信——请从 git 恢复后重试。',
        );
        process.exit(1);
      }
    })
    .catch((e) => {
      console.error(`\n词典写入后无法加载，请立即修复：\n  ${e.message}`);
      // 先留坏文件，再把词典**真正还原**。
      // 「已撤销」这句话必须对应一次真实的还原动作：只留备份却把坏文件留在原地，
      // 下一次重试就会在坏文件上继续叠加，越救越坏。
      try {
        fs.copyFileSync(catalogPath, catalogPath + '.broken');
        if (!backupPath) throw new Error('缺少写入前备份，无法自动还原');
        fs.copyFileSync(backupPath, catalogPath);
        console.error(`本次写入已撤销（坏文件留存于 ${path.basename(catalogPath)}.broken）`);
      } catch (restoreErr) {
        console.error(`自动还原失败：${restoreErr.message}`);
        console.error(`请手动执行：git checkout -- ${path.relative(repoRoot, catalogPath)}`);
        process.exit(1);
      }
      // 还原后自证：还原出来的那份必须能加载，否则说明备份本身就有问题。
      return verifyCatalogSyntax(0).then(() => {
        process.exit(1);
      });
    });
}

/**
 * 把字符串安全地写进JS 字面量。
 *
 * 两个坑，都在3d 词典上踩到过：
 *
 *1. **控制字符必须转义。** 词典里有 `标题\n提示` 这种 Blender tooltip 形态的键
 *    （`data-tip` 的原文就是 `标题\n说明`），字面换行落进单引号字符串就是语法错误。
 *    逐字符走 charCode，不用含字面控制字符的正则——U+2028/2029 在 regex 字面量里非法。
 *
 * 2. **值永远要加引号。** 键可以偷懒省略引号（合法标识符），值**不行**：
 *    `UVs: UV` 里的 `UV` 会被当成变量引用，运行时直接抛 `UV is not defined`，
 *    而 `node --check` 语法校验却完全通过。所以键和值必须分开处理。
 *
 * @param {string} s
 * @param {{asKey?: boolean}} [opts] asKey=true 时允许合法标识符省略引号
 * @returns {string}
 */
function quoteLiteral(s, { asKey = false } = {}) {
  if (asKey && /^[A-Za-z_$][\w$]*$/.test(s)) return s;
  let out = '';
  for (const ch of s) {
    const code = ch.codePointAt(0);
    if (ch === '\\') out += '\\\\';
    else if (ch === "'") out += "\\'";
    else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (ch === '\t') out += '\\t';
    else if (code < 0x20 || code === 0x7f || code === 0x2028 || code === 0x2029) {
      out += `\\u${code.toString(16).padStart(4, '0')}`;
    } else out += ch;
  }
  return `'${out}'`;
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
