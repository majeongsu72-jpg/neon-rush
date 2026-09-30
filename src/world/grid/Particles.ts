import * as THREE from 'three';
import type { Rng } from '../../core/rng';
import { GLSL_COMMON, GLSL_FOG_FADE, fogUniforms, type GridUniforms } from './common';

const VERT = /* glsl */ `
attribute float aSeed;
uniform vec3 uCamPos;
uniform float uBox;
uniform float uPxScale;
uniform float uClock;
uniform float uPulse;
varying float vAlpha;
varying float vSeed;
#include <fog_pars_vertex>
void main() {
  vec3 drift = vec3(sin(uClock * 0.2 + aSeed * 40.0), 0.6 * cos(uClock * 0.15 + aSeed * 23.0), sin(uClock * 0.1 + aSeed * 11.0)) * 6.0;
  // wrap into a box that travels with the camera: an endless field for a fixed budget
  vec3 rel = mod(position + drift - uCamPos + 0.5 * uBox, uBox) - 0.5 * uBox;
  vec4 mvPosition = viewMatrix * vec4(uCamPos + rel, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  float size = mix(0.15, 0.48, fract(aSeed * 17.0)) * (1.0 + 0.6 * uPulse);
  gl_PointSize = clamp(size * uPxScale / max(-mvPosition.z, 0.1), 1.0, 28.0);
  float edge = length(rel) / (0.5 * uBox);
  vAlpha = (1.0 - smoothstep(0.65, 1.0, edge)) * (0.6 + 0.4 * sin(uClock * (1.0 + 3.0 * fract(aSeed * 7.0)) + aSeed * 50.0));
  vSeed = aSeed;
  #include <fog_vertex>
}
`;

const FRAG = /* glsl */ `
varying float vAlpha;
varying float vSeed;
#include <fog_pars_fragment>
${GLSL_COMMON}
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float a = exp(-dot(c, c) * 20.0) * vAlpha;
  float pick = fract(vSeed * 3.7);
  vec3 tint = pick < 0.45 ? G_CYAN : (pick < 0.8 ? G_MAGENTA : vec3(0.8, 0.85, 1.0));
  gl_FragColor = vec4(tint * a * 2.4, 1.0);
  ${GLSL_FOG_FADE}
}
`;

export interface Particles {
  points: THREE.Points;
  disposables: { dispose(): void }[];
  update(camera: THREE.Camera, drawingBufferHeight: number): void;
}

/** Drifting data motes around the camera: close-passing specks that sell the speed. */
export function buildParticles(U: GridUniforms, rng: Rng, budget: number): Particles {
  const count = Math.max(200, Math.round(1400 * budget));
  const box = 260;
  const pos = new Float32Array(count * 3);
  const seed = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    pos[i * 3] = rng.range(0, box);
    pos[i * 3 + 1] = rng.range(0, box);
    pos[i * 3 + 2] = rng.range(0, box);
    seed[i] = rng.next();
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));
  const uCamPos = { value: new THREE.Vector3() };
  const uPxScale = { value: 600 };
  const mat = new THREE.ShaderMaterial({
    vertexShader: VERT,
    fragmentShader: FRAG,
    uniforms: { ...fogUniforms(), uCamPos, uBox: { value: box }, uPxScale, uClock: U.uClock, uPulse: U.uPulse },
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    fog: true,
  });
  const points = new THREE.Points(geo, mat);
  points.name = 'gridMotes';
  points.frustumCulled = false;
  points.renderOrder = 4;
  return {
    points,
    disposables: [geo, mat],
    update(camera, drawingBufferHeight) {
      uCamPos.value.copy(camera.position);
      const fov = (camera as THREE.PerspectiveCamera).fov ?? 60;
      uPxScale.value = drawingBufferHeight / (2 * Math.tan(THREE.MathUtils.degToRad(fov) / 2));
    },
  };
}
