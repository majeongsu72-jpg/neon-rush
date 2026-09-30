import * as THREE from 'three';
import type { Track } from '../../track/Track';
import type { GroundSample, Island } from './Island';
import type { Rng } from '../../core/rng';
import { canvasTexture, glowTexture } from '../textures';
import { bakeGeometry, instanceWorld } from '../props';
import { fbm2 } from '../../core/math';

export interface Landmark {
  objects: THREE.Object3D[];
  update(dt: number, time: number): void;
  dispose(): void;
}

type Prep = (m: THREE.Material) => void;

// ---------------------------------------------------------------------------
// Lighthouse

const BEAM_VERT = /* glsl */ `
#include <fog_pars_vertex>
varying float vAlong;
varying vec3 vNrm;
varying vec3 vViewDir;
void main() {
  vAlong = uv.y;
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vNrm = normalize(mat3(modelMatrix) * normal);
  vViewDir = normalize(cameraPosition - wp.xyz);
  vec4 mvPosition = viewMatrix * wp;
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}`;
const BEAM_FRAG = /* glsl */ `
#include <fog_pars_fragment>
uniform vec3 uColor;
varying float vAlong;
varying vec3 vNrm;
varying vec3 vViewDir;
void main() {
  // bright core seen side-on, fading along the beam and toward its rim
  float core = pow(abs(dot(normalize(vNrm), normalize(vViewDir))), 1.6);
  float along = pow(clamp(vAlong, 0.0, 1.0), 2.2);
  vec3 col = uColor * core * along;
#ifdef USE_FOG
  #ifdef FOG_EXP2
    float fogFactor = 1.0 - exp( - fogDensity * fogDensity * vFogDepth * vFogDepth );
  #else
    float fogFactor = smoothstep( fogNear, fogFar, vFogDepth );
  #endif
  col *= 1.0 - fogFactor; // additive: haze swallows the beam instead of tinting it
#endif
  gl_FragColor = vec4(col, 1.0);
}`;

export function buildLighthouse(isl: Island, prep: Prep): Landmark {
  const { x, z, y } = isl.lighthouse;
  const disposables: { dispose(): void }[] = [];
  const keep = <T extends { dispose(): void }>(o: T): T => {
    disposables.push(o);
    return o;
  };
  const root = new THREE.Group();
  root.name = 'lighthouse';
  root.position.set(x, y - 0.6, z);

  const H = 23;
  const stripes = keep(
    canvasTexture(16, 128, (c, w, h) => {
      const bands = 5;
      for (let i = 0; i < bands; i++) {
        c.fillStyle = i % 2 ? '#b8231c' : '#f2ede6';
        c.fillRect(0, (i * h) / bands, w, h / bands + 1);
      }
    }),
  );
  const towerMat = keep(new THREE.MeshStandardMaterial({ map: stripes, roughness: 0.55, metalness: 0.05 }));
  const darkMat = keep(new THREE.MeshStandardMaterial({ color: new THREE.Color(0.05, 0.05, 0.055), roughness: 0.45, metalness: 0.7 }));
  const roofMat = keep(new THREE.MeshStandardMaterial({ color: new THREE.Color(0.45, 0.05, 0.035), roughness: 0.4, metalness: 0.3 }));
  const houseMat = keep(new THREE.MeshStandardMaterial({ color: new THREE.Color(0.8, 0.76, 0.7), roughness: 0.8 }));
  const lampMat = keep(new THREE.MeshBasicMaterial({ color: new THREE.Color(9, 7.5, 5) }));
  for (const m of [towerMat, darkMat, roofMat, houseMat, lampMat]) prep(m);

  const tower = new THREE.Mesh(keep(new THREE.CylinderGeometry(2.1, 3.3, H, 20, 1).translate(0, H / 2, 0)), towerMat);
  tower.castShadow = true;
  const gallery = new THREE.Mesh(
    keep(
      bakeGeometry([
        { geo: new THREE.CylinderGeometry(3.3, 3.1, 0.5, 20), matrix: new THREE.Matrix4().makeTranslation(0, H + 0.25, 0) },
        { geo: new THREE.CylinderGeometry(3.2, 3.2, 1.0, 20, 1, true), matrix: new THREE.Matrix4().makeTranslation(0, H + 1.0, 0) },
        { geo: new THREE.CylinderGeometry(1.95, 1.95, 0.4, 16), matrix: new THREE.Matrix4().makeTranslation(0, H + 3.9, 0) },
      ]),
    ),
    darkMat,
  );
  const lantern = new THREE.Mesh(keep(new THREE.CylinderGeometry(1.7, 1.7, 3.2, 16).translate(0, H + 2.1, 0)), lampMat);
  const dome = new THREE.Mesh(keep(new THREE.SphereGeometry(2.0, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2).translate(0, H + 4.1, 0)), roofMat);
  const house = new THREE.Mesh(
    keep(
      bakeGeometry([
        { geo: new THREE.BoxGeometry(9, 4.2, 6.5), matrix: new THREE.Matrix4().makeTranslation(6.5, 2.1, 2) },
        { geo: new THREE.CylinderGeometry(0.01, 5.6, 2.4, 4, 1), matrix: new THREE.Matrix4().makeRotationY(Math.PI / 4).setPosition(6.5, 5.4, 2) },
      ]),
    ),
    houseMat,
  );
  house.castShadow = true;
  root.add(tower, gallery, lantern, dome, house);

  // rotating beams
  // CylinderGeometry uv.y is 1 at the top: make the top the narrow lamp end, then
  // move it to the origin and lay the cone along +X (fading toward the wide end).
  const beamGeo = keep(new THREE.CylinderGeometry(0.5, 9, 150, 18, 1, true));
  beamGeo.translate(0, -75, 0).rotateZ(Math.PI / 2);
  const beamMat = keep(
    new THREE.ShaderMaterial({
      vertexShader: BEAM_VERT,
      fragmentShader: BEAM_FRAG,
      uniforms: { ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog), uColor: { value: new THREE.Color(1.1, 0.9, 0.62) } },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      fog: true,
    }),
  );
  const beams = new THREE.Group();
  beams.position.set(0, H + 2.1, 0);
  const b1 = new THREE.Mesh(beamGeo, beamMat);
  const b2 = new THREE.Mesh(beamGeo, beamMat);
  b2.rotation.y = Math.PI;
  b1.frustumCulled = b2.frustumCulled = false;
  beams.add(b1, b2);
  root.add(beams);

  // glow halo around the lantern
  const glow = new THREE.Sprite(
    keep(
      new THREE.SpriteMaterial({
        map: keep(glowTexture(128, 2.4)),
        color: new THREE.Color(5, 3.8, 2.4),
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        transparent: true,
        fog: false,
      }),
    ),
  );
  glow.scale.set(16, 16, 1);
  glow.position.set(0, H + 2.1, 0);
  root.add(glow);

  return {
    objects: [root],
    update(_dt, time) {
      beams.rotation.y = time * 0.9;
      // brighter when a beam sweeps past the viewer is implicit in the core term
    },
    dispose() {
      for (const d of disposables) d.dispose();
    },
  };
}

// ---------------------------------------------------------------------------
// Wind turbines on the interior ridges

export function buildTurbines(track: Track, isl: Island, rng: Rng, count: number, windYaw: number, prep: Prep): Landmark {
  const disposables: { dispose(): void }[] = [];
  const keep = <T extends { dispose(): void }>(o: T): T => {
    disposables.push(o);
    return o;
  };
  // pick the highest well-spaced sites well inside the island
  const smp: GroundSample = { h: 0, natural: 0, s: 0, d: 0, dist: 0, road: 0, rock: 0, lagoon: 0 };
  const cands: { x: number; z: number; h: number }[] = [];
  for (let i = 0; i < 2600; i++) {
    const x = rng.range(isl.x0, isl.x1), z = rng.range(isl.z0, isl.z1);
    isl.sample(x, z, smp);
    if (smp.d <= 0 || smp.dist < 150 || smp.h < 30 || smp.lagoon < 60) continue;
    cands.push({ x, z, h: smp.h });
  }
  cands.sort((a, b) => b.h - a.h);
  const sites: { x: number; z: number; h: number }[] = [];
  for (const c of cands) {
    if (sites.length >= count) break;
    if (sites.some((s) => Math.hypot(s.x - c.x, s.z - c.z) < 170)) continue;
    sites.push(c);
  }
  void track;

  const white = keep(new THREE.MeshStandardMaterial({ color: new THREE.Color(0.78, 0.78, 0.8), roughness: 0.5, metalness: 0.1 }));
  const redMat = keep(new THREE.MeshBasicMaterial({ color: new THREE.Color(5, 0.2, 0.15) }));
  prep(white);
  prep(redMat);
  const HUB = 72;
  const towerGeo = keep(
    bakeGeometry([
      { geo: new THREE.CylinderGeometry(1.05, 2.1, HUB, 12, 1), matrix: new THREE.Matrix4().makeTranslation(0, HUB / 2 - 2, 0) },
      { geo: new THREE.BoxGeometry(2.8, 3, 9), matrix: new THREE.Matrix4().makeTranslation(0, HUB, -1.5) },
    ]),
  );
  // rotor in the XY plane (spins about +Z, the nacelle axis)
  const blades: { geo: THREE.BufferGeometry; matrix?: THREE.Matrix4 }[] = [{ geo: new THREE.SphereGeometry(1.4, 10, 8) }];
  for (let b = 0; b < 3; b++) {
    const shape = new THREE.Shape();
    shape.moveTo(-0.9, 0);
    shape.lineTo(1.3, 0);
    shape.quadraticCurveTo(1.4, 12, 0.35, 38);
    shape.lineTo(-0.25, 38);
    shape.quadraticCurveTo(-0.7, 10, -0.9, 0);
    const g = new THREE.ExtrudeGeometry(shape, { depth: 0.35, bevelEnabled: false, curveSegments: 6 });
    blades.push({ geo: g, matrix: new THREE.Matrix4().makeRotationZ((b / 3) * Math.PI * 2).multiply(new THREE.Matrix4().makeRotationY(0.25)) });
  }
  const rotorGeo = keep(bakeGeometry(blades));
  for (const p of blades) p.geo.dispose();
  const beaconGeo = keep(new THREE.SphereGeometry(0.6, 8, 6));

  const towerItems: { matrix: THREE.Matrix4 }[] = [];
  const beaconItems: { matrix: THREE.Matrix4 }[] = [];
  const rotorBase: { pos: THREE.Vector3; yaw: number; phase: number; speed: number; scale: number }[] = [];
  for (const s of sites) {
    const scale = rng.range(0.9, 1.1);
    const yaw = windYaw + rng.range(-0.15, 0.15);
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
    const base = new THREE.Vector3(s.x, s.h, s.z);
    towerItems.push({ matrix: new THREE.Matrix4().compose(base, q, new THREE.Vector3(scale, scale, scale)) });
    const hub = new THREE.Vector3(0, HUB * scale, 4.2 * scale).applyQuaternion(q).add(base);
    rotorBase.push({ pos: hub, yaw, phase: rng.range(0, Math.PI * 2), speed: rng.range(0.9, 1.25), scale });
    const beacon = new THREE.Vector3(0, (HUB + 1.8) * scale, -4.5 * scale).applyQuaternion(q).add(base);
    beaconItems.push({ matrix: new THREE.Matrix4().makeTranslation(beacon.x, beacon.y, beacon.z) });
  }
  const objects: THREE.Object3D[] = [];
  for (const m of instanceWorld(towerGeo, white, towerItems, 2000, 'turbineTowers')) {
    m.castShadow = true;
    objects.push(m);
  }
  for (const m of instanceWorld(beaconGeo, redMat, beaconItems, 2000, 'turbineBeacons')) objects.push(m);
  const rotors = new THREE.InstancedMesh(rotorGeo, white, Math.max(1, rotorBase.length));
  rotors.count = rotorBase.length;
  rotors.name = 'turbineRotors';
  rotors.castShadow = true;
  const mtx = new THREE.Matrix4(), q = new THREE.Quaternion(), qs = new THREE.Quaternion(), sc = new THREE.Vector3();
  const Z = new THREE.Vector3(0, 0, 1), Y = new THREE.Vector3(0, 1, 0);
  const setRotors = (time: number) => {
    rotorBase.forEach((r, i) => {
      q.setFromAxisAngle(Y, r.yaw);
      qs.setFromAxisAngle(Z, r.phase + time * r.speed);
      q.multiply(qs);
      sc.setScalar(r.scale);
      rotors.setMatrixAt(i, mtx.compose(r.pos, q, sc));
    });
    rotors.instanceMatrix.needsUpdate = true;
  };
  setRotors(0);
  rotors.computeBoundingSphere();
  objects.push(rotors);

  return {
    objects,
    update(_dt, time) {
      setRotors(time);
      const on = time % 2 < 0.9 ? 1 : 0.08; // wind farms blink in sync
      redMat.color.setRGB(5 * on, 0.2 * on, 0.15 * on);
    },
    dispose() {
      for (const d of disposables) d.dispose();
    },
  };
}

// ---------------------------------------------------------------------------
// Sailboats on the sun path + rocks

export function buildBoats(isl: Island, rng: Rng, sunDir: THREE.Vector3, count: number, prep: Prep): Landmark {
  const disposables: { dispose(): void }[] = [];
  const keep = <T extends { dispose(): void }>(o: T): T => {
    disposables.push(o);
    return o;
  };
  // hull + mast + two sails, vertex coloured
  const parts: { geo: THREE.BufferGeometry; matrix?: THREE.Matrix4; color: [number, number, number] }[] = [];
  const hull = new THREE.CylinderGeometry(1.1, 0.5, 9, 6, 1);
  hull.rotateX(Math.PI / 2).scale(1, 0.55, 1);
  parts.push({ geo: hull, matrix: new THREE.Matrix4().makeTranslation(0, 0.35, 0), color: [0.75, 0.72, 0.7] });
  parts.push({ geo: new THREE.CylinderGeometry(0.08, 0.1, 12, 5), matrix: new THREE.Matrix4().makeTranslation(0, 6.3, -0.5), color: [0.2, 0.2, 0.2] });
  const sail = (w: number, h: number, x0: number, z0: number, zDir: number): THREE.BufferGeometry => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute([x0, 1.4, z0, x0, 1.4 + h, z0, x0, 1.4, z0 + zDir * w], 3));
    g.setIndex([0, 1, 2]);
    return g;
  };
  parts.push({ geo: sail(3.6, 10.5, 0.05, -0.4, 1), color: [0.95, 0.9, 0.86] });
  parts.push({ geo: sail(2.8, 9.5, 0.05, -0.6, -1), color: [0.95, 0.55, 0.5] });
  const pos: number[] = [], col: number[] = [];
  const v = new THREE.Vector3();
  for (const p of parts) {
    const g = p.geo.index ? p.geo.toNonIndexed() : p.geo;
    const P = g.attributes.position;
    for (let i = 0; i < P.count; i++) {
      v.fromBufferAttribute(P, i);
      if (p.matrix) v.applyMatrix4(p.matrix);
      pos.push(v.x, v.y, v.z);
      col.push(...p.color);
    }
    if (g !== p.geo) g.dispose();
    p.geo.dispose();
  }
  const geo = keep(new THREE.BufferGeometry());
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  geo.computeVertexNormals();
  const mat = keep(new THREE.MeshStandardMaterial({ vertexColors: true, side: THREE.DoubleSide, roughness: 0.6 }));
  prep(mat);

  // anchor spots: open water west of the island, mostly toward the sun path
  const boats: { x: number; z: number; yaw: number; phase: number }[] = [];
  const sx = sunDir.x, sz = sunDir.z;
  const sl = Math.hypot(sx, sz) || 1;
  for (let tries = 0; boats.length < count && tries < 400; tries++) {
    const ang = Math.atan2(sz / sl, sx / sl) + rng.range(-0.7, 0.7);
    const dist = rng.range(250, 1100);
    const cx = (isl.x0 + isl.x1) / 2 - 250, cz = (isl.z0 + isl.z1) / 2;
    const x = cx + Math.cos(ang) * (dist + 500), z = cz + Math.sin(ang) * (dist + 500);
    if (isl.heightAt(x, z) > -4) continue;
    if (boats.some((b) => Math.hypot(b.x - x, b.z - z) < 90)) continue;
    boats.push({ x, z, yaw: rng.range(0, Math.PI * 2), phase: rng.range(0, 10) });
  }
  const mesh = new THREE.InstancedMesh(geo, mat, Math.max(1, boats.length));
  mesh.count = boats.length;
  mesh.name = 'sailboats';
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), p = new THREE.Vector3(), s1 = new THREE.Vector3(1, 1, 1);
  const place = (time: number) => {
    boats.forEach((b, i) => {
      e.set(Math.sin(time * 0.9 + b.phase) * 0.05, b.yaw, Math.sin(time * 0.7 + b.phase * 1.3) * 0.07);
      q.setFromEuler(e);
      p.set(b.x, Math.sin(time * 1.1 + b.phase) * 0.25, b.z);
      mesh.setMatrixAt(i, m.compose(p, q, s1));
    });
    mesh.instanceMatrix.needsUpdate = true;
  };
  place(0);
  mesh.computeBoundingSphere();
  if (mesh.boundingSphere) mesh.boundingSphere.radius += 20;
  return {
    objects: [mesh],
    update(_dt, time) {
      place(time);
    },
    dispose() {
      for (const d of disposables) d.dispose();
    },
  };
}

/** Boulders on cliff tops, cliff feet and the lighthouse point. */
export function buildRocks(isl: Island, rng: Rng, count: number, prep: Prep): Landmark {
  const disposables: { dispose(): void }[] = [];
  const base = new THREE.IcosahedronGeometry(1, 1);
  const P = base.attributes.position;
  const v = new THREE.Vector3();
  for (let i = 0; i < P.count; i++) {
    v.fromBufferAttribute(P, i);
    const k = 1 + 0.28 * fbm2(v.x * 1.7 + 3, v.y * 1.7 + v.z * 1.3, 2, 91);
    P.setXYZ(i, v.x * k, v.y * k * 0.72, v.z * k);
  }
  base.computeVertexNormals();
  disposables.push(base);
  const mat = new THREE.MeshStandardMaterial({ color: new THREE.Color(0.25, 0.19, 0.15), roughness: 0.92, flatShading: true });
  disposables.push(mat);
  prep(mat);
  const smp: GroundSample = { h: 0, natural: 0, s: 0, d: 0, dist: 0, road: 0, rock: 0, lagoon: 0 };
  const items: { matrix: THREE.Matrix4; color?: THREE.Color }[] = [];
  for (let tries = 0; items.length < count && tries < count * 60; tries++) {
    const x = rng.range(isl.x0, isl.x1), z = rng.range(isl.z0, isl.z1);
    isl.sample(x, z, smp);
    if (smp.rock < 0.45 || smp.h < -1.5 || smp.road > 0.05) continue;
    if (smp.dist < isl.track.halfWidthAt(smp.s) + 4) continue;
    const s = rng.range(0.8, 3.4) * (smp.h < 1 ? 1.4 : 1);
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(rng.range(-0.3, 0.3), rng.range(0, 6.3), rng.range(-0.3, 0.3)));
    const tint = rng.range(0.75, 1.15);
    items.push({
      matrix: new THREE.Matrix4().compose(new THREE.Vector3(x, smp.h - s * 0.25, z), q, new THREE.Vector3(s * rng.range(0.8, 1.4), s, s * rng.range(0.8, 1.3))),
      color: new THREE.Color(tint, tint * rng.range(0.92, 1.0), tint * rng.range(0.85, 1.0)),
    });
  }
  const objects = instanceWorld(base, mat, items, 900, 'rocks');
  for (const o of objects) o.castShadow = true;
  return {
    objects,
    update() {},
    dispose() {
      for (const d of disposables) d.dispose();
    },
  };
}
