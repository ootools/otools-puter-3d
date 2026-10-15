// GLSL library: gradient noise (1–4D), fractal variants, Noise / White Noise / Wave / Magic / Gabor
// textures. Independent implementations of the publicly documented node behaviour.
import type { GlslLib } from './lib';

export const NOISE: GlslLib = {
  nd_perlin: {
    deps: ['nd_hash'],
    code: `
float nd_fade(float t) { return t * t * t * (t * (t * 6.0 - 15.0) + 10.0); }
float nd_g1(uint h, float x) { float g = float(h & 7u) + 1.0; return ((h & 8u) == 0u ? g : -g) * x; }
float nd_g2(uint h, vec2 p) { uint k = h & 7u; float u = k < 4u ? p.x : p.y, v = k < 4u ? p.y : p.x; return ((k & 1u) == 0u ? u : -u) + ((k & 2u) == 0u ? 2.0 * v : -2.0 * v); }
float nd_g3(uint h, vec3 p) { uint k = h & 15u; float u = k < 8u ? p.x : p.y; float v = k < 4u ? p.y : ((k == 12u || k == 14u) ? p.x : p.z); return ((k & 1u) == 0u ? u : -u) + ((k & 2u) == 0u ? v : -v); }
float nd_g4(uint h, vec4 p) { uint k = h & 31u; float u = k < 24u ? p.x : p.y, v = k < 16u ? p.y : p.z, w = k < 8u ? p.z : p.w; return ((k & 1u) == 0u ? u : -u) + ((k & 2u) == 0u ? v : -v) + ((k & 4u) == 0u ? w : -w); }
float nd_snoise(float p) {
  float i = floor(p), f = p - i; int x = int(i);
  float a = nd_g1(nd_hash_u(uint(x)), f), b = nd_g1(nd_hash_u(uint(x + 1)), f - 1.0);
  return 0.25 * mix(a, b, nd_fade(f));
}
float nd_snoise(vec2 p) {
  vec2 i = floor(p), f = p - i; ivec2 c = ivec2(i);
  float a = nd_g2(nd_hash_u(uint(c.x), uint(c.y)), f), b = nd_g2(nd_hash_u(uint(c.x + 1), uint(c.y)), f - vec2(1.0, 0.0));
  float d = nd_g2(nd_hash_u(uint(c.x), uint(c.y + 1)), f - vec2(0.0, 1.0)), e = nd_g2(nd_hash_u(uint(c.x + 1), uint(c.y + 1)), f - vec2(1.0));
  vec2 u = vec2(nd_fade(f.x), nd_fade(f.y));
  return 0.6616 * mix(mix(a, b, u.x), mix(d, e, u.x), u.y) * 0.5;
}
float nd_snoise(vec3 p) {
  vec3 i = floor(p), f = p - i; ivec3 c = ivec3(i);
  vec3 u = vec3(nd_fade(f.x), nd_fade(f.y), nd_fade(f.z));
  float n000 = nd_g3(nd_hash_u(uint(c.x), uint(c.y), uint(c.z)), f);
  float n100 = nd_g3(nd_hash_u(uint(c.x + 1), uint(c.y), uint(c.z)), f - vec3(1, 0, 0));
  float n010 = nd_g3(nd_hash_u(uint(c.x), uint(c.y + 1), uint(c.z)), f - vec3(0, 1, 0));
  float n110 = nd_g3(nd_hash_u(uint(c.x + 1), uint(c.y + 1), uint(c.z)), f - vec3(1, 1, 0));
  float n001 = nd_g3(nd_hash_u(uint(c.x), uint(c.y), uint(c.z + 1)), f - vec3(0, 0, 1));
  float n101 = nd_g3(nd_hash_u(uint(c.x + 1), uint(c.y), uint(c.z + 1)), f - vec3(1, 0, 1));
  float n011 = nd_g3(nd_hash_u(uint(c.x), uint(c.y + 1), uint(c.z + 1)), f - vec3(0, 1, 1));
  float n111 = nd_g3(nd_hash_u(uint(c.x + 1), uint(c.y + 1), uint(c.z + 1)), f - vec3(1, 1, 1));
  return 0.982 * mix(mix(mix(n000, n100, u.x), mix(n010, n110, u.x), u.y), mix(mix(n001, n101, u.x), mix(n011, n111, u.x), u.y), u.z);
}
float nd_snoise(vec4 p) {
  vec4 i = floor(p), f = p - i; ivec4 c = ivec4(i);
  vec4 u = vec4(nd_fade(f.x), nd_fade(f.y), nd_fade(f.z), nd_fade(f.w));
  float r[2];
  for (int w = 0; w < 2; w++) {
    float n[8];
    for (int k = 0; k < 8; k++) {
      ivec4 o = ivec4(k & 1, (k >> 1) & 1, (k >> 2) & 1, w);
      n[k] = nd_g4(nd_hash_u(uint(c.x + o.x), uint(c.y + o.y), uint(c.z + o.z), uint(c.w + o.w)), f - vec4(o));
    }
    r[w] = mix(mix(mix(n[0], n[1], u.x), mix(n[2], n[3], u.x), u.y), mix(mix(n[4], n[5], u.x), mix(n[6], n[7], u.x), u.y), u.z);
  }
  return 0.8344 * mix(r[0], r[1], u.w);
}
`,
  },
  nd_fractal: {
    deps: ['nd_perlin'],
    // generic over the coordinate type via a macro-like template (instantiated per dimension)
    code: ['float', 'vec2', 'vec3', 'vec4']
      .map(
        (T) => `
float nd_fbm(${T} p, float detail, float rough, float lac, bool norm) {
  float fs = 1.0, amp = 1.0, mx = 0.0, sum = 0.0;
  detail = clamp(detail, 0.0, 15.0);
  for (int i = 0; i <= 15; i++) { if (float(i) > detail) break; float t = nd_snoise(fs * p); sum += t * amp; mx += amp; amp *= clamp(rough, 0.0, 1.0); fs *= lac; }
  float rmd = detail - floor(detail);
  if (rmd != 0.0) {
    float t = nd_snoise(fs * p); float sum2 = sum + t * amp;
    return norm ? mix(0.5 * sum / mx + 0.5, 0.5 * sum2 / (mx + amp) + 0.5, rmd) : mix(sum, sum2, rmd);
  }
  return norm ? 0.5 * sum / mx + 0.5 : sum;
}
float nd_multifractal(${T} p, float detail, float rough, float lac) {
  float v = 1.0, pwr = 1.0; detail = clamp(detail, 0.0, 15.0);
  for (int i = 0; i <= 15; i++) { if (float(i) > detail) break; v *= (pwr * nd_snoise(p) + 1.0); pwr *= rough; p *= lac; }
  float rmd = detail - floor(detail); if (rmd != 0.0) v *= (rmd * pwr * nd_snoise(p) + 1.0);
  return v;
}
float nd_hetero(${T} p, float detail, float rough, float lac, float offset) {
  float pwr = rough; detail = clamp(detail, 0.0, 15.0);
  float v = offset + nd_snoise(p); p *= lac;
  for (int i = 1; i <= 15; i++) { if (float(i) > detail) break; float inc = (nd_snoise(p) + offset) * pwr * v; v += inc; pwr *= rough; p *= lac; }
  float rmd = detail - floor(detail); if (rmd != 0.0) v += rmd * ((nd_snoise(p) + offset) * pwr * v);
  return v;
}
float nd_hybrid(${T} p, float detail, float rough, float lac, float offset, float gain) {
  float pwr = rough; detail = clamp(detail, 0.0, 15.0);
  float res = nd_snoise(p) + offset, w = gain * res; p *= lac;
  for (int i = 1; i <= 15; i++) { if (float(i) > detail || w <= 0.001) break; w = min(w, 1.0); float s = (nd_snoise(p) + offset) * pwr; pwr *= rough; res += w * s; w *= gain * s; p *= lac; }
  float rmd = detail - floor(detail); if (rmd != 0.0 && w > 0.001) res += rmd * ((nd_snoise(p) + offset) * pwr);
  return res;
}
float nd_ridged(${T} p, float detail, float rough, float lac, float offset, float gain) {
  float pwr = rough; detail = clamp(detail, 0.0, 15.0);
  float s = offset - abs(nd_snoise(p)); s *= s; float res = s, w = 1.0;
  for (int i = 1; i <= 15; i++) { if (float(i) > detail) break; p *= lac; w = clamp(s * gain, 0.0, 1.0); s = offset - abs(nd_snoise(p)); s *= s; s *= w; res += s * pwr; pwr *= rough; }
  return res;
}
float nd_noise_fractal(int type, ${T} p, float detail, float rough, float lac, float offset, float gain, bool norm) {
  if (type == 0) return nd_multifractal(p, detail, rough, lac);
  if (type == 1) return nd_ridged(p, detail, rough, lac, offset, gain);
  if (type == 2) return nd_hybrid(p, detail, rough, lac, offset, gain);
  if (type == 3) return nd_fbm(p, detail, rough, lac, norm);
  return nd_hetero(p, detail, rough, lac, offset);
}`,
      )
      .join('\n'),
  },
  nd_noise_tex: {
    deps: ['nd_fractal'],
    code: `
float nd_rnd_off(float s) { return 100.0 + nd_hash_f(s) * 100.0; }
// returns (fac, r, g, b)
vec4 nd_noise_tex1(float p, float detail, float rough, float lac, float offset, float gain, float dist, int type, bool norm) {
  if (dist != 0.0) p += nd_snoise(p + nd_rnd_off(0.0)) * dist;
  float f = nd_noise_fractal(type, p, detail, rough, lac, offset, gain, norm);
  return vec4(f, f, nd_noise_fractal(type, p + nd_rnd_off(1.0), detail, rough, lac, offset, gain, norm), nd_noise_fractal(type, p + nd_rnd_off(2.0), detail, rough, lac, offset, gain, norm));
}
vec4 nd_noise_tex2(vec2 p, float detail, float rough, float lac, float offset, float gain, float dist, int type, bool norm) {
  if (dist != 0.0) p += vec2(nd_snoise(p + vec2(nd_rnd_off(0.0), nd_rnd_off(1.0))), nd_snoise(p + vec2(nd_rnd_off(2.0), nd_rnd_off(3.0)))) * dist;
  float f = nd_noise_fractal(type, p, detail, rough, lac, offset, gain, norm);
  return vec4(f, f, nd_noise_fractal(type, p + vec2(nd_rnd_off(4.0), nd_rnd_off(5.0)), detail, rough, lac, offset, gain, norm), nd_noise_fractal(type, p + vec2(nd_rnd_off(6.0), nd_rnd_off(7.0)), detail, rough, lac, offset, gain, norm));
}
vec4 nd_noise_tex3(vec3 p, float detail, float rough, float lac, float offset, float gain, float dist, int type, bool norm) {
  if (dist != 0.0) p += vec3(nd_snoise(p + vec3(nd_rnd_off(0.0), nd_rnd_off(1.0), nd_rnd_off(2.0))), nd_snoise(p + vec3(nd_rnd_off(3.0), nd_rnd_off(4.0), nd_rnd_off(5.0))), nd_snoise(p + vec3(nd_rnd_off(6.0), nd_rnd_off(7.0), nd_rnd_off(8.0)))) * dist;
  float f = nd_noise_fractal(type, p, detail, rough, lac, offset, gain, norm);
  return vec4(f, f, nd_noise_fractal(type, p + vec3(nd_rnd_off(9.0), nd_rnd_off(10.0), nd_rnd_off(11.0)), detail, rough, lac, offset, gain, norm), nd_noise_fractal(type, p + vec3(nd_rnd_off(12.0), nd_rnd_off(13.0), nd_rnd_off(14.0)), detail, rough, lac, offset, gain, norm));
}
vec4 nd_noise_tex4(vec4 p, float detail, float rough, float lac, float offset, float gain, float dist, int type, bool norm) {
  if (dist != 0.0) p += vec4(nd_snoise(p + vec4(nd_rnd_off(0.0), nd_rnd_off(1.0), nd_rnd_off(2.0), nd_rnd_off(3.0))), nd_snoise(p + vec4(nd_rnd_off(4.0), nd_rnd_off(5.0), nd_rnd_off(6.0), nd_rnd_off(7.0))), nd_snoise(p + vec4(nd_rnd_off(8.0), nd_rnd_off(9.0), nd_rnd_off(10.0), nd_rnd_off(11.0))), nd_snoise(p + vec4(nd_rnd_off(12.0), nd_rnd_off(13.0), nd_rnd_off(14.0), nd_rnd_off(15.0)))) * dist;
  float f = nd_noise_fractal(type, p, detail, rough, lac, offset, gain, norm);
  return vec4(f, f, nd_noise_fractal(type, p + vec4(nd_rnd_off(16.0), nd_rnd_off(17.0), nd_rnd_off(18.0), nd_rnd_off(19.0)), detail, rough, lac, offset, gain, norm), nd_noise_fractal(type, p + vec4(nd_rnd_off(20.0), nd_rnd_off(21.0), nd_rnd_off(22.0), nd_rnd_off(23.0)), detail, rough, lac, offset, gain, norm));
}
`,
  },
  nd_white_noise: {
    deps: ['nd_hash'],
    code: `
vec4 nd_white1(float p) { return vec4(nd_hash_f(p), nd_hash_f(vec2(p, 1.0)), nd_hash_f(vec2(p, 2.0)), nd_hash_f(vec2(p, 3.0))); }
vec4 nd_white2(vec2 p) { return vec4(nd_hash_f(p), nd_hash_f(vec3(p, 1.0)), nd_hash_f(vec3(p, 2.0)), nd_hash_f(vec3(p, 3.0))); }
vec4 nd_white3(vec3 p) { return vec4(nd_hash_f(p), nd_hash_f(vec4(p, 1.0)), nd_hash_f(vec4(p, 2.0)), nd_hash_f(vec4(p, 3.0))); }
vec4 nd_white4(vec4 p) { return vec4(nd_hash_f(p), nd_hash_f(p + vec4(13.37, 0.0, 0.0, 0.0)), nd_hash_f(p + vec4(0.0, 17.13, 0.0, 0.0)), nd_hash_f(p + vec4(0.0, 0.0, 19.71, 0.0))); }
`,
  },
  nd_wave: {
    deps: ['nd_fractal'],
    code: `
float nd_wave(vec3 p, int type, int bdir, int rdir, int profile, float dist, float detail, float dscale, float drough, float phase) {
  p = (p + 0.000001) * 0.999999;
  float n;
  if (type == 0) {
    if (bdir == 0) n = p.x * 20.0; else if (bdir == 1) n = p.y * 20.0; else if (bdir == 2) n = p.z * 20.0; else n = (p.x + p.y + p.z) * 10.0;
  } else {
    vec3 r = p;
    if (rdir == 0) r.x = 0.0; else if (rdir == 1) r.y = 0.0; else if (rdir == 2) r.z = 0.0;
    n = length(r) * 20.0;
  }
  n += phase;
  if (dist != 0.0) n += dist * (nd_fbm(p * dscale, detail, drough, 2.0, true) * 2.0 - 1.0);
  if (profile == 0) return 0.5 + 0.5 * sin(n - 1.5707963);
  if (profile == 1) { n /= 6.2831853; return n - floor(n); }
  n /= 6.2831853; return abs(n - floor(n + 0.5)) * 2.0;
}
`,
  },
  nd_magic: {
    code: `
vec4 nd_magic(vec3 p, int depth, float dist) {
  float x = sin((p.x + p.y + p.z) * 5.0), y = cos((-p.x + p.y - p.z) * 5.0), z = -cos((-p.x - p.y + p.z) * 5.0);
  float d = dist;
  for (int i = 0; i < 10; i++) {
    if (i >= depth) break;
    float a = x * d, b = y * d, c = z * d;
    x = cos(b - c) * (i % 2 == 0 ? 1.0 : -1.0);
    y = sin(c + a);
    z = -cos(a - b);
    d *= 0.5 + 0.25 * float(i % 3);
  }
  if (dist != 0.0) { d = 2.0 * dist; x /= d; y /= d; z /= d; }
  vec3 col = vec3(0.5 - x, 0.5 - y, 0.5 - z);
  return vec4(col, (col.r + col.g + col.b) / 3.0);
}
`,
  },
  nd_gabor: {
    deps: ['nd_hash'],
    code: `
vec2 nd_gabor_kernel(vec3 d, float freq, vec3 dir) {
  float r2 = dot(d, d);
  if (r2 >= 1.0) return vec2(0.0);
  float g = exp(-3.14159265 * r2) * (1.0 - smoothstep(0.7, 1.0, sqrt(r2)));
  float ph = 6.2831853 * freq * dot(dir, d);
  return g * vec2(cos(ph), sin(ph));
}
// returns (value, phase, intensity)
vec3 nd_gabor(vec3 p, float scale, float freq, float aniso, vec3 orient, bool is3d) {
  p *= scale;
  if (!is3d) p.z = 0.0;
  vec3 cell = floor(p);
  vec2 sum = vec2(0.0);
  int zr = is3d ? 1 : 0;
  for (int k = -1; k <= 1; k++) {
    if (abs(k) > zr) continue;
    for (int j = -1; j <= 1; j++)
      for (int i = -1; i <= 1; i++) {
        ivec3 c = ivec3(cell) + ivec3(i, j, k);
        for (int n = 0; n < 8; n++) {
          vec4 h = nd_hash4_i(ivec4(c, n));
          vec3 pos = vec3(c) + vec3(h.x, h.y, is3d ? h.z : 0.0);
          float w = h.w < 0.5 ? -1.0 : 1.0;
          vec3 rnd = is3d ? normalize(nd_hash3_i(ivec3(c.x * 7 + n, c.y * 13 - n, c.z * 3 + n)) * 2.0 - 1.0 + 1e-4) : vec3(cos(h.z * 6.2831853), sin(h.z * 6.2831853), 0.0);
          vec3 dir = normalize(mix(rnd, orient, aniso) + 1e-5);
          sum += w * nd_gabor_kernel(p - pos, freq, dir);
        }
      }
  }
  float sd = is3d ? 0.7 : 0.55;
  return vec3(clamp(0.5 + 0.5 * sum.x / (2.0 * sd), 0.0, 1.0), (atan(sum.y, sum.x) + 3.14159265) / 6.2831853, length(sum) / (2.0 * sd));
}
`,
  },
};
