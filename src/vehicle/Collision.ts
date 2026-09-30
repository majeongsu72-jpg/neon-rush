import type { Track } from '../track/Track';
import { clamp } from '../core/math';

/** Minimal shape both racing cars and traffic expose for collisions. */
export interface Collider {
  s: number;
  d: number;
  h: number;
  theta: number;
  vf: number;
  vl: number;
  omega: number;
  readonly halfL: number;
  readonly halfW: number;
  mass: number;
  /** Kinematic bodies (traffic in rush mode) are pushed less. */
  kinematic?: boolean;
}

export interface Contact {
  impact: number; // closing speed (m/s)
  nS: number; // collision normal in (s, d) plane, from A to B
  nD: number;
  s: number; // contact position
  d: number;
}

const axes = new Float64Array(8);

/**
 * OBB vs OBB in the local (s, d) road plane using SAT. Resolves penetration
 * and applies an impulse; returns contact info or null.
 */
export function collidePair(a: Collider, b: Collider, track: Track, restitution = 0.25, out?: Contact): Contact | null {
  const ds = track.delta(a.s, b.s);
  const dd = b.d - a.d;
  const reach = a.halfL + b.halfL + 0.5;
  if (ds > reach || ds < -reach || Math.abs(dd) > a.halfL + b.halfL) return null;
  if (Math.abs(a.h - b.h) > 1.6) return null;

  const ca = Math.cos(a.theta), sa = Math.sin(a.theta);
  const cb = Math.cos(b.theta), sb = Math.sin(b.theta);
  // axes: forward & right of each box, in (s, d) coordinates
  axes[0] = ca; axes[1] = sa;
  axes[2] = -sa; axes[3] = ca;
  axes[4] = cb; axes[5] = sb;
  axes[6] = -sb; axes[7] = cb;

  let minOverlap = Infinity;
  let nS = 0, nD = 0;
  for (let k = 0; k < 4; k++) {
    const ax = axes[k * 2], ay = axes[k * 2 + 1];
    const ra = a.halfL * Math.abs(ca * ax + sa * ay) + a.halfW * Math.abs(-sa * ax + ca * ay);
    const rb = b.halfL * Math.abs(cb * ax + sb * ay) + b.halfW * Math.abs(-sb * ax + cb * ay);
    const dist = ds * ax + dd * ay;
    const overlap = ra + rb - Math.abs(dist);
    if (overlap <= 0) return null;
    if (overlap < minOverlap) {
      minOverlap = overlap;
      const sg = dist >= 0 ? 1 : -1;
      nS = ax * sg;
      nD = ay * sg;
    }
  }

  const ma = a.kinematic ? 1e6 : a.mass;
  const mb = b.kinematic ? 1e6 : b.mass;
  const inv = 1 / ma + 1 / mb;
  // positional correction (in s this is approximate: ignores 1-κd metric)
  const pa = (minOverlap * (1 / ma)) / inv;
  const pb = (minOverlap * (1 / mb)) / inv;
  a.s = track.wrap(a.s - nS * pa);
  a.d -= nD * pa;
  b.s = track.wrap(b.s + nS * pb);
  b.d += nD * pb;

  // velocities in the road frame
  let avs = a.vf * ca - a.vl * sa, avd = a.vf * sa + a.vl * ca;
  let bvs = b.vf * cb - b.vl * sb, bvd = b.vf * sb + b.vl * cb;
  const rel = (bvs - avs) * nS + (bvd - avd) * nD;
  let impact = 0;
  if (rel < 0) {
    impact = -rel;
    const j = (-(1 + restitution) * rel) / inv;
    avs -= (j / ma) * nS;
    avd -= (j / ma) * nD;
    bvs += (j / mb) * nS;
    bvd += (j / mb) * nD;
    // friction along the contact tangent
    const tS = -nD, tD = nS;
    const vt = (bvs - avs) * tS + (bvd - avd) * tD;
    const jt = clamp(-vt / inv, -0.35 * j, 0.35 * j);
    avs -= (jt / ma) * tS;
    avd -= (jt / ma) * tD;
    bvs += (jt / mb) * tS;
    bvd += (jt / mb) * tD;
    // yaw kick from off-centre hits (side swipes spin the car a little)
    const lever = clamp(ds * 0.5, -a.halfL, a.halfL);
    const kick = clamp(j * 0.012, 0, 0.9);
    if (!a.kinematic) a.omega += -kick * Math.sign(nD) * Math.sign(lever || 1) * (1 / ma);
    if (!b.kinematic) b.omega += kick * Math.sign(nD) * Math.sign(lever || 1) * (1 / mb);
  }
  if (!a.kinematic) {
    a.vf = avs * ca + avd * sa;
    a.vl = -avs * sa + avd * ca;
  }
  if (!b.kinematic) {
    b.vf = bvs * cb + bvd * sb;
    b.vl = -bvs * sb + bvd * cb;
  }
  const c = out ?? { impact: 0, nS: 0, nD: 0, s: 0, d: 0 };
  c.impact = impact;
  c.nS = nS;
  c.nD = nD;
  c.s = track.wrap(a.s + ds * 0.5);
  c.d = a.d + dd * 0.5;
  return c;
}
