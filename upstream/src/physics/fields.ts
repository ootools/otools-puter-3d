// Force fields (effectors) on objects: Force, Wind, Vortex, Turbulence, Drag.
// Evaluated per point as an acceleration-like force; callers divide by mass.
import { Matrix4, Vector3 } from 'three';
import type { DocumentData, ObjectData } from '../data/types';
import { hash32, motionKey, worldAt, type SimContext } from './common';
import type { ForceFieldX } from './types';

export interface Effector {
  id: string;
  field: ForceFieldX;
  /** world position and unit Z axis of the field object */
  px: number;
  py: number;
  pz: number;
  ax: number;
  ay: number;
  az: number;
  inv: Matrix4;
  scale: number;
}

export function fieldObjects(doc: DocumentData): ObjectData[] {
  const out: ObjectData[] = [];
  for (const id of doc.object_order) {
    const ob = doc.objects[id];
    if (ob?.field && ob.field.type !== 'NONE' && !ob.hide_viewport) out.push(ob);
  }
  return out;
}

/** Settings + motion signature of all fields (part of simulation cache hashes). */
export function fieldsKey(doc: DocumentData, refFrame: number): string {
  return fieldObjects(doc)
    .map((ob) => `${ob.id}:${JSON.stringify(ob.field)}:${motionKey(doc, ob, refFrame)}`)
    .join('|');
}

export function collectEffectors(ctx: SimContext, frame: number, exclude?: string): Effector[] {
  const out: Effector[] = [];
  for (const ob of fieldObjects(ctx.doc)) {
    if (ob.id === exclude) continue;
    const m = worldAt(ctx, ob, frame);
    const e = m.elements;
    const z = new Vector3(e[8], e[9], e[10]);
    const scale = z.length() || 1;
    z.normalize();
    out.push({ id: ob.id, field: ob.field as ForceFieldX, px: e[12], py: e[13], pz: e[14], ax: z.x, ay: z.y, az: z.z, inv: m.clone().invert(), scale });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Smooth 3D value noise (own implementation) for turbulence and noise amounts.

function lattice(ix: number, iy: number, iz: number, seed: number, ch: number) {
  return hash32(ix, iy, iz, seed * 4 + ch) / 2147483648 - 1;
}
const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);

export function valueNoise(x: number, y: number, z: number, seed: number, ch: number): number {
  const ix = Math.floor(x),
    iy = Math.floor(y),
    iz = Math.floor(z);
  const fx = fade(x - ix),
    fy = fade(y - iy),
    fz = fade(z - iz);
  let r = 0;
  for (let k = 0; k < 8; k++) {
    const dx = k & 1,
      dy = (k >> 1) & 1,
      dz = (k >> 2) & 1;
    const w = (dx ? fx : 1 - fx) * (dy ? fy : 1 - fy) * (dz ? fz : 1 - fz);
    r += w * lattice(ix + dx, iy + dy, iz + dz, seed, ch);
  }
  return r;
}

function falloff(f: ForceFieldX, dist: number, radial: number, axial: number): number {
  if (f.use_max_distance && (f.distance_max ?? 0) > 0 && dist > f.distance_max!) return 0;
  if (f.use_min_distance && dist < (f.distance_min ?? 0)) return 0;
  const power = f.falloff_power ?? 0;
  if (power <= 0) return 1;
  let r = dist;
  if (f.falloff_type === 'TUBE') r = radial;
  else if (f.falloff_type === 'CONE') r = dist * (1 + Math.max(0, radial / Math.max(1e-6, Math.abs(axial))));
  // 1 / r^power, limited near the field origin to keep the integration stable
  return 1 / Math.pow(Math.max(r, 0.1), power);
}

/**
 * Accumulate the force of all effectors at a point with velocity v into out.
 * `normal` (optional) makes wind act like pressure on a surface (cloth).
 */
export function effectorForce(
  effs: Effector[],
  x: number,
  y: number,
  z: number,
  vx: number,
  vy: number,
  vz: number,
  time: number,
  out: Float64Array | number[],
  weight = 1,
  normal?: [number, number, number] | null,
) {
  if (!effs.length || weight === 0) return;
  for (const e of effs) {
    const f = e.field;
    const S = f.strength * weight;
    const dx = x - e.px,
      dy = y - e.py,
      dz = z - e.pz;
    const axial = dx * e.ax + dy * e.ay + dz * e.az;
    const rx = dx - axial * e.ax,
      ry = dy - axial * e.ay,
      rz = dz - axial * e.az;
    const radial = Math.hypot(rx, ry, rz);
    const dist = Math.hypot(dx, dy, dz);
    let fx = 0,
      fy = 0,
      fz = 0;
    switch (f.type) {
      case 'FORCE': {
        const fo = falloff(f, dist, radial, axial);
        if (dist > 1e-6 && fo) {
          fx = (dx / dist) * S * fo;
          fy = (dy / dist) * S * fo;
          fz = (dz / dist) * S * fo;
        }
        break;
      }
      case 'WIND': {
        // planar: distance measured along the field axis
        const fo = falloff(f, Math.abs(axial), radial, axial);
        fx = e.ax * S * fo;
        fy = e.ay * S * fo;
        fz = e.az * S * fo;
        break;
      }
      case 'VORTEX': {
        const fo = falloff(f, radial, radial, axial);
        if (radial > 1e-6 && fo) {
          // tangential direction: axis × radial
          fx = ((e.ay * rz - e.az * ry) / radial) * S * fo;
          fy = ((e.az * rx - e.ax * rz) / radial) * S * fo;
          fz = ((e.ax * ry - e.ay * rx) / radial) * S * fo;
        }
        break;
      }
      case 'TURBULENCE': {
        const fo = falloff(f, dist, radial, axial);
        const size = Math.max(1e-3, f.size ?? 1);
        const seed = f.seed ?? 1;
        const t = time * 0.05;
        fx = valueNoise(x / size + t, y / size, z / size, seed, 0) * S * fo * 2;
        fy = valueNoise(x / size, y / size + t, z / size, seed, 1) * S * fo * 2;
        fz = valueNoise(x / size, y / size, z / size + t, seed, 2) * S * fo * 2;
        break;
      }
      case 'DRAG': {
        const fo = falloff(f, dist, radial, axial);
        const sp = Math.hypot(vx, vy, vz);
        const k = (f.strength + f.flow * sp) * fo * weight;
        out[0] -= vx * k;
        out[1] -= vy * k;
        out[2] -= vz * k;
        continue;
      }
      default:
        continue;
    }
    // noise amount (random variation of the force)
    if (f.noise && f.type !== 'TURBULENCE') {
      const n = f.noise * Math.abs(S);
      const seed = f.seed ?? 1;
      fx += valueNoise(x * 2 + time * 0.3, y * 2, z * 2, seed, 3) * n;
      fy += valueNoise(x * 2, y * 2 + time * 0.3, z * 2, seed, 4) * n;
      fz += valueNoise(x * 2, y * 2, z * 2 + time * 0.3, seed, 5) * n;
    }
    // surfaces (cloth) catch wind like a sail: only the normal component pushes
    if (normal && f.type === 'WIND') {
      const d = fx * normal[0] + fy * normal[1] + fz * normal[2];
      fx = normal[0] * d;
      fy = normal[1] * d;
      fz = normal[2] * d;
    }
    // flow: the field becomes a target air velocity instead of a constant force
    if (f.flow > 0 && f.type !== 'TURBULENCE') {
      fx = f.flow * (fx - vx);
      fy = f.flow * (fy - vy);
      fz = f.flow * (fz - vz);
    }
    out[0] += fx;
    out[1] += fy;
    out[2] += fz;
  }
}
