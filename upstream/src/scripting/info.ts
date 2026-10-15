// Info editor: reports (info / warnings / errors) and the operator log in Python-call form.
// Click to select (Shift/Ctrl to extend), A select all, Ctrl+C copy, X / Delete delete.
import { h, patch, type Child } from '../ui/h';
import { icon } from '../ui/icons';
import { app, registerOperators, type ChangeKind, type OpContext, type Report } from '../app/app';
import { registerEditor, type Area, type Editor } from '../ui/screen';
import { openMenu, type MenuItem } from '../ui/menu';
import { addKeys } from '../app/keymap';
import { opLog, type LogEntry } from './oplog';

type Entry = Report | LogEntry;

const selected = new WeakSet<Entry>();
let anchor: Entry | null = null;

function entries(): Entry[] {
  const all: Entry[] = [...app.reports, ...opLog.entries];
  return all.sort((a, b) => a.time - b.time);
}

const ICON: Record<string, string> = { INFO: 'info_small', WARNING: 'warning', ERROR: 'error', OPERATOR: 'info_op' };

export class InfoEditor implements Editor {
  el: HTMLElement;
  keymaps = ['Info', 'Window', 'Screen'];
  private list: HTMLElement;
  private lastCount = -1;
  private unsub: () => void;
  showOps = true;
  showInfo = true;
  showWarnings = true;
  showErrors = true;

  constructor(public area: Area) {
    this.el = document.createElement('div');
    this.el.className = 'info-editor';
    this.el.tabIndex = -1;
    this.list = document.createElement('div');
    this.list.className = 'info-list';
    this.list.setAttribute('role', 'listbox');
    this.list.setAttribute('aria-multiselectable', 'true');
    this.el.append(this.list);
    const fn = () => this.draw();
    opLog.listeners.add(fn);
    this.unsub = () => opLog.listeners.delete(fn);
    this.el.addEventListener('pointerdown', (e) => {
      if (e.target === this.el || e.target === this.list) {
        for (const x of entries()) selected.delete(x);
        this.draw();
      }
    });
    this.draw();
  }

  private visible(): Entry[] {
    return entries().filter((e) => (e.type === 'OPERATOR' ? this.showOps : e.type === 'INFO' ? this.showInfo : e.type === 'WARNING' ? this.showWarnings : this.showErrors));
  }

  header(): Child {
    const menu = (label: string, items: () => MenuItem[]) =>
      h('button', { key: label, class: 'hdr-menu', onpointerdown: (e: PointerEvent) => (e.preventDefault(), openMenu(items(), e.currentTarget as HTMLElement)) }, label);
    const tog = (key: 'showOps' | 'showInfo' | 'showWarnings' | 'showErrors', ic: string, tip: string) =>
      h('button', { key, class: { 'hdr-toggle': true, on: this[key] }, 'data-tip': tip, 'aria-label': tip.split('\n')[0], 'aria-pressed': this[key] ? 'true' : 'false', onclick: () => ((this[key] = !this[key]), this.draw(), this.area.drawHeader()) }, icon(ic));
    return h(
      'div',
      { class: 'hdr-row' },
      menu('View', () => [
        { label: 'Scroll to Bottom', action: () => this.scrollBottom() },
        { separator: true },
        { label: 'Show Operators', checked: this.showOps, action: () => ((this.showOps = !this.showOps), this.draw()) },
        { label: 'Show Info', checked: this.showInfo, action: () => ((this.showInfo = !this.showInfo), this.draw()) },
        { label: 'Show Warnings', checked: this.showWarnings, action: () => ((this.showWarnings = !this.showWarnings), this.draw()) },
        { label: 'Show Errors', checked: this.showErrors, action: () => ((this.showErrors = !this.showErrors), this.draw()) },
      ]),
      menu('Info', () => [
        { label: 'Select All', shortcut: 'A', op: 'info.select_all', props: { action: 'SELECT' } },
        { label: 'Deselect All', shortcut: 'Alt A', op: 'info.select_all', props: { action: 'DESELECT' } },
        { label: 'Invert Selection', shortcut: 'Ctrl I', op: 'info.select_all', props: { action: 'INVERT' } },
        { separator: true },
        { label: 'Copy', shortcut: 'Ctrl C', op: 'info.report_copy' },
        { label: 'Delete', shortcut: 'X', op: 'info.report_delete' },
        { separator: true },
        { label: 'Clear All', op: 'info.clear' },
      ]),
      h('div', { class: 'hdr-spacer' }),
      h('div', { class: 'hdr-group' }, tog('showOps', 'info_op', 'Operators\nShow the operator log'), tog('showInfo', 'info_small', 'Info\nShow info reports'), tog('showWarnings', 'warning', 'Warnings\nShow warnings'), tog('showErrors', 'error', 'Errors\nShow errors')),
    );
  }

  draw() {
    const list = this.visible();
    const atBottom = this.el.scrollHeight - this.el.scrollTop - this.el.clientHeight < 30;
    patch(
      this.list,
      list.map((e, i) =>
        h(
          'div',
          {
            key: `${e.time}:${i}:${e.message.length}`,
            class: { 'info-row': true, [e.type.toLowerCase()]: true, sel: selected.has(e) },
            role: 'option',
            'aria-selected': selected.has(e) ? 'true' : 'false',
            title: e.message,
            onpointerdown: (ev: PointerEvent) => {
              ev.stopPropagation();
              this.click(e, ev);
            },
          },
          h('span', { class: 'info-ic' }, icon(ICON[e.type] ?? 'info_small')),
          h('span', { class: 'info-msg' }, e.message),
        ),
      ),
    );
    if (atBottom || list.length !== this.lastCount) this.scrollBottom();
    this.lastCount = list.length;
  }

  private click(e: Entry, ev: PointerEvent) {
    const vis = this.visible();
    if (ev.shiftKey && anchor && vis.includes(anchor)) {
      const a = vis.indexOf(anchor),
        b = vis.indexOf(e);
      for (let i = Math.min(a, b); i <= Math.max(a, b); i++) selected.add(vis[i]);
    } else if (ev.ctrlKey || ev.metaKey) {
      if (selected.has(e)) selected.delete(e);
      else selected.add(e);
      anchor = e;
    } else {
      for (const x of vis) selected.delete(x);
      selected.add(e);
      anchor = e;
    }
    this.el.focus({ preventScroll: true });
    this.draw();
  }

  private scrollBottom() {
    requestAnimationFrame(() => (this.el.scrollTop = this.el.scrollHeight));
  }

  selectAll(action: 'SELECT' | 'DESELECT' | 'INVERT' | 'TOGGLE') {
    const vis = this.visible();
    const any = vis.some((e) => selected.has(e));
    for (const e of vis) {
      const on = action === 'SELECT' ? true : action === 'DESELECT' ? false : action === 'INVERT' ? !selected.has(e) : !any;
      if (on) selected.add(e);
      else selected.delete(e);
    }
    this.draw();
  }

  selection() {
    return this.visible().filter((e) => selected.has(e));
  }

  update(kinds: Set<ChangeKind>) {
    if (kinds.has('ui') || kinds.has('doc')) this.draw();
  }

  dispose() {
    this.unsub();
  }
}

export function deleteEntries(list: Entry[]) {
  const set = new Set(list);
  for (const arr of [app.reports, opLog.entries] as Entry[][]) {
    for (let i = arr.length - 1; i >= 0; i--) if (set.has(arr[i])) arr.splice(i, 1);
  }
}

const infoOf = (ctx: OpContext) => (ctx.area?.type === 'INFO' ? (ctx.area.editor as InfoEditor) : null);

registerOperators([
  {
    idname: 'info.select_all',
    label: '(De)select All',
    description: 'Change the selection of all visible reports',
    undo: false,
    props: [{ id: 'action', label: 'Action', type: 'enum', default: 'TOGGLE', items: [['TOGGLE', 'Toggle'], ['SELECT', 'Select'], ['DESELECT', 'Deselect'], ['INVERT', 'Invert']] }],
    poll: (ctx) => !!infoOf(ctx),
    exec: (ctx, p) => infoOf(ctx)!.selectAll(p.action as 'SELECT'),
  },
  {
    idname: 'info.report_copy',
    label: 'Copy Reports to Clipboard',
    description: 'Copy the selected reports to the clipboard',
    undo: false,
    poll: (ctx) => !!infoOf(ctx) && infoOf(ctx)!.selection().length > 0,
    exec: (ctx) => {
      const text = infoOf(ctx)!
        .selection()
        .map((e) => e.message)
        .join('\n');
      void navigator.clipboard?.writeText(text).then(
        () => app.report('INFO', `Copied ${text.split('\n').length} line(s)`),
        () => app.report('WARNING', 'Clipboard access was denied'),
      );
    },
  },
  {
    idname: 'info.report_delete',
    label: 'Delete Reports',
    description: 'Delete the selected reports',
    undo: false,
    poll: (ctx) => !!infoOf(ctx) && infoOf(ctx)!.selection().length > 0,
    exec: (ctx) => {
      deleteEntries(infoOf(ctx)!.selection());
      app.changed('ui');
      infoOf(ctx)!.draw();
    },
  },
  {
    idname: 'info.clear',
    label: 'Clear Reports',
    description: 'Delete all reports and the operator log',
    undo: false,
    exec: () => {
      app.reports.length = 0;
      opLog.entries.length = 0;
      app.changed('ui');
    },
  },
]);

addKeys('Info', [
  { key: 'A', op: 'info.select_all', props: { action: 'SELECT' } },
  { key: 'A', alt: true, op: 'info.select_all', props: { action: 'DESELECT' } },
  { key: 'I', ctrl: true, op: 'info.select_all', props: { action: 'INVERT' } },
  { key: 'C', ctrl: true, op: 'info.report_copy' },
  { key: 'X', op: 'info.report_delete' },
  { key: 'DEL', op: 'info.report_delete' },
]);

registerEditor({ id: 'INFO', label: 'Info', icon: 'info', group: 'Scripting', create: (a) => new InfoEditor(a) });
