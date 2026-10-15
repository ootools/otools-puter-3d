/**
 * OTools 宿主桥：把「文件从哪来、存到哪去」接到 OTools 宿主的系统对话框与
 * 本地磁盘上。这是移植层唯一的底座，其它移植文件都建在它上面。
 *
 * 上游这几个应用（Photo Studio / 3D / Documents / Spreadsheet / Presentation）
 * 都是纯前端 Vite 应用，文件存在 Puter 云盘（未登录时退回浏览器 OPFS）。
 * 本插件把这一层换成宿主：
 *
 *   上游做法                                  插件做法
 *   ----------------------------------------  ------------------------------------------
 *   puter.fs.read/write/readdir/delete        宿主 tools_webview_read_file / write_file /
 *                                             list_dir / remove_entry（真·本地磁盘）
 *   puter.ui.showOpenFilePicker               宿主 tools_webview_pick_files
 *   puter.ui.showSaveFilePicker               宿主 tools_webview_pick_save_path + write_file
 *   puter.auth.isSignedIn / signIn            恒为「已登录到本地」/ 空操作（见 local.js）
 *   浏览器下载（未登录时）                     同上，落到用户选定的本地路径
 *   OPFS（未登录时的兜底）                     宿主不在时的最后退路
 *
 * 宿主能力有两条通道，任一条通就算「在 OTools 里」（与 otools-cadcraft、
 * otools-video 同样的经验：个别 webview 里注入的 `window.otools` 包装会缺席，
 * 但 Tauri 自己的 `__TAURI_INTERNALS__.invoke` 是好的）：
 *
 *   1. 包装 API   `window.otools` / `window.utools`
 *                 —— dialog.open/save、readHostFile、writeHostFile、listHostDir
 *   2. 原生 IPC   `window.__TAURI_INTERNALS__.invoke`
 *                 —— 直接调 tools_webview_* 命令（含 window.parent / window.top 兜底）
 *
 * 参数形状（Rust 侧 `rename_all = "camelCase"`，Tauri 按参数名从载荷里取）：
 *   pick_files        { options: { multiple, title, directory, filters } }
 *   pick_folder       { options: { title, directory } }
 *   pick_save_path    { options: { title, suggestedName, directory, filters } }
 *   read_file         { path }
 *   write_file        { request: { path, dataBase64 } }   ← 结构体参数，平铺会被拒
 *   list_dir          { path }
 *   create_dir        { path }
 *   remove_entry      { path, recursive }
 *   rename_entry      { request: { from, to } }           ← 同样是结构体参数
 *   join_path         { parts: [...] }
 *
 * 两条通道都不通（把 dist/ 拖进普通浏览器）时 `available()` 为 false，
 * 此时由 `local.js` 退回浏览器行为（`<input type=file>` 导入、下载导出、OPFS）。
 */

import { t } from './i18n.js';
import { APP } from './app.js';

const DIAG_KEY = `${APP.id}.diag`;

/* ------------------------------------------------------------------ 工具 */

/** 诊断面包屑：插件没有 devtools，localStorage 是事后唯一能看到内部状态的渠道。 */
export function diag(patch) {
  try {
    const d = JSON.parse(window.localStorage.getItem(DIAG_KEY) || '{}') || {};
    Object.assign(d, patch);
    d.at = new Date().toISOString();
    window.localStorage.setItem(DIAG_KEY, JSON.stringify(d));
  } catch {
    /* 隐私模式等场景下忽略 */
  }
}

/** 取路径的最后一段（两种分隔符都认）。 */
export function baseName(p) {
  const s = String(p || '');
  const i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
  return i >= 0 ? s.slice(i + 1) : s;
}

/** 取父目录；没有分隔符时返回空串。 */
export function dirName(p) {
  const s = String(p || '');
  const i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
  return i > 0 ? s.slice(0, i) : '';
}

/** 去掉扩展名（用于「另存为」时给建议名）。 */
export function stripExt(name) {
  const s = String(name || '');
  const i = s.lastIndexOf('.');
  return i > 0 ? s.slice(0, i) : s;
}

/** 改名时保住扩展名：用户改的就是 Basename，后缀跟着原来的走。 */
export function withExt(name, ext) {
  const base = stripExt(name);
  const e = String(ext || '').replace(/^\.+/, '');
  return e ? `${base}.${e}` : base;
}

/**
 * 用宿主的能力拼绝对路径，而不是在 JS 里硬拼分隔符：
 * 先试 `join_path`（宿主用 PathBuf，Windows 下会给出正确的 `\`），
 * 失败再退回手工拼接。
 */
export async function joinPath(...parts) {
  const list = parts.filter((p) => typeof p === 'string' && p.trim()).map((p) => p.trim());
  if (!list.length) return '';
  if (list.length === 1) return list[0];
  try {
    return await invokeRaw('tools_webview_join_path', { parts: list });
  } catch {
    return list.join('/').replace(/\/{2,}/g, '/');
  }
}

const CHUNK = 0x8000;

/** Uint8Array → base64（分块，避免 apply 的参数上限）。 */
export function bytesToBase64(bytes) {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let out = '';
  for (let i = 0; i < view.length; i += CHUNK) {
    out += String.fromCharCode.apply(null, view.subarray(i, i + CHUNK));
  }
  return btoa(out);
}

/** base64 → Uint8Array。 */
export function base64ToBytes(text) {
  const raw = atob(String(text || ''));
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

/** Blob → base64（宿主只收 base64，不收二进制）。 */
export async function blobToBase64(blob) {
  return bytesToBase64(new Uint8Array(await blob.arrayBuffer()));
}

/** base64 + MIME → Blob。 */
export function base64ToBlob(dataBase64, mime) {
  const bytes = base64ToBytes(dataBase64);
  return new Blob([bytes], mime ? { type: mime } : undefined);
}

/** 按扩展名猜 MIME（宿主读文件时也会给 mime，这里只是兜底）。 */
const MIME_BY_EXT = {
  // 文档办公（这五个插件的主战场）
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  dotx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.template',
  docm: 'application/vnd.ms-word.document.macroEnabled12',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  xlsm: 'application/vnd.ms-excel.sheet.macroEnabled12',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  ppsx: 'application/vnd.openxmlformats-officedocument.presentationml.slideshow',
  hwp: 'application/x-hwp', hwpx: 'application/hwp+zip',
  pdf: 'application/pdf', md: 'text/markdown', txt: 'text/plain',
  csv: 'text/csv', ods: 'application/vnd.oasis.opendocument.spreadsheet',
  odt: 'application/vnd.oasis.opendocument.text',
  odp: 'application/vnd.oasis.opendocument.presentation',
  // 图像与工程
  psd: 'image/vnd.adobe.photoshop', psb: 'image/vnd.adobe.photoshop',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp',
  gif: 'image/gif', bmp: 'image/bmp', avif: 'image/avif', svg: 'image/svg+xml',
  glb: 'model/gltf-binary', gltf: 'model/gltf+json', obj: 'text/plain',
  usd: 'text/plain', usda: 'text/plain', usdz: 'model/vnd.usdz+zip',
  // 音视频（3D 的动画导出、Presentation 的媒体插入）
  mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', mkv: 'video/x-matroska',
  avi: 'video/x-msvideo', m4v: 'video/x-m4v',
  mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4', ogg: 'audio/ogg', flac: 'audio/flac',
  // 通用
  json: 'application/json', zip: 'application/zip',
};

export function mimeForPath(path, fallback = '') {
  const name = baseName(path).toLowerCase();
  const dot = name.lastIndexOf('.');
  if (dot < 0) return fallback;
  return MIME_BY_EXT[name.slice(dot + 1)] || fallback;
}

/** 宿主缺文件时的报错五花八门，统一识别成「不存在」而不是抛出。 */
function isMissing(err) {
  const text = String(err?.message || err?.error?.message || err || '');
  return /not found|no such|does not exist|cannot find|os error 2|系统找不到|找不到|不存在|拒绝访问|Access is denied/i.test(text);
}

export function errorMessage(err) {
  if (!err) return t('Unknown error');
  if (typeof err === 'string') return err;
  return String(err.message || err.error?.message || err);
}

/* ------------------------------------------------------------ 通道探测 */

/** 完整的宿主包装 API（dialog + readHostFile），没有则 null。 */
function wrapper() {
  const a = (typeof window !== 'undefined' && (window.otools || window.utools)) || null;
  return a && a.dialog && typeof a.dialog.open === 'function' && typeof a.readHostFile === 'function' ? a : null;
}

/** Tauri 原生 IPC（包装缺席时的兜底通道；普通浏览器里没有）。 */
function tauriInvoke() {
  const candidates = [window];
  try { if (window.parent && window.parent !== window) candidates.push(window.parent); } catch { /* 跨域 */ }
  try { if (window.top && window.top !== window) candidates.push(window.top); } catch { /* 跨域 */ }
  for (const c of candidates) {
    const t = c && c.__TAURI_INTERNALS__;
    if (t && typeof t.invoke === 'function') return t.invoke.bind(t);
  }
  return null;
}

function invokeRaw(command, payload) {
  const invoke = tauriInvoke();
  if (!invoke) return Promise.reject(new Error(t('OTools host is not available')));
  return invoke(command, payload);
}

/** 走哪条通道：'wrapper' | 'raw' | 'none'。 */
export function channel() {
  if (wrapper()) return 'wrapper';
  if (tauriInvoke()) return 'raw';
  return 'none';
}

/** 是否运行在 OTools 宿主里。 */
export function available() {
  const c = channel();
  diag({ bridge: c, host: c !== 'none' });
  return c !== 'none';
}

/** OTools 的界面主题（dark / light / ''）。 */
export function theme() {
  if (typeof document === 'undefined') return '';
  const cl = document.documentElement && document.documentElement.classList;
  if (!cl) return '';
  if (cl.contains('dark')) return 'dark';
  if (cl.contains('light')) return 'light';
  return '';
}

/** 宿主环境变量（`window.__OToolsEnv`）。 */
export function env() {
  try {
    return window.__OToolsEnv && typeof window.__OToolsEnv === 'object' ? window.__OToolsEnv : {};
  } catch {
    return {};
  }
}

/** 宿主公开的路径（home / documents / videos / appData …）。 */
export function knownPath(name) {
  const paths = env().paths;
  const value = paths && typeof paths === 'object' ? paths[name] : '';
  return typeof value === 'string' ? value.trim() : '';
}

/** 宿主应用名（用于窗口标题与提示）。 */
export function appName() {
  return String(env().appName || '').trim() || 'OTools';
}

/* -------------------------------------------------------- 对话框 / 文件 */

function firstPath(picked) {
  if (Array.isArray(picked)) return picked.length ? String(picked[0] || '').trim() || null : null;
  if (picked && typeof picked === 'object' && typeof picked.path === 'string') return picked.path.trim() || null;
  return typeof picked === 'string' ? picked.trim() || null : null;
}

/** 把默认路径拆成「目录 + 建议名」，规则对齐宿主 resolveDialogDirectoryAndName。 */
export function splitPath(p) {
  const s = String(p || '').trim();
  if (!s) return { directory: undefined, fileName: undefined };
  const m = /^(.*[\\/])([^\\/]+)$/.exec(s);
  if (!m) return { directory: undefined, fileName: s };
  return { directory: m[1].replace(/[\\/]+$/, '') || undefined, fileName: m[2].trim() || undefined };
}

/** 弹打开文件对话框，返回选中的路径数组（取消为 []）。 */
export async function pickFiles({ multiple = false, title, directory, filters } = {}) {
  const options = { multiple: Boolean(multiple), title, directory, filters };
  const a = wrapper();
  if (a) {
    const picked = await a.dialog.open({ multiple: Boolean(multiple), title, directory, filters });
    if (Array.isArray(picked)) return picked.map((p) => String(p || '').trim()).filter(Boolean);
    const one = firstPath(picked);
    return one ? [one] : [];
  }
  const files = await invokeRaw('tools_webview_pick_files', { options });
  const list = Array.isArray(files) ? files : files ? [files] : [];
  return list.map((f) => (typeof f === 'string' ? f.trim() : String(f?.path || '').trim())).filter(Boolean);
}

/** 弹选择目录对话框，返回选中的目录（取消为 null）。 */
export async function pickFolder({ title, directory } = {}) {
  const a = wrapper();
  if (a && typeof a.dialog.open === 'function') {
    return firstPath(await a.dialog.open({ directory: true, multiple: false, title }));
  }
  const folder = await invokeRaw('tools_webview_pick_folder', { options: { title, directory } });
  if (!folder) return null;
  return typeof folder === 'string' ? folder.trim() || null : String(folder.path || '').trim() || null;
}

/** 弹另存对话框，返回选中的完整路径（取消为 null）。 */
export async function pickSavePath({ title, defaultPath, filters } = {}) {
  const a = wrapper();
  if (a) return firstPath(await a.dialog.save({ title, defaultPath, filters }));
  const sp = splitPath(defaultPath);
  const meta = await invokeRaw('tools_webview_pick_save_path', {
    options: { title, suggestedName: sp.fileName, directory: sp.directory, filters },
  });
  if (!meta) return null;
  return typeof meta === 'string' ? meta.trim() || null : String(meta.path || '').trim() || null;
}

/** 读宿主文件；文件不存在时返回 null（调用方按「没有」处理）。 */
export async function readFile(path) {
  try {
    const a = wrapper();
    const file = a && typeof a.readHostFile === 'function'
      ? await a.readHostFile(path)
      : await invokeRaw('tools_webview_read_file', { path });
    if (!file) return null;
    return {
      path: String(file.path || path),
      name: String(file.name || baseName(path)),
      size: Number(file.size) || 0,
      mime: String(file.mime || '') || mimeForPath(path),
      lastModified: Number(file.lastModified || file.last_modified) || 0,
      dataBase64: String(file.dataBase64 || ''),
    };
  } catch (err) {
    if (isMissing(err)) return null;
    throw err;
  }
}

/**
 * 写宿主文件。
 *
 * Rust 侧 `tools_webview_write_file(request: WebviewWriteFileRequest)` 收的是
 * 名为 `request` 的结构体参数，平铺 `{path, dataBase64}` 会被 Tauri 以
 * "missing required key `request`" 拒掉——宿主自带的 `writeHostFile` 包装正是
 * 这么调的（latent bug，cadcraft 0.6.4 踩过），所以只要原生 IPC 在就优先走
 * 原生，包装只在原生不在时兜底；原生报参数错时再退回包装重试一次。
 */
export async function writeFile(path, dataBase64) {
  const invoke = tauriInvoke();
  if (invoke) {
    try {
      await invoke('tools_webview_write_file', { request: { path, dataBase64 } });
      return path;
    } catch (err) {
      const a = wrapper();
      if (a && typeof a.writeHostFile === 'function') {
        await a.writeHostFile({ path, dataBase64 });
        return path;
      }
      throw err;
    }
  }
  const a = wrapper();
  if (a && typeof a.writeHostFile === 'function') {
    await a.writeHostFile({ path, dataBase64 });
    return path;
  }
  throw new Error(t('OTools host is not available'));
}

/** 写 Blob 到宿主路径。 */
export async function writeBlob(path, blob) {
  return writeFile(path, await blobToBase64(blob));
}

/** 列出目录；目录不存在时返回 []。 */
export async function listDir(path) {
  try {
    const a = wrapper();
    const entries = a && typeof a.listHostDir === 'function'
      ? await a.listHostDir(path)
      : await invokeRaw('tools_webview_list_dir', { path });
    const list = Array.isArray(entries) ? entries : [];
    return list.map((e) => ({
      name: String(e?.name || baseName(e?.path || '')),
      path: String(e?.path || ''),
      isDir: e?.kind === 'directory' || e?.isDir === true || e?.is_dir === true,
      size: Number(e?.size) || 0,
      mime: String(e?.mime || ''),
      modified: Number(e?.lastModified ?? e?.last_modified ?? e?.modified) || 0,
    }));
  } catch (err) {
    if (isMissing(err)) return [];
    throw err;
  }
}

/** 建目录（宿主用 create_dir_all，会补齐父级）。 */
export async function createDir(path) {
  if (!path) return;
  await invokeRaw('tools_webview_create_dir', { path });
}

/** 删除文件或目录（默认递归，缺目录不算错）。 */
export async function removeEntry(path, { recursive = true } = {}) {
  try {
    await invokeRaw('tools_webview_remove_entry', { path, recursive: Boolean(recursive) });
  } catch (err) {
    if (!isMissing(err)) throw err;
  }
}

/** 重命名 / 移动。 */
export async function renameEntry(from, to) {
  await invokeRaw('tools_webview_rename_entry', { request: { from, to } });
}

/** 在系统文件管理器里定位一个路径（宿主包装没有这个能力时静默忽略）。 */
export function revealPath(path) {
  try {
    const a = wrapper();
    if (a && typeof a.shellShowItemInFolder === 'function') a.shellShowItemInFolder(path);
  } catch {
    /* 忽略 */
  }
}

/** 弹宿主的消息框（宿主不可用时退回 window.alert）。 */
export async function message(text, { title, kind = 'info' } = {}) {
  const a = wrapper();
  if (a && typeof a.dialog.message === 'function') {
    try {
      await a.dialog.message(text, { title, kind });
      return;
    } catch {
      /* 落到 alert */
    }
  }
  try { window.alert(text); } catch { /* 忽略 */ }
}

/**
 * 安装 `window[APP.bridge]`。
 *
 * 上游代码里没有这个全局——它是给**移植层自己**用的（`local.js`、各 overlay 的
 * seam 替换文件），也是排查问题时在 console 里可以直接敲的入口。名字取自
 * `app.js`，刻意与上游无关，避免和 `window.puter` 混淆。
 */
export function install() {
  const api = {
    app: APP,
    available,
    channel,
    theme,
    env,
    knownPath,
    appName,
    joinPath,
    splitPath,
    pickFiles,
    pickFolder,
    pickSavePath,
    readFile,
    writeFile,
    writeBlob,
    listDir,
    createDir,
    removeEntry,
    renameEntry,
    revealPath,
    message,
    baseName,
    dirName,
    stripExt,
    withExt,
    mimeForPath,
    blobToBase64,
    bytesToBase64,
    base64ToBytes,
    base64ToBlob,
    errorMessage,
    diag,
  };
  if (typeof window !== 'undefined') window[APP.bridge] = api;
  return api;
}

install();
