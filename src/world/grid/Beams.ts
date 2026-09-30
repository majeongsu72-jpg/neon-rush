import * as THREE from 'three';
import type { Track } from '../../track/Track';
import { makeFrame } from '../../track/Track';
import { F_LOOP } from '../../track/types';
import { GLSL_COMMON, GLSL_FOG_FADE, fogUniforms, type GridUniforms } from './common';

const VERT = /* glsl */ `
attribute float aSeed;
varying vec2 vUv;
varying float vY;
varying float vH;
varying float vSeed;
#include <fog_pars_vertex>
void main() {
  // cylindrical billboard: the unit quad turns around world Y to face the camera
  vec3 base = (modelMatrix * vec4(instanceMatrix[3].xyz, 1.0)).xyz;
  float w = length(instanceMatrix[0].xyz);
  float h = length(instanceMatrix[1].xyz);
  vec3 toCam = cameraPosition - base;
  vec3 side = normalize(vec3(toCam.z, 0.0, -toCam.x) + vec3(1e-4, 0.0, 0.0));
  vec3 wp = base + side * position.x * w + vec3(0.0, position.y * h, 0.0);
  vUv = uv;
  vY = position.y * h;
  vH = h;
  vSeed = aSeed;
  vec4 mvPosition = viewMatrix * vec4(wp, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}
`;

/** Laser column: hot core, soft sheath, energy packets streaming upward. */
const FRAG = /* glsl */ `
uniform float uClock;
uniform float uPulse;
varying vec2 vUv;
varying float vY;
varying float vH;
varying float vSeed;
#include <fog_pars_fragment>
${GLSL_COMMON}
void main() {
  float x = vUv.x * 2.0 - 1.0;
  float core = exp(-x * x * 40.0);
  float sheath = exp(-x * x * 5.0) * 0.25;
  float flow = gBand(vY / 14.0 - uClock * 2.0 - vSeed * 7.0, 0.35);
  float fade = smoothstep(0.0, 30.0, vY) * (1.0 - smoothstep(vH - 28.0, vH, vY));
  float I = (core * (1.1 + 1.9 * flow) + sheath * (0.6 + flow)) * fade * (1.0 + 1.5 * uPulse);
  vec3 col = mix(G_CYAN, G_MAGENTA, step(0.5, fract(vSeed * 3.0))) * I;
  gl_FragColor = vec4(col, 1.0);
  ${GLSL_FOG_FADE}
}
`;

export interface Beams {
  meshes: THREE.InstancedMesh[];
  passables: number[];
  disposables: { dispose(): void }[];
}

/**
 * Light columns from the grid floor up past the deck, alternating sides of the
 * road, plus free-standing `pillars` (e.g. the infield core's sky beam).
 */
export function buildBeams(
  track: Track,
  U: GridUniforms,
  density: number,
  pillars: { x: number; z: number; top: number; width: number }[] = [],
): Beams {
  const L = track.length;
  const spacing = density >= 0.8 ? 115 : 160;
  const fr = makeFrame();
  const items: { x: number; z: number; top: number; s: number; seed: number; width: number }[] = [];
  let side = 1;
  for (let s = 40; s < L - 20; s += spacing) {
    side = -side;
    track.surface(s, side * (track.halfWidthAt(s) + 8), fr);
    if (track.flags[track.idx(s)] & F_LOOP) continue;
    const x = fr.pos.x, z = fr.pos.z, top = fr.pos.y + 34;
    // never pierce another part of the circuit (crossover, loop)
    let clear = true;
    for (let j = 0; j < track.N && clear; j += 3) {
      if (Math.abs(track.delta(s, j * track.ds)) < 30) continue;
      const dx = track.px[j] - x, dz = track.pz[j] - z;
      const r = track.halfWidth[j] + 6;
      if (dx * dx + dz * dz < r * r && track.py[j] < top + 4) clear = false;
    }
    if (clear) items.push({ x, z, top, s, seed: items.length * 0.37 + 0.05, width: 1.8 });
  }
  const passables = items.map((it) => it.s);
  // seed 0.1 → cyan (fract(3·seed) < 0.5)
  for (const p of pillars) items.push({ x: p.x, z: p.z, top: p.top, s: -1e5, seed: 0.1, width: p.width });

  const geo = new THREE.PlaneGeometry(1, 1);
  geo.translate(0, 0.5, 0);
  const mat = new THREE.ShaderMaterial({
    vertexShader: VERT,
    fragmentShader: FRAG,
    uniforms: { ...fogUniforms(), uClock: U.uClock, uPulse: U.uPulse },
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    fog: true,
  });
  const disposables: { dispose(): void }[] = [geo, mat];
  const meshes: THREE.InstancedMesh[] = [];
  const chunk = 600;
  const buckets = new Map<number, typeof items>();
  for (const it of items) {
    const k = Math.floor(it.s / chunk);
    let arr = buckets.get(k);
    if (!arr) buckets.set(k, (arr = []));
    arr.push(it);
  }
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const p = new THREE.Vector3();
  const sc = new THREE.Vector3();
  for (const arr of buckets.values()) {
    const g = new THREE.BufferGeometry();
    g.setIndex(geo.getIndex());
    g.setAttribute('position', geo.getAttribute('position'));
    g.setAttribute('uv', geo.getAttribute('uv'));
    g.setAttribute('aSeed', new THREE.InstancedBufferAttribute(new Float32Array(arr.map((it) => it.seed)), 1));
    const im = new THREE.InstancedMesh(g, mat, arr.length);
    im.name = 'gridBeams';
    arr.forEach((it, i) => im.setMatrixAt(i, m.compose(p.set(it.x, 0, it.z), q, sc.set(it.width, it.top, 1))));
    im.instanceMatrix.needsUpdate = true;
    im.computeBoundingSphere();
    im.renderOrder = 1;
    meshes.push(im);
    disposables.push(g);
  }
  return { meshes, passables, disposables };
}
