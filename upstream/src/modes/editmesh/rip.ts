// Rip (V / Alt+V): disconnect faces along the selected edges (or at a selected vertex) so the side
// nearest the mouse can be moved away, leaving a hole.
import { Matrix4, Vector3 } from 'three';
import { app, registerOperators } from '../../app/app';
import { addKeys } from '../../app/keymap';
import { startTransform } from '../../ops/transform';
import { activeView3D } from '../../editors/view3d/view3d';
import { MeshEdit, edgeKey } from './meshedit';
import { withEdit, inMeshEdit, worldMatrix } from './context';
import { extrudeRegion } from './ops-topology';

/**
 * Rip the selection. `side(faceIndex)` scores faces (lower = closer to the mouse); per selected
 * vertex, the fan group with the best score receives a new copy of the vertex.
 * Returns the number of new vertices.
 */
export function ripSelection(m: MeshEdit, score: (f: number) => number): number {
  const selEdges = new Set(m.selectedEdges().map(([a, b]) => edgeKey(a, b)));
  const facesOf = new Map<number, number[]>();
  m.faces.forEach((f, fi) => {
    for (const v of f.verts) if (m.sel[v] && !m.hide[v]) (facesOf.get(v) ?? facesOf.set(v, []).get(v)!).push(fi);
  });
  const remapPerFace = new Map<number, Map<number, number>>(); // face → (old vertex → new vertex)
  let created = 0;
  const newSel: number[] = [];
  for (const [v, fs] of facesOf) {
    if (fs.length < 2) continue;
    // group the fan: faces sharing an edge through v that is NOT a selected (rip) edge stay together
    const parent = new Map(fs.map((f) => [f, f]));
    const find = (f: number): number => {
      while (parent.get(f) !== f) f = parent.get(f)!;
      return f;
    };
    const edgesAt = (fi: number) => {
      const vs = m.faces[fi].verts,
        n = vs.length,
        i = vs.indexOf(v);
      return [vs[(i + n - 1) % n], vs[(i + 1) % n]];
    };
    for (let i = 0; i < fs.length; i++)
      for (let j = i + 1; j < fs.length; j++) {
        const shared = edgesAt(fs[i]).filter((o) => edgesAt(fs[j]).includes(o));
        for (const o of shared) if (!selEdges.has(edgeKey(v, o))) parent.set(find(fs[i]), find(fs[j]));
      }
    const groups = new Map<number, number[]>();
    for (const f of fs) (groups.get(find(f)) ?? groups.set(find(f), []).get(find(f))!).push(f);
    let ripped: number[];
    if (groups.size >= 2) {
      // the group nearest the mouse moves
      let best: number[] = [],
        bs = Infinity;
      for (const g of groups.values()) {
        const s = Math.min(...g.map(score));
        if (s < bs) {
          bs = s;
          best = g;
        }
      }
      ripped = best;
    } else {
      // a lone vertex: rip the single face nearest the mouse out of the fan
      ripped = [fs.reduce((a, b) => (score(a) <= score(b) ? a : b))];
    }
    const nv = m.addVert(m.p(v), [[v, 1]], 1);
    created++;
    newSel.push(nv);
    for (const f of ripped) (remapPerFace.get(f) ?? remapPerFace.set(f, new Map()).get(f)!).set(v, nv);
  }
  if (!created) return 0;
  for (const [f, map] of remapPerFace) m.faces[f].verts = m.faces[f].verts.map((x) => map.get(x) ?? x);
  // the moved side becomes the selection
  m.sel = m.sel.map(() => 0);
  for (const v of newSel) m.sel[v] = 1;
  return created;
}

registerOperators([
  {
    idname: 'mesh.rip_move',
    label: 'Rip',
    description: 'Disconnect vertex or edges from connected geometry and move them',
    poll: inMeshEdit,
    invoke: (ctx) => {
      const v = activeView3D();
      if (!v) return 'CANCELLED';
      const r = v.el.getBoundingClientRect();
      const mx = (ctx.event?.x ?? app.pointer.x) - r.left,
        my = (ctx.event?.y ?? app.pointer.y) - r.top;
      let total = 0;
      withEdit((m, ob) => {
        const w: Matrix4 = worldMatrix(ob);
        const centre = (fi: number) => {
          const c = new Vector3();
          for (const vi of m.faces[fi].verts) c.add(new Vector3(...m.p(vi)));
          c.multiplyScalar(1 / m.faces[fi].verts.length).applyMatrix4(w);
          const s = v.project(c);
          return Math.hypot(s.x - mx, s.y - my);
        };
        const n = ripSelection(m, centre);
        total += n;
        return n > 0;
      });
      if (!total) {
        app.report('WARNING', 'Cannot rip selected faces or vertices without connected geometry');
        return 'CANCELLED';
      }
      app.flush();
      return startTransform('TRANSLATION', { event: ctx.event, label: 'Rip' }) ? 'RUNNING_MODAL' : 'CANCELLED';
    },
  },
]);

registerOperators([
  {
    idname: 'mesh.dupli_extrude_cursor',
    label: 'Extrude to Cursor or Add',
    description: 'Duplicate and extrude the selection to the mouse position, or add a vertex there',
    poll: inMeshEdit,
    invoke: (ctx) => {
      const v = activeView3D();
      if (!v) return 'CANCELLED';
      const r = v.el.getBoundingClientRect();
      const mx = (ctx.event?.x ?? app.pointer.x) - r.left,
        my = (ctx.event?.y ?? app.pointer.y) - r.top;
      let done = false;
      withEdit((m, ob) => {
        const w = worldMatrix(ob),
          inv = w.clone().invert();
        const sel = m.sel.map((s, i) => (s && !m.hide[i] ? i : -1)).filter((i) => i >= 0);
        if (!sel.length) {
          // nothing selected: add a single vertex under the mouse at the 3D cursor depth
          const p = v.unproject(mx, my, new Vector3(...(ctx.doc.scene.cursor.location as [number, number, number]))).applyMatrix4(inv);
          m.sel = m.sel.map(() => 0);
          m.addVert([p.x, p.y, p.z], [], 1);
          done = true;
          return true;
        }
        const centre = new Vector3();
        for (const i of sel) centre.add(new Vector3(...m.p(i)));
        centre.multiplyScalar(1 / sel.length).applyMatrix4(w);
        const target = v.unproject(mx, my, centre);
        if (!extrudeRegion(m)) return false;
        const d = target.sub(centre).applyMatrix4(new Matrix4().copy(inv).setPosition(0, 0, 0));
        for (let i = 0; i < m.vcount; i++) if (m.sel[i]) m.setP(i, [m.p(i)[0] + d.x, m.p(i)[1] + d.y, m.p(i)[2] + d.z]);
        done = true;
        return true;
      });
      return done ? 'FINISHED' : 'CANCELLED';
    },
  },
]);

addKeys('Mesh', [
  { key: 'V', op: 'mesh.rip_move', when: inMeshEdit },
  { key: 'V', alt: true, op: 'mesh.rip_move', when: inMeshEdit },
]);
