import * as THREE from 'three';
import type { ResolvedBoostPad, ResolvedSection, SectionKind, TrackDef } from './types';

/** An interpolated, orthonormal road frame at distance `s` along the centerline. */
export interface TrackFrame {
  s: number;
  pos: THREE.Vector3;
  T: THREE.Vector3; // forward
  R: THREE.Vector3; // right (in road surface)
  U: THREE.Vector3; // road normal
  kappa: number; // in-surface (geodesic) curvature, + = turning right
  kappaV: number; // normal curvature, + = curving toward the road normal (valley / loop)
  tau: number; // torsion (bank rate): (dR/ds)·U
  /** |∂P/∂s| at the queried lateral offset (1 on the centreline). */
  metric: number;
  halfWidth: number;
  flags: number;
}

export const makeFrame = (): TrackFrame => ({
  s: 0,
  pos: new THREE.Vector3(),
  T: new THREE.Vector3(0, 0, -1),
  R: new THREE.Vector3(1, 0, 0),
  U: new THREE.Vector3(0, 1, 0),
  kappa: 0,
  kappaV: 0,
  tau: 0,
  metric: 1,
  halfWidth: 8,
  flags: 0,
});

/**
 * Immutable sampled track. Everything in the game lives in (s, d, h) road
 * coordinates; this class converts them to world space.
 */
export class Track {
  readonly def: TrackDef;
  readonly N: number;
  readonly length: number;
  readonly ds: number;
  readonly px: Float64Array;
  readonly py: Float64Array;
  readonly pz: Float64Array;
  readonly tx: Float64Array;
  readonly ty: Float64Array;
  readonly tz: Float64Array;
  readonly rx: Float64Array;
  readonly ry: Float64Array;
  readonly rz: Float64Array;
  readonly ux: Float64Array;
  readonly uy: Float64Array;
  readonly uz: Float64Array;
  readonly kappa: Float64Array;
  readonly kappaV: Float64Array;
  readonly tau: Float64Array;
  readonly halfWidth: Float64Array;
  readonly bank: Float64Array;
  readonly flags: Uint8Array;
  readonly sections: ResolvedSection[];
  readonly boostPads: ResolvedBoostPad[];
  /** s of each control point. */
  readonly cpS: Float64Array;

  // Racing line (filled by RacingLine.compute)
  lineD: Float64Array;
  lineV: Float64Array;
  lineKappa: Float64Array;
  /** Reference lap time (s) of a perfect grip-only run on the racing line. */
  refLapTime = 0;
  /** 1 where rumble strips line the corners (set by the world builder). */
  curbMask: Uint8Array | null = null;

  private grid: Map<number, number[]> | null = null;
  private readonly gridCell = 24;

  constructor(init: {
    def: TrackDef;
    N: number;
    length: number;
    arrays: {
      px: Float64Array; py: Float64Array; pz: Float64Array;
      tx: Float64Array; ty: Float64Array; tz: Float64Array;
      rx: Float64Array; ry: Float64Array; rz: Float64Array;
      ux: Float64Array; uy: Float64Array; uz: Float64Array;
      kappa: Float64Array; kappaV: Float64Array; tau: Float64Array; halfWidth: Float64Array; bank: Float64Array;
      flags: Uint8Array;
    };
    sections: ResolvedSection[];
    boostPads: ResolvedBoostPad[];
    cpS: Float64Array;
  }) {
    this.def = init.def;
    this.N = init.N;
    this.length = init.length;
    this.ds = init.length / init.N;
    const a = init.arrays;
    this.px = a.px; this.py = a.py; this.pz = a.pz;
    this.tx = a.tx; this.ty = a.ty; this.tz = a.tz;
    this.rx = a.rx; this.ry = a.ry; this.rz = a.rz;
    this.ux = a.ux; this.uy = a.uy; this.uz = a.uz;
    this.kappa = a.kappa;
    this.kappaV = a.kappaV;
    this.tau = a.tau;
    this.halfWidth = a.halfWidth;
    this.bank = a.bank;
    this.flags = a.flags;
    this.sections = init.sections;
    this.boostPads = init.boostPads;
    this.cpS = init.cpS;
    this.lineD = new Float64Array(this.N);
    this.lineV = new Float64Array(this.N).fill(60);
    this.lineKappa = new Float64Array(this.N);
  }

  wrap(s: number): number {
    const L = this.length;
    s %= L;
    return s < 0 ? s + L : s;
  }

  /** Signed shortest distance from a to b along the loop. */
  delta(a: number, b: number): number {
    const L = this.length;
    let d = (b - a) % L;
    if (d > L / 2) d -= L;
    else if (d < -L / 2) d += L;
    return d;
  }

  /** Index + fraction for interpolation. */
  private locate(s: number): number {
    const x = this.wrap(s) / this.ds;
    return x >= this.N ? this.N - 1e-9 : x;
  }

  lerp(arr: Float64Array, s: number): number {
    const x = this.locate(s);
    const i = Math.floor(x);
    const f = x - i;
    const j = i + 1 === this.N ? 0 : i + 1;
    return arr[i] + (arr[j] - arr[i]) * f;
  }

  idx(s: number): number {
    return Math.floor(this.locate(s));
  }

  kappaAt(s: number): number {
    return this.lerp(this.kappa, s);
  }

  halfWidthAt(s: number): number {
    return this.lerp(this.halfWidth, s);
  }

  flagsAt(s: number): number {
    return this.flags[this.idx(s)];
  }

  sample(s: number, out: TrackFrame): TrackFrame {
    const x = this.locate(s);
    const i = Math.floor(x);
    const f = x - i;
    const j = i + 1 === this.N ? 0 : i + 1;
    const g = 1 - f;
    out.s = this.wrap(s);
    out.pos.set(this.px[i] * g + this.px[j] * f, this.py[i] * g + this.py[j] * f, this.pz[i] * g + this.pz[j] * f);
    out.T.set(this.tx[i] * g + this.tx[j] * f, this.ty[i] * g + this.ty[j] * f, this.tz[i] * g + this.tz[j] * f).normalize();
    out.R.set(this.rx[i] * g + this.rx[j] * f, this.ry[i] * g + this.ry[j] * f, this.rz[i] * g + this.rz[j] * f);
    // Re-orthogonalize R against T, then U = R x T.
    const dot = out.R.dot(out.T);
    out.R.addScaledVector(out.T, -dot).normalize();
    out.U.crossVectors(out.R, out.T).normalize();
    out.kappa = this.kappa[i] * g + this.kappa[j] * f;
    out.kappaV = this.kappaV[i] * g + this.kappaV[j] * f;
    out.tau = this.tau[i] * g + this.tau[j] * f;
    out.metric = 1;
    out.halfWidth = this.halfWidth[i] * g + this.halfWidth[j] * f;
    out.flags = this.flags[f < 0.5 ? i : j];
    return out;
  }

  /**
   * Frame of the actual ruled road surface at lateral offset d: tangent and
   * normal tilt when the bank changes (torsion) or the road curves (κ·d).
   * out.pos becomes the surface point at (s, d).
   */
  surface(s: number, d: number, out: TrackFrame): TrackFrame {
    this.sample(s, out);
    const a = 1 - out.kappa * d;
    const b = d * out.tau;
    out.metric = Math.sqrt(a * a + b * b);
    out.pos.addScaledVector(out.R, d);
    // T_s = norm(a T + b U), N = norm(a U - b T)
    const tx = out.T.x, ty = out.T.y, tz = out.T.z;
    out.T.set(a * tx + b * out.U.x, a * ty + b * out.U.y, a * tz + b * out.U.z).normalize();
    out.U.set(a * out.U.x - b * tx, a * out.U.y - b * ty, a * out.U.z - b * tz).normalize();
    return out;
  }

  /** World position of road coordinate (s, d, h). */
  point(s: number, d: number, h: number, out: THREE.Vector3, frame?: TrackFrame): THREE.Vector3 {
    const fr = frame ?? this.sample(s, tmpFrame);
    return out.copy(fr.pos).addScaledVector(fr.R, d).addScaledVector(fr.U, h);
  }

  /** s of a (fractional) control point index. */
  sAtIndex(idx: number): number {
    const n = this.def.points.length;
    const k = Math.floor(idx);
    const f = idx - k;
    const k0 = ((k % n) + n) % n;
    const s0 = this.cpS[k0];
    const s1 = k0 + 1 < n ? this.cpS[k0 + 1] : this.length;
    return this.wrap(s0 + (s1 - s0) * f);
  }

  sectionsOf(kind: SectionKind): ResolvedSection[] {
    return this.sections.filter((s) => s.kind === kind);
  }

  /** True if s is inside [s0, s1] (handles wrap-around sections). */
  inRange(s: number, s0: number, s1: number): boolean {
    s = this.wrap(s);
    return s0 <= s1 ? s >= s0 && s <= s1 : s >= s0 || s <= s1;
  }

  // -------------------------------------------------------------------------
  // Spatial queries (for world dressing, not the physics hot path)

  private buildGrid(): Map<number, number[]> {
    const g = new Map<number, number[]>();
    const c = this.gridCell;
    for (let i = 0; i < this.N; i += 2) {
      const key = this.cellKey(Math.floor(this.px[i] / c), Math.floor(this.pz[i] / c));
      let arr = g.get(key);
      if (!arr) g.set(key, (arr = []));
      arr.push(i);
    }
    return g;
  }

  private cellKey(cx: number, cz: number): number {
    return (cx + 2048) * 4096 + (cz + 2048);
  }

  /**
   * Nearest centerline sample to a world XZ point within `radius`.
   * Returns horizontal distance, sample index and the road height there.
   */
  nearest(x: number, z: number, radius: number, out: { dist: number; i: number; y: number }): typeof out {
    if (!this.grid) this.grid = this.buildGrid();
    const c = this.gridCell;
    const r = Math.ceil(radius / c);
    const cx = Math.floor(x / c);
    const cz = Math.floor(z / c);
    let best = Infinity;
    let bi = -1;
    for (let ix = cx - r; ix <= cx + r; ix++) {
      for (let iz = cz - r; iz <= cz + r; iz++) {
        const arr = this.grid.get(this.cellKey(ix, iz));
        if (!arr) continue;
        for (const i of arr) {
          const dx = this.px[i] - x;
          const dz = this.pz[i] - z;
          const d2 = dx * dx + dz * dz;
          if (d2 < best) {
            best = d2;
            bi = i;
          }
        }
      }
    }
    out.dist = bi < 0 ? Infinity : Math.sqrt(best);
    out.i = bi;
    out.y = bi < 0 ? 0 : this.py[bi];
    return out;
  }

  /** Axis-aligned XZ bounds of the centerline. */
  bounds(): { minX: number; maxX: number; minZ: number; maxZ: number; minY: number; maxY: number } {
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity, minY = Infinity, maxY = -Infinity;
    for (let i = 0; i < this.N; i++) {
      minX = Math.min(minX, this.px[i]);
      maxX = Math.max(maxX, this.px[i]);
      minZ = Math.min(minZ, this.pz[i]);
      maxZ = Math.max(maxZ, this.pz[i]);
      minY = Math.min(minY, this.py[i]);
      maxY = Math.max(maxY, this.py[i]);
    }
    return { minX, maxX, minZ, maxZ, minY, maxY };
  }
}

const tmpFrame = makeFrame();
