// Cyclic coordinate descent IK solver operating on evaluated pose matrices.
import { Matrix4, Quaternion, Vector3 } from 'three';
import type { ArmatureData } from '../data/types';
import type { BoneEval } from './armature';
import { setBonePose } from './armature';

export function solveIK(
  bones: Map<string, BoneEval>,
  arm: ArmatureData,
  tipName: string,
  target: Vector3,
  chainCount: number,
  iterations: number,
  influence: number,
  pole: Vector3 | null,
  poleAngle: number,
) {
  const chain: string[] = [];
  let cur: string | null = tipName;
  while (cur && (chainCount <= 0 || chain.length < chainCount)) {
    chain.push(cur);
    cur = bones.get(cur)?.parent ?? null;
  }
  if (!chain.length) return;
  const original = new Map(chain.map((n) => [n, bones.get(n)!.pose.clone()]));
  const tip = () => {
    const b = bones.get(tipName)!;
    return new Vector3(0, b.length, 0).applyMatrix4(b.pose);
  };
  const iters = Math.min(iterations, 200);
  for (let it = 0; it < iters; it++) {
    for (const name of chain) {
      const b = bones.get(name)!;
      const origin = new Vector3().setFromMatrixPosition(b.pose);
      const toTip = tip().sub(origin),
        toTarget = target.clone().sub(origin);
      if (toTip.lengthSq() < 1e-12 || toTarget.lengthSq() < 1e-12) continue;
      const q = new Quaternion().setFromUnitVectors(toTip.normalize(), toTarget.normalize());
      const rot = new Matrix4().makeRotationFromQuaternion(q);
      const m = new Matrix4().makeTranslation(origin.x, origin.y, origin.z).multiply(rot).multiply(new Matrix4().makeTranslation(-origin.x, -origin.y, -origin.z)).multiply(b.pose);
      setBonePose(bones, name, m);
    }
    if (tip().distanceTo(target) < 1e-4) break;
  }
  // pole target: rotate the whole chain around the root→target axis so the chain plane faces the pole
  if (pole && chain.length > 1) {
    const root = bones.get(chain[chain.length - 1])!;
    const rootPos = new Vector3().setFromMatrixPosition(root.pose);
    const axis = target.clone().sub(rootPos).normalize();
    const mid = new Vector3().setFromMatrixPosition(bones.get(chain[0])!.pose);
    const project = (p: Vector3) => {
      const d = p.clone().sub(rootPos);
      return d.sub(axis.clone().multiplyScalar(d.dot(axis))).normalize();
    };
    const a = project(mid),
      b = project(pole);
    if (a.lengthSq() > 0 && b.lengthSq() > 0) {
      let angle = Math.acos(Math.max(-1, Math.min(1, a.dot(b))));
      if (new Vector3().crossVectors(a, b).dot(axis) < 0) angle = -angle;
      angle += poleAngle;
      const r = new Matrix4().makeRotationAxis(axis, angle);
      const m = new Matrix4().makeTranslation(rootPos.x, rootPos.y, rootPos.z).multiply(r).multiply(new Matrix4().makeTranslation(-rootPos.x, -rootPos.y, -rootPos.z)).multiply(root.pose);
      setBonePose(bones, root.name, m);
    }
  }
  if (influence < 1)
    for (const name of [...chain].reverse()) {
      const b = bones.get(name)!;
      const p0 = new Vector3(),
        q0 = new Quaternion(),
        s0 = new Vector3(),
        p1 = new Vector3(),
        q1 = new Quaternion(),
        s1 = new Vector3();
      original.get(name)!.decompose(p0, q0, s0);
      b.pose.decompose(p1, q1, s1);
      q0.slerp(q1, influence);
      p0.lerp(p1, influence);
      setBonePose(bones, name, new Matrix4().compose(p0, q0, s1));
    }
  void arm;
}
