import * as THREE from 'three';
import type { Track, TrackFrame } from './Track';
import { makeFrame } from './Track';
import { gridSlot, GRID_SIZE } from '../race/grid';

/** Cross-section point. e=±1: `d` is measured outward from that road edge; e=0: absolute offset. */
export interface ProfilePoint {
  e: -1 | 0 | 1;
  d: number;
  h: number;
}

export interface SweepOptions {
  s0: number;
  /** Length along s (m). Use track.length for a closed loop. */
  len: number;
  step: number;
  profile: ProfilePoint[];
  uScale?: number;
  vScale?: number;
  chunk?: number;
  /** Optional per-vertex colour. */
  color?: (s: number, k: number, out: THREE.Color) => void;
  /** Extra per-row displacement (e.g. bumps). */
  lift?: number;
  /**
   * Emit road-space attributes for analytic shading: aRoad = (s, d, halfWidth, zone)
   * and aTan = road tangent. `zone(s)` classifies rows (e.g. 1 inside tunnels).
   */
  roadAttrs?: (s: number) => number;
}

const fr: TrackFrame = makeFrame();
const tmp = new THREE.Vector3();

/** Sweep a profile along the track between s0 and s0+len; returns one geometry per chunk. */
export function sweep(track: Track, o: SweepOptions): THREE.BufferGeometry[] {
  const rows = Math.max(1, Math.ceil(o.len / o.step));
  const step = o.len / rows;
  const perChunk = Math.max(1, Math.round((o.chunk ?? 250) / step));
  const out: THREE.BufferGeometry[] = [];
  const P = o.profile.length;
  const col = new THREE.Color();
  for (let r0 = 0; r0 < rows; r0 += perChunk) {
    const r1 = Math.min(rows, r0 + perChunk);
    const nRows = r1 - r0 + 1;
    const pos = new Float32Array(nRows * P * 3);
    const uv = new Float32Array(nRows * P * 2);
    const colors = o.color ? new Float32Array(nRows * P * 3) : null;
    const roadA = o.roadAttrs ? new Float32Array(nRows * P * 4) : null;
    const tanA = o.roadAttrs ? new Float32Array(nRows * P * 3) : null;
    const upA = o.roadAttrs ? new Float32Array(nRows * P * 3) : null;
    const hwA = o.roadAttrs ? new Float32Array(nRows * P) : null;
    let pi = 0, ui = 0, ci = 0, ri = 0, ti = 0, wi = 0;
    for (let r = r0; r <= r1; r++) {
      const along = r * step;
      const s = o.s0 + along;
      track.sample(s, fr);
      const zone = o.roadAttrs ? o.roadAttrs(track.wrap(s)) : 0;
      let acc = 0;
      let prevD = 0, prevH = 0;
      for (let k = 0; k < P; k++) {
        const p = o.profile[k];
        const d = p.e === 0 ? p.d : p.e * (fr.halfWidth + p.d);
        const h = p.h;
        if (k > 0) acc += Math.hypot(d - prevD, h - prevH);
        prevD = d;
        prevH = h;
        tmp.copy(fr.pos).addScaledVector(fr.R, d).addScaledVector(fr.U, h + (o.lift ?? 0));
        pos[pi++] = tmp.x;
        pos[pi++] = tmp.y;
        pos[pi++] = tmp.z;
        uv[ui++] = acc * (o.uScale ?? 1);
        uv[ui++] = (o.s0 + along) * (o.vScale ?? 0.1);
        if (colors && o.color) {
          o.color(s, k, col);
          colors[ci++] = col.r;
          colors[ci++] = col.g;
          colors[ci++] = col.b;
        }
        if (roadA && tanA && upA && hwA) {
          // unwrapped s keeps interpolation continuous across the start line
          roadA[ri++] = o.s0 + along;
          roadA[ri++] = d;
          roadA[ri++] = h;
          roadA[ri++] = zone;
          hwA[wi] = fr.halfWidth;
          tanA[ti] = fr.T.x;
          tanA[ti + 1] = fr.T.y;
          tanA[ti + 2] = fr.T.z;
          upA[ti] = fr.U.x;
          upA[ti + 1] = fr.U.y;
          upA[ti + 2] = fr.U.z;
          ti += 3;
          wi++;
        }
      }
    }
    const idx: number[] = [];
    for (let r = 0; r < nRows - 1; r++) {
      for (let k = 0; k < P - 1; k++) {
        const a = r * P + k, b = a + 1, c = a + P, d = c + 1;
        idx.push(a, b, c, b, d, c);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    if (colors) g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    if (roadA && tanA && upA && hwA) {
      g.setAttribute('aRoad', new THREE.BufferAttribute(roadA, 4));
      g.setAttribute('aTan', new THREE.BufferAttribute(tanA, 3));
      g.setAttribute('aUpR', new THREE.BufferAttribute(upA, 3));
      g.setAttribute('aHw', new THREE.BufferAttribute(hwA, 1));
    }
    g.setIndex(idx);
    g.computeVertexNormals();
    g.computeBoundingSphere();
    out.push(g);
  }
  return out;
}

/** Mirror a right-side profile to the left side (reverses winding order). */
export function mirrorProfile(p: ProfilePoint[]): ProfilePoint[] {
  return p.map((q) => ({ e: (q.e === 0 ? 0 : -q.e) as -1 | 0 | 1, d: q.e === 0 ? -q.d : q.d, h: q.h })).reverse();
}

// ---------------------------------------------------------------------------

export interface RoadStyle {
  road: THREE.Material;
  roadOverhang: number;
  slab: THREE.Material | null;
  slabDepth: number;
  marking: THREE.Material; // uses vertex colours
  laneColor: THREE.Color;
  edgeColor: THREE.Color;
  laneWidth: number;
  dash: [number, number];
  curb: THREE.Material | null;
  wall: THREE.Material | null;
  /** Right-side wall profile, points from the road edge outward: (d outward, h). */
  wallProfile: [number, number][];
  wallStrip: {
    material: THREE.Material;
    materialLeft?: THREE.Material;
    d: number;
    h: number;
    width: number;
    vScale: number;
  } | null;
  startLine: THREE.Material | null;
  /** Road rows get aRoad/aTan attributes (for analytic lamp lighting) when set. */
  zone?: (s: number) => number;
}

export interface CurbRun {
  s0: number;
  len: number;
  side: number;
}

/** Corners get rumble strips on both edges. */
export function computeCurbRuns(track: Track, minRadius = 320): CurbRun[] {
  const N = track.N;
  const on = new Uint8Array(N);
  for (let i = 0; i < N; i++) if (Math.abs(track.kappa[i]) > 1 / minRadius) on[i] = 1;
  // dilate a bit so curbs start before the apex region
  const dil = new Uint8Array(N);
  for (let i = 0; i < N; i++) if (on[i]) for (let k = -18; k <= 18; k++) dil[(i + k + N) % N] = 1;
  const runs: CurbRun[] = [];
  let start = -1;
  // find a starting index that is off to avoid wrap issues
  let base = 0;
  while (base < N && dil[base]) base++;
  if (base >= N) return [{ s0: 0, len: track.length, side: 0 }];
  for (let k = 0; k <= N; k++) {
    const i = (base + k) % N;
    const v = k < N ? dil[i] : 0;
    if (v && start < 0) start = base + k;
    if (!v && start >= 0) {
      const len = (base + k - start) * track.ds;
      if (len > 25) runs.push({ s0: track.wrap(start * track.ds), len, side: 0 });
      start = -1;
    }
  }
  return runs;
}

export function curbMask(track: Track, runs: CurbRun[]): Uint8Array {
  const m = new Uint8Array(track.N);
  for (const r of runs) {
    const n = Math.round(r.len / track.ds);
    const i0 = track.idx(r.s0);
    for (let k = 0; k < n; k++) m[(i0 + k) % track.N] = 1;
  }
  return m;
}

export function buildRoad(track: Track, style: RoadStyle, curbRuns: CurbRun[]): THREE.Group {
  const group = new THREE.Group();
  group.name = 'road';
  const L = track.length;
  const add = (geos: THREE.BufferGeometry[], mat: THREE.Material, name: string, shadows = true) => {
    for (const g of geos) {
      const m = new THREE.Mesh(g, mat);
      m.name = name;
      m.receiveShadow = shadows;
      m.matrixAutoUpdate = false;
      m.updateMatrix();
      group.add(m);
    }
  };

  const oh = style.roadOverhang;
  // Road surface
  add(
    sweep(track, {
      s0: 0, len: L, step: track.ds, chunk: 220,
      profile: [{ e: -1, d: oh, h: 0 }, { e: 1, d: oh, h: 0 }],
      uScale: 0.1, vScale: 0.1,
      roadAttrs: style.zone,
    }),
    style.road,
    'road',
  );

  // Slab underside / sides
  if (style.slab) {
    const w = oh + (style.wallProfile.length ? Math.max(...style.wallProfile.map((p) => p[0])) : 0.2);
    add(
      sweep(track, {
        s0: 0, len: L, step: 3, chunk: 300,
        profile: [
          { e: 1, d: w, h: 0.02 },
          { e: 1, d: w, h: -style.slabDepth },
          { e: 1, d: w - 1.5, h: -style.slabDepth - 0.2 },
          { e: -1, d: w - 1.5, h: -style.slabDepth - 0.2 },
          { e: -1, d: w, h: -style.slabDepth },
          { e: -1, d: w, h: 0.02 },
        ],
        uScale: 0.25, vScale: 0.05,
      }),
      style.slab,
      'slab',
      false,
    );
  }

  // Walls
  if (style.wall && style.wallProfile.length > 1) {
    const right: ProfilePoint[] = style.wallProfile.map(([d, h]) => ({ e: 1, d: d + oh * 0, h }));
    const left = mirrorProfile(right);
    const opts = { s0: 0, len: L, step: 2, chunk: 250, uScale: 0.5, vScale: 0.25, roadAttrs: style.zone };
    add(sweep(track, { ...opts, profile: right }), style.wall, 'wallR');
    add(sweep(track, { ...opts, profile: left }), style.wall, 'wallL');
  }

  // Emissive strips along the walls
  if (style.wallStrip) {
    const ws = style.wallStrip;
    const stripR: ProfilePoint[] = [
      { e: 1, d: ws.d, h: ws.h - ws.width / 2 },
      { e: 1, d: ws.d, h: ws.h + ws.width / 2 },
    ];
    const opts = { s0: 0, len: L, step: 2, chunk: 250, uScale: 1, vScale: ws.vScale };
    add(sweep(track, { ...opts, profile: stripR }), ws.material, 'stripR', false);
    add(sweep(track, { ...opts, profile: mirrorProfile(stripR) }), ws.materialLeft ?? ws.material, 'stripL', false);
  }

  // Curbs (rumble strips) in corners
  if (style.curb) {
    for (const run of curbRuns) {
      const inner: ProfilePoint[] = [
        { e: 1, d: -1.15, h: 0.012 },
        { e: 1, d: -0.95, h: 0.05 },
        { e: 1, d: 0.0, h: 0.05 },
        { e: 1, d: oh, h: 0.01 },
      ];
      const o = { s0: run.s0, len: run.len, step: 1.5, chunk: 400, uScale: 0.8, vScale: 1 / 3, roadAttrs: style.zone };
      add(sweep(track, { ...o, profile: inner }), style.curb, 'curbR');
      add(sweep(track, { ...o, profile: mirrorProfile(inner) }), style.curb, 'curbL');
    }
  }

  // Markings (lane dashes + edge lines) as one vertex-coloured geometry per chunk
  add(buildMarkings(track, style), style.marking, 'markings', true);

  // Start/finish line
  if (style.startLine) {
    const g = sweep(track, {
      s0: -1.2, len: 2.4, step: 1.2, chunk: 10,
      profile: [{ e: -1, d: 0, h: 0.03 }, { e: 1, d: 0, h: 0.03 }],
      uScale: 1 / 2.4, vScale: 1 / 2.4,
    });
    add(g, style.startLine, 'startLine', true);
  }
  return group;
}

function buildMarkings(track: Track, style: RoadStyle): THREE.BufferGeometry[] {
  const chunkLen = 300;
  const L = track.length;
  const out: THREE.BufferGeometry[] = [];
  const [dash, gap] = style.dash;
  const period = dash + gap;
  const lw = 0.13;
  const edgeInset = 0.55;
  const lift = 0.025;
  const f0 = makeFrame(), f1 = makeFrame();
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), d = new THREE.Vector3();

  for (let cs = 0; cs < L; cs += chunkLen) {
    const ce = Math.min(L, cs + chunkLen);
    const pos: number[] = [];
    const col: number[] = [];
    const idx: number[] = [];
    const quad = (sA: number, sB: number, dA: number, dB: number, width: number, color: THREE.Color) => {
      track.sample(sA, f0);
      track.sample(sB, f1);
      a.copy(f0.pos).addScaledVector(f0.R, dA - width).addScaledVector(f0.U, lift);
      b.copy(f0.pos).addScaledVector(f0.R, dA + width).addScaledVector(f0.U, lift);
      c.copy(f1.pos).addScaledVector(f1.R, dB - width).addScaledVector(f1.U, lift);
      d.copy(f1.pos).addScaledVector(f1.R, dB + width).addScaledVector(f1.U, lift);
      const base = pos.length / 3;
      pos.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z, d.x, d.y, d.z);
      for (let k = 0; k < 4; k++) col.push(color.r, color.g, color.b);
      idx.push(base, base + 1, base + 2, base + 1, base + 3, base + 2);
    };
    // Lane dashes
    const firstDash = Math.ceil(cs / period) * period;
    for (let s = firstDash; s < ce; s += period) {
      const hw = track.halfWidthAt(s);
      const usable = 2 * (hw - edgeInset);
      const lanes = Math.max(2, Math.round(usable / style.laneWidth));
      const lw2 = usable / lanes;
      const hw1 = track.halfWidthAt(s + dash);
      const lw2b = (2 * (hw1 - edgeInset)) / lanes;
      for (let k = 1; k < lanes; k++) {
        const dA = -hw + edgeInset + k * lw2;
        const dB = -hw1 + edgeInset + k * lw2b;
        // split long dashes to follow curvature
        const parts = Math.max(1, Math.ceil(dash / 2));
        for (let p = 0; p < parts; p++) {
          const t0 = p / parts, t1 = (p + 1) / parts;
          quad(s + dash * t0, s + dash * t1, dA + (dB - dA) * t0, dA + (dB - dA) * t1, lw, style.laneColor);
        }
      }
    }
    // Edge lines (continuous)
    const step = 2;
    for (let s = cs; s < ce; s += step) {
      const s2 = Math.min(s + step, ce);
      const hwA = track.halfWidthAt(s), hwB = track.halfWidthAt(s2);
      quad(s, s2, hwA - edgeInset, hwB - edgeInset, 0.1, style.edgeColor);
      quad(s, s2, -hwA + edgeInset, -hwB + edgeInset, 0.1, style.edgeColor);
    }
    // Grid slots behind the start line: a transverse bar in front of each car
    if (cs === 0) {
      for (let slot = 0; slot < GRID_SIZE; slot++) {
        const g = gridSlot(slot);
        const sFront = L + g.s + 2.9;
        quad(sFront, sFront + 0.3, g.d, g.d, 1.2, style.laneColor);
        quad(sFront - 1.2, sFront + 0.3, g.d - 1.2, g.d - 1.2, 0.07, style.laneColor);
        quad(sFront - 1.2, sFront + 0.3, g.d + 1.2, g.d + 1.2, 0.07, style.laneColor);
      }
    }
    if (!pos.length) continue;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    g.computeBoundingSphere();
    out.push(g);
  }
  return out;
}
