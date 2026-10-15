/**
 * 主题跟随宿主（「跟随，直到用户自己选」）。
 * ------------------------------------------------------------------
 * 上游自己有一套主题（`APP.themeKey`，值 `dark` / `light` / `system`，界面里
 * 也有切换入口）。在 OTools 里，主题应该由宿主统一管：宿主切深色，插件跟着切，
 * 用户不用来五个插件里各调一次。
 *
 * 但也不能一刀切——用户可能就是想让这个插件单独用浅色。所以规则是：
 *
 *   - 我们跟随宿主时会把值写进 `APP.themeKey`，同时把写过的值记在
 *     `${APP.id}.theme-followed`；
 *   - 下次如果 `APP.themeKey` 与记下的值不一样，说明是用户在界面里自己选了
 *     主题 —— 那就**停止跟随**，以后都不再写；
 *   - 用户在界面里选回 `system` 时，把记忆清掉，重新开始跟随。
 */

import { APP } from './app.js';

const FOLLOWED_KEY = `${APP.id}.theme-followed`;
const THEME_KEY = APP.themeKey;

function readFollowed() {
  try {
    return String(window.localStorage.getItem(FOLLOWED_KEY) || '').trim();
  } catch {
    return '';
  }
}

function writeFollowed(value) {
  try {
    if (value) window.localStorage.setItem(FOLLOWED_KEY, value);
    else window.localStorage.removeItem(FOLLOWED_KEY);
  } catch {
    /* 忽略 */
  }
}

/** 上游当前的主题设置（'dark' / 'light' / 'system' / ''）。 */
export function upstreamTheme() {
  try {
    return String(window.localStorage.getItem(THEME_KEY) || '').trim();
  } catch {
    return '';
  }
}

/** 用户是不是自己选过主题（选过就不再跟随）。 */
export function userChoseTheme() {
  const current = upstreamTheme();
  if (!current || current === 'system') return false;
  // 界面里选成明确的 dark/light，且不是我们上次写进去的那个值
  return current !== readFollowed();
}

/**
 * 把宿主的主题写进上游的设置。
 *
 * `documentElement` 上的 `dark` / `light` 类是宿主打上去的（语言同理）。
 * 写完立刻让上游重画：派发 `storage` 事件是最小侵入的做法——上游监听
 * `storage` 读主题的代码会按新值重画，我们不需要知道它内部怎么实现。
 *
 * @param {'dark'|'light'|''} mode 空串表示宿主没表态，什么都不做
 */
export function applyHostTheme(mode) {
  if (!mode) return false;
  if (userChoseTheme()) return false;
  try {
    window.localStorage.setItem(THEME_KEY, mode);
    writeFollowed(mode);
    // 让同页面的其它监听（上游自己的主题逻辑）看到变化
    window.dispatchEvent(new StorageEvent('storage', { key: THEME_KEY, newValue: mode }));
    return true;
  } catch {
    return false;
  }
}

/** 用户在界面里选了主题：除了 `system`，其它都记下来以便停止跟随。 */
export function noteUserThemeChoice(value) {
  const next = String(value || '').trim();
  if (!next || next === 'system') {
    writeFollowed('');
    return;
  }
  writeFollowed(next);
}

/** 宿主当前主题（从 documentElement 的类上读）。 */
export function hostTheme() {
  if (typeof document === 'undefined' || !document.documentElement) return '';
  const cl = document.documentElement.classList;
  if (cl.contains('dark')) return 'dark';
  if (cl.contains('light')) return 'light';
  return '';
}

/**
 * 装上主题跟随。
 *
 * 与 i18n 同样的三条监听（CustomEvent、`class` 属性变化、storage）：
 * 不同宿主版本推的方式不完全一样，冗余是刻意的。
 */
export function installThemeSync() {
  const follow = () => applyHostTheme(hostTheme());

  // 首次：宿主已经把类打在 documentElement 上了
  follow();

  window.addEventListener('otools-theme-changed', (event) => {
    const detail = event && event.detail;
    const mode = detail && (detail.resolvedTheme || detail.themeMode);
    applyHostTheme(mode === 'system' ? hostTheme() : String(mode || hostTheme()));
  });
  document.addEventListener('otools-theme-changed', (event) => {
    const detail = event && event.detail;
    const mode = detail && (detail.resolvedTheme || detail.themeMode);
    applyHostTheme(mode === 'system' ? hostTheme() : String(mode || hostTheme()));
  });

  if (typeof MutationObserver === 'function' && document.documentElement) {
    new MutationObserver(follow).observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class', 'data-theme-mode'],
    });
  }
}
