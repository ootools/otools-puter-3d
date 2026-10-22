// @vitest-environment jsdom
/**
 * 插件侧 MCP 桥的边界。
 *
 * 只测「契约」——宿主读 `window.__otoolsMcp` 能得到什么形状、异常怎么变成
 * isError、路径守卫挡不挡越界、写工具落点对不对；不测文案翻译（这些描述是
 * 给 AI 读的，本来就不进 i18n 词表）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const LIB = '/Users/local/Documents';

vi.mock('../src/otools/local.js', () => ({
  libraryDir: vi.fn(),
}));

vi.mock('../src/otools/host.js', () => ({
  joinPath: vi.fn(async (...parts) => parts.filter(Boolean).join('/')),
  dirName: vi.fn((p) => {
    const at = String(p).lastIndexOf('/');
    return at > 0 ? String(p).slice(0, at) : '';
  }),
  listDir: vi.fn(),
  readFile: vi.fn(),
  writeFile: vi.fn(),
  createDir: vi.fn(),
}));

// 用轻量假 App 替换 app/app.ts（真模块会拉入整个 three.js 场景/求值器）。
vi.mock('../src/app/app', () => {
  const app = {
    doc: { object_order: [], objects: {}, scene: { active_object: null }, mode: 'OBJECT' },
    mode: 'OBJECT',
    filename: 'test.p3d',
    pushUndo: vi.fn(),
    changed: vi.fn(),
    get activeObject() {
      const id = app.doc.scene && app.doc.scene.active_object;
      return id ? app.doc.objects[id] || null : null;
    },
    set activeObject(o) {
      app.doc.scene = app.doc.scene || {};
      app.doc.scene.active_object = o ? o.id : null;
    },
  };
  return { app };
});

vi.mock('../src/ops/object', () => ({
  deleteObjects: vi.fn((doc, ids) => {
    for (const id of ids) {
      delete doc.objects[id];
      doc.object_order = doc.object_order.filter((x) => x !== id);
    }
  }),
}));

import { installMcpBridge, mcpToolDefs, mcpToolNames } from '../src/otools/mcp.js';
import { libraryDir } from '../src/otools/local.js';
import * as host from '../src/otools/host.js';
import { d3McpTools, d3ToolNames } from '../src/otools/mcp-tools.js';
import { app } from '../src/app/app';

const bridge = () => window.__otoolsMcp;

function seedScene() {
  app.doc = {
    object_order: ['o1', 'o2'],
    objects: {
      o1: { id: 'o1', name: 'Cube', type: 'MESH', select: true, hide: false, parent: null, location: [0, 0, 0], rotation_euler: [0, 0, 0], scale: [1, 1, 1] },
      o2: { id: 'o2', name: 'Camera', type: 'CAMERA', select: false, hide: false, parent: null, location: [1, 2, 3], rotation_euler: [0, 0, 0], scale: [1, 1, 1] },
    },
    scene: { active_object: 'o1' },
    mode: 'OBJECT',
  };
  app.mode = 'OBJECT';
  app.filename = 'test.p3d';
}

describe('MCP 桥', () => {
  beforeEach(() => {
    delete window.__otoolsMcp;
    vi.clearAllMocks();
    libraryDir.mockResolvedValue(LIB);
    host.listDir.mockResolvedValue([]);
    host.readFile.mockResolvedValue(null);
    installMcpBridge({ extraTools: d3McpTools() });
  });

  it('挂载 window.__otoolsMcp 且暴露 listTools/call', () => {
    expect(typeof bridge().listTools).toBe('function');
    expect(typeof bridge().call).toBe('function');
  });

  it('listTools 返回带 name/inputSchema/annotations 的工具表', async () => {
    const tools = await bridge().listTools();
    expect(tools.map((tool) => tool.name)).toEqual(d3ToolNames());
    for (const tool of tools) {
      expect(typeof tool.name).toBe('string');
      expect(tool.inputSchema).toBeTypeOf('object');
      expect(tool.annotations).toBeTypeOf('object');
    }
  });

  it('list_library 映射宿主条目并跳过库标记文件', async () => {
    host.listDir.mockResolvedValue([
      { name: '3d.json', isDir: false, size: 1, modified: 1 },
      { name: 'a.docx', isDir: false, size: 12, modified: 5 },
      { name: 'archive', isDir: true, size: 0, modified: 6 },
    ]);

    const result = await bridge().call('list_library', {});
    expect(result.isError).toBe(false);
    const payload = JSON.parse(result.content[0].text);
    expect(payload.entries).toEqual([
      { path: 'a.docx', name: 'a.docx', kind: 'file', size: 12, modified: 5 },
      { path: 'archive', name: 'archive', kind: 'directory', size: 0, modified: 6 },
    ]);
    expect(host.listDir).toHaveBeenCalledWith(LIB);
  });

  it('list_library 支持子目录并把相对路径拼进条目', async () => {
    host.listDir.mockResolvedValue([{ name: 'q3.docx', isDir: false, size: 3, modified: 9 }]);
    const result = await bridge().call('list_library', { path: 'reports' });
    const payload = JSON.parse(result.content[0].text);
    expect(host.listDir).toHaveBeenCalledWith(`${LIB}/reports`);
    expect(payload.entries[0].path).toBe('reports/q3.docx');
  });

  it('read_file 返回 base64 内容与元信息', async () => {
    host.readFile.mockResolvedValue({
      name: 'a.txt',
      size: 2,
      mime: 'text/plain',
      dataBase64: 'aGk=',
    });
    const result = await bridge().call('read_file', { path: 'a.txt' });
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.content[0].text)).toEqual({
      path: 'a.txt',
      size: 2,
      mime: 'text/plain',
      base64: 'aGk=',
    });
  });

  it('read_file 拒绝跳出库目录的路径', async () => {
    const result = await bridge().call('read_file', { path: '../secret.txt' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/inside the library folder/);
    expect(host.readFile).not.toHaveBeenCalled();
  });

  it('read_file 拒绝绝对路径', async () => {
    const result = await bridge().call('read_file', { path: '/etc/passwd' });
    expect(result.isError).toBe(true);
    expect(host.readFile).not.toHaveBeenCalled();
  });

  it('read_file 对不存在的文件返回 isError', async () => {
    const result = await bridge().call('read_file', { path: 'missing.txt' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/No such file/);
  });

  it('write_file 建父目录并写入 base64', async () => {
    const result = await bridge().call('write_file', {
      path: 'exports/deck.pptx',
      base64: 'aGk=',
    });
    expect(result.isError).toBe(false);
    expect(host.createDir).toHaveBeenCalledWith(`${LIB}/exports`);
    expect(host.writeFile).toHaveBeenCalledWith(`${LIB}/exports/deck.pptx`, 'aGk=');
    expect(JSON.parse(result.content[0].text)).toMatchObject({
      path: 'exports/deck.pptx',
      bytes: 2,
    });
  });

  it('write_file 缺 base64 时返回 isError 且不落盘', async () => {
    const result = await bridge().call('write_file', { path: 'a.txt' });
    expect(result.isError).toBe(true);
    expect(host.writeFile).not.toHaveBeenCalled();
  });

  it('业务能力抛错时由桥转成 isError', async () => {
    host.listDir.mockRejectedValue(new Error('disk gone'));
    const result = await bridge().call('list_library', {});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('disk gone');
  });

  it('未知工具返回 isError，而不是抛异常', async () => {
    const result = await bridge().call('nope', {});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/Unknown tool/);
  });

  it('宿主不在时给出可行动的说明', async () => {
    libraryDir.mockResolvedValue('');
    const result = await bridge().call('list_library', {});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/OTools host is not available/);
  });

  it('extraTools 可以追加领域工具，run 不会外泄给宿主', async () => {
    delete window.__otoolsMcp;
    const run = vi.fn(async () => ({ content: [{ type: 'text', text: 'ok' }], isError: false }));
    installMcpBridge({ extraTools: [{ name: 'domain_tool', description: 'x', run }] });

    const tools = await bridge().listTools();
    const added = tools.find((tool) => tool.name === 'domain_tool');
    expect(added).toBeTruthy();
    expect(added.run).toBeUndefined();

    const result = await bridge().call('domain_tool', { a: 1 });
    expect(run).toHaveBeenCalledWith({ a: 1 });
    expect(result.content[0].text).toBe('ok');
  });

  it('工具表与 plugin.json 的 mcp 声明一致', () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const manifest = JSON.parse(
      fs.readFileSync(path.resolve(here, '..', '..', 'plugin.json'), 'utf8'),
    );
    expect(manifest.mcp.enabled).toBe(true);
    expect(manifest.mcp.backend).toBe('webview');
    expect(manifest.mcp.namespace).toBe('puter-3d');
    expect(manifest.mcp.expose).toEqual(d3ToolNames());
    for (const tool of [...mcpToolDefs(), ...d3McpTools()]) {
      expect(manifest.mcp.annotations?.[tool.name]).toBeTypeOf('object');
    }
  });
});

describe('MCP 领域工具（3d）', () => {
  beforeEach(() => {
    delete window.__otoolsMcp;
    vi.clearAllMocks();
    installMcpBridge({ extraTools: d3McpTools() });
    seedScene();
  });

  it('get_scene 报出文件名/模式/对象数/活动对象', async () => {
    const result = await bridge().call('get_scene', {});
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.content[0].text)).toMatchObject({
      filename: 'test.p3d', mode: 'OBJECT', objectCount: 2, activeObject: { id: 'o1', name: 'Cube' },
    });
  });

  it('list_objects / read_object 读出对象', async () => {
    const list = JSON.parse((await bridge().call('list_objects', {})).content[0].text);
    expect(list.objects.map((o) => o.id)).toEqual(['o1', 'o2']);
    const one = JSON.parse((await bridge().call('read_object', { objectId: 'o2' })).content[0].text);
    expect(one).toMatchObject({ id: 'o2', name: 'Camera', type: 'CAMERA' });
    expect(one.location).toEqual([1, 2, 3]);
  });

  it('rename_object 改名并 pushUndo/changed', async () => {
    const result = await bridge().call('rename_object', { objectId: 'o1', name: 'Box' });
    expect(result.isError).toBe(false);
    expect(app.doc.objects.o1.name).toBe('Box');
    expect(app.pushUndo).toHaveBeenCalled();
    expect(app.changed).toHaveBeenCalled();
  });

  it('set_object_visibility 改 hide', async () => {
    const result = await bridge().call('set_object_visibility', { objectId: 'o1', visible: false });
    expect(result.isError).toBe(false);
    expect(app.doc.objects.o1.hide).toBe(true);
  });

  it('delete_object 删掉对象', async () => {
    const result = await bridge().call('delete_object', { objectId: 'o2' });
    expect(result.isError).toBe(false);
    expect(app.doc.object_order).toEqual(['o1']);
    expect(app.doc.objects.o2).toBeUndefined();
  });

  it('select_object 只选一个并设为活动', async () => {
    const result = await bridge().call('select_object', { objectId: 'o2' });
    expect(result.isError).toBe(false);
    expect(app.doc.objects.o2.select).toBe(true);
    expect(app.doc.objects.o1.select).toBe(false);
    expect(app.doc.scene.active_object).toBe('o2');
  });

  it('未知对象返回 isError', async () => {
    const result = await bridge().call('read_object', { objectId: 'nope' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/Unknown object/);
  });

  it('未就绪时领域工具给出可行动说明', async () => {
    app.doc = null;
    const result = await bridge().call('get_scene', {});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/not ready yet/);
  });
});
