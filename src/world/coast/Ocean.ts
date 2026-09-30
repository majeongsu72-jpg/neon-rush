import * as THREE from 'three';
import { ATMOS_GLSL, type AtmosphereUniforms } from './Atmosphere';
import type { GroundSample, Island } from './Island';
import { Rng } from '../../core/rng';
import { smoothstep } from '../../core/math';

/**
 * The sea: one camera-following plane at y = 0 with an analytic shader.
 *
 * Waves come from three scrolling octaves of a tileable slope map that stores
 * the mean slope (RG) AND the mean squared slope (BA). Mipmapping averages
 * both, so E[s²] − E[s]² is the sub-pixel slope variance: it widens the sun's
 * specular lobe with distance. Up close the sun breaks into hard sparkles; far
 * away they merge into the smooth glittering path that runs to the horizon
 * under the huge striped sun (whose disc is also reflected through `atmSky`).
 * The island's heightfield, baked into a small texture, drives turquoise
 * shallows, calmer water in the lagoon and foam lapping at the shore.
 */
export interface OceanParams {
  deep: THREE.Color;
  shallow: THREE.Color;
  foam: THREE.Color;
  /** Radiance of the sun for the glitter path (linear HDR). */
  glint: THREE.Color;
  /** Overall wave steepness (world slope units). */
  slope: number;
}

const VERT = /* glsl */ `
#include <fog_pars_vertex>
varying vec3 vWorld;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorld = wp.xyz;
  vec4 mvPosition = viewMatrix * wp;
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}`;

const FRAG = /* glsl */ `
#include <fog_pars_fragment>
${ATMOS_GLSL}
uniform float uTime;
uniform sampler2D uWaveTex;
uniform sampler2D uDepthTex;
uniform vec4 uDepthRect;
uniform vec3 uDeep;
uniform vec3 uShallow;
uniform vec3 uFoamCol;
uniform vec3 uGlint;
uniform float uSlope;
varying vec3 vWorld;

vec2 waveSlope(vec4 t) { return t.xy * 2.0 - 1.0; }
float waveVar(vec4 t) {
  vec2 m = t.xy * 2.0 - 1.0;
  return max(t.z + t.w - dot(m, m), 0.0);
}

void main() {
  vec3 toCam = cameraPosition - vWorld;
  float dist = length(toCam);
  vec3 V = toCam / dist;
  vec2 p = vWorld.xz;
  float t = uTime;

  // ---- island data: seabed height, rocky shore, sheltered lagoon
  vec2 duv = (p - uDepthRect.xy) * uDepthRect.zw;
  float inside = step(0.0, duv.x) * step(duv.x, 1.0) * step(0.0, duv.y) * step(duv.y, 1.0);
  vec4 dd = texture2D(uDepthTex, clamp(duv, vec2(0.0), vec2(1.0)));
  float e = dd.r * 2.0 - 1.0;
  float ground = mix(-30.0, sign(e) * e * e * 30.0, inside);
  float depth = max(-ground, 0.0);
  float rocky = dd.g * inside;
  float shelter = dd.b * inside;

  // ---- waves (three octaves drifting with the wind, calmer in the shallows)
  vec4 w1 = texture2D(uWaveTex, p * 0.0165 + vec2(0.0121, 0.0047) * t);
  vec4 w2 = texture2D(uWaveTex, p * 0.0431 + vec2(-0.0172, 0.0213) * t);
  vec4 w3 = texture2D(uWaveTex, p * 0.1373 + vec2(0.0411, -0.0287) * t);
  float calm = mix(1.0, 0.4, shelter) * mix(0.3, 1.0, smoothstep(0.2, 5.0, depth));
  float amp = uSlope * calm;
  vec2 slope = (waveSlope(w1) * 0.55 + waveSlope(w2) * 0.35 + waveSlope(w3) * 0.25) * amp;
  float variance = (waveVar(w1) * 0.3 + waveVar(w2) * 0.12 + waveVar(w3) * 0.06) * amp * amp;
  vec3 N = normalize(vec3(-slope.x, 1.0, -slope.y));

  // ---- reflection of the sunset sky (including the striped sun)
  vec3 R = reflect(-V, N);
  R.y = abs(R.y) + 0.002;
  vec3 refl = atmSky(normalize(R), 0.0);
  float NdV = clamp(dot(N, V), 0.0, 1.0);
  float F = 0.02 + 0.98 * pow(1.0 - NdV, 5.0);

  // ---- water body: violet-teal depths, turquoise over sand
  float shallowW = (1.0 - smoothstep(0.25, 7.5, depth)) * inside;
  vec3 body = mix(uDeep, uShallow, shallowW);
  // sunlight scattered through the backs of waves on the sun side
  float back = pow(clamp(dot(-V, uAtmSunDir) * 0.5 + 0.5, 0.0, 1.0), 5.0);
  body += uShallow * 0.35 * back * clamp(0.5 + 3.0 * dot(slope, normalize(uAtmSunDir.xz)), 0.0, 1.0);
  vec3 col = mix(body, refl, F);

  // ---- sun glitter: normalized Blinn-Phong, lobe widened by the slope variance
  vec3 H = normalize(V + uAtmSunDir);
  float NdH = max(dot(N, H), 0.0);
  float m2 = 0.0014 + variance + dist * 0.0000035;
  float n = 2.0 / m2 - 2.0;
  float spec = pow(NdH, n) * (n + 2.0) * 0.0397887;
  float Fh = 0.02 + 0.98 * pow(max(1.0 - dot(H, V), 0.0), 5.0);
  col += uGlint * spec * Fh;

  // ---- shore foam: lapping edge + swash bands rolling in, busier on rocks
  float zone = (1.0 - smoothstep(0.0, 1.7, depth)) * inside;
  float phase = depth * 3.1 - t * 0.5 + w1.x * 1.6;
  float bands = smoothstep(0.72, 0.95, fract(phase)) * (1.0 - smoothstep(0.15, 1.7, depth));
  float edge = 1.0 - smoothstep(0.02, 0.22 + 0.25 * w2.y, depth);
  float foam = clamp(max(edge, bands * 0.65) * (0.6 + 0.9 * rocky) * (0.45 + 0.55 * w3.z * 3.0), 0.0, 1.0) * zone;
  col = mix(col, uFoamCol, foam);

  gl_FragColor = vec4(col, 1.0);
#ifdef USE_FOG
  #ifdef FOG_EXP2
    float fogFactor = 1.0 - exp( - fogDensity * fogDensity * vFogDepth * vFogDepth );
  #else
    float fogFactor = smoothstep( fogNear, fogFar, vFogDepth );
  #endif
  gl_FragColor.rgb = mix( gl_FragColor.rgb, atmHaze( -V ), fogFactor );
#endif
}`;

export class Ocean {
  readonly mesh: THREE.Mesh;
  readonly material: THREE.ShaderMaterial;
  private readonly waveTex: THREE.DataTexture;
  private readonly depthTex: THREE.DataTexture;
  private readonly geo: THREE.CircleGeometry;

  constructor(isl: Island, atm: AtmosphereUniforms, p: OceanParams, radius = 4200, depthCell = 8) {
    this.waveTex = makeWaveTexture(256, 17);
    const { tex, rect } = makeDepthTexture(isl, depthCell);
    this.depthTex = tex;
    this.material = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: {
        ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog),
        ...atm,
        uTime: { value: 0 },
        uWaveTex: { value: this.waveTex },
        uDepthTex: { value: this.depthTex },
        uDepthRect: { value: rect },
        uDeep: { value: p.deep },
        uShallow: { value: p.shallow },
        uFoamCol: { value: p.foam },
        uGlint: { value: p.glint },
        uSlope: { value: p.slope },
      },
      fog: true,
    });
    this.geo = new THREE.CircleGeometry(radius, 48);
    this.geo.rotateX(-Math.PI / 2);
    this.mesh = new THREE.Mesh(this.geo, this.material);
    this.mesh.name = 'ocean';
    this.mesh.frustumCulled = false;
    this.mesh.receiveShadow = false;
  }

  update(camera: THREE.Camera, time: number): void {
    // Follow the camera in coarse steps (the shader works in world space).
    this.mesh.position.set(Math.round(camera.position.x / 64) * 64, 0, Math.round(camera.position.z / 64) * 64);
    this.material.uniforms.uTime.value = time;
  }

  dispose(): void {
    this.geo.dispose();
    this.material.dispose();
    this.waveTex.dispose();
    this.depthTex.dispose();
  }
}

/**
 * Tileable wave slope map: a sum of sinusoids with integer wave vectors
 * (periodic on the unit square), wind-aligned with a directional spread and a
 * k⁻² height spectrum. RG = slope (mapped to 0..1), BA = slope² for the
 * mip-filtered variance.
 */
function makeWaveTexture(size: number, seed: number): THREE.DataTexture {
  const rng = new Rng(seed);
  const wind = 0.35; // radians: waves travel roughly toward +x (from the open sea)
  const waves: { kx: number; kz: number; a: number; ph: number }[] = [];
  while (waves.length < 34) {
    const k = 2 + Math.pow(rng.next(), 1.7) * 26;
    const ang = wind + (rng.next() - 0.5) * 2.1;
    const kx = Math.round(Math.cos(ang) * k), kz = Math.round(Math.sin(ang) * k);
    if (kx === 0 && kz === 0) continue;
    const kl = Math.sqrt(kx * kx + kz * kz);
    waves.push({ kx, kz, a: 1 / (kl * kl), ph: rng.next() * Math.PI * 2 });
  }
  const n = size * size;
  const sx = new Float32Array(n), sz = new Float32Array(n);
  const TAU = Math.PI * 2;
  let maxS = 1e-6;
  for (const w of waves) {
    const gx = w.a * TAU * w.kx, gz = w.a * TAU * w.kz;
    for (let j = 0; j < size; j++) {
      const v = j / size;
      for (let i = 0; i < size; i++) {
        const c = Math.cos(TAU * (w.kx * (i / size) + w.kz * v) + w.ph);
        const o = j * size + i;
        sx[o] += gx * c;
        sz[o] += gz * c;
      }
    }
  }
  for (let o = 0; o < n; o++) maxS = Math.max(maxS, Math.abs(sx[o]), Math.abs(sz[o]));
  const data = new Uint8Array(n * 4);
  for (let o = 0; o < n; o++) {
    const a = sx[o] / maxS, b = sz[o] / maxS;
    data[o * 4] = Math.round((0.5 + 0.5 * a) * 255);
    data[o * 4 + 1] = Math.round((0.5 + 0.5 * b) * 255);
    data[o * 4 + 2] = Math.round(a * a * 255);
    data[o * 4 + 3] = Math.round(b * b * 255);
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = 8;
  tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;
  return tex;
}

/**
 * Island heightfield for the sea shader: R = seabed height (sign · sqrt
 * encoding for precision near the waterline), G = rocky shore, B = sheltered
 * lagoon water.
 */
function makeDepthTexture(isl: Island, cell: number): { tex: THREE.DataTexture; rect: THREE.Vector4 } {
  const w = Math.ceil((isl.x1 - isl.x0) / cell);
  const h = Math.ceil((isl.z1 - isl.z0) / cell);
  const data = new Uint8Array(w * h * 4);
  const smp: GroundSample = { h: 0, natural: 0, s: 0, d: 0, dist: 0, road: 0, rock: 0, lagoon: 0 };
  for (let j = 0; j < h; j++) {
    const z = isl.z0 + (j + 0.5) * cell;
    for (let i = 0; i < w; i++) {
      const x = isl.x0 + (i + 0.5) * cell;
      isl.sample(x, z, smp);
      const hv = Math.max(-30, Math.min(30, smp.h));
      const enc = Math.sign(hv) * Math.sqrt(Math.abs(hv) / 30);
      const o = (j * w + i) * 4;
      data[o] = Math.round((0.5 + 0.5 * enc) * 255);
      data[o + 1] = Math.round(Math.min(1, smp.rock) * 255);
      data[o + 2] = Math.round(smoothstep(20, -40, smp.lagoon) * 255);
      data[o + 3] = 255;
    }
  }
  const tex = new THREE.DataTexture(data, w, h, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;
  const rect = new THREE.Vector4(isl.x0, isl.z0, 1 / (w * cell), 1 / (h * cell));
  return { tex, rect };
}
