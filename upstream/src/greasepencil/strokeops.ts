// Stroke kernels shared by Draw post-processing, Edit Mode operators and Sculpt brushes.
import type { GPPoint, GPStroke } from './data';

export interface SmoothWhat {
  position: boolean;
  radius: boolean;
  opacity: boolean;
}

/** Laplacian smoothing; end points of open strokes stay fixed. `mask` limits which points move. */
export function smoothPoints(points: GPPoint[], factor: number, steps: number, cyclic: boolean, what: SmoothWhat, mask?: (i: number) => number): GPPoint[] {
  let cur = points.map((p) => ({
    ...p,
    co: [...p.co] as [number, number, number],
  }));
  const n = cur.length;
  if (n < 3) return cur;
  for (let s = 0; s < steps; s++) {
    const next = cur.map((p) => ({
      ...p,
      co: [...p.co] as [number, number, number],
    }));
    for (let i = 0; i < n; i++) {
      if (!cyclic && (i === 0 || i === n - 1)) continue;
      const a = cur[(i - 1 + n) % n],
        b = cur[(i + 1) % n],
        p = cur[i];
      const f = factor * (mask ? mask(i) : 1);
      if (!f) continue;
      if (what.position) for (let k = 0; k < 3; k++) next[i].co[k] = p.co[k] + ((a.co[k] + b.co[k]) / 2 - p.co[k]) * f;
      if (what.radius) next[i].radius = p.radius + ((a.radius + b.radius) / 2 - p.radius) * f;
      if (what.opacity) next[i].opacity = p.opacity + ((a.opacity + b.opacity) / 2 - p.opacity) * f;
    }
    cur = next;
  }
  return cur;
}

function mid(a: GPPoint, b: GPPoint, t: number): GPPoint {
  const l = (x: number, y: number) => x + (y - x) * t;
  return {
    co: [l(a.co[0], b.co[0]), l(a.co[1], b.co[1]), l(a.co[2], b.co[2])],
    radius: l(a.radius, b.radius),
    opacity: l(a.opacity, b.opacity),
    vertex_color: [l(a.vertex_color[0], b.vertex_color[0]), l(a.vertex_color[1], b.vertex_color[1]), l(a.vertex_color[2], b.vertex_color[2]), l(a.vertex_color[3], b.vertex_color[3])],
    select: a.select && b.select,
  };
}

/** Insert `cuts` points in each segment (only between selected points when `onlySelected`). */
export function subdivideStroke(st: GPStroke, cuts: number, onlySelected: boolean): GPStroke {
  const pts = st.points;
  const n = pts.length;
  const out: GPPoint[] = [];
  const segs = st.cyclic ? n : n - 1;
  for (let i = 0; i < n; i++) {
    out.push(pts[i]);
    if (i >= segs) continue;
    const a = pts[i],
      b = pts[(i + 1) % n];
    if (onlySelected && !(a.select && b.select)) continue;
    for (let k = 1; k <= cuts; k++) out.push(mid(a, b, k / (cuts + 1)));
  }
  return { ...st, points: out };
}

/** Ramer–Douglas–Peucker simplification on positions. */
export function simplifyPoints(points: GPPoint[], eps: number): GPPoint[] {
  if (points.length < 3) return points;
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  const stack: [number, number][] = [[0, points.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    const A = points[a].co,
      B = points[b].co;
    const ab = [B[0] - A[0], B[1] - A[1], B[2] - A[2]];
    const L2 = ab[0] ** 2 + ab[1] ** 2 + ab[2] ** 2;
    let best = -1,
      bd = eps;
    for (let i = a + 1; i < b; i++) {
      const P = points[i].co;
      const ap = [P[0] - A[0], P[1] - A[1], P[2] - A[2]];
      const t = L2 > 0 ? Math.max(0, Math.min(1, (ap[0] * ab[0] + ap[1] * ab[1] + ap[2] * ab[2]) / L2)) : 0;
      const d = Math.hypot(ap[0] - ab[0] * t, ap[1] - ab[1] * t, ap[2] - ab[2] * t);
      if (d > bd) {
        bd = d;
        best = i;
      }
    }
    if (best >= 0) {
      keep[best] = 1;
      stack.push([a, best], [best, b]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

const dist = (a: GPPoint, b: GPPoint) => Math.hypot(a.co[0] - b.co[0], a.co[1] - b.co[1], a.co[2] - b.co[2]);

/** Join strokes into one, chaining each next stroke by its nearest end (reversing as needed). */
export function joinStrokes(strokes: GPStroke[]): GPStroke | null {
  if (!strokes.length) return null;
  const rest = strokes.slice(1).map((s) => s.points.slice());
  let pts = strokes[0].points.slice();
  while (rest.length) {
    const end = pts[pts.length - 1];
    let bi = 0,
      rev = false,
      bd = Infinity;
    rest.forEach((r, i) => {
      const d0 = dist(end, r[0]),
        d1 = dist(end, r[r.length - 1]);
      if (d0 < bd) {
        bd = d0;
        bi = i;
        rev = false;
      }
      if (d1 < bd) {
        bd = d1;
        bi = i;
        rev = true;
      }
    });
    const next = rest.splice(bi, 1)[0];
    pts = pts.concat(rev ? next.reverse() : next);
  }
  return { ...strokes[0], points: pts, cyclic: false };
}

/** Split strokes at unselected/selected boundaries, keeping only the parts matching `keep`. */
export function filterPoints(st: GPStroke, keep: (p: GPPoint, i: number) => boolean): GPStroke[] {
  const runs: GPPoint[][] = [];
  let cur: GPPoint[] = [];
  st.points.forEach((p, i) => {
    if (keep(p, i)) cur.push(p);
    else {
      if (cur.length) runs.push(cur);
      cur = [];
    }
  });
  if (cur.length) runs.push(cur);
  if (runs.length === 1 && runs[0].length === st.points.length) return [st];
  if (st.cyclic && runs.length > 1 && keep(st.points[0], 0) && keep(st.points[st.points.length - 1], st.points.length - 1)) {
    const last = runs.pop()!;
    runs[0] = [...last, ...runs[0]];
  }
  return runs.map((r) => ({ ...st, points: r, cyclic: false }));
}
