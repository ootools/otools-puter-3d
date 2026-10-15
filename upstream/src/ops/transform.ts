// Modal transform operator (grab / rotate / scale and variants).
import { Matrix4, Vector3, Quaternion, Matrix3, Euler } from 'three';
import { parseExpression, evalExpression } from '../anim/drivers';
import { uiState } from '../app/prefs';
import { app, registerOperators, type ModalHandler } from '../app/app';
import { activeView3D, type View3D } from '../editors/view3d/view3d';
import type { ObjectData } from '../data/types';
import { applyMatrixToObject, toMatrix4, localMatrix } from '../eval/transform';
import { insertKeyframesForObjects } from '../anim/keyframes';
import { renderContext } from '../render/context';
import { findSnapTarget, snapIndicator, type SnapElement } from './snap';

export type TransformMode = 'TRANSLATION' | 'ROTATION' | 'RESIZE' | 'TRACKBALL' | 'SHRINKFATTEN' | 'TOSPHERE' | 'SHEAR' | 'PUSHPULL' | 'EDGESLIDE' | 'BEND';

/** An item being transformed. All math happens in world space. */
export interface TElement {
  /** world-space position used for pivot computations */
  center: Vector3;
  /** orientation basis for local constraints (world space, columns = axes) */
  basis: Matrix3;
  /** proportional influence 0..1 (1 = selected) */
  weight: number;
  /** distance to selection for proportional editing (world units) */
  distance?: number;
  /** apply a world-space matrix relative to the initial state (pivot already baked) */
  apply(m: Matrix4, ctx: { mode: TransformMode; value: number[] }): void;
  restore(): void;
  /** normal for shrink/fatten (world) */
  normal?: Vector3;
}

export interface TProvider {
  /** collect elements for the current mode; return null if not applicable */
  collect(opts: { proportional: boolean; connected: boolean; individual: boolean }): { elements: TElement[]; active?: Vector3; label: string; finish(): void; cancel(): void; onUpdate?(): void } | null;
}

export const transformProviders: TProvider[] = [];

// ---------------------------------------------------------------------------
// Objects provider

function objectWorld(ob: ObjectData) {
  return app.graph.get(ob.id)?.world.clone() ?? new Matrix4();
}

function hasSelectedAncestor(ob: ObjectData, set: Set<string>) {
  let p = ob.parent;
  while (p) {
    if (set.has(p)) return true;
    p = app.doc.objects[p]?.parent ?? null;
  }
  return false;
}

const objectProvider: TProvider = {
  collect() {
    if (app.doc.mode !== 'OBJECT') return null;
    const sel = app.selectedObjects().filter((o) => app.isSelectable(o.id) || o.select);
    if (!sel.length) return null;
    const ids = new Set(sel.map((o) => o.id));
    const roots = sel.filter((o) => !hasSelectedAncestor(o, ids));
    const elements: TElement[] = roots.map((ob) => {
      const w0 = objectWorld(ob);
      const before = { location: [...ob.location], rotation_euler: [...ob.rotation_euler], rotation_quaternion: [...ob.rotation_quaternion], rotation_axis_angle: [...ob.rotation_axis_angle], scale: [...ob.scale] };
      const p = new Vector3(),
        q = new Quaternion(),
        s = new Vector3();
      w0.decompose(p, q, s);
      const basis = new Matrix3().setFromMatrix4(new Matrix4().makeRotationFromQuaternion(q));
      // parent space (world → local) computed once
      const parentEv = ob.parent ? app.graph.get(ob.parent) : undefined;
      const parentMat = parentEv ? parentEv.world.clone().multiply(toMatrix4(ob.matrix_parent_inverse)) : new Matrix4();
      const parentInv = parentMat.clone().invert();
      // constraints offset: compare evaluated world with world basis (pre-constraint)
      const basisWorld = app.graph.get(ob.id)?.worldBasis.clone() ?? w0.clone();
      const constraintFix = basisWorld.clone().multiply(w0.clone().invert());
      const ts = app.doc.scene.tool_settings;
      // Affect Only Origins: the object data is counter-transformed so the geometry stays in place
      const originOnly = !!ts.use_transform_data_origin && dataUsers(ob) === 1 ? originCompensator(ob) : null;
      // Affect Only Parents: direct children keep their world transform
      const children = ts.use_transform_skip_children
        ? Object.values(app.doc.objects)
            .filter((c) => c.parent === ob.id && !ids.has(c.id))
            .map((c) => ({ c, world: objectWorld(c), mpi: toMatrix4(c.matrix_parent_inverse), before: { location: [...c.location], rotation_euler: [...c.rotation_euler], rotation_quaternion: [...c.rotation_quaternion], rotation_axis_angle: [...c.rotation_axis_angle], scale: [...c.scale] } }))
        : [];
      return {
        center: p,
        basis,
        weight: 1,
        apply(m: Matrix4) {
          const target = m.clone().multiply(w0);
          const unconstrained = constraintFix.clone().multiply(target);
          const local = parentInv.clone().multiply(unconstrained);
          Object.assign(ob, cloneBefore(before));
          applyMatrixToObject(ob, local);
          // respect transform locks
          for (let i = 0; i < 3; i++) {
            if (ob.lock_location[i]) ob.location[i] = before.location[i];
            if (ob.lock_rotation[i]) {
              ob.rotation_euler[i] = before.rotation_euler[i];
              if (ob.rotation_mode === 'QUATERNION') ob.rotation_quaternion[i + 1] = before.rotation_quaternion[i + 1];
            }
            if (ob.lock_scale[i]) ob.scale[i] = before.scale[i];
          }
          originOnly?.apply();
          if (children.length) {
            const newWorld = parentMat.clone().multiply(localMatrix(ob, new Matrix4()));
            for (const ch of children) {
              Object.assign(ch.c, cloneBefore(ch.before));
              applyMatrixToObject(ch.c, newWorld.clone().multiply(ch.mpi).invert().multiply(ch.world));
            }
          }
        },
        restore() {
          Object.assign(ob, cloneBefore(before));
          originOnly?.restore();
          for (const ch of children) Object.assign(ch.c, cloneBefore(ch.before));
        },
      } as TElement;
    });
    const act = app.activeObject;
    return {
      elements,
      active: act && ids.has(act.id) ? new Vector3().setFromMatrixPosition(objectWorld(act)) : undefined,
      label: 'Object',
      finish() {
        if (app.doc.scene.tool_settings.use_keyframe_insert_auto) insertKeyframesForObjects(roots, 'Available');
      },
      cancel() {},
    };
  },
};

/** Number of objects sharing an object's data-block. */
function dataUsers(ob: ObjectData) {
  if (!ob.data) return 0;
  return Object.values(app.doc.objects).filter((o) => o.data === ob.data).length;
}

/** Keeps mesh / curve / lattice geometry fixed in world space while the object's transform changes. */
function originCompensator(ob: ObjectData) {
  const doc = app.doc;
  const L0 = localMatrix(ob, new Matrix4());
  const me = ob.type === 'MESH' && ob.data ? doc.meshes[ob.data] : undefined;
  const cu = (ob.type === 'CURVE' || ob.type === 'FONT') && ob.data ? doc.curves[ob.data] : undefined;
  if (!me && !(cu && ob.type === 'CURVE')) return null;
  const pos0 = me ? me.positions.slice() : null;
  const keys0 = me ? me.shape_keys.map((k) => k.data.slice()) : [];
  const splines0 = cu ? structuredClone(cu.splines) : null;
  const tp = (m: Matrix4, src: ArrayLike<number>, dst: { [i: number]: number }, n: number) => {
    const v = new Vector3();
    for (let i = 0; i < n; i += 3) {
      v.set(src[i], src[i + 1], src[i + 2]).applyMatrix4(m);
      dst[i] = v.x;
      dst[i + 1] = v.y;
      dst[i + 2] = v.z;
    }
  };
  return {
    apply() {
      const comp = localMatrix(ob, new Matrix4()).invert().multiply(L0);
      if (me && pos0) {
        const P = new Float32Array(pos0.length);
        tp(comp, pos0, P, pos0.length);
        me.positions = P;
        me.shape_keys.forEach((k, i) => {
          const d = new Float32Array(keys0[i].length);
          tp(comp, keys0[i], d, d.length);
          k.data = d;
        });
      }
      if (cu && splines0) {
        cu.splines = structuredClone(splines0);
        const v = new Vector3();
        const t3 = (a: number[]) => {
          v.set(a[0], a[1], a[2]).applyMatrix4(comp);
          a[0] = v.x;
          a[1] = v.y;
          a[2] = v.z;
        };
        for (const sp of cu.splines) {
          for (const b of sp.bezier_points) {
            t3(b.co);
            t3(b.handle_left);
            t3(b.handle_right);
          }
          for (const p of sp.points) t3(p.co);
        }
      }
      app.changed('geometry');
    },
    restore() {
      if (me && pos0) {
        me.positions = pos0.slice();
        me.shape_keys.forEach((k, i) => (k.data = keys0[i].slice()));
      }
      if (cu && splines0) cu.splines = structuredClone(splines0);
      app.changed('geometry');
    },
  };
}

function cloneBefore(b: Record<string, number[]>) {
  const o: Record<string, number[]> = {};
  for (const k in b) o[k] = [...b[k]];
  return o as unknown as Partial<ObjectData>;
}

transformProviders.push(objectProvider);

// ---------------------------------------------------------------------------
// Modal

const AXES = [new Vector3(1, 0, 0), new Vector3(0, 1, 0), new Vector3(0, 0, 1)];
const AXIS_NAMES = ['X', 'Y', 'Z'];

interface Constraint {
  axes: boolean[]; // which axes are free
  space: 'GLOBAL' | 'LOCAL' | 'VIEW' | 'NORMAL' | 'CURSOR';
}

export function startTransform(
  mode: TransformMode,
  opts: {
    value?: number[];
    constraint?: boolean[];
    orient?: string;
    release_confirm?: boolean;
    event?: { x: number; y: number };
    /** build the redo operator from the final transform value (Adjust Last Operation) */
    redo?: (value: number[]) => { idname: string; props: Record<string, unknown> } | undefined;
    /** label for the undo step */
    label?: string;
  } = {},
): boolean {
  const v = activeView3D();
  if (!v) return false;
  const ts = app.doc.scene.tool_settings;
  const proportional = app.doc.mode === 'OBJECT' ? ts.use_proportional_edit_objects : ts.use_proportional_edit;
  let data: ReturnType<TProvider['collect']> = null;
  for (let i = transformProviders.length - 1; i >= 0; i--) {
    data = transformProviders[i].collect({ proportional, connected: ts.use_proportional_connected, individual: ts.transform_pivot_point === 'INDIVIDUAL_ORIGINS' });
    if (data) break;
  }
  if (!data || !data.elements.length) return false;
  const d = data;
  const rect = v.el.getBoundingClientRect();
  const start = opts.event ? { x: opts.event.x - rect.left, y: opts.event.y - rect.top } : { x: app.pointer.x - rect.left, y: app.pointer.y - rect.top };
  // pivot
  const sel = d.elements.filter((e) => e.weight >= 1);
  const pivot = new Vector3();
  const pp = ts.transform_pivot_point;
  if (pp === 'CURSOR') pivot.fromArray(app.doc.scene.cursor.location);
  else if (pp === 'ACTIVE_ELEMENT' && d.active) pivot.copy(d.active);
  else if (pp === 'BOUNDING_BOX_CENTER') {
    const min = new Vector3(Infinity, Infinity, Infinity),
      max = new Vector3(-Infinity, -Infinity, -Infinity);
    for (const e of sel) {
      min.min(e.center);
      max.max(e.center);
    }
    pivot.addVectors(min, max).multiplyScalar(0.5);
  } else {
    for (const e of sel) pivot.add(e.center);
    pivot.multiplyScalar(1 / Math.max(1, sel.length));
  }
  // Snap With: Closest uses the bounding-box corners of moved objects (captured before moving)
  const closestSources: Vector3[] = [];
  if (app.doc.mode === 'OBJECT')
    for (const ob of app.selectedObjects()) {
      const ev = app.graph.get(ob.id);
      if (!ev) continue;
      const P = ev.mesh?.positions;
      if (!P || !P.length) {
        closestSources.push(new Vector3().setFromMatrixPosition(ev.world));
        continue;
      }
      const min = [Infinity, Infinity, Infinity],
        max = [-Infinity, -Infinity, -Infinity];
      for (let i = 0; i < P.length; i += 3)
        for (let k = 0; k < 3; k++) {
          min[k] = Math.min(min[k], P[i + k]);
          max[k] = Math.max(max[k], P[i + k]);
        }
      for (const x of [min[0], max[0]]) for (const y of [min[1], max[1]]) for (const z of [min[2], max[2]]) closestSources.push(new Vector3(x, y, z).applyMatrix4(ev.world));
    }
  /** Snap source point (Snap With: closest / center / median / active). */
  const snapSource = (target: Vector3 | null): Vector3 => {
    const st = ts.snap_target;
    if (st === 'ACTIVE' && d.active) return d.active.clone();
    if (st === 'MEDIAN') {
      const c = new Vector3();
      for (const e of sel) c.add(e.center);
      return c.multiplyScalar(1 / Math.max(1, sel.length));
    }
    if (st === 'CLOSEST' && target && closestSources.length) {
      let best = closestSources[0];
      for (const p of closestSources) if (p.distanceTo(target) < best.distanceTo(target)) best = p;
      return best.clone();
    }
    if (st === 'CLOSEST' && target && sel.length) {
      let best = sel[0].center;
      for (const e of sel) if (e.center.distanceTo(target) < best.distanceTo(target)) best = e.center;
      return best.clone();
    }
    const min = new Vector3(Infinity, Infinity, Infinity),
      max = new Vector3(-Infinity, -Infinity, -Infinity);
    for (const e of sel) {
      min.min(e.center);
      max.max(e.center);
    }
    return sel.length ? min.add(max).multiplyScalar(0.5) : pivot.clone();
  };
  const individual = pp === 'INDIVIDUAL_ORIGINS' && (mode === 'ROTATION' || mode === 'RESIZE');
  const pivotScreen = v.project(pivot);
  let curMode = mode;
  let mouse = { ...start };
  let startMouse = { ...start };
  let constraint: Constraint | null = opts.constraint ? { axes: opts.constraint, space: (opts.orient as Constraint['space']) ?? 'GLOBAL' } : null;
  let lastAxisKey = '';
  let numeric = '';
  let numericAxis = 0;
  let numericValues: (string | null)[] = [null, null, null];
  let snap = ts.use_snap;
  let precise = false;
  let value: number[] = [0, 0, 0];
  let propSize = ts.proportional_size;
  let trackball = [0, 0];
  let lastPrecise = { x: start.x, y: start.y };
  let accumPrecise = { x: 0, y: 0 };
  const orientation = (space: Constraint['space']): Matrix3 => {
    if (space === 'LOCAL' || space === 'NORMAL') return d.elements[0]?.basis ?? new Matrix3();
    if (space === 'VIEW') return new Matrix3().setFromMatrix4(new Matrix4().makeRotationFromQuaternion(v.camera.quaternion));
    if (space === 'CURSOR') {
      const r = app.doc.scene.cursor.rotation_euler;
      return new Matrix3().setFromMatrix4(new Matrix4().makeRotationFromEuler(new Euler(r[0], r[1], r[2], 'ZYX')));
    }
    return new Matrix3();
  };
  const defaultOrient = (): Constraint['space'] => {
    const o = uiState.orientation;
    return (o === 'GLOBAL' || o === 'LOCAL' || o === 'VIEW' || o === 'NORMAL' || o === 'CURSOR' ? o : o === 'GIMBAL' || o === 'PARENT' ? 'LOCAL' : 'GLOBAL') as Constraint['space'];
  };
  const axisWorld = (i: number, space: Constraint['space']) => AXES[i].clone().applyMatrix3(orientation(space)).normalize();

  const viewDir = () => new Vector3(0, 0, -1).applyQuaternion(v.camera.quaternion);

  const parseNumeric = (): number[] | null => {
    const vals = numericValues.map((s, i) => (i === numericAxis ? numeric : s));
    if (vals.every((s) => !s)) return null;
    const out = vals.map((s) => {
      if (!s) return 0;
      try {
        const t = s.replace(/^-$/, '-1').replace(/[-+*/]$/, '');
        return evalExpression(parseExpression(t), {});
      } catch {
        return 0;
      }
    });
    return out;
  };

  const compute = () => {
    const num = parseNumeric();
    const dx = mouse.x - startMouse.x,
      dy = mouse.y - startMouse.y;
    let m = new Matrix4();
    const T = (p: Vector3) => new Matrix4().makeTranslation(p.x, p.y, p.z);
    const around = (center: Vector3, mm: Matrix4) => T(center).multiply(mm).multiply(T(center.clone().negate()));
    const free = constraint?.axes ?? [true, true, true];
    const space = constraint?.space ?? 'GLOBAL';
    const nFree = free.filter(Boolean).length;
    if (curMode === 'TRANSLATION') {
      let delta = new Vector3();
      if (num) {
        if (constraint && nFree === 1) {
          const ai = free.indexOf(true);
          delta = axisWorld(ai, space).multiplyScalar(num[numericValues.some((x, i) => x && i !== ai) ? ai : 0] ?? num[0]);
          if (numericValues.every((x, i) => !x || i === numericAxis) && numericAxis === 0) delta = axisWorld(ai, space).multiplyScalar(num[0]);
        } else {
          for (let i = 0; i < 3; i++) if (free[i]) delta.addScaledVector(axisWorld(i, space), num[i]);
        }
      } else {
        const a = v.unproject(startMouse.x, startMouse.y, pivot),
          b = v.unproject(mouse.x, mouse.y, pivot);
        delta = b.sub(a);
        if (constraint) {
          if (nFree === 1) {
            const ai = free.indexOf(true);
            const axis = axisWorld(ai, space);
            // project mouse motion onto the screen-space axis direction
            const s0 = v.project(pivot),
              s1 = v.project(pivot.clone().add(axis));
            const sx = s1.x - s0.x,
              sy = s1.y - s0.y,
              sl = Math.hypot(sx, sy);
            if (sl > 1e-6) {
              const t = (dx * sx + dy * sy) / (sl * sl);
              delta = axis.multiplyScalar(t);
            } else delta.set(0, 0, 0);
          } else if (nFree === 2) {
            const normal = axisWorld(free.indexOf(false), space);
            const ray0 = v.ray(startMouse.x, startMouse.y),
              ray1 = v.ray(mouse.x, mouse.y);
            const hit = (r: { origin: Vector3; dir: Vector3 }) => {
              const den = r.dir.dot(normal);
              if (Math.abs(den) < 1e-6) return null;
              const t = pivot.clone().sub(r.origin).dot(normal) / den;
              return r.origin.clone().addScaledVector(r.dir, t);
            };
            const h0 = hit(ray0),
              h1 = hit(ray1);
            if (h0 && h1) delta = h1.sub(h0);
          }
        }
        if (precise) delta.multiplyScalar(1);
        snapIndicator.point = null;
        if (snap) {
          const els = (ts.snap_elements.length ? ts.snap_elements : ['INCREMENT']) as SnapElement[];
          const basis = orientation(space);
          const inv = basis.clone().invert();
          const keepFree = (vec: Vector3) => {
            if (!constraint) return vec;
            const lv = vec.clone().applyMatrix3(inv);
            if (!free[0]) lv.x = 0;
            if (!free[1]) lv.y = 0;
            if (!free[2]) lv.z = 0;
            return lv.applyMatrix3(basis);
          };
          const target = els.some((e) => e !== 'INCREMENT' && e !== 'GRID') ? findSnapTarget(v, mouse, els) : null;
          if (target) {
            // move the snap source (closest / center / median / active) onto the target
            delta = keepFree(target.point.clone().sub(snapSource(target.point)));
            snapIndicator.point = target.point;
            snapIndicator.kind = target.kind;
          } else if (els.includes('GRID')) {
            // absolute grid snapping of the source point
            const inc = precise ? 0.1 : 1;
            const src = snapSource(null);
            const lp = src.clone().add(delta).applyMatrix3(inv);
            lp.set(Math.round(lp.x / inc) * inc, Math.round(lp.y / inc) * inc, Math.round(lp.z / inc) * inc);
            delta = keepFree(lp.applyMatrix3(basis).sub(src));
          } else if (els.includes('INCREMENT')) {
            const inc = precise ? 0.1 : 1;
            // snap in the constraint orientation
            const lv = delta.clone().applyMatrix3(inv);
            lv.set(Math.round(lv.x / inc) * inc, Math.round(lv.y / inc) * inc, Math.round(lv.z / inc) * inc);
            delta = lv.applyMatrix3(basis);
          }
        }
      }
      value = [delta.x, delta.y, delta.z];
      m = T(delta);
    } else if (curMode === 'ROTATION' || curMode === 'TRACKBALL') {
      if (curMode === 'TRACKBALL') {
        const ax = num ? num[0] : trackball[0] + (dy * Math.PI) / 360;
        const ay = num ? num[1] : trackball[1] + (dx * Math.PI) / 360;
        const right = new Vector3(1, 0, 0).applyQuaternion(v.camera.quaternion),
          up = new Vector3(0, 1, 0).applyQuaternion(v.camera.quaternion);
        const qx = new Quaternion().setFromAxisAngle(right, snap ? Math.round(ax / (Math.PI / 36)) * (Math.PI / 36) : ax);
        const qy = new Quaternion().setFromAxisAngle(up, snap ? Math.round(ay / (Math.PI / 36)) * (Math.PI / 36) : ay);
        value = [ax, ay, 0];
        m = new Matrix4().makeRotationFromQuaternion(qy.multiply(qx));
      } else {
        let axis: Vector3;
        if (constraint && nFree === 1) axis = axisWorld(free.indexOf(true), space);
        else if (constraint && nFree === 2) axis = axisWorld(free.indexOf(false), space);
        else axis = viewDir().negate();
        let angle: number;
        if (num) angle = (num[0] * Math.PI) / 180;
        else {
          angle = -rotTotal;
          // screen rotation direction vs axis direction relative to the viewer
          if (axis.dot(viewDir()) > 0) angle = -angle;
          if (precise) angle *= 0.2;
          if (snap) angle = Math.round(angle / ((precise ? 1 : 5) * (Math.PI / 180))) * ((precise ? 1 : 5) * (Math.PI / 180));
        }
        value = [angle, 0, 0];
        m = new Matrix4().makeRotationAxis(axis, angle);
      }
    } else if (curMode === 'RESIZE') {
      let f: number;
      if (num) f = num[0];
      else {
        const d0 = Math.hypot(startMouse.x - pivotScreen.x, startMouse.y - pivotScreen.y),
          d1 = Math.hypot(mouse.x - pivotScreen.x, mouse.y - pivotScreen.y);
        f = d0 > 1 ? d1 / d0 : 1;
        // flipped when crossing the pivot
        const dot = (startMouse.x - pivotScreen.x) * (mouse.x - pivotScreen.x) + (startMouse.y - pivotScreen.y) * (mouse.y - pivotScreen.y);
        if (dot < 0) f = -f;
        if (precise) f = 1 + (f - 1) * 0.1;
        if (snap) f = Math.round(f / (precise ? 0.01 : 0.1)) * (precise ? 0.01 : 0.1);
      }
      const sv = [1, 1, 1].map((_, i) => (constraint && !free[i] ? 1 : f));
      if (num && constraint) for (let i = 0; i < 3; i++) if (free[i]) sv[i] = num[nFree === 1 ? 0 : i] || f;
      value = sv;
      const basis = new Matrix4().setFromMatrix3(orientation(space));
      m = basis.clone().multiply(new Matrix4().makeScale(sv[0], sv[1], sv[2])).multiply(basis.clone().invert());
    } else if (curMode === 'SHRINKFATTEN' || curMode === 'PUSHPULL' || curMode === 'TOSPHERE') {
      const amount = num ? num[0] : ((mouse.x - startMouse.x) - (mouse.y - startMouse.y)) * v.nav.pixelSize(pivot) * (precise ? 0.1 : 1);
      value = [snap ? Math.round(amount * 10) / 10 : amount, 0, 0];
    }
    // apply
    for (const e of d.elements) {
      if (curMode === 'SHRINKFATTEN') {
        const n = e.normal ?? new Vector3();
        e.apply(T(n.clone().multiplyScalar(value[0] * e.weight)), { mode: curMode, value });
        continue;
      }
      if (curMode === 'PUSHPULL') {
        const dir = pivot.clone().sub(e.center);
        e.apply(T(dir.multiplyScalar(-value[0] * e.weight / Math.max(1e-6, dir.length() || 1))), { mode: curMode, value });
        continue;
      }
      if (curMode === 'TOSPHERE') {
        const f = Math.max(0, Math.min(1, num ? num[0] : (mouse.x - startMouse.x) / 200));
        value = [f, 0, 0];
        const avg = d.elements.reduce((s, x) => s + x.center.distanceTo(pivot), 0) / d.elements.length;
        const dir = e.center.clone().sub(pivot);
        const target = pivot.clone().add(dir.clone().setLength(avg));
        e.apply(T(target.sub(e.center).multiplyScalar(f * e.weight)), { mode: curMode, value });
        continue;
      }
      let mm = m;
      if (e.weight < 1) mm = blendTransform(m, e.weight, curMode);
      const center = individual ? e.center : pivot;
      e.apply(curMode === 'TRANSLATION' ? mm : around(center, mm), { mode: curMode, value });
    }
    d.onUpdate?.();
    app.changed('doc');
    renderContext?.engine.requestDraw();
    v.drawSvg();
  };
  let rotTotal = 0;
  let lastAngle = Math.atan2(start.y - pivotScreen.y, start.x - pivotScreen.x);

  const setConstraint = (axis: number, plane: boolean) => {
    const key = `${axis}${plane}`;
    if (lastAxisKey === key && constraint) {
      if (constraint.space === 'GLOBAL' || constraint.space !== 'LOCAL') {
        constraint = { axes: constraint.axes, space: constraint.space === 'GLOBAL' ? (defaultOrient() === 'GLOBAL' ? 'LOCAL' : 'GLOBAL') : 'LOCAL' };
        if (constraint.space === 'LOCAL' && lastSpaceCycle >= 1) {
          constraint = null;
          lastAxisKey = '';
          lastSpaceCycle = 0;
          return;
        }
        lastSpaceCycle++;
      } else {
        constraint = null;
        lastAxisKey = '';
        lastSpaceCycle = 0;
      }
      return;
    }
    lastAxisKey = key;
    lastSpaceCycle = 0;
    const axes = [0, 1, 2].map((i) => (plane ? i !== axis : i === axis));
    constraint = { axes, space: defaultOrient() };
  };
  let lastSpaceCycle = 0;

  const modeLabel = () => ({ TRANSLATION: 'Move', ROTATION: 'Rotate', RESIZE: 'Resize', TRACKBALL: 'Trackball', SHRINKFATTEN: 'Shrink/Fatten', TOSPHERE: 'To Sphere', SHEAR: 'Shear', PUSHPULL: 'Push/Pull', EDGESLIDE: 'Edge Slide', BEND: 'Bend' })[curMode];

  const fmt = (x: number) => (Math.abs(x) < 1e-6 ? '0' : x.toFixed(4).replace(/\.?0+$/, ''));
  const header = () => {
    const free = constraint?.axes;
    const cname = constraint ? `along ${constraint.space.toLowerCase()} ${free!.map((f, i) => (f ? AXIS_NAMES[i] : '')).join('')}` : '';
    const numTxt = numeric || numericValues.some(Boolean) ? ` [${numericValues.map((s, i) => (i === numericAxis ? numeric + '|' : s ?? '')).join(', ')}]` : '';
    if (curMode === 'TRANSLATION') {
      const len = Math.hypot(value[0], value[1], value[2]);
      return `D: ${fmt(value[0])} m  ${fmt(value[1])} m  ${fmt(value[2])} m (${fmt(len)} m) ${cname}${numTxt}`;
    }
    if (curMode === 'ROTATION') return `Rot: ${fmt((value[0] * 180) / Math.PI)}° ${cname}${numTxt}`;
    if (curMode === 'TRACKBALL') return `Trackball: ${fmt((value[0] * 180) / Math.PI)}° ${fmt((value[1] * 180) / Math.PI)}°${numTxt}`;
    if (curMode === 'RESIZE') return `Scale X: ${fmt(value[0])}  Y: ${fmt(value[1])}  Z: ${fmt(value[2])} ${cname}${numTxt}`;
    return `${modeLabel()}: ${fmt(value[0])}${numTxt}${proportionalText()}`;
  };
  const proportionalText = () => (proportional ? `  Proportional size: ${fmt(propSize)}` : '');

  const handler: ModalHandler = {
    label: modeLabel(),
    cursor: 'move',
    header,
    status: () => [
      ['LMB', 'Confirm'],
      ['RMB/Esc', 'Cancel'],
      ['X Y Z', 'Axis'],
      ['Shift X Y Z', 'Plane'],
      ['Ctrl', 'Snap'],
      ['Shift', 'Precision'],
      ['G R S', 'Mode'],
    ],
    onPointerMove(e: PointerEvent) {
      const r = v.el.getBoundingClientRect();
      const nx = e.clientX - r.left,
        ny = e.clientY - r.top;
      precise = e.shiftKey;
      if (precise) {
        // precision: scale incremental motion
        accumPrecise.x += (nx - lastPrecise.x) * 0.1;
        accumPrecise.y += (ny - lastPrecise.y) * 0.1;
        mouse = { x: precisionBase.x + accumPrecise.x, y: precisionBase.y + accumPrecise.y };
      } else {
        precisionBase = { x: nx, y: ny };
        accumPrecise = { x: 0, y: 0 };
        mouse = { x: nx, y: ny };
      }
      lastPrecise = { x: nx, y: ny };
      snap = e.ctrlKey !== ts.use_snap;
      // accumulate rotation across the ±π wrap
      const a = Math.atan2(mouse.y - pivotScreen.y, mouse.x - pivotScreen.x);
      let da = a - lastAngle;
      if (da > Math.PI) da -= Math.PI * 2;
      if (da < -Math.PI) da += Math.PI * 2;
      lastAngle = a;
      rotTotal += da;
      compute();
    },
    onPointerDown(e: PointerEvent) {
      if (e.button === 0) return 'FINISHED';
      if (e.button === 2) return 'CANCELLED';
      return undefined;
    },
    onPointerUp(e: PointerEvent) {
      if (opts.release_confirm && e.button === 0) return 'FINISHED';
      return undefined;
    },
    onWheel(e: WheelEvent) {
      if (proportional) {
        propSize = Math.max(0.001, propSize * (e.deltaY > 0 ? 1.1 : 1 / 1.1));
        ts.proportional_size = propSize;
        d.onUpdate?.();
        compute();
      }
    },
    onKey(e: KeyboardEvent) {
      const k = e.key;
      if (k === 'Escape') return 'CANCELLED';
      if (k === 'Enter' || k === ' ') return 'FINISHED';
      if (e.type !== 'keydown') return true;
      const code = e.code;
      if (code === 'KeyX' || code === 'KeyY' || code === 'KeyZ') {
        if (numeric || numericValues.some(Boolean)) {
          // typing a new axis while numeric input is active
        }
        setConstraint(code === 'KeyX' ? 0 : code === 'KeyY' ? 1 : 2, e.shiftKey);
        compute();
        return true;
      }
      if (code === 'KeyG' && curMode === 'TRANSLATION' && app.doc.mode === 'EDIT' && !constraint) {
        // G G: switch to edge/vertex slide
        setTimeout(() => app.run('transform.edge_slide'), 0);
        return 'CANCELLED';
      }
      if (code === 'KeyG' || code === 'KeyR' || code === 'KeyS') {
        const next: TransformMode = code === 'KeyG' ? 'TRANSLATION' : code === 'KeyR' ? (curMode === 'ROTATION' ? 'TRACKBALL' : 'ROTATION') : 'RESIZE';
        for (const el of d.elements) el.restore();
        curMode = next;
        startMouse = { ...mouse };
        rotTotal = 0;
        lastAngle = Math.atan2(mouse.y - pivotScreen.y, mouse.x - pivotScreen.x);
        handler.label = modeLabel();
        compute();
        return true;
      }
      if (/^[0-9.]$/.test(k) || k === '-' || k === '*' || k === '/' || k === '+' || k === '(' || k === ')') {
        if (k === '-' && !numeric) numeric = '-';
        else if (k === '-' && numeric === '-') numeric = '';
        else numeric += k;
        compute();
        return true;
      }
      if (k === 'Backspace') {
        if (e.ctrlKey) numeric = '';
        else numeric = numeric.slice(0, -1);
        compute();
        return true;
      }
      if (k === 'Tab') {
        e.preventDefault();
        numericValues[numericAxis] = numeric || null;
        numericAxis = (numericAxis + 1) % (curMode === 'TRANSLATION' || curMode === 'RESIZE' ? 3 : 1);
        numeric = numericValues[numericAxis] ?? '';
        compute();
        return true;
      }
      if ((k === 'o' || k === 'O') && !e.ctrlKey) {
        return true;
      }
      if (k === 'PageUp' || k === 'PageDown') {
        propSize *= k === 'PageUp' ? 1.1 : 1 / 1.1;
        ts.proportional_size = propSize;
        compute();
        return true;
      }
      return true;
    },
    cancel() {
      for (const e of d.elements) e.restore();
      d.onUpdate?.();
      d.cancel();
      app.changed('doc');
    },
    finish() {
      d.finish();
      if (opts.redo) handler.redoOp = opts.redo(value);
      if (opts.label) handler.label = opts.label;
    },
  };
  let precisionBase = { ...start };
  void trackball;
  trackball = [0, 0];
  app.startModal(handler);
  if (opts.value) {
    numeric = String(opts.value[0]);
    numericValues = opts.value.map((x) => String(x));
    numericAxis = 0;
    numeric = numericValues[0] ?? '';
  }
  compute();
  // run non-interactively when values were given (redo / scripting)
  if (opts.value) app.endModal('FINISHED');
  return true;
}

function blendTransform(m: Matrix4, w: number, mode: TransformMode): Matrix4 {
  const p = new Vector3(),
    q = new Quaternion(),
    s = new Vector3();
  m.decompose(p, q, s);
  p.multiplyScalar(w);
  q.slerp(new Quaternion(), 1 - w);
  s.lerp(new Vector3(1, 1, 1), 1 - w);
  void mode;
  return new Matrix4().compose(p, q, s);
}

registerOperators([
  {
    idname: 'transform.translate',
    label: 'Move',
    description: 'Move selected items',
    poll: () => !!activeView3D(),
    invoke: (ctx, p) => (startTransform('TRANSLATION', { constraint: p.constraint_axis as boolean[] | undefined, event: ctx.event, release_confirm: !!p.release_confirm }) ? 'RUNNING_MODAL' : 'CANCELLED'),
    exec: (_ctx, p) => (startTransform('TRANSLATION', { value: p.value as number[], constraint: p.constraint_axis as boolean[] | undefined }) ? 'FINISHED' : 'CANCELLED'),
    undo: false,
  },
  {
    idname: 'transform.rotate',
    label: 'Rotate',
    description: 'Rotate selected items',
    poll: () => !!activeView3D(),
    invoke: (ctx, p) => (startTransform('ROTATION', { constraint: p.constraint_axis as boolean[] | undefined, event: ctx.event }) ? 'RUNNING_MODAL' : 'CANCELLED'),
    undo: false,
  },
  {
    idname: 'transform.resize',
    label: 'Resize',
    description: 'Scale (resize) selected items',
    poll: () => !!activeView3D(),
    invoke: (ctx, p) => (startTransform('RESIZE', { constraint: p.constraint_axis as boolean[] | undefined, event: ctx.event }) ? 'RUNNING_MODAL' : 'CANCELLED'),
    undo: false,
  },
  {
    idname: 'transform.trackball',
    label: 'Trackball',
    poll: () => !!activeView3D(),
    invoke: (ctx) => (startTransform('TRACKBALL', { event: ctx.event }) ? 'RUNNING_MODAL' : 'CANCELLED'),
    undo: false,
  },
  {
    idname: 'transform.shrink_fatten',
    label: 'Shrink/Fatten',
    poll: () => !!activeView3D() && app.doc.mode === 'EDIT',
    invoke: (ctx) => (startTransform('SHRINKFATTEN', { event: ctx.event }) ? 'RUNNING_MODAL' : 'CANCELLED'),
    undo: false,
  },
  {
    idname: 'transform.tosphere',
    label: 'To Sphere',
    poll: () => !!activeView3D() && app.doc.mode === 'EDIT',
    invoke: (ctx) => (startTransform('TOSPHERE', { event: ctx.event }) ? 'RUNNING_MODAL' : 'CANCELLED'),
    undo: false,
  },
  {
    idname: 'transform.push_pull',
    label: 'Push/Pull',
    poll: () => !!activeView3D(),
    invoke: (ctx) => (startTransform('PUSHPULL', { event: ctx.event }) ? 'RUNNING_MODAL' : 'CANCELLED'),
    undo: false,
  },
]);

export type { View3D };
