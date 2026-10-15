/**
 * 多语言运行时。
 * ------------------------------------------------------------------
 * 宿主（OTools）会把自己的语言推给每个插件 webview，注入脚本长这样
 * （见宿主 src-tauri/src/platform/webview/core.rs 的 build_child_webview_locale_script）：
 *
 *     document.documentElement.setAttribute('lang', 'zh-CN');
 *     window.__OTOOLS_LOCALE__ = { locale: 'zh-CN' };
 *     window.dispatchEvent(new CustomEvent('otools-locale-changed', { detail: { locale } }));
 *     document.dispatchEvent(new CustomEvent('otools-locale-changed', { detail: { locale } }));
 *
 * 它在 webview 创建时随 init script 注入一次，之后宿主里改语言会**再推一次**。
 * 所以这里做两件事：
 *   1. 启动时读一次（三条通道任一：`__OTOOLS_LOCALE__` / `documentElement.lang` /
 *      `navigator.language`）；
 *   2. 之后一直监听 `otools-locale-changed` 与 `documentElement.lang` 的变化，
 *      宿主切语言时**不刷新页面**就跟着切。
 *
 * 语言来源有三层，优先级从高到低：
 *   用户在本插件里显式选的语言（localStorage） → 宿主推的语言 → 浏览器语言
 * 用户没选过时（默认 'auto'）完全跟随宿主。
 *
 * 词典见 `i18n.zh-CN.js`。没有词典的语言回退到英文原文——上游本来就是英文界面，
 * 回退是安全的。
 *
 * 翻译分两层（见 `t()`）：**精确词条** + **模式**。模式是为了那些上游用模板串拼
 * 出来的文案（`Open ${name}`、`${n} slides`），它们永远不可能成为词典的键，
 * 只能按形状认。
 */

import zhCN, { patterns as zhCNPatterns } from './i18n.zh-CN.js';
import { APP } from './app.js';

/** 用户选择的语言；'auto' = 跟随宿主。 */
const PREF_KEY = `${APP.id}.locale`;

/** 上游界面的语言，也是所有词典的键的语言，缺词时的回退目标。 */
export const SOURCE_LOCALE = 'en-US';

/** 宿主支持的语言（见宿主 normalize_locale）。 */
export const HOST_LOCALES = ['zh-CN', 'en-US', 'ja-JP', 'ko-KR', 'de-DE', 'ru-RU', 'es-ES', 'ar-SA'];

/** 从右往左书写的语言。 */
const RTL_LOCALES = new Set(['ar-SA']);

/** 语言在菜单里的显示名：用自己的语言写，用户才认得出。 */
const LOCALE_LABELS = {
  'zh-CN': '简体中文',
  'en-US': 'English',
};

/** 已注册的词典：locale -> { 英文原文: 译文 }。 */
const catalogs = new Map();

/**
 * 模式表：locale -> [[锚定正则, 替换], …]。
 *
 * 上游有大量文案是**模板串拼出来的**，精确匹配永远命中不了：
 *
 *     `Open ${p.name}, edited ${relTime(p.modified)}`
 *     `${n} slides · ${clock(duration)}`
 *     `Export ${label}`
 *
 * 这些只能按形状去认。替换可以是字符串（`$1` 引用捕获组）或函数
 * `(match, t) => string`——函数形式是为了能区分「捕获组是用户数据」
 * 与「捕获组是界面文案」，后者要递归再翻一次。
 */
const patternSets = new Map();

/** 已注册但不需要词典（英文就是原文）的语言。 */
const passthrough = new Set([SOURCE_LOCALE]);

export function registerCatalog(locale, messages, patterns = []) {
  catalogs.set(locale, messages);
  if (patterns.length) patternSets.set(locale, patterns);
  else patternSets.delete(locale);
  passthrough.delete(locale);
  resolve();
}

/* ------------------------------------------------------------------ 状态 */

let current = SOURCE_LOCALE;
let hostLang = '';
/** 我们自己写进 `documentElement.lang` 的值，用来区分「宿主改的」和「我们改的」。 */
let ourLang = '';
const listeners = new Set();

// 内置词典要在状态声明之后注册：registerCatalog 会立刻 resolve 一次。
registerCatalog('zh-CN', zhCN, zhCNPatterns);

function readPref() {
  try {
    return String(window.localStorage.getItem(PREF_KEY) || '').trim() || 'auto';
  } catch {
    return 'auto';
  }
}

function writePref(value) {
  try {
    window.localStorage.setItem(PREF_KEY, String(value || 'auto'));
  } catch {
    /* 忽略 */
  }
}

/** 宿主推过来的语言（可能是空串：宿主还没说话）。 */
export function readHostLocale() {
  try {
    const injected = window.__OTOOLS_LOCALE__;
    const fromInjected = injected && typeof injected.locale === 'string' ? injected.locale.trim() : '';
    if (fromInjected) return fromInjected;
  } catch {
    /* 忽略 */
  }
  return String(document?.documentElement?.getAttribute?.('lang') || '').trim();
}

/**
 * 把任意 locale 字符串归一到我们认识的语言上。
 * `zh-TW` / `zh` → `zh-CN`（同一个语言族）；没有词典的语言 → 英文原文。
 */
export function normalizeLocale(raw) {
  const value = String(raw || '').trim();
  if (!value) return '';
  const exact = value.replace(/_/g, '-');
  const lower = exact.toLowerCase();
  for (const locale of [...catalogs.keys(), ...passthrough]) {
    if (locale.toLowerCase() === lower) return locale;
  }
  const base = lower.split('-')[0];
  for (const locale of [...catalogs.keys(), ...passthrough]) {
    if (locale.toLowerCase().split('-')[0] === base) return locale;
  }
  return '';
}

/** 当前生效的语言（已经过词典可用性归一）。 */
export function locale() {
  return current;
}

/** 用户的选择：'auto' 或具体 locale。 */
export function preference() {
  return readPref();
}

/** 当前语言是不是从右往左写。 */
export function isRTL(value = current) {
  return RTL_LOCALES.has(value);
}

/** 菜单里可选项：[['auto', 'Follow OTools'], ['zh-CN', '简体中文'], …]。 */
export function localeChoices() {
  const choices = [['auto', 'Follow OTools']];
  for (const l of catalogs.keys()) choices.push([l, LOCALE_LABELS[l] || l]);
  // 英文没有词典（它就是原文），但用户可能想显式选它，免得跟着宿主跑。
  if (!catalogs.has(SOURCE_LOCALE)) choices.push([SOURCE_LOCALE, LOCALE_LABELS[SOURCE_LOCALE] || SOURCE_LOCALE]);
  return choices;
}

/**
 * 同上，但把显示名翻好——`<select>` 的选项文本与菜单标签都直接用它。
 * 语言名本身不翻译（「简体中文」就用中文写，「English」就用英文写），
 * 只有 'auto' 那一项要跟着界面语言走。
 */
export function localeOptionPairs() {
  return localeChoices().map(([value, label]) => [value, value === 'auto' ? t('Follow OTools') : label]);
}

/* ---------------------------------------------------------------- 翻译 */

/**
 * 查一条译文。
 *
 * 两步：
 *   1. **精确命中**词典（绝大多数界面文案走这条）；
 *   2. 没命中就试**模式**——带插值的模板串只能按形状认。
 *
 * 两步都不中时返回原文。上游本来就是英文界面，回退是安全的：
 * 露英文比露 key 好，也比把用户自己起的名字改掉好。
 *
 * @param {string} key 英文原文
 * @param {Record<string, unknown>} [params] 替换译文里的 `{name}` 占位
 * @returns {string} 译文；没有词典或没有这条词时返回 key 本身
 */
export function t(key, params) {
  const source = String(key ?? '');
  if (!source) return source;
  const catalog = catalogs.get(current);
  let hit;
  if (catalog && Object.prototype.hasOwnProperty.call(catalog, source)) hit = catalog[source];
  else hit = applyPatterns(source) ?? source;
  if (!params) return hit;
  return hit.replace(/\{(\w+)\}/g, (all, name) => (name in params ? String(params[name]) : all));
}

/** 按当前语言的模式表试一遍，命中返回译文，没命中返回 null。 */
function applyPatterns(source) {
  const patterns = patternSets.get(current);
  if (!patterns) return null;
  for (const entry of patterns) {
    const re = entry[0];
    // 模式一律是锚定的、不带 g 的；带 g 会让 lastIndex 在调用间残留。
    if (re.global || re.sticky) re.lastIndex = 0;
    const match = re.exec(source);
    if (!match) continue;
    const replace = entry[1];
    const out = typeof replace === 'function' ? replace(match, t) : source.replace(re, replace);
    // 替换结果为空串视为「不处理」：写错模式不该把界面文案抹掉。
    if (typeof out === 'string' && out) return out;
  }
  return null;
}

/** 这条原文有没有译文（精确或模式命中都算）。报告与调试用。 */
export function has(key) {
  const catalog = catalogs.get(current);
  if (catalog && Object.prototype.hasOwnProperty.call(catalog, key)) return true;
  return applyPatterns(String(key ?? '')) !== null;
}

/** 当前词典的条目数。 */
export function catalogSize(value = current) {
  const catalog = catalogs.get(value);
  return catalog ? Object.keys(catalog).length : 0;
}

/** 当前语言的模式条数。 */
export function patternSize(value = current) {
  return patternSets.get(value)?.length ?? 0;
}

/* ------------------------------------------------------------ 变更通知 */

export function onChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function notify(previous) {
  for (const fn of [...listeners]) {
    try {
      fn(current, previous);
    } catch (err) {
      console.error(`[${APP.id}] i18n listener failed`, err);
    }
  }
}

/* ------------------------------------------------------------ 解析与应用 */

function resolve() {
  const previous = current;
  const pref = readPref();
  const raw = pref !== 'auto' ? pref : hostLang || (typeof navigator !== 'undefined' ? navigator.language : '');
  current = normalizeLocale(raw) || SOURCE_LOCALE;
  applyDocument();
  if (current !== previous) notify(previous);
  return current;
}

/** 把解析结果写到 document 上：`lang` 给字体/断行/读屏用，`dir` 给 RTL 用。 */
function applyDocument() {
  if (typeof document === 'undefined' || !document.documentElement) return;
  const root = document.documentElement;
  root.dataset.otoolsLocale = current;
  root.dataset.otoolsLocalePreference = readPref();
  const dir = isRTL() ? 'rtl' : 'ltr';
  if (root.getAttribute('dir') !== dir) root.setAttribute('dir', dir);
  // 总是写成解析后的语言：宿主推 'ja-JP' 而我们只有英文时，页面实际显示英文，
  // 此时把 lang 留在 ja-JP 会让字体与断行按日文来——那才是真的错。
  ourLang = current;
  if (root.getAttribute('lang') !== current) root.setAttribute('lang', current);
}

/** 宿主推了一次新语言。 */
function applyHostLocale(raw) {
  const next = String(raw || '').trim();
  if (!next || next === hostLang) return;
  hostLang = next;
  resolve();
}

/** 用户在本插件里换语言。 */
export function setPreference(value) {
  writePref(String(value || 'auto').trim() || 'auto');
  return resolve();
}

/* ---------------------------------------------------------------- 安装 */

let installed = false;

/**
 * 装上监听。幂等，重复调用无副作用。
 *
 * 三条监听同时用，是因为宿主的注入方式在不同版本/不同 webview 里不完全一致：
 *   - CustomEvent：宿主主动推（正常路径）
 *   - `lang` 属性变化：宿主只改了属性、事件没到（或事件在监听之前就发过）
 *   - storage 事件：多窗口（插件被拆成独立窗口）时另一边的选择同步过来
 */
export function installI18n() {
  if (installed) return;
  installed = true;

  hostLang = readHostLocale();

  const onHostEvent = (event) => {
    const detail = event && event.detail;
    applyHostLocale(detail && typeof detail.locale === 'string' ? detail.locale : readHostLocale());
  };
  window.addEventListener('otools-locale-changed', onHostEvent);
  document.addEventListener('otools-locale-changed', onHostEvent);

  if (typeof MutationObserver === 'function' && document.documentElement) {
    new MutationObserver(() => {
      const value = document.documentElement.getAttribute('lang') || '';
      // 我们自己写的值不算宿主更新（否则会来回打架）
      if (value === ourLang) return;
      applyHostLocale(value);
    }).observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] });
  }

  window.addEventListener('storage', (event) => {
    if (!event || event.key === PREF_KEY || event.key === null) resolve();
  });

  resolve();
}

/**
 * 给上游的菜单用的语言项（形状与上游的菜单项一致）。
 * 放在这里而不是各处菜单，是为了让「有哪些语言」只有一处定义。
 */
export function languageMenuItems() {
  const pref = readPref();
  return localeOptionPairs().map(([value, label]) => ({
    label,
    icon: value === 'auto' ? 'monitor' : 'languages',
    checked: pref === value,
    radio: true,
    onSelect: () => setPreference(value),
  }));
}
