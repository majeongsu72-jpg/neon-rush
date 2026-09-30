import * as THREE from 'three';

export interface SkyParams {
  zenith: THREE.Color;
  mid: THREE.Color;
  horizon: THREE.Color;
  ground: THREE.Color;
  sunDir: THREE.Vector3;
  sunColor: THREE.Color;
  sunSize: number; // angular radius (cos space), 0 = none
  sunStripes: number; // synthwave stripes 0..1
  glowColor: THREE.Color; // horizon glow
  glowStrength: number;
  stars: number;
  clouds: number;
  cloudColor: THREE.Color;
}

const VERT = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = position;
  vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  gl_Position = vec4(p.xy, p.w * 0.99995, p.w); // pin just inside the far plane
}`;

const FRAG = /* glsl */ `
uniform vec3 uZenith;
uniform vec3 uMid;
uniform vec3 uHorizon;
uniform vec3 uGround;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform float uSunSize;
uniform float uSunStripes;
uniform vec3 uGlowColor;
uniform float uGlowStrength;
uniform float uStars;
uniform float uClouds;
uniform vec3 uCloudColor;
uniform float uTime;
uniform float uBeat;
varying vec3 vDir;

float hash13(vec3 p3) {
  p3 = fract(p3 * 0.1031);
  p3 += dot(p3, p3.zyx + 31.32);
  return fract((p3.x + p3.y) * p3.z);
}
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = hash13(vec3(i, 1.0)), b = hash13(vec3(i + vec2(1.0, 0.0), 1.0));
  float c = hash13(vec3(i + vec2(0.0, 1.0), 1.0)), d = hash13(vec3(i + vec2(1.0, 1.0), 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
float fbm(vec2 p) {
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 5; i++) { s += a * vnoise(p); p *= 2.03; a *= 0.5; }
  return s;
}

void main() {
  vec3 d = normalize(vDir);
  float h = d.y;
  vec3 col;
  if (h >= 0.0) {
    col = mix(uHorizon, uMid, smoothstep(0.0, 0.18, h));
    col = mix(col, uZenith, smoothstep(0.14, 0.75, h));
  } else {
    col = mix(uHorizon, uGround, smoothstep(0.0, 0.12, -h));
  }
  // horizon glow band (city light / sunset haze)
  col += uGlowColor * uGlowStrength * exp(-abs(h) * 14.0) * (1.0 + 0.25 * uBeat);

  // sun
  if (uSunSize > 0.0) {
    float sd = dot(d, normalize(uSunDir));
    float disc = smoothstep(1.0 - uSunSize, 1.0 - uSunSize * 0.92, sd);
    if (uSunStripes > 0.0) {
      // synthwave: horizontal gaps that widen toward the bottom of the disc
      vec3 sdN = normalize(uSunDir);
      float rel = (d.y - sdN.y) / uSunSize * 0.7; // -1 bottom .. 1 top (approx)
      float band = fract(rel * 5.5 + uTime * 0.05);
      float gapW = clamp(0.5 - rel * 0.45, 0.0, 0.6) * uSunStripes;
      float gap = step(band, gapW) * step(rel, 0.35);
      disc *= 1.0 - gap;
      vec3 sunGrad = mix(uSunColor * vec3(1.0, 0.35, 0.55), uSunColor, smoothstep(-0.9, 0.8, rel));
      col = mix(col, sunGrad * 2.4, disc);
    } else {
      col += uSunColor * disc * 6.0;
    }
    col += uSunColor * pow(max(sd, 0.0), 180.0) * 1.5 + uSunColor * pow(max(sd, 0.0), 12.0) * 0.18;
  }

  // clouds (thin streaks)
  if (uClouds > 0.0 && h > 0.0) {
    vec2 cp = d.xz / (h + 0.08) * 1.4 + vec2(uTime * 0.004, 0.0);
    float c = fbm(cp);
    c = smoothstep(0.52, 0.85, c) * smoothstep(0.0, 0.2, h) * uClouds;
    col = mix(col, uCloudColor, c * 0.7);
  }

  // stars
  if (uStars > 0.0 && h > 0.02) {
    vec3 sp = d * 380.0;
    vec3 cell = floor(sp);
    float r = hash13(cell);
    float star = step(0.9975, r) * smoothstep(0.5, 0.0, length(fract(sp) - 0.5));
    float tw = 0.6 + 0.4 * sin(uTime * (2.0 + r * 5.0) + r * 60.0);
    col += vec3(0.8, 0.85, 1.0) * star * tw * uStars * smoothstep(0.02, 0.3, h) * 3.0;
  }
  gl_FragColor = vec4(col, 1.0);
}`;

export class Sky {
  readonly mesh: THREE.Mesh;
  readonly material: THREE.ShaderMaterial;

  constructor(p: SkyParams, radius = 1000) {
    this.material = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: {
        uZenith: { value: p.zenith },
        uMid: { value: p.mid },
        uHorizon: { value: p.horizon },
        uGround: { value: p.ground },
        uSunDir: { value: p.sunDir },
        uSunColor: { value: p.sunColor },
        uSunSize: { value: p.sunSize },
        uSunStripes: { value: p.sunStripes },
        uGlowColor: { value: p.glowColor },
        uGlowStrength: { value: p.glowStrength },
        uStars: { value: p.stars },
        uClouds: { value: p.clouds },
        uCloudColor: { value: p.cloudColor },
        uTime: { value: 0 },
        uBeat: { value: 0 },
      },
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
    });
    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(radius, 48, 24), this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -1000;
    this.mesh.name = 'sky';
  }

  update(camera: THREE.Camera, time: number, beat = 0): void {
    this.mesh.position.copy(camera.position);
    this.material.uniforms.uTime.value = time;
    this.material.uniforms.uBeat.value = beat;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}
