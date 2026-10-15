// Font loading and text layout for text (FONT) objects. Uses opentype.js (MIT) to read the bundled
// Inter font (SIL Open Font License, via @fontsource/inter) and converts glyph outlines into
// Bézier splines that the curve evaluator fills and extrudes.
import { parse, type Font, type Glyph } from 'opentype.js';
import type { BezierPoint, CurveData, Spline, Vec3 } from '../data/types';
import { setGlyphProvider } from '../eval/text';
import latinUrl from '@fontsource/inter/files/inter-latin-400-normal.woff?url';
import latinExtUrl from '@fontsource/inter/files/inter-latin-ext-400-normal.woff?url';
import greekUrl from '@fontsource/inter/files/inter-greek-400-normal.woff?url';
import cyrillicUrl from '@fontsource/inter/files/inter-cyrillic-400-normal.woff?url';

let fonts: Font[] = [];
const outlineCache = new Map<string, Spline[]>();

/** Glyph lookup with fallback across the loaded subsets. */
function glyphFor(ch: string): { font: Font; glyph: Glyph } | null {
  for (const font of fonts) {
    const idx = font.charToGlyphIndex(ch);
    if (idx > 0) return { font, glyph: font.glyphs.get(idx) };
  }
  if (!fonts.length) return null;
  return { font: fonts[0], glyph: fonts[0].charToGlyph('?') };
}

function bp(co: Vec3): BezierPoint {
  return { co: [...co] as Vec3, handle_left: [...co] as Vec3, handle_right: [...co] as Vec3, handle_left_type: 'FREE', handle_right_type: 'FREE', radius: 1, tilt: 0 };
}

/** Glyph outline (em units, y up) as cyclic Bézier splines. */
function glyphOutline(font: Font, glyph: Glyph): Spline[] {
  const key = `${font.names.fullName?.en}|${glyph.index}`;
  const hit = outlineCache.get(key);
  if (hit) return hit;
  const s = 1 / font.unitsPerEm;
  const out: Spline[] = [];
  let pts: BezierPoint[] = [];
  let cur: Vec3 = [0, 0, 0];
  const close = () => {
    if (pts.length > 1) {
      // the closing point duplicates the first one: merge their handles
      const first = pts[0],
        last = pts[pts.length - 1];
      if (Math.hypot(first.co[0] - last.co[0], first.co[1] - last.co[1]) < 1e-6) {
        first.handle_left = last.handle_left;
        pts.pop();
      }
      if (pts.length >= 2) out.push({ type: 'BEZIER', bezier_points: pts, points: [], use_cyclic_u: true, resolution_u: 0, order_u: 4, use_smooth: false, material_index: 0 });
    }
    pts = [];
  };
  for (const c of glyph.path.commands) {
    if (c.type === 'M') {
      close();
      cur = [c.x * s, c.y * s, 0];
      pts.push(bp(cur));
    } else if (c.type === 'L') {
      const p: Vec3 = [c.x * s, c.y * s, 0];
      const prev = pts[pts.length - 1];
      prev.handle_right = [cur[0] + (p[0] - cur[0]) / 3, cur[1] + (p[1] - cur[1]) / 3, 0];
      const n = bp(p);
      n.handle_left = [p[0] + (cur[0] - p[0]) / 3, p[1] + (cur[1] - p[1]) / 3, 0];
      pts.push(n);
      cur = p;
    } else if (c.type === 'Q') {
      const q: Vec3 = [c.x1 * s, c.y1 * s, 0],
        p: Vec3 = [c.x * s, c.y * s, 0];
      const prev = pts[pts.length - 1];
      prev.handle_right = [cur[0] + (2 / 3) * (q[0] - cur[0]), cur[1] + (2 / 3) * (q[1] - cur[1]), 0];
      const n = bp(p);
      n.handle_left = [p[0] + (2 / 3) * (q[0] - p[0]), p[1] + (2 / 3) * (q[1] - p[1]), 0];
      pts.push(n);
      cur = p;
    } else if (c.type === 'C') {
      const p: Vec3 = [c.x * s, c.y * s, 0];
      pts[pts.length - 1].handle_right = [c.x1 * s, c.y1 * s, 0];
      const n = bp(p);
      n.handle_left = [c.x2 * s, c.y2 * s, 0];
      pts.push(n);
      cur = p;
    } else if (c.type === 'Z') close();
  }
  close();
  outlineCache.set(key, out);
  return out;
}

export interface TextLayout {
  splines: Spline[];
  /** caret positions (x, y of the baseline, in object units) for every character index 0..len */
  carets: [number, number][];
  lineHeight: number;
  size: number;
}

/** Lay out a text body: per-line advance, character/line spacing and alignment. */
export function layoutText(cu: CurveData): TextLayout {
  const body = cu.body ?? '';
  const size = cu.size ?? 1;
  const lineHeight = 1.2 * size * (cu.space_line ?? 1);
  const lines = body.split('\n');
  const splines: Spline[] = [];
  const carets: [number, number][] = [];
  if (!fonts.length) return { splines, carets: [[0, 0]], lineHeight, size };
  const widths = lines.map((line) => {
    let w = 0;
    for (const ch of line) {
      const g = glyphFor(ch);
      if (g) w += ((g.glyph.advanceWidth ?? 0) / g.font.unitsPerEm) * size * (cu.space_character ?? 1);
    }
    return w;
  });
  const total = (lines.length - 1) * lineHeight;
  const yOffset = cu.align_y === 'CENTER' ? total / 2 - size * 0.35 : cu.align_y === 'BOTTOM' ? total : 0;
  lines.forEach((line, li) => {
    const w = widths[li];
    let x = cu.align_x === 'CENTER' ? -w / 2 : cu.align_x === 'RIGHT' ? -w : 0;
    const y = -li * lineHeight + yOffset;
    for (const ch of line) {
      carets.push([x, y]);
      const g = glyphFor(ch);
      if (!g) continue;
      for (const sp of glyphOutline(g.font, g.glyph)) {
        const c: Spline = { ...sp, bezier_points: sp.bezier_points.map((b) => ({ ...b, co: tr(b.co, x, y, size), handle_left: tr(b.handle_left, x, y, size), handle_right: tr(b.handle_right, x, y, size) })) };
        splines.push(c);
      }
      x += ((g.glyph.advanceWidth ?? 0) / g.font.unitsPerEm) * size * (cu.space_character ?? 1);
    }
    carets.push([x, y]); // end of line (the newline character's position)
  });
  return { splines, carets, lineHeight, size };
}

function tr(p: Vec3, x: number, y: number, size: number): Vec3 {
  return [p[0] * size + x, p[1] * size + y, 0];
}

let loading: Promise<void> | null = null;

/** Load the bundled font subsets (once) and install the glyph provider. */
export function loadFonts(onReady: () => void): Promise<void> {
  loading ??= Promise.all(
    [latinUrl, latinExtUrl, greekUrl, cyrillicUrl].map((u) =>
      fetch(u)
        .then((r) => r.arrayBuffer())
        .then((b) => parse(b))
        .catch(() => null),
    ),
  ).then((list) => {
    fonts = list.filter((f): f is Font => !!f);
    setGlyphProvider({ layout: (cu) => layoutText(cu).splines });
    onReady();
  });
  return loading;
}
