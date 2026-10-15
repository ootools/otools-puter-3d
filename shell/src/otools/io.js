/**
 * 本机文件接缝：把上游的文件出入口接到 OTools 宿主上。
 * ------------------------------------------------------------------
 * 上游 3D 完全没有 Puter 依赖（源码里 "puter" 只出现在导出文件头的字符串里，
 * 比如 `# Puter 3D OBJ File`），它的文件出入口就是浏览器原生的两招：
 *
 *   写 —— `URL.createObjectURL(blob)` + `<a download>`（src/io/native.ts 的
 *        `download()`，以及 src/render/final/result.ts 里同名的那一份）；
 *   读 —— 造一个隐藏的 `<input type=file>` 点它（`pickFile()`）。
 *
 * OTools 的 webview 里下载通常是禁的，「读」虽然能用但走不到用户的目录，
 * 所以这里把这两招换成 `local.js` 的统一入口 `exportFile` / `importFiles`：
 * 宿主在就走系统对话框 + 真磁盘，宿主不在就退回浏览器那两招——也就是上游
 * 现在的行为，不会更差。
 *
 * 接缝的形状是刻意压扁的：`shell/edits.mjs` 只能在上面两个文件里各插 1~2 行，
 * 所以「同步判断宿主在不在」与「异步真正去读写」必须拆成两个函数——
 * `download()` 是同步的，没法 `await usingHost()`。
 *
 * 另外这里**不**静态 import `local.js` / `host.js`：那条链在模块加载时就要
 * `window`（`host.js` 末尾的 `install()`）。上游有测试在 node 环境里 import
 * `src/io/native.ts`（tests/unit/greasepencil.test.ts），静态 import 会让它在
 * 那里直接炸掉。所以统一走动态 import，并且所有 window 访问都在函数体内。
 */

import { APP } from './app.js';
import { t } from './i18n.js';

/**
 * 同步判断宿主在不在。
 *
 * 判据与 `host.js` 的 `channel()` 一致（包装 API 优先，其次原生 IPC），
 * 只是不能再 import 一次 `host.js`——原因见文件头。
 */
export function usingHostDisk() {
  if (typeof window === 'undefined') return false;
  const w = window;
  const wrap = w.otools || w.utools;
  if (wrap && wrap.dialog && typeof wrap.readHostFile === 'function') return true;
  return Boolean(w.__TAURI_INTERNALS__ && typeof w.__TAURI_INTERNALS__.invoke === 'function');
}

/** 文件自己的扩展名（没有就空串）。 */
function extOf(name) {
  const m = /\.([A-Za-z0-9]{1,8})$/.exec(String(name || ''));
  return m ? m[1].toLowerCase() : '';
}

/**
 * 存一个 blob 到本机。
 *
 * 宿主在就弹另存对话框落到磁盘；宿主不在时交给 `exportFile`，它会退回浏览器
 * 下载。失败只记一条 warning：调用方（`download()`）本来就是「点了就不管」的
 * 形状，抛出去只会变成没人接的 rejection。
 *
 * 这里自己问一次保存路径，而不用 `local.js` 的 `saveFileAs`：后者把过滤器写死
 * 成 `APP.extensions`（3D 上是 glb/gltf/usd/…），而 3D 真正要落盘的后缀有一大
 * 堆——.p3d（主格式，还不在那份清单里）、.png/.webm/.zip（渲染输出）、
 * .csv/.txt/.py（脚本与跟踪数据）……用固定清单会把「保存工程」挡在对话框外面。
 * 所以按**这一次要存的那个文件**的扩展名做过滤器，其余（默认目录、写盘）仍旧
 * 走 `local.js`。
 *
 * @returns {Promise<{path: string, name: string}|null>} 用户取消时是 null
 */
export async function saveToDevice(blob, name) {
  try {
    const local = await import('./local.js');
    if (!local.usingHost()) return await local.exportFile(blob, name);
    const host = await import('./host.js');
    const dir = await local.libraryDir().catch(() => '');
    const ext = extOf(name);
    const path = await host.pickSavePath({
      title: t('Save'),
      defaultPath: dir ? await host.joinPath(dir, name) : name,
      filters: ext ? [{ name: APP.product, extensions: [ext] }] : undefined,
    });
    return path ? local.writeToPath(path, blob) : null;
  } catch (error) {
    console.warn('[otools] 保存到本机失败：', error);
    return null;
  }
}

/**
 * 用宿主的打开对话框选一个文件，按上游的形状返回 `File`。
 *
 * `pickFile()` 的调用方都拿 `File` 去读（`file.arrayBuffer()` / `file.name`），
 * 所以这里把宿主读回来的 blob 包成 `File`，其余代码一行都不用改。
 * 宿主不在时 `importFiles` 会用 `<input type=file>` 兜底；用户取消返回 null。
 */
export async function pickLocalFile(accept) {
  try {
    const { importFiles } = await import('./local.js');
    const files = await importFiles({ accept });
    const first = files[0];
    if (!first) return null;
    const blob = typeof first.read === 'function' ? await first.read() : first.blob;
    if (blob instanceof File) return blob;
    return new File([await blob.arrayBuffer()], first.name || 'file', { type: blob.type || '' });
  } catch (error) {
    console.warn('[otools] 从本机读文件失败：', error);
    return null;
  }
}
