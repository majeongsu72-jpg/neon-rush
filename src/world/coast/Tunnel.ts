import * as THREE from 'three';
import type { Track } from '../../track/Track';
import { makeFrame } from '../../track/Track';
import { sweep, mirrorProfile, type ProfilePoint } from '../../track/TrackMesh';
import { instanceAlongTrack, type Placement } from '../props';
import { canvasTexture, dashTexture } from '../textures';
import type { Rng } from '../../core/rng';

/**
 * Curving tunnel through the headland: arched tiled shell lit by two rows of
 * sodium fixtures (analytic lamps in the road shader do the light pools),
 * amber guide LEDs, an outer hull, and concrete headwalls with wing walls and
 * aprons covering the heightfield cut at each mouth.
 */
export interface TunnelBuild {
  group: THREE.Group;
  passables: number[];
  dispose(): void;
}

export interface TunnelStyle {
  spacing: number;
  phase: number;
  lampD: number;
  lampH: number;
  lampColor: THREE.Color;
}

/** Right half of the arch, from the kerb up to the crown (road-edge relative). */
const SHELL_R: ProfilePoint[] = [
  { e: 1, d: 0.9, h: -0.3 },
  { e: 1, d: 0.9, h: 5.2 },
  { e: 1, d: 0.1, h: 6.5 },
  { e: 1, d: -2.5, h: 7.3 },
  { e: 0, d: 0, h: 7.7 },
];

export function buildTunnel(
  track: Track,
  rng: Rng,
  style: TunnelStyle,
  zone: (s: number) => number,
  prepRoad: (m: THREE.MeshStandardMaterial) => void,
  prep: (m: THREE.Material) => void,
): TunnelBuild | null {
  const tunnels = track.sectionsOf('tunnel');
  if (!tunnels.length) return null;
  const group = new THREE.Group();
  group.name = 'tunnel';
  const disposables: { dispose(): void }[] = [];
  const keep = <T extends { dispose(): void }>(x: T): T => {
    disposables.push(x);
    return x;
  };
  const passables: number[] = [];

  const wallTex = keep(
    canvasTexture(256, 256, (c, w, h) => {
      c.fillStyle = '#3a3634';
      c.fillRect(0, 0, w, h);
      // dark skirting band at the bottom of the wall (u = 0..0.28)
      for (let y = 0; y < 8; y++) {
        for (let x = 0; x < 8; x++) {
          const v = 150 + Math.floor(rng.next() * 40);
          c.fillStyle = x < 2 ? `rgb(${v * 0.35},${v * 0.33},${v * 0.32})` : `rgb(${v},${v - 6},${v - 16})`;
          c.fillRect(x * 32 + 1, y * 32 + 1, 30, 30);
        }
      }
    }),
  );
  const shellMat = keep(new THREE.MeshStandardMaterial({ map: wallTex, roughness: 0.38, metalness: 0.1, envMapIntensity: 0.4 }));
  prepRoad(shellMat);
  prep(shellMat);
  const hullMat = keep(new THREE.MeshStandardMaterial({ color: new THREE.Color(0.2, 0.18, 0.17), roughness: 0.95 }));
  prep(hullMat);
  const lightMat = keep(new THREE.MeshBasicMaterial({ color: style.lampColor.clone().multiplyScalar(5.5) }));
  prep(lightMat);
  const ledMat = keep(new THREE.MeshBasicMaterial({ color: new THREE.Color(3.2, 1.2, 0.25), map: keep(dashTexture(0.5, 0.15)) }));
  prep(ledMat);
  const concrete = keep(new THREE.MeshStandardMaterial({ color: new THREE.Color(0.36, 0.32, 0.29), roughness: 0.85, side: THREE.DoubleSide }));
  prep(concrete);

  const shell = [...SHELL_R, ...mirrorProfile(SHELL_R).slice(1)];
  const hullR: ProfilePoint[] = [
    { e: 0, d: 0, h: 9.8 },
    { e: 1, d: 3.6, h: 9.8 },
    { e: 1, d: 3.6, h: -0.6 },
  ];
  const hull = [...mirrorProfile(hullR), ...hullR.slice(1)];
  const boxGeo = keep(new THREE.BoxGeometry(1, 1, 1));

  for (const t of tunnels) {
    const len = track.wrap(t.s1 - t.s0);
    for (const g of sweep(track, { s0: t.s0, len, step: 2, chunk: 200, profile: shell, uScale: 0.2, vScale: 0.25, roadAttrs: zone })) {
      const m = new THREE.Mesh(keep(g), shellMat);
      m.receiveShadow = true;
      m.castShadow = true;
      m.name = 'tunnelShell';
      group.add(m);
    }
    for (const g of sweep(track, { s0: t.s0, len, step: 6, chunk: 400, profile: hull, uScale: 0.1, vScale: 0.1 })) {
      const m = new THREE.Mesh(keep(g), hullMat);
      m.castShadow = true;
      m.name = 'tunnelHull';
      group.add(m);
    }
    // ceiling fixtures
    const lights: Placement[] = [];
    const k0 = Math.ceil((t.s0 + 2 - style.phase) / style.spacing);
    const k1 = Math.floor((t.s0 + len - 2 - style.phase) / style.spacing);
    for (let k = k0; k <= k1; k++) {
      const s = k * style.spacing + style.phase;
      for (const sd of [-1, 1]) lights.push({ s, d: sd * style.lampD, h: style.lampH, upright: false, scale: [0.7, 0.12, 2.8] });
      passables.push(track.wrap(s));
    }
    for (const m of instanceAlongTrack(track, boxGeo, lightMat, lights, { name: 'tunnelLights', chunk: 200 })) group.add(m);
    // amber guide LEDs along both walls
    const ledR: ProfilePoint[] = [
      { e: 1, d: 0.88, h: 1.05 },
      { e: 1, d: 0.88, h: 1.17 },
    ];
    for (const prof of [ledR, mirrorProfile(ledR)]) {
      for (const g of sweep(track, { s0: t.s0, len, step: 2, chunk: 400, profile: prof, uScale: 1, vScale: 1 / 4 })) {
        const m = new THREE.Mesh(keep(g), ledMat);
        m.name = 'tunnelLeds';
        group.add(m);
      }
    }
    // headwalls, wing walls and aprons at both mouths
    for (const [sP, dir] of [[t.s0, -1], [t.s1, 1]] as [number, number][]) {
      const geo = keep(buildPortalGeometry(track, sP, dir));
      const m = new THREE.Mesh(geo, concrete);
      m.receiveShadow = true;
      m.castShadow = true;
      m.name = 'tunnelPortal';
      group.add(m);
    }
  }

  return {
    group,
    passables,
    dispose() {
      for (const d of disposables) d.dispose();
    },
  };
}

/**
 * Headwall (with the arch cut out), cornice, wing walls and aprons for one
 * tunnel mouth. `dir` = +1 when the open road continues toward +s.
 */
function buildPortalGeometry(track: Track, sP: number, dir: number): THREE.BufferGeometry {
  const fr = makeFrame();
  track.sample(sP, fr);
  const hw = fr.halfWidth;
  const W = hw + 17;
  const top = 14.5;
  // headwall: rectangle minus the arch (in the portal's (d, h) plane)
  const shape = new THREE.Shape();
  shape.moveTo(-W, -3.5);
  shape.lineTo(W, -3.5);
  shape.lineTo(W, top);
  shape.lineTo(-W, top);
  shape.lineTo(-W, -3.5);
  const arch = [...SHELL_R, ...mirrorProfile(SHELL_R).slice(1)].map((p) => {
    const d = p.e === 0 ? p.d : p.e * (hw + p.d);
    return new THREE.Vector2(d, Math.max(p.h, -0.05));
  });
  const hole = new THREE.Path();
  hole.moveTo(arch[0].x, arch[0].y);
  for (let i = 1; i < arch.length; i++) hole.lineTo(arch[i].x, arch[i].y);
  hole.lineTo(arch[0].x, arch[0].y);
  shape.holes.push(hole);
  const wall = new THREE.ExtrudeGeometry(shape, { depth: 1.6, bevelEnabled: false, curveSegments: 1 });
  // cornice + pilasters
  const parts: THREE.BufferGeometry[] = [wall];
  const cornice = new THREE.BoxGeometry(2 * W + 1.2, 1.1, 2.6).translate(0, top + 0.55, 0.8);
  parts.push(cornice);
  for (const x of [-(hw + 3.2), hw + 3.2, -(W - 1.2), W - 1.2]) parts.push(new THREE.BoxGeometry(1.6, top + 3.5, 2.2).translate(x, (top - 3.5) / 2, 0.8));

  // Portal frame: x = road right, y = world up, z = x × y (= −forward). Right-
  // handed, so the arch keeps its handedness; the origin is chosen so the
  // 1.6 m wall thickness always sits just inside the mouth.
  const X = new THREE.Vector3(fr.R.x, 0, fr.R.z).normalize();
  const Y = new THREE.Vector3(0, 1, 0);
  const Z = new THREE.Vector3().crossVectors(X, Y);
  const T = Z.clone().negate();
  const m = new THREE.Matrix4().makeBasis(X, Y, Z);
  const origin = fr.pos.clone().addScaledVector(T, dir > 0 ? 0.3 : 1.3);
  const place = new THREE.Matrix4().makeTranslation(origin.x, origin.y, origin.z).multiply(m);
  const merged: THREE.BufferGeometry[] = [];
  for (const g of parts) {
    const ng = g.index ? g.toNonIndexed() : g;
    ng.applyMatrix4(place);
    merged.push(ng);
    if (ng !== g) g.dispose();
  }

  // wing walls + aprons along the open road in front of the mouth
  merged.push(buildWings(track, sP, dir, hw));

  const out = concat(merged);
  for (const g of merged) g.dispose();
  return out;
}

function buildWings(track: Track, sP: number, dir: number, hw: number): THREE.BufferGeometry {
  const fr = makeFrame();
  const pos: number[] = [];
  const idx: number[] = [];
  const quad = (a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, d: THREE.Vector3) => {
    const o = pos.length / 3;
    pos.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z, d.x, d.y, d.z);
    idx.push(o, o + 1, o + 2, o, o + 2, o + 3);
  };
  const N = 6, LEN = 13;
  const p = (s: number, d: number, h: number) => {
    track.sample(s, fr);
    return fr.pos.clone().addScaledVector(fr.R, d).add(new THREE.Vector3(0, h, 0));
  };
  for (let k = 0; k < N; k++) {
    const sa = sP + dir * (LEN * k) / N, sb = sP + dir * (LEN * (k + 1)) / N;
    const ha = 7 - (6 * k) / N, hb = 7 - (6 * (k + 1)) / N;
    for (const sd of [-1, 1]) {
      const d = sd * (hw + 5.2);
      // wing wall (double-sided material)
      quad(p(sa, d, -5), p(sb, d, -5), p(sb, d, hb), p(sa, d, ha));
      // apron between the kerb and the wing wall
      quad(p(sa, sd * (hw + 0.2), -0.32), p(sb, sd * (hw + 0.2), -0.32), p(sb, d, -0.32), p(sa, d, -0.32));
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  const ng = g.toNonIndexed();
  g.dispose();
  ng.computeVertexNormals();
  const uv = new Float32Array((ng.attributes.position.count) * 2);
  ng.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  return ng;
}

/** Concatenate non-indexed geometries (position/normal/uv). */
function concat(list: THREE.BufferGeometry[]): THREE.BufferGeometry {
  let n = 0;
  for (const g of list) n += g.attributes.position.count;
  const pos = new Float32Array(n * 3), nrm = new Float32Array(n * 3), uv = new Float32Array(n * 2);
  let o = 0;
  for (const g of list) {
    const P = g.attributes.position, N = g.attributes.normal, U = g.attributes.uv;
    for (let i = 0; i < P.count; i++, o++) {
      pos[o * 3] = P.getX(i); pos[o * 3 + 1] = P.getY(i); pos[o * 3 + 2] = P.getZ(i);
      if (N) { nrm[o * 3] = N.getX(i); nrm[o * 3 + 1] = N.getY(i); nrm[o * 3 + 2] = N.getZ(i); }
      if (U) { uv[o * 2] = U.getX(i); uv[o * 2 + 1] = U.getY(i); }
    }
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  out.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  out.computeBoundingSphere();
  return out;
}
