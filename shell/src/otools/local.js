/**
 * 本地文件后端：把上游的 Puter 云盘换成「这台机器上的普通文件」。
 * ------------------------------------------------------------------
 * 这一层是「本地文件优先」这句话的落点，也是五个 puter-* 插件共用的那一块。
 * 每个插件的 overlay 里有一个 seam 文件（photo-studio 是
 * `src/persistence/puter.ts`、documents/spreadsheet 是 `src/lib/puter.js`、
 * presentation 是 `src/cloud.js`），它们**只**从这里取能力，不直接碰宿主。
 *
 * 三条退路，按优先级：
 *
 *   1. **宿主磁盘**（OTools 里）：系统打开/另存对话框 + 真·本地读写。
 *      这是正常路径，文件就是用户能在访达/资源管理器里看到的普通文件。
 *   2. **浏览器下载 / `<input type=file>`**：宿主不在（把 dist/ 拖进普通浏览器）
 *      时的兜底。读用 file input，写用 `URL.createObjectURL` 触发下载。
 *   3. **OPFS**：连下载都不方便时（比如只想暂存一个草稿）的最后退路。
 *      OPFS 里的内容**不出现在用户的文件系统里**，所以只当兜底，不当默认。
 *
 * 关于 Puter 登录：
 *   上游的 `puter.auth.isSignedIn / signIn / getUser` 这类能力在这个插件里
 *   一律由 `localAuth` 顶掉——「登录状态」这个概念在本地文件模型下没有意义，
 *   对应的是「这台机器能用」。所以 `isSignedIn()` 恒为 true、`signIn()` 是空
 *   操作、`getUser()` 给一个本地身份。**上游那些「登录 / 云同步 / 协作」的入口
 *   在各插件的 `shell/edits.mjs` 里被摘掉或置灰，不在这个底座里假装它们能用。**
 */

import * as host from './host.js';
import { t } from './i18n.js';
import { APP } from './app.js';

/* ------------------------------------------------------------ 通道判断 */

/** 宿主在不在（在就用真磁盘，不在就走浏览器兜底）。 */
export function usingHost() {
  return host.available();
}

/**
 * 本地身份：顶掉上游 `puter.auth.getUser()`。
 *
 * 用户名取宿主的系统用户名（拿不到就用 'Local'）。它会出现在协作头像、
 * 「以谁的身份保存」这类地方——在本地模型下那都指这台机器的使用者。
 */
export function localUser() {
  const fromEnv = String(host.env()?.username || host.env()?.user || '').trim();
  return { username: fromEnv || 'Local' };
}

/**
 * Puter 登录能力的替身。
 *
 * 刻意**不抛异常**：上游很多地方是 `if (await isSignedIn()) { …云… } else { …本地… }`
 * 这种形状，让它恒为 true 会让那些分支走到云代码上去。所以这里给的是
 * 「已登录到本地」的语义，而真正需要云的入口由 `edits.mjs` 在界面上摘掉。
 */
export const localAuth = {
  isSignedIn: () => true,
  async signIn() {
    return localUser();
  },
  signOut() {
    /* 本地文件没有「登出」这回事 */
  },
  async getUser() {
    return localUser();
  },
  async getProfilePicture() {
    return null;
  },
};

/* -------------------------------------------------------------- 库目录 */

const ROOT_KEY = `${APP.id}.root`;

/**
 * 本机库目录：`<文档>/<APP.folder>`。
 *
 * 第一次用时建出来并写一个空的标记文件（APP.marker）。标记文件的作用只有一个：
 * 万一用户把这个目录挪走或改名，我们不会把一个普通目录误认成自己的库。
 * 目录位置记在 localStorage，用户可以在界面里改（各插件的偏好设置）。
 */
export async function libraryDir({ create = true } = {}) {
  const remembered = readRoot();
  if (remembered) return remembered;

  const base = APP.rootKeys.map((k) => host.knownPath(k)).find((p) => p) || '';
  if (!base) return '';
  const dir = await host.joinPath(base, APP.folder);
  if (!create) return dir;

  await host.createDir(dir);
  const marker = await host.joinPath(dir, APP.marker);
  const existing = await host.readFile(marker);
  if (!existing) {
    await host.writeFile(marker, btoa(JSON.stringify({
      app: APP.id,
      name: APP.product,
      note: t('This folder is the {product} document library. Files here are ordinary files on this computer.', { product: APP.product }),
    })));
  }
  writeRoot(dir);
  return dir;
}

function readRoot() {
  try {
    return String(window.localStorage.getItem(ROOT_KEY) || '').trim();
  } catch {
    return '';
  }
}

function writeRoot(value) {
  try {
    window.localStorage.setItem(ROOT_KEY, String(value || ''));
  } catch {
    /* 忽略 */
  }
}

/** 用户选定一个已有的目录作为库目录。 */
export async function chooseLibraryDir() {
  const picked = await host.pickFolder({ title: t('Choose a folder for {product} documents', { product: APP.product }) });
  if (!picked) return '';
  writeRoot(picked);
  await host.createDir(picked);
  return picked;
}

/** 列出库目录里的文件（目录不存在时返回 []）。 */
export async function listLibrary() {
  const dir = await libraryDir({ create: false });
  if (!dir) return [];
  const entries = await host.listDir(dir);
  return entries.filter((e) => !e.isDir && e.name !== APP.marker);
}

/** 从库目录里读一个文件（按名字）。 */
export async function readFromLibrary(name) {
  const dir = await libraryDir({ create: false });
  if (!dir) return null;
  const file = await host.readFile(await host.joinPath(dir, name));
  return file ? host.base64ToBlob(file.dataBase64, file.mime) : null;
}

/** 从库目录里删一个文件。 */
export async function removeFromLibrary(name) {
  const dir = await libraryDir({ create: false });
  if (!dir) return;
  await host.removeEntry(await host.joinPath(dir, name));
}

/* ------------------------------------------------------------ 打开 / 保存 */

/** 名字冲突时补后缀：`报告.docx` → `报告 2.docx`。 */
export function dedupeName(name, taken) {
  const set = new Set([...(taken || [])].map((n) => String(n).toLowerCase()));
  if (!set.has(String(name).toLowerCase())) return name;
  const dot = String(name).lastIndexOf('.');
  const base = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  for (let i = 2; i < 1000; i += 1) {
    const candidate = `${base} ${i}${ext}`;
    if (!set.has(candidate.toLowerCase())) return candidate;
  }
  return `${base} ${Date.now()}${ext}`;
}

/**
 * 弹「打开」对话框并读出内容。
 *
 * @param {{accept?: string, multiple?: boolean, title?: string}} options
 * @returns {Promise<Array<{path: string, name: string, blob: Blob, read: () => Promise<Blob>}>>}
 *   取消或宿主不在时返回 []（宿主不在时调用方应退到 `pickFilesWithInput`）。
 */
export async function openFiles({ accept, multiple = false, title } = {}) {
  if (!usingHost()) return [];
  const paths = await host.pickFiles({
    multiple,
    title: title || t('Open'),
    filters: accept ? [{ name: APP.product, extensions: extensionList(accept) }] : undefined,
  });
  const out = [];
  for (const path of paths) {
    const file = await host.readFile(path);
    if (!file) continue;
    const blob = host.base64ToBlob(file.dataBase64, file.mime || host.mimeForPath(path));
    out.push({ path, name: file.name, blob, async read() { return blob; } });
  }
  return out;
}

/** 只弹对话框拿第一个文件（上游的 `showOpenFilePicker` 就是这个形状）。 */
export async function openFile(options) {
  const files = await openFiles({ multiple: false, ...options });
  return files[0] || null;
}

/**
 * 弹「另存为」对话框并写入。
 *
 * @returns {Promise<{path: string, name: string, read: () => Promise<Blob>}|null>}
 */
export async function saveFileAs(blob, name) {
  if (!usingHost()) return null;
  const dir = await libraryDir({ create: false });
  const path = await host.pickSavePath({
    title: t('Save'),
    defaultPath: dir ? await host.joinPath(dir, name) : name,
    filters: [{ name: APP.product, extensions: APP.extensions }],
  });
  if (!path) return null;
  return writeToPath(path, blob);
}

/** 写到一个已经记住的路径（没弹对话框的「保存」）。 */
export async function writeToPath(path, blob) {
  await host.writeBlob(path, blob);
  return { path, name: host.baseName(path), async read() { return blob; } };
}

/** 读一个已知路径。 */
export async function readPath(path) {
  const file = await host.readFile(path);
  if (!file) return null;
  return host.base64ToBlob(file.dataBase64, file.mime || host.mimeForPath(path));
}

/**
 * 不弹对话框，直接落到库目录（「快速保存」/ 自动保存走这条）。
 * 返回写入后的完整路径。
 */
export async function saveToLibrary(blob, name) {
  const dir = await libraryDir();
  if (!dir) throw new Error(t('OTools host is not available'));
  const taken = new Set((await listLibrary()).map((e) => e.name));
  const target = await host.joinPath(dir, dedupeName(name, taken));
  await host.writeBlob(target, blob);
  return target;
}

/* ---------------------------------------------------- 浏览器兜底（无宿主） */

/**
 * 宿主不在时用 `<input type=file>` 读文件。
 *
 * 造一个隐藏的 input、点它、等 change——这是浏览器里唯一能拿到用户选中的
 * 文件的方式。取消时 Promise 一直挂着直到下一次调用（浏览器不告诉我们取消），
 * 所以额外监听一次 window focus 来判定「用户关掉了对话框」。
 */
export function pickFilesWithInput({ accept, multiple = false } = {}) {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = Boolean(multiple);
    if (accept) input.accept = accept;
    input.style.display = 'none';
    let settled = false;
    const finish = (files) => {
      if (settled) return;
      settled = true;
      window.removeEventListener('focus', onFocus);
      input.remove();
      resolve(files);
    };
    const onFocus = () => setTimeout(() => finish([]), 500);
    input.addEventListener('change', () => finish([...input.files]));
    window.addEventListener('focus', onFocus);
    document.body.appendChild(input);
    input.click();
  });
}

/** 宿主不在时用浏览器下载导出。 */
export function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/* ------------------------------------------------------------- OPFS 兜底 */

/** OPFS 的私有根（每个插件一个目录，避免五个插件互相踩）。 */
async function opfsRoot() {
  if (typeof navigator === 'undefined' || !navigator.storage?.getDirectory) return null;
  try {
    const root = await navigator.storage.getDirectory();
    return await root.getDirectoryHandle(APP.id, { create: true });
  } catch {
    return null;
  }
}

/** OPFS 里写一份（宿主不在时的最后退路）。 */
export async function opfsWrite(name, blob) {
  const dir = await opfsRoot();
  if (!dir) return null;
  const handle = await dir.getFileHandle(name, { create: true });
  const writable = await handle.createWritable();
  await writable.write(blob);
  await writable.close();
  return name;
}

/** OPFS 里读一份。 */
export async function opfsRead(name) {
  const dir = await opfsRoot();
  if (!dir) return null;
  try {
    const handle = await dir.getFileHandle(name);
    return await handle.getFile();
  } catch {
    return null;
  }
}

/** 列出 OPFS 里的文件。 */
export async function opfsList() {
  const dir = await opfsRoot();
  if (!dir) return [];
  const out = [];
  for await (const [name, handle] of dir.entries()) {
    if (handle.kind === 'file') out.push({ name, path: `opfs:${name}` });
  }
  return out;
}

/** 从 OPFS 里删一份。 */
export async function opfsRemove(name) {
  const dir = await opfsRoot();
  if (!dir) return;
  try {
    await dir.removeEntry(name);
  } catch {
    /* 本来就不在 */
  }
}

/* ------------------------------------------------------------------ 杂项 */

/** 把 `<input accept>` 那种逗号串转成宿主 filters 要的扩展名数组。 */
function extensionList(accept) {
  return String(accept || '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.startsWith('.'))
    .map((s) => s.replace(/^\./, ''))
    .filter(Boolean);
}

/**
 * 统一的「导入」入口：宿主在就走系统对话框，不在就走 `<input type=file>`。
 * 各插件的 seam 都用它，省得每个都写一遍这个判断。
 */
export async function importFiles({ accept, multiple = false, title } = {}) {
  if (usingHost()) return openFiles({ accept, multiple, title });
  const files = await pickFilesWithInput({ accept, multiple });
  return files.map((f) => ({
    path: '',
    name: f.name,
    blob: f,
    async read() { return f; },
  }));
}

/**
 * 统一的「导出」入口：宿主在就落本地文件，不在就浏览器下载。
 * @param {Blob} blob
 * @param {string} name 建议文件名
 * @param {{silent?: boolean}} [options] silent=true 时不弹对话框，直接进库目录
 */
export async function exportFile(blob, name, { silent = false } = {}) {
  if (!usingHost()) {
    downloadBlob(blob, name);
    return { path: '', name };
  }
  if (silent) {
    const path = await saveToLibrary(blob, name);
    return { path, name: host.baseName(path) };
  }
  const saved = await saveFileAs(blob, name);
  return saved || { path: '', name };
}
