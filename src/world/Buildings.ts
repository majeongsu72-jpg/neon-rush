import * as THREE from 'three';

/**
 * Night-city facade material: procedural lit windows, floor bands and a neon
 * crown, computed from object-space position × instance scale (so one
 * InstancedMesh of unit boxes becomes hundreds of distinct towers).
 * Windows fade to their average brightness where they get smaller than a
 * pixel, which kills distant moiré.
 */
export interface FacadeParams {
  base: THREE.Color;
  warm: THREE.Color;
  cool: THREE.Color;
  accentA: THREE.Color;
  accentB: THREE.Color;
  litRatio: number;
  brightness: number;
  floorH: number;
  winW: number;
}

export function makeFacadeMaterial(p: FacadeParams, uniforms: { uTime: THREE.IUniform; uBeat: THREE.IUniform }): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({
    color: p.base,
    roughness: 0.62,
    metalness: 0.35,
    envMapIntensity: 0.6,
  });
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uWarm = { value: p.warm };
    shader.uniforms.uCool = { value: p.cool };
    shader.uniforms.uAccentA = { value: p.accentA };
    shader.uniforms.uAccentB = { value: p.accentB };
    shader.uniforms.uLit = { value: p.litRatio };
    shader.uniforms.uBright = { value: p.brightness };
    shader.uniforms.uFloorH = { value: p.floorH };
    shader.uniforms.uWinW = { value: p.winW };
    shader.uniforms.uTime = uniforms.uTime;
    shader.uniforms.uBeat = uniforms.uBeat;
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
varying vec3 vBPos;
varying vec3 vBNrm;
varying vec3 vBSize;
varying float vSeed;`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
#ifdef USE_INSTANCING
  vec3 bsc = vec3(length(instanceMatrix[0].xyz), length(instanceMatrix[1].xyz), length(instanceMatrix[2].xyz));
  vSeed = fract(sin(dot(instanceMatrix[3].xyz, vec3(12.9898, 78.233, 37.719))) * 43758.5453);
#else
  vec3 bsc = vec3(1.0);
  vSeed = 0.37;
#endif
  vBSize = bsc;
  vBPos = (position + vec3(0.5, 0.0, 0.5)) * bsc;
  vBNrm = normal;`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
varying vec3 vBPos;
varying vec3 vBNrm;
varying vec3 vBSize;
varying float vSeed;
uniform vec3 uWarm;
uniform vec3 uCool;
uniform vec3 uAccentA;
uniform vec3 uAccentB;
uniform float uLit;
uniform float uBright;
uniform float uFloorH;
uniform float uWinW;
uniform float uTime;
uniform float uBeat;
float bh(vec3 p3) {
  p3 = fract(p3 * 0.1031);
  p3 += dot(p3, p3.zyx + 31.32);
  return fract((p3.x + p3.y) * p3.z);
}`,
      )
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
{
  vec3 an = abs(vBNrm);
  float isSide = step(an.y, 0.5);
  float faceId = an.x > 0.5 ? (vBNrm.x > 0.0 ? 1.0 : 2.0) : (vBNrm.z > 0.0 ? 3.0 : 4.0);
  vec2 fc = an.x > 0.5 ? vec2(vBPos.z, vBPos.y) : vec2(vBPos.x, vBPos.y);
  // per-tower window module and style (grid windows vs. continuous ribbons)
  vec2 cellSize = vec2(uWinW, uFloorH) * vec2(0.7 + 0.7 * fract(vSeed * 7.13), 0.85 + 0.3 * fract(vSeed * 3.71));
  vec2 g = fc / cellSize;
  vec2 cell = floor(g);
  vec2 f = fract(g);
  float win = smoothstep(0.1, 0.16, f.x) * smoothstep(0.9, 0.84, f.x) * smoothstep(0.22, 0.3, f.y) * smoothstep(0.86, 0.78, f.y);
  float ribbon = step(0.68, fract(vSeed * 13.7));
  win = mix(win, smoothstep(0.28, 0.34, f.y) * smoothstep(0.8, 0.74, f.y), ribbon);
  cell.x = mix(cell.x, floor(cell.x / 4.0), ribbon);
  float rowOn = step(0.18, bh(vec3(cell.y, vSeed * 91.0, faceId)));
  float h1 = bh(vec3(cell, vSeed * 173.0 + faceId));
  float lit = step(1.0 - uLit, h1) * rowOn;
  float h2 = bh(vec3(cell.yx, vSeed * 57.0));
  vec3 wc = mix(uWarm, uCool, step(0.62, h2)) * (0.55 + 0.9 * bh(vec3(cell * 1.7, vSeed)));
  // anti-moire: blend to the average when windows shrink below a pixel
  vec2 fw = fwidth(g);
  float far = smoothstep(0.35, 0.9, max(fw.x, fw.y));
  float avg = uLit * 0.82 * 0.45;
  float amount = mix(win * lit, avg, far);
  vec3 winCol = mix(wc, (uWarm + uCool) * 0.5, far);
  // ground floor shop glow
  float shop = smoothstep(4.5, 1.0, vBPos.y) * step(0.5, fract(vSeed * 7.3)) ;
  // neon crown at the roof line
  float crown = smoothstep(1.4, 0.2, abs(vBPos.y - (vBSize.y - 2.0))) * step(0.45, vSeed);
  vec3 crownCol = mix(uAccentA, uAccentB, step(0.72, vSeed)) * (0.8 + 0.4 * sin(uTime * 2.0 + vSeed * 30.0) + uBeat * 0.6);
  // vertical neon strips on some towers
  float strip = step(0.8, vSeed) * smoothstep(0.35, 0.0, abs(fract(fc.x / max(vBSize.x, 1.0)) - 0.5) * vBSize.x - 0.0) * 0.0;
  totalEmissiveRadiance += isSide * (winCol * amount * uBright + uWarm * shop * 1.4 + crownCol * crown * 3.0 + strip);
  diffuseColor.rgb *= mix(1.0, 0.45, win * isSide * (1.0 - far));
}`,
      );
  };
  mat.customProgramCacheKey = () => 'facade';
  return mat;
}

/** Unit box with its base at y=0, footprint centred on origin. */
export function unitBoxGeometry(): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(1, 1, 1);
  g.translate(0, 0.5, 0);
  return g;
}
