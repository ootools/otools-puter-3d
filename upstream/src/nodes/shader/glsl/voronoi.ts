// GLSL library: Voronoi texture (1–4D; F1, F2, Smooth F1, Distance to Edge, N-Sphere Radius;
// Euclidean / Manhattan / Chebychev / Minkowski; fractal detail). Independent implementation.
import type { GlslLib } from './lib';

interface Dim {
  n: number;
  T: string;
  IT: string;
  /** expression turning ivec cell + offset loop vars into an IT */
  zero: string;
  hashPoint: (c: string) => string;
  hashColor: (c: string) => string;
  sum: (v: string) => string;
  maxc: (v: string) => string;
  toVec4: (v: string) => string;
}

const dims: Dim[] = [
  {
    n: 1,
    T: 'float',
    IT: 'int',
    zero: '0',
    hashPoint: (c) => `nd_hash_i(${c})`,
    hashColor: (c) => `nd_hash3_i(ivec2(${c}, 7))`,
    sum: (v) => v,
    maxc: (v) => v,
    toVec4: (v) => `vec4(${v}, 0.0, 0.0, ${v})`,
  },
  {
    n: 2,
    T: 'vec2',
    IT: 'ivec2',
    zero: 'ivec2(0)',
    hashPoint: (c) => `nd_hash3_i(ivec3(${c}, 3)).xy`,
    hashColor: (c) => `nd_hash3_i(ivec3(${c}, 11))`,
    sum: (v) => `(${v}.x + ${v}.y)`,
    maxc: (v) => `max(${v}.x, ${v}.y)`,
    toVec4: (v) => `vec4(${v}, 0.0, 0.0)`,
  },
  {
    n: 3,
    T: 'vec3',
    IT: 'ivec3',
    zero: 'ivec3(0)',
    hashPoint: (c) => `nd_hash3_i(${c})`,
    hashColor: (c) => `nd_hash3_i(${c} + ivec3(1013, 37, 911))`,
    sum: (v) => `(${v}.x + ${v}.y + ${v}.z)`,
    maxc: (v) => `max(${v}.x, max(${v}.y, ${v}.z))`,
    toVec4: (v) => `vec4(${v}, 0.0)`,
  },
  {
    n: 4,
    T: 'vec4',
    IT: 'ivec4',
    zero: 'ivec4(0)',
    hashPoint: (c) => `nd_hash4_i(${c})`,
    hashColor: (c) => `nd_vcol4(${c})`,
    sum: (v) => `(${v}.x + ${v}.y + ${v}.z + ${v}.w)`,
    maxc: (v) => `max(max(${v}.x, ${v}.y), max(${v}.z, ${v}.w))`,
    toVec4: (v) => v,
  },
];

/** Nested loops over neighbour cells in [-r, r]^n, declaring `IT o`. */
function loops(d: Dim, r: string, body: string) {
  const v = ['vi', 'vj', 'vk', 'vl'].slice(0, d.n);
  let open = '',
    close = '';
  for (const x of v) {
    open += `for (int ${x} = -${r}; ${x} <= ${r}; ${x}++) `;
  }
  const o = d.n === 1 ? 'vi' : `${d.IT}(${v.join(', ')})`;
  open += `{ ${d.IT} o = ${o}; `;
  close = '}';
  return `${open}${body}${close}`;
}

function gen(d: Dim): string {
  const { T, IT } = d;
  const s = d.n;
  return `
float nd_vdist${s}(${T} a, ${T} b, int metric, float e) {
  ${T} q = abs(a - b);
  if (metric == 0) return length(a - b);
  if (metric == 1) return ${d.sum('q')};
  if (metric == 2) return ${d.maxc('q')};
  ${T} pq = pow(q, ${T}(e));
  return pow(${d.sum('pq')}, 1.0 / e);
}
// feature: 0 F1, 1 F2, 2 smooth F1, 3 distance to edge, 4 n-sphere radius
NdVor nd_voronoi${s}_octave(${T} p, int feature, int metric, float e, float smoothness, float rnd) {
  ${T} cellf = floor(p);
  ${IT} cell = ${IT}(cellf);
  ${T} local = p - cellf;
  NdVor r; r.dist = 0.0; r.col = vec3(0.0); r.pos = vec4(0.0); r.radius = 0.0;
  if (feature == 0 || feature == 4) {
    float best = 1e10; ${T} bp = ${T}(0.0); ${IT} bc = ${d.zero};
    ${loops(d, '1', `${T} pt = ${T}(o) + ${d.hashPoint('cell + o')} * rnd; float dd = nd_vdist${s}(pt, local, metric, e); if (dd < best) { best = dd; bp = pt; bc = cell + o; }`)}
    r.dist = best; r.col = ${d.hashColor('bc')}; r.pos = ${d.toVec4('(bp + cellf)')};
    if (feature == 4) {
      // distance from the closest point to its closest neighbouring point
      float nb = 1e10;
      ${IT} cc = bc;
      ${loops(d, '1', `if (o != ${d.zero}) { ${T} pt = ${T}(cc + o) + ${d.hashPoint('cc + o')} * rnd; float dd = distance(pt, ${T}(cc) + ${d.hashPoint('cc')} * rnd); nb = min(nb, dd); }`)}
      r.radius = nb * 0.5;
    }
  } else if (feature == 1) {
    float d1 = 1e10, d2 = 1e10; ${T} p1 = ${T}(0.0), p2 = ${T}(0.0); ${IT} c1 = ${d.zero}, c2 = ${d.zero};
    ${loops(d, '1', `${T} pt = ${T}(o) + ${d.hashPoint('cell + o')} * rnd; float dd = nd_vdist${s}(pt, local, metric, e); if (dd < d1) { d2 = d1; p2 = p1; c2 = c1; d1 = dd; p1 = pt; c1 = cell + o; } else if (dd < d2) { d2 = dd; p2 = pt; c2 = cell + o; }`)}
    r.dist = d2; r.col = ${d.hashColor('c2')}; r.pos = ${d.toVec4('(p2 + cellf)')};
  } else if (feature == 2) {
    float ks = max(smoothness, 1e-4) * 0.25;
    float acc = 0.0; vec3 col = vec3(0.0); ${T} pos = ${T}(0.0); float mn = 1e10;
    ${loops(d, s >= 4 ? '1' : '2', `${T} pt = ${T}(o) + ${d.hashPoint('cell + o')} * rnd; float dd = nd_vdist${s}(pt, local, metric, e); mn = min(mn, dd);`)}
    ${loops(d, s >= 4 ? '1' : '2', `${T} pt = ${T}(o) + ${d.hashPoint('cell + o')} * rnd; float dd = nd_vdist${s}(pt, local, metric, e); float w = exp(-(dd - mn) / ks); acc += w; col += ${d.hashColor('cell + o')} * w; pos += pt * w;`)}
    r.dist = mn - ks * log(acc); r.col = col / acc; r.pos = ${d.toVec4('(pos / acc + cellf)')};
    r.dist = max(r.dist, 0.0);
  } else {
    // distance to edge (euclidean)
    ${T} bp = ${T}(0.0); float best = 1e10;
    ${loops(d, '1', `${T} pt = ${T}(o) + ${d.hashPoint('cell + o')} * rnd; float dd = distance(pt, local); if (dd < best) { best = dd; bp = pt; }`)}
    float edge = 1e10;
    ${loops(d, '2', `${T} pt = ${T}(o) + ${d.hashPoint('cell + o')} * rnd; ${T} dv = pt - bp; float l = length(dv); if (l > 1e-5) edge = min(edge, dot((pt + bp) * 0.5 - local, dv / l));`)}
    r.dist = edge;
  }
  return r;
}
NdVor nd_voronoi${s}(${T} p, float scale, float detail, float rough, float lac, float smoothness, float e, float rnd, int feature, int metric, bool norm) {
  p *= scale;
  rnd = clamp(rnd, 0.0, 1.0);
  detail = clamp(detail, 0.0, 15.0);
  if (feature == 4 || detail == 0.0) {
    NdVor r = nd_voronoi${s}_octave(p, feature, metric, e, smoothness, rnd);
    r.pos /= scale;
    if (norm && feature != 3 && feature != 4) r.dist /= (0.5 + 0.5 * rnd) * (metric == 2 ? 1.0 : (metric == 1 ? float(${s}) : sqrt(float(${s}))));
    return r;
  }
  float amp = 1.0, mxamp = 0.0, sc = 1.0;
  NdVor acc; acc.dist = feature == 3 ? 1e10 : 0.0; acc.col = vec3(0.0); acc.pos = vec4(0.0); acc.radius = 0.0;
  for (int i = 0; i <= 15; i++) {
    if (float(i) > detail) break;
    NdVor o = nd_voronoi${s}_octave(p * sc, feature, metric, e, smoothness, rnd);
    if (feature == 3) { acc.dist = min(acc.dist, o.dist / sc); }
    else {
      acc.dist += o.dist * amp; acc.col += o.col * amp;
      if (i == 0) acc.pos = o.pos / sc;
      mxamp += amp; amp *= clamp(rough, 0.0, 1.0); sc *= lac;
      continue;
    }
    sc *= lac;
  }
  float rmd = detail - floor(detail);
  if (feature != 3) {
    if (rmd != 0.0) {
      NdVor o = nd_voronoi${s}_octave(p * sc, feature, metric, e, smoothness, rnd);
      float d2 = acc.dist + o.dist * amp; vec3 c2 = acc.col + o.col * amp;
      acc.dist = mix(acc.dist / mxamp, d2 / (mxamp + amp), rmd);
      acc.col = mix(acc.col / mxamp, c2 / (mxamp + amp), rmd);
    } else { acc.dist /= mxamp; acc.col /= mxamp; }
    if (norm) acc.dist /= (0.5 + 0.5 * rnd) * (metric == 2 ? 1.0 : (metric == 1 ? float(${s}) : sqrt(float(${s}))));
  }
  acc.pos /= scale;
  return acc;
}`;
}

export const VORONOI: GlslLib = {
  nd_voronoi_struct: {
    code: 'struct NdVor { float dist; vec3 col; vec4 pos; float radius; };',
  },
  nd_voronoi1: { deps: ['nd_hash', 'nd_voronoi_struct'], code: gen(dims[0]) },
  nd_voronoi2: { deps: ['nd_hash', 'nd_voronoi_struct'], code: gen(dims[1]) },
  nd_voronoi3: { deps: ['nd_hash', 'nd_voronoi_struct'], code: gen(dims[2]) },
  nd_voronoi4: {
    deps: ['nd_hash', 'nd_voronoi_struct'],
    code: 'vec3 nd_vcol4(ivec4 c) { return nd_hash3_i(c.xyz + ivec3(c.w * 127, 59, 211)); }\n' + gen(dims[3]),
  },
};
