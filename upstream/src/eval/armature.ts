// Armature rest/pose evaluation and linear blend skinning.
// Bone convention: the bone's local Y axis points from head to tail, roll rotates
// around Y. Rest matrices are in armature space with translation at the head.
import { Matrix4, Quaternion, Vector3 } from 'three';
import type { ArmatureData, Bone, DocumentData, ObjectData, PoseBone, Vec3 } from '../data/types';
import { poseBoneMatrix } from './transform';
import type { Depsgraph } from './depsgraph';
import { solveIK } from './ik';

export interface BoneEval {
  name: string;
  rest: Matrix4; // armature space
  restInv: Matrix4;
  pose: Matrix4; // armature space, posed
  /** pose * restInv: deforms rest-space vertices */
  deform: Matrix4;
  length: number;
  parent: string | null;
}

export interface PoseResult {
  bones: Map<string, BoneEval>;
  order: string[];
  signature: string;
}

/** Rotation that maps +Y onto `dir` with roll around it. */
export function boneRotation(dir: Vector3, roll: number, out = new Matrix4()): Matrix4 {
  const y = dir.clone().normalize();
  const q = new Quaternion().setFromUnitVectors(new Vector3(0, 1, 0), y);
  if (y.y < -0.99999) q.setFromAxisAngle(new Vector3(0, 0, 1), Math.PI);
  const r = new Quaternion().setFromAxisAngle(y, roll);
  q.premultiply(r);
  return out.makeRotationFromQuaternion(q);
}

export function boneRestMatrix(b: Bone, out = new Matrix4()): Matrix4 {
  const head = new Vector3(...b.head),
    tail = new Vector3(...b.tail);
  boneRotation(tail.clone().sub(head), b.roll, out);
  out.setPosition(head);
  return out;
}

export function defaultPoseBone(): PoseBone {
  return {
    location: [0, 0, 0],
    rotation_mode: 'QUATERNION',
    rotation_quaternion: [1, 0, 0, 0],
    rotation_euler: [0, 0, 0],
    rotation_axis_angle: [0, 0, 1, 0],
    scale: [1, 1, 1],
    constraints: [],
  };
}

export function sortedBones(arm: ArmatureData): Bone[] {
  const byName = new Map(arm.bones.map((b) => [b.name, b]));
  const out: Bone[] = [],
    seen = new Set<string>();
  const visit = (b: Bone) => {
    if (seen.has(b.name)) return;
    seen.add(b.name);
    if (b.parent && byName.has(b.parent)) visit(byName.get(b.parent)!);
    out.push(b);
  };
  arm.bones.forEach(visit);
  return out;
}

export function evaluatePose(doc: DocumentData, ob: ObjectData, arm: ArmatureData, graph?: Depsgraph): PoseResult {
  const bones = new Map<string, BoneEval>(),
    order: string[] = [];
  const restPosition = arm.pose_position === 'REST' || !!graph?.editObjects.has(ob.id);
  const local = new Matrix4();
  for (const b of sortedBones(arm)) {
    const rest = boneRestMatrix(b);
    const ev: BoneEval = {
      name: b.name,
      rest,
      restInv: rest.clone().invert(),
      pose: new Matrix4(),
      deform: new Matrix4(),
      length: new Vector3(...b.tail).distanceTo(new Vector3(...b.head)),
      parent: b.parent,
    };
    const pb = ob.pose?.[b.name];
    if (pb && !restPosition) poseBoneMatrix(pb, local);
    else local.identity();
    const parent = b.parent ? bones.get(b.parent) : undefined;
    if (parent) {
      // parent pose * (parent rest^-1 * rest) * local
      const relRest = parent.restInv.clone().multiply(rest);
      if (b.use_connect) {
        // connected bones start at the parent's tail
        relRest.setPosition(0, parent.length, 0);
      }
      let parentPose = parent.pose;
      if (!b.use_inherit_rotation || b.inherit_scale === 'NONE') {
        const p = new Vector3(),
          q = new Quaternion(),
          s = new Vector3();
        parent.pose.decompose(p, q, s);
        const pr = new Vector3(),
          qr = new Quaternion(),
          sr = new Vector3();
        parent.rest.decompose(pr, qr, sr);
        parentPose = new Matrix4().compose(p, b.use_inherit_rotation ? q : qr, b.inherit_scale === 'NONE' ? new Vector3(1, 1, 1) : s);
      }
      ev.pose.multiplyMatrices(parentPose, relRest).multiply(local);
    } else ev.pose.multiplyMatrices(rest, local);
    bones.set(b.name, ev);
    order.push(b.name);
  }
  // Bone constraints (IK, copy rotation, damped track...) in armature space
  if (ob.pose && !restPosition && graph) {
    const armWorld = graph.get(ob.id)?.world ?? new Matrix4();
    const armWorldInv = armWorld.clone().invert();
    for (const name of order) {
      const pb = ob.pose[name];
      if (!pb?.constraints.length) continue;
      for (const c of pb.constraints) {
        if (c.mute || c.influence <= 0) continue;
        if (c.type === 'IK') {
          let targetPos: Vector3 | null = null;
          const target = c.target ? graph.get(c.target as string) : undefined;
          if (target) {
            const tm = target.world.clone();
            if (c.subtarget && target.pose) {
              const tb = target.pose.bones.get(c.subtarget as string);
              if (tb) tm.multiply(tb.pose);
            }
            targetPos = new Vector3().setFromMatrixPosition(tm).applyMatrix4(armWorldInv);
          }
          if (targetPos) {
            let pole: Vector3 | null = null;
            const poleOb = c.pole_target ? graph.get(c.pole_target as string) : undefined;
            if (poleOb) pole = new Vector3().setFromMatrixPosition(poleOb.world).applyMatrix4(armWorldInv);
            solveIK(bones, arm, name, targetPos, (c.chain_count as number) || 0, (c.iterations as number) || 500, c.influence, pole, ((c.pole_angle as number) ?? 0));
          }
        } else if (c.type === 'COPY_ROTATION' || c.type === 'DAMPED_TRACK' || c.type === 'TRACK_TO' || c.type === 'COPY_LOCATION' || c.type === 'LIMIT_ROTATION' || c.type === 'STRETCH_TO') {
          applyBoneConstraint(bones, name, c, graph, armWorld, armWorldInv);
        }
      }
    }
  }
  let sig = '';
  for (const name of order) {
    const ev = bones.get(name)!;
    ev.deform.multiplyMatrices(ev.pose, ev.restInv);
    sig += ev.pose.elements.map((x) => x.toFixed(4)).join(',') + ',' + ev.length.toFixed(4) + ';';
  }
  return { bones, order, signature: hashString(sig) };
}

function hashString(s: string) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0).toString(36);
}

function propagateChildren(bones: Map<string, BoneEval>, name: string, delta: Matrix4) {
  for (const b of bones.values())
    if (b.parent === name) {
      b.pose.premultiply(delta);
      propagateChildren(bones, b.name, delta);
    }
}

/** Replace a bone's pose matrix and carry its children along. */
export function setBonePose(bones: Map<string, BoneEval>, name: string, m: Matrix4) {
  const b = bones.get(name)!;
  const delta = m.clone().multiply(b.pose.clone().invert());
  b.pose.copy(m);
  propagateChildren(bones, name, delta);
}

function applyBoneConstraint(
  bones: Map<string, BoneEval>,
  name: string,
  c: PoseBone['constraints'][number],
  graph: Depsgraph,
  armWorld: Matrix4,
  armWorldInv: Matrix4,
) {
  const b = bones.get(name)!;
  const target = c.target ? graph.get(c.target as string) : undefined;
  if (!target && c.type !== 'LIMIT_ROTATION') return;
  const tm = target ? target.world.clone() : new Matrix4();
  if (target && c.subtarget && target.pose) {
    const tb = target.pose.bones.get(c.subtarget as string);
    if (tb) tm.multiply(tb.pose);
  }
  const tLocal = armWorldInv.clone().multiply(tm);
  const p = new Vector3(),
    q = new Quaternion(),
    s = new Vector3();
  b.pose.decompose(p, q, s);
  const tp = new Vector3(),
    tq = new Quaternion(),
    ts = new Vector3();
  tLocal.decompose(tp, tq, ts);
  const inf = c.influence;
  if (c.type === 'COPY_ROTATION') q.slerp(tq, inf);
  else if (c.type === 'COPY_LOCATION') p.lerp(tp, inf);
  else if (c.type === 'DAMPED_TRACK' || c.type === 'TRACK_TO' || c.type === 'STRETCH_TO') {
    const yAxis = new Vector3(0, 1, 0).applyQuaternion(q);
    const dir = tp.clone().sub(p);
    const dist = dir.length();
    dir.normalize();
    const rot = new Quaternion().setFromUnitVectors(yAxis, dir);
    const full = rot.multiply(q);
    q.slerp(full, inf);
    if (c.type === 'STRETCH_TO' && b.length > 0) s.y *= 1 + ((dist / b.length) - 1) * inf;
  } else if (c.type === 'LIMIT_ROTATION') {
    // limit in local space relative to rest
    void armWorld;
  }
  setBonePose(bones, name, new Matrix4().compose(p, q, s));
}

/** Deform positions (object space) by an armature; returns new array. */
export function skinPositions(
  positions: Float32Array,
  groups: { name: string }[],
  weights: Float32Array[],
  pose: PoseResult,
  meshToArm: Matrix4,
  armToMesh: Matrix4,
  preserveVolume = false,
  envelopeFallback = false,
): Float32Array {
  void preserveVolume;
  void envelopeFallback;
  const n = positions.length / 3,
    out = new Float32Array(positions.length);
  const mats: (Matrix4 | null)[] = groups.map((g) => {
    const b = pose.bones.get(g.name);
    return b ? armToMesh.clone().multiply(b.deform).multiply(meshToArm) : null;
  });
  const v = new Vector3(),
    acc = new Vector3(),
    tmp = new Vector3();
  for (let i = 0; i < n; i++) {
    v.set(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]);
    acc.set(0, 0, 0);
    let total = 0;
    for (let g = 0; g < mats.length; g++) {
      const m = mats[g];
      if (!m) continue;
      const w = weights[g]?.[i] ?? 0;
      if (w <= 0) continue;
      tmp.copy(v).applyMatrix4(m).multiplyScalar(w);
      acc.add(tmp);
      total += w;
    }
    if (total > 0) acc.multiplyScalar(1 / total);
    else acc.copy(v);
    out[i * 3] = acc.x;
    out[i * 3 + 1] = acc.y;
    out[i * 3 + 2] = acc.z;
  }
  return out;
}

export function boneTailWorld(b: Bone): Vec3 {
  return [...b.tail] as Vec3;
}
