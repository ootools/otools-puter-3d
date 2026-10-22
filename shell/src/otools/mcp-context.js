/**
 * 3d 插件 MCP 领域工具的「活上下文」。
 * ------------------------------------------------------------------
 * 3d 的 overlay 用 `setApp(new App(...))` 建实例，`app` 是 `app/app.ts` 里的
 * `export let app`（**活绑定**）——工具直接 `import { app }` 即可，无需入口传句柄。
 *
 * 工具用 `app.doc`（DocumentData：`objects` 表 + `object_order`）、`app.scene`、
 * `app.activeObject`；写操作走 `app.pushUndo(label)` → 改对象 → `app.changed('doc')`。
 */

import { app } from '../app/app';

/** 当前 App；还没就绪时给出可行动的说明。 */
export function requireApp() {
  if (!app || !app.doc || !Array.isArray(app.doc.object_order)) {
    throw new Error('The 3D editor is not ready yet. Try again in a moment.');
  }
  return app;
}

/** MCP 形状的文本结果。 */
export const text = (value) => ({
  content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }],
  isError: false,
});
