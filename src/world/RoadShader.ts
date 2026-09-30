import * as THREE from 'three';

/**
 * Analytic street/tunnel lamps for the road surface.
 *
 * Instead of real three.js lights (each one costs every lit shader, and
 * changing the count recompiles programs), the road shader reconstructs the
 * two nearest lamp rows from its road-space coordinates (s, d) and shades them
 * with the physical BRDF. On wet, low-roughness asphalt this produces the long
 * glossy streaks of a rainy night street for the price of four point lights.
 */
export interface LampParams {
  spacing: number;
  phase: number;
  height: number;
  inset: number; // lateral offset beyond the road edge
  range: number;
  intensity: number;
  color: THREE.Color;
  tunnelSpacing: number;
  tunnelHeight: number;
  tunnelD: number;
  tunnelColor: THREE.Color;
  tunnelIntensity: number;
}

export function makeLampUniforms(p: LampParams): Record<string, THREE.IUniform> {
  return {
    uLampSpacing: { value: p.spacing },
    uLampPhase: { value: p.phase },
    uLampHeight: { value: p.height },
    uLampInset: { value: p.inset },
    uLampRange: { value: p.range },
    uLampIntensity: { value: p.intensity },
    uLampColor: { value: p.color },
    uTunnelSpacing: { value: p.tunnelSpacing },
    uTunnelHeight: { value: p.tunnelHeight },
    uTunnelD: { value: p.tunnelD },
    uTunnelColor: { value: p.tunnelColor },
    uTunnelIntensity: { value: p.tunnelIntensity },
  };
}

const VERT_PARS = /* glsl */ `
attribute vec4 aRoad;
attribute vec3 aTan;
attribute vec3 aUpR;
attribute float aHw;
varying vec4 vRoad;
varying float vHw;
varying vec3 vTanV;
varying vec3 vUpV;
`;

const VERT_MAIN = /* glsl */ `
vRoad = aRoad;
vHw = aHw;
vTanV = normalize( ( modelViewMatrix * vec4( aTan, 0.0 ) ).xyz );
vUpV = normalize( ( modelViewMatrix * vec4( aUpR, 0.0 ) ).xyz );
`;

const FRAG_PARS = /* glsl */ `
varying vec4 vRoad;
varying float vHw;
varying vec3 vTanV;
varying vec3 vUpV;
uniform float uLampSpacing;
uniform float uLampPhase;
uniform float uLampHeight;
uniform float uLampInset;
uniform float uLampRange;
uniform float uLampIntensity;
uniform vec3 uLampColor;
uniform float uTunnelSpacing;
uniform float uTunnelHeight;
uniform float uTunnelD;
uniform vec3 uTunnelColor;
uniform float uTunnelIntensity;
`;

const FRAG_LIGHT = /* glsl */ `
{
  float rs = vRoad.x;
  float rd = vRoad.y;
  float rh = vRoad.z;
  float hw = vHw;
  float zone = step(0.5, vRoad.w);
  vec3 Tv = normalize( vTanV );
  vec3 Nv = normalize( vUpV );
  vec3 Rv = normalize( cross( Tv, Nv ) );
  float spacing = mix( uLampSpacing, uTunnelSpacing, zone );
  float height = mix( uLampHeight, uTunnelHeight, zone );
  float inten = mix( uLampIntensity, uTunnelIntensity, zone );
  vec3 lcol = mix( uLampColor, uTunnelColor, zone ) * inten;
  float k0 = floor( ( rs - uLampPhase ) / spacing );
  for ( int i = 0; i < 2; i ++ ) {
    float ls = ( k0 + float( i ) ) * spacing + uLampPhase;
    for ( int side = 0; side < 2; side ++ ) {
      float sd = side == 0 ? -1.0 : 1.0;
      float ld = mix( sd * ( hw + uLampInset ), sd * uTunnelD, zone );
      vec3 L = Tv * ( ls - rs ) + Rv * ( ld - rd ) + Nv * ( height - rh );
      float dist = length( L );
      IncidentLight lamp;
      lamp.direction = L / dist;
      lamp.color = lcol * getDistanceAttenuation( dist, uLampRange, 2.0 );
      lamp.visible = true;
      RE_Direct( lamp, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );
    }
  }
}
`;

/** Per-car lamp set: the 4 lamps nearest to the car, in world space. */
export interface CarLamps {
  pos: THREE.Vector3[];
  col: THREE.Color[];
  range: { value: number };
}

export const makeCarLamps = (): CarLamps => ({
  pos: [0, 1, 2, 3].map(() => new THREE.Vector3(0, -1e4, 0)),
  col: [0, 1, 2, 3].map(() => new THREE.Color(0, 0, 0)),
  range: { value: 38 },
});

/**
 * Car paint receives the nearest street / tunnel lamps as point lights, so
 * bands of light sweep over the body at speed — the strongest "I'm flying
 * past things" cue on a car. Uniform values are updated per car per frame.
 */
export function patchCarLamps(mat: THREE.MeshStandardMaterial, lamps: CarLamps): void {
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uCarLampPos = { value: lamps.pos };
    shader.uniforms.uCarLampCol = { value: lamps.col };
    shader.uniforms.uCarLampRange = lamps.range;
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
uniform vec3 uCarLampPos[4];
uniform vec3 uCarLampCol[4];
uniform float uCarLampRange;`,
      )
      .replace(
        '#include <lights_fragment_end>',
        `{
  for (int i = 0; i < 4; i ++) {
    vec3 lp = ( viewMatrix * vec4( uCarLampPos[ i ], 1.0 ) ).xyz;
    vec3 L = lp - geometryPosition;
    float dist = length( L );
    IncidentLight lamp;
    lamp.direction = L / max( dist, 1e-3 );
    lamp.color = uCarLampCol[ i ] * getDistanceAttenuation( dist, uCarLampRange, 2.0 );
    lamp.visible = true;
    RE_Direct( lamp, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );
  }
}
#include <lights_fragment_end>`,
      );
  };
  mat.customProgramCacheKey = () => 'carLamps';
}

let keyCounter = 0;

/** Patch a MeshStandard/Physical material to receive analytic lamp lighting. */
export function patchRoadLamps(mat: THREE.MeshStandardMaterial, uniforms: Record<string, THREE.IUniform>): void {
  const key = `roadLamps-${keyCounter++}`;
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${VERT_PARS}`)
      .replace('#include <project_vertex>', `#include <project_vertex>\n${VERT_MAIN}`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${FRAG_PARS}`)
      .replace('#include <lights_fragment_end>', `${FRAG_LIGHT}\n#include <lights_fragment_end>`);
  };
  // All road materials share the same patch code; the key only has to differ
  // from unpatched programs.
  mat.customProgramCacheKey = () => 'roadLamps';
  void key;
}
