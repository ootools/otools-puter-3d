/**
 * 宿主 MCP 网关的插件侧桥（webview 后端）。
 * ------------------------------------------------------------------
 * 宿主在插件 webview 里 eval 一段脚本，脚本读 `window.__otoolsMcp` 的两个方法：
 *
 *   listTools()       → 本插件对外暴露的工具表
 *   call(name, args)  → 执行工具，返回 MCP 形状的 { content, isError }
 *
 * **回传由宿主脚本负责**：宿主后端拿到返回值后自己调 `mcp_webview_resolve`
 * 把结果交回网关，插件不需要知道 requestId，也不该自己调回传命令。这样插件
 * 只关心「我的工具有哪些、怎么执行」，与传输细节解耦。
 *
 * 本桥与 `@/plugins/shared/mcp-webview-bridge.ts` 语义一致，但那个模块属于宿主
 * 仓库（TypeScript，且不在本插件的构建树里），这里按同一契约用本插件的 JS
 * 风格实现一份——七个 puter-* 插件共用同一套移植层写法，不引入 TS 构建步骤。
 *
 * ## 为什么工具面只做「库目录的文件级操作」
 *
 * 七个 puter-* 插件（ps / 3d / documents / spreadsheet / presentation / audio /
 * video）共用同一套工具名与语义，只有 namespace 前缀不同。理由：
 *
 *   - 这些能力落在 `local.js`（宿主磁盘）上，不依赖上游应用的内部状态，
 *     所以插件刚启动、还没画完第一帧时也能用；
 *   - AI 在一个插件里学会的动作，换到另一个插件同样成立；
 *   - 领域级工具（「改这个图层」「读这张表的单元格」）需要各上游应用暴露
 *     真实句柄，属于各插件自己的适配工作，通用层不假装能做——需要时由入口
 *     传 `installMcpBridge({ extraTools })` 补，见文件末尾。
 *
 * ## 三条刻意的取舍
 *
 *   1. **文案用英文裸串、不走 `t()`**：这些描述是给外部 AI 读的，不是界面
 *      文案。进词表只会让 i18n 报告多出一批「永远不会显示」的待翻条目。
 *   2. **路径一律相对库目录**（`reports/q3.docx`），绝对路径与 `..` 直接拒绝。
 *      库目录之外的文件不该由 AI 经这个桥碰到。
 *   3. **只在宿主里挂载**：普通浏览器里挂一个没有宿主的 MCP 桥没有意义；
 *      工具表拿不到时返回空表，让宿主把本插件视为「暂无工具」而不是整段脚本失败。
 */

import { APP } from './app.js';
import { libraryDir } from './local.js';
import * as host from './host.js';

/** 单次 read_file 的字节上限：base64 会把体积放大 4/3，再大就不适合走 AI 上下文。 */
const MAX_READ_BYTES = 8 * 1024 * 1024;

/** list_library 单次返回的条目上限（`media/` 这类目录动辄上万条）。 */
const MAX_LIST_ENTRIES = 500;

const textResult = (value) => ({
  content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }],
  isError: false,
});

const errorResult = (error) => ({
  content: [{ type: 'text', text: String((error && error.message) || error) }],
  isError: true,
});

/** 宿主不在时没有可读写的库目录——给出可行动的说明，而不是一个空结果。 */
const noHost = () =>
  new Error(
    'The OTools host is not available, so this plugin has no library folder on disk. Open the plugin inside OTools.',
  );

/* ------------------------------------------------------------ 库目录 */

/**
 * 本插件的库目录。
 *
 * 六个 puter 插件都走 `local.js` 的 `libraryDir()`；video 没有这一层，它自己
 * 有一份工程目录（工程目录就是库目录），所以那份 mcp.js 只改这一个函数。
 */
async function libraryRoot({ create = false } = {}) {
  return libraryDir({ create });
}

/* ------------------------------------------------------------ 路径守卫 */

/**
 * 把调用方给的路径收敛成「相对库目录的 POSIX 片段」。
 *
 * 拒绝绝对路径（`/x`、`C:\x`）与任何 `..` 片段：MCP 桥的能力边界就是库目录，
 * 越界不做「尽力而为」，直接报错让 AI 换个路径。
 */
function safeRelative(input, { allowEmpty = false } = {}) {
  const raw = String(input == null ? '' : input).trim();
  if (!raw) {
    if (allowEmpty) return '';
    throw new Error('A file path inside the library folder is required');
  }
  if (/^([a-zA-Z]:|[\\/])/.test(raw)) {
    throw new Error('Only paths relative to the library folder are allowed');
  }
  const segments = raw.replace(/\\/g, '/').split('/').filter((part) => part && part !== '.');
  if (segments.includes('..')) {
    throw new Error('Only paths inside the library folder are allowed');
  }
  if (!segments.length) {
    if (allowEmpty) return '';
    throw new Error('A file path inside the library folder is required');
  }
  return segments.join('/');
}

async function absolutePath(root, relative) {
  return relative ? host.joinPath(root, ...relative.split('/')) : root;
}

/* ------------------------------------------------------------ 工具实现 */

async function runListLibrary(args) {
  const root = await libraryRoot({ create: false });
  if (!root) throw noHost();

  const relative = safeRelative(args.path, { allowEmpty: true });
  const entries = await host.listDir(await absolutePath(root, relative));
  const items = entries
    // 标记文件是移植层的内部约定，不是用户的文件。
    .filter((entry) => entry.name !== APP.marker)
    .map((entry) => ({
      path: relative ? `${relative}/${entry.name}` : entry.name,
      name: entry.name,
      kind: entry.isDir ? 'directory' : 'file',
      size: entry.size,
      modified: entry.modified,
    }));

  return textResult({
    root,
    path: relative,
    truncated: items.length > MAX_LIST_ENTRIES,
    entries: items.slice(0, MAX_LIST_ENTRIES),
  });
}

async function runReadFile(args) {
  const root = await libraryRoot({ create: false });
  if (!root) throw noHost();

  const relative = safeRelative(args.path);
  const file = await host.readFile(await absolutePath(root, relative));
  if (!file) throw new Error(`No such file in the library folder: ${relative}`);
  if (file.size > MAX_READ_BYTES) {
    throw new Error(
      `The file ${relative} is ${file.size} bytes, which is over the ${MAX_READ_BYTES}-byte limit of this tool. Open it in the app instead.`,
    );
  }

  return textResult({
    path: relative,
    size: file.size,
    mime: file.mime,
    base64: file.dataBase64,
  });
}

async function runWriteFile(args) {
  const root = await libraryRoot({ create: true });
  if (!root) throw noHost();

  const relative = safeRelative(args.path);
  const base64 = String(args.base64 || '');
  if (!base64) throw new Error('base64 content is required');

  const target = await absolutePath(root, relative);
  await host.createDir(host.dirName(target));
  await host.writeFile(target, base64);

  // 反推字节数只为回报一个可信的大小；不校验 base64 是否合法（宿主写入会拒）。
  const bytes = Math.floor((base64.replace(/=+$/, '').length * 3) / 4);
  return textResult({ path: relative, absolutePath: target, bytes });
}

async function runLibraryPath() {
  const root = await libraryRoot({ create: false });
  return textResult({ root: root || '', available: Boolean(root) });
}

const baseRunners = {
  list_library: runListLibrary,
  read_file: runReadFile,
  write_file: runWriteFile,
  library_path: runLibraryPath,
};

function baseToolDefs() {
  const product = APP.product;
  const folder = APP.folder;

  return [
    {
      name: 'list_library',
      title: `List ${product} library files`,
      description: `List the files in the ${product} plugin library folder ("${folder}") on this computer: name, kind (file or directory), size in bytes and last modified time. Pass a relative path to list a subfolder.`,
      inputSchema: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Relative subfolder inside the library folder. Omit for the top level.',
          },
        },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    {
      name: 'read_file',
      title: 'Read a library file',
      description:
        'Read one file from the library folder and return its raw bytes as base64, together with its MIME type and size. Binary formats are returned exactly as stored, not decoded.',
      inputSchema: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Path relative to the library folder, for example "reports/q3.docx".',
          },
        },
        required: ['path'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    {
      name: 'write_file',
      title: 'Write a library file',
      description:
        'Write base64-encoded bytes to a file in the library folder, creating parent folders and overwriting an existing file. The result is an ordinary file on this computer that the user can open in the app.',
      inputSchema: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Path relative to the library folder, for example "exports/deck.pptx".',
          },
          base64: { type: 'string', description: 'File content, base64-encoded.' },
        },
        required: ['path', 'base64'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    {
      name: 'library_path',
      title: `Show the ${product} library folder`,
      description:
        'Return the absolute path of the library folder on this computer, so the user can be told where the files live.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
  ];
}

/* ------------------------------------------------------------ 挂载 */

/**
 * 把桥挂到 `window.__otoolsMcp`。
 *
 * 幂等：重复调用只会覆盖成同形状的对象，不叠加监听或状态。
 *
 * @param {{extraTools?: Array<{name: string, title?: string, description?: string,
 *   inputSchema?: object, annotations?: object, run: (args: object) => Promise<object>}>}} [options]
 *   插件自己的领域工具。`run` 收参数对象、返回 MCP 形状结果；其余字段原样进
 *   `listTools`，`run` 不会外泄给宿主。
 */
export function installMcpBridge(options = {}) {
  if (typeof window === 'undefined') return;

  const extras = (Array.isArray(options.extraTools) ? options.extraTools : []).filter(
    (tool) => tool && typeof tool.name === 'string' && typeof tool.run === 'function',
  );

  const defs = [...baseToolDefs(), ...extras.map(({ run, ...def }) => def)];
  const runners = new Map([
    ...Object.entries(baseRunners),
    ...extras.map((tool) => [tool.name, tool.run]),
  ]);

  window.__otoolsMcp = {
    listTools: async () => {
      try {
        return defs;
      } catch {
        // 工具表拿不到时返回空表：宿主会把本插件视为「暂无工具」，
        // 而不是让整段脚本失败。
        return [];
      }
    },
    call: async (name, args) => {
      try {
        const run = runners.get(String(name || ''));
        if (!run) throw new Error(`Unknown tool: ${name}`);
        return (await run(args && typeof args === 'object' ? args : {})) || { content: [] };
      } catch (error) {
        // 异常转成 isError：Windows 上 Tauri 会忽略脚本异常，抛出去等于没传。
        return errorResult(error);
      }
    },
  };
}

/** 供测试与诊断：工具名清单（不含 extraTools）。 */
export function mcpToolNames() {
  return baseToolDefs().map((tool) => tool.name);
}

/** 供测试与诊断：完整工具表定义。 */
export function mcpToolDefs() {
  return baseToolDefs();
}
