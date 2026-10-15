// Generic brush stroke driver: turns pointer input into evenly spaced dabs along the mouse path
// (spacing as a percentage of the brush radius), or a dab per mouse move for anchored tools.
import type { View3D } from '../editors/view3d/view3d';
import { renderContext } from '../render/context';
import { cursorState } from './cursorstate';

export interface Dab {
  x: number;
  y: number;
  pressure: number;
  /** first dab of the stroke */
  first: boolean;
}

export interface StrokeHandler {
  /** spacing in percent of the radius (0 = a dab per pointer event) */
  spacing(): number;
  radiusPx(): number;
  dab(d: Dab): void;
  /** after the dabs of one pointer event (upload GPU buffers etc.) */
  update?(): void;
  end(): void;
}

let active: { handler: StrokeHandler; view: View3D } | null = null;

export function strokeActive() {
  return !!active;
}

export function runStroke(v: View3D, e: PointerEvent, handler: StrokeHandler) {
  const el = v.el;
  try {
    el.setPointerCapture(e.pointerId);
  } catch {
    // ignore (synthetic events)
  }
  active = { handler, view: v };
  const p0 = v.local(e);
  let last = { x: p0.x, y: p0.y };
  const pressure = (ev: PointerEvent) => (ev.pointerType === 'pen' && ev.pressure > 0 ? ev.pressure : 1);
  handler.dab({ x: p0.x, y: p0.y, pressure: pressure(e), first: true });
  handler.update?.();
  cursorState.x = p0.x;
  cursorState.y = p0.y;
  let raf = 0;
  let pending: PointerEvent[] = [];
  const process = () => {
    raf = 0;
    const evs = pending;
    pending = [];
    for (const ev of evs) {
      const q = v.local(ev);
      const spacing = handler.spacing();
      if (spacing <= 0) {
        if (q.x !== last.x || q.y !== last.y) handler.dab({ x: q.x, y: q.y, pressure: pressure(ev), first: false });
        last = q;
        continue;
      }
      const step = Math.max(1, (handler.radiusPx() * spacing) / 100);
      const dx = q.x - last.x,
        dy = q.y - last.y;
      const len = Math.hypot(dx, dy);
      if (len < step) continue;
      const n = Math.min(200, Math.floor(len / step));
      for (let i = 1; i <= n; i++) {
        const t = (i * step) / len;
        handler.dab({
          x: last.x + dx * t,
          y: last.y + dy * t,
          pressure: pressure(ev),
          first: false,
        });
      }
      const t = (n * step) / len;
      last = { x: last.x + dx * t, y: last.y + dy * t };
    }
    handler.update?.();
  };
  const move = (ev: PointerEvent) => {
    const q = v.local(ev);
    cursorState.x = q.x;
    cursorState.y = q.y;
    const coalesced = typeof ev.getCoalescedEvents === 'function' ? ev.getCoalescedEvents() : [];
    if (coalesced.length) pending.push(...coalesced);
    else pending.push(ev);
    if (!raf) raf = requestAnimationFrame(process);
  };
  const up = () => {
    removeEventListener('pointermove', move, true);
    removeEventListener('pointerup', up, true);
    removeEventListener('pointercancel', up, true);
    if (raf) cancelAnimationFrame(raf);
    process();
    active = null;
    handler.end();
    renderContext?.engine.requestDraw();
    v.drawSvg();
  };
  addEventListener('pointermove', move, true);
  addEventListener('pointerup', up, true);
  addEventListener('pointercancel', up, true);
}
