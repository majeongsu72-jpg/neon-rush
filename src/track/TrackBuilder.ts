import { Track } from './Track';
import {
  F_BOOST, F_BRIDGE, F_JUMP, F_LOOP, F_TUNNEL,
  type ControlPoint, type ResolvedBoostPad, type ResolvedSection, type TrackDef,
} from './types';
import { clamp, smoothstep } from '../core/math';

const ALPHA = 0.5; // centripetal Catmull-Rom

interface V3 { x: number; y: number; z: number }

function dist(a: V3, b: V3): number {
  const dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/** Barry–Goldman evaluation of a centripetal Catmull-Rom segment P1→P2. */
function catmull(p0: V3, p1: V3, p2: V3, p3: V3, u: number, out: V3): V3 {
  const t0 = 0;
  const t1 = t0 + Math.max(Math.pow(dist(p0, p1), ALPHA), 1e-4);
  const t2 = t1 + Math.max(Math.pow(dist(p1, p2), ALPHA), 1e-4);
  const t3 = t2 + Math.max(Math.pow(dist(p2, p3), ALPHA), 1e-4);
  const t = t1 + (t2 - t1) * u;
  const comp = (a0: number, a1: number, a2: number, a3: number) => {
    const A1 = ((t1 - t) / (t1 - t0)) * a0 + ((t - t0) / (t1 - t0)) * a1;
    const A2 = ((t2 - t) / (t2 - t1)) * a1 + ((t - t1) / (t2 - t1)) * a2;
    const A3 = ((t3 - t) / (t3 - t2)) * a2 + ((t - t2) / (t3 - t2)) * a3;
    const B1 = ((t2 - t) / (t2 - t0)) * A1 + ((t - t0) / (t2 - t0)) * A2;
    const B2 = ((t3 - t) / (t3 - t1)) * A2 + ((t - t1) / (t3 - t1)) * A3;
    return ((t2 - t) / (t2 - t1)) * B1 + ((t - t1) / (t2 - t1)) * B2;
  };
  out.x = comp(p0.x, p1.x, p2.x, p3.x);
  out.y = comp(p0.y, p1.y, p2.y, p3.y);
  out.z = comp(p0.z, p1.z, p2.z, p3.z);
  return out;
}

/** Circular moving average (window ±r samples). */
function smoothCircular(src: Float64Array, r: number, passes = 1): Float64Array {
  const n = src.length;
  let a = src;
  for (let p = 0; p < passes; p++) {
    const out = new Float64Array(n);
    let acc = 0;
    for (let k = -r; k <= r; k++) acc += a[((k % n) + n) % n];
    const inv = 1 / (2 * r + 1);
    for (let i = 0; i < n; i++) {
      out[i] = acc * inv;
      acc += a[(i + r + 1) % n] - a[(((i - r) % n) + n) % n];
    }
    a = out;
  }
  return a;
}

/** Circular Gaussian blur, sigma in samples. */
function gaussCircular(src: Float64Array, sigma: number): Float64Array {
  if (sigma <= 0.01) return src.slice();
  const n = src.length;
  const r = Math.ceil(sigma * 3);
  const w: number[] = [];
  let sum = 0;
  for (let k = -r; k <= r; k++) {
    const v = Math.exp(-(k * k) / (2 * sigma * sigma));
    w.push(v);
    sum += v;
  }
  for (let k = 0; k < w.length; k++) w[k] /= sum;
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let acc = 0;
    for (let k = -r; k <= r; k++) acc += src[(i + k + n) % n] * w[k + r];
    out[i] = acc;
  }
  return out;
}

export function buildTrack(def: TrackDef): Track {
  const pts = def.points;
  const n = pts.length;
  const P = (i: number): ControlPoint => pts[((i % n) + n) % n];

  // 1) Densely sample the closed spline.
  const fine: V3[] = [];
  const cpFine: number[] = [];
  for (let i = 0; i < n; i++) {
    const p0 = P(i - 1), p1 = P(i), p2 = P(i + 1), p3 = P(i + 2);
    const chord = dist(p1, p2);
    const steps = Math.max(4, Math.ceil(chord / 0.4));
    cpFine.push(fine.length);
    for (let k = 0; k < steps; k++) fine.push(catmull(p0, p1, p2, p3, k / steps, { x: 0, y: 0, z: 0 }));
  }
  const fineCount = fine.length;
  const cum = new Float64Array(fineCount + 1);
  for (let i = 1; i <= fineCount; i++) cum[i] = cum[i - 1] + dist(fine[i - 1], fine[i % fineCount]);
  const L = cum[fineCount];
  const cpS = new Float64Array(n);
  for (let i = 0; i < n; i++) cpS[i] = cum[cpFine[i]];

  // 2) Resample uniformly at ~1 m.
  const N = Math.round(L);
  const ds = L / N;
  const px = new Float64Array(N), py = new Float64Array(N), pz = new Float64Array(N);
  let seg = 0;
  for (let j = 0; j < N; j++) {
    const s = j * ds;
    while (seg < fineCount - 1 && cum[seg + 1] < s) seg++;
    const a = fine[seg];
    const b = fine[(seg + 1) % fineCount];
    const len = cum[seg + 1] - cum[seg];
    const f = len > 0 ? (s - cum[seg]) / len : 0;
    px[j] = a.x + (b.x - a.x) * f;
    py[j] = a.y + (b.y - a.y) * f;
    pz[j] = a.z + (b.z - a.z) * f;
  }

  const wrapS = (s: number) => ((s % L) + L) % L;
  const sAtIndex = (idx: number): number => {
    const k = Math.floor(idx);
    const f = idx - k;
    const k0 = ((k % n) + n) % n;
    const s0 = cpS[k0];
    const s1 = k0 + 1 < n ? cpS[k0 + 1] : L;
    return wrapS(s0 + (s1 - s0) * f);
  };

  // Per-point attribute interpolation (smoothstep between control points).
  const attrAt = (s: number, get: (p: ControlPoint) => number): number => {
    let k = 0;
    // binary search control segment
    let lo = 0, hi = n - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (cpS[mid] <= s) {
        k = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    const s0 = cpS[k];
    const s1 = k + 1 < n ? cpS[k + 1] : L;
    const t = s1 > s0 ? smoothstep(0, 1, (s - s0) / (s1 - s0)) : 0;
    return get(P(k)) * (1 - t) + get(P(k + 1)) * t;
  };

  // 3) Resolve sections to s-ranges.
  const sections: ResolvedSection[] = def.sections.map((sd) => ({
    kind: sd.kind,
    s0: sAtIndex(sd.from),
    s1: sAtIndex(sd.to),
    def: sd,
  }));
  const inRange = (s: number, s0: number, s1: number) => (s0 <= s1 ? s >= s0 && s <= s1 : s >= s0 || s <= s1);
  /** 0..1 weight of being inside a section, with `fade` metres of ramp inside each end. */
  const sectionWeight = (s: number, sec: ResolvedSection, fade: number): number => {
    if (!inRange(s, sec.s0, sec.s1)) return 0;
    const fromStart = wrapS(s - sec.s0);
    const toEnd = wrapS(sec.s1 - s);
    return Math.min(smoothstep(0, fade, fromStart), smoothstep(0, fade, toEnd));
  };

  // 3b) Gaussian-smooth the centreline (Catmull-Rom is only C1: curvature jumps
  // at control points). Loops keep a tighter kernel so they stay round.
  {
    const loopW = new Float64Array(N);
    for (const sec of sections) {
      if (sec.kind !== 'loop') continue;
      for (let j = 0; j < N; j++) loopW[j] = Math.max(loopW[j], sectionWeight(j * ds, sec, 25));
    }
    const sig = 3 / ds;
    const sx = gaussCircular(px, sig), sy = gaussCircular(py, sig), sz = gaussCircular(pz, sig);
    const lx = gaussCircular(px, 1 / ds), ly = gaussCircular(py, 1 / ds), lz = gaussCircular(pz, 1 / ds);
    for (let j = 0; j < N; j++) {
      const w = loopW[j];
      px[j] = sx[j] * (1 - w) + lx[j] * w;
      py[j] = sy[j] * (1 - w) + ly[j] * w;
      pz[j] = sz[j] * (1 - w) + lz[j] * w;
    }
  }

  // 4) Tangents.
  const tx = new Float64Array(N), ty = new Float64Array(N), tz = new Float64Array(N);
  for (let j = 0; j < N; j++) {
    const a = (j - 1 + N) % N, b = (j + 1) % N;
    let x = px[b] - px[a], y = py[b] - py[a], z = pz[b] - pz[a];
    const l = Math.hypot(x, y, z) || 1;
    x /= l; y /= l; z /= l;
    tx[j] = x; ty[j] = y; tz[j] = z;
  }

  // 5) Unbanked frames. Normal roads: R = T × worldUp. Loops: fixed axis.
  const rx0 = new Float64Array(N), ry0 = new Float64Array(N), rz0 = new Float64Array(N);
  const loopSecs = sections.filter((s) => s.kind === 'loop');
  let prevR = { x: 1, y: 0, z: 0 };
  for (let j = 0; j < N; j++) {
    const s = j * ds;
    // T × Y = (tz*0 - ty*0?)… explicit: (ty*0 - tz*1, tz*0 - tx*0, tx*1 - ty*0) = (-tz, 0, tx)
    let rxv = -tz[j], ryv = 0, rzv = tx[j];
    let l = Math.hypot(rxv, ryv, rzv);
    if (l < 1e-4) {
      rxv = prevR.x; ryv = prevR.y; rzv = prevR.z;
      l = 1;
    } else {
      rxv /= l; ryv /= l; rzv /= l;
    }
    for (const sec of loopSecs) {
      const w = sectionWeight(s, sec, 14);
      if (w > 0 && sec.def.axis) {
        const [axx, axy, axz] = sec.def.axis;
        const al = Math.hypot(axx, axy, axz) || 1;
        rxv = rxv * (1 - w) + (axx / al) * w;
        ryv = ryv * (1 - w) + (axy / al) * w;
        rzv = rzv * (1 - w) + (axz / al) * w;
      }
    }
    // Orthogonalize against T.
    const d = rxv * tx[j] + ryv * ty[j] + rzv * tz[j];
    rxv -= d * tx[j]; ryv -= d * ty[j]; rzv -= d * tz[j];
    l = Math.hypot(rxv, ryv, rzv) || 1;
    rx0[j] = rxv / l; ry0[j] = ryv / l; rz0[j] = rzv / l;
    prevR = { x: rx0[j], y: ry0[j], z: rz0[j] };
  }
  // U0 = R0 × T
  const ux0 = new Float64Array(N), uy0 = new Float64Array(N), uz0 = new Float64Array(N);
  for (let j = 0; j < N; j++) {
    ux0[j] = ry0[j] * tz[j] - rz0[j] * ty[j];
    uy0[j] = rz0[j] * tx[j] - rx0[j] * tz[j];
    uz0[j] = rx0[j] * ty[j] - ry0[j] * tx[j];
  }

  // 6) Horizontal curvature → auto bank.
  const curvOnto = (ax: Float64Array, ay: Float64Array, az: Float64Array): Float64Array => {
    const out = new Float64Array(N);
    for (let j = 0; j < N; j++) {
      const a = (j - 1 + N) % N, b = (j + 1) % N;
      const kx = (tx[b] - tx[a]) / (2 * ds), ky = (ty[b] - ty[a]) / (2 * ds), kz = (tz[b] - tz[a]) / (2 * ds);
      out[j] = kx * ax[j] + ky * ay[j] + kz * az[j];
    }
    return out;
  };
  const kH = smoothCircular(curvOnto(rx0, ry0, rz0), 18, 2);
  const noBankSecs = sections.filter((s) => s.kind === 'loop' || s.kind === 'noAutoBank');
  const bankRaw = new Float64Array(N);
  const maxBank = (def.maxBank * Math.PI) / 180;
  for (let j = 0; j < N; j++) {
    const s = j * ds;
    let auto = clamp(def.autoBank * kH[j], -maxBank, maxBank);
    for (const sec of noBankSecs) auto *= 1 - sectionWeight(s, sec, 20);
    const manual = (attrAt(s, (p) => p.bank ?? 0) * Math.PI) / 180;
    bankRaw[j] = auto + manual;
  }
  const bank = smoothCircular(bankRaw, 12, 2);

  // 7) Apply bank: rotate R0/U0 around T.
  const rx = new Float64Array(N), ry = new Float64Array(N), rz = new Float64Array(N);
  const ux = new Float64Array(N), uy = new Float64Array(N), uz = new Float64Array(N);
  for (let j = 0; j < N; j++) {
    const c = Math.cos(bank[j]), sn = Math.sin(bank[j]);
    rx[j] = rx0[j] * c - ux0[j] * sn;
    ry[j] = ry0[j] * c - uy0[j] * sn;
    rz[j] = rz0[j] * c - uz0[j] * sn;
    ux[j] = ux0[j] * c + rx0[j] * sn;
    uy[j] = uy0[j] * c + ry0[j] * sn;
    uz[j] = uz0[j] * c + rz0[j] * sn;
  }

  // 8) Final curvatures in the banked frame (±2 stencil, Gaussian σ = 3 m).
  const stencil = (vx: Float64Array, vy: Float64Array, vz: Float64Array, ax: Float64Array, ay: Float64Array, az: Float64Array) => {
    const out = new Float64Array(N);
    for (let j = 0; j < N; j++) {
      const a = (j - 2 + N) % N, b = (j + 2) % N;
      const kx = (vx[b] - vx[a]) / (4 * ds), ky = (vy[b] - vy[a]) / (4 * ds), kz = (vz[b] - vz[a]) / (4 * ds);
      out[j] = kx * ax[j] + ky * ay[j] + kz * az[j];
    }
    return out;
  };
  const kappa = gaussCircular(stencil(tx, ty, tz, rx, ry, rz), 3 / ds);
  const kappaV = gaussCircular(stencil(tx, ty, tz, ux, uy, uz), 3 / ds);
  // torsion of the ruled surface: τ = (dR/ds)·U — needed for the true surface normal at d ≠ 0
  const tau = gaussCircular(stencil(rx, ry, rz, ux, uy, uz), 3 / ds);

  // 9) Width, flags, boost pads.
  const halfWidth = new Float64Array(N);
  for (let j = 0; j < N; j++) halfWidth[j] = attrAt(j * ds, (p) => p.w ?? def.halfWidth);

  const flags = new Uint8Array(N);
  const flagOf: Partial<Record<string, number>> = { tunnel: F_TUNNEL, bridge: F_BRIDGE, loop: F_LOOP, jump: F_JUMP };
  for (const sec of sections) {
    const f = flagOf[sec.kind];
    if (!f) continue;
    for (let j = 0; j < N; j++) if (inRange(j * ds, sec.s0, sec.s1)) flags[j] |= f;
  }
  const boostPads: ResolvedBoostPad[] = (def.boostPads ?? []).map((b) => {
    const s0 = sAtIndex(b.at);
    const len = b.length ?? 14;
    return { s0, s1: wrapS(s0 + len), d: b.d, halfWidth: (b.width ?? 5) / 2 };
  });
  for (const b of boostPads) {
    for (let j = 0; j < N; j++) if (inRange(j * ds, b.s0, b.s1)) flags[j] |= F_BOOST;
  }

  const track = new Track({
    def,
    N,
    length: L,
    arrays: { px, py, pz, tx, ty, tz, rx, ry, rz, ux, uy, uz, kappa, kappaV, tau, halfWidth, bank, flags },
    sections,
    boostPads,
    cpS,
  });
  return track;
}

/** Sanity report printed in dev builds. */
export function validateTrack(track: Track): string[] {
  const warnings: string[] = [];
  let minR = Infinity;
  let minRAt = 0;
  let maxSlope = 0;
  let maxSlopeAt = 0;
  for (let j = 0; j < track.N; j++) {
    const k = Math.abs(track.kappa[j]);
    const hw = track.halfWidth[j];
    if (k > 1e-6) {
      const R = 1 / k;
      if (R < minR) {
        minR = R;
        minRAt = j * track.ds;
      }
      if (R < hw * 1.6) warnings.push(`tight radius ${R.toFixed(1)}m < 1.6×halfWidth at s=${(j * track.ds).toFixed(0)}`);
    }
    if (!(track.flags[j] & F_LOOP)) {
      const slope = Math.abs(track.ty[j]);
      if (slope > maxSlope) {
        maxSlope = slope;
        maxSlopeAt = j * track.ds;
      }
    }
    if (!isFinite(track.px[j] + track.py[j] + track.pz[j] + track.kappa[j])) warnings.push(`NaN at ${j}`);
  }
  if (maxSlope > 0.26) warnings.push(`steep slope ${(Math.asin(maxSlope) * 57.3).toFixed(1)}° at s=${maxSlopeAt.toFixed(0)}`);
  // Self-proximity (non-adjacent samples too close at similar height).
  const step = 4;
  for (let i = 0; i < track.N; i += step) {
    for (let j = i + 60; j < track.N; j += step) {
      if (track.N - j + i < 60) continue;
      const dx = track.px[i] - track.px[j], dz = track.pz[i] - track.pz[j];
      const dy = Math.abs(track.py[i] - track.py[j]);
      const need = track.halfWidth[i] + track.halfWidth[j] + 4;
      if (dx * dx + dz * dz < need * need && dy < 9) {
        warnings.push(`overlap near s=${(i * track.ds).toFixed(0)} & s=${(j * track.ds).toFixed(0)} (dy=${dy.toFixed(1)})`);
        i += 40;
        break;
      }
    }
  }
  const summary = `[track ${track.def.id}] L=${track.length.toFixed(0)}m minR=${minR.toFixed(1)}m@${minRAt.toFixed(0)} maxSlope=${(Math.asin(Math.min(1, maxSlope)) * 57.3).toFixed(1)}°@${maxSlopeAt.toFixed(0)}`;
  return [summary, ...warnings.slice(0, 30)];
}
