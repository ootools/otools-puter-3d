// Object motion paths: sample the evaluated world position over a frame range and draw the path
// in the 3D viewport (Object properties ▸ Motion Paths; Object ▸ Motion Paths menu operators).
import { Vector3 } from 'three';
import { app, registerOperators } from '../app/app';
import type { ObjectData } from '../data/types';
import { objectExtraPanels } from '../editors/properties/tabs';
import { editModeHooks } from '../editors/view3d/hooks';
import { h, type VNode } from '../ui/h';
import { panel, opButton } from '../ui/widgets';
import { num, bool, enumProp } from '../ui/props';
import { keyframeFrames } from './keyframes';

export interface MotionPathSettings {
  type: 'RANGE' | 'CURRENT_FRAME';
  frame_start: number;
  frame_end: number;
  frame_before: number;
  frame_after: number;
  frame_step: number;
  show_frame_numbers: boolean;
  show_keyframe_highlight: boolean;
}

export interface MotionPath {
  frame_start: number;
  points: number[]; // world xyz per frame
  step: number;
}

type ObMP = ObjectData & { animation_visualization?: MotionPathSettings; motion_path?: MotionPath | null };

function settings(o: ObMP): MotionPathSettings {
  return (o.animation_visualization ??= {
    type: 'RANGE',
    frame_start: app.doc.scene.frame_start,
    frame_end: app.doc.scene.frame_end,
    frame_before: 10,
    frame_after: 10,
    frame_step: 1,
    show_frame_numbers: false,
    show_keyframe_highlight: true,
  });
}

function rangeOf(o: ObMP): [number, number] {
  const st = settings(o);
  if (st.type === 'CURRENT_FRAME') {
    const f = app.doc.scene.frame_current;
    return [f - st.frame_before, f + st.frame_after];
  }
  return [st.frame_start, Math.max(st.frame_start, st.frame_end)];
}

/** Sample motion paths for several objects in one pass over the frames. */
function calculate(objects: ObMP[]) {
  if (!objects.length) return;
  const saved = app.doc.scene.frame_current;
  const ranges = objects.map((o) => rangeOf(o));
  const lo = Math.min(...ranges.map((r) => r[0])),
    hi = Math.max(...ranges.map((r) => r[1]));
  const paths = objects.map((o, i) => ({ frame_start: ranges[i][0], points: [] as number[], step: Math.max(1, settings(o).frame_step) }));
  const p = new Vector3();
  for (let f = lo; f <= hi; f++) {
    app.setFrame(f);
    app.flush();
    objects.forEach((o, i) => {
      const [a, b] = ranges[i];
      if (f < a || f > b || (f - a) % paths[i].step) return;
      const ev = app.graph.get(o.id);
      if (!ev) return;
      p.setFromMatrixPosition(ev.world);
      paths[i].points.push(p.x, p.y, p.z);
    });
  }
  app.setFrame(saved);
  objects.forEach((o, i) => (o.motion_path = paths[i]));
}

registerOperators([
  {
    idname: 'object.paths_calculate',
    label: 'Calculate Object Motion Paths',
    description: 'Generate motion paths for the selected objects',
    poll: (ctx) => ctx.doc.mode === 'OBJECT' && app.selectedObjects().length > 0,
    exec: () => calculate(app.selectedObjects() as ObMP[]),
  },
  {
    idname: 'object.paths_update',
    label: 'Update Object Paths',
    description: 'Recalculate motion paths for the selected objects that have them',
    poll: () => app.selectedObjects().some((o) => (o as ObMP).motion_path),
    exec: () => calculate(app.selectedObjects().filter((o) => (o as ObMP).motion_path) as ObMP[]),
  },
  {
    idname: 'object.paths_clear',
    label: 'Clear Object Paths',
    description: 'Remove motion paths of the selected objects (or all objects)',
    props: [{ id: 'only_selected', label: 'Only Selected', type: 'bool', default: true }],
    poll: () => Object.values(app.doc.objects).some((o) => (o as ObMP).motion_path),
    exec: (ctx, p) => {
      for (const o of Object.values(ctx.doc.objects) as ObMP[]) if (!p.only_selected || o.select) o.motion_path = null;
    },
  },
]);

objectExtraPanels.push((o) => {
  const ob = o as ObMP;
  const st = settings(ob);
  return panel(
    'ob-motionpaths',
    'Motion Paths',
    () => [
      enumProp(st, 'type', 'Type', [
        ['CURRENT_FRAME', 'Around Frame'],
        ['RANGE', 'In Range'],
      ]),
      st.type === 'RANGE' ? [num(st, 'frame_start', 'Frame Range Start', { int: true }), num(st, 'frame_end', 'End', { int: true })] : [num(st, 'frame_before', 'Frame Range Before', { int: true, min: 0 }), num(st, 'frame_after', 'After', { int: true, min: 0 })],
      num(st, 'frame_step', 'Step', { int: true, min: 1, max: 100 }),
      ob.motion_path
        ? h('div', { class: 'prop-buttons' }, opButton('object.paths_update', 'Update Paths', {}, { icon: 'file_refresh' }), opButton('object.paths_clear', '', { only_selected: true }, { icon: 'x', tip: 'Clear Paths' }))
        : h('div', { class: 'prop-buttons' }, opButton('object.paths_calculate', 'Calculate…', {}, { icon: 'curve_data' })),
      bool(st, 'show_frame_numbers', 'Frame Numbers'),
      bool(st, 'show_keyframe_highlight', 'Keyframes'),
    ],
    { closed: true },
  );
});

// viewport drawing
editModeHooks.svg.push((v) => {
  if (!v.overlay.show_overlays || v.overlay.show_motion_paths === false) return null;
  const parts: VNode[] = [];
  const cur = app.doc.scene.frame_current;
  for (const o of Object.values(app.doc.objects) as ObMP[]) {
    const mp = o.motion_path;
    if (!mp || !app.isVisible(o.id)) continue;
    const st = settings(o);
    const keys = st.show_keyframe_highlight ? keyframeFrames(app.doc, [o]) : null;
    const pts: { x: number; y: number; f: number }[] = [];
    for (let i = 0; i < mp.points.length / 3; i++) {
      const s = v.project(new Vector3(mp.points[i * 3], mp.points[i * 3 + 1], mp.points[i * 3 + 2]));
      if (s.z > 1) continue;
      pts.push({ x: s.x, y: s.y, f: mp.frame_start + i * mp.step });
    }
    if (pts.length < 2) continue;
    // path line: frames before the current frame are drawn darker than those after it
    for (let i = 0; i + 1 < pts.length; i++) {
      const after = pts[i].f >= cur;
      parts.push(h('line', { x1: pts[i].x, y1: pts[i].y, x2: pts[i + 1].x, y2: pts[i + 1].y, stroke: after ? '#7fb3ff' : '#4b6aa0', 'stroke-width': 2 }));
    }
    for (const p of pts) {
      const isKey = keys?.has(p.f);
      const isCur = p.f === cur;
      parts.push(h('circle', { cx: p.x, cy: p.y, r: isCur ? 4 : isKey ? 3.5 : 1.8, fill: isCur ? '#ffffff' : isKey ? '#ffbe33' : '#000000' }));
      if (st.show_frame_numbers) parts.push(h('text', { x: p.x + 5, y: p.y - 4, fill: '#ccc', 'font-size': 10 }, String(p.f)));
    }
  }
  return parts.length ? h('g', { class: 'motion-paths' }, parts) : null;
});
