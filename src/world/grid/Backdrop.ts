import * as THREE from 'three';
import { GLSL_COMMON, type GridUniforms } from './common';

const VERT = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = position;
  vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  gl_Position = vec4(p.xy, p.w * 0.99994, p.w); // just in front of the sky dome
}
`;

/**
 * Celestial bodies at infinity, evaluated per pixel and added over the sky
 * dome: a ray-traced hologram planet (lat/long wireframe, scanline bands,
 * magenta limb + halo, tilted rings that pass in front of / behind the globe),
 * a striped synthwave sun sinking behind the grid, and a laser horizon line.
 */
const FRAG = /* glsl */ `
uniform vec3 uPlanetDir;
uniform float uPlanetR;
uniform float uPlanetAng;
uniform mat3 uPlanetFrame;
uniform vec3 uRingN;
uniform vec3 uLightDir;
uniform vec3 uSunDir;
uniform float uSunAng;
uniform float uClock;
uniform float uPulse;
varying vec3 vDir;
${GLSL_COMMON}
void main() {
  vec3 d = normalize(vDir);

  // ---- planet
  vec3 C = uPlanetDir;
  float r = uPlanetR;
  float b = dot(d, C);
  float disc = r * r - (1.0 - b * b);
  float onDisc = step(0.0, disc) * step(0.0, b);
  // Sphere hit, clamped so every pixel (inside or not) has smooth, defined
  // derivatives for the line filters; the result is masked by onDisc.
  float t = b - sqrt(max(disc, 0.0));
  float tHit = onDisc > 0.5 ? t : 1e9;
  vec3 N = normalize(d * t - C);
  vec3 Nl = uPlanetFrame * N;
  float lat = asin(clamp(Nl.y, -1.0, 1.0));
  float lon = atan(Nl.z, Nl.x) + uClock * (G_TAU / 120.0);
  float latX = lat / 0.2618;
  float lonX = lon / 0.3927;
  float latL = gLineW(gWrap(latX, 1.0), 0.045, fwidth(latX));
  float lonL = gLineW(gWrap(lonX, 1.0), 0.045, fwidth(lonX)) * (1.0 - smoothstep(1.25, 1.5, abs(lat)));
  float facing = max(dot(N, -d), 0.0);
  float rim = pow(max(1.0 - facing, 0.0), 3.0);
  float lit = clamp(dot(N, uLightDir) * 0.5 + 0.5, 0.0, 1.0);
  float bands = 0.55 + 0.45 * gBand(Nl.y * 16.0 - uClock * 0.5, 0.5);
  vec3 body = mix(vec3(0.03, 0.005, 0.06), vec3(0.3, 0.04, 0.36), lit * lit) * bands;
  float wire = max(latL, lonL) * (0.35 + 0.9 * lit);
  vec3 col = (body + G_CYAN * wire * (1.0 + 0.7 * uPulse) + G_MAGENTA * rim * 2.0) * onDisc;
  float beyond = max(acos(clamp(b, -1.0, 1.0)) - uPlanetAng, 0.0);
  col += (G_MAGENTA * exp(-beyond * 34.0) * 0.9 + G_VIOLET * exp(-beyond * 7.0) * 0.1) * (1.0 - onDisc);
  // rings in the equatorial plane (hidden where they pass behind the globe)
  float dn = dot(d, uRingN);
  float tr = dot(C, uRingN) / (abs(dn) > 1e-4 ? dn : 1e-4);
  float rr = length(d * tr - C) / r;
  float ringVis = step(0.0, tr) * step(tr, tHit);
  float bandsR = 0.35 + 0.65 * gBand(rr * 9.0, 0.55);
  float edge = smoothstep(1.3, 1.42, rr) * (1.0 - smoothstep(2.22, 2.4, rr));
  float gx = (rr - 1.82) / 0.035;
  float gap = 1.0 - 0.85 * exp(-gx * gx);
  col += mix(G_MAGENTA, G_CYAN, smoothstep(1.45, 2.3, rr)) * bandsR * edge * gap * ringVis * 0.5 * (1.0 + 0.5 * uPulse);

  // ---- synthwave sun: gradient disc, gaps widening toward the bottom, drifting down
  float sAng = acos(clamp(dot(d, uSunDir), -1.0, 1.0));
  float sW = max(fwidth(sAng), 1e-5);
  float sDisc = 1.0 - smoothstep(uSunAng - sW, uSunAng + sW, sAng);
  float rel = (d.y - uSunDir.y) / uSunAng; // -1 bottom .. 1 top
  float gapW = clamp(0.4 - rel * 0.5, 0.0, 0.62) * (1.0 - smoothstep(0.2, 0.35, rel));
  float stripe = gBandW(rel * 7.0 + uClock * 0.4, 1.0 - gapW, fwidth(rel * 7.0));
  vec3 sunCol = mix(vec3(1.0, 0.1, 0.5), vec3(1.0, 0.8, 0.28), smoothstep(-0.9, 0.9, rel));
  col += sunCol * sDisc * stripe * (2.3 + 0.8 * uPulse);
  float sOut = max(sAng - uSunAng, 0.0);
  col += vec3(1.0, 0.25, 0.6) * (exp(-sOut * 24.0) * 0.45 + exp(-sOut * 5.0) * 0.07);

  // ---- thin laser line on the horizon, faint cyan band above the magenta glow
  col += G_MAGENTA * (gLine(d.y, 0.0012) * 1.6 + exp(-abs(d.y) * 70.0) * 0.1) * (1.0 + 0.6 * uPulse);
  col += G_CYAN * exp(-abs(d.y - 0.06) * 28.0) * 0.022;
  gl_FragColor = vec4(col, 1.0);
}
`;

export interface Backdrop {
  mesh: THREE.Mesh;
  disposables: { dispose(): void }[];
}

export interface BackdropParams {
  /** Horizontal (x, z) direction of the planet, its centre elevation and angular radius (degrees). */
  planetAz: [number, number];
  planetEl: number;
  planetR: number;
  sunAz: [number, number];
  sunEl: number;
  sunR: number;
}

const dirOf = (az: [number, number], elDeg: number): THREE.Vector3 => {
  const a = new THREE.Vector2(az[0], az[1]).normalize();
  const el = THREE.MathUtils.degToRad(elDeg);
  return new THREE.Vector3(a.x * Math.cos(el), Math.sin(el), a.y * Math.cos(el)).normalize();
};

export function buildBackdrop(U: GridUniforms, p: BackdropParams): Backdrop {
  const dir = dirOf(p.planetAz, p.planetEl);
  const ang = THREE.MathUtils.degToRad(p.planetR);
  // spin axis tilted ~24° sideways; rings lie in the equatorial plane
  const side = new THREE.Vector3().crossVectors(dir, new THREE.Vector3(0, 1, 0)).normalize();
  const axis = new THREE.Vector3(0, 1, 0).addScaledVector(side, 0.45).addScaledVector(dir, -0.12).normalize();
  const ex = new THREE.Vector3().crossVectors(axis, dir).normalize();
  const ez = new THREE.Vector3().crossVectors(ex, axis).normalize();
  const frame = new THREE.Matrix3().set(ex.x, ex.y, ex.z, axis.x, axis.y, axis.z, ez.x, ez.y, ez.z);
  const light = new THREE.Vector3(0, 0.75, 0).addScaledVector(side, -0.6).addScaledVector(dir, -0.25).normalize();

  const mat = new THREE.ShaderMaterial({
    vertexShader: VERT,
    fragmentShader: FRAG,
    uniforms: {
      uPlanetDir: { value: dir },
      uPlanetR: { value: Math.sin(ang) },
      uPlanetAng: { value: ang },
      uPlanetFrame: { value: frame },
      uRingN: { value: axis },
      uLightDir: { value: light },
      uSunDir: { value: dirOf(p.sunAz, p.sunEl) },
      uSunAng: { value: THREE.MathUtils.degToRad(p.sunR) },
      uClock: U.uClock,
      uPulse: U.uPulse,
    },
    side: THREE.BackSide,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    fog: false,
  });
  const geo = new THREE.SphereGeometry(800, 64, 32);
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'gridBackdrop';
  mesh.frustumCulled = false;
  mesh.renderOrder = -999; // right after the sky dome, before any scene geometry
  return { mesh, disposables: [geo, mat] };
}
