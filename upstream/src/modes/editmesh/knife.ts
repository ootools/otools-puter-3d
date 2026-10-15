// Knife tool: draw a polyline over the mesh (snapping to vertices and edges); on confirm,
// every visible face crossed by a segment is split along the cut plane of that segment.
import { Matrix4, Vector3 } from 'three';
import { app, registerOperators } from '../../app/app';
import { activeView3D, type View3D } from '../../editors/view3d/view3d';
import { editModeHooks } from '../../editors/view3d/hooks';
import { h } from '../../ui/h';
import { editMeshObjects } from './context';
import { MeshEdit, edgeKey, type EFace } from './meshedit';
import { pickContext, nearestVertex, nearestEdge, raycastFace, type PickContext } from './pick';
import { editPoll } from './ops-basic';
import { addKeys } from '../../app/keymap';
import type { ObjectData, MeshData } from '../../data/types';
import { activeTools } from '../../app/prefs';

interface KPoint {
  world: Vector3;
  screen: { x: number; y: number };
}

let state: { v: View3D; points: KPoint[]; cursor: KPoint | null; cuts: KPoint[][] } | null = null;

editModeHooks.svg.push((v) => {
  if (!state || state.v !== v) return null;
  const all = [...state.cuts, state.points];
  const parts = all.map((pts, i) => {
    const line = [...pts, ...(i === all.length - 1 && state!.cursor ? [state!.cursor] : [])];
    return h(
      'g',
      { key: i },
      h('path', { d: line.map((p, k) => `${k ? 'L' : 'M'}${p.screen.x.toFixed(1)} ${p.screen.y.toFixed(1)}`).join(''), fill: 'none', stroke: '#00ff7f', 'stroke-width': 1.6 }),
      pts.map((p, k) => h('circle', { key: k, cx: p.screen.x, cy: p.screen.y, r: 3.5, fill: '#00ff7f' })),
    );
  });
  if (state.cursor) parts.push(h('circle', { cx: state.cursor.screen.x, cy: state.cursor.screen.y, r: 4, fill: 'none', stroke: '#fff', 'stroke-width': 1.5 }));
  return h('g', { class: 'knife' }, parts);
});

function snap(v: View3D, x: number, y: number): KPoint | null {
  for (const { ob, me } of editMeshObjects()) {
    const c = pickContext(v, ob, me);
    const world = c.world;
    const vt = nearestVertex(c, x, y, 10);
    if (vt) {
      const p = new Vector3(me.positions[vt.index * 3], me.positions[vt.index * 3 + 1], me.positions[vt.index * 3 + 2]).applyMatrix4(world);
      return { world: p, screen: v.project(p) };
    }
    const e = nearestEdge(c, x, y, 8);
    if (e) {
      const a = new Vector3(me.positions[e.a * 3], me.positions[e.a * 3 + 1], me.positions[e.a * 3 + 2]).applyMatrix4(world);
      const b = new Vector3(me.positions[e.b * 3], me.positions[e.b * 3 + 1], me.positions[e.b * 3 + 2]).applyMatrix4(world);
      const sa = v.project(a),
        sb = v.project(b);
      const dx = sb.x - sa.x,
        dy = sb.y - sa.y;
      const t = Math.max(0, Math.min(1, ((x - sa.x) * dx + (y - sa.y) * dy) / (dx * dx + dy * dy || 1)));
      const p = a.lerp(b, t);
      return { world: p, screen: v.project(p) };
    }
    const hit = raycastFace(c, x, y);
    if (hit) {
      const p = hit.point.clone().applyMatrix4(world);
      return { world: p, screen: v.project(p) };
    }
  }
  return null;
}

/** Cut faces of one mesh with a segment A→B (world space) seen from the view. */
export function knifeCut(m: MeshEdit, c: PickContext | null, A: Vector3, B: Vector3, view: Vector3, worldToLocal: Matrix4, project: (p: Vector3) => { x: number; y: number }, visible: (f: number, p: Vector3) => boolean) {
  const a = A.clone().applyMatrix4(worldToLocal),
    b = B.clone().applyMatrix4(worldToLocal);
  const vd = view.clone().transformDirection(worldToLocal);
  const n = b.clone().sub(a).cross(vd).normalize();
  if (n.lengthSq() < 1e-12) return;
  const sa = project(A),
    sb = project(B);
  const dir = { x: sb.x - sa.x, y: sb.y - sa.y };
  const len2 = dir.x * dir.x + dir.y * dir.y || 1;
  const param = (p: Vector3) => {
    const s = project(p.clone().applyMatrix4(worldToLocal.clone().invert()));
    return ((s.x - sa.x) * dir.x + (s.y - sa.y) * dir.y) / len2;
  };
  const side = (v: number) => new Vector3(...m.p(v)).sub(a).dot(n);
  const newV = new Map<string, number>();
  const cutVert = (u: number, w: number) => {
    const k = edgeKey(u, w);
    let id = newV.get(k);
    if (id === undefined) {
      const su = side(u),
        sw = side(w);
      const t = su / (su - sw);
      const p = new Vector3(...m.p(u)).lerp(new Vector3(...m.p(w)), t);
      id = m.addVert([p.x, p.y, p.z], [[u, 1 - t], [w, t]], 1);
      newV.set(k, id);
    }
    return id;
  };
  const eps = 1e-6;
  const splitFaces = new Map<number, [number, number]>(); // face -> corner indices of crossing edges
  m.faces.forEach((f, fi) => {
    const s = f.verts.map(side);
    const crossings: number[] = [];
    for (let i = 0; i < f.verts.length; i++) {
      const j = (i + 1) % f.verts.length;
      if ((s[i] > eps && s[j] < -eps) || (s[i] < -eps && s[j] > eps)) crossings.push(i);
    }
    if (crossings.length !== 2) return;
    // intersection points must lie within the drawn segment
    const pts = crossings.map((i) => {
      const u = f.verts[i],
        w = f.verts[(i + 1) % f.verts.length];
      const t = s[i] / (s[i] - s[(i + 1) % f.verts.length]);
      return new Vector3(...m.p(u)).lerp(new Vector3(...m.p(w)), t);
    });
    const t0 = param(pts[0]),
      t1 = param(pts[1]);
    if (Math.min(t0, t1) < -0.02 || Math.max(t0, t1) > 1.02) return;
    const mid = pts[0].clone().lerp(pts[1], 0.5);
    if (!visible(fi, mid)) return;
    splitFaces.set(fi, [crossings[0], crossings[1]]);
  });
  if (!splitFaces.size) return;
  const out: EFace[] = [];
  m.faces.forEach((f, fi) => {
    const sp = splitFaces.get(fi);
    const n0 = f.verts.length;
    // insert cut vertices on crossing edges (for split faces) or on edges that were cut by neighbours
    const verts: number[] = [],
      uvs: number[] = [],
      isCut: boolean[] = [];
    for (let i = 0; i < n0; i++) {
      const u = f.verts[i],
        w = f.verts[(i + 1) % n0];
      verts.push(u);
      uvs.push(f.uvs[i * 2], f.uvs[i * 2 + 1]);
      isCut.push(false);
      const k = edgeKey(u, w);
      const crossingHere = sp && (sp[0] === i || sp[1] === i);
      if (crossingHere || (newV.has(k) && !sp)) {
        const id = crossingHere ? cutVert(u, w) : newV.get(k)!;
        const su = side(u),
          sw = side(w);
        const t = Math.max(0, Math.min(1, su / (su - sw || 1)));
        const j = (i + 1) % n0;
        verts.push(id);
        uvs.push(f.uvs[i * 2] + (f.uvs[j * 2] - f.uvs[i * 2]) * t, f.uvs[i * 2 + 1] + (f.uvs[j * 2 + 1] - f.uvs[i * 2 + 1]) * t);
        isCut.push(!!crossingHere);
      }
    }
    if (!sp) {
      out.push(verts.length === n0 ? f : m.makeFace(verts, f, uvs));
      return;
    }
    const idx = isCut.map((c2, i) => (c2 ? i : -1)).filter((i) => i >= 0);
    if (idx.length !== 2) return out.push(m.makeFace(verts, f, uvs));
    const [p, q] = idx;
    const part = (from: number, to: number) => {
      const vv: number[] = [],
        uu: number[] = [];
      for (let k = from; ; k = (k + 1) % verts.length) {
        vv.push(verts[k]);
        uu.push(uvs[k * 2], uvs[k * 2 + 1]);
        if (k === to) break;
      }
      return m.makeFace(vv, f, uu);
    };
    out.push(part(p, q), part(q, p));
  });
  // neighbour faces that share a cut edge but were processed before the vertex existed
  m.faces = out.map((f) => {
    const n0 = f.verts.length;
    for (let i = 0; i < n0; i++) {
      const k = edgeKey(f.verts[i], f.verts[(i + 1) % n0]);
      if (newV.has(k) && !f.verts.includes(newV.get(k)!)) {
        const id = newV.get(k)!;
        const verts = [...f.verts.slice(0, i + 1), id, ...f.verts.slice(i + 1)];
        const uv = [f.uvs[i * 2], f.uvs[i * 2 + 1]];
        const uvs = [...f.uvs.slice(0, (i + 1) * 2), ...uv, ...f.uvs.slice((i + 1) * 2)];
        return m.makeFace(verts, f, uvs);
      }
    }
    return f;
  });
  void c;
}

function confirm() {
  if (!state) return;
  const v = state.v;
  const cuts = [...state.cuts, state.points].filter((c) => c.length >= 2);
  for (const { ob, me } of editMeshObjects()) cutObject(v, ob, me, cuts);
  app.changed('geometry');
}

function cutObject(v: View3D, ob: ObjectData, me: MeshData, cuts: KPoint[][]) {
  const m = MeshEdit.from(me);
  const world = app.graph.get(ob.id)?.world ?? new Matrix4();
  const inv = world.clone().invert();
  const before = m.faces.length;
  m.sel = m.sel.map(() => 0);
  for (const pts of cuts)
    for (let i = 0; i < pts.length - 1; i++) {
      const A = pts[i].world,
        B = pts[i + 1].world;
      const mid = A.clone().lerp(B, 0.5);
      const viewDir = v.nav.ortho && !v.sceneCamera ? new Vector3(0, 0, -1).applyQuaternion(v.camera.quaternion) : mid.clone().sub(v.camera.position).normalize();
      // visibility is tested against the mesh as it was before cutting
      const c = pickContext(v, ob, me);
      knifeCut(
        m,
        c,
        A,
        B,
        viewDir,
        inv,
        (p) => v.project(p.clone().applyMatrix4(world)),
        (_f, pLocal) => {
          if (c.xray) return true;
          const s = v.project(pLocal.clone().applyMatrix4(world));
          const hit = raycastFace(c, s.x, s.y);
          if (!hit) return false;
          return hit.point.distanceTo(pLocal) < Math.max(1e-3, pLocal.length() * 1e-3) * 50;
        },
      );
    }
  if (m.faces.length !== before) m.write(me);
}

function start(): 'RUNNING_MODAL' | 'CANCELLED' {
  const v = activeView3D();
  if (!v) return 'CANCELLED';
  state = { v, points: [], cursor: null, cuts: [] };
  const local = (e: { clientX: number; clientY: number }) => {
    const r = v.el.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  app.startModal({
    label: 'Knife',
    header: () => 'Knife: LMB add cut point, RMB/E start new cut, Enter/Space confirm, Esc cancel',
    status: () => [['LMB', 'Cut Point'], ['E', 'New Cut'], ['Enter', 'Confirm'], ['Esc', 'Cancel']],
    onPointerMove(e) {
      if (!state) return;
      const p = local(e);
      state.cursor = snap(v, p.x, p.y) ?? { world: v.unproject(p.x, p.y, state.points[state.points.length - 1]?.world ?? new Vector3(...app.doc.scene.cursor.location)), screen: p };
      v.drawSvg();
    },
    onPointerDown(e) {
      if (!state) return 'CANCELLED';
      if (e.button === 2) {
        if (state.points.length >= 2) state.cuts.push(state.points);
        state.points = [];
        v.drawSvg();
        return;
      }
      if (e.button !== 0) return;
      const p = local(e);
      const k = snap(v, p.x, p.y);
      if (k) state.points.push(k);
      v.drawSvg();
      if (e.detail >= 2) {
        confirm();
        return 'FINISHED';
      }
      return undefined;
    },
    onKey(e) {
      if (e.type !== 'keydown') return true;
      if (e.key === 'Escape') return 'CANCELLED';
      if (e.key === 'Enter' || e.key === ' ') {
        confirm();
        return 'FINISHED';
      }
      if ((e.key === 'e' || e.key === 'E') && state) {
        if (state.points.length >= 2) state.cuts.push(state.points);
        state.points = [];
        v.drawSvg();
      }
      return true;
    },
    cancel() {
      state = null;
      v.drawSvg();
    },
    finish() {
      state = null;
      v.drawSvg();
    },
  });
  return 'RUNNING_MODAL';
}

registerOperators([{ idname: 'mesh.knife_tool', label: 'Knife Topology Tool', description: 'Cut new topology', poll: editPoll, invoke: () => start() }]);
addKeys('Mesh', [{ key: 'K', op: 'mesh.knife_tool', when: () => app.doc.mode === 'EDIT' }]);

// Toolbar tool: LMB in the viewport starts the knife with the clicked point
editModeHooks.pointer.unshift((v, e) => {
  if (app.doc.mode !== 'EDIT' || activeTools.EDIT !== 'builtin.knife') return false;
  if (app.run('mesh.knife_tool') !== 'RUNNING_MODAL' || !state) return false;
  const r = v.el.getBoundingClientRect();
  const k = snap(v, e.clientX - r.left, e.clientY - r.top);
  if (k) state.points.push(k);
  v.drawSvg();
  return true;
});
