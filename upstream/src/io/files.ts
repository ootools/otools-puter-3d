// File operators: new / open / save / save as / revert, autosave and import/export registry.
import { app, registerOperators } from '../app/app';
import { startupDocument } from '../data/defaults';
import { encodeDocument, decodeDocument, isNativeFile, saveRecovery, download, pickFile, clearRecovery } from './native';
import { importLegacyScene } from './legacy';
import type { MenuItem } from '../ui/menu';
import { openMenu } from '../ui/menu';

export interface FormatHandler {
  id: string;
  label: string;
  /** file extensions, e.g. ['.glb', '.gltf'] */
  extensions: string[];
  import?: (file: File) => Promise<void>;
  /** Optional: replace the whole document (File ▸ Open). Without it Open falls back to `import`. */
  open?: (file: File) => Promise<void>;
  export?: (opts: { selectedOnly: boolean }) => Promise<{ bytes: Uint8Array | string; mime: string; ext: string }>;
  /** shown in File > Import/Export */
  description?: string;
}

export const formats: FormatHandler[] = [];
export function registerFormat(f: FormatHandler) {
  formats.push(f);
}

/** UI layout hooks saved inside project files (workspaces etc). */
export const projectUiState = {
  save: (): Record<string, unknown> => ({}),
  load: (_s: Record<string, unknown>) => {},
};

let autosaveTimer = 0;
let lastSavedRevision = -1;

export function scheduleAutosave() {
  clearTimeout(autosaveTimer);
  autosaveTimer = window.setTimeout(() => void autosave(), 1500);
}

export async function autosave() {
  if (app.revision === lastSavedRevision) return;
  try {
    const bytes = encodeDocument(app.doc, { ui: projectUiState.save() });
    await saveRecovery(bytes, app.filename);
    lastSavedRevision = app.revision;
    status('Autosaved');
  } catch (e) {
    status(`Autosave failed: ${e instanceof Error ? e.message : e}`);
  }
}

let statusFn: (s: string) => void = () => {};
export function onFileStatus(fn: (s: string) => void) {
  statusFn = fn;
}
function status(s: string) {
  statusFn(s);
}

export async function openFile(file: File, mode: 'open' | 'import' = 'open') {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const name = file.name.toLowerCase();
  try {
    if (isNativeFile(bytes)) {
      const { doc, extra } = decodeDocument(bytes);
      app.setDocument(doc);
      app.filename = file.name;
      if (extra.ui) projectUiState.load(extra.ui as Record<string, unknown>);
      app.report('INFO', `Opened "${file.name}"`);
    } else if (name.endsWith('.json') || name.endsWith('.3d.json')) {
      const doc = importLegacyScene(new TextDecoder().decode(bytes));
      app.setDocument(doc);
      app.filename = file.name.replace(/\.3d\.json$|\.json$/i, '.p3d');
      app.report('INFO', `Imported legacy scene "${file.name}"`);
    } else {
      const handler = formats.find((f) => f.import && f.extensions.some((x) => name.endsWith(x)));
      if (!handler) throw new Error(`Unsupported file type: ${file.name}`);
      if (mode === 'open' && handler.open) {
        await handler.open(file);
        app.dirty = false;
        return;
      }
      await handler.import!(file);
      app.pushUndo(`Import ${handler.label}`);
      app.changed('doc');
      app.report('INFO', `Imported "${file.name}"`);
    }
    app.dirty = false;
  } catch (e) {
    if (e instanceof Error && e.name === 'AbortError') return; // options dialog cancelled
    app.report('ERROR', `Cannot open "${file.name}": ${e instanceof Error ? e.message : String(e)}`);
  }
}

export function saveFile(name = app.filename) {
  const bytes = encodeDocument(app.doc, { ui: projectUiState.save() });
  if (!name.toLowerCase().endsWith('.p3d')) name = `${name.replace(/\.[^.]+$/, '')}.p3d`;
  download(bytes, name);
  app.filename = name;
  app.dirty = false;
  app.report('INFO', `Saved "${name}"`);
}

registerOperators([
  {
    idname: 'wm.read_homefile',
    label: 'New File',
    description: 'Open the default startup file',
    undo: false,
    exec: () => {
      app.setDocument(startupDocument());
      app.filename = 'untitled.p3d';
      app.dirty = false;
      void clearRecovery();
    },
  },
  {
    idname: 'wm.open_mainfile',
    label: 'Open…',
    description: 'Open a project file (.p3d), a legacy scene (.3d.json) or a supported 3D model',
    undo: false,
    invoke: () => {
      void pickFile(['.p3d', '.json', ...formats.flatMap((f) => (f.import ? f.extensions : []))].join(',')).then((f) => f && openFile(f));
      return 'CANCELLED';
    },
  },
  {
    idname: 'wm.save_mainfile',
    label: 'Save',
    description: 'Save the current project (downloads a .p3d file)',
    props: [{ id: 'incremental', label: 'Incremental', type: 'bool', default: false }],
    undo: false,
    exec: (_ctx, p) => {
      if (!p.incremental) return void saveFile();
      // name.p3d → name.001.p3d → name.002.p3d …
      const base = app.filename.replace(/\.p3d$/i, '');
      const m = /^(.*)\.(\d{3})$/.exec(base);
      const next = m ? `${m[1]}.${String(Number(m[2]) + 1).padStart(3, '0')}` : `${base}.001`;
      saveFile(`${next}.p3d`);
    },
  },
  {
    idname: 'wm.save_as_mainfile',
    label: 'Save As…',
    undo: false,
    invoke: () => {
      import('../ui/menu').then(({ promptText }) => promptText('Save As', app.filename, (n) => n && saveFile(n)));
      return 'CANCELLED';
    },
  },
  {
    idname: 'wm.import',
    label: 'Import',
    props: [{ id: 'format', label: 'Format', type: 'string', default: '' }],
    undo: false,
    invoke: (_ctx, p) => {
      const f = formats.find((x) => x.id === p.format);
      const accept = f ? f.extensions.join(',') : formats.flatMap((x) => (x.import ? x.extensions : [])).join(',');
      void pickFile(accept).then((file) => file && openFile(file, 'import'));
      return 'CANCELLED';
    },
  },
  {
    idname: 'wm.export',
    label: 'Export',
    props: [{ id: 'format', label: 'Format', type: 'string', default: '' }, { id: 'use_selection', label: 'Selected Only', type: 'bool', default: false }],
    undo: false,
    exec: (_ctx, p) => {
      const f = formats.find((x) => x.id === p.format && x.export);
      if (!f) return 'CANCELLED';
      f.export!({ selectedOnly: !!p.use_selection })
        .then((r) => {
          download(r.bytes, `${app.filename.replace(/\.[^.]+$/, '')}${r.ext}`, r.mime);
          app.report('INFO', `Exported ${f.label}`);
        })
        .catch((e) => e?.name !== 'AbortError' && app.report('ERROR', `Export failed: ${e instanceof Error ? e.message : e}`));
    },
  },
]);

export function importMenu(): MenuItem[] {
  return formats.filter((f) => f.import).map((f) => ({ label: f.label, description: f.description, op: 'wm.import', props: { format: f.id } }));
}

export function exportMenu(): MenuItem[] {
  return formats.filter((f) => f.export).map((f) => ({ label: f.label, description: f.description, submenu: () => [{ label: 'All', op: 'wm.export', props: { format: f.id } }, { label: 'Selected Only', op: 'wm.export', props: { format: f.id, use_selection: true } }] }));
}

export { openMenu };
