// Small, allocation-free math helpers shared by every system.

export const TAU = Math.PI * 2;
export const DEG = Math.PI / 180;

export const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);
export const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
export const invLerp = (a: number, b: number, v: number): number => (a === b ? 0 : (v - a) / (b - a));
export const remap = (v: number, a0: number, a1: number, b0: number, b1: number): number =>
  lerp(b0, b1, clamp01(invLerp(a0, a1, v)));

export const smoothstep = (e0: number, e1: number, x: number): number => {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
};

/** Frame-rate independent exponential smoothing: moves `a` toward `b` with rate `lambda` (1/s). */
export const damp = (a: number, b: number, lambda: number, dt: number): number =>
  lerp(a, b, 1 - Math.exp(-lambda * dt));

/** Move `a` toward `b` by at most `maxDelta`. */
export const approach = (a: number, b: number, maxDelta: number): number =>
  a < b ? Math.min(a + maxDelta, b) : Math.max(a - maxDelta, b);

/** Positive modulo. */
export const mod = (a: number, n: number): number => ((a % n) + n) % n;

/** Wrap an angle into (-PI, PI]. */
export const wrapAngle = (a: number): number => {
  a = mod(a + Math.PI, TAU) - Math.PI;
  return a;
};

export const sign = (v: number): number => (v > 0 ? 1 : v < 0 ? -1 : 0);

export const easeOutCubic = (t: number): number => 1 - Math.pow(1 - clamp01(t), 3);
export const easeInCubic = (t: number): number => Math.pow(clamp01(t), 3);
export const easeInOutCubic = (t: number): number => {
  t = clamp01(t);
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
};
export const easeOutBack = (t: number): number => {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  t = clamp01(t);
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
};
export const easeOutElastic = (t: number): number => {
  t = clamp01(t);
  if (t === 0 || t === 1) return t;
  return Math.pow(2, -10 * t) * Math.sin((t * 10 - 0.75) * (TAU / 3)) + 1;
};

// ---------------------------------------------------------------------------
// Hashing / noise

/** Integer hash → [0,1). Deterministic, fast. */
export function hash1(n: number): number {
  let x = (n | 0) ^ 0x9e3779b9;
  x = Math.imul(x ^ (x >>> 16), 0x85ebca6b);
  x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35);
  x ^= x >>> 16;
  return (x >>> 0) / 4294967296;
}

export function hash2(x: number, y: number): number {
  return hash1(Math.imul(x | 0, 73856093) ^ Math.imul(y | 0, 19349663));
}

export function hash3(x: number, y: number, z: number): number {
  return hash1(Math.imul(x | 0, 73856093) ^ Math.imul(y | 0, 19349663) ^ Math.imul(z | 0, 83492791));
}

/** Smooth 1D value noise in [-1, 1]. */
export function noise1(x: number, seed = 0): number {
  const i = Math.floor(x);
  const f = x - i;
  const u = f * f * (3 - 2 * f);
  const a = hash2(i, seed) * 2 - 1;
  const b = hash2(i + 1, seed) * 2 - 1;
  return a + (b - a) * u;
}

/** Smooth 2D value noise in [-1, 1]. */
export function noise2(x: number, y: number, seed = 0): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);
  const a = hash3(ix, iy, seed);
  const b = hash3(ix + 1, iy, seed);
  const c = hash3(ix, iy + 1, seed);
  const d = hash3(ix + 1, iy + 1, seed);
  return (a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy) * 2 - 1;
}

/** Fractal Brownian motion over noise2, roughly in [-1, 1]. */
export function fbm2(x: number, y: number, octaves = 5, seed = 0, lacunarity = 2.03, gain = 0.5): number {
  let amp = 0.5;
  let sum = 0;
  let norm = 0;
  let fx = x;
  let fy = y;
  for (let o = 0; o < octaves; o++) {
    sum += amp * noise2(fx, fy, seed + o * 17);
    norm += amp;
    amp *= gain;
    fx *= lacunarity;
    fy *= lacunarity;
  }
  return sum / norm;
}

/** Ridged fbm (sharp crests) in [0, 1]. */
export function ridged2(x: number, y: number, octaves = 5, seed = 0): number {
  let amp = 0.5;
  let sum = 0;
  let norm = 0;
  let fx = x;
  let fy = y;
  for (let o = 0; o < octaves; o++) {
    const n = 1 - Math.abs(noise2(fx, fy, seed + o * 31));
    sum += amp * n * n;
    norm += amp;
    amp *= 0.5;
    fx *= 2.1;
    fy *= 2.1;
  }
  return sum / norm;
}

// ---------------------------------------------------------------------------
// Formatting

/** 83.456 → "1:23.456" */
export function formatTime(t: number, withMs = true): string {
  if (!isFinite(t) || t < 0) return withMs ? '-:--.---' : '-:--';
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  if (!withMs) return `${m}:${Math.floor(s).toString().padStart(2, '0')}`;
  const whole = Math.floor(s);
  const ms = Math.floor((s - whole) * 1000);
  return `${m}:${whole.toString().padStart(2, '0')}.${ms.toString().padStart(3, '0')}`;
}

/** Signed delta, e.g. "-0.342" / "+1.204" */
export function formatDelta(dt: number): string {
  const sgn = dt < 0 ? '-' : '+';
  return `${sgn}${Math.abs(dt).toFixed(3)}`;
}

export function formatInt(n: number): string {
  return Math.round(n).toLocaleString('en-US');
}

export function ordinal(n: number): string {
  const s = ['TH', 'ST', 'ND', 'RD'];
  const v = n % 100;
  return s[(v - 20) % 10] || s[v] || s[0];
}
