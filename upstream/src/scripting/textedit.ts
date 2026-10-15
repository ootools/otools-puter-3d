// Text Editor: text data-block selector, line-numbered editing with syntax highlighting,
// find & replace sidebar, indentation / comment tools, templates, Run Script (Alt+P).
import { h, patch, type Child } from '../ui/h';
import { icon } from '../ui/icons';
import { app, registerOperators, type ChangeKind, type OpContext } from '../app/app';
import { registerEditor, type Area, type Editor } from '../ui/screen';
import { openMenu, promptText, type MenuItem } from '../ui/menu';
import { textField, checkbox, panel, numberField } from '../ui/widgets';
import { addKeys } from '../app/keymap';
import { dispatchEditorKeys, redirectIfElsewhere } from './editkeys';
import { newText } from '../data/defaults';
import type { TextData } from '../data/types';
import { download, pickFile } from '../io/native';
import { highlightLines } from './highlight';
import { templates } from './templates';
import { runJavaScript, output, type RunResult } from './runner';
import { loadPython, runPythonText } from './python';
import { uniqueName } from './api';

type Lang = TextData['language'];

const settings = {
  tabWidth: 4,
  useSpaces: true,
  fontSize: 12,
  matchCase: false,
  wrapAround: true,
};

function langOf(t: TextData | null): Lang {
  return t?.language ?? 'python';
}
const JS_EXT = /\.(mjs|js|ts)$/i;
const PY_EXT = /\.py$/i;
const TXT_EXT = /\.(txt|md|json|csv|glsl)$/i;
function langFromName(name: string): Lang {
  if (JS_EXT.test(name)) return 'javascript';
  if (PY_EXT.test(name)) return 'python';
  if (TXT_EXT.test(name)) return 'text';
  return 'python';
}

/** File handles from the File System Access API (when available) for Save. */
const fileHandles = new Map<string, FileSystemFileHandle>();

export class TextEditor implements Editor {
  el: HTMLElement;
  keymaps = ['Text', 'Window', 'Screen'];
  textId: string | null = null;
  showLineNumbers = true;
  wordWrap = false;
  syntax = true;
  highlightLine = true;
  showSidebar = false;
  findText = '';
  replaceText = '';
  errorLine: number | null = null;
  private main: HTMLElement;
  private scroll: HTMLElement;
  private gutter: HTMLElement;
  private content: HTMLElement;
  private pre: HTMLElement;
  private curLine: HTMLElement;
  private ta: HTMLTextAreaElement;
  private empty: HTMLElement;
  private sidebarEl: HTMLElement;
  private footer: HTMLElement;
  private lineHeight = 17;
  private charWidth = 7.2;
  private lastBody = '';
  private dirtySincePush = false;
  private renderQueued = false;
  private findFocus = false;
  private resizeObs: ResizeObserver;

  constructor(
    public area: Area,
    state?: unknown,
  ) {
    const st = (state ?? {}) as Partial<{ text: string; lineNumbers: boolean; wrap: boolean; syntax: boolean; sidebar: boolean }>;
    this.textId = st.text ?? null;
    if (st.lineNumbers !== undefined) this.showLineNumbers = st.lineNumbers;
    if (st.wrap !== undefined) this.wordWrap = st.wrap;
    if (st.syntax !== undefined) this.syntax = st.syntax;
    if (st.sidebar !== undefined) this.showSidebar = st.sidebar;
    this.el = document.createElement('div');
    this.el.className = 'text-editor';
    this.main = div('te-main');
    this.scroll = div('te-scroll');
    this.gutter = div('te-gutter');
    this.content = div('te-content');
    this.pre = document.createElement('div');
    this.pre.className = 'te-highlight';
    this.pre.setAttribute('aria-hidden', 'true');
    this.curLine = div('te-curline');
    this.ta = document.createElement('textarea');
    this.ta.className = 'te-input text-editor-input';
    this.ta.spellcheck = false;
    this.ta.setAttribute('autocapitalize', 'off');
    this.ta.setAttribute('autocomplete', 'off');
    this.ta.setAttribute('wrap', 'off');
    this.ta.setAttribute('aria-label', 'Text editor');
    this.content.append(this.curLine, this.pre, this.ta);
    this.scroll.append(this.gutter, this.content);
    this.empty = div('te-empty');
    this.main.append(this.scroll, this.empty);
    this.sidebarEl = div('te-sidebar');
    this.footer = div('te-footer');
    const body = div('te-body');
    body.append(this.main, this.sidebarEl);
    this.el.append(body, this.footer);

    this.ta.addEventListener('input', () => this.onInput());
    this.ta.addEventListener('keydown', (e) => this.onKeyDown(e));
    this.ta.addEventListener('select', () => this.updateCaret());
    this.ta.addEventListener('click', () => this.updateCaret());
    this.ta.addEventListener('keyup', () => this.updateCaret());
    this.ta.addEventListener('focus', () => this.updateCaret());
    this.ta.addEventListener('blur', () => this.commitUndo());
    document.addEventListener('selectionchange', this.onSelectionChange);
    this.scroll.addEventListener('pointerdown', (e) => {
      if (e.target === this.scroll || e.target === this.gutter || this.gutter.contains(e.target as Node)) {
        e.preventDefault();
        this.ta.focus();
      }
    });
    this.resizeObs = new ResizeObserver(() => this.layout());
    this.resizeObs.observe(this.scroll);
    this.measure();
    this.load();
  }

  private onSelectionChange = () => {
    if (document.activeElement === this.ta) this.updateCaret();
  };

  get text(): TextData | null {
    return this.textId ? app.doc.texts[this.textId] ?? null : null;
  }

  // ---------------------------------------------------------------- header

  header(): Child {
    const t = this.text;
    const menu = (label: string, items: () => MenuItem[]) =>
      h('button', { key: label, class: 'hdr-menu', onpointerdown: (e: PointerEvent) => (e.preventDefault(), openMenu(items(), e.currentTarget as HTMLElement)) }, label);
    return h(
      'div',
      { class: 'hdr-row te-header' },
      menu('View', () => this.viewMenu()),
      menu('Text', () => this.textMenu()),
      menu('Edit', () => this.editMenu()),
      menu('Select', () => [
        { label: 'Select All', shortcut: 'Ctrl A', action: () => this.selectAll() },
        { label: 'Select Line', shortcut: 'Shift Ctrl A', action: () => this.selectLine() },
        { label: 'Select Word', action: () => this.selectWord() },
      ]),
      menu('Format', () => this.formatMenu()),
      menu('Templates', () => templateMenu((tpl) => this.openTemplate(tpl))),
      h('div', { class: 'te-sep' }),
      this.idSelector(t),
      h('div', { class: 'hdr-spacer' }),
      t
        ? h(
            'button',
            { class: 'hdr-toggle te-run', 'data-tip': 'Run Script (Alt P)\nExecute this script in the application', onclick: () => app.run('text.run_script', {}, { area: this.area }), 'aria-label': 'Run Script' },
            icon('play'),
          )
        : null,
      h(
        'div',
        { class: 'hdr-group' },
        h('button', { class: { 'hdr-toggle': true, on: this.showLineNumbers }, 'data-tip': 'Line Numbers\nShow line numbers next to the text', 'aria-label': 'Line Numbers', onclick: () => ((this.showLineNumbers = !this.showLineNumbers), this.render(), this.area.drawHeader()) }, icon('te_linenumbers')),
        h('button', { class: { 'hdr-toggle': true, on: this.wordWrap }, 'data-tip': 'Word Wrap\nWrap words if there is not enough horizontal space', 'aria-label': 'Word Wrap', onclick: () => ((this.wordWrap = !this.wordWrap), this.render(), this.area.drawHeader()) }, icon('te_wordwrap')),
        h('button', { class: { 'hdr-toggle': true, on: this.syntax }, 'data-tip': 'Syntax Highlight\nSyntax highlight for scripting', 'aria-label': 'Syntax Highlight', onclick: () => ((this.syntax = !this.syntax), this.render(), this.area.drawHeader()) }, icon('te_syntax')),
      ),
    );
  }

  private idSelector(t: TextData | null): Child {
    const browse = h(
      'button',
      {
        class: 'hdr-toggle te-browse',
        'data-tip': 'Browse Text to be linked',
        'aria-label': 'Browse Text',
        onpointerdown: (e: PointerEvent) => {
          e.preventDefault();
          const texts = Object.values(app.doc.texts).sort((a, b) => a.name.localeCompare(b.name));
          openMenu(texts.length ? texts.map((x) => ({ label: x.name, icon: 'text', active: x.id === this.textId, action: () => this.setText(x.id) })) : [{ label: 'No texts', disabled: true }], e.currentTarget as HTMLElement);
        },
      },
      icon('text'),
      icon('down_arrow_hlt', 'tiny'),
    );
    if (!t)
      return h(
        'div',
        { class: 'te-id' },
        browse,
        h('button', { class: 'btn te-new', onclick: () => app.run('text.new', {}, { area: this.area }) }, icon('add'), 'New'),
        h('button', { class: 'btn te-open', onclick: () => app.run('text.open', {}, { area: this.area }) }, icon('file_folder'), 'Open'),
      );
    return h(
      'div',
      { class: 'te-id' },
      browse,
      textField('te-name', t.name, (v) => {
        const cur = this.text;
        if (!cur || !v.trim()) return;
        cur.name = uniqueName(app.doc.texts, v.trim(), cur.id);
        app.pushUndo('Rename Text');
        app.changed('doc');
      }),
      h('button', { class: 'hdr-toggle', 'data-tip': 'New Text\nCreate a new text data-block', 'aria-label': 'New Text', onclick: () => app.run('text.new', {}, { area: this.area }) }, icon('duplicate')),
      h('button', { class: 'hdr-toggle', 'data-tip': 'Unlink Text\nRemove this text data-block', 'aria-label': 'Unlink Text', onclick: () => app.run('text.unlink', {}, { area: this.area }) }, icon('x')),
    );
  }

  private viewMenu(): MenuItem[] {
    return [
      { label: 'Sidebar', shortcut: 'Ctrl T', checked: this.showSidebar, action: () => this.toggleSidebar() },
      { separator: true },
      { label: 'Line Numbers', checked: this.showLineNumbers, action: () => ((this.showLineNumbers = !this.showLineNumbers), this.render()) },
      { label: 'Word Wrap', checked: this.wordWrap, action: () => ((this.wordWrap = !this.wordWrap), this.render()) },
      { label: 'Syntax Highlight', checked: this.syntax, action: () => ((this.syntax = !this.syntax), this.render()) },
      { label: 'Highlight Line', checked: this.highlightLine, action: () => ((this.highlightLine = !this.highlightLine), this.updateCaret()) },
      { separator: true },
      { label: 'Zoom In', shortcut: 'Ctrl Wheel', action: () => this.zoom(1) },
      { label: 'Zoom Out', action: () => this.zoom(-1) },
      { separator: true },
      { label: 'Top of File', shortcut: 'Ctrl Home', action: () => this.setCaret(0) },
      { label: 'Bottom of File', shortcut: 'Ctrl End', action: () => this.setCaret(this.ta.value.length) },
    ];
  }

  private textMenu(): MenuItem[] {
    const t = this.text;
    return [
      { label: 'New', icon: 'file_blank', shortcut: 'Alt N', op: 'text.new' },
      { label: 'Open…', icon: 'file_folder', shortcut: 'Alt O', op: 'text.open' },
      { separator: true },
      { label: 'Save', shortcut: 'Alt S', op: 'text.save', disabled: !t },
      { label: 'Save As…', shortcut: 'Shift Ctrl Alt S', op: 'text.save_as', disabled: !t },
      { separator: true },
      {
        label: 'Language',
        disabled: !t,
        submenu: () =>
          (['python', 'javascript', 'text'] as Lang[]).map((l) => ({
            label: l === 'python' ? 'Python' : l === 'javascript' ? 'JavaScript' : 'Plain Text',
            active: langOf(this.text) === l,
            action: () => this.setLanguage(l),
          })),
      },
      { separator: true },
      { label: 'Run Script', icon: 'play', shortcut: 'Alt P', op: 'text.run_script', disabled: !t },
      { separator: true },
      { label: 'Unlink', icon: 'x', op: 'text.unlink', disabled: !t },
    ];
  }

  private editMenu(): MenuItem[] {
    const t = !!this.text;
    return [
      { label: 'Undo', shortcut: 'Ctrl Z', disabled: !t, action: () => this.exec('undo') },
      { label: 'Redo', shortcut: 'Shift Ctrl Z', disabled: !t, action: () => this.exec('redo') },
      { separator: true },
      { label: 'Cut', shortcut: 'Ctrl X', disabled: !t, action: () => void this.cut() },
      { label: 'Copy', shortcut: 'Ctrl C', disabled: !t, action: () => void this.copy() },
      { label: 'Paste', shortcut: 'Ctrl V', disabled: !t, action: () => void this.paste() },
      { label: 'Duplicate Line', shortcut: 'Shift Ctrl D', disabled: !t, op: 'text.duplicate_line' },
      { separator: true },
      { label: 'Move Line(s) Up', shortcut: 'Shift Ctrl ↑', disabled: !t, op: 'text.move_lines', props: { direction: 'UP' } },
      { label: 'Move Line(s) Down', shortcut: 'Shift Ctrl ↓', disabled: !t, op: 'text.move_lines', props: { direction: 'DOWN' } },
      { separator: true },
      { label: 'Find & Replace…', shortcut: 'Ctrl F', disabled: !t, op: 'text.start_find' },
      { label: 'Find Next', shortcut: 'Ctrl G', disabled: !t, op: 'text.find' },
      { label: 'Jump To…', shortcut: 'Ctrl J', disabled: !t, op: 'text.jump' },
    ];
  }

  private formatMenu(): MenuItem[] {
    const t = !!this.text;
    return [
      { label: 'Indent', shortcut: 'Tab', disabled: !t, op: 'text.indent' },
      { label: 'Unindent', shortcut: 'Shift Tab', disabled: !t, op: 'text.unindent' },
      { separator: true },
      { label: 'Toggle Comments', shortcut: 'Ctrl /', disabled: !t, op: 'text.comment_toggle' },
      { separator: true },
      {
        label: 'Convert Whitespace',
        disabled: !t,
        submenu: () => [
          { label: 'To Spaces', op: 'text.convert_whitespace', props: { type: 'SPACES' } },
          { label: 'To Tabs', op: 'text.convert_whitespace', props: { type: 'TABS' } },
        ],
      },
    ];
  }

  // ---------------------------------------------------------------- state

  private load() {
    if (this.textId && !app.doc.texts[this.textId]) this.textId = null;
    if (!this.textId) {
      const first = Object.values(app.doc.texts).sort((a, b) => a.name.localeCompare(b.name))[0];
      this.textId = first?.id ?? null;
    }
    const t = this.text;
    this.ta.value = t?.body ?? '';
    this.lastBody = this.ta.value;
    this.errorLine = null;
    this.render();
  }

  setText(id: string | null) {
    this.commitUndo();
    this.textId = id;
    this.load();
    this.area.drawHeader();
    if (id) requestAnimationFrame(() => this.ta.focus());
  }

  private setLanguage(l: Lang) {
    const t = this.text;
    if (!t) return;
    t.language = l;
    app.pushUndo('Text Language');
    this.render();
    app.changed('ui');
  }

  update(kinds: Set<ChangeKind>) {
    if (!kinds.has('doc') && !kinds.has('ui')) return;
    if (this.textId && !app.doc.texts[this.textId]) {
      this.textId = null;
      this.load();
      return;
    }
    if (!this.textId && Object.keys(app.doc.texts).length) {
      this.load();
      return;
    }
    const t = this.text;
    const body = t?.body ?? '';
    if (body !== this.ta.value && body !== this.lastBody) {
      // changed outside the editor (undo, scripts, file load)
      const pos = this.ta.selectionStart;
      this.ta.value = body;
      this.lastBody = body;
      this.ta.selectionStart = this.ta.selectionEnd = Math.min(pos, body.length);
      this.render();
    } else if (kinds.has('ui')) this.renderSidebar();
  }

  private onInput() {
    const t = this.text;
    if (!t) return;
    t.body = this.ta.value;
    this.lastBody = t.body;
    this.dirtySincePush = true;
    this.errorLine = null;
    app.dirty = true;
    this.queueRender();
  }

  /** Push one global undo step for typing done since the last push (on blur / before runs). */
  commitUndo() {
    if (!this.dirtySincePush) return;
    this.dirtySincePush = false;
    app.pushUndo('Edit Text');
    app.changed('doc');
  }

  private queueRender() {
    if (this.renderQueued) return;
    this.renderQueued = true;
    requestAnimationFrame(() => {
      this.renderQueued = false;
      this.render();
    });
  }

  // ---------------------------------------------------------------- rendering

  private measure() {
    const c = document.createElement('canvas').getContext('2d');
    if (c) {
      c.font = `${settings.fontSize}px 'JetBrains Mono', ui-monospace, Menlo, monospace`;
      this.charWidth = c.measureText('0000000000').width / 10 || 7.2;
    }
    this.lineHeight = Math.round(settings.fontSize * 1.42);
    this.el.style.setProperty('--te-fs', `${settings.fontSize}px`);
    this.el.style.setProperty('--te-lh', `${this.lineHeight}px`);
    this.el.style.setProperty('--te-tab', String(settings.tabWidth));
  }

  private zoom(d: number) {
    settings.fontSize = Math.max(8, Math.min(32, settings.fontSize + d));
    this.measure();
    this.render();
  }

  render() {
    const t = this.text;
    this.el.classList.toggle('no-text', !t);
    this.el.classList.toggle('wrap', this.wordWrap);
    this.el.classList.toggle('no-gutter', !this.showLineNumbers);
    this.ta.setAttribute('wrap', this.wordWrap ? 'soft' : 'off');
    if (!t) {
      patch(this.empty, h('div', { class: 'te-empty-msg' }, h('div', null, 'No text data-block'), h('div', { class: 'te-empty-btns' }, h('button', { class: 'btn', onclick: () => app.run('text.new', {}, { area: this.area }) }, icon('add'), 'New'), h('button', { class: 'btn', onclick: () => app.run('text.open', {}, { area: this.area }) }, icon('file_folder'), 'Open'))));
      this.renderFooter();
      this.renderSidebar();
      return;
    }
    const lines = highlightLines(this.ta.value, langOf(t), this.syntax);
    this.pre.innerHTML = lines.map((l, i) => `<div class="te-line${i + 1 === this.errorLine ? ' err' : ''}">${l || ' '}</div>`).join('');
    this.layout();
    this.renderSidebar();
  }

  private layout() {
    const t = this.text;
    if (!t) return;
    const lines = this.ta.value.split('\n');
    const lh = this.lineHeight;
    // size the textarea to its content so the outer container does the scrolling
    if (this.wordWrap) {
      this.content.style.width = '';
      this.ta.style.height = '0px';
      this.ta.style.height = `${Math.max(this.pre.scrollHeight, this.ta.scrollHeight)}px`;
    } else {
      const longest = lines.reduce((m, l) => Math.max(m, l.replace(/\t/g, ' '.repeat(settings.tabWidth)).length), 0);
      this.content.style.width = `max(100%, ${Math.ceil(longest * this.charWidth) + 40}px)`;
      this.ta.style.height = `${lines.length * lh + 8}px`;
    }
    // gutter numbers (match wrapped line heights)
    if (this.showLineNumbers) {
      const rows = this.pre.children;
      const digits = Math.max(2, String(lines.length).length);
      this.gutter.style.width = `${digits * this.charWidth + 16}px`;
      let html = '';
      for (let i = 0; i < lines.length; i++) {
        const hgt = this.wordWrap ? (rows[i] as HTMLElement | undefined)?.offsetHeight ?? lh : lh;
        html += `<div class="te-ln${i + 1 === this.errorLine ? ' err' : ''}" style="height:${hgt}px">${i + 1}</div>`;
      }
      this.gutter.innerHTML = html;
    } else this.gutter.innerHTML = '';
    this.updateCaret();
  }

  private caretLine() {
    const v = this.ta.value;
    const pos = this.ta.selectionStart;
    let line = 0;
    for (let i = 0; i < pos; i++) if (v.charCodeAt(i) === 10) line++;
    const col = pos - (v.lastIndexOf('\n', pos - 1) + 1);
    return { line, col };
  }

  updateCaret() {
    const { line, col } = this.caretLine();
    const row = this.pre.children[line] as HTMLElement | undefined;
    const show = this.highlightLine && !!row && this.ta.selectionStart === this.ta.selectionEnd;
    this.curLine.style.display = show ? '' : 'none';
    if (row) {
      this.curLine.style.top = `${row.offsetTop}px`;
      this.curLine.style.height = `${row.offsetHeight}px`;
    }
    this.gutter.querySelectorAll('.te-ln.cur').forEach((e) => e.classList.remove('cur'));
    (this.gutter.children[line] as HTMLElement | undefined)?.classList.add('cur');
    this.renderFooter(line, col);
  }

  private renderFooter(line?: number, col?: number) {
    const t = this.text;
    const fh = t ? fileHandles.get(t.id) : undefined;
    patch(this.footer, [
      h('span', { class: 'te-foot-file' }, t ? (fh ? `File: ${fh.name}` : 'Text: Internal') : ''),
      h('span', { class: 'hdr-spacer' }),
      t ? h('span', { class: 'te-foot-pos' }, `Ln ${(line ?? 0) + 1}, Col ${(col ?? 0) + 1}`) : null,
      t ? h('span', { class: 'te-foot-lang' }, langOf(t) === 'python' ? 'Python' : langOf(t) === 'javascript' ? 'JavaScript' : 'Plain Text') : null,
    ]);
  }

  // ---------------------------------------------------------------- sidebar (find & replace)

  toggleSidebar(force?: boolean) {
    this.showSidebar = force ?? !this.showSidebar;
    this.renderSidebar();
  }

  private renderSidebar() {
    this.el.classList.toggle('sidebar', this.showSidebar);
    if (!this.showSidebar) {
      patch(this.sidebarEl, []);
      return;
    }
    patch(this.sidebarEl, [
      h('div', { class: 'te-sb-tabs' }, h('button', { class: 'sb-tab on' }, 'Text')),
      h(
        'div',
        { class: 'te-sb-body' },
        panel('te-find', 'Find & Replace', () => [
          h(
            'div',
            { class: 'te-find-row' },
            h('label', { class: 'text-field te-find-field' }, icon('search'), h('input', { value: this.findText, placeholder: 'Find', spellcheck: 'false', 'aria-label': 'Find', ref: (el: HTMLInputElement) => this.findFocus && (requestAnimationFrame(() => (el.focus(), el.select())), (this.findFocus = false)), oninput: (e: Event) => (this.findText = (e.target as HTMLInputElement).value), onkeydown: (e: KeyboardEvent) => this.fieldKey(e, () => this.findNext()) })),
            h('button', { class: 'btn', onclick: () => this.findNext() }, 'Find Next'),
          ),
          h(
            'div',
            { class: 'te-find-row' },
            h('label', { class: 'text-field te-find-field' }, h('input', { value: this.replaceText, placeholder: 'Replace', spellcheck: 'false', 'aria-label': 'Replace', oninput: (e: Event) => (this.replaceText = (e.target as HTMLInputElement).value), onkeydown: (e: KeyboardEvent) => this.fieldKey(e, () => this.replaceOne()) })),
            h('button', { class: 'btn', onclick: () => this.replaceOne() }, 'Replace'),
          ),
          h('div', { class: 'te-find-row' }, h('button', { class: 'btn grow', onclick: () => this.replaceAll() }, 'Replace All')),
          h('div', { class: 'te-find-opts' }, checkbox('te-case', 'Match Case', settings.matchCase, (v) => ((settings.matchCase = v), this.renderSidebar())), checkbox('te-wrap', 'Wrap Around', settings.wrapAround, (v) => ((settings.wrapAround = v), this.renderSidebar()))),
        ]),
        panel('te-props', 'Properties', () => [
          h('div', { class: 'te-prop' }, numberField({ id: 'te-tabw', label: 'Tab Width', value: settings.tabWidth, int: true, min: 1, max: 8, set: (v) => ((settings.tabWidth = Math.round(v)), this.measure(), this.render()) })),
          h('div', { class: 'te-prop' }, numberField({ id: 'te-fs', label: 'Font Size', value: settings.fontSize, int: true, min: 8, max: 32, set: (v) => ((settings.fontSize = Math.round(v)), this.measure(), this.render()) })),
          h('div', { class: 'te-sb-label' }, 'Indentation'),
          h(
            'div',
            { class: 'enum-row' },
            h('button', { class: { on: !settings.useSpaces }, onclick: () => ((settings.useSpaces = false), this.renderSidebar()) }, 'Tabs'),
            h('button', { class: { on: settings.useSpaces }, onclick: () => ((settings.useSpaces = true), this.renderSidebar()) }, 'Spaces'),
          ),
        ]),
      ),
    ]);
  }

  /** Enter runs the action, Escape returns to the text; default handling is suppressed so focus changes don't leak keys. */
  private fieldKey(e: KeyboardEvent, onEnter: () => void) {
    e.stopPropagation();
    if (e.key === 'Enter') {
      e.preventDefault();
      onEnter();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      this.ta.focus();
    }
  }

  startFind() {
    const sel = this.ta.value.slice(this.ta.selectionStart, this.ta.selectionEnd);
    if (sel && !sel.includes('\n')) this.findText = sel;
    this.findFocus = true;
    this.toggleSidebar(true);
  }

  private matchAt(from: number, backwards = false): [number, number] | null {
    const q = this.findText;
    if (!q) return null;
    const hay = settings.matchCase ? this.ta.value : this.ta.value.toLowerCase();
    const needle = settings.matchCase ? q : q.toLowerCase();
    let i = backwards ? hay.lastIndexOf(needle, from) : hay.indexOf(needle, from);
    if (i < 0 && settings.wrapAround) i = backwards ? hay.lastIndexOf(needle) : hay.indexOf(needle);
    return i < 0 ? null : [i, i + q.length];
  }

  findNext() {
    if (!this.text) return;
    const m = this.matchAt(this.ta.selectionEnd);
    if (!m) {
      app.report('WARNING', `Text not found: ${this.findText}`);
      return;
    }
    this.ta.focus();
    this.ta.setSelectionRange(m[0], m[1]);
    this.revealCaret();
  }

  private selectionMatches() {
    const sel = this.ta.value.slice(this.ta.selectionStart, this.ta.selectionEnd);
    return !!this.findText && (settings.matchCase ? sel === this.findText : sel.toLowerCase() === this.findText.toLowerCase());
  }

  replaceOne() {
    if (!this.text || !this.findText) return;
    if (this.selectionMatches()) this.insert(this.replaceText);
    this.findNext();
  }

  replaceAll() {
    const t = this.text;
    if (!t || !this.findText) return;
    const flags = settings.matchCase ? 'g' : 'gi';
    const re = new RegExp(this.findText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags);
    const count = (this.ta.value.match(re) ?? []).length;
    if (!count) {
      app.report('WARNING', `Text not found: ${this.findText}`);
      return;
    }
    this.ta.focus();
    this.ta.setSelectionRange(0, this.ta.value.length);
    this.insert(this.ta.value.replace(re, () => this.replaceText));
    app.report('INFO', `Replaced ${count} occurrence${count === 1 ? '' : 's'}`);
  }

  // ---------------------------------------------------------------- editing helpers

  private exec(cmd: 'undo' | 'redo') {
    this.ta.focus();
    document.execCommand(cmd);
  }

  /** Replace the selection keeping the browser's undo stack intact. */
  insert(text: string) {
    this.ta.focus();
    if (!document.execCommand('insertText', false, text)) {
      this.ta.setRangeText(text, this.ta.selectionStart, this.ta.selectionEnd, 'end');
      this.onInput();
    }
  }

  private async copy() {
    const s = this.ta.value.slice(this.ta.selectionStart, this.ta.selectionEnd);
    if (s) await navigator.clipboard?.writeText(s).catch(() => document.execCommand('copy'));
  }
  private async cut() {
    await this.copy();
    this.insert('');
  }
  private async paste() {
    try {
      const s = await navigator.clipboard.readText();
      this.insert(s);
    } catch {
      app.report('WARNING', 'Clipboard access was denied; use Ctrl V in the editor');
    }
  }

  setCaret(pos: number, end = pos) {
    this.ta.focus();
    this.ta.setSelectionRange(pos, end);
    this.revealCaret();
  }

  private revealCaret() {
    requestAnimationFrame(() => {
      const { line } = this.caretLine();
      const row = this.pre.children[line] as HTMLElement | undefined;
      if (!row) return;
      const top = row.offsetTop,
        bottom = top + row.offsetHeight;
      const sc = this.scroll;
      if (top < sc.scrollTop) sc.scrollTop = top - 4;
      else if (bottom > sc.scrollTop + sc.clientHeight) sc.scrollTop = bottom - sc.clientHeight + 4;
      this.updateCaret();
    });
  }

  goToLine(n: number) {
    const lines = this.ta.value.split('\n');
    const ln = Math.max(1, Math.min(lines.length, Math.round(n)));
    let pos = 0;
    for (let i = 0; i < ln - 1; i++) pos += lines[i].length + 1;
    this.setCaret(pos);
  }

  /** Line range [start, end) covering the selection. */
  private lineRange() {
    const v = this.ta.value;
    const s = this.ta.selectionStart,
      e = this.ta.selectionEnd;
    const start = v.lastIndexOf('\n', s - 1) + 1;
    let endPos = e > s && v[e - 1] === '\n' ? e - 1 : e;
    let end = v.indexOf('\n', endPos);
    if (end < 0) end = v.length;
    return { start, end, text: v.slice(start, end) };
  }

  private indentUnit() {
    return settings.useSpaces ? ' '.repeat(settings.tabWidth) : '\t';
  }

  indent() {
    const s = this.ta.selectionStart,
      e = this.ta.selectionEnd;
    const v = this.ta.value;
    if (s === e || !v.slice(s, e).includes('\n')) {
      if (s === e) {
        const col = s - (v.lastIndexOf('\n', s - 1) + 1);
        this.insert(settings.useSpaces ? ' '.repeat(settings.tabWidth - (col % settings.tabWidth)) : '\t');
        return;
      }
    }
    const r = this.lineRange();
    const unit = this.indentUnit();
    const out = r.text
      .split('\n')
      .map((l) => (l.length ? unit + l : l))
      .join('\n');
    this.ta.setSelectionRange(r.start, r.end);
    this.insert(out);
    this.ta.setSelectionRange(r.start, r.start + out.length);
  }

  unindent() {
    const r = this.lineRange();
    const out = r.text
      .split('\n')
      .map((l) => {
        if (l.startsWith('\t')) return l.slice(1);
        const m = /^ +/.exec(l);
        return m ? l.slice(Math.min(m[0].length, settings.tabWidth)) : l;
      })
      .join('\n');
    if (out === r.text) return;
    this.ta.setSelectionRange(r.start, r.end);
    this.insert(out);
    this.ta.setSelectionRange(r.start, r.start + out.length);
  }

  toggleComment() {
    const lang = langOf(this.text);
    const mark = lang === 'javascript' ? '//' : '#';
    const r = this.lineRange();
    const lines = r.text.split('\n');
    const nonEmpty = lines.filter((l) => l.trim());
    const allCommented = nonEmpty.length > 0 && nonEmpty.every((l) => l.trimStart().startsWith(mark));
    const minIndent = Math.min(...nonEmpty.map((l) => /^\s*/.exec(l)![0].length), Infinity);
    const out = lines
      .map((l) => {
        if (!l.trim()) return l;
        if (allCommented) {
          const i = l.indexOf(mark);
          return l.slice(0, i) + l.slice(i + mark.length).replace(/^ /, '');
        }
        const k = Number.isFinite(minIndent) ? minIndent : 0;
        return `${l.slice(0, k)}${mark} ${l.slice(k)}`;
      })
      .join('\n');
    this.ta.setSelectionRange(r.start, r.end);
    this.insert(out);
    this.ta.setSelectionRange(r.start, r.start + out.length);
  }

  duplicateLine() {
    const r = this.lineRange();
    const caret = this.ta.selectionStart;
    this.ta.setSelectionRange(r.end, r.end);
    this.insert(`\n${r.text}`);
    this.ta.setSelectionRange(caret + r.text.length + 1, caret + r.text.length + 1);
  }

  moveLines(dir: 'UP' | 'DOWN') {
    const v = this.ta.value;
    const r = this.lineRange();
    const s = this.ta.selectionStart - r.start,
      e = this.ta.selectionEnd - r.start;
    if (dir === 'UP') {
      if (r.start === 0) return;
      const prevStart = v.lastIndexOf('\n', r.start - 2) + 1;
      const prev = v.slice(prevStart, r.start - 1);
      this.ta.setSelectionRange(prevStart, r.end);
      this.insert(`${r.text}\n${prev}`);
      this.ta.setSelectionRange(prevStart + s, prevStart + e);
    } else {
      if (r.end >= v.length) return;
      let nextEnd = v.indexOf('\n', r.end + 1);
      if (nextEnd < 0) nextEnd = v.length;
      const next = v.slice(r.end + 1, nextEnd);
      this.ta.setSelectionRange(r.start, nextEnd);
      this.insert(`${next}\n${r.text}`);
      const ns = r.start + next.length + 1;
      this.ta.setSelectionRange(ns + s, ns + e);
    }
  }

  convertWhitespace(type: 'SPACES' | 'TABS') {
    const unit = ' '.repeat(settings.tabWidth);
    const out = this.ta.value
      .split('\n')
      .map((l) => {
        const m = /^[ \t]*/.exec(l)![0];
        const width = [...m].reduce((w, c) => (c === '\t' ? w + settings.tabWidth - (w % settings.tabWidth) : w + 1), 0);
        const lead = type === 'SPACES' ? ' '.repeat(width) : '\t'.repeat(Math.floor(width / settings.tabWidth)) + ' '.repeat(width % settings.tabWidth);
        return lead + l.slice(m.length);
      })
      .join('\n');
    if (out === this.ta.value) return;
    const caret = this.ta.selectionStart;
    this.ta.focus();
    this.ta.setSelectionRange(0, this.ta.value.length);
    this.insert(out);
    this.ta.setSelectionRange(Math.min(caret, out.length), Math.min(caret, out.length));
    void unit;
  }

  selectAll() {
    this.setCaret(0, this.ta.value.length);
  }
  selectLine() {
    const r = this.lineRange();
    this.setCaret(r.start, r.end);
  }
  selectWord() {
    const v = this.ta.value;
    let s = this.ta.selectionStart,
      e = s;
    while (s > 0 && /\w/.test(v[s - 1])) s--;
    while (e < v.length && /\w/.test(v[e])) e++;
    this.setCaret(s, e);
  }

  private newlineWithIndent() {
    const v = this.ta.value;
    const s = this.ta.selectionStart;
    const lineStart = v.lastIndexOf('\n', s - 1) + 1;
    const before = v.slice(lineStart, s);
    let lead = /^[ \t]*/.exec(before)![0];
    const trimmed = before.trimEnd();
    const lang = langOf(this.text);
    if ((lang === 'python' && trimmed.endsWith(':')) || (lang === 'javascript' && /[{([]$/.test(trimmed))) lead += this.indentUnit();
    if (lang === 'python' && /^\s*(return|pass|break|continue|raise)\b/.test(before) && lead.length) lead = lead.slice(0, Math.max(0, lead.length - this.indentUnit().length));
    this.insert(`\n${lead}`);
  }

  private smartBackspace(): boolean {
    if (!settings.useSpaces || this.ta.selectionStart !== this.ta.selectionEnd) return false;
    const v = this.ta.value;
    const s = this.ta.selectionStart;
    const lineStart = v.lastIndexOf('\n', s - 1) + 1;
    const before = v.slice(lineStart, s);
    if (!before.length || /[^ ]/.test(before)) return false;
    const n = before.length % settings.tabWidth || settings.tabWidth;
    this.ta.setSelectionRange(s - n, s);
    this.insert('');
    return true;
  }

  // ---------------------------------------------------------------- keys

  private onKeyDown(e: KeyboardEvent) {
    e.stopPropagation();
    if (redirectIfElsewhere(e, this.area, this.ta)) return;
    // Text keymap (editable in Preferences ▸ Keymap) and window shortcuts
    if (dispatchEditorKeys(e, this.area, ['Text'], () => this.commitUndo())) return;
    if (e.key === 'Tab' && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      if (e.shiftKey) this.unindent();
      else this.indent();
      return;
    }
    if (e.key === 'Enter' && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
      e.preventDefault();
      this.newlineWithIndent();
      return;
    }
    if (e.key === 'Backspace' && !e.ctrlKey && !e.metaKey && !e.altKey && this.smartBackspace()) {
      e.preventDefault();
      return;
    }
    if (e.key === 'Escape') {
      this.ta.blur();
      return;
    }
  }

  onKey(e: KeyboardEvent): boolean {
    // keys while hovering the editor without focus in the text area
    if (e.key === 'Escape' && this.showSidebar && document.activeElement?.closest('.te-sidebar')) {
      this.ta.focus();
      return true;
    }
    return false;
  }

  // ---------------------------------------------------------------- templates / run

  openTemplate(tpl: (typeof templates)[number]) {
    const t = newText(uniqueName(app.doc.texts, tpl.file), tpl.body, tpl.language);
    app.doc.texts[t.id] = t;
    app.pushUndo('New Text from Template');
    this.setText(t.id);
    app.changed('doc');
  }

  async run(): Promise<RunResult | null> {
    const t = this.text;
    if (!t) return null;
    t.body = this.ta.value;
    this.commitUndo();
    const res = await runText(t);
    this.errorLine = res.ok ? null : res.line ?? null;
    this.render();
    if (!res.ok && res.line) this.goToLine(res.line);
    return res;
  }

  serialize() {
    return { text: this.textId, lineNumbers: this.showLineNumbers, wrap: this.wordWrap, syntax: this.syntax, sidebar: this.showSidebar };
  }

  resize() {
    this.layout();
  }

  dispose() {
    this.commitUndo();
    this.resizeObs.disconnect();
    document.removeEventListener('selectionchange', this.onSelectionChange);
  }
}

function div(cls: string) {
  const d = document.createElement('div');
  d.className = cls;
  return d;
}

export function templateMenu(open: (t: (typeof templates)[number]) => void): MenuItem[] {
  return [
    { heading: 'Python' },
    ...templates.filter((t) => t.language === 'python').map((t) => ({ label: t.name, icon: 'file_script', action: () => open(t) })),
    { separator: true },
    { heading: 'JavaScript' },
    ...templates.filter((t) => t.language === 'javascript').map((t) => ({ label: t.name, icon: 'file_script', action: () => open(t) })),
  ];
}

/** Run a text data-block in its language; reports errors (with line numbers) to Info and the status bar. */
export async function runText(t: TextData): Promise<RunResult> {
  let res: RunResult;
  if (t.language === 'javascript') res = runJavaScript(t.body, t.name);
  else if (t.language === 'text') {
    app.report('WARNING', `"${t.name}" is plain text; set Text ▸ Language to Python or JavaScript to run it`);
    return { ok: false, error: 'not a script' };
  } else {
    try {
      if (!python.ready) app.report('INFO', 'Loading Python runtime…');
      await loadPython();
    } catch (e) {
      app.report('ERROR', (e as Error).message);
      return { ok: false, error: (e as Error).message };
    }
    res = runPythonText(t.body, t.name);
  }
  if (!res.ok) {
    const where = res.line ? ` line ${res.line}` : '';
    app.report('ERROR', `${t.name}${where}: ${res.error}`);
    if (res.traceback && t.language === 'python') output.push(res.traceback, 'ERROR');
    else output.push(`${t.name}${where}: ${res.error}`, 'ERROR');
  }
  return res;
}

const python = {
  get ready() {
    return pythonLoaded();
  },
};
import { pythonReady as pythonLoaded } from './python';

// ---------------------------------------------------------------------------
// operators & keymap

const textArea = (ctx: OpContext) => (ctx.area?.type === 'TEXT' ? (ctx.area.editor as TextEditor) : null);
const withText = (ctx: OpContext) => {
  const ed = textArea(ctx);
  return ed && ed.text ? ed : null;
};

registerOperators([
  {
    idname: 'text.new',
    label: 'New Text',
    description: 'Create a new text data-block',
    exec: (ctx) => {
      const t = newText(uniqueName(app.doc.texts, 'Text'), '', 'python');
      app.doc.texts[t.id] = t;
      const ed = textArea(ctx);
      if (ed) {
        ed.textId = t.id;
        requestAnimationFrame(() => ed.setText(t.id));
      }
    },
  },
  {
    idname: 'text.open',
    label: 'Open Text',
    description: 'Open a text file from disk',
    undo: false,
    exec: (ctx) => {
      const ed = textArea(ctx);
      void pickFile('.py,.js,.mjs,.txt,.json,.md,.glsl,text/*').then(async (file) => {
        if (!file) return;
        if (file.size > 8 * 1024 * 1024) {
          app.report('ERROR', `${file.name} is too large to open as text`);
          return;
        }
        const body = (await file.text()).replace(/\r\n?/g, '\n');
        const t = newText(uniqueName(app.doc.texts, file.name), body, langFromName(file.name));
        app.doc.texts[t.id] = t;
        app.pushUndo('Open Text');
        ed?.setText(t.id);
        app.changed('doc');
      });
    },
  },
  {
    idname: 'text.save',
    label: 'Save Text',
    description: 'Save the active text to a file on disk',
    undo: false,
    poll: (ctx) => !!withText(ctx),
    exec: (ctx) => void saveText(withText(ctx)!, false),
  },
  {
    idname: 'text.save_as',
    label: 'Save Text As',
    description: 'Save the active text to a new file on disk',
    undo: false,
    poll: (ctx) => !!withText(ctx),
    exec: (ctx) => void saveText(withText(ctx)!, true),
  },
  {
    idname: 'text.unlink',
    label: 'Unlink Text',
    description: 'Remove the active text data-block',
    poll: (ctx) => !!withText(ctx),
    exec: (ctx) => {
      const ed = withText(ctx)!;
      const id = ed.textId!;
      delete app.doc.texts[id];
      fileHandles.delete(id);
      ed.setText(Object.values(app.doc.texts)[0]?.id ?? null);
    },
  },
  {
    idname: 'text.run_script',
    label: 'Run Script',
    description: 'Run the active text as a Python or JavaScript script',
    undo: false,
    poll: (ctx) => !!withText(ctx),
    exec: (ctx) => void withText(ctx)!.run(),
  },
  { idname: 'text.start_find', label: 'Find & Replace', description: 'Open the Find & Replace panel', undo: false, poll: (ctx) => !!withText(ctx), exec: (ctx) => withText(ctx)!.startFind() },
  { idname: 'text.find', label: 'Find Next', description: 'Find the next occurrence of the search text', undo: false, poll: (ctx) => !!withText(ctx), exec: (ctx) => withText(ctx)!.findNext() },
  { idname: 'text.replace', label: 'Replace', description: 'Replace the current match and find the next one', undo: false, poll: (ctx) => !!withText(ctx), exec: (ctx) => withText(ctx)!.replaceOne() },
  {
    idname: 'text.jump',
    label: 'Jump To Line',
    description: 'Jump to a line number',
    undo: false,
    poll: (ctx) => !!withText(ctx),
    exec: (ctx) => {
      const ed = withText(ctx)!;
      promptText('Jump to Line', '', (v) => {
        const n = parseInt(v, 10);
        if (Number.isFinite(n)) requestAnimationFrame(() => ed.goToLine(n));
      });
    },
  },
  { idname: 'text.indent', label: 'Indent', description: 'Indent the selected lines', undo: false, poll: (ctx) => !!withText(ctx), exec: (ctx) => withText(ctx)!.indent() },
  { idname: 'text.unindent', label: 'Unindent', description: 'Unindent the selected lines', undo: false, poll: (ctx) => !!withText(ctx), exec: (ctx) => withText(ctx)!.unindent() },
  { idname: 'text.comment_toggle', label: 'Toggle Comments', description: 'Comment or uncomment the selected lines', undo: false, poll: (ctx) => !!withText(ctx), exec: (ctx) => withText(ctx)!.toggleComment() },
  { idname: 'text.duplicate_line', label: 'Duplicate Line', description: 'Duplicate the current line', undo: false, poll: (ctx) => !!withText(ctx), exec: (ctx) => withText(ctx)!.duplicateLine() },
  {
    idname: 'text.move_lines',
    label: 'Move Lines',
    description: 'Move the selected lines up or down',
    undo: false,
    props: [{ id: 'direction', label: 'Direction', type: 'enum', default: 'DOWN', items: [['UP', 'Up'], ['DOWN', 'Down']] }],
    poll: (ctx) => !!withText(ctx),
    exec: (ctx, p) => withText(ctx)!.moveLines(p.direction as 'UP' | 'DOWN'),
  },
  {
    idname: 'text.convert_whitespace',
    label: 'Convert Whitespace',
    description: 'Convert indentation to spaces or tabs',
    undo: false,
    props: [{ id: 'type', label: 'Type', type: 'enum', default: 'SPACES', items: [['SPACES', 'To Spaces'], ['TABS', 'To Tabs']] }],
    poll: (ctx) => !!withText(ctx),
    exec: (ctx, p) => withText(ctx)!.convertWhitespace(p.type as 'SPACES'),
  },
  { idname: 'text.toggle_sidebar', label: 'Toggle Sidebar', description: 'Show or hide the Text Editor sidebar', undo: false, poll: (ctx) => !!textArea(ctx), exec: (ctx) => textArea(ctx)!.toggleSidebar() },
]);

addKeys('Text', [
  { key: 'P', alt: true, op: 'text.run_script' },
  { key: 'N', alt: true, op: 'text.new' },
  { key: 'O', alt: true, op: 'text.open' },
  { key: 'S', alt: true, op: 'text.save' },
  { key: 'S', shift: true, ctrl: true, alt: true, op: 'text.save_as' },
  { key: 'F', ctrl: true, op: 'text.start_find' },
  { key: 'G', ctrl: true, op: 'text.find' },
  { key: 'H', ctrl: true, op: 'text.replace' },
  { key: 'J', ctrl: true, op: 'text.jump' },
  { key: 'SLASH', ctrl: true, op: 'text.comment_toggle' },
  { key: 'D', shift: true, ctrl: true, op: 'text.duplicate_line' },
  { key: 'UP_ARROW', shift: true, ctrl: true, op: 'text.move_lines', props: { direction: 'UP' } },
  { key: 'DOWN_ARROW', shift: true, ctrl: true, op: 'text.move_lines', props: { direction: 'DOWN' } },
  { key: 'T', ctrl: true, op: 'text.toggle_sidebar' },
]);

async function saveText(ed: TextEditor, saveAs: boolean) {
  const t = ed.text;
  if (!t) return;
  const picker = (window as unknown as { showSaveFilePicker?: (o: unknown) => Promise<FileSystemFileHandle> }).showSaveFilePicker;
  const ext = t.language === 'javascript' ? '.js' : t.language === 'python' ? '.py' : '.txt';
  const name = /\.[a-z0-9]+$/i.test(t.name) ? t.name : `${t.name}${ext}`;
  try {
    if (picker) {
      let handle = saveAs ? undefined : fileHandles.get(t.id);
      if (!handle) {
        handle = await picker({ suggestedName: name, types: [{ description: 'Script', accept: { 'text/plain': ['.py', '.js', '.txt'] } }] });
        fileHandles.set(t.id, handle);
      }
      const w = await (handle as unknown as { createWritable(): Promise<{ write(s: string): Promise<void>; close(): Promise<void> }> }).createWritable();
      await w.write(t.body);
      await w.close();
      app.report('INFO', `Saved "${handle.name}"`);
    } else {
      download(t.body, name, 'text/plain');
      app.report('INFO', `Saved "${name}" to downloads`);
    }
    ed.render();
  } catch (e) {
    if ((e as Error)?.name === 'AbortError') return;
    app.report('ERROR', `Could not save text: ${(e as Error)?.message ?? e}`);
  }
}

registerEditor({ id: 'TEXT', label: 'Text Editor', icon: 'text', group: 'Scripting', create: (a, s) => new TextEditor(a, s) });
