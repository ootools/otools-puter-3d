// Marker operators used by the animation editors' Marker menus
// (add/delete live in ops/screen.ts; these add duplicate, rename, move, jump).
import { app, registerOperators } from '../app/app';
import { promptText } from '../ui/menu';
import { hoverEditor } from './animeditor';

const selectedMarkers = () => app.doc.scene.timeline_markers.filter((m) => m.select);

/** Interactive move of the selected markers (follows the pointer horizontally). */
function startMarkerMove(label: string, onCancel?: () => void) {
  const sel = selectedMarkers();
  if (!sel.length) return false;
  const orig = sel.map((m) => m.frame);
  const x0 = app.pointer.x;
  const ppf = hoverEditor()?.view.ppf ?? 6;
  let delta = 0;
  let numeric = '';
  const apply = () => {
    const d = numeric && numeric !== '-' ? Math.round(Number(numeric)) || 0 : delta;
    sel.forEach((m, i) => (m.frame = orig[i] + d));
    app.changed('ui');
    return d;
  };
  app.startModal({
    label,
    cursor: 'ew-resize',
    header: () => `Marker offset ${numeric ? numeric + '|' : delta}`,
    onPointerMove(e) {
      delta = Math.round((e.clientX - x0) / ppf);
      apply();
    },
    onPointerDown: (e) => (e.button === 0 ? 'FINISHED' : e.button === 2 ? 'CANCELLED' : undefined),
    onKey(e) {
      if (e.key === 'Escape') return 'CANCELLED';
      if (e.key === 'Enter') return 'FINISHED';
      if (e.type !== 'keydown') return true;
      if (/^[0-9]$/.test(e.key) || (e.key === '-' && !numeric)) numeric += e.key;
      else if (e.key === 'Backspace') numeric = numeric.slice(0, -1);
      apply();
      return true;
    },
    cancel() {
      sel.forEach((m, i) => (m.frame = orig[i]));
      onCancel?.();
    },
  });
  return true;
}

registerOperators([
  {
    idname: 'marker.duplicate',
    label: 'Duplicate Marker',
    description: 'Duplicate selected time marker(s)',
    poll: () => selectedMarkers().length > 0,
    invoke: () => {
      const s = app.doc.scene;
      const sel = selectedMarkers();
      sel.forEach((m) => (m.select = false));
      const copies = sel.map((m) => ({ ...m, select: true }));
      s.timeline_markers.push(...copies);
      startMarkerMove('Duplicate Marker', () => {
        s.timeline_markers = s.timeline_markers.filter((m) => !copies.includes(m));
        sel.forEach((m) => (m.select = true));
      });
      return 'RUNNING_MODAL';
    },
    exec: () => {
      const s = app.doc.scene;
      const sel = selectedMarkers();
      sel.forEach((m) => (m.select = false));
      s.timeline_markers.push(...sel.map((m) => ({ ...m, select: true })));
    },
  },
  {
    idname: 'marker.rename',
    label: 'Rename Marker',
    description: 'Rename first selected time marker',
    poll: () => selectedMarkers().length > 0,
    undo: false,
    invoke: () => {
      const m = selectedMarkers()[0];
      promptText('Rename Marker', m.name, (v) => {
        m.name = v;
        app.pushUndo('Rename Marker');
        app.changed('doc');
      });
      return 'CANCELLED';
    },
  },
  {
    idname: 'marker.move',
    label: 'Move Time Marker',
    description: 'Move selected time marker(s)',
    props: [{ id: 'frames', label: 'Frames', type: 'int', default: 0 }],
    poll: () => selectedMarkers().length > 0,
    invoke: () => (startMarkerMove('Move Marker') ? 'RUNNING_MODAL' : 'CANCELLED'),
    exec: (_ctx, p) => {
      for (const m of selectedMarkers()) m.frame += p.frames as number;
    },
  },
  {
    idname: 'screen.marker_jump',
    label: 'Jump to Marker',
    description: 'Jump to previous/next marker',
    props: [{ id: 'next', label: 'Next Marker', type: 'bool', default: true }],
    undo: false,
    exec: (ctx, p) => {
      const f = ctx.doc.scene.frame_current;
      const frames = ctx.doc.scene.timeline_markers.map((m) => m.frame).sort((a, b) => a - b);
      const t = p.next ? frames.find((x) => x > f) : [...frames].reverse().find((x) => x < f);
      if (t === undefined) {
        app.report('INFO', 'No more markers to jump to in this direction');
        return 'CANCELLED';
      }
      app.setFrame(t);
    },
  },
]);
