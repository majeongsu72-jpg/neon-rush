import * as THREE from 'three';
import type { Track } from '../../track/Track';
import { F_LOOP } from '../../track/types';
import { placementMatrix } from '../props';
import { GLSL_COMMON, GLSL_FOG_FADE, PAL, fogUniforms, type GridUniforms } from './common';

/** Gate kinds (aGate.w). */
const REGULAR = 0;
const START = 1;
const HALO = 2;
/** Gate centre height above the road; outline radius ≈ 13.6 m clears deck + barriers. */
const GATE_H = 3;

const VERT = /* glsl */ `
attribute vec4 aGate; // s, shape (0 ring / 1 hexagon), seed, kind
attribute vec3 aColor;
varying vec2 vLocal;
varying vec4 vGate;
varying vec3 vColor;
#include <fog_pars_vertex>
void main() {
  vLocal = position.xy;
  vGate = aGate;
  vColor = aColor;
  vec4 mvPosition = modelViewMatrix * instanceMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}
`;

/** Hard neon outline + soft halo, rotating segments, flare as the camera approaches, flash after passing. */
const FRAG = /* glsl */ `
uniform float uClock;
uniform float uPulse;
uniform float uCamS;
uniform float uLen;
varying vec2 vLocal;
varying vec4 vGate;
varying vec3 vColor;
#include <fog_pars_fragment>
${GLSL_COMMON}
void main() {
  float r = length(vLocal);
  float ang = atan(vLocal.y, vLocal.x);
  float dist;
  if (vGate.y < 0.5) {
    dist = r - 13.6;
  } else {
    vec2 p = abs(vLocal);
    dist = max(p.x * 0.8660254 + p.y * 0.5, p.y) - 13.0;
  }
  bool halo = vGate.w > 1.5;
  float core = gLine(dist, halo ? 0.3 : 0.17);
  float glow = exp(-abs(dist) * 1.5) * 0.45 + exp(-abs(dist) * 0.5) * 0.08;
  float dir = fract(vGate.z * 13.0) > 0.5 ? 0.5 : -0.5;
  float nSeg = halo ? 60.0 : 36.0;
  // angular footprint from the position derivatives (atan jumps at ±π)
  float angW = (length(dFdx(vLocal)) + length(dFdy(vLocal))) / max(r, 1e-3) / G_TAU * nSeg;
  float seg = gBandW(ang / G_TAU * nSeg + uClock * dir, 0.74, angW);
  float ahead = gWrap(vGate.x - uCamS, uLen);
  float approach = halo ? 0.0 : (1.0 - smoothstep(15.0, 150.0, ahead)) * step(-3.0, ahead);
  float flash = halo ? 0.0 : step(ahead, 0.0) * exp(min(ahead, 0.0) * 0.06); // min(): exp overflow → 0·inf = NaN
  float I = (core * mix(0.45, 1.0, seg) * (2.2 + 3.5 * approach) + glow * (0.8 + 1.2 * approach)) * (1.0 + 1.0 * uPulse);
  I += core * flash * 3.0;
  vec3 col = mix(vColor, vec3(1.0), clamp(0.4 * approach * core + 0.5 * flash * core, 0.0, 1.0)) * I;
  gl_FragColor = vec4(col, 1.0);
  ${GLSL_FOG_FADE}
}
`;

interface GateItem {
  matrix: THREE.Matrix4;
  s: number;
  shape: number;
  seed: number;
  kind: number;
  color: THREE.Color;
}

export interface Gates {
  meshes: THREE.InstancedMesh[];
  passables: number[];
  disposables: { dispose(): void }[];
  /** Shared by the core rings. */
  material: THREE.ShaderMaterial;
  base: THREE.BufferGeometry;
}

/** True if a hoop at s would cut through another part of the circuit (crossover, loop). */
function blocked(track: Track, s: number): boolean {
  const i0 = track.idx(s);
  if (track.flags[i0] & F_LOOP) return true;
  for (const sec of track.sectionsOf('loop')) if (track.inRange(s, sec.s0 - 45, sec.s1 + 45)) return true;
  const x = track.px[i0], y = track.py[i0], z = track.pz[i0];
  for (let j = 0; j < track.N; j += 3) {
    if (Math.abs(track.delta(s, j * track.ds)) < 70) continue;
    const dx = track.px[j] - x, dz = track.pz[j] - z;
    if (dx * dx + dz * dz < 26 * 26 && Math.abs(track.py[j] - y) < 24) return true;
  }
  return false;
}

export function buildGates(track: Track, U: GridUniforms, density: number): Gates {
  const L = track.length;
  const items: GateItem[] = [];
  const passables: number[] = [];
  const m = new THREE.Matrix4();
  const add = (s: number, shape: number, kind: number, color: THREE.Color, scale = 1) => {
    placementMatrix(track, { s, d: 0, h: GATE_H, upright: false, scale: [scale, scale, scale] }, m);
    items.push({ matrix: m.clone(), s: track.wrap(s), shape, seed: items.length * 0.6180339 + 0.1, kind, color });
    passables.push(track.wrap(s));
  };

  // start / finish arch
  add(0, 0, START, new THREE.Color(0.9, 0.9, 1.0), 1.12);
  // dense tunnels of rings inside 'rings' sections
  const rings = track.sectionsOf('rings');
  const inRings = (s: number) => rings.some((r) => track.inRange(s, r.s0 - 12, r.s1 + 12));
  const ringSpacing = density >= 0.8 ? 28 : 40;
  let alt = 0;
  for (const sec of rings) {
    const len = track.wrap(sec.s1 - sec.s0);
    for (let x = 14; x < len - 4; x += ringSpacing) {
      const s = sec.s0 + x;
      if (Math.abs(track.delta(s, 0)) < 20 || blocked(track, s)) continue;
      add(s, 0, REGULAR, (alt++ & 1 ? PAL.magenta : PAL.cyan).clone());
    }
  }
  // hexagonal portals around the rest of the lap
  const every = density >= 0.8 ? 170 : 240;
  for (let s = 90; s < L - 60; s += every) {
    if (inRings(s) || blocked(track, s)) continue;
    add(s, 1, REGULAR, (alt++ & 1 ? PAL.violet : PAL.cyan).clone());
  }

  // giant halo framing the loop (in the loop plane, around its centre)
  for (const sec of track.sectionsOf('loop')) {
    const len = track.wrap(sec.s1 - sec.s0);
    let top = sec.s0;
    for (let x = 0; x < len; x += 1) if (track.py[track.idx(sec.s0 + x)] > track.py[track.idx(top)]) top = sec.s0 + x;
    const iTop = track.idx(top), iBase = track.idx(sec.s0);
    const radius = (track.py[iTop] - track.py[iBase]) / 2;
    const center = new THREE.Vector3(track.px[iTop], track.py[iBase] + radius, track.pz[iTop]);
    const ax = sec.def.axis ?? [1, 0, 0];
    const normal = new THREE.Vector3(ax[0], ax[1], ax[2]).normalize();
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), normal);
    const scale = (radius + 13) / 13.6;
    items.push({
      matrix: new THREE.Matrix4().compose(center, q, new THREE.Vector3(scale, scale, scale)),
      s: -1e5,
      shape: 0,
      seed: 0.77,
      kind: HALO,
      color: PAL.magenta.clone(),
    });
  }

  // ---- instanced meshes, bucketed along s so frustum culling works
  const base = new THREE.RingGeometry(11.0, 16.6, 128, 1);
  const mat = new THREE.ShaderMaterial({
    vertexShader: VERT,
    fragmentShader: FRAG,
    uniforms: { ...fogUniforms(), uClock: U.uClock, uPulse: U.uPulse, uCamS: U.uCamS, uLen: U.uLen },
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    fog: true,
  });
  const disposables: { dispose(): void }[] = [base, mat];
  const buckets = new Map<number, GateItem[]>();
  for (const it of items) {
    const k = it.kind === HALO ? -1 : Math.floor(it.s / 500);
    let arr = buckets.get(k);
    if (!arr) buckets.set(k, (arr = []));
    arr.push(it);
  }
  const meshes: THREE.InstancedMesh[] = [];
  for (const arr of buckets.values()) {
    const g = new THREE.BufferGeometry();
    g.setIndex(base.getIndex());
    g.setAttribute('position', base.getAttribute('position'));
    const gate = new Float32Array(arr.length * 4);
    const col = new Float32Array(arr.length * 3);
    arr.forEach((it, i) => {
      gate.set([it.s, it.shape, it.seed, it.kind], i * 4);
      col.set([it.color.r, it.color.g, it.color.b], i * 3);
    });
    g.setAttribute('aGate', new THREE.InstancedBufferAttribute(gate, 4));
    g.setAttribute('aColor', new THREE.InstancedBufferAttribute(col, 3));
    g.boundingSphere = null;
    const im = new THREE.InstancedMesh(g, mat, arr.length);
    im.name = 'gridGates';
    arr.forEach((it, i) => im.setMatrixAt(i, it.matrix));
    im.instanceMatrix.needsUpdate = true;
    im.computeBoundingSphere();
    im.renderOrder = 3;
    meshes.push(im);
    disposables.push(g);
  }
  return { meshes, passables, disposables, material: mat, base };
}

export interface CoreRings {
  mesh: THREE.InstancedMesh;
  disposables: { dispose(): void }[];
  update(time: number): void;
}

/** Gyroscope of giant rings tumbling around the infield core. */
export function buildCoreRings(gates: Gates, center: THREE.Vector3, radii: number[]): CoreRings {
  const n = radii.length;
  const g = new THREE.BufferGeometry();
  g.setIndex(gates.base.getIndex());
  g.setAttribute('position', gates.base.getAttribute('position'));
  const gate = new Float32Array(n * 4);
  const col = new Float32Array(n * 3);
  const cols = [PAL.cyan, PAL.magenta, PAL.violet];
  for (let i = 0; i < n; i++) {
    gate.set([-1e5, 0, 0.31 + i * 0.29, HALO], i * 4);
    const c = cols[i % cols.length];
    col.set([c.r, c.g, c.b], i * 3);
  }
  g.setAttribute('aGate', new THREE.InstancedBufferAttribute(gate, 4));
  g.setAttribute('aColor', new THREE.InstancedBufferAttribute(col, 3));
  const mesh = new THREE.InstancedMesh(g, gates.material, n);
  mesh.name = 'gridCoreRings';
  mesh.renderOrder = 3;
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  // each ring stands on edge and spins about its own tilted axis
  const base = radii.map((_, i) => new THREE.Quaternion().setFromEuler(new THREE.Euler(Math.PI / 2 + 0.5 * i, 0.9 * i, 0.25 * i)));
  const axes = radii.map((_, i) => new THREE.Vector3(Math.sin(i * 1.7) * 0.4, 1, Math.cos(i * 2.3) * 0.4).normalize());
  const rates = radii.map((_, i) => (i % 2 ? -1 : 1) * (0.07 + 0.035 * i));
  const q = new THREE.Quaternion();
  const m = new THREE.Matrix4();
  const sc = new THREE.Vector3();
  const update = (time: number) => {
    for (let i = 0; i < n; i++) {
      q.setFromAxisAngle(axes[i], time * rates[i]).multiply(base[i]);
      mesh.setMatrixAt(i, m.compose(center, q, sc.setScalar(radii[i] / 13.6)));
    }
    mesh.instanceMatrix.needsUpdate = true;
  };
  update(0);
  mesh.computeBoundingSphere(); // centred rings: rotation never leaves this sphere
  return { mesh, disposables: [g], update };
}
