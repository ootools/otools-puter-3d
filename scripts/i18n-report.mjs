/**
 * 多语言覆盖率报告。
 * ------------------------------------------------------------------
 *   node scripts/i18n-report.mjs            覆盖率总览 + 缺口最大的文件
 *   node scripts/i18n-report.mjs --list     列出全部候选原文（按出现次数）
 *   node scripts/i18n-report.mjs --missing  只列还没进词典的
 *   node scripts/i18n-report.mjs --file src/ui/home.js    只看某个文件
 *
 * 上游 Video Studio 完全没有 i18n：界面文案是散在 60 多个文件里的字面量。
 * 我们不改上游，所以中文靠 `shell/src/otools/i18n.zh-CN.js` 这份词典 +
 * 运行时的 DOM 翻译层（`shell/src/otools/dom-i18n.js`）来做。
 *
 * 这个脚本就是那份词典的**工作台**：
 *   1. 用启发式规则从上游源码里抽出「像界面文案」的字面量（label/title/
 *      aria-label/data-tip/emptyState 的标题与正文/h('tag', …, '文本') 的子节点…）；
 *   2. 拿词典对一遍，给出覆盖率与缺口清单。
 *
 * 上游同步之后重跑一次，就知道新版本又多了哪些没翻译的文案。
 * 启发式一定会有漏网与误报——它的用途是给出**可信的缺口清单**，不是精确统计。
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const upstreamSrc = path.join(repoRoot, 'upstream', 'src');
const catalogPath = path.join(repoRoot, 'shell', 'src', 'otools', 'i18n.zh-CN.js');
const commonPath = path.join(repoRoot, 'shell', 'src', 'otools', 'i18n.common.zh-CN.js');

const has = (name) => process.argv.includes(`--${name}`);
const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : null;
};

/**
 * 抽出来的字面量里，这些明显不是界面文案，直接丢。
 *
 * 注意**不要**简单地「丢掉所有单个词」：界面上一大半是单词标签
 * （`Restore`、`Player`、`Details`、`Ratio`、`Mirror`…）。当初用
 * `/^[\w-]+$/` 一刀切，结果面板标签页名、字段名、按钮名整类都不在
 * 报告里——覆盖率看着很高，屏幕上却一直是英文。
 * 要丢的是**标识符形状**的词：camelCase、全小写、全大写、带点或下划线。
 */
const NOT_UI = [
  /^[.#][\w.\-:[\]="' >+~,()]*$/, // CSS 选择器
  /^[a-z0-9]+(?:[A-Z][a-z0-9]*)+$/, // camelCase 标识符
  /^[a-z][a-z0-9-]*$/, // 单个小写词（属性名 / class 名 / 枚举值）
  /^(?:https?:|\/|\.\/|\.\.\/|data:|blob:|@)/, // 路径与 URL
  /^[A-Z0-9_]+$/, // 常量
  /^[\w-]+\/[\w.+-]+$/, // mime / 路径
  /^(?:Arrow|Digit|Numpad|Key)[A-Za-z]+$/, // 键名
  /^[\w.-]+\.(?:js|json|css|png|svg|mp4|mp3|wav|cube|tflite|task|wasm|txt)$/,
  /^\d/,
  /[{}<>=;|&$]/, // 代码片段
  /^[\w-]*[._][\w-]*$/, // 带点或下划线的单个 token（文件名 / id / class）
];

/**
 * 只在「像界面文案」的上下文里抽。每条规则给出：正则 + 取哪一组。
 *
 * 这里的规则就是**缺口清单的可信度上限**：漏掉一种调用形状，那一整类文案
 * 就永远不会出现在报告里（曾经漏掉 `store.update('Add track', …)` 与
 * `.edit('Reset color', …)`——它们会出现在历史面板和撤销提示里，是真正
 * 看得见的界面文案，132 条就这样一直没人发现）。
 * 所以要往里加的是**新的调用形状**，不是新的文案。
 */
const CONTEXT_RULES = [
  // 属性表里的展示字段：{ label: '…' }、title: '…'、'aria-label': '…'、data-tip: '…'
  { re: /(?:^|[\s{,(])(?:label|title|heading|hint|note|description|placeholder|text|okLabel|cancelLabel|confirm|cancel|ok|tip|unit|why|reason|message|empty|sub|body|summary)\s*:\s*(['"])((?:[^'"\\\n]|\\.){2,140})\1/g, group: 2 },
  { re: /['"](?:aria-label|data-tip|aria-labelledby|aria-describedby)['"]\s*:\s*(['"])((?:[^'"\\\n]|\\.){2,140})\1/g, group: 2 },
  // h('div.cls', {…}, '文本') / h('div.cls', '文本')
  { re: /\bh\(\s*(['"])[^'"]*\1\s*,\s*(['"])((?:[^'"\\\n]|\\.){3,140})\2/g, group: 3 },
  { re: /\bh\(\s*(['"])[^'"]*\1\s*,\s*\{[^{}]*\}\s*,\s*(['"])((?:[^'"\\\n]|\\.){3,140})\2/g, group: 3 },
  // emptyState('icon', '标题', '正文')
  { re: /\bemptyState\(\s*(['"])[^'"]*\1\s*,\s*(['"])((?:[^'"\\\n]|\\.){3,140})\2/g, group: 3 },
  // .textContent = '文本'
  { re: /\.textContent\s*=\s*(['"])((?:[^'"\\\n]|\\.){3,140})\1/g, group: 2 },
  // 会直接显示给用户的调用：announce / toast / note / done / progress
  { re: /\b(?:announce|toast|note|done|progress|promptDialog|confirmDialog)\(\s*(['"])((?:[^'"\\\n]|\\.){3,140})\1/g, group: 2 },
  // fail('kind', '文案')：第二个参数才是文案
  { re: /\bfail\(\s*(['"])[^'"]*\1\s*,\s*(['"])((?:[^'"\\\n]|\\.){3,140})\2/g, group: 3 },
  // 进度条文本：p.set(0.5, 'Matching …') / progress('Packing …', …)
  { re: /\b[a-zA-Z_$][\w$]*\.set\([^,()]*,\s*(['"])((?:[^'"\\\n]|\\.){3,140})\1/g, group: 2 },
  // 历史 / 编辑动作的标签：store.update('Add track', …)、view.edit('Reset color', …)
  // 这些会出现在历史面板条目与撤销/重做的悬停提示里。
  { re: /\b(?:update|edit)\(\s*(['"])((?:[^'"\\\n]|\\.){2,140})\1/g, group: 2 },
  { re: /\.undoStack\.push\(\s*\{[^}]*\blabel\s*:\s*(['"])((?:[^'"\\\n]|\\.){2,140})\1/g, group: 2 },
  // 抛给用户的错误文案（上游把它们显示在错误页 / toast 里）
  { re: /\bnew Error\(\s*(['"])((?:[^'"\\\n]|\\.){3,160})\1/g, group: 2 },
];

/** 源码扩展名：上游有的用 .js、有的用 .ts/.tsx（photo-studio、3d 全是 .ts），
 *  漏掉任一扩展名都会让那一整类应用的界面文案永远不在报告里。 */
const SRC_EXTS = new Set(['.js', '.mjs', '.ts', '.tsx', '.jsx', '.vue', '.svelte']);

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    const stat = fs.statSync(full);
    if (stat.isDirectory()) walk(full, out);
    else if (SRC_EXTS.has(path.extname(name).toLowerCase())) out.push(full);
  }
  return out;
}

/** 从一份源码里抽出候选文案。 */
function extractFrom(source) {
  const found = new Map();
  for (const rule of CONTEXT_RULES) {
    const re = new RegExp(rule.re.source, rule.re.flags);
    let m;
    while ((m = re.exec(source))) {
      const raw = m[rule.group];
      if (!raw) continue;
      const value = raw.replace(/\\'/g, "'").replace(/\\"/g, '"').replace(/\\n/g, ' ');
      if (value.length < 3 || value.length > 120) continue;
      if (!/[A-Za-z\u4e00-\u9fa5]/.test(value)) continue;
      if (NOT_UI.some((p) => p.test(value))) continue;
      // 带模板插值的动态文案不可能是词典键
      if (value.includes('${')) continue;
      found.set(value, (found.get(value) || 0) + 1);
    }
  }
  return found;
}

/**
 * 读词典。
 *
 * 用正则解析而不是 import：报告要能在没装依赖、没有构建树的情况下跑，
 * 而且顺带能查出**重复键**（JS 对象字面量允许重复键，后者覆盖前者，
 * 静默吃掉一条译文——这种事必须报出来）。
 */
function readCatalog() {
  if (!fs.existsSync(catalogPath)) return { entries: new Map(), duplicates: [] };
  const source = fs.readFileSync(catalogPath, 'utf8');
  const entries = new Map();
  const duplicates = [];
  // 键可以是 'x'、"x" 或裸标识符（如 px:），值与键同类
  const re = /^\s*(?:'((?:[^'\\\n]|\\.)+)'|"((?:[^"\\\n]|\\.)+)"|([A-Za-z_$][\w$]*))\s*:\s*(?:'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)")\s*,?\s*$/gm;
  let m;
  while ((m = re.exec(source))) {
    const key = m[1] ?? m[2] ?? m[3];
    const value = m[4] ?? m[5] ?? '';
    if (entries.has(key)) duplicates.push(key);
    entries.set(key, value);
  }
  return { entries, duplicates };
}

/**
 * 读通用词典（与其它插件共用的那一份）。
 * 运行时项目词典是 `...common` 展开的，所以覆盖率要看合并后的全集——
 * 否则报告永远显示 0%（通用词明明已经在生效）。
 */
function readCommon() {
  if (!fs.existsSync(commonPath)) return new Map();
  const source = fs.readFileSync(commonPath, 'utf8');
  const entries = new Map();
  const re = /^\s*(?:'((?:[^'\\\n]|\\.)+)'|"((?:[^"\\\n]|\\.)+)"|([A-Za-z_$][\w$]*))\s*:\s*(?:'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)")\s*,?\s*$/gm;
  let m;
  while ((m = re.exec(source))) {
    const key = m[1] ?? m[2] ?? m[3];
    const value = m[4] ?? m[5] ?? '';
    if (!entries.has(key)) entries.set(key, value);
  }
  return entries;
}

function main() {
  const files = walk(upstreamSrc);
  const only = arg('file');

  const perFile = new Map();
  const total = new Map();
  for (const file of files) {
    const relative = path.relative(repoRoot, file).split(path.sep).join('/');
    if (only && relative !== only) continue;
    const found = extractFrom(fs.readFileSync(file, 'utf8'));
    if (!found.size) continue;
    perFile.set(relative, found);
    for (const [k, v] of found) total.set(k, (total.get(k) || 0) + v);
  }

  const { entries: catalog, duplicates } = readCatalog();
  // 把通用词典并进来：运行时项目词典是 ...common 展开的，覆盖率统计要看合并后的全集。
  for (const [k, v] of readCommon()) if (!catalog.has(k)) catalog.set(k, v);

  if (has('list') || has('missing')) {
    const rows = [...total].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    const show = has('missing') ? rows.filter(([k]) => !catalog.has(k)) : rows;
    for (const [k, n] of show) console.log(`${String(n).padStart(3)}  ${JSON.stringify(k)}`);
    console.log(`\n${show.length} 条`);
    return;
  }

  const covered = [...total.keys()].filter((k) => catalog.has(k));
  const missing = [...total.keys()].filter((k) => !catalog.has(k));
  const occurrences = [...total.values()].reduce((a, b) => a + b, 0);
  const coveredOccurrences = covered.reduce((sum, k) => sum + total.get(k), 0);

  console.log(`候选文案：${total.size} 条不同文案，共出现 ${occurrences} 次`);
  console.log(`词典条目（含通用）：${catalog.size} 条`);
  console.log(`已覆盖：${covered.length}/${total.size}（${((covered.length / total.size) * 100).toFixed(1)}%），按出现次数算 ${((coveredOccurrences / occurrences) * 100).toFixed(1)}%`);
  console.log(`未覆盖：${missing.length} 条`);

  if (duplicates.length) {
    console.log(`\n⚠ 词典里有 ${duplicates.length} 个重复键（后者会静默覆盖前者）：`);
    for (const key of [...new Set(duplicates)]) console.log(`  ${JSON.stringify(key)}`);
  }

  const gaps = [...perFile]
    .map(([file, found]) => {
      const miss = [...found.keys()].filter((k) => !catalog.has(k));
      return { file, miss: miss.length, total: found.size, top: miss.slice(0, 4) };
    })
    .filter((row) => row.miss > 0)
    .sort((a, b) => b.miss - a.miss)
    .slice(0, 12);

  console.log('\n缺口最大的文件：');
  for (const row of gaps) {
    console.log(`  ${String(row.miss).padStart(3)}/${String(row.total).padEnd(3)}  ${row.file}`);
    console.log(`         ${row.top.map((s) => JSON.stringify(s)).join(', ')}`);
  }
  console.log('\n看完整清单：node scripts/i18n-report.mjs --missing');
}

try {
  main();
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
