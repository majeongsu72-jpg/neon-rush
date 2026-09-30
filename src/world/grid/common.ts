import * as THREE from 'three';
import type { Track } from '../../track/Track';
import { F_LOOP } from '../../track/types';

/**
 * Uniforms shared by every HYPER GRID material. Each is a single object
 * referenced by all materials, so the theme updates it once per frame.
 */
export interface GridUniforms {
  uTime: THREE.IUniform<number>;
  /** Scene time wrapped to CLOCK_WRAP s: scrolling patterns stay precise in long sessions. */
  uClock: THREE.IUniform<number>;
  /** Kick envelope 0..1 (audio beat, or a synthetic 128 BPM kick while no beat arrives). */
  uPulse: THREE.IUniform<number>;
  /** Seconds since the last kick onset. */
  uBeatAge: THREE.IUniform<number>;
  /** Track s of the camera at the last onset (origin of the light wave that races down the road). */
  uBeatS: THREE.IUniform<number>;
  /** Camera position at the last onset (centre of the ring wave on the grid floor). */
  uBeatOrigin: THREE.IUniform<THREE.Vector3>;
  uCamS: THREE.IUniform<number>;
  uLen: THREE.IUniform<number>;
  uFar: THREE.IUniform<number>;
}

/**
 * Every pattern scrolls at a rate (Hz) whose product with CLOCK_WRAP is an
 * integer, so the wrap of uClock is invisible.
 */
export const CLOCK_WRAP = 600;

export function makeGridUniforms(shared: { uTime: THREE.IUniform }, length: number): GridUniforms {
  return {
    uTime: shared.uTime as THREE.IUniform<number>,
    uClock: { value: 0 },
    uPulse: { value: 0 },
    uBeatAge: { value: 10 },
    uBeatS: { value: 0 },
    uBeatOrigin: { value: new THREE.Vector3() },
    uCamS: { value: 0 },
    uLen: { value: length },
    uFar: { value: 2600 },
  };
}

/** Fog uniforms for custom ShaderMaterials (fresh objects: UniformsUtils.merge would clone our shared ones). */
export const fogUniforms = (): Record<string, THREE.IUniform> => THREE.UniformsUtils.clone(THREE.UniformsLib.fog);

/** Palette in linear HDR-ready units (multiply for emission). */
export const PAL = {
  cyan: new THREE.Color(0.12, 0.85, 1.0),
  magenta: new THREE.Color(1.0, 0.12, 0.72),
  violet: new THREE.Color(0.45, 0.22, 1.0),
  amber: new THREE.Color(1.0, 0.6, 0.1),
};

/**
 * GLSL shared by the grid shaders: palette, hashes and analytically
 * anti-aliased lines / bands / hexagons (fwidth box filters, so fine
 * patterns fade to their average instead of shimmering at distance).
 */
export const GLSL_COMMON = /* glsl */ `
const vec3 G_CYAN = vec3(0.12, 0.85, 1.0);
const vec3 G_MAGENTA = vec3(1.0, 0.12, 0.72);
const vec3 G_VIOLET = vec3(0.45, 0.22, 1.0);
const vec3 G_AMBER = vec3(1.0, 0.6, 0.1);
const float G_TAU = 6.28318530718;

float gHash11(float p) {
  p = fract(p * 0.1031);
  p *= p + 33.33;
  p *= p + p;
  return fract(p);
}
float gHash21(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
// Coverage of a line of half-width hw at signed distance d, given the pixel
// footprint w of d. Thinner than a pixel, it fades by its area instead of aliasing.
// The *W variants take explicit footprints: derivatives are only reliable in
// uniform control flow and on continuous arguments (not after a wrap).
float gLineW(float d, float hw, float w) {
  w = max(w, 1e-5);
  return clamp((hw + 0.5 * w - abs(d)) / w, 0.0, 1.0) * min(2.0 * hw / w, 1.0);
}
float gLine(float d, float hw) {
  return gLineW(d, hw, fwidth(d));
}
// Coverage of an axis-aligned box of half-size hs around the origin (w = footprints of q).
float gBoxW(vec2 q, vec2 hs, vec2 w) {
  return gLineW(q.x, hs.x, w.x) * gLineW(q.y, hs.y, w.y);
}
// Box-filtered pulse train: 1 on [0, duty) of every unit period of x.
float gPulseInt(float x, float duty) {
  return floor(x) * duty + min(fract(x), duty);
}
float gBandW(float x, float duty, float w) {
  w = max(w, 1e-5);
  return (gPulseInt(x + 0.5 * w, duty) - gPulseInt(x - 0.5 * w, duty)) / w;
}
float gBand(float x, float duty) {
  return gBandW(x, duty, fwidth(x));
}
// Hexagonal tiling: xy = offset from the cell centre, zw = cell id (unit edge-to-edge width).
vec4 gHex(vec2 uv) {
  vec2 r = vec2(1.0, 1.7320508);
  vec2 h = r * 0.5;
  vec2 a = mod(uv, r) - h;
  vec2 b = mod(uv - h, r) - h;
  vec2 gv = dot(a, a) < dot(b, b) ? a : b;
  return vec4(gv, uv - gv);
}
// 0.5 at a hex edge, 0 at the centre.
float gHexDist(vec2 p) {
  p = abs(p);
  return max(dot(p, vec2(0.5, 0.8660254)), p.x);
}
// x wrapped into [-len/2, len/2): signed distance to the nearest multiple of len
// (e.g. along-track distance on a closed circuit of length len).
float gWrap(float x, float len) {
  return x - len * floor(x / len + 0.5);
}
`;

/** Fog for additive materials: fade the contribution to black instead of mixing toward the fog colour. */
export const GLSL_FOG_FADE = /* glsl */ `
#ifdef USE_FOG
  #ifdef FOG_EXP2
    float gFog = 1.0 - exp(-fogDensity * fogDensity * vFogDepth * vFogDepth);
  #else
    float gFog = smoothstep(fogNear, fogFar, vFogDepth);
  #endif
  gl_FragColor.rgb *= 1.0 - gFog;
#endif
`;

/**
 * Kick-drum clock over the audio kick envelope (Music.beat(): jumps to 1 on a
 * kick, decays to 0 within 150 ms). Any rise is an onset, so even a frame that
 * lands late in the envelope at a low frame rate still catches the kick. The
 * pulse gets a short release tail: a glow rather than a strobe. Until a real
 * beat has ever been heard (audio locked / not wired) a gentle synthetic kick
 * at the grid song's 140 BPM keeps the world breathing; after that, musical
 * breakdowns simply calm the world down.
 */
export class BeatClock {
  pulse = 0;
  age = 10;
  count = 0;
  private last = 0;
  private heard = false;
  private waited = 0;
  private synth = 0;

  /** Returns true on a kick onset. */
  update(dt: number, beat: number): boolean {
    this.age += dt;
    this.waited += dt;
    if (beat > 0.02) this.heard = true;
    let onset = false;
    const synthetic = !this.heard && this.waited > 2;
    if (synthetic) {
      const period = 60 / 140;
      this.synth += dt;
      if (this.synth >= period) {
        this.synth %= period;
        onset = true;
      }
    } else if (beat > this.last + 0.04 && beat > 0.06 && this.age > 0.12) {
      onset = true;
    }
    this.last = beat;
    if (onset) {
      this.age = 0;
      this.count++;
    }
    const target = synthetic ? 0.55 * Math.exp(-this.age * 6.5) : beat;
    this.pulse = Math.max(target, this.pulse * Math.exp(-dt * 9));
    return onset;
  }
}

/**
 * Tracks the camera's position along the track (s). Searches locally around
 * the previous answer in 3D, so it stays on the right deck at the crossover
 * and through the loop; falls back to a global search after a teleport.
 */
export class TrackLocator {
  private s = -1;
  private readonly track: Track;

  constructor(track: Track) {
    this.track = track;
  }

  locate(p: THREE.Vector3): number {
    const tr = this.track;
    let best = Infinity;
    let bestS = 0;
    const test = (s: number): void => {
      const i = tr.idx(s);
      const dx = tr.px[i] - p.x, dy = tr.py[i] - p.y, dz = tr.pz[i] - p.z;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 < best) {
        best = d2;
        bestS = s;
      }
    };
    if (this.s >= 0) for (let s = this.s - 40; s <= this.s + 90; s += 2) test(s);
    if (this.s < 0 || best > 45 * 45) {
      best = Infinity;
      for (let s = 0; s < tr.length; s += 4) test(s);
    }
    this.s = tr.wrap(bestS);
    return this.s;
  }
}

/**
 * The infield's heart: the plan point inside the circuit (even-odd rule on the
 * centreline) that is farthest from every part of it.
 */
export function findInfield(track: Track): { x: number; z: number; clearance: number } {
  const pts: number[] = [];
  for (let i = 0; i < track.N; i += 6) pts.push(track.px[i], track.pz[i]);
  const n = pts.length / 2;
  const inside = (x: number, z: number): boolean => {
    let c = false;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const xi = pts[2 * i], zi = pts[2 * i + 1], xj = pts[2 * j], zj = pts[2 * j + 1];
      if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) c = !c;
    }
    return c;
  };
  const b = track.bounds();
  let best = { x: (b.minX + b.maxX) / 2, z: (b.minZ + b.maxZ) / 2, clearance: 0 };
  const steps = 48;
  for (let gx = 1; gx < steps; gx++) {
    for (let gz = 1; gz < steps; gz++) {
      const x = b.minX + ((b.maxX - b.minX) * gx) / steps;
      const z = b.minZ + ((b.maxZ - b.minZ) * gz) / steps;
      if (!inside(x, z)) continue;
      let m = Infinity;
      for (let i = 0; i < n; i++) {
        const dx = pts[2 * i] - x, dz = pts[2 * i + 1] - z;
        m = Math.min(m, dx * dx + dz * dz);
      }
      m = Math.sqrt(m);
      if (m > best.clearance) best = { x, z, clearance: m };
    }
  }
  return best;
}

/** Signed corner strength per track sample (−1..1, + = right-hander), 0 on straights and in loops. */
export function cornerStrength(track: Track, refRadius = 170): Float32Array {
  const N = track.N;
  const raw = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const k = track.kappa[i];
    const loop = track.flags[i] & F_LOOP;
    raw[i] = loop || Math.abs(k) < 1 / 520 ? 0 : Math.max(-1, Math.min(1, k * refRadius));
  }
  // ±12 m box smoothing so chevrons fade in and out
  const out = new Float32Array(N);
  const r = Math.max(1, Math.round(12 / track.ds));
  let acc = 0;
  for (let k = -r; k <= r; k++) acc += raw[(k + N) % N];
  for (let i = 0; i < N; i++) {
    out[i] = acc / (2 * r + 1);
    acc += raw[(i + r + 1) % N] - raw[(i - r + N) % N];
  }
  return out;
}
