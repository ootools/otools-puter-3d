// A 2D time/value view used by the animation editors: frames along X, values
// (or channel rows) along Y. Handles pan/zoom on both axes and grid steps.

export class View2D {
  /** frame at the left edge of the region */
  x0 = -10;
  /** pixels per frame */
  ppf = 6;
  /** value at the bottom edge of the region (graph editors) */
  y0 = -1.5;
  /** pixels per value unit */
  ppv = 60;
  /** region size in CSS px */
  width = 1;
  height = 1;

  fx(frame: number) {
    return (frame - this.x0) * this.ppf;
  }
  xf(x: number) {
    return x / this.ppf + this.x0;
  }
  vy(value: number) {
    return this.height - (value - this.y0) * this.ppv;
  }
  yv(y: number) {
    return (this.height - y) / this.ppv + this.y0;
  }

  /** Zoom horizontally keeping the frame under `anchorX` fixed. */
  zoomX(factor: number, anchorX: number) {
    const f = this.xf(anchorX);
    this.ppf = Math.max(0.02, Math.min(400, this.ppf * factor));
    this.x0 = f - anchorX / this.ppf;
  }
  zoomY(factor: number, anchorY: number) {
    const v = this.yv(anchorY);
    this.ppv = Math.max(1e-6, Math.min(1e7, this.ppv * factor));
    this.y0 = v - (this.height - anchorY) / this.ppv;
  }
  /** Pan by a pixel delta (content follows the pointer). */
  panPx(dx: number, dy: number) {
    this.x0 -= dx / this.ppf;
    this.y0 += dy / this.ppv;
  }
  fitX(a: number, b: number, marginPx = 30) {
    if (!(b > a)) {
      a -= 10;
      b += 10;
    }
    const avail = Math.max(20, this.width - marginPx * 2);
    this.ppf = Math.max(0.02, Math.min(400, avail / (b - a)));
    this.x0 = a - marginPx / this.ppf;
  }
  fitY(lo: number, hi: number, marginPx = 30) {
    if (!(hi - lo > 1e-9)) {
      const c = (hi + lo) / 2 || 0;
      lo = c - 1;
      hi = c + 1;
    }
    const avail = Math.max(20, this.height - marginPx * 2);
    this.ppv = Math.max(1e-6, Math.min(1e7, avail / (hi - lo)));
    this.y0 = lo - marginPx / this.ppv;
  }
  centerOnFrame(frame: number) {
    this.x0 = frame - this.width / 2 / this.ppf;
  }
}

/** Grid/label step in frames so that labels are at least `minPx` apart. */
export function frameStep(ppf: number, fps: number, minPx = 50): number {
  const f = Math.max(1, Math.round(fps));
  const cands = new Set<number>([1, 2, 5, 10]);
  for (const m of [0.25, 0.5, 1, 2, 5, 10, 20, 30, 60, 120, 300, 600, 1200, 3000, 6000]) {
    const s = f * m;
    if (Number.isInteger(s) && s >= 1) cands.add(s);
  }
  const sorted = [...cands].sort((a, b) => a - b);
  return sorted.find((s) => s * ppf >= minPx) ?? sorted[sorted.length - 1] * Math.ceil(minPx / (sorted[sorted.length - 1] * ppf));
}

/** 1/2/5 × 10^n step for value axes. */
export function valueStep(ppv: number, minPx = 40): number {
  const raw = minPx / ppv;
  const p = Math.pow(10, Math.floor(Math.log10(raw)));
  for (const m of [1, 2, 5, 10]) if (m * p >= raw) return m * p;
  return 10 * p;
}

export function formatValue(v: number, step: number) {
  const digits = Math.max(0, Math.min(6, -Math.floor(Math.log10(step) + 1e-9)));
  const s = v.toFixed(digits);
  return s === '-0' || /^-0\.0*$/.test(s) ? s.slice(1) : s;
}
