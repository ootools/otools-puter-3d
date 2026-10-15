// File Browser editor: browse local folders (File System Access API) or picked files, preview
// images, and open/import files by double-clicking (projects open, models import, images load
// into the project and can be dragged onto Image Texture nodes / image fields).
import { h, patch, type Child } from '../ui/h';
import { icon } from '../ui/icons';
import { app, type ChangeKind } from '../app/app';
import { registerEditor, type Area, type Editor } from '../ui/screen';
import { openMenu, type MenuItem } from '../ui/menu';
import { textField, enumRow } from '../ui/widgets';
import { openFile, formats } from '../io/files';
import { imageFromFile } from '../ops/imageobjects';
import { newText } from '../data/defaults';
import { registerIcons } from '../ui/icons';
import './filebrowser.css';

registerIcons({
  back: '<path class="s" d="M10 3 5 8l5 5" fill="none" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>',
  forward: '<path class="s" d="M6 3l5 5-5 5" fill="none" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>',
  file_parent: '<path class="s" d="M8 13V4M4 7.5 8 3.5l4 4" fill="none" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>',
  file_refresh: '<path class="s" d="M12.5 6A5 5 0 1 0 13 9.5" fill="none" stroke-width="1.6" stroke-linecap="round"/><path class="f" d="M13.8 2.2v4.6H9.2z"/>',
  listview: '<path class="f" d="M2 3h2v2H2zM6 3h8v2H6zM2 7h2v2H2zM6 7h8v2H6zM2 11h2v2H2zM6 11h8v2H6z"/>',
  imgdisplay: '<path class="f" d="M2 2h5v5H2zM9 2h5v5H9zM2 9h5v5H2zM9 9h5v5H9z"/>',
  viewzoom: '<circle class="s" cx="7" cy="7" r="4" fill="none" stroke-width="1.6"/><path class="s" d="M10 10l4 4" stroke-width="1.8" stroke-linecap="round"/>',
  file: '<path class="s" d="M4 2h5l3 3v9H4z" fill="none" stroke-width="1.3" stroke-linejoin="round"/><path class="s" d="M9 2v3h3" fill="none" stroke-width="1.1"/>',
  file_blend: '<path class="s" d="M4 2h5l3 3v9H4z" fill="none" stroke-width="1.3" stroke-linejoin="round"/><circle class="f" cx="8" cy="10" r="2.2" fill="#e8973a"/>',
  filebrowser: '<path class="f" d="M2 4h4.5l1.5 1.5h6V13H2z" opacity=".85"/><path d="M2 7h12" stroke="#1d1d1d" stroke-width="1"/>',
});

interface DirHandle {
  kind: 'directory';
  name: string;
  values(): AsyncIterable<DirHandle | FileHandle>;
}
interface FileHandle {
  kind: 'file';
  name: string;
  getFile(): Promise<File>;
}

interface Item {
  name: string;
  kind: 'dir' | 'file';
  dir?: DirHandle;
  file?: File;
  handle?: FileHandle;
}

type Category = 'project' | 'image' | 'model' | 'text' | 'other';
const IMAGE_EXT = /\.(png|jpe?g|webp|gif|bmp|avif|svg)$/i;
const TEXT_EXT = /\.(py|js|txt|md|json|glsl|osl)$/i;

function category(name: string): Category {
  const n = name.toLowerCase();
  if (n.endsWith('.p3d') || n.endsWith('.3d.json') || n.endsWith('.blend')) return 'project';
  if (IMAGE_EXT.test(n)) return 'image';
  if (formats.some((f) => f.import && f.extensions.some((x) => n.endsWith(x)))) return 'model';
  if (TEXT_EXT.test(n)) return 'text';
  return 'other';
}

const CAT_ICON: Record<Category, string> = { project: 'file_blend', image: 'image', model: 'mesh_data', text: 'text', other: 'file' };

/** Shared across File Browsers in the session: opened folders and recently used files. */
const roots: DirHandle[] = [];
const recent: File[] = [];

const supportsFolders = typeof (window as unknown as { showDirectoryPicker?: unknown }).showDirectoryPicker === 'function';

export class FileBrowser implements Editor {
  el: HTMLElement;
  keymaps = ['File Browser', 'Window', 'Screen'];
  private side: HTMLElement;
  private main: HTMLElement;
  private path: DirHandle[] = [];
  private items: Item[] = [];
  private loose: File[] = [];
  private view: 'THUMBNAIL' | 'LIST' = 'THUMBNAIL';
  private filter = '';
  private onlySupported = true;
  private selected: string | null = null;
  private thumbs = new Map<string, string>();
  private history: DirHandle[][] = [];
  private future: DirHandle[][] = [];
  private status = '';

  constructor(public area: Area, state?: unknown) {
    const st = (state ?? {}) as { view?: 'THUMBNAIL' | 'LIST' };
    if (st.view) this.view = st.view;
    this.el = document.createElement('div');
    this.el.className = 'file-browser';
    this.side = document.createElement('div');
    this.side.className = 'fb-side';
    this.main = document.createElement('div');
    this.main.className = 'fb-main';
    this.main.tabIndex = -1;
    this.el.append(this.side, this.main);
    this.main.addEventListener('pointerdown', (e) => {
      if (e.target === this.main) {
        this.selected = null;
        this.draw();
      }
    });
    if (roots.length) void this.enter([roots[0]], false);
    else this.draw();
  }

  serialize() {
    return { view: this.view };
  }

  header(): Child {
    const nav = (ic: string, tip: string, on: boolean, fn: () => void) => h('button', { key: tip, class: 'hdr-icon', 'data-tip': tip, 'aria-label': tip, disabled: !on, onclick: fn }, icon(ic));
    const menu = (label: string, items: () => MenuItem[]) => h('button', { key: label, class: 'hdr-menu', onpointerdown: (e: PointerEvent) => (e.preventDefault(), openMenu(items(), e.currentTarget as HTMLElement)) }, label);
    return h(
      'div',
      { class: 'hdr-row' },
      menu('View', () => [
        { label: 'Thumbnails', checked: this.view === 'THUMBNAIL', action: () => this.setView('THUMBNAIL') },
        { label: 'List', checked: this.view === 'LIST', action: () => this.setView('LIST') },
        { separator: true },
        { label: 'Show Only Supported Files', checked: this.onlySupported, action: () => ((this.onlySupported = !this.onlySupported), this.draw()) },
      ]),
      nav('back', 'Back', this.history.length > 0, () => this.back()),
      nav('forward', 'Forward', this.future.length > 0, () => this.forward()),
      nav('file_parent', 'Parent Directory', this.path.length > 1, () => void this.enter(this.path.slice(0, -1))),
      nav('file_refresh', 'Refresh', this.path.length > 0, () => void this.enter(this.path, false)),
      h('div', { class: 'fb-path' }, this.path.length ? this.path.map((d) => d.name).join(' / ') : supportsFolders ? 'No folder opened' : 'Picked files'),
      h('div', { class: 'hdr-spacer' }),
      enumRow(
        'fb-view',
        [
          { value: 'LIST', label: '', icon: 'listview', description: 'List' },
          { value: 'THUMBNAIL', label: '', icon: 'imgdisplay', description: 'Thumbnails' },
        ],
        this.view,
        (v) => this.setView(v as 'LIST'),
        { iconOnly: true },
      ),
      textField('fb-filter', this.filter, (v) => ((this.filter = v), this.draw()), { placeholder: 'Filter', icon: 'viewzoom', live: true, className: 'fb-filter' }),
    );
  }

  private setView(v: 'THUMBNAIL' | 'LIST') {
    this.view = v;
    this.draw();
    this.area.drawHeader();
  }

  update(kinds: Set<ChangeKind>) {
    if (kinds.has('ui')) this.draw();
  }

  dispose() {
    for (const u of this.thumbs.values()) URL.revokeObjectURL(u);
  }

  // ---------------------------------------------------------------------
  // navigation

  private async openFolder() {
    try {
      const dir = (await (window as unknown as { showDirectoryPicker: (o?: unknown) => Promise<DirHandle> }).showDirectoryPicker({ mode: 'read' })) as DirHandle;
      if (!roots.some((r) => r.name === dir.name)) roots.push(dir);
      await this.enter([dir]);
    } catch (e) {
      if ((e as Error)?.name !== 'AbortError') app.report('ERROR', `Cannot open folder: ${e instanceof Error ? e.message : e}`);
    }
  }

  private pickFiles() {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.onchange = () => {
      this.loose.push(...Array.from(input.files ?? []));
      this.path = [];
      this.items = this.loose.map((f) => ({ name: f.name, kind: 'file' as const, file: f }));
      this.draw();
    };
    input.click();
  }

  private async enter(path: DirHandle[], record = true) {
    if (record && this.path.length) {
      this.history.push(this.path);
      this.future = [];
    }
    this.path = path;
    this.status = 'Reading folder…';
    this.draw();
    const dir = path[path.length - 1];
    const items: Item[] = [];
    try {
      for await (const entry of dir.values()) items.push(entry.kind === 'directory' ? { name: entry.name, kind: 'dir', dir: entry } : { name: entry.name, kind: 'file', handle: entry as FileHandle });
    } catch (e) {
      app.report('ERROR', `Cannot read folder: ${e instanceof Error ? e.message : e}`);
    }
    items.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name, undefined, { numeric: true }) : a.kind === 'dir' ? -1 : 1));
    this.items = items;
    this.status = '';
    this.selected = null;
    this.draw();
    this.area.drawHeader();
  }

  private back() {
    const prev = this.history.pop();
    if (!prev) return;
    this.future.push(this.path);
    void this.enter(prev, false);
  }

  private forward() {
    const next = this.future.pop();
    if (!next) return;
    this.history.push(this.path);
    void this.enter(next, false);
  }

  private async fileOf(it: Item): Promise<File | null> {
    if (it.file) return it.file;
    if (it.handle) {
      try {
        it.file = await it.handle.getFile();
        return it.file;
      } catch {
        return null;
      }
    }
    return null;
  }

  /** Double-click: open projects, import models, load images and texts. */
  private async activate(it: Item) {
    if (it.kind === 'dir' && it.dir) return this.enter([...this.path, it.dir]);
    const file = await this.fileOf(it);
    if (!file) return;
    if (!recent.includes(file)) recent.unshift(file);
    recent.splice(12);
    const cat = category(file.name);
    if (cat === 'project') await openFile(file, 'open');
    else if (cat === 'model') await openFile(file, 'import');
    else if (cat === 'image') {
      const img = await imageFromFile(file);
      app.doc.images[img.id] = img;
      app.pushUndo('Load Image');
      app.changed('doc');
      app.report('INFO', `Loaded image "${img.name}" (assign it in an Image Texture node or image field)`);
    } else if (cat === 'text') {
      const body = await file.text();

      const tx = newText(file.name, body, /\.py$/i.test(file.name) ? 'python' : 'javascript');
      app.doc.texts[tx.id] = tx;
      app.pushUndo('Open Text');
      app.changed('doc');
      app.report('INFO', `Opened "${file.name}" as a text data-block`);
    } else app.report('WARNING', `"${file.name}" is not a supported file type`);
    this.draw();
  }

  private thumb(it: Item) {
    const key = `${this.path.map((p) => p.name).join('/')}/${it.name}`;
    const url = this.thumbs.get(key);
    if (url) return url;
    if (this.view !== 'THUMBNAIL' || category(it.name) !== 'image') return null;
    this.thumbs.set(key, '');
    void this.fileOf(it).then((f) => {
      if (!f) return;
      this.thumbs.set(key, URL.createObjectURL(f));
      this.draw();
    });
    return null;
  }

  // ---------------------------------------------------------------------
  // drawing

  private draw() {
    const side = [
      h('div', { class: 'fb-side-title' }, 'Folders'),
      ...roots.map((r) =>
        h('button', { key: r.name, class: { 'fb-side-item': true, on: this.path[0] === r }, onclick: () => void this.enter([r]) }, icon('file_folder'), h('span', null, r.name)),
      ),
      supportsFolders ? h('button', { class: 'fb-side-item fb-add', onclick: () => void this.openFolder() }, icon('add'), h('span', null, 'Open Folder…')) : null,
      h('button', { class: 'fb-side-item fb-add', onclick: () => this.pickFiles() }, icon('add'), h('span', null, 'Add Files…')),
      h('div', { class: 'fb-side-title' }, 'Recent'),
      recent.length
        ? recent.map((f, i) => h('button', { key: `r${i}`, class: 'fb-side-item', 'data-tip': f.name, ondblclick: () => void this.activate({ name: f.name, kind: 'file', file: f }) }, icon(CAT_ICON[category(f.name)]), h('span', null, f.name)))
        : h('div', { class: 'fb-empty-small' }, 'Nothing yet'),
    ];
    patch(this.side, side);
    const q = this.filter.trim().toLowerCase();
    const shown = this.items.filter((it) => (!q || it.name.toLowerCase().includes(q)) && (it.kind === 'dir' || !this.onlySupported || category(it.name) !== 'other') && !it.name.startsWith('.'));
    let body: Child;
    if (!this.items.length && !this.status)
      body = h(
        'div',
        { class: 'fb-empty' },
        h('p', null, supportsFolders ? 'Open a folder to browse your files. Double-click a file to open a project, import a model, or load an image or text.' : 'Add files to browse them. Double-click a file to open a project, import a model, or load an image or text.'),
        h('div', { class: 'fb-empty-actions' }, supportsFolders ? h('button', { class: 'btn', onclick: () => void this.openFolder() }, 'Open Folder…') : null, h('button', { class: 'btn', onclick: () => this.pickFiles() }, 'Add Files…')),
      );
    else
      body = h(
        'div',
        { class: `fb-items ${this.view === 'LIST' ? 'list' : 'grid'}` },
        this.status ? h('div', { class: 'fb-empty-small' }, this.status) : null,
        shown.map((it) => {
          const cat = it.kind === 'dir' ? null : category(it.name);
          const url = it.kind === 'file' ? this.thumb(it) : null;
          return h(
            'div',
            {
              key: it.name,
              class: { 'fb-item': true, on: this.selected === it.name },
              role: 'option',
              'aria-selected': this.selected === it.name ? 'true' : 'false',
              draggable: cat === 'image' ? 'true' : 'false',
              onclick: () => ((this.selected = it.name), this.draw()),
              ondblclick: () => void this.activate(it),
              ondragstart: (e: DragEvent) => {
                // dragging an image file into other editors (drop targets read text/uri-list or files)
                void this.fileOf(it);
                if (it.file) e.dataTransfer?.items.add(it.file);
                e.dataTransfer?.setData('text/plain', it.name);
              },
            },
            url ? h('img', { class: 'fb-thumb', src: url, alt: '' }) : h('div', { class: 'fb-icon' }, icon(it.kind === 'dir' ? 'file_folder' : CAT_ICON[cat!])),
            h('span', { class: 'fb-name' }, it.name),
          );
        }),
      );
    patch(this.main, [body]);
  }
}

registerEditor({ id: 'FILE_BROWSER', label: 'File Browser', icon: 'filebrowser', group: 'Data', create: (a, s) => new FileBrowser(a, s) });
