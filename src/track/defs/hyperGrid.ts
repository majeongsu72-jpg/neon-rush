import { Turtle } from './turtle';
import type { TrackDef } from '../types';

const R2D = 180 / Math.PI;

/** Point of vertical intersection: two grade lines meet at (u, y); a parabola of length `len` rounds the corner. */
interface Pvi {
  u: number;
  y: number;
  len: number;
}

/**
 * Periodic highway-style vertical alignment: constant grades between PVIs,
 * joined by parabolic vertical curves (constant vertical curvature Δg/len).
 * The turtle's smoothstep ramps put their sharpest curvature at the ends,
 * which at 100 m/s is exactly where a car leaves the ground; here every
 * crest's curvature is chosen explicitly, so cars only fly where intended.
 */
function alignment(pvis: Pvi[], period: number): (u: number) => number {
  const n = pvis.length;
  const ext: Pvi[] = [
    { ...pvis[n - 2], u: pvis[n - 2].u - period },
    { ...pvis[n - 1], u: pvis[n - 1].u - period },
    ...pvis,
    { ...pvis[0], u: pvis[0].u + period },
    { ...pvis[1], u: pvis[1].u + period },
  ];
  for (let i = 1; i < ext.length; i++) {
    const a = ext[i - 1], b = ext[i];
    if (b.u - a.u < (a.len + b.len) / 2 - 1e-6) throw new Error(`vertical curves overlap near u=${b.u.toFixed(0)}`);
  }
  const grade = (i: number): number => (ext[i + 1].y - ext[i].y) / (ext[i + 1].u - ext[i].u);
  const curve = (i: number, u: number): number => {
    const p = ext[i], g0 = grade(i - 1), g1 = grade(i);
    const x = u - (p.u - p.len / 2);
    return p.y - (g0 * p.len) / 2 + g0 * x + ((g1 - g0) * x * x) / (2 * p.len);
  };
  return (u0: number): number => {
    const u = ((u0 % period) + period) % period;
    let i = 1;
    while (ext[i + 1].u <= u) i++;
    if (u - ext[i].u < ext[i].len / 2) return curve(i, u);
    if (ext[i + 1].u - u < ext[i + 1].len / 2) return curve(i + 1, u);
    return ext[i].y + grade(i) * (u - ext[i].u);
  };
}

/**
 * HYPER GRID — a neon circuit floating in the void above an endless grid.
 * Boost-pad launch straight (deck 90 m) → 180° velodrome sweeper (≈40° bank)
 * climbing to the upper deck (120 m) → pad → 360° loop (top 172 m) →
 * pad-lined back straight → 14 % drop and kicker jump that flies over the
 * lower deck through ring gates → 270° descending pretzel helix that dives
 * 35 m under its own approach (lower deck 66 m) → fast S → banked final
 * sweeper climbing back onto the start straight.
 */
export function hyperGrid(): TrackDef {
  const Y0 = 90; // start/finish deck height
  // Evenly spaced control points: centripetal Catmull-Rom overshoots curvature
  // where spacing jumps (e.g. 20 m straight points → 7 m spiral points).
  const t = new Turtle(0, Y0, 0, 0, 10);
  const SPACING = 9;
  const at: Record<string, number> = {};
  const mark = (name: string): void => {
    at[name] = t.index;
  };
  /**
   * Arc with clothoid-like ends: `ease` metres of stepped, ramping curvature
   * (and manual bank) on each side, so the spline has no curvature jump.
   */
  const bend = (radius: number, angleDeg: number, bankDeg: number, ease = 60, n = 4): void => {
    const sgn = Math.sign(angleDeg);
    const piece = (k: number) => {
      const kap = (k + 0.5) / n / radius;
      t.bank((bankDeg * (k + 0.5)) / n).arc(1 / kap, sgn * (ease / n) * kap * R2D, 0, SPACING * kap * R2D);
    };
    for (let k = 0; k < n; k++) piece(k);
    t.bank(bankDeg).arc(radius, angleDeg - sgn * (ease / radius) * R2D, 0, (SPACING / radius) * R2D);
    for (let k = n - 1; k >= 0; k--) piece(k);
    t.bank(0);
  };

  // 1. launch straight, two pads (left then right) inside a tunnel of ring gates
  t.begin('rings');
  t.straight(160);
  t.pad(-4.5, 16, 5);
  t.straight(170);
  t.pad(4.5, 16, 5);
  t.straight(150);
  t.end('rings');
  t.straight(40);
  mark('t1');
  // 2. velodrome sweeper, climbing onto the upper deck
  bend(250, 180, 30, 80);
  mark('t1x');
  t.straight(100);
  // 3. pad → ring gates → loop
  t.pad(0, 18, 6);
  t.begin('rings');
  t.straight(70);
  t.end('rings');
  t.loop(26, -30, 36);
  // 4. back straight with pads, steep drop, kicker jump over the lower deck
  t.straight(130);
  t.pad(-4, 16, 5);
  t.straight(130);
  t.pad(4, 16, 5);
  t.straight(140);
  mark('drop');
  t.straight(170, 0, 10);
  t.begin('jump');
  t.straight(45, 0, 5);
  mark('lip');
  t.begin('rings');
  t.straight(120, 0, 5); // flight: passes over the lower deck ~55 m after the lip
  t.end('rings');
  t.straight(57, 0, 5);
  t.end('jump');
  mark('helix');
  // 5+6. descending 270° pretzel helix: dives under its own approach (crossover)
  bend(155, -270, -24, 70);
  mark('helixx');
  t.straight(158.3); // passes under the jump ~120 m after the helix
  mark('climb');
  // fast S
  bend(150, -30, -8, 40);
  bend(150, 30, 8, 40);
  t.straight(30);
  // 7. banked final sweeper onto the start straight
  bend(210, 90, 22, 60);
  mark('finalx');
  t.straight(211.8);

  // ---- vertical alignment. The turtle ran flat (y = Y0) except inside the loop
  // circle, whose rise is kept on top of the profile. u = plan distance along
  // the path, frozen across the circle (its plan zig-zag is not road length).
  const pts = t.points;
  const u = new Float64Array(pts.length);
  for (let i = 1; i < pts.length; i++) {
    const inCircle = pts[i].y !== Y0 || pts[i - 1].y !== Y0;
    u[i] = u[i - 1] + (inCircle ? 0 : Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z));
  }
  const U = u[pts.length - 1];
  const uo = (name: string, off = 0): number => u[at[name]] + off;
  const yUp = 120; // upper deck (loop / back straight)
  const yLow = 66; // helix exit / lower deck
  const uSag = uo('lip', -45);
  const ySag = yUp - 0.14 * (uSag - uo('drop', 40));
  const yLip = ySag + 0.03 * 45;
  // −4.5 % landing ramp runs straight into the helix descent (no sag to land in)
  const yHelix = yLip - 0.045 * (uo('helix', 30) - uo('lip'));
  const pvis: Pvi[] = [
    { u: uo('t1', 40), y: Y0, len: 200 },
    { u: uo('t1x', -40), y: yUp, len: 200 },
    // drop crest R ≈ 570 m: with the arcade downforce, cars stay planted up to ~180 m/s
    { u: uo('drop', 40), y: yUp, len: 80 },
    { u: uSag, y: ySag, len: 50 }, // compression at the foot of the drop
    // kicker lip +3 % → −4.5 % over 6 m: launches (jump section = no downforce), ≈1.1–1.4 s air at 85–95 m/s
    { u: uo('lip'), y: yLip, len: 6 },
    { u: uo('helix', 30), y: yHelix, len: 60 },
    { u: uo('helixx', -25), y: yLow, len: 60 },
    { u: uo('climb'), y: yLow, len: 120 },
    { u: uo('finalx', 30), y: Y0, len: 120 },
  ];
  const yAt = alignment(pvis, U);
  for (let i = 0; i < pts.length; i++) pts[i].y = yAt(u[i]) + (pts[i].y - Y0);

  if (import.meta.env.DEV) console.info('[turtle grid] closure', t.closureError());
  const { points, sections, pads } = t.close();
  return {
    id: 'grid',
    name: 'HYPER GRID',
    nameKo: '하이퍼 그리드',
    subtitle: '허공에 뜬 네온 서킷 · 360° 루프 · 점프 · 교차 나선',
    theme: 'grid',
    points,
    halfWidth: 10,
    autoBank: 45,
    maxBank: 40,
    sections,
    boostPads: pads,
    laps: 3,
    seed: 2077,
    sunDir: [0.35, 0.55, 0.75],
  };
}
