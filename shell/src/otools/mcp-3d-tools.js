/**
 * 3d 插件的领域级 MCP 工具（"应用级"MCP 第一批）。
 * ------------------------------------------------------------------
 * 直接驱动当前场景（`app.doc`，Blender 式文档：`objects` 表 + `object_order`）：
 * 读场景/对象，改名、显隐、删除、选中。写操作走
 * `app.pushUndo(label)` → 改对象 → `app.changed('doc')`——与界面同一撤销栈。
 */
import { requireApp, text } from './mcp-context.js';
import { deleteObjects } from '../ops/object';

function objectsOf(app) {
  return app.doc.object_order.map((id) => app.doc.objects[id]).filter(Boolean);
}

const objSummary = (o) => ({
  id: o.id,
  name: o.name,
  type: o.type,
  selected: Boolean(o.select),
  hidden: Boolean(o.hide),
  parent: o.parent || null,
});

function needObject(app, id) {
  const ob = app.doc.objects[String(id || '').trim()];
  if (!ob) throw new Error(`Unknown object ${id}. Use list_objects to read ids.`);
  return ob;
}

async function runGetScene() {
  const app = requireApp();
  return text({
    filename: app.filename || null,
    mode: app.mode,
    objectCount: objectsOf(app).length,
    activeObject: app.activeObject ? { id: app.activeObject.id, name: app.activeObject.name } : null,
  });
}

async function runListObjects() {
  const app = requireApp();
  return text({ objects: objectsOf(app).map(objSummary) });
}

async function runReadObject(args) {
  const app = requireApp();
  const o = needObject(app, args.objectId);
  return text({
    ...objSummary(o),
    location: o.location,
    rotationEuler: o.rotation_euler,
    scale: o.scale,
  });
}

async function runRenameObject(args) {
  const app = requireApp();
  const o = needObject(app, args.objectId);
  const name = String(args.name || '').trim();
  if (!name) throw new Error('name is required.');
  app.pushUndo('MCP: rename object');
  o.name = name;
  app.changed('doc');
  return text({ objectId: o.id, name });
}

async function runSetObjectVisibility(args) {
  const app = requireApp();
  const o = needObject(app, args.objectId);
  if (typeof args.visible !== 'boolean') throw new Error('visible must be true or false.');
  app.pushUndo('MCP: object visibility');
  o.hide = !args.visible;
  app.changed('doc');
  return text({ objectId: o.id, visible: args.visible });
}

async function runDeleteObject(args) {
  const app = requireApp();
  const o = needObject(app, args.objectId);
  app.pushUndo('MCP: delete object');
  deleteObjects(app.doc, new Set([o.id]));
  app.changed('doc');
  return text({ deleted: o.id });
}

async function runSelectObject(args) {
  const app = requireApp();
  const o = needObject(app, args.objectId);
  for (const other of objectsOf(app)) other.select = other.id === o.id;
  app.activeObject = o;
  app.changed('select');
  return text({ selected: o.id });
}

export function d3McpTools() {
  return [
    {
      name: 'get_scene',
      title: 'Describe the open scene',
      description: 'Return the open 3D scene: file name, mode, object count and the active object. Call this first.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true, destructiveHint: false },
      run: runGetScene,
    },
    {
      name: 'list_objects',
      title: 'List scene objects',
      description: 'List every object with id, name, type, selection, visibility and parent.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true, destructiveHint: false },
      run: runListObjects,
    },
    {
      name: 'read_object',
      title: 'Read one object',
      description: 'Return one object: name, type, flags, location, rotation (Euler) and scale.',
      inputSchema: {
        type: 'object',
        properties: { objectId: { type: 'string', description: 'Object id from list_objects.' } },
        required: ['objectId'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, destructiveHint: false },
      run: runReadObject,
    },
    {
      name: 'rename_object',
      title: 'Rename an object',
      description: 'Rename an object. One undoable step.',
      inputSchema: {
        type: 'object',
        properties: {
          objectId: { type: 'string', description: 'Object id from list_objects.' },
          name: { type: 'string', description: 'New name.' },
        },
        required: ['objectId', 'name'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
      run: runRenameObject,
    },
    {
      name: 'set_object_visibility',
      title: 'Show or hide an object',
      description: 'Set an object’s viewport visibility (the eye icon).',
      inputSchema: {
        type: 'object',
        properties: {
          objectId: { type: 'string', description: 'Object id from list_objects.' },
          visible: { type: 'boolean', description: 'true to show, false to hide.' },
        },
        required: ['objectId', 'visible'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
      run: runSetObjectVisibility,
    },
    {
      name: 'delete_object',
      title: 'Delete an object',
      description: 'Delete an object and clean up references. Undoable.',
      inputSchema: {
        type: 'object',
        properties: { objectId: { type: 'string', description: 'Object id from list_objects.' } },
        required: ['objectId'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
      run: runDeleteObject,
    },
    {
      name: 'select_object',
      title: 'Select an object',
      description: 'Make an object the only selected and active object.',
      inputSchema: {
        type: 'object',
        properties: { objectId: { type: 'string', description: 'Object id from list_objects.' } },
        required: ['objectId'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
      run: runSelectObject,
    },
  ];
}
