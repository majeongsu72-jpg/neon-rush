import * as THREE from 'three';
import type { Track } from '../../track/Track';
import type { GroundSample, Island } from './Island';
import { sweep, mirrorProfile, type ProfilePoint } from '../../track/TrackMesh';
import { smoothstep } from '../../core/math';

// ---------------------------------------------------------------------------
// Tunnel lighting for swept road meshes.
//
// Road rows carry aRoad = (s, d, h, zone). zone = 0 in daylight and 1 + r in
// the tunnel, where r ramps 0 → 1 over the first metres behind each portal:
// the lamp rows switch on at the portal while sun, sky and IBL fade out as the
// daylight dies inside the mouth.

export interface TunnelLampParams {
  spacing: number;
  phase: number;
  height: number;
  /** Lateral position of the two lamp rows (±). */
  d: number;
  range: number;
  intensity: number;
  color: THREE.Color;
}

export function makeTunnelLampUniforms(p: TunnelLampParams): Record<string, THREE.IUniform> {
  return {
    uTunSpacing: { value: p.spacing },
    uTunPhase: { value: p.phase },
    uTunHeight: { value: p.height },
    uTunD: { value: p.d },
    uTunRange: { value: p.range },
    uTunIntensity: { value: p.intensity },
    uTunColor: { value: p.color },
  };
}

const ROAD_VERT_PARS = /* glsl */ `
attribute vec4 aRoad;
attribute vec3 aTan;
attribute vec3 aUpR;
varying vec4 vRoad;
varying vec3 vTanV;
varying vec3 vUpV;
`;
const ROAD_VERT_MAIN = /* glsl */ `
vRoad = aRoad;
vTanV = normalize( ( modelViewMatrix * vec4( aTan, 0.0 ) ).xyz );
vUpV = normalize( ( modelViewMatrix * vec4( aUpR, 0.0 ) ).xyz );
`;
const ROAD_FRAG_PARS = /* glsl */ `
varying vec4 vRoad;
varying vec3 vTanV;
varying vec3 vUpV;
uniform float uTunSpacing;
uniform float uTunPhase;
uniform float uTunHeight;
uniform float uTunD;
uniform float uTunRange;
uniform float uTunIntensity;
uniform vec3 uTunColor;
`;
/** Shared occlusion: `dark` 0..1 removes sun, sky and IBL. */
const OCCLUDE = /* glsl */ `
  float occ = 1.0 - 0.94 * dark;
  irradiance *= occ;
  #if defined( RE_IndirectSpecular )
    radiance *= occ;
    iblIrradiance *= occ;
  #endif
  reflectedLight.directDiffuse *= 1.0 - dark;
  reflectedLight.directSpecular *= 1.0 - dark;
`;
const ROAD_FRAG_LIGHT = /* glsl */ `
{
  float zr = vRoad.w;
  float dark = clamp( zr - 1.0, 0.0, 1.0 );
  ${OCCLUDE}
  if ( zr > 0.5 ) {
    float rs = vRoad.x;
    float rd = vRoad.y;
    float rh = vRoad.z;
    vec3 Tv = normalize( vTanV );
    vec3 Nv = normalize( vUpV );
    vec3 Rv = normalize( cross( Tv, Nv ) );
    vec3 lcol = uTunColor * uTunIntensity;
    float k0 = floor( ( rs - uTunPhase ) / uTunSpacing );
    for ( int i = 0; i < 2; i ++ ) {
      float ls = ( k0 + float( i ) ) * uTunSpacing + uTunPhase;
      for ( int side = 0; side < 2; side ++ ) {
        float ld = side == 0 ? - uTunD : uTunD;
        vec3 L = Tv * ( ls - rs ) + Rv * ( ld - rd ) + Nv * ( uTunHeight - rh );
        float dist = length( L );
        IncidentLight lamp;
        lamp.direction = L / dist;
        lamp.color = lcol * getDistanceAttenuation( dist, uTunRange, 2.0 );
        lamp.visible = true;
        RE_Direct( lamp, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );
      }
    }
  }
}
`;

/** Tunnel lamps + daylight occlusion for swept meshes that carry aRoad. */
export function patchCoastRoad(mat: THREE.MeshStandardMaterial, uniforms: Record<string, THREE.IUniform>): void {
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${ROAD_VERT_PARS}`)
      .replace('#include <project_vertex>', `#include <project_vertex>\n${ROAD_VERT_MAIN}`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${ROAD_FRAG_PARS}`)
      .replace('#include <lights_fragment_end>', `${ROAD_FRAG_LIGHT}\n#include <lights_fragment_end>`);
  };
  mat.customProgramCacheKey = () => 'coastRoad';
}

/**
 * Same daylight occlusion for meshes without road attributes (lane markings,
 * kerbs of other builders), looked up from a world-space mask of the tunnel,
 * plus a little lamp glow so paint still reads under the sodium lights.
 */
export function patchTunnelMask(mat: THREE.MeshStandardMaterial, mask: TunnelMask, glow: THREE.Color): void {
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTunMask = { value: mask.texture };
    shader.uniforms.uTunMaskRect = { value: mask.rect };
    shader.uniforms.uTunGlow = { value: glow };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vMaskXZ;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvMaskXZ = position.xz;');
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        '#include <common>\nvarying vec2 vMaskXZ;\nuniform sampler2D uTunMask;\nuniform vec4 uTunMaskRect;\nuniform vec3 uTunGlow;',
      )
      .replace(
        '#include <lights_fragment_end>',
        `{
  vec2 muv = ( vMaskXZ - uTunMaskRect.xy ) * uTunMaskRect.zw;
  float inM = step( 0.0, muv.x ) * step( muv.x, 1.0 ) * step( 0.0, muv.y ) * step( muv.y, 1.0 );
  float dark = texture2D( uTunMask, clamp( muv, vec2( 0.0 ), vec2( 1.0 ) ) ).r * inM;
  ${OCCLUDE}
  totalEmissiveRadiance += diffuseColor.rgb * uTunGlow * dark;
}
#include <lights_fragment_end>`,
      );
  };
  mat.customProgramCacheKey = () => 'coastTunnelMask';
}

export interface TunnelMask {
  texture: THREE.DataTexture;
  rect: THREE.Vector4;
}

/** Darkness inside the tunnel corridor, baked on a 2 m grid over the tunnel's bounds. */
export function makeTunnelMask(isl: Island, zoneOf: (s: number) => number): TunnelMask {
  const tr = isl.track;
  const tun = tr.sectionsOf('tunnel')[0];
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  if (tun) {
    const len = tr.wrap(tun.s1 - tun.s0);
    for (let a = 0; a <= len; a += 4) {
      const s = tun.s0 + a;
      minX = Math.min(minX, tr.lerp(tr.px, s));
      maxX = Math.max(maxX, tr.lerp(tr.px, s));
      minZ = Math.min(minZ, tr.lerp(tr.pz, s));
      maxZ = Math.max(maxZ, tr.lerp(tr.pz, s));
    }
  } else {
    minX = minZ = 0;
    maxX = maxZ = 1;
  }
  const pad = 24, cell = 2;
  minX -= pad; minZ -= pad; maxX += pad; maxZ += pad;
  const w = Math.max(2, Math.ceil((maxX - minX) / cell));
  const h = Math.max(2, Math.ceil((maxZ - minZ) / cell));
  const data = new Uint8Array(w * h * 4);
  const smp: GroundSample = { h: 0, natural: 0, s: 0, d: 0, dist: 0, road: 0, rock: 0, lagoon: 0 };
  if (tun) {
    for (let j = 0; j < h; j++) {
      for (let i = 0; i < w; i++) {
        const x = minX + (i + 0.5) * cell, z = minZ + (j + 0.5) * cell;
        isl.sample(x, z, smp);
        const hw = tr.halfWidthAt(smp.s);
        const z1 = zoneOf(smp.s);
        const v = Math.abs(smp.d) < hw + 3 ? Math.max(0, Math.min(1, z1 - 1)) : 0;
        data[(j * w + i) * 4] = Math.round(v * 255);
        data[(j * w + i) * 4 + 3] = 255;
      }
    }
  }
  const texture = new THREE.DataTexture(data, w, h, THREE.RGBAFormat, THREE.UnsignedByteType);
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;
  texture.colorSpace = THREE.NoColorSpace;
  texture.needsUpdate = true;
  return { texture, rect: new THREE.Vector4(minX, minZ, 1 / (w * cell), 1 / (h * cell)) };
}

/** zone(s) for road rows: 0 outside, 1..2 inside the tunnel (ramping in over `ramp` m). */
export function tunnelZoneFn(track: Track, ramp = 26): (s: number) => number {
  const tunnels = track.sectionsOf('tunnel');
  return (s: number) => {
    for (const t of tunnels) {
      if (!track.inRange(s, t.s0 - 0.5, t.s1 + 0.5)) continue;
      const a = Math.min(track.wrap(s - t.s0 + 0.5), track.wrap(t.s1 + 0.5 - s));
      return 1 + smoothstep(0, ramp, a);
    }
    return 0;
  };
}

// ---------------------------------------------------------------------------
// Guardrails

/** Galvanised W-beam guardrail profile (right side, from the road edge outward). */
export const W_BEAM: [number, number][] = [
  [0.2, 0.43],
  [0.07, 0.52],
  [0.15, 0.61],
  [0.07, 0.7],
  [0.2, 0.79],
  [0.21, 0.43],
];

/** Both guardrails in one geometry per chunk (skipping `skip` ranges such as tunnels). */
export function buildGuardrails(
  track: Track,
  skip: { s0: number; s1: number }[],
  zone: (s: number) => number,
  chunk = 480,
): THREE.BufferGeometry[] {
  const right: ProfilePoint[] = W_BEAM.map(([d, h]) => ({ e: 1 as const, d, h }));
  const left = mirrorProfile(right);
  // runs of track not covered by skip ranges
  const runs: { s0: number; len: number }[] = [];
  const L = track.length;
  const inSkip = (s: number) => skip.some((k) => track.inRange(s, k.s0, k.s1));
  let start = -1;
  const step = 2;
  for (let k = 0; ; k++) {
    const s = Math.min(k * step, L);
    const on = s < L && !inSkip(s);
    if (on && start < 0) start = s;
    if (!on && start >= 0) {
      runs.push({ s0: start, len: s - start });
      start = -1;
    }
    if (s >= L) break;
  }
  const out: THREE.BufferGeometry[] = [];
  for (const r of runs) {
    const opts = { s0: r.s0, len: r.len, step: 2.5, chunk, uScale: 1, vScale: 0.25, roadAttrs: zone };
    const a = sweep(track, { ...opts, profile: right });
    const b = sweep(track, { ...opts, profile: left });
    for (let i = 0; i < a.length; i++) {
      const merged = mergeTwo(a[i], b[i]);
      a[i].dispose();
      b[i].dispose();
      out.push(merged);
    }
  }
  return out;
}

/** Concatenate two indexed geometries with identical attribute layouts. */
export function mergeTwo(a: THREE.BufferGeometry, b: THREE.BufferGeometry): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  const na = a.attributes.position.count;
  for (const name of Object.keys(a.attributes)) {
    const A = a.attributes[name] as THREE.BufferAttribute;
    const B = b.attributes[name] as THREE.BufferAttribute;
    if (!B) continue;
    const arr = new Float32Array(A.array.length + B.array.length);
    arr.set(A.array as Float32Array, 0);
    arr.set(B.array as Float32Array, A.array.length);
    g.setAttribute(name, new THREE.BufferAttribute(arr, A.itemSize));
  }
  const ia = a.index ? Array.from(a.index.array) : [];
  const ib = b.index ? Array.from(b.index.array, (v) => v + na) : [];
  g.setIndex(ia.concat(ib));
  g.computeBoundingSphere();
  return g;
}
