import type { Track } from './Track';
import { F_LOOP } from './types';

/**
 * Minimum-curvature racing line: coordinate descent on Σ|Δ²P|² (bending
 * energy), NOT Laplacian smoothing — the latter converges to the shortest path
 * and hugs apexes like a string. The exact per-point minimiser of the bending
 * energy is P* = (−P[i−2k] + 4P[i−k] + 4P[i+k] − P[i+2k]) / 6, projected on the
 * road's right vector and clamped inside the walls. Multigrid strides converge fast.
 */
export function computeRacingLine(track: Track, margin = 2.2): void {
  const N = track.N;
  const { px, py, pz, rx, ry, rz, halfWidth, flags } = track;
  const d = new Float64Array(N);
  const lim = new Float64Array(N);
  for (let i = 0; i < N; i++) lim[i] = flags[i] & F_LOOP ? 0 : Math.max(0, halfWidth[i] - margin);

  const qx = (i: number) => px[i] + rx[i] * d[i];
  const qy = (i: number) => py[i] + ry[i] * d[i];
  const qz = (i: number) => pz[i] + rz[i] * d[i];

  const schedule: [number, number][] = [
    [16, 300],
    [8, 300],
    [4, 250],
    [2, 200],
    [1, 120],
  ];
  for (const [k, iters] of schedule) {
    for (let it = 0; it < iters; it++) {
      for (let i = 0; i < N; i += k) {
        const a2 = (i - 2 * k + N * 4) % N, a1 = (i - k + N * 4) % N;
        const b1 = (i + k) % N, b2 = (i + 2 * k) % N;
        const sx = (-qx(a2) + 4 * qx(a1) + 4 * qx(b1) - qx(b2)) / 6;
        const sy = (-qy(a2) + 4 * qy(a1) + 4 * qy(b1) - qy(b2)) / 6;
        const sz = (-qz(a2) + 4 * qz(a1) + 4 * qz(b1) - qz(b2)) / 6;
        let target = (sx - px[i]) * rx[i] + (sy - py[i]) * ry[i] + (sz - pz[i]) * rz[i];
        const l = lim[i];
        if (target > l) target = l;
        else if (target < -l) target = -l;
        d[i] += 0.5 * (target - d[i]);
      }
    }
    // Interpolate the skipped points for the next (finer) level.
    if (k > 1) {
      for (let i = 0; i < N; i += k) {
        const j = (i + k) % N;
        for (let m = 1; m < k && i + m < N; m++) {
          const t = m / k;
          const v = d[i] * (1 - t) + d[j] * t;
          const idx = i + m;
          d[idx] = Math.max(-lim[idx], Math.min(lim[idx], v));
        }
      }
    }
  }
  // Gaussian (σ ≈ 4 m) to remove ripples, then re-clamp.
  const sm = new Float64Array(N);
  const r = 12;
  const w: number[] = [];
  let ws = 0;
  for (let k = -r; k <= r; k++) {
    const v = Math.exp(-(k * k) / (2 * 16));
    w.push(v);
    ws += v;
  }
  for (let i = 0; i < N; i++) {
    let acc = 0;
    for (let k = -r; k <= r; k++) acc += d[(i + k + N) % N] * w[k + r];
    sm[i] = Math.max(-lim[i], Math.min(lim[i], acc / ws));
  }
  track.lineD = sm;

  // Signed in-surface curvature of the line (circumcircle of projected points).
  const kap = new Float64Array(N);
  const m = 5;
  for (let i = 0; i < N; i++) {
    const a = (i - m + N) % N, b = (i + m) % N;
    const qx = px[i] + rx[i] * sm[i], qy = py[i] + ry[i] * sm[i], qz = pz[i] + rz[i] * sm[i];
    const ax = px[a] + rx[a] * sm[a] - qx, ay = py[a] + ry[a] * sm[a] - qy, az = pz[a] + rz[a] * sm[a] - qz;
    const bx = px[b] + rx[b] * sm[b] - qx, by = py[b] + ry[b] * sm[b] - qy, bz = pz[b] + rz[b] * sm[b] - qz;
    // project onto local (T, R) plane
    const tX = track.tx[i], tY = track.ty[i], tZ = track.tz[i];
    const a1 = ax * tX + ay * tY + az * tZ, a2 = ax * rx[i] + ay * ry[i] + az * rz[i];
    const b1 = bx * tX + by * tY + bz * tZ, b2 = bx * rx[i] + by * ry[i] + bz * rz[i];
    const cross = a1 * b2 - a2 * b1;
    const la = Math.hypot(a1, a2), lb = Math.hypot(b1, b2), lc = Math.hypot(b1 - a1, b2 - a2);
    const denom = la * lb * lc;
    // For a right turn the prev point lies at -T, +R side... sign: cross < 0 → right turn.
    kap[i] = denom > 1e-6 ? (-2 * cross) / denom : 0;
    if (track.flags[i] & F_LOOP) kap[i] = 0;
  }
  track.lineKappa = kap;
}

export interface SpeedProfileParams {
  vTop: number;
  aLat: number;
  aBrake: number;
  accel: (v: number) => number;
}

/** Max-speed profile along the racing line for a given car capability. */
export function computeSpeedProfile(track: Track, p: SpeedProfileParams): Float64Array {
  const N = track.N;
  const v = new Float64Array(N);
  const kap = track.lineKappa;
  // Sliding max of |κ| (±14 m): S-bends need steering/yaw transients that the
  // steady-state formula ignores, so treat each point as tight as its neighbourhood.
  const W = Math.round(14 / track.ds);
  const kmax = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    let m = 0;
    for (let k = -W; k <= W; k++) {
      const a = Math.abs(kap[(i + k + N) % N]);
      if (a > m) m = a;
    }
    // sign flips inside the window (S-bend) add a transient penalty
    const a0 = kap[(i - W + N) % N], a1 = kap[(i + W) % N];
    if (a0 * a1 < 0) m *= 1 + Math.min(Math.abs(a0), Math.abs(a1)) / Math.max(1e-6, m) * 0.6;
    kmax[i] = m;
  }
  for (let i = 0; i < N; i++) {
    const k = kmax[i];
    v[i] = Math.min(p.vTop, k > 1e-6 ? Math.sqrt(p.aLat / k) : p.vTop);
  }
  // segment lengths along the line
  const seg = new Float64Array(N);
  const { px, py, pz, rx, ry, rz, lineD } = track;
  for (let i = 0; i < N; i++) {
    const j = (i + 1) % N;
    seg[i] = Math.hypot(
      px[j] + rx[j] * lineD[j] - px[i] - rx[i] * lineD[i],
      py[j] + ry[j] * lineD[j] - py[i] - ry[i] * lineD[i],
      pz[j] + rz[j] * lineD[j] - pz[i] - rz[i] * lineD[i],
    );
  }
  for (let pass = 0; pass < 2; pass++) {
    for (let i = N - 1; i >= 0; i--) {
      const j = (i + 1) % N;
      const lim = Math.sqrt(v[j] * v[j] + 2 * p.aBrake * seg[i]);
      if (v[i] > lim) v[i] = lim;
    }
  }
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 0; i < N; i++) {
      const j = (i - 1 + N) % N;
      const lim = Math.sqrt(v[j] * v[j] + 2 * Math.max(0.5, p.accel(v[j])) * seg[j]);
      if (v[i] > lim) v[i] = lim;
    }
  }
  return v;
}

export function lapTimeOf(track: Track, v: Float64Array): number {
  let t = 0;
  for (let i = 0; i < track.N; i++) t += track.ds / Math.max(1, v[i]);
  return t;
}
