// User keymap overrides: edited in Preferences ▸ Keymap, stored in localStorage and
// applied to the in-memory keymaps at startup.
import { keymaps, type KeyItem } from '../app/keymap';

const STORAGE = 'p3d.keymap.overrides.v1';

export interface Binding {
  key: string;
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
}
interface Override extends Binding {
  km: string;
  index: number;
  op: string;
  orig: Binding;
  active: boolean;
}

const originals = new WeakMap<KeyItem, Binding>();
const disabled = new WeakSet<KeyItem>();
let overrides: Override[] = [];

const bindingOf = (k: KeyItem): Binding => ({ key: k.key, ctrl: !!k.ctrl, shift: !!k.shift, alt: !!k.alt });
const same = (a: Binding, b: Binding) => a.key === b.key && a.ctrl === b.ctrl && a.shift === b.shift && a.alt === b.alt;

/** The default binding of an item (before user overrides). */
export function originalBinding(k: KeyItem): Binding {
  return originals.get(k) ?? bindingOf(k);
}

export function isActive(k: KeyItem) {
  return !disabled.has(k);
}

export function isModified(k: KeyItem) {
  const o = originals.get(k);
  return disabled.has(k) || (!!o && !same(o, bindingOf(k)));
}

function load(): Override[] {
  try {
    const raw = localStorage.getItem(STORAGE);
    const v = raw ? (JSON.parse(raw) as Override[]) : [];
    return Array.isArray(v) ? v.filter((o) => o && typeof o.km === 'string' && typeof o.key === 'string') : [];
  } catch {
    return [];
  }
}

function save() {
  try {
    if (overrides.length) localStorage.setItem(STORAGE, JSON.stringify(overrides));
    else localStorage.removeItem(STORAGE);
  } catch {
    // storage unavailable: overrides last for this session
  }
}

function find(o: Override): KeyItem | null {
  const list = keymaps[o.km];
  if (!list) return null;
  const at = list[o.index];
  const matches = (k: KeyItem) => k.op === o.op && same(originalBinding(k), o.orig);
  if (at && matches(at)) return at;
  return list.find(matches) ?? null;
}

function applyOne(k: KeyItem, o: Override) {
  if (!originals.has(k)) originals.set(k, bindingOf(k));
  if (o.active) {
    disabled.delete(k);
    k.key = o.key;
  } else {
    disabled.add(k);
    k.key = 'NONE';
  }
  k.ctrl = o.ctrl || undefined;
  k.shift = o.shift || undefined;
  k.alt = o.alt || undefined;
}

/** Apply stored overrides to the keymaps (called once all modules registered their keys). */
export function applyKeymapOverrides() {
  overrides = load();
  for (const o of overrides) {
    const k = find(o);
    if (k) applyOne(k, o);
  }
}

/** Set (or disable) a binding and persist it. */
export function setBinding(km: string, k: KeyItem, b: Partial<Binding> & { active?: boolean }) {
  const index = keymaps[km]?.indexOf(k) ?? -1;
  if (index < 0) return;
  const orig = originalBinding(k);
  if (!originals.has(k)) originals.set(k, orig);
  const cur = { ...bindingOf(k), key: disabled.has(k) ? overrides.find((o) => find(o) === k)?.key ?? orig.key : k.key };
  const next: Override = { km, index, op: k.op ?? '', orig, key: b.key ?? cur.key, ctrl: b.ctrl ?? cur.ctrl, shift: b.shift ?? cur.shift, alt: b.alt ?? cur.alt, active: b.active ?? !disabled.has(k) };
  overrides = overrides.filter((o) => find(o) !== k);
  if (!(next.active && same(next, orig))) overrides.push(next);
  applyOne(k, next);
  save();
}

/** The binding to show for an item (disabled items keep their key for display). */
export function displayBinding(k: KeyItem): Binding {
  if (!disabled.has(k)) return bindingOf(k);
  const o = overrides.find((x) => find(x) === k);
  return o ? { key: o.key, ctrl: o.ctrl, shift: o.shift, alt: o.alt } : originalBinding(k);
}

export function resetBinding(k: KeyItem) {
  const o = originals.get(k);
  overrides = overrides.filter((x) => find(x) !== k);
  disabled.delete(k);
  if (o) {
    k.key = o.key;
    k.ctrl = o.ctrl || undefined;
    k.shift = o.shift || undefined;
    k.alt = o.alt || undefined;
  }
  save();
}

export function resetAllBindings() {
  for (const list of Object.values(keymaps)) for (const k of list) if (isModified(k)) resetBinding(k);
  overrides = [];
  save();
}

export function overrideCount() {
  return overrides.length;
}
