import * as THREE from 'three';
import type { Track } from '../../track/Track';
import { makeFrame } from '../../track/Track';
import { sweep, type ProfilePoint } from '../../track/TrackMesh';
import { bakeGeometry } from '../props';
import { canvasTexture, dashTexture } from '../textures';

/**
 * Suspension bridge across the lagoon mouth: two art-deco towers in the bay,
 * parabolic main cables over their saddles down to anchorages at both ends,
 * vertical hangers every 12 m (the rhythmic "whoosh" of the crossing), a deep
 * truss girder under the deck with a warm LED fascia, caisson piers and
 * abutments. Towers glow orange in the low sun; aviation lights blink.
 */
export interface BridgeBuild {
  group: THREE.Group;
  passables: number[];
  update(time: number): void;
  dispose(): void;
}

const TOWER_H = 50; // above the deck
const CABLE_LOW = 3.2; // cable height above the deck at mid-span
const HANGER_STEP = 12;

export function buildBridge(track: Track, prep: (m: THREE.Material) => void): BridgeBuild | null {
  const br = track.sectionsOf('bridge')[0];
  if (!br) return null;
  const group = new THREE.Group();
  group.name = 'bridge';
  const disposables: { dispose(): void }[] = [];
  const keep = <T extends { dispose(): void }>(x: T): T => {
    disposables.push(x);
    return x;
  };
  const len = track.wrap(br.s1 - br.s0);
  const sT1 = br.s0 + 0.252 * len;
  const sT2 = br.s1 - 0.252 * len;
  const sA1 = br.s0 - 5;
  const sA2 = br.s1 - 6;
  const hw = track.halfWidthAt(sT1);
  const dc = hw + 3.1; // cable/hanger plane: on the girder's outer face
  const dL = hw + 4.9; // tower legs stand outboard so the girder passes between them
  /** The cable plane swings out to the tower saddles. */
  const cableD = (s: number) => dc + (dL - dc) * Math.max(0, 1 - Math.min(Math.abs(s - sT1), Math.abs(s - sT2)) / 70) ** 2;
  const fr = makeFrame();

  /** Main cable height above the deck at s. */
  const cableH = (s: number): number => {
    if (s <= sT1) {
      const u = (s - sA1) / (sT1 - sA1);
      return 3 + (TOWER_H - 3) * u - 5 * 4 * u * (1 - u);
    }
    if (s >= sT2) {
      const u = (s - sT2) / (sA2 - sT2);
      return TOWER_H + (5 - TOWER_H) * u - 5 * 4 * u * (1 - u);
    }
    const mid = (sT1 + sT2) / 2, half = (sT2 - sT1) / 2;
    const x = (s - mid) / half;
    return CABLE_LOW + (TOWER_H - CABLE_LOW) * x * x;
  };
  /** World point at (s, d) with a vertical offset h above the deck surface there. */
  const worldAt = (s: number, d: number, h: number, out: THREE.Vector3): THREE.Vector3 => {
    track.sample(s, fr);
    out.copy(fr.pos).addScaledVector(fr.R, d);
    out.y += h;
    return out;
  };

  // ---------------------------------------------------------------- materials
  const steel = keep(new THREE.MeshStandardMaterial({ color: new THREE.Color(0.6, 0.085, 0.03), roughness: 0.5, metalness: 0.35, envMapIntensity: 0.8 }));
  const cableMat = keep(new THREE.MeshStandardMaterial({ color: new THREE.Color(0.5, 0.09, 0.035), roughness: 0.42, metalness: 0.55 }));
  const concrete = keep(new THREE.MeshStandardMaterial({ color: new THREE.Color(0.34, 0.3, 0.28), roughness: 0.88, metalness: 0.02 }));
  const trussTex = keep(
    canvasTexture(128, 128, (c, w, h) => {
      c.fillStyle = '#2a1c1c';
      c.fillRect(0, 0, w, h);
      c.strokeStyle = '#a3321c';
      c.lineWidth = 9;
      c.strokeRect(4, 4, w - 8, h - 8);
      c.lineWidth = 7;
      c.beginPath();
      c.moveTo(6, 6);
      c.lineTo(w - 6, h - 6);
      c.moveTo(w - 6, 6);
      c.lineTo(6, h - 6);
      c.stroke();
      c.fillStyle = 'rgba(0,0,0,0.25)';
      c.fillRect(0, h * 0.46, w, h * 0.08);
    }),
  );
  const trussMat = keep(new THREE.MeshStandardMaterial({ map: trussTex, roughness: 0.6, metalness: 0.4, color: new THREE.Color(1, 0.9, 0.85) }));
  const ledTex = keep(dashTexture(0.45, 0.2));
  const ledMat = keep(new THREE.MeshBasicMaterial({ color: new THREE.Color(3.4, 1.5, 0.55), map: ledTex }));
  const aviMat = keep(new THREE.MeshBasicMaterial({ color: new THREE.Color(6, 0.3, 0.2) }));
  for (const m of [steel, cableMat, concrete, trussMat, ledMat, aviMat]) prep(m);

  // ---------------------------------------------------------------- towers
  const towerParts: { geo: THREE.BufferGeometry; matrix?: THREE.Matrix4 }[] = [];
  const pierParts: { geo: THREE.BufferGeometry; matrix?: THREE.Matrix4 }[] = [];
  const aviPos: THREE.Vector3[] = [];
  const basis = new THREE.Matrix4();
  const box = (w: number, h: number, dpt: number, x: number, y: number, z: number, into: typeof towerParts) => {
    const g = new THREE.BoxGeometry(w, h, dpt);
    into.push({ geo: g, matrix: basis.clone().multiply(new THREE.Matrix4().makeTranslation(x, y, z)) });
  };
  for (const sT of [sT1, sT2]) {
    track.sample(sT, fr);
    const R = new THREE.Vector3(fr.R.x, 0, fr.R.z).normalize();
    const T = new THREE.Vector3(fr.T.x, 0, fr.T.z).normalize();
    // local frame: X = right, Y = up, Z = -forward (so boxes sit square to the road)
    basis.makeBasis(R, new THREE.Vector3(0, 1, 0), T.clone().negate()).setPosition(fr.pos.x, 0, fr.pos.z);
    const deck = fr.pos.y;
    const top = deck + TOWER_H;
    const base = -7;
    for (const sd of [-1, 1]) {
      const x = sd * dL;
      // stepped art-deco legs: three tiers tapering upward
      const tiers: [number, number, number, number][] = [
        [base, deck + 10, 3.2, 5.2],
        [deck + 10, deck + 32, 2.8, 4.4],
        [deck + 32, top, 2.4, 3.6],
      ];
      for (const [y0, y1, w, dpt] of tiers) box(w, y1 - y0, dpt, x, (y0 + y1) / 2, 0, towerParts);
      box(1.6, 2.2, 2.2, x, top + 1.1, 0, towerParts); // saddle housing
      aviPos.push(new THREE.Vector3(x, top + 2.4, 0).applyMatrix4(basis));
      aviPos.push(new THREE.Vector3(x - sd * 1.55, deck + 30, 0).applyMatrix4(basis));
    }
    // portal struts (the deck girder passes between the legs)
    const span = dL * 2;
    box(span, 2.4, 3.2, 0, deck - 4.6, 0, towerParts);
    box(span, 2.2, 2.6, 0, deck + 21, 0, towerParts);
    box(span, 1.6, 2.2, 0, deck + 23.2, 0, towerParts);
    box(span, 2.4, 2.4, 0, deck + 39, 0, towerParts);
    box(span + 2, 1.8, 2.6, 0, top - 0.4, 0, towerParts);
    // caisson pier at the waterline
    box(span + 12, 11, 12, 0, -5.5 + 2.2, 0, pierParts);
  }
  const towers = new THREE.Mesh(keep(bakeGeometry(towerParts)), steel);
  for (const p of towerParts) p.geo.dispose();
  towers.castShadow = true;
  towers.receiveShadow = true;
  towers.name = 'bridgeTowers';
  group.add(towers);

  // abutments under both deck ends + anchorage blocks where the main cables end
  const frameAt = (sA: number) => {
    track.sample(sA, fr);
    const R = new THREE.Vector3(fr.R.x, 0, fr.R.z).normalize();
    const T = new THREE.Vector3(fr.T.x, 0, fr.T.z).normalize();
    basis.makeBasis(R, new THREE.Vector3(0, 1, 0), T.clone().negate()).setPosition(fr.pos.x, 0, fr.pos.z);
    return fr.pos.y;
  };
  for (const [sA, dir] of [[br.s0 + 2, -1], [br.s1 - 3, 1]] as [number, number][]) {
    const deck = frameAt(sA);
    box(dc * 2 + 3, deck + 6, 16, 0, (deck - 0.6 - 6) / 2 - 0.1, dir * 4, pierParts);
  }
  for (const sA of [sA1, sA2]) {
    const deck = frameAt(sA);
    for (const sd of [-1, 1]) box(4.2, 7.5, 6, sd * (dc + 0.6), deck + 1.8, 0, pierParts);
  }
  const piers = new THREE.Mesh(keep(bakeGeometry(pierParts)), concrete);
  for (const p of pierParts) p.geo.dispose();
  piers.receiveShadow = true;
  piers.name = 'bridgePiers';
  group.add(piers);

  // ---------------------------------------------------------------- aviation lights
  const aviGeo = keep(new THREE.SphereGeometry(0.55, 10, 6));
  const avi = new THREE.InstancedMesh(aviGeo, aviMat, aviPos.length);
  aviPos.forEach((p, i) => avi.setMatrixAt(i, new THREE.Matrix4().makeTranslation(p.x, p.y, p.z)));
  avi.instanceMatrix.needsUpdate = true;
  avi.computeBoundingSphere();
  avi.name = 'aviationLights';
  group.add(avi);

  // ---------------------------------------------------------------- main cables
  const cableGeos: THREE.BufferGeometry[] = [];
  const v = new THREE.Vector3();
  for (const sd of [-1, 1]) {
    const pts: THREE.Vector3[] = [];
    let sLast = sA1;
    for (let s = sA1; s <= sA2 + 1e-6; s += 5) {
      pts.push(worldAt(s, sd * cableD(s), cableH(s), v).clone());
      sLast = s;
    }
    if (sA2 - sLast > 0.5) pts.push(worldAt(sA2, sd * cableD(sA2), cableH(sA2), v).clone());
    const curve = new THREE.CatmullRomCurve3(pts, false, 'centripetal');
    cableGeos.push(new THREE.TubeGeometry(curve, pts.length * 2, 0.45, 7, false));
  }
  const cablesGeo = keep(mergeGeos(cableGeos));
  for (const g of cableGeos) g.dispose();
  const cables = new THREE.Mesh(cablesGeo, cableMat);
  cables.castShadow = true;
  cables.name = 'mainCables';
  group.add(cables);

  // ---------------------------------------------------------------- hangers
  const passables: number[] = [];
  const hangerGeo = keep(new THREE.CylinderGeometry(1, 1, 1, 5, 1, true).translate(0, 0.5, 0));
  const hangerMatrices: THREE.Matrix4[] = [];
  for (let s = sA1 + 10; s < sA2 - 4; s += HANGER_STEP) {
    if (Math.abs(s - sT1) < 4 || Math.abs(s - sT2) < 4) continue;
    const h = cableH(s) - 0.9;
    if (h < 1) continue;
    for (const sd of [-1, 1]) {
      worldAt(s, sd * cableD(s), 0.9, v);
      hangerMatrices.push(new THREE.Matrix4().compose(v.clone(), new THREE.Quaternion(), new THREE.Vector3(0.075, h, 0.075)));
    }
    passables.push(track.wrap(s));
  }
  const hangers = new THREE.InstancedMesh(hangerGeo, cableMat, hangerMatrices.length);
  hangerMatrices.forEach((m, i) => hangers.setMatrixAt(i, m));
  hangers.instanceMatrix.needsUpdate = true;
  hangers.computeBoundingSphere();
  hangers.name = 'hangers';
  group.add(hangers);

  // ---------------------------------------------------------------- girder + LED fascia
  const girder: ProfilePoint[] = [
    { e: 1, d: 2.9, h: -0.25 },
    { e: 1, d: 2.9, h: -4.1 },
    { e: 1, d: 0.6, h: -4.6 },
    { e: -1, d: 0.6, h: -4.6 },
    { e: -1, d: 2.9, h: -4.1 },
    { e: -1, d: 2.9, h: -0.25 },
  ];
  for (const g of sweep(track, { s0: br.s0, len, step: 4, chunk: 400, profile: girder, uScale: 1 / 3.85, vScale: 1 / 8 })) {
    const m = new THREE.Mesh(keep(g), trussMat);
    m.receiveShadow = true;
    m.name = 'bridgeGirder';
    group.add(m);
  }
  // outward-facing strips (right: top → bottom, left: bottom → top)
  const ledR: ProfilePoint[] = [
    { e: 1, d: 2.95, h: -0.55 },
    { e: 1, d: 2.95, h: -0.75 },
  ];
  const ledL: ProfilePoint[] = [
    { e: -1, d: 2.95, h: -0.75 },
    { e: -1, d: 2.95, h: -0.55 },
  ];
  for (const prof of [ledR, ledL]) {
    for (const g of sweep(track, { s0: br.s0, len, step: 4, chunk: 800, profile: prof, uScale: 1, vScale: 1 / 3 })) {
      const m = new THREE.Mesh(keep(g), ledMat);
      m.name = 'bridgeLeds';
      group.add(m);
    }
  }

  return {
    group,
    passables,
    update(time: number) {
      // double-flash aviation beacons
      const ph = time % 1.6;
      const on = ph < 0.08 || (ph > 0.22 && ph < 0.3) ? 1 : 0;
      aviMat.color.setRGB(0.6 + 7 * on, 0.03 + 0.35 * on, 0.02 + 0.25 * on);
    },
    dispose() {
      for (const d of disposables) d.dispose();
    },
  };
}

function mergeGeos(list: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const pos: number[] = [], nrm: number[] = [], uv: number[] = [], idx: number[] = [];
  let base = 0;
  for (const g of list) {
    const P = g.attributes.position, N = g.attributes.normal, U = g.attributes.uv;
    for (let i = 0; i < P.count; i++) {
      pos.push(P.getX(i), P.getY(i), P.getZ(i));
      nrm.push(N.getX(i), N.getY(i), N.getZ(i));
      uv.push(U ? U.getX(i) : 0, U ? U.getY(i) : 0);
    }
    const I = g.index;
    if (I) for (let i = 0; i < I.count; i++) idx.push(I.getX(i) + base);
    else for (let i = 0; i < P.count; i++) idx.push(i + base);
    base += P.count;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  out.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  out.setIndex(idx);
  out.computeBoundingSphere();
  return out;
}
