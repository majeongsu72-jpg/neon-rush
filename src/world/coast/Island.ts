import type { Track } from '../../track/Track';
import type { ResolvedSection } from '../../track/types';
import { clamp, fbm2, ridged2, smoothstep } from '../../core/math';

/**
 * SUNSET COAST geography: one continuous height function for the whole island,
 * derived from the track itself so land, sea and road always agree.
 *
 * - The circuit runs clockwise, so the island interior is on the driver's
 *   right (d > 0) and the open sea on the left.
 * - Outside the loop the coastline sits `coastOffset(s)` metres from the
 *   centreline: sandy beaches where the road is low, sheer cliffs where it is
 *   high (cliffiness follows a smoothed road height).
 * - Inside, rolling hills grow with distance from the road; a lagoon opens
 *   under the bridge; a headland covers the tunnel; a rocky knoll carries the
 *   lighthouse at the hairpin.
 * - Finally the road corridor is carved/filled to sit just below the asphalt
 *   (never raised under the bridge, always buried above the tunnel).
 *
 * Pure math (no three.js objects) so it can be profiled and plotted offline.
 */

export interface GroundSample {
  /** Final terrain height (m). */
  h: number;
  /** Height before the road corridor was carved. */
  natural: number;
  /** Nearest centreline position. */
  s: number;
  /** Signed lateral offset (+ = right = island interior). */
  d: number;
  /** Horizontal distance to the centreline. */
  dist: number;
  /** 0..1 how strongly the road corridor shaped this point. */
  road: number;
  /** 0..1 extra rockiness (cliff faces, lighthouse point). */
  rock: number;
  /** Signed distance to the lagoon shore (+ = dry side). */
  lagoon: number;
}

interface Disc {
  x: number;
  z: number;
  r: number;
}

const SEA_FLOOR = -30;
/** Terrain sits this far below the asphalt inside the road corridor. */
export const ROAD_CLEARANCE = 0.6;
/** Half-width of the flat shoulder beyond the road edge before blending out. */
const SHOULDER = 6;
const BLEND = 30;
/** Minimum cover over the tunnel roof (road + this). */
const TUNNEL_COVER = 11.5;

export class Island {
  readonly track: Track;
  readonly x0: number;
  readonly z0: number;
  readonly x1: number;
  readonly z1: number;
  readonly cell: number;
  readonly nx: number;
  readonly nz: number;
  /** Lighthouse site on the rocky point outside the hairpin. */
  readonly lighthouse: { x: number; z: number; y: number };
  readonly lagoonDiscs: Disc[] = [];
  /** Tunnel mouths: s of the headwall and the direction (+1/-1) that leads into the tunnel. */
  readonly portals: { s: number; dir: number; x: number; z: number }[] = [];

  private readonly fS: Float32Array;
  private readonly fDist: Float32Array;
  /** Base-height node grid (3 × cell spacing). */
  private readonly fB: Float32Array;
  private readonly bnx: number;
  private readonly bnz: number;
  private readonly coastTab: Float32Array;
  private readonly bridge: ResolvedSection | null;
  private readonly tunnel: ResolvedSection | null;
  private readonly headA: [number, number];
  private readonly headB: [number, number];
  private readonly seed: number;

  constructor(track: Track, seed = 7, cell = 8) {
    this.track = track;
    this.seed = seed;
    this.cell = cell;
    const b = track.bounds();
    const margin = 380;
    this.x0 = Math.floor((b.minX - margin) / cell) * cell;
    this.z0 = Math.floor((b.minZ - margin) / cell) * cell;
    this.nx = Math.ceil((b.maxX + margin - this.x0) / cell);
    this.nz = Math.ceil((b.maxZ + margin - this.z0) / cell);
    this.x1 = this.x0 + this.nx * cell;
    this.z1 = this.z0 + this.nz * cell;
    this.bridge = track.sectionsOf('bridge')[0] ?? null;
    this.tunnel = track.sectionsOf('tunnel')[0] ?? null;

    this.coastTab = this.buildCoastTable();
    const n = this.nx * this.nz;
    this.fS = new Float32Array(n);
    this.fDist = new Float32Array(n);
    this.bnx = Math.ceil(this.nx / 3) + 2;
    this.bnz = Math.ceil(this.nz / 3) + 2;
    this.fB = new Float32Array(this.bnx * this.bnz);
    this.buildField();

    // Headland capsule along the tunnel.
    const t = this.tunnel;
    if (t) {
      this.headA = [track.lerp(track.px, t.s0), track.lerp(track.pz, t.s0)];
      this.headB = [track.lerp(track.px, t.s1), track.lerp(track.pz, t.s1)];
      this.portals.push({ s: t.s0, dir: 1, x: this.headA[0], z: this.headA[1] });
      this.portals.push({ s: t.s1, dir: -1, x: this.headB[0], z: this.headB[1] });
    } else {
      this.headA = this.headB = [1e9, 1e9];
    }

    this.buildLagoon();

    // Lighthouse: on the outside of the hairpin apex, ~22 m beyond the kerb.
    const lh = track.sectionsOf('lighthouse')[0];
    if (lh) {
      const sm = lh.s0 + track.wrap(lh.s1 - lh.s0) / 2;
      const hw = track.halfWidthAt(sm);
      const rx = track.lerp(track.rx, sm), rz = track.lerp(track.rz, sm);
      const rl = Math.hypot(rx, rz) || 1;
      const off = -(hw + 24);
      this.lighthouse = {
        x: track.lerp(track.px, sm) + (rx / rl) * off,
        z: track.lerp(track.pz, sm) + (rz / rl) * off,
        y: 0,
      };
    } else {
      this.lighthouse = { x: 1e9, z: 1e9, y: 0 };
    }
    this.lighthouse.y = this.heightAt(this.lighthouse.x, this.lighthouse.z);
  }

  // ---------------------------------------------------------------- setup

  /** Coast offset (centreline → waterline on the sea side) per metre of s. */
  private buildCoastTable(): Float32Array {
    const tr = this.track;
    const L = tr.length;
    const sec = (k: Parameters<Track['sectionsOf']>[0], i = 0) => tr.sectionsOf(k)[i];
    const cliff = sec('cliff');
    const br = sec('bridge');
    const tun = sec('tunnel');
    const lh = sec('lighthouse');
    const beaches = tr.sectionsOf('beach');
    const keys: [number, number][] = [[0, 96]];
    if (beaches[0]) keys.push([beaches[0].s1, 92]);
    if (cliff) {
      keys.push([cliff.s0, 64], [cliff.s0 + 160, 56], [cliff.s1 - 300, 52], [cliff.s1 - 140, 38], [cliff.s1, 42]);
    }
    if (br) {
      keys.push([br.s0 - 12, 40], [br.s0 + 60, -420], [br.s1 - 62, -420]);
    }
    if (tun) {
      keys.push([tun.s0 + 4, 96], [tun.s1, 86], [tun.s1 + 260, 62]);
    }
    if (lh) {
      keys.push([lh.s0 - 140, 52], [sectionMid(tr, lh), 40], [lh.s1 + 70, 62]);
    }
    if (beaches[1]) keys.push([beaches[1].s0 + 60, 92], [beaches[1].s1, 96]);
    keys.push([L, 96]);
    keys.sort((a, c) => a[0] - c[0]);
    const n = Math.ceil(L) + 1;
    const tab = new Float32Array(n);
    let k = 0;
    for (let i = 0; i < n; i++) {
      const s = Math.min(i, L);
      while (k < keys.length - 2 && keys[k + 1][0] <= s) k++;
      const [sa, va] = keys[k];
      const [sb, vb] = keys[k + 1];
      const f = sb > sa ? smoothstep(0, 1, (s - sa) / (sb - sa)) : 0;
      // irregular shore: gentle bays on the beaches, coves and points on the cliffs
      const high = smoothstep(6, 16, tr.lerp(tr.py, s));
      const wob = (6 + 9 * high) * fbm2(s / 150, 3.7, 3, this.seed + 11) + 7 * high * fbm2(s / 48, 9.1, 2, this.seed + 12);
      tab[i] = va + (vb - va) * f + (va > 0 && vb > 0 ? wob : 0);
    }
    return tab;
  }

  /** Nearest-centreline field + smoothed road height on a coarse grid. */
  private buildField(): void {
    const tr = this.track;
    const N = tr.N;
    const cStep = Math.max(1, Math.round(24 / tr.ds));
    const nc = Math.ceil(N / cStep);
    const cx = new Float64Array(nc), cz = new Float64Array(nc), cy = new Float64Array(nc);
    for (let k = 0; k < nc; k++) {
      const i = k * cStep;
      cx[k] = tr.px[i];
      cz[k] = tr.pz[i];
      cy[k] = tr.py[i];
    }
    // Smooth base height (inverse-distance weighted road height) on a 3× coarser
    // node grid: it varies over ~50 m, so bilinear interpolation is exact enough.
    const R0 = 55 * 55;
    const bc = this.cell * 3;
    for (let jb = 0; jb < this.bnz; jb++) {
      const z = this.z0 + jb * bc;
      for (let ib = 0; ib < this.bnx; ib++) {
        const x = this.x0 + ib * bc;
        let wsum = 0, ysum = 0;
        for (let k = 0; k < nc; k++) {
          const dx = cx[k] - x, dz = cz[k] - z;
          const q = dx * dx + dz * dz + R0;
          const w = 1 / (q * q);
          wsum += w;
          ysum += w * cy[k];
        }
        this.fB[jb * this.bnx + ib] = ysum / wsum;
      }
    }
    const c = this.cell;
    for (let iz = 0; iz < this.nz; iz++) {
      const z = this.z0 + (iz + 0.5) * c;
      for (let ix = 0; ix < this.nx; ix++) {
        const x = this.x0 + (ix + 0.5) * c;
        let best = Infinity, bk = 0;
        for (let k = 0; k < nc; k++) {
          const dx = cx[k] - x, dz = cz[k] - z;
          const d2 = dx * dx + dz * dz;
          if (d2 < best) {
            best = d2;
            bk = k;
          }
        }
        // refine at full resolution around the coarse winner
        let bi = bk * cStep;
        const i0 = bi;
        for (let j = -cStep * 2; j <= cStep * 2; j++) {
          const i = (((i0 + j) % N) + N) % N;
          const dx = tr.px[i] - x, dz = tr.pz[i] - z;
          const d2 = dx * dx + dz * dz;
          if (d2 < best) {
            best = d2;
            bi = i;
          }
        }
        const o = iz * this.nx + ix;
        this.fS[o] = bi * tr.ds;
        this.fDist[o] = Math.sqrt(best);
      }
    }
  }

  /** Lagoon under the bridge: a smooth union of discs kept clear of every other road. */
  private buildLagoon(): void {
    const tr = this.track;
    const br = this.bridge;
    const cliff = tr.sectionsOf('cliff')[0];
    if (!br || !cliff) return;
    const brLen = tr.wrap(br.s1 - br.s0);
    const clear = (x: number, z: number, skipBridge: boolean): number => {
      let best = Infinity;
      for (let i = 0; i < tr.N; i += 3) {
        const s = i * tr.ds;
        if (skipBridge && tr.inRange(s, br.s0 + 30, br.s1 - 30)) continue;
        const d = Math.hypot(tr.px[i] - x, tr.pz[i] - z);
        if (d < best) best = d;
      }
      return best;
    };
    // Chain hugging the inner side of the bridge (water right under the deck).
    for (let a = 55; a < brLen - 60; a += 42) {
      const s = br.s0 + a;
      const hw = tr.halfWidthAt(s);
      const rx = tr.lerp(tr.rx, s), rz = tr.lerp(tr.rz, s);
      const rl = Math.hypot(rx, rz) || 1;
      const x = tr.lerp(tr.px, s) + (rx / rl) * (hw + 44);
      const z = tr.lerp(tr.pz, s) + (rz / rl) * (hw + 44);
      const r = Math.min(76, clear(x, z, true) - 40);
      if (r > 40) this.lagoonDiscs.push({ x, z, r });
    }
    // Body of the lagoon: between the clifftop ridge and the bridge.
    const ridgeS = [0.18, 0.3, 0.42, 0.54, 0.62].map((f) => cliff.s0 + f * tr.wrap(cliff.s1 - cliff.s0));
    const brS = [0.95, 0.78, 0.6, 0.42, 0.2].map((f) => br.s0 + f * brLen);
    for (let k = 0; k < ridgeS.length; k++) {
      const ax = tr.lerp(tr.px, ridgeS[k]), az = tr.lerp(tr.pz, ridgeS[k]);
      const bx = tr.lerp(tr.px, brS[k]), bz = tr.lerp(tr.pz, brS[k]);
      const x = (ax + bx) / 2, z = (az + bz) / 2;
      const r = clear(x, z, true) - 78;
      if (r > 60) this.lagoonDiscs.push({ x, z, r });
    }
  }

  // ---------------------------------------------------------------- queries

  private coastAt(s: number): number {
    const tab = this.coastTab;
    const x = clamp(this.track.wrap(s), 0, tab.length - 1.001);
    const i = Math.floor(x);
    return tab[i] + (tab[i + 1] - tab[i]) * (x - i);
  }

  /** Smooth-union signed distance to the lagoon shore (+ outside the water). */
  lagoonDist(x: number, z: number): number {
    const k = 42;
    let res = 1e5;
    for (const c of this.lagoonDiscs) {
      const ex = x - c.x, ez = z - c.z;
      const d = Math.sqrt(ex * ex + ez * ez) - c.r;
      // polynomial smooth min
      const h = clamp(0.5 + (0.5 * (d - res)) / k, 0, 1);
      res = d * (1 - h) + res * h - k * h * (1 - h);
    }
    // wavy shoreline (small coves and sand spits)
    if (res < 90) res += 16 * fbm2(x / 95, z / 95, 3, this.seed + 41);
    return res;
  }

  private fieldIndex(x: number, z: number): number {
    const ix = clamp(Math.floor((x - this.x0) / this.cell), 0, this.nx - 1);
    const iz = clamp(Math.floor((z - this.z0) / this.cell), 0, this.nz - 1);
    return iz * this.nx + ix;
  }

  private baseAt(x: number, z: number): number {
    const bc = this.cell * 3;
    const fx = clamp((x - this.x0) / bc, 0, this.bnx - 1.001);
    const fz = clamp((z - this.z0) / bc, 0, this.bnz - 1.001);
    const ix = Math.floor(fx), iz = Math.floor(fz);
    const tx = fx - ix, tz = fz - iz;
    const o = iz * this.bnx + ix;
    const B = this.fB;
    const a = B[o] + (B[o + 1] - B[o]) * tx;
    const c = B[o + this.bnx] + (B[o + this.bnx + 1] - B[o + this.bnx]) * tx;
    return a + (c - a) * tz;
  }

  /** 0..1 weight of being inside a section, ramping over `fade` metres inside each end. */
  private secWeight(sec: ResolvedSection | null, s: number, fade: number): number {
    if (!sec || !this.track.inRange(s, sec.s0, sec.s1)) return 0;
    const a = this.track.wrap(s - sec.s0), b = this.track.wrap(sec.s1 - s);
    return Math.min(smoothstep(0, fade, a), smoothstep(0, fade, b));
  }

  heightAt(x: number, z: number): number {
    return this.sample(x, z, tmpSample).h;
  }

  /**
   * True inside a tunnel mouth: the strip across the corridor from `reachOut`
   * metres in front of a headwall to `reachIn` metres behind it, where the
   * heightfield ramps through the tunnel volume (those triangles are dropped
   * and the headwall/aprons cover the gap).
   */
  inPortalMouth(x: number, z: number, reachOut: number, reachIn: number): boolean {
    for (const p of this.portals) {
      if (Math.abs(x - p.x) > 70 || Math.abs(z - p.z) > 70) continue;
      const q = this.sample(x, z, tmpMouth);
      const a = this.track.delta(p.s, q.s) * p.dir; // + = inside the tunnel
      const hw = this.track.halfWidthAt(q.s);
      if (Math.abs(q.d) < hw + 5 && a > -reachOut && a < reachIn) return true;
    }
    return false;
  }

  /** Smallest centreline distance over the coarse field inside a rectangle. */
  minRoadDist(xa: number, za: number, xb: number, zb: number): number {
    const c = this.cell;
    const i0 = clamp(Math.floor((xa - this.x0) / c), 0, this.nx - 1), i1 = clamp(Math.floor((xb - this.x0) / c), 0, this.nx - 1);
    const j0 = clamp(Math.floor((za - this.z0) / c), 0, this.nz - 1), j1 = clamp(Math.floor((zb - this.z0) / c), 0, this.nz - 1);
    let best = Infinity;
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) best = Math.min(best, this.fDist[j * this.nx + i]);
    // outside the field everything is far away
    if (xb < this.x0 || xa > this.x1 || zb < this.z0 || za > this.z1) return Infinity;
    return best;
  }

  /** Full terrain query. Allocation-free when `out` is reused. */
  sample(x: number, z: number, out: GroundSample): GroundSample {
    const tr = this.track;
    const o = this.fieldIndex(x, z);
    const approxDist = this.fDist[o];
    let s = this.fS[o];

    // Exact foot point near the road (Newton on the horizontal projection).
    let px = 0, pz = 0, py = 0, rx = 1, ry = 0, rz = 0, hw = tr.def.halfWidth;
    if (approxDist < 260) {
      for (let it = 0; it < 3; it++) {
        const f = frameAt(tr, s);
        const tl2 = f.tx * f.tx + f.tz * f.tz || 1;
        const step = ((x - f.px) * f.tx + (z - f.pz) * f.tz) / tl2;
        s = tr.wrap(s + clamp(step, -14, 14));
      }
    }
    {
      const f = frameAt(tr, s);
      px = f.px; py = f.py; pz = f.pz; rx = f.rx; ry = f.ry; rz = f.rz; hw = f.hw;
    }
    const rl = Math.sqrt(rx * rx + rz * rz) || 1;
    const dx = x - px, dz = z - pz;
    const d = (dx * rx + dz * rz) / rl;
    const dist = Math.sqrt(dx * dx + dz * dz);
    const B = this.baseAt(x, z);
    const top = B - 0.8;
    const seed = this.seed;
    let rock = 0;

    // ---- natural terrain
    let h: number;
    if (d >= 0) {
      // island interior: rolling hills rising away from the road
      const mask = smoothstep(18, 330, dist);
      const m3 = mask * mask * (3 - 2 * mask);
      h = top + 0.8 * fbm2(x / 23, z / 23, 2, seed + 9);
      if (m3 > 1e-4) {
        const n = fbm2(x / 430, z / 430, 4, seed + 3);
        const r = ridged2(x / 290 + 7.1, z / 290 - 3.3, 4, seed + 5);
        h += (30 + 52 * (0.5 + 0.5 * n) + 34 * r * r) * m3;
      }
    } else {
      // sea side: beach or cliff down to the waterline
      const co = this.coastAt(s);
      const u = co + d; // distance to the waterline, + = land
      const cliff = smoothstep(5, 15, B);
      const landW = Math.max(6, co - hw - 3);
      if (u >= 0) {
        let beach = 0, cliffH = 0;
        if (cliff < 1) beach = top * Math.min(1, Math.pow(u / landW, 0.8)) + 0.35 * fbm2(x / 17, z / 17, 2, seed + 13);
        if (cliff > 0) {
          const faceW = 15 * (0.75 + 0.6 * (0.5 + 0.5 * fbm2(x / 70, z / 70, 2, seed + 15)));
          const face = smoothstep(0, faceW, u);
          const crag = 4.5 * ridged2(x / 26, z / 26, 3, seed + 17) * (1 - Math.abs(face * 2 - 1));
          cliffH = top * face + crag + 1.2 * fbm2(x / 40, z / 40, 3, seed + 19) * face;
        }
        h = beach + (cliffH - beach) * cliff;
        rock = cliff * (1 - smoothstep(10, 24, u));
      } else {
        const off = -u;
        const beachFloor = -0.075 * off - 0.00012 * off * off;
        const cliffFloor = cliff > 0 ? -4.5 - 0.16 * off + 2.5 * ridged2(x / 30, z / 30, 2, seed + 23) : 0;
        h = Math.max(SEA_FLOOR, beachFloor + (cliffFloor - beachFloor) * cliff);
        rock = cliff;
      }
    }

    // headland over the tunnel
    if (this.tunnel) {
      const hd = segDist(x, z, this.headA, this.headB);
      const hm = 1 - smoothstep(35, 230, hd);
      if (hm > 0) {
        const bump = 44 * hm * hm * (3 - 2 * hm) + 6 * ridged2(x / 60, z / 60, 3, seed + 29) * hm;
        h += bump * (h > -2 ? 1 : smoothstep(-12, -2, h));
      }
    }

    // lagoon carved out of the interior
    const lag = this.lagoonDist(x, z);
    if (lag < 160) {
      const shore = lag >= 0 ? 0.44 * lag : Math.max(-13, 0.3 * lag);
      h = smin(h, shore, 9);
    }

    // rocky knoll carrying the lighthouse
    const lx = x - this.lighthouse.x, lz = z - this.lighthouse.z;
    const lhd = Math.sqrt(lx * lx + lz * lz);
    if (lhd < 60) {
      const k = 1 - smoothstep(6, 34, lhd);
      const knoll = 6.5 * k + 2.2 * ridged2(x / 9, z / 9, 2, seed + 31) * (1 - smoothstep(20, 60, lhd));
      h = Math.max(h, knoll - 3 * (1 - k));
      rock = Math.max(rock, 1 - smoothstep(22, 58, lhd));
    }
    const natural = h;

    // ---- road corridor
    let road = 0;
    if (dist < hw + SHOULDER + BLEND + 20) {
      const ad = Math.abs(d);
      const w = 1 - smoothstep(hw + SHOULDER, hw + SHOULDER + BLEND, ad);
      const dc = clamp(d, -(hw + 1), hw + 1);
      // (floored above the sea so banked kerbs on the beach never flood their verge)
      const surf = Math.max(py + (ry / rl) * dc - ROAD_CLEARANCE, 0.35);
      const wb = this.secWeight(this.bridge, s, 14);
      const wt = this.secWeight(this.tunnel, s, 1.5);
      if (w > 0 && wt < 1) {
        // normal: carve/fill; bridge: only ever lower (keep water under the deck)
        const filled = h + (surf - h) * w;
        const lowered = Math.min(h, h + (surf - 1.2 - h) * w);
        const hc = filled + (lowered - filled) * wb;
        h += (hc - h) * (1 - wt);
        road = w * (1 - wb) * (1 - wt);
      }
      if (wt > 0 && this.tunnel) {
        // Near the mouths the headland is trimmed down to the headwall so the
        // (hidden) grid ramp at the portal never rises above the concrete.
        const a = Math.min(tr.wrap(s - this.tunnel.s0), tr.wrap(this.tunnel.s1 - s));
        const cap = py + TUNNEL_COVER + Math.max(0, a - 7) * 1.5 + Math.max(0, ad - hw - 12) * 1.2;
        if (h > cap) h = cap;
        // bury the tunnel: the headland always covers the roof
        const cover = py + TUNNEL_COVER - Math.max(0, ad - hw - 9) * 0.5;
        if (cover > h) h += (cover - h) * wt;
      }
    }

    out.h = h;
    out.natural = natural;
    out.s = s;
    out.d = d;
    out.dist = dist;
    out.road = road;
    out.rock = rock;
    out.lagoon = lag;
    return out;
  }
}

/** s at the middle of a section. */
export function sectionMid(tr: Track, sec: ResolvedSection): number {
  return sec.s0 + tr.wrap(sec.s1 - sec.s0) / 2;
}

/** Polynomial smooth minimum (blend radius k). */
function smin(a: number, b: number, k: number): number {
  const h = clamp(0.5 + (0.5 * (b - a)) / k, 0, 1);
  return b + (a - b) * h - k * h * (1 - h);
}

function segDist(x: number, z: number, a: [number, number], b: [number, number]): number {
  const abx = b[0] - a[0], abz = b[1] - a[1];
  const t = clamp(((x - a[0]) * abx + (z - a[1]) * abz) / (abx * abx + abz * abz || 1), 0, 1);
  const ex = x - a[0] - abx * t, ez = z - a[1] - abz * t;
  return Math.sqrt(ex * ex + ez * ez);
}

const fr = { px: 0, py: 0, pz: 0, tx: 0, tz: 0, rx: 0, ry: 0, rz: 0, hw: 0 };
/** Interpolated centreline data at s (inlined Track.lerp for speed). */
function frameAt(tr: Track, s: number): typeof fr {
  let x = tr.wrap(s) / tr.ds;
  if (x >= tr.N) x = tr.N - 1e-9;
  const i = Math.floor(x);
  const f = x - i;
  const j = i + 1 === tr.N ? 0 : i + 1;
  const g = 1 - f;
  fr.px = tr.px[i] * g + tr.px[j] * f;
  fr.py = tr.py[i] * g + tr.py[j] * f;
  fr.pz = tr.pz[i] * g + tr.pz[j] * f;
  fr.tx = tr.tx[i] * g + tr.tx[j] * f;
  fr.tz = tr.tz[i] * g + tr.tz[j] * f;
  fr.rx = tr.rx[i] * g + tr.rx[j] * f;
  fr.ry = tr.ry[i] * g + tr.ry[j] * f;
  fr.rz = tr.rz[i] * g + tr.rz[j] * f;
  fr.hw = tr.halfWidth[i] * g + tr.halfWidth[j] * f;
  return fr;
}

const tmpSample: GroundSample = { h: 0, natural: 0, s: 0, d: 0, dist: 0, road: 0, rock: 0, lagoon: 0 };
const tmpMouth: GroundSample = { h: 0, natural: 0, s: 0, d: 0, dist: 0, road: 0, rock: 0, lagoon: 0 };
