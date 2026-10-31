/**
 * 宿主投递的「打开文件」：SDK 契约（`otools-open-file`）的 shell 侧最小实现。
 * ------------------------------------------------------------------
 * 链路（宿主侧 `platform/file_open.rs`）：用户在系统里双击已绑定扩展名的文件 →
 * 宿主把路径排进按插件分桶的投递队列 → 对本 webview `emit_to("otools-open-file")`
 * 敲门。事件只做敲门，载荷一律用 `otools_consume_open_files` 取走，所以「宿主先投、
 * 插件后启动」与「插件先启、宿主后投」两种时序都不丢件。
 *
 * 新开标签时宿主还会把 `?otoolsOpenFile=["…"]` 拼进插件 URL（webview 事件早于
 * JS listener 就绪的兜底），这里与队列内容按 3 秒窗口去重合并。
 *
 * 两个使用层次：
 *   - [`installOpenFileBridge`] + [`onHostOpenFiles`]：`boot.js` 里装一次桥，
 *     上游的 overlay 入口只管订阅。桥会在订阅者出现之前先把投递**暂存**起来，
 *     所以「宿主先投、界面后订阅」也不会丢（启动期 consume 是异步的，与入口
 *     注册监听器之间存在真实窗口）。
 *   - [`onHostOpenFile`]：只要回调、不要暂存语义时直接用（与 SDK 同形）。
 *
 * 与 `host.js` 同一套通道哲学：Tauri 原生 IPC（`__TAURI_INTERNALS__`，含
 * parent/top 兜底）为准；两条都不通（dist 拖进普通浏览器）时静默不订阅——
 * 浏览器里本来就没有宿主投递这回事。
 */

import { APP } from './app.js';
import { diag } from './host.js';

const DELIVER_EVENT = 'otools-open-file';
const DEDUPE_WINDOW_MS = 3000;

/** 找得到 transformCallback + invoke 的窗口（window → parent → top）。 */
function tauriInternals() {
  if (typeof window === 'undefined') return null;
  const candidates = [window];
  try { if (window.parent && window.parent !== window) candidates.push(window.parent); } catch { /* 跨域 */ }
  try { if (window.top && window.top !== window) candidates.push(window.top); } catch { /* 跨域 */ }
  for (const candidate of candidates) {
    const internals = candidate && candidate.__TAURI_INTERNALS__;
    if (internals && typeof internals.invoke === 'function' && typeof internals.transformCallback === 'function') {
      return internals;
    }
  }
  return null;
}

/** Tauri 事件监听（与插件 SDK 的 listenTauri 同形）；通道不在时返回 null。 */
async function tauriListen(event, handler) {
  const internals = tauriInternals();
  if (!internals) return null;
  const handlerId = internals.transformCallback((payload) => {
    // Tauri 的回调形状是 { event, id, payload }，剥一层拿真载荷。
    const inner = payload && typeof payload === 'object' && 'payload' in payload
      ? payload.payload
      : payload;
    handler(inner);
  }, false);
  const eventId = await internals.invoke('plugin:event|listen', {
    event,
    target: { kind: 'Any' },
    handler: handlerId,
  });
  return async () => {
    try {
      await window.__TAURI_EVENT_PLUGIN_INTERNALS__?.unregisterListener?.(event, eventId);
    } catch { /* 后端 unlisten 仍会清掉服务端监听 */ }
    internals.unregisterCallback?.(handlerId);
    try {
      await internals.invoke('plugin:event|unlisten', { event, eventId });
    } catch { /* 已注销时忽略 */ }
  };
}

function parseLaunchPaths(search) {
  if (!search) return [];
  try {
    const raw = new URLSearchParams(search).get('otoolsOpenFile');
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.map((item) => String(item || '').trim()).filter(Boolean);
  } catch {
    return [];
  }
}

/** 把绝对路径拆成 `{ path, name, ext }`（扩展名小写、不带点）。 */
export function describePath(path) {
  const normalized = String(path || '').trim();
  const i = Math.max(normalized.lastIndexOf('/'), normalized.lastIndexOf('\\'));
  const name = i >= 0 ? normalized.slice(i + 1) : normalized;
  const dot = name.lastIndexOf('.');
  return { path: normalized, name, ext: dot > 0 ? name.slice(dot + 1).toLowerCase() : '' };
}

/**
 * 订阅宿主投递的文件。返回 unlisten（通道不可用时返回 null，handler 不会触发）。
 * 回调参数是 `[{ path, name, ext }]`。
 */
export async function onHostOpenFile(handler) {
  if (typeof window === 'undefined') return null;
  const recent = new Map();
  const deliver = (paths) => {
    const now = Date.now();
    const fresh = [];
    for (const path of paths) {
      const normalized = String(path || '').trim();
      if (!normalized) continue;
      const seenAt = recent.get(normalized);
      if (typeof seenAt === 'number' && now - seenAt < DEDUPE_WINDOW_MS) continue;
      recent.set(normalized, now);
      fresh.push(normalized);
    }
    if (recent.size > 256) {
      for (const [path, seenAt] of recent) {
        if (now - seenAt >= DEDUPE_WINDOW_MS) recent.delete(path);
      }
    }
    if (fresh.length) handler(fresh.map(describePath));
  };

  const consume = async () => {
    try {
      const internals = tauriInternals();
      if (!internals) return;
      const result = await internals.invoke('otools_consume_open_files', { pluginUuid: APP.id });
      deliver(Array.isArray(result) ? result.map(String) : []);
    } catch (error) {
      diag({ openFileConsumeError: String(error) });
    }
  };

  // 与 SDK 相同的顺序：先注册 listener 再 consume，保证「取空后宿主才投递」
  // 的窗口里敲门一定命中。
  const unlisten = await tauriListen(DELIVER_EVENT, () => { void consume(); });
  const launchPaths = parseLaunchPaths(window.location?.search || '');
  if (launchPaths.length) deliver(launchPaths);
  void consume();
  diag({ openFileHook: unlisten ? 'on' : 'off' });
  return unlisten;
}

/* ------------------------------------------------------------ 暂存式桥 */

/** 订阅者出现之前收到的投递（启动期 consume 早于界面注册监听的真实窗口）。 */
let pending = [];
const subscribers = new Set();

/**
 * 订阅宿主投递。订阅那一刻若已有暂存的投递，立即以一批交付。
 * 返回取消订阅函数。
 */
export function onHostOpenFiles(handler) {
  if (typeof handler !== 'function') return () => {};
  subscribers.add(handler);
  if (pending.length) {
    const batch = pending;
    pending = [];
    try { handler(batch); } catch (error) { diag({ openFileHandlerError: String(error) }); }
  }
  return () => subscribers.delete(handler);
}

function publish(entries) {
  if (!entries.length) return;
  if (!subscribers.size) {
    pending = pending.concat(entries);
    // 上限防呆：投递在无人消费时不该无限堆积。
    if (pending.length > 64) pending = pending.slice(-64);
    return;
  }
  for (const handler of [...subscribers]) {
    try { handler(entries); } catch (error) { diag({ openFileHandlerError: String(error) }); }
  }
}

let bridgeInstalled = false;

/**
 * 装宿主投递桥：`boot.js` 里调一次，幂等。
 *
 * 必须在界面入口之前装：宿主对插件 webview 的敲门可能早于 overlay 入口的
 * 订阅代码执行，桥在这里先接住并暂存。
 */
export function installOpenFileBridge() {
  if (bridgeInstalled) return;
  bridgeInstalled = true;
  void onHostOpenFile(publish);
}
