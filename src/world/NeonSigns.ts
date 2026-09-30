import * as THREE from 'three';
import { canvasTexture } from './textures';

/** 4×4 atlas of glowing sign designs (no real brands). */
export const SIGN_DESIGNS: { text: string; color: string; sub?: string; vertical?: boolean; font?: 'ko' | 'num' }[] = [
  { text: '네온', color: '#ff2bd6', sub: 'NEON', font: 'ko' },
  { text: '질주', color: '#19f5ff', sub: 'RUSH', font: 'ko' },
  { text: '24시', color: '#ffe14d', sub: 'OPEN', font: 'ko' },
  { text: '라멘', color: '#ff6a2a', sub: 'NOODLE BAR', font: 'ko' },
  { text: 'HOTEL', color: '#ff5bbd', vertical: true, font: 'num' },
  { text: 'OVERDRIVE', color: '#19f5ff', font: 'num' },
  { text: '夜', color: '#ff2bd6', sub: 'NIGHT', font: 'ko' },
  { text: 'ARCADE', color: '#7cff4d', font: 'num' },
  { text: 'CYBER', color: '#39a8ff', sub: '사이버', font: 'num' },
  { text: '▶▶▶', color: '#ffe14d', font: 'num' },
  { text: '서울', color: '#cfe8ff', sub: 'SEOUL 2099', font: 'ko' },
  { text: 'PULSE', color: '#b04bff', font: 'num' },
  { text: '∞', color: '#19f5ff', sub: 'NO LIMIT', font: 'num' },
  { text: 'BAR', color: '#ff3b5c', vertical: true, font: 'num' },
  { text: '가속', color: '#ff8a1f', sub: 'BOOST ZONE', font: 'ko' },
  { text: 'NEON CITY', color: '#ff2bd6', sub: '네온 시티', font: 'num' },
];

export function signAtlas(): THREE.CanvasTexture {
  return canvasTexture(
    1024,
    1024,
    (ctx) => {
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, 1024, 1024);
      SIGN_DESIGNS.forEach((d, i) => {
        const cx = (i % 4) * 256, cy = Math.floor(i / 4) * 256;
        ctx.save();
        ctx.translate(cx, cy);
        // frame
        ctx.strokeStyle = d.color;
        ctx.lineWidth = 5;
        ctx.shadowColor = d.color;
        ctx.shadowBlur = 16;
        ctx.strokeRect(14, 14, 228, 228);
        ctx.lineWidth = 2;
        ctx.strokeRect(24, 24, 208, 208);
        // text
        ctx.fillStyle = '#ffffff';
        ctx.shadowBlur = 22;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        const fam = d.font === 'ko' ? '"Malgun Gothic","Apple SD Gothic Neo","Noto Sans KR",sans-serif' : 'Orbitron, "Arial Black", sans-serif';
        if (d.vertical) {
          const chars = d.text.split('');
          const size = Math.min(52, 200 / chars.length);
          ctx.font = `900 ${size}px ${fam}`;
          chars.forEach((c, k) => ctx.fillText(c, 128, 128 + (k - (chars.length - 1) / 2) * size * 1.05));
        } else {
          let size = d.text.length <= 2 ? 118 : d.text.length <= 4 ? 70 : Math.max(26, 300 / d.text.length);
          ctx.font = `900 ${size}px ${fam}`;
          while (ctx.measureText(d.text).width > 210 && size > 16) {
            size -= 2;
            ctx.font = `900 ${size}px ${fam}`;
          }
          ctx.fillText(d.text, 128, d.sub ? 112 : 128);
          // colour pass on top for a hot-core look
          ctx.globalCompositeOperation = 'source-atop';
          ctx.globalCompositeOperation = 'source-over';
          if (d.sub) {
            ctx.shadowBlur = 10;
            ctx.fillStyle = d.color;
            ctx.font = `700 26px ${d.font === 'ko' ? 'Orbitron, sans-serif' : '"Malgun Gothic",sans-serif'}`;
            ctx.fillText(d.sub, 128, 196);
          }
        }
        ctx.restore();
      });
    },
    { repeat: false },
  );
}

const VERT = /* glsl */ `
#include <common>
#include <fog_pars_vertex>
attribute vec2 aTile;
attribute vec3 aTint;
attribute float aPhase;
uniform float uTime;
uniform float uBeat;
varying vec2 vUv;
varying vec3 vTint;
varying float vFlick;
void main() {
  vUv = uv * 0.25 + aTile;
  vTint = aTint;
  float f = 1.0;
  if (aPhase > 0.8) {
    // broken tube: stutters now and then
    float t = uTime * 7.0 + aPhase * 50.0;
    f = step(0.25, fract(sin(floor(t) * 12.9898 + aPhase) * 43758.5453)) * 0.8 + 0.2;
  } else {
    f = 0.85 + 0.15 * sin(uTime * (1.5 + aPhase * 3.0) + aPhase * 20.0);
  }
  vFlick = f * (1.0 + uBeat * 0.35 * step(0.5, aPhase));
  vec4 mvPosition = modelViewMatrix * instanceMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}`;

const FRAG = /* glsl */ `
#include <common>
#include <fog_pars_fragment>
uniform sampler2D uMap;
uniform float uGain;
varying vec2 vUv;
varying vec3 vTint;
varying float vFlick;
void main() {
  vec3 c = texture2D(uMap, vUv).rgb;
  // white core stays white-hot, coloured halo tinted
  vec3 col = c * vTint * uGain * vFlick;
  gl_FragColor = vec4(col, 1.0);
  #include <fog_fragment>
}`;

export function makeSignMaterial(atlas: THREE.Texture, shared: { uTime: THREE.IUniform; uBeat: THREE.IUniform }, gain = 3.2): THREE.ShaderMaterial {
  // textures / shared uniforms are attached AFTER merge (merge would clone them)
  const uniforms = THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { uGain: { value: gain } }]);
  uniforms.uMap = { value: atlas };
  uniforms.uTime = shared.uTime;
  uniforms.uBeat = shared.uBeat;
  return new THREE.ShaderMaterial({
    vertexShader: VERT,
    fragmentShader: FRAG,
    uniforms,
    fog: true,
    side: THREE.DoubleSide,
  });
}

const HOLO_VERT = /* glsl */ `
#include <common>
#include <fog_pars_vertex>
attribute float aKind;
attribute vec3 aCol;
varying vec2 vUv;
varying float vKind;
varying vec3 vCol;
void main() {
  vUv = uv;
  vKind = aKind;
  vCol = aCol;
  vec4 mvPosition = modelViewMatrix * instanceMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}`;

const HOLO_FRAG = /* glsl */ `
#include <common>
#include <fog_pars_fragment>
uniform float uTime;
uniform float uBeat;
varying vec2 vUv;
varying float vKind;
varying vec3 vCol;
float h11(float p) { p = fract(p * 0.1031); p *= p + 33.33; p *= p + p; return fract(p); }
void main() {
  vec2 uv = vUv;
  float v = 0.0;
  int kind = int(vKind + 0.5);
  if (kind == 0) {
    // equalizer bars bouncing to the beat
    float bars = 18.0;
    float id = floor(uv.x * bars);
    float f = fract(uv.x * bars);
    float hgt = 0.15 + 0.75 * h11(id * 7.0 + floor(uTime * 8.0)) * (0.55 + 0.45 * uBeat);
    v = step(0.12, f) * step(f, 0.88) * step(uv.y, hgt);
    v *= 0.6 + 0.4 * step(fract(uv.y * 24.0), 0.75);
  } else if (kind == 1) {
    // scrolling sine waves
    float w = sin(uv.x * 18.0 + uTime * 3.0) * 0.18 + 0.5;
    float w2 = sin(uv.x * 11.0 - uTime * 2.2 + 1.3) * 0.22 + 0.5;
    v = smoothstep(0.035, 0.0, abs(uv.y - w)) + 0.7 * smoothstep(0.03, 0.0, abs(uv.y - w2));
  } else if (kind == 2) {
    // concentric pulse rings
    float r = length(uv - 0.5) * 2.0;
    v = smoothstep(0.12, 0.0, abs(fract(r * 3.0 - uTime * 0.8) - 0.5) - 0.05) * (1.0 - r);
    v += uBeat * smoothstep(0.35, 0.0, r);
  } else {
    // scrolling chevrons
    float c = fract(uv.x * 4.0 - abs(uv.y - 0.5) * 2.0 - uTime * 1.5);
    v = step(0.5, c) * 0.8;
  }
  // frame + scanlines + occasional glitch
  float edge = step(min(min(uv.x, 1.0 - uv.x), min(uv.y, 1.0 - uv.y)), 0.02);
  float scan = 0.75 + 0.25 * sin(uv.y * 220.0);
  float glitch = step(0.985, h11(floor(uTime * 12.0) + vKind * 13.0));
  vec3 col = vCol * (v * scan + edge * 0.9) * (1.0 - glitch * 0.7) * (2.4 + uBeat * 0.8);
  gl_FragColor = vec4(col + vCol * 0.05, 1.0);
  #include <fog_fragment>
}`;

/** Animated holographic billboard material (instanced; per-instance kind + colour). */
export function makeHoloMaterial(shared: { uTime: THREE.IUniform; uBeat: THREE.IUniform }): THREE.ShaderMaterial {
  const uniforms = THREE.UniformsUtils.merge([THREE.UniformsLib.fog]);
  uniforms.uTime = shared.uTime;
  uniforms.uBeat = shared.uBeat;
  return new THREE.ShaderMaterial({
    vertexShader: HOLO_VERT,
    fragmentShader: HOLO_FRAG,
    uniforms,
    fog: true,
    side: THREE.DoubleSide,
  });
}

/** Attach per-instance sign data (tile index, tint, flicker phase) to a geometry. */
export function signInstanceAttrs(
  geo: THREE.InstancedBufferGeometry | THREE.BufferGeometry,
  tiles: number[],
  tints: THREE.Color[],
  phases: number[],
): void {
  const n = tiles.length;
  const t = new Float32Array(n * 2);
  const c = new Float32Array(n * 3);
  const p = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const k = tiles[i] % 16;
    t[i * 2] = (k % 4) * 0.25;
    t[i * 2 + 1] = 0.75 - Math.floor(k / 4) * 0.25;
    c[i * 3] = tints[i].r;
    c[i * 3 + 1] = tints[i].g;
    c[i * 3 + 2] = tints[i].b;
    p[i] = phases[i];
  }
  geo.setAttribute('aTile', new THREE.InstancedBufferAttribute(t, 2));
  geo.setAttribute('aTint', new THREE.InstancedBufferAttribute(c, 3));
  geo.setAttribute('aPhase', new THREE.InstancedBufferAttribute(p, 1));
}
