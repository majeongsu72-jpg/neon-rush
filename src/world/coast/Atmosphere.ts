import * as THREE from 'three';

/**
 * Synthwave golden-hour atmosphere shared by every SUNSET COAST shader:
 *
 * - `atmSky(dir)`: gradient sky (violet zenith → magenta → gold horizon toward
 *   the sun, dusky pink with a Belt-of-Venus band away from it), a huge striped
 *   synthwave sun, forward-scatter glow, thin sun-lit cloud streaks, a few stars
 *   and faint island silhouettes on the horizon.
 * - `atmHaze(dir)`: the colour distant geometry fades into. It equals the sky
 *   at the horizon for every azimuth, so land and sea melt seamlessly into the
 *   sky: hills toward the sun dissolve into orange glow, away from it into
 *   violet dusk. Injected into built-in materials by `patchHaze` (replaces the
 *   flat FogExp2 colour but keeps its density).
 *
 * All colours are linear HDR (the renderer tone-maps later).
 */
export interface AtmosphereParams {
  /** Direction toward the centre of the visible sun disc (low over the sea). */
  sunDir: THREE.Vector3;
  /** Angular radius of the synthwave sun disc (rad). */
  sunRadius: number;
  sunTop: THREE.Color;
  sunBottom: THREE.Color;
  zenith: THREE.Color;
  midSun: THREE.Color;
  midAnti: THREE.Color;
  hazeSun: THREE.Color;
  hazeAnti: THREE.Color;
  belt: THREE.Color;
  glow: THREE.Color;
  cloudLit: THREE.Color;
  cloudShade: THREE.Color;
  clouds: number;
  stars: number;
}

export type AtmosphereUniforms = Record<string, THREE.IUniform>;

/** Uniform declarations + sky/haze functions (GLSL). */
export const ATMOS_GLSL = /* glsl */ `
uniform vec3 uAtmSunDir;
uniform vec3 uAtmSunRight;
uniform vec3 uAtmSunUp;
uniform float uAtmSunRadius;
uniform vec3 uAtmSunTop;
uniform vec3 uAtmSunBottom;
uniform vec3 uAtmZenith;
uniform vec3 uAtmMidSun;
uniform vec3 uAtmMidAnti;
uniform vec3 uAtmHazeSun;
uniform vec3 uAtmHazeAnti;
uniform vec3 uAtmBelt;
uniform vec3 uAtmGlow;
uniform vec3 uAtmCloudLit;
uniform vec3 uAtmCloudShade;
uniform float uAtmClouds;
uniform float uAtmStars;
uniform float uAtmTime;

float atmHash(vec3 p3) {
  p3 = fract(p3 * 0.1031);
  p3 += dot(p3, p3.zyx + 31.32);
  return fract((p3.x + p3.y) * p3.z);
}
float atmNoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = atmHash(vec3(i, 3.1)), b = atmHash(vec3(i + vec2(1.0, 0.0), 3.1));
  float c = atmHash(vec3(i + vec2(0.0, 1.0), 3.1)), d = atmHash(vec3(i + vec2(1.0, 1.0), 3.1));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

// 0 = facing away from the sun's azimuth, 1 = toward it (smoothed)
float atmAzimuth(vec3 d) {
  vec2 h = d.xz;
  float l = length(h);
  float c = l > 1e-4 ? dot(h / l, normalize(uAtmSunDir.xz)) : 0.0;
  float a = 0.5 + 0.5 * c;
  return a * a * (3.0 - 2.0 * a);
}

// forward-scatter glow around the sun (shared by sky and haze)
vec3 atmGlow(vec3 d) {
  float mu = max(dot(d, uAtmSunDir), 0.0);
  return uAtmGlow * (pow(mu, 6.0) * 0.5 + pow(mu, 48.0) * 1.1);
}

vec3 atmHaze(vec3 d) {
  return mix(uAtmHazeAnti, uAtmHazeSun, atmAzimuth(d)) + atmGlow(d);
}

vec3 atmSky(vec3 d, float detail) {
  float h = d.y;
  float he = max(h, 0.0);
  float az = atmAzimuth(d);
  vec3 col = mix(uAtmHazeAnti, uAtmHazeSun, az);
  vec3 mid = mix(uAtmMidAnti, uAtmMidSun, az);
  col = mix(col, mid, smoothstep(0.0, 0.24, he));
  col = mix(col, uAtmZenith, smoothstep(0.1, 0.9, he));
  // Belt of Venus: pink band above the Earth's shadow, opposite the sun
  float bx = (he - 0.12) / 0.075;
  float belt = exp(-bx * bx) * (1.0 - az);
  col += uAtmBelt * belt * smoothstep(0.0, 0.03, he);
  col += atmGlow(d);

  // faint island silhouettes on the horizon (away from the sun path; sky dome only)
  if (detail > 0.5) {
    vec2 hd = normalize(d.xz + vec2(1e-5));
    float isl = atmNoise(hd * 4.0 + 1.3) * 0.65 + atmNoise(hd * 13.0 + 7.7) * 0.35;
    float ih = max(isl - 0.52, 0.0) * 0.07 * (1.0 - az * 0.9);
    float land = (1.0 - smoothstep(ih - 0.0015, ih + 0.0015, h)) * step(0.0005, ih) * step(-0.002, h);
    col = mix(col, mix(uAtmHazeAnti, uAtmHazeSun, az) * 0.62, land * 0.75);
  }

  // synthwave sun: gradient disc with horizontal cuts widening downward
  vec3 rel = d - uAtmSunDir;
  float su = dot(rel, uAtmSunRight) / uAtmSunRadius;
  float sv = dot(rel, uAtmSunUp) / uAtmSunRadius;
  float r = length(vec2(su, sv));
  // cuts scroll slowly down into the sea and thicken toward the horizon
  float bv = sv * 8.0 + uAtmTime * 0.15;
  // derivatives in uniform control flow (before the branch)
  float aa = max(fwidth(r) * 1.5, 1e-4);
  float fa = max(fwidth(bv) * 1.2, 1e-4);
  if (r < 1.2 && dot(d, uAtmSunDir) > 0.0) {
    float disc = 1.0 - smoothstep(1.0 - aa, 1.0 + aa, r);
    float f = fract(bv);
    float gw = clamp((0.45 - sv) * 0.7, 0.0, 0.6);
    float gap = step(0.001, gw) * (1.0 - smoothstep(gw - fa, gw + fa, f));
    disc *= 1.0 - gap;
    vec3 sunCol = mix(uAtmSunBottom, uAtmSunTop, smoothstep(-0.35, 0.8, sv));
    sunCol *= 1.0 + 0.35 * (1.0 - r * r);
    col = mix(col, sunCol, disc);
  }

  if (detail > 0.5) {
    // thin streaky clouds: dark silhouettes against the sun, pink-lit elsewhere
    if (uAtmClouds > 0.0 && h > 0.0) {
      vec2 cp = d.xz / (h + 0.1);
      cp = vec2(cp.x * 0.93 + cp.y * 0.37, -cp.x * 0.37 + cp.y * 0.93);
      cp = cp * vec2(0.45, 2.6) + vec2(uAtmTime * 0.006, 0.0);
      float c = 0.0, amp = 0.5;
      vec2 q = cp;
      for (int i = 0; i < 5; i++) {
        c += amp * atmNoise(q);
        q = q * 2.07 + vec2(3.1, 1.7);
        amp *= 0.5;
      }
      float dens = smoothstep(0.5, 0.82, c) * smoothstep(0.015, 0.1, h) * (1.0 - smoothstep(0.35, 0.7, h)) * uAtmClouds;
      float mu = max(dot(d, uAtmSunDir), 0.0);
      vec3 cc = mix(uAtmCloudLit, uAtmCloudShade, smoothstep(0.55, 0.97, mu) * 0.85);
      cc += uAtmSunTop * pow(mu, 24.0) * (1.0 - dens) * 2.5; // silver lining
      col = mix(col, cc, dens);
    }
    // a few stars in the violet upper sky, away from the sun
    if (uAtmStars > 0.0 && h > 0.25) {
      vec3 sp = d * 300.0;
      vec3 cell = floor(sp);
      float rnd = atmHash(cell);
      float star = step(0.9982, rnd) * (1.0 - smoothstep(0.0, 0.45, length(fract(sp) - 0.5)));
      float tw = 0.6 + 0.4 * sin(uAtmTime * (1.5 + rnd * 4.0) + rnd * 50.0);
      col += vec3(1.0, 0.85, 1.0) * star * tw * uAtmStars * smoothstep(0.25, 0.7, h) * (1.0 - az);
    }
  }
  return col;
}
`;

const SKY_VERT = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = position;
  vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  gl_Position = vec4(p.xy, p.w * 0.99995, p.w); // pin just inside the far plane
}`;

const SKY_FRAG = /* glsl */ `
${ATMOS_GLSL}
varying vec3 vDir;
void main() {
  vec3 d = normalize(vDir);
  gl_FragColor = vec4(atmSky(d, 1.0), 1.0);
}`;

/** Haze replacement for three's fog_fragment (keeps the FogExp2 density). */
const HAZE_FRAGMENT = /* glsl */ `
#ifdef USE_FOG
  #ifdef FOG_EXP2
    float fogFactor = 1.0 - exp( - fogDensity * fogDensity * vFogDepth * vFogDepth );
  #else
    float fogFactor = smoothstep( fogNear, fogFar, vFogDepth );
  #endif
  vec3 hazeDirW = normalize( ( vec4( vHazeView, 0.0 ) * viewMatrix ).xyz );
  gl_FragColor.rgb = mix( gl_FragColor.rgb, atmHaze( hazeDirW ), fogFactor );
#endif
`;

export class Atmosphere {
  readonly params: AtmosphereParams;
  readonly uniforms: AtmosphereUniforms;
  readonly sky: THREE.Mesh;
  private readonly skyMat: THREE.ShaderMaterial;
  private readonly skyGeo: THREE.SphereGeometry;

  constructor(p: AtmosphereParams) {
    this.params = p;
    const sd = p.sunDir.clone().normalize();
    const right = new THREE.Vector3().crossVectors(sd, new THREE.Vector3(0, 1, 0)).normalize();
    const up = new THREE.Vector3().crossVectors(right, sd).normalize();
    this.uniforms = {
      uAtmSunDir: { value: sd },
      uAtmSunRight: { value: right },
      uAtmSunUp: { value: up },
      uAtmSunRadius: { value: p.sunRadius },
      uAtmSunTop: { value: p.sunTop },
      uAtmSunBottom: { value: p.sunBottom },
      uAtmZenith: { value: p.zenith },
      uAtmMidSun: { value: p.midSun },
      uAtmMidAnti: { value: p.midAnti },
      uAtmHazeSun: { value: p.hazeSun },
      uAtmHazeAnti: { value: p.hazeAnti },
      uAtmBelt: { value: p.belt },
      uAtmGlow: { value: p.glow },
      uAtmCloudLit: { value: p.cloudLit },
      uAtmCloudShade: { value: p.cloudShade },
      uAtmClouds: { value: p.clouds },
      uAtmStars: { value: p.stars },
      uAtmTime: { value: 0 },
    };
    this.skyMat = new THREE.ShaderMaterial({
      vertexShader: SKY_VERT,
      fragmentShader: SKY_FRAG,
      uniforms: this.uniforms,
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
    });
    this.skyGeo = new THREE.SphereGeometry(900, 64, 32);
    this.sky = new THREE.Mesh(this.skyGeo, this.skyMat);
    this.sky.frustumCulled = false;
    // Last among opaques: early-z skips every pixel the island and sea cover.
    this.sky.renderOrder = 1000;
    this.sky.name = 'sky';
  }

  update(camera: THREE.Camera, time: number): void {
    this.sky.position.copy(camera.position);
    this.uniforms.uAtmTime.value = time;
  }

  /**
   * Swap the flat fog colour of a built-in material for the directional haze.
   * Chains any existing onBeforeCompile and extends its program cache key.
   */
  patchHaze(mat: THREE.Material): void {
    const prev = mat.onBeforeCompile;
    const baseKey = mat.customProgramCacheKey();
    const uniforms = this.uniforms;
    mat.onBeforeCompile = (shader, renderer) => {
      prev.call(mat, shader, renderer);
      Object.assign(shader.uniforms, uniforms);
      shader.vertexShader = shader.vertexShader
        .replace('#include <fog_pars_vertex>', '#include <fog_pars_vertex>\nvarying vec3 vHazeView;')
        .replace('#include <fog_vertex>', '#include <fog_vertex>\nvHazeView = mvPosition.xyz;');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <fog_pars_fragment>', `#include <fog_pars_fragment>\nvarying vec3 vHazeView;\n${ATMOS_GLSL}`)
        .replace('#include <fog_fragment>', HAZE_FRAGMENT);
    };
    mat.customProgramCacheKey = () => `${baseKey}|coastHaze`;
    mat.needsUpdate = true;
  }

  /**
   * Pre-filtered environment map: this sky plus a dark sea below and a few
   * soft sunset panels, so paint and chrome pick up pink/orange/violet.
   */
  buildEnvMap(gl: THREE.WebGLRenderer): { texture: THREE.Texture; dispose: () => void } {
    const scene = new THREE.Scene();
    const geo = new THREE.SphereGeometry(60, 48, 24);
    const sky = new THREE.Mesh(geo, this.skyMat);
    scene.add(sky);
    const disposables: { dispose(): void }[] = [geo];
    const panel = (dir: [number, number, number], color: THREE.Color, w: number, h: number, dist = 40) => {
      const mat = new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide, fog: false });
      const g = new THREE.PlaneGeometry(w, h);
      const m = new THREE.Mesh(g, mat);
      m.position.set(...dir).normalize().multiplyScalar(dist);
      m.lookAt(0, 0, 0);
      scene.add(m);
      disposables.push(mat, g);
    };
    // dark evening sea / ground under the horizon
    const sea = new THREE.Mesh(
      new THREE.CircleGeometry(120, 32),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(0.035, 0.022, 0.05), side: THREE.DoubleSide, fog: false }),
    );
    sea.rotation.x = -Math.PI / 2;
    sea.position.y = -6;
    scene.add(sea);
    disposables.push(sea.geometry, sea.material as THREE.Material);
    const sd = this.params.sunDir;
    // warm glare streak on the sea below the sun, magenta and violet fills elsewhere
    panel([sd.x, -0.12, sd.z], new THREE.Color(2.2, 0.9, 0.3), 26, 5);
    panel([-sd.x, 0.18, -sd.z], new THREE.Color(0.9, 0.18, 0.55), 40, 9);
    panel([sd.z, 0.1, -sd.x], new THREE.Color(0.55, 0.2, 0.75), 30, 8);
    panel([-sd.z, 0.1, sd.x], new THREE.Color(1.0, 0.35, 0.3), 30, 8);
    const pmrem = new THREE.PMREMGenerator(gl);
    const rt = pmrem.fromScene(scene, 0.03, 0.1, 150, { size: 256 });
    pmrem.dispose();
    for (const d of disposables) d.dispose();
    return { texture: rt.texture, dispose: () => rt.dispose() };
  }

  dispose(): void {
    this.skyGeo.dispose();
    this.skyMat.dispose();
  }
}
