// Scene camera → three.js camera for final renders (exact frame, lens shift, depth of field).
import { OrthographicCamera, Vector3, Matrix4, type Camera, PerspectiveCamera } from 'three';
import { PhysicalCamera } from 'three-gpu-pathtracer';
import type { App } from '../../app/app';

/** Half extents of the camera frame at distance 1 (perspective) – pure for testing. */
export function frustumHalfExtents(ca: { sensor_fit: 'AUTO' | 'HORIZONTAL' | 'VERTICAL'; sensor_width: number; sensor_height: number; lens: number }, aspect: number): [number, number] {
  const horizontal = ca.sensor_fit === 'HORIZONTAL' || (ca.sensor_fit === 'AUTO' && aspect >= 1);
  const sensor = ca.sensor_fit === 'VERTICAL' ? ca.sensor_height : ca.sensor_width;
  const half = sensor / 2 / ca.lens;
  return horizontal ? [half, half / aspect] : [half * aspect, half];
}

/** Build the active scene camera for an image of w×h pixels (null when the scene has no camera). */
export function renderCamera(app: App, w: number, h: number, cameraId = app.doc.scene.camera): Camera | null {
  const doc = app.doc;
  const ev = cameraId ? app.graph.get(cameraId) : undefined;
  const ca = ev?.ob.type === 'CAMERA' && ev.ob.data ? doc.cameras[ev.ob.data] : undefined;
  if (!ev || !ca) return null;
  const r = doc.scene.render;
  const aspect = (w * r.pixel_aspect_x) / (h * r.pixel_aspect_y);
  let cam: Camera;
  if (ca.type === 'ORTHO') {
    const o = new OrthographicCamera();
    const horizontal = ca.sensor_fit === 'HORIZONTAL' || (ca.sensor_fit === 'AUTO' && aspect >= 1);
    const hw = horizontal ? ca.ortho_scale / 2 : (ca.ortho_scale / 2) * aspect;
    const hh = hw / aspect;
    const sx = ca.shift_x * ca.ortho_scale,
      sy = ca.shift_y * ca.ortho_scale;
    o.left = -hw + sx;
    o.right = hw + sx;
    o.top = hh + sy;
    o.bottom = -hh + sy;
    o.near = ca.clip_start;
    o.far = ca.clip_end;
    o.updateProjectionMatrix();
    cam = o;
  } else {
    const p = new PhysicalCamera();
    const [hx, hy] = frustumHalfExtents(ca, aspect);
    p.fov = (2 * Math.atan(hy) * 180) / Math.PI;
    p.aspect = aspect;
    p.near = ca.clip_start;
    p.far = ca.clip_end;
    p.updateProjectionMatrix();
    if (ca.shift_x || ca.shift_y) {
      // shift is a fraction of the larger frame dimension
      const s = 2 * Math.max(hx, hy);
      p.projectionMatrix.elements[8] = (ca.shift_x * s) / hx;
      p.projectionMatrix.elements[9] = (ca.shift_y * s) / hy;
      p.projectionMatrixInverse.copy(p.projectionMatrix).invert();
    }
    if (ca.dof.use_dof) {
      let dist = ca.dof.focus_distance;
      const fo = ca.dof.focus_object ? app.graph.get(ca.dof.focus_object) : undefined;
      if (fo) {
        const cp = new Vector3().setFromMatrixPosition(ev.world);
        const fwd = new Vector3(0, 0, -1).transformDirection(ev.world);
        dist = Math.max(1e-3, new Vector3().setFromMatrixPosition(fo.world).sub(cp).dot(fwd));
      }
      p.focusDistance = dist;
      p.apertureBlades = ca.dof.aperture_blades >= 3 ? ca.dof.aperture_blades : 0;
      p.bokehSize = ca.lens / Math.max(0.1, ca.dof.aperture_fstop);
    } else p.fStop = Infinity;
    cam = p;
  }
  const scale = new Vector3();
  ev.world.decompose(cam.position, cam.quaternion, scale);
  cam.updateMatrixWorld(true);
  return cam;
}

/** Copy of a viewport camera with a different aspect ratio (viewport renders). */
export function viewportCameraForAspect(src: Camera, aspect: number): Camera {
  let cam: Camera;
  if ((src as OrthographicCamera).isOrthographicCamera) {
    const s = src as OrthographicCamera;
    const o = s.clone();
    const hh = (s.top - s.bottom) / 2 / s.zoom;
    const cy = (s.top + s.bottom) / 2;
    const cx = (s.left + s.right) / 2;
    o.zoom = 1;
    o.top = cy + hh;
    o.bottom = cy - hh;
    o.left = cx - hh * aspect;
    o.right = cx + hh * aspect;
    o.updateProjectionMatrix();
    cam = o;
  } else {
    const p = (src as PerspectiveCamera).clone();
    p.aspect = aspect;
    p.updateProjectionMatrix();
    cam = p;
  }
  cam.matrixWorld.copy(src.matrixWorld);
  cam.matrixWorld.decompose(cam.position, cam.quaternion, new Vector3());
  cam.updateMatrixWorld(true);
  return cam;
}

/** Apply a sub-pixel jitter (pixels) to a camera's projection matrix in place. */
export function jitterProjection(cam: Camera, base: Matrix4, jx: number, jy: number, w: number, h: number) {
  const pm = (cam as PerspectiveCamera).projectionMatrix;
  pm.copy(base);
  const e = pm.elements;
  const dx = (2 * jx) / w,
    dy = (2 * jy) / h;
  if ((cam as OrthographicCamera).isOrthographicCamera) {
    e[12] += dx;
    e[13] += dy;
  } else {
    e[8] += dx;
    e[9] += dy;
  }
  (cam as PerspectiveCamera).projectionMatrixInverse.copy(pm).invert();
}
