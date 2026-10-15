/**
 * DOM 翻译层：把上游界面上出现的英文原文换成当前语言的译文。
 * ------------------------------------------------------------------
 * 上游界面是几十个文件里散着的英文字面量，没有 i18n 钩子，也没有集中的文案表。
 * **不改上游**这条底线之下，只有一条路可走：在运行时把渲染出来的文本节点换掉。
 *
 * 做法与边界：
 *
 *   - **只做精确匹配**（外加 `i18n.js` 里的锚定模式）。文本节点去掉首尾空白后
 *     必须与词典的键逐字符相同、或者整条匹配某条模式，才替换。
 *     没有模糊匹配、没有子串替换——所以用户自己起的文档名不会被改写。
 *   - **用户内容区整棵子树跳过**（文档名、单元格内容、幻灯片正文…），
 *     见 `APP.i18nSkip`。**只跳叶子**：写容器选择器会把容器里的按钮、副标题
 *     一起跳过，界面上就一直留着英文。
 *   - **只碰文本与几个展示属性**（title / aria-label / placeholder / data-tip / alt），
 *     不碰表单值、不碰 canvas、不碰 svg。
 *   - 记下每个节点/属性的**原文**，所以切语言时重译是幂等的，不会中文套中文。
 *   - MutationObserver 跟新增节点，按帧批处理；自己的写入不会触发二次写入
 *     （写完 nodeValue 已经等于目标值，下一轮算出来还是同一个值，自然收敛）。
 *   - `document.title` 上游是单独赋值的，不在 body 里，另外接一下。
 *
 * 覆盖率：`node scripts/i18n-report.mjs`。没翻到的原文保持英文显示——这是刻意的：
 * 露英文比露 key 好。
 */

import { t, onChange, locale, SOURCE_LOCALE } from './i18n.js';
import { APP } from './app.js';

/**
 * 这些标签的**内容**是用户数据或程序绘制结果（或根本不是文本节点），不翻文本。
 *
 * 注意：`INPUT` / `TEXTAREA` 在列里，但它们的**展示属性**（placeholder /
 * title / aria-label …）属于界面文案，仍会被翻译——见 `isFormControl` 与
 * `translateNode` / `translateSubtree` 里的特判。
 */
const SKIP_TAGS = new Set([
  'SCRIPT', 'STYLE', 'NOSCRIPT', 'TITLE', 'TEXTAREA', 'INPUT',
  'CANVAS', 'VIDEO', 'AUDIO', 'IFRAME', 'OBJECT', 'SVG', 'PATH', 'CODE', 'PRE',
]);

/**
 * 用户内容区 = 通用项 + `APP.i18nSkip`（各插件自己的叶子选择器）。
 *
 * 两条纪律：
 *   1. **只写叶子节点，不写容器**。
 *   2. **不是用户写的就不进来**。菜单项、工具栏按钮、面板标题都是界面文案，
 *      它们本来就是词典的条目；跳过等于界面上永远留着英文。
 */
const SKIP_SELECTORS = [
  '[contenteditable]',
  '[data-i18n-skip]',
  ...(Array.isArray(APP.i18nSkip) ? APP.i18nSkip : []),
];

/** 需要一起翻译的展示属性。 */
const ATTRS = ['title', 'aria-label', 'placeholder', 'data-tip', 'alt'];

/** 文本节点 -> 原文；元素 -> Map(属性名 -> 原文)。 */
const textOriginals = new WeakMap();
const attrOriginals = new WeakMap();

let observer = null;
let enabled = true;
let scheduled = false;
const pending = new Set();
const stats = { nodes: 0, attributes: 0, passes: 0 };

/**
 * 没翻到的原文：`原文 -> { text, attr }`。
 *
 * 分开计数是有用的：属性（title/aria-label）漏了只影响读屏与悬停提示，
 * 文本漏了是**屏幕上直接看得见的英文**——排查时先看 text。
 */
const misses = new Map();

/** `document.title` 的原文与我们最后写进去的值。 */
let titleOriginal = '';
let titleWritten = '';

/**
 * 已安装的观察器挂在 globalThis 上，而不是模块作用域。
 *
 * 两个理由：模块被重新求值（HMR、测试里的 resetModules）时不会又挂一个；
 * `disposeDomTranslation()` 也能把**所有**观察器一次收掉。
 */
const REGISTRY = (globalThis.__otoolsPuterDomI18nObservers ||= new Set());

/* ------------------------------------------------------------------ 工具 */

function skippedElement(el) {
  if (!el || el.nodeType !== 1) return false;
  // SVG / MathML 里的元素 tagName 保持小写（`svg`、`text`），HTML 里是大写，
  // 所以统一成大写再比。
  const tag = el.tagName ? el.tagName.toUpperCase() : '';
  if (SKIP_TAGS.has(tag)) return true;
  for (const selector of SKIP_SELECTORS) {
    try {
      if (el.matches(selector)) return true;
    } catch {
      /* 选择器写错不该让整层挂掉 */
    }
  }
  return false;
}

/** 往上找最近的元素，看是不是落在用户内容区里（只在遍历入口调一次）。 */
function insideSkipped(node) {
  let el = node.nodeType === 1 ? node : node.parentElement;
  while (el) {
    if (skippedElement(el)) return true;
    el = el.parentElement;
  }
  return false;
}

/**
 * INPUT / TEXTAREA 这类「叶子级跳过元素」：它们的**值/内容**是用户数据
 * （文档名、备注正文…）不能翻，但它们的**展示属性**（placeholder / title /
 * aria-label …）属于界面文案，仍需翻译。用这个函数把两种情况分开。
 */
function isFormControl(el) {
  if (!el || el.nodeType !== 1) return false;
  const tag = el.tagName ? el.tagName.toUpperCase() : '';
  return tag === 'INPUT' || tag === 'TEXTAREA';
}

/** 记下没翻到的原文（只在有词典的语言下记，英文模式下整棵树都是「没翻到」）。 */
function noteMiss(original, kind) {
  if (locale() === SOURCE_LOCALE) return;
  const row = misses.get(original) || { text: 0, attr: 0 };
  row[kind] += 1;
  misses.set(original, row);
}

/** 保留首尾空白地替换文本。调用方保证这个节点不在跳过区里。 */
function translateTextNode(node) {
  const raw = node.nodeValue;
  if (!raw) return;
  const trimmed = raw.trim();
  if (!trimmed) return;

  let original = textOriginals.get(node);
  if (original === undefined) {
    original = trimmed;
    textOriginals.set(node, original);
  }
  const want = t(original);
  if (want === original) noteMiss(original, 'text');
  // 注意：要拿 `want` 去和**当前**节点值比，而不是和原文比。
  // 切回原文语言时 want === original，此时正是要把译文还原回英文——
  // 早退就会留下中文。
  const at = raw.indexOf(trimmed);
  const next = `${raw.slice(0, at)}${want}${raw.slice(at + trimmed.length)}`;
  if (node.nodeValue !== next) {
    node.nodeValue = next;
    stats.nodes += 1;
  }
}

function translateAttributes(el) {
  if (!el.hasAttributes()) return;
  let map = null;
  for (const attr of ATTRS) {
    if (!el.hasAttribute(attr)) continue;
    const raw = el.getAttribute(attr);
    if (!raw) continue;
    if (!map) {
      map = attrOriginals.get(el);
      if (!map) {
        map = new Map();
        attrOriginals.set(el, map);
      }
    }
    let original = map.get(attr);
    if (original === undefined) {
      original = raw;
      map.set(attr, original);
    }
    const want = t(original);
    if (want === original) noteMiss(original, 'attr');
    // 同 translateTextNode：和当前值比，才能在切回原文语言时还原
    if (raw !== want) {
      el.setAttribute(attr, want);
      stats.attributes += 1;
    }
  }
}

/** 遍历一棵已经在非跳过区里的子树（跳过区在子节点处剪枝）。 */
function translateSubtree(el) {
  translateAttributes(el);
  for (const child of el.childNodes) {
    if (child.nodeType === 3) translateTextNode(child);
    else if (child.nodeType === 1) {
      if (skippedElement(child)) {
        // 跳过元素的内容（用户数据）不翻；但表单控件的展示属性仍要翻。
        if (isFormControl(child)) translateAttributes(child);
      } else {
        translateSubtree(child);
      }
    }
  }
}

/**
 * 翻译任意一个节点（文本或元素）。
 *
 * 入口处先看两件事：总开关有没有关（`setEnabled(false)` 之后整层必须真的
 * 什么都不做——测试靠这个断言），以及是不是落在跳过区里。
 */
function translateNode(node) {
  if (!enabled || !node) return;
  if (node.nodeType === 3) {
    if (!insideSkipped(node)) translateTextNode(node);
    return;
  }
  if (node.nodeType !== 1) return;
  if (insideSkipped(node)) {
    // INPUT / TEXTAREA 落在跳过区：内容（用户数据）不翻，但展示属性仍要翻。
    if (isFormControl(node)) translateAttributes(node);
    return;
  }
  translateSubtree(node);
}

/* -------------------------------------------------------------- 调度 */

/**
 * `document.title`。
 *
 * 上游是 `document.title = \`${name} - Photo Studio\`` 这样单独赋值的，
 * 不在 body 里，翻译层看不到。做法是「发现和我们上次写的不一样，就当作
 * 上游又改了一次，重新按原文翻」。幂等，且不会和上游打架。
 */
function syncTitle() {
  if (typeof document === 'undefined') return;
  const raw = document.title || '';
  if (!raw) {
    titleOriginal = '';
    titleWritten = '';
    return;
  }
  if (raw === titleWritten) return;
  titleOriginal = raw;
  const want = t(titleOriginal);
  if (want === titleOriginal) noteMiss(titleOriginal, 'attr');
  titleWritten = want;
  if (want !== raw) document.title = want;
}

function flush() {
  scheduled = false;
  stats.passes += 1;
  for (const node of pending) {
    if (node.isConnected) translateNode(node);
  }
  pending.clear();
  syncTitle();
}

function schedule(node) {
  if (!enabled || !node) return;
  pending.add(node);
  if (scheduled) return;
  scheduled = true;
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(flush);
  else setTimeout(flush, 16);
}

/**
 * 判断这次 `characterData` 改动是不是翻译层自己刚写进去的。
 *
 * 翻译层写到文本节点的目标值永远是 `t(原文)`。如果节点当前值正好等于
 * 「按已记录的原文算出来的译文」，说明这是我们的写入、不是上游重渲染——
 * 千万别把原文删掉，否则下次切语言时查不到英文原文，译文就回不去（表现为
 * 「语言切换无效」）。只有当前值 ≠ `t(原文)` 时，才认定上游真改了文案。
 */
function isOurTextWrite(node) {
  const original = textOriginals.get(node);
  if (original === undefined) return false;
  const now = node.nodeValue || '';
  return now.trim() === t(original);
}

/** 同 {@link isOurTextWrite}，针对某个展示属性。 */
function isOurAttrWrite(el, attr) {
  const map = attrOriginals.get(el);
  const original = map?.get(attr);
  if (original === undefined) return false;
  const now = el.getAttribute(attr) || '';
  return now === t(original);
}

function onMutations(records) {
  if (!enabled) return;
  for (const record of records) {
    if (record.type === 'childList') {
      for (const node of record.addedNodes) schedule(node);
    } else if (record.type === 'characterData') {
      if (!isOurTextWrite(record.target)) {
        // 上游真的改了文案：忘掉旧原文，按新内容重新翻译
        textOriginals.delete(record.target);
      }
      schedule(record.target);
    } else if (record.type === 'attributes') {
      if (!isOurAttrWrite(record.target, record.attributeName)) {
        attrOriginals.get(record.target)?.delete(record.attributeName);
      }
      schedule(record.target);
    }
  }
}

/* ---------------------------------------------------------------- 对外 */

/** 当前语言下没翻到的原文（调试与报告用）。 */
export function missingStrings() {
  return [...misses.keys()].sort();
}

/**
 * 没翻到的原文，带「是文本还是属性」的计数。
 *
 * @returns {Array<{key: string, text: number, attr: number}>}
 */
export function missingReport() {
  return [...misses]
    .map(([key, row]) => ({ key, text: row.text, attr: row.attr }))
    .sort((a, b) => b.text - a.text || b.attr - a.attr || a.key.localeCompare(b.key));
}

/** 清空漏译记录。 */
export function resetMisses() {
  misses.clear();
}

export function domStats() {
  return { ...stats, locale: locale(), missing: misses.size };
}

export function setEnabled(value) {
  enabled = Boolean(value);
  if (enabled) translateAll();
}

/** 全量重译。切语言后调用；因为记着原文，重译是幂等的。 */
export function translateAll() {
  if (!enabled || typeof document === 'undefined' || !document.documentElement) return;
  pending.clear();
  // 切语言时上游可能已经改过标题：忘掉上次写进去的值，重新按原文翻。
  titleWritten = '';
  translateNode(document.documentElement);
  syncTitle();
}

export function disposeDomTranslation() {
  for (const installed of REGISTRY) installed.disconnect();
  REGISTRY.clear();
  observer = null;
}

/**
 * 装上翻译层。幂等（跨模块实例也幂等）。
 *
 * 默认挂在 `documentElement` 而不是 `body`：`<title>` 在 head 里，上游改
 * 标题时只有观察整个文档才能收到通知（`<title>` 本身在 SKIP_TAGS 里，
 * 不会被动到）。
 *
 * @param {{root?: Element}} [options] 只翻译这个根（默认 documentElement）
 */
export function installDomTranslation({ root } = {}) {
  if (typeof document === 'undefined' || REGISTRY.size) return;
  const target = root || document.documentElement;
  if (!target) return;

  translateNode(target);
  syncTitle();

  if (typeof MutationObserver === 'function') {
    observer = new MutationObserver(onMutations);
    observer.observe(target, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ATTRS,
    });
    REGISTRY.add(observer);
  }

  // 宿主切语言 / 用户在本插件里换语言 → 整棵树重译
  onChange(() => translateAll());
}
