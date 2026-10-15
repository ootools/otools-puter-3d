// Extra 3D View navigation: zoom region, camera frame zoom, view locking, fly & walk navigation.
import { Quaternion, Vector3 } from 'three';
import { app, registerOperators } from '../app/app';
import { activeView3D, type View3D } from '../editors/view3d/view3d';
import { keymaps } from '../app/keymap';
import { renderContext } from '../render/context';

const v3d = () => !!activeView3D();

function redraw(v: View3D) {
  renderContext?.engine.requestDraw();
  v.drawSvg();
  v.drawUI();
  app.changed('view');
}

/** Zoom so that the given viewport rectangle fills the view. */
function zoomToRect(v: View3D, x0: number, y0: number, x1: number, y1: number) {
  const w = Math.abs(x1 - x0),
    hgt = Math.abs(y1 - y0);
  if (w < 4 || hgt < 4) return;
  const cx = (x0 + x1) / 2,
    cy = (y0 + y1) / 2;
  const fit = Math.max(w / v.width, hgt / v.height);
  if (v.cameraView && !v.lockCameraToView) {
    // move the rectangle centre to the view centre, then enlarge the frame
    v.panCameraFrame(v.width / 2 - cx, v.height / 2 - cy);
    v.zoomCameraFrame(1 / fit);
  } else {
    v.leaveCamera();
    v.nav.update();
    const center = v.unproject(cx, cy, v.nav.pivot.clone());
    v.nav.pivot.copy(center);
    v.nav.zoom(fit);
    v.afterNav();
  }
  redraw(v);
}

registerOperators([
  {
    idname: 'view3d.zoom_border',
    label: 'Zoom to Border',
    description: 'Zoom in the view to the nearest object contained in the border',
    poll: v3d,
    invoke: () => {
      const v = activeView3D()!;
      let start: { x: number; y: number } | null = null;
      const r = () => v.el.getBoundingClientRect();
      app.startModal({
        label: 'Zoom to Border',
        header: () => (start ? 'Release to zoom' : 'Drag to define the zoom region · Esc to cancel'),
        onPointerDown(e) {
          if (e.button !== 0) return 'CANCELLED';
          start = { x: e.clientX - r().left, y: e.clientY - r().top };
        },
        onPointerMove(e) {
          if (start) v.showBox(start.x, start.y, e.clientX - r().left, e.clientY - r().top, 'box');
        },
        onPointerUp(e) {
          if (!start) return;
          v.boxEl.hidden = true;
          zoomToRect(v, start.x, start.y, e.clientX - r().left, e.clientY - r().top);
          return 'FINISHED';
        },
        onKey(e) {
          if (e.type === 'keydown' && e.key === 'Escape') return 'CANCELLED';
          return true;
        },
        cancel() {
          v.boxEl.hidden = true;
        },
      });
      return 'RUNNING_MODAL';
    },
    undo: false,
  },
  {
    idname: 'view3d.zoom_camera_1_to_1',
    label: 'Zoom Camera 1:1',
    description: 'Match the camera to 1:1 to the render output',
    poll: () => !!activeView3D()?.cameraView,
    exec: (ctx) => {
      const v = activeView3D()!;
      const r = ctx.doc.scene.render;
      v.camZoom = 1;
      v.camOffset = { x: 0, y: 0 };
      v.updateSceneCamera();
      const frame = v.cameraFrame();
      if (!frame) return 'CANCELLED';
      const target = (r.resolution_x * r.resolution_percentage) / 100;
      v.zoomCameraFrame(target / frame.w);
      redraw(v);
    },
    undo: false,
  },
  {
    idname: 'view3d.view_center_camera',
    label: 'Frame Camera Bounds',
    description: 'Center the camera view, resizing the view to fit its bounds',
    poll: () => !!activeView3D()?.cameraView,
    exec: () => {
      const v = activeView3D()!;
      v.resetCameraFrame();
      redraw(v);
    },
    undo: false,
  },
  {
    idname: 'view3d.view_center_cursor',
    label: 'Center View to Cursor',
    description: 'Center the view so that the cursor is in the middle of the view',
    poll: v3d,
    exec: (ctx) => {
      const v = activeView3D()!;
      v.leaveCamera();
      v.nav.pivot.set(...(ctx.doc.scene.cursor.location as [number, number, number]));
      v.afterNav();
      redraw(v);
    },
    undo: false,
  },
  {
    idname: 'view3d.view_lock_to_active',
    label: 'View Lock to Active',
    description: 'Lock the view to the active object',
    poll: () => v3d() && !!app.activeObject,
    exec: () => {
      const v = activeView3D()!;
      v.lockObject = app.activeObject!.id;
      redraw(v);
    },
    undo: false,
  },
  {
    idname: 'view3d.view_lock_clear',
    label: 'View Lock Clear',
    description: 'Clear all view locking',
    poll: () => !!activeView3D()?.lockObject,
    exec: () => {
      const v = activeView3D()!;
      v.lockObject = null;
      redraw(v);
    },
    undo: false,
  },
  {
    idname: 'view3d.walk',
    label: 'Walk Navigation',
    description: 'Interactively walk around the scene (WASD, Q/E down/up, mouse to look)',
    poll: v3d,
    invoke: () => startFlight('WALK'),
    undo: false,
  },
  {
    idname: 'view3d.fly',
    label: 'Fly Navigation',
    description: 'Interactively fly around the scene (mouse steers, wheel sets speed, WASD to move)',
    poll: v3d,
    invoke: () => startFlight('FLY'),
    undo: false,
  },
]);

/**
 * Walk / Fly navigation. Both keep the eye position as the reference point and move it with the
 * keyboard; Walk looks around with relative mouse motion, Fly steers towards the mouse position
 * and moves forward at a wheel-controlled speed. In camera view the scene camera is moved.
 */
function startFlight(kind: 'WALK' | 'FLY') {
  const v = activeView3D()!;
  const nav = v.nav;
  const camId = v.cameraView ? app.doc.scene.camera : null;
  const camOb = camId ? app.doc.objects[camId] : null;
  const camBefore = camOb ? { location: [...camOb.location], rotation_euler: [...camOb.rotation_euler], rotation_quaternion: [...camOb.rotation_quaternion], rotation_axis_angle: [...camOb.rotation_axis_angle] } : null;
  const lockBefore = v.lockCameraToView;
  if (camOb) {
    const ev = app.graph.get(camOb.id);
    if (ev) {
      const dist = nav.distance;
      nav.alignToMatrix(ev.world);
      nav.distance = dist;
    }
    v.lockCameraToView = true;
  } else v.leaveCamera();
  nav.leaveAxisView();
  if (nav.ortho) nav.ortho = false;
  const before = { pivot: nav.pivot.clone(), rot: nav.rot.clone(), distance: nav.distance };
  const keys = new Set<string>();
  // base speed scales with the scene/view size
  let speed = kind === 'WALK' ? Math.max(0.5, nav.distance * 0.25) : 0;
  const flyStep = Math.max(0.05, nav.distance * 0.02);
  const r = v.el.getBoundingClientRect();
  let mouse = { x: r.width / 2, y: r.height / 2 };
  let locked = false;
  if (kind === 'WALK') {
    try {
      const p = v.el.requestPointerLock?.() as unknown as Promise<void> | undefined;
      p?.catch?.(() => {});
      locked = true;
    } catch {
      locked = false;
    }
  }
  const eyeOf = () => nav.eye;
  const setEye = (eye: Vector3) => nav.pivot.copy(eye).addScaledVector(nav.forward, nav.distance);
  const look = (dx: number, dy: number) => {
    const eye = eyeOf();
    const yaw = new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), -dx);
    const pitch = new Quaternion().setFromAxisAngle(nav.right, -dy);
    const next = nav.rot.clone().premultiply(pitch).premultiply(yaw).normalize();
    // keep the view from flipping over the vertical
    const up = new Vector3(0, 1, 0).applyQuaternion(next);
    if (up.z > 0.02) nav.rot.copy(next);
    else nav.rot.premultiply(yaw).normalize();
    setEye(eye);
  };
  let last = performance.now();
  let raf = 0;
  const tick = () => {
    const now = performance.now();
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    const mult = keys.has('SHIFT') ? 3 : keys.has('ALT') ? 0.25 : 1;
    const eye = eyeOf();
    const fwd = nav.forward;
    if (kind === 'WALK') fwd.z = 0;
    fwd.normalize();
    const right = nav.right;
    const move = new Vector3();
    if (keys.has('W') || keys.has('ARROWUP')) move.add(fwd);
    if (keys.has('S') || keys.has('ARROWDOWN')) move.sub(fwd);
    if (keys.has('D') || keys.has('ARROWRIGHT')) move.add(right);
    if (keys.has('A') || keys.has('ARROWLEFT')) move.sub(right);
    if (keys.has('E')) move.z += 1;
    if (keys.has('Q')) move.z -= 1;
    const base = kind === 'WALK' ? speed : Math.max(flyStep * 10, Math.abs(speed));
    if (move.lengthSq()) eye.addScaledVector(move.normalize(), base * mult * dt);
    if (kind === 'FLY') {
      // steer towards the mouse (dead zone in the middle) and move forward at the wheel speed
      const nx = (mouse.x - r.width / 2) / (r.width / 2),
        ny = (mouse.y - r.height / 2) / (r.height / 2);
      const dz = (t: number) => (Math.abs(t) < 0.1 ? 0 : t - Math.sign(t) * 0.1);
      setEye(eye);
      look(dz(nx) * dt * 1.5, dz(ny) * dt * 1.5);
      const e2 = eyeOf().addScaledVector(nav.forward, speed * mult * dt);
      setEye(e2);
    } else setEye(eye);
    v.afterNav();
    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);
  const stop = () => {
    cancelAnimationFrame(raf);
    if (locked && document.pointerLockElement) document.exitPointerLock?.();
    v.lockCameraToView = lockBefore;
  };
  app.startModal({
    label: kind === 'WALK' ? 'Walk Navigation' : 'Fly Navigation',
    header: () =>
      kind === 'WALK'
        ? 'Walk: WASD move · Q/E down/up · Shift fast · Alt slow · Wheel speed · LMB/Enter confirm · RMB/Esc cancel'
        : `Fly: speed ${speed.toFixed(2)} · mouse steers · Wheel speed · WASD move · LMB/Enter confirm · RMB/Esc cancel`,
    onPointerMove(e) {
      if (kind === 'WALK') look(e.movementX * 0.0035, e.movementY * 0.0035);
      else mouse = { x: e.clientX - r.left, y: e.clientY - r.top };
      v.afterNav();
    },
    onWheel(e) {
      const f = e.deltaY < 0 ? 1.25 : 0.8;
      if (kind === 'FLY') speed = speed === 0 ? (e.deltaY < 0 ? flyStep * 10 : -flyStep * 10) : speed * (Math.sign(e.deltaY) === Math.sign(speed) ? 0.8 : 1.25);
      else speed = Math.max(0.01, speed * f);
      app.changed('ui');
    },
    onPointerDown(e) {
      return e.button === 0 ? 'FINISHED' : 'CANCELLED';
    },
    onKey(e) {
      const k = e.key.toUpperCase();
      if (e.type === 'keyup') {
        keys.delete(k);
        if (k === 'SHIFT' || k === 'ALT') keys.delete(k);
        return true;
      }
      if (k === 'ESCAPE') return 'CANCELLED';
      if (k === 'ENTER' || k === ' ') return 'FINISHED';
      keys.add(k);
      return true;
    },
    cancel() {
      stop();
      nav.pivot.copy(before.pivot);
      nav.rot.copy(before.rot);
      nav.distance = before.distance;
      if (camOb && camBefore) {
        Object.assign(camOb, structuredClone(camBefore));
        app.changed('doc');
      }
      redraw(v);
    },
    finish() {
      stop();
      redraw(v);
    },
  });
  return 'RUNNING_MODAL' as const;
}

// Home in camera view frames the camera bounds (before the generic Frame All binding)
(keymaps['3D View'] ??= []).unshift({ key: 'HOME', op: 'view3d.view_center_camera', when: () => !!activeView3D()?.cameraView });
(keymaps['3D View'] ??= []).push({ key: 'B', shift: true, op: 'view3d.zoom_border' }, { key: 'ACCENT_GRAVE', shift: true, op: 'view3d.walk' });
