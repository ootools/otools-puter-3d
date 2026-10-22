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
import { installMcpBridge } from './mcp.js';
import { d3McpTools } from './mcp-tools.js';

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

  // MCP 桥挂在最后：宿主读 `window.__otoolsMcp` 时会用到上面装好的库目录能力，
  // 所以它必须晚于 i18n / 主题就绪。挂载本身没有副作用（只赋值，不触发工具调用）。
  // 领域级工具（读/改当前场景对象）在 `otools/mcp-tools.js`；它们直接 import 的
  // `app`（app/app.ts 的活绑定）在 setApp 之后自动可用，无需入口传句柄。
  installMcpBridge({ extraTools: d3McpTools() });

  if (typeof document !== 'undefined') {
    document.documentElement.dataset.otoolsPlugin = APP.id;
  }
}

boot();
