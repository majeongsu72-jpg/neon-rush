import * as THREE from 'three';
import type { Track } from '../../track/Track';
import { makeFrame } from '../../track/Track';
import { GLSL_COMMON, GLSL_FOG_FADE, fogUniforms, type GridUniforms } from './common';

const FLOOR_SIZE = 16000;

const FLOOR_VERT = /* glsl */ `
varying vec3 vWorld;
#include <fog_pars_vertex>
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorld = wp.xyz;
  vec4 mvPosition = viewMatrix * wp;
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}
`;

/**
 * Endless neon grid far below the circuit. Lines use a "pristine grid" box
 * filter (line width clamped to the pixel footprint, then faded to its mean
 * coverage), so the floor stays clean from overhead down to grazing angles.
 */
const FLOOR_FRAG = /* glsl */ `
uniform float uClock;
uniform float uPulse;
uniform float uBeatAge;
uniform vec3 uBeatOrigin;
uniform float uFar;
uniform vec3 uBaseCol;
uniform vec3 uHaze;
varying vec3 vWorld;
#include <fog_pars_fragment>
${GLSL_COMMON}
float gGrid(vec2 uv, float lineWidth) {
  vec2 deriv = vec2(length(vec2(dFdx(uv.x), dFdy(uv.x))), length(vec2(dFdx(uv.y), dFdy(uv.y))));
  vec2 drawWidth = clamp(vec2(lineWidth), deriv, vec2(0.5));
  vec2 lineAA = max(deriv, vec2(1e-6)) * 1.5;
  vec2 gridUV = 1.0 - abs(fract(uv) * 2.0 - 1.0);
  vec2 g2 = 1.0 - smoothstep(drawWidth - lineAA, drawWidth + lineAA, gridUV);
  g2 *= clamp(vec2(lineWidth) / drawWidth, 0.0, 1.0);
  g2 = mix(g2, vec2(lineWidth), clamp(deriv * 2.0 - 1.0, 0.0, 1.0));
  return mix(g2.x, 1.0, g2.y);
}
void main() {
  vec2 p = vWorld.xz;
  float dist = length(vWorld - cameraPosition);
  float minor = gGrid(p / 10.0, 0.018);
  float major = gGrid(p / 80.0, 0.0065);
  float sector = gGrid(p / 640.0, 0.0018);
  // ring wave expanding from where the camera was on each kick
  float rx = (length(p - uBeatOrigin.xz) - uBeatAge * 520.0) / 34.0;
  float ring = exp(-rx * rx) * exp(-uBeatAge * 1.1);
  // slow scanning bar sweeping the whole floor
  float sx = gWrap(p.x * 0.7 + p.y * 0.7 - uClock * 90.0, 3000.0) / 40.0;
  float sweep = exp(-sx * sx);
  vec3 col = uBaseCol;
  col += G_CYAN * minor * (0.3 + 0.35 * uPulse + 2.5 * ring + 0.6 * sweep);
  col += G_MAGENTA * major * (1.1 + 0.8 * uPulse + 3.0 * ring + 0.8 * sweep);
  col += vec3(0.75, 0.6, 1.0) * sector * (2.2 + 1.5 * ring);
  col += G_CYAN * ring * 0.05;
  gl_FragColor = vec4(col, 1.0);
  #include <fog_fragment>
  // whatever the fog density vs. far plane, the floor's edge melts into the horizon haze
  gl_FragColor.rgb = mix(gl_FragColor.rgb, uHaze, smoothstep(0.45 * uFar, 0.97 * uFar, dist));
}
`;

const PRINT_VERT = /* glsl */ `
attribute vec2 aUv;
varying vec2 vUv;
#include <fog_pars_vertex>
void main() {
  vUv = aUv;
  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}
`;

/** The circuit's footprint drawn in light on the floor (reads the layout from the air). */
const PRINT_FRAG = /* glsl */ `
uniform float uClock;
uniform float uPulse;
uniform float uHalf;
varying vec2 vUv;
#include <fog_pars_fragment>
${GLSL_COMMON}
void main() {
  float dm = vUv.x * uHalf;
  float core = exp(-dm * dm * 4.0);
  float glow = exp(-dm * dm * 0.012);
  float dashes = gBand(vUv.y / 40.0 - uClock * 1.5, 0.45);
  vec3 col = G_MAGENTA * core * (0.5 + 1.3 * dashes) * (1.0 + uPulse) + G_VIOLET * glow * 0.12;
  gl_FragColor = vec4(col, 1.0);
  ${GLSL_FOG_FADE}
}
`;

export interface GridFloor {
  objects: THREE.Object3D[];
  disposables: { dispose(): void }[];
  update(camera: THREE.Camera): void;
}

export function buildGridFloor(track: Track, U: GridUniforms, baseCol: THREE.Color, haze: THREE.Color): GridFloor {
  const disposables: { dispose(): void }[] = [];
  const geo = new THREE.PlaneGeometry(1, 1, 24, 24);
  geo.rotateX(-Math.PI / 2);
  const mat = new THREE.ShaderMaterial({
    vertexShader: FLOOR_VERT,
    fragmentShader: FLOOR_FRAG,
    uniforms: {
      ...fogUniforms(),
      uClock: U.uClock,
      uPulse: U.uPulse,
      uBeatAge: U.uBeatAge,
      uBeatOrigin: U.uBeatOrigin,
      uFar: U.uFar,
      uBaseCol: { value: baseCol },
      uHaze: { value: haze },
    },
    fog: true,
    depthWrite: true,
  });
  disposables.push(geo, mat);
  const floor = new THREE.Mesh(geo, mat);
  floor.name = 'gridFloor';
  floor.scale.set(FLOOR_SIZE, 1, FLOOR_SIZE);
  floor.frustumCulled = false;
  // after the other opaques: early-z then rejects every floor pixel hidden under the deck
  floor.renderOrder = 10;

  // ---- footprint ribbon (chunked), 1 m above the floor, pulled forward in depth
  const printMat = new THREE.ShaderMaterial({
    vertexShader: PRINT_VERT,
    fragmentShader: PRINT_FRAG,
    uniforms: { ...fogUniforms(), uClock: U.uClock, uPulse: U.uPulse, uHalf: { value: 24 } },
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: -4,
    polygonOffsetUnits: -4,
    fog: true,
  });
  disposables.push(printMat);
  const objects: THREE.Object3D[] = [floor];
  const fr = makeFrame();
  const L = track.length;
  const step = 6;
  const rows = Math.ceil(L / step);
  const perChunk = 100;
  const half = 24;
  for (let r0 = 0; r0 < rows; r0 += perChunk) {
    const r1 = Math.min(rows, r0 + perChunk);
    const pos: number[] = [];
    const uv: number[] = [];
    const idx: number[] = [];
    for (let r = r0; r <= r1; r++) {
      const s = Math.min(L, r * step);
      track.sample(s, fr);
      let rx = fr.R.x, rz = fr.R.z;
      const l = Math.hypot(rx, rz) || 1;
      rx /= l;
      rz /= l;
      pos.push(fr.pos.x - rx * half, 1, fr.pos.z - rz * half, fr.pos.x + rx * half, 1, fr.pos.z + rz * half);
      uv.push(-1, s, 1, s);
      if (r > r0) {
        const a = (r - r0 - 1) * 2;
        idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('aUv', new THREE.Float32BufferAttribute(uv, 2));
    g.setIndex(idx);
    g.computeBoundingSphere();
    const m = new THREE.Mesh(g, printMat);
    m.name = 'gridFootprint';
    m.matrixAutoUpdate = false;
    m.renderOrder = -5;
    objects.push(m);
  }

  return {
    objects,
    disposables,
    update(camera) {
      // follow the camera; the pattern is computed in world space so it never slides
      floor.position.set(camera.position.x, 0, camera.position.z);
    },
  };
}
