/**
 * 启动胶水：把「语言 + 主题 + 本地文件」三件事一次装好。
 * ------------------------------------------------------------------
 * 各插件的 overlay 入口（`shell/overlay/src/main.*`）在渲染界面之前 import 它
 * 一次就行。之所以集中在这里，是因为这三件事有顺序依赖：
 *
 *   1. 先装 i18n —— 之后所有 `t()` 才拿得到当前语言；
 *   2. 再装 DOM 翻译层 —— 它订阅 i18n 的变更，切语言时整棵树重译；
 *   3. 最后装主题跟随 —— 它会写上游的主题 storage key 并触发重画。
 *
 * 顺序反过来会出现「界面按英文画完再翻一遍」这种闪一下的效果。
 *
 * 幂等：重复 import / 重复调用都不会装第二遍。
 */

import { installI18n } from './i18n.js';
import { installDomTranslation } from './dom-i18n.js';
import { installThemeSync } from './theme-sync.js';
import { APP } from './app.js';
import { usingHost, libraryDir } from './local.js';

let booted = false;

export function boot() {
  if (booted) return;
  booted = true;

  installI18n();
  installDomTranslation();

  // 主题跟随放在 i18n 之后：上游有些面板的文案依赖主题（比如「深色」菜单项）。
  installThemeSync();

  // 库目录提前建好：用户第一次保存时不想再等一次目录创建 + 宿主往返。
  // 失败也不影响启动（宿主不在时本来就用浏览器兜底）。
  if (usingHost()) {
    libraryDir().catch(() => { /* 建不了目录不该让启动失败 */ });
  }

  if (typeof document !== 'undefined') {
    document.documentElement.dataset.otoolsPlugin = APP.id;
  }
}

boot();
