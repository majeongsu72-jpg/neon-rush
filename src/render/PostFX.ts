import * as THREE from 'three';

/** Per-frame look parameters driven by speed, boosts, impacts and the theme. */
export interface PostParams {
  exposure: number;
  bloom: number; // bloom mix
  threshold: number; // bloom threshold (linear HDR)
  blur: number; // radial speed blur strength 0..~0.14
  ca: number; // chromatic aberration 0..~0.012
  lines: number; // speed lines 0..1
  vignette: number; // 0..1
  grain: number;
  saturation: number;
  contrast: number;
  lift: THREE.Color;
  gain: THREE.Color;
  flash: number;
  flashColor: THREE.Color;
  fade: number;
  center: THREE.Vector2;
  lineColor: THREE.Color;
}

export const defaultPostParams = (): PostParams => ({
  exposure: 1,
  bloom: 1,
  threshold: 1,
  blur: 0,
  ca: 0,
  lines: 0,
  vignette: 0.35,
  grain: 0.035,
  saturation: 1.08,
  contrast: 1.04,
  lift: new THREE.Color(0, 0, 0),
  gain: new THREE.Color(1, 1, 1),
  flash: 0,
  flashColor: new THREE.Color(1, 1, 1),
  fade: 0,
  center: new THREE.Vector2(0.5, 0.52),
  lineColor: new THREE.Color(1, 1, 1),
});

const VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = position.xy * 0.5 + 0.5;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}`;

const DOWNSAMPLE = /* glsl */ `
precision highp float;
uniform sampler2D tSrc;
uniform vec2 uTexel;
uniform float uPrefilter; // 1 on the first pass
uniform float uThreshold;
uniform float uKnee;
varying vec2 vUv;

vec3 prefilter(vec3 c) {
  float br = max(c.r, max(c.g, c.b));
  float rq = clamp(br - uThreshold + uKnee, 0.0, 2.0 * uKnee);
  rq = (rq * rq) / (4.0 * uKnee + 1e-5);
  float contrib = max(rq, br - uThreshold) / max(br, 1e-5);
  return c * contrib;
}
float karis(vec3 c) { return 1.0 / (1.0 + max(c.r, max(c.g, c.b))); }

vec3 tap(vec2 o) { return texture2D(tSrc, vUv + o * uTexel).rgb; }

void main() {
  vec3 a = tap(vec2(-2.0, 2.0)), b = tap(vec2(0.0, 2.0)), c = tap(vec2(2.0, 2.0));
  vec3 d = tap(vec2(-2.0, 0.0)), e = tap(vec2(0.0, 0.0)), f = tap(vec2(2.0, 0.0));
  vec3 g = tap(vec2(-2.0, -2.0)), h = tap(vec2(0.0, -2.0)), i = tap(vec2(2.0, -2.0));
  vec3 j = tap(vec2(-1.0, 1.0)), k = tap(vec2(1.0, 1.0));
  vec3 l = tap(vec2(-1.0, -1.0)), m = tap(vec2(1.0, -1.0));
  vec3 res;
  if (uPrefilter > 0.5) {
    vec3 g0 = (a + b + d + e) * 0.25, g1 = (b + c + e + f) * 0.25;
    vec3 g2 = (d + e + g + h) * 0.25, g3 = (e + f + h + i) * 0.25;
    vec3 g4 = (j + k + l + m) * 0.25;
    g0 = prefilter(g0); g1 = prefilter(g1); g2 = prefilter(g2); g3 = prefilter(g3); g4 = prefilter(g4);
    float w0 = karis(g0) * 0.125, w1 = karis(g1) * 0.125, w2 = karis(g2) * 0.125, w3 = karis(g3) * 0.125, w4 = karis(g4) * 0.5;
    res = (g0 * w0 + g1 * w1 + g2 * w2 + g3 * w3 + g4 * w4) / (w0 + w1 + w2 + w3 + w4);
  } else {
    res = e * 0.125 + (a + c + g + i) * 0.03125 + (b + d + f + h) * 0.0625 + (j + k + l + m) * 0.125;
  }
  gl_FragColor = vec4(max(res, vec3(0.0)), 1.0);
}`;

const UPSAMPLE = /* glsl */ `
precision highp float;
uniform sampler2D tSrc;
uniform vec2 uTexel;
uniform float uRadius;
uniform float uWeight;
varying vec2 vUv;
vec3 tap(vec2 o) { return texture2D(tSrc, vUv + o * uTexel * uRadius).rgb; }
void main() {
  vec3 s = tap(vec2(0.0)) * 4.0;
  s += (tap(vec2(-1.0, 0.0)) + tap(vec2(1.0, 0.0)) + tap(vec2(0.0, -1.0)) + tap(vec2(0.0, 1.0))) * 2.0;
  s += tap(vec2(-1.0, -1.0)) + tap(vec2(1.0, -1.0)) + tap(vec2(-1.0, 1.0)) + tap(vec2(1.0, 1.0));
  gl_FragColor = vec4(s * (uWeight / 16.0), 1.0);
}`;

const COMPOSITE = /* glsl */ `
precision highp float;
uniform sampler2D tScene;
uniform sampler2D tBloom;
uniform vec2 uResolution;
uniform float uTime;
uniform float uExposure;
uniform float uBloom;
uniform float uBlur;
uniform float uCA;
uniform float uLines;
uniform vec3 uLineColor;
uniform float uVignette;
uniform float uGrain;
uniform float uSaturation;
uniform float uContrast;
uniform vec3 uLift;
uniform vec3 uGain;
uniform float uFlash;
uniform vec3 uFlashColor;
uniform float uFade;
uniform vec2 uCenter;
varying vec2 vUv;

#ifndef TAPS
#define TAPS 10
#endif

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float hash11(float p) {
  p = fract(p * 0.1031);
  p *= p + 33.33;
  p *= p + p;
  return fract(p);
}

vec3 RRTAndODTFit(vec3 v) {
  vec3 a = v * (v + 0.0245786) - 0.000090537;
  vec3 b = v * (0.983729 * v + 0.4329510) + 0.238081;
  return a / b;
}
vec3 acesFitted(vec3 color) {
  const mat3 ACESInputMat = mat3(
    vec3(0.59719, 0.07600, 0.02840),
    vec3(0.35458, 0.90834, 0.13383),
    vec3(0.04823, 0.01566, 0.83777));
  const mat3 ACESOutputMat = mat3(
    vec3(1.60475, -0.10208, -0.00327),
    vec3(-0.53108, 1.10813, -0.07276),
    vec3(-0.07367, -0.00605, 1.07602));
  color = ACESInputMat * color;
  color = RRTAndODTFit(color);
  color = ACESOutputMat * color;
  return clamp(color, 0.0, 1.0);
}
vec3 toSRGB(vec3 c) {
  c = max(c, 0.0); // pow(<0) is NaN, and mix(x, NaN, 0) is still NaN
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}

void main() {
  vec2 uv = vUv;
  vec2 dir = uv - uCenter;
  float aspect = uResolution.x / uResolution.y;
  float dist = length(dir * vec2(aspect, 1.0));
  float mask = smoothstep(0.1, 0.8, dist);
  float strength = uBlur * mask;
  float ca = uCA * dist * dist * 2.0;

  vec3 col;
  if (strength < 0.0015 && ca < 0.0002) {
    col = texture2D(tScene, uv).rgb;
  } else {
    col = vec3(0.0);
    float jitter = hash12(gl_FragCoord.xy + fract(uTime) * 61.0) - 0.5;
    for (int i = 0; i < TAPS; i++) {
      float t = (float(i) + jitter * 0.9) / float(TAPS);
      float sc = 1.0 - strength * t;
      col.r += texture2D(tScene, uCenter + dir * (sc + ca)).r;
      col.g += texture2D(tScene, uCenter + dir * sc).g;
      col.b += texture2D(tScene, uCenter + dir * (sc - ca)).b;
    }
    col /= float(TAPS);
  }

  vec3 bloom = texture2D(tBloom, uCenter + dir * (1.0 - strength * 0.35)).rgb;
  col += bloom * uBloom;
  col *= uExposure;

  col = acesFitted(col / 0.6);

  // grade
  float l = dot(col, vec3(0.2126, 0.7152, 0.0722));
  col = mix(vec3(l), col, uSaturation);
  col = clamp((col - 0.5) * uContrast + 0.5, 0.0, 1.0);
  col = col * uGain + uLift * (1.0 - col);

  // anime speed lines
  if (uLines > 0.001) {
    float ang = atan(dir.y, dir.x * aspect);
    float a = ang / 6.2831853 + 0.5;
    float n = 150.0;
    float id = floor(a * n);
    float f = fract(a * n);
    float frame = floor(uTime * 14.0);
    float rnd = hash11(id * 1.37 + frame * 17.13);
    float w = 0.08 + 0.3 * hash11(id * 7.1 + frame);
    float line = smoothstep(w, 0.0, abs(f - 0.5));
    float reach = 0.38 + 0.4 * hash11(id * 3.7 + frame * 5.1);
    line *= step(0.62, rnd) * smoothstep(reach, reach + 0.35, dist);
    col = mix(col, uLineColor, clamp(line * uLines * 0.75, 0.0, 1.0));
  }

  // vignette
  float vig = smoothstep(1.05, 0.2, dist);
  col *= mix(1.0 - uVignette, 1.0, vig);

  col = mix(col, uFlashColor, clamp(uFlash, 0.0, 1.0));
  col *= 1.0 - uFade;
  col = toSRGB(clamp(col, 0.0, 1.0));
  col += (hash12(gl_FragCoord.xy + fract(uTime * 7.13) * 113.0) - 0.5) * uGrain;
  gl_FragColor = vec4(col, 1.0);
}`;

export class PostFX {
  readonly params: PostParams = defaultPostParams();
  private readonly renderer: THREE.WebGLRenderer;
  private sceneRT: THREE.WebGLRenderTarget;
  private mips: THREE.WebGLRenderTarget[] = [];
  private readonly quadScene = new THREE.Scene();
  private readonly quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly quad: THREE.Mesh;
  private readonly downMat: THREE.ShaderMaterial;
  private readonly upMat: THREE.ShaderMaterial;
  private compMat: THREE.ShaderMaterial;
  private msaa: number;
  private mipCount: number;
  private taps: number;
  private width = 1;
  private height = 1;
  private time = 0;

  constructor(renderer: THREE.WebGLRenderer, opts: { msaa: number; mips: number; taps: number }) {
    this.renderer = renderer;
    this.msaa = opts.msaa;
    this.mipCount = opts.mips;
    this.taps = opts.taps;
    this.sceneRT = this.makeSceneRT(1, 1);

    const tri = new THREE.BufferGeometry();
    tri.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
    this.downMat = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: DOWNSAMPLE,
      uniforms: {
        tSrc: { value: null },
        uTexel: { value: new THREE.Vector2() },
        uPrefilter: { value: 0 },
        uThreshold: { value: 1 },
        uKnee: { value: 0.6 },
      },
      depthTest: false,
      depthWrite: false,
    });
    this.upMat = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: UPSAMPLE,
      uniforms: {
        tSrc: { value: null },
        uTexel: { value: new THREE.Vector2() },
        uRadius: { value: 1 },
        uWeight: { value: 1 },
      },
      depthTest: false,
      depthWrite: false,
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneFactor,
    });
    this.compMat = this.makeComposite();
    this.quad = new THREE.Mesh(tri, this.downMat);
    this.quad.frustumCulled = false;
    this.quadScene.add(this.quad);
  }

  private makeSceneRT(w: number, h: number): THREE.WebGLRenderTarget {
    return new THREE.WebGLRenderTarget(w, h, {
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      samples: this.msaa,
      depthBuffer: true,
      stencilBuffer: false,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      generateMipmaps: false,
    });
  }

  private makeComposite(): THREE.ShaderMaterial {
    return new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: COMPOSITE,
      defines: { TAPS: this.taps },
      uniforms: {
        tScene: { value: null },
        tBloom: { value: null },
        uResolution: { value: new THREE.Vector2(1, 1) },
        uTime: { value: 0 },
        uExposure: { value: 1 },
        uBloom: { value: 1 },
        uBlur: { value: 0 },
        uCA: { value: 0 },
        uLines: { value: 0 },
        uLineColor: { value: new THREE.Color(1, 1, 1) },
        uVignette: { value: 0.35 },
        uGrain: { value: 0.03 },
        uSaturation: { value: 1 },
        uContrast: { value: 1 },
        uLift: { value: new THREE.Color(0, 0, 0) },
        uGain: { value: new THREE.Color(1, 1, 1) },
        uFlash: { value: 0 },
        uFlashColor: { value: new THREE.Color(1, 1, 1) },
        uFade: { value: 0 },
        uCenter: { value: new THREE.Vector2(0.5, 0.5) },
      },
      depthTest: false,
      depthWrite: false,
    });
  }

  configure(opts: { msaa: number; mips: number; taps: number }): void {
    const rebuildScene = opts.msaa !== this.msaa;
    const rebuildComp = opts.taps !== this.taps;
    this.msaa = opts.msaa;
    this.mipCount = opts.mips;
    this.taps = opts.taps;
    if (rebuildScene) {
      this.sceneRT.dispose();
      this.sceneRT = this.makeSceneRT(this.width, this.height);
    }
    if (rebuildComp) {
      this.compMat.dispose();
      this.compMat = this.makeComposite();
    }
    this.setSize(this.width, this.height, true);
  }

  setSize(w: number, h: number, force = false): void {
    w = Math.max(1, Math.floor(w));
    h = Math.max(1, Math.floor(h));
    if (!force && w === this.width && h === this.height) return;
    this.width = w;
    this.height = h;
    this.sceneRT.setSize(w, h);
    for (const m of this.mips) m.dispose();
    this.mips = [];
    let mw = w, mh = h;
    for (let i = 0; i < this.mipCount; i++) {
      mw = Math.max(1, Math.floor(mw / 2));
      mh = Math.max(1, Math.floor(mh / 2));
      this.mips.push(
        new THREE.WebGLRenderTarget(mw, mh, {
          type: THREE.HalfFloatType,
          format: THREE.RGBAFormat,
          depthBuffer: false,
          stencilBuffer: false,
          minFilter: THREE.LinearFilter,
          magFilter: THREE.LinearFilter,
          generateMipmaps: false,
        }),
      );
    }
  }

  get target(): THREE.WebGLRenderTarget {
    return this.sceneRT;
  }

  render(scene: THREE.Scene, camera: THREE.Camera, dt: number): void {
    const r = this.renderer;
    const p = this.params;
    this.time += dt;

    r.setRenderTarget(this.sceneRT);
    r.render(scene, camera);

    // --- bloom: downsample chain
    this.quad.material = this.downMat;
    const du = this.downMat.uniforms;
    du.uThreshold.value = p.threshold;
    let src: THREE.Texture = this.sceneRT.texture;
    let sw = this.width, sh = this.height;
    for (let i = 0; i < this.mips.length; i++) {
      du.tSrc.value = src;
      du.uTexel.value.set(1 / sw, 1 / sh);
      du.uPrefilter.value = i === 0 ? 1 : 0;
      r.setRenderTarget(this.mips[i]);
      r.render(this.quadScene, this.quadCam);
      src = this.mips[i].texture;
      sw = this.mips[i].width;
      sh = this.mips[i].height;
    }
    // --- upsample (additive) back to mip 0 — must not clear the targets
    this.quad.material = this.upMat;
    const uu = this.upMat.uniforms;
    const prevAutoClear = r.autoClear;
    r.autoClear = false;
    for (let i = this.mips.length - 1; i > 0; i--) {
      const from = this.mips[i];
      uu.tSrc.value = from.texture;
      uu.uTexel.value.set(1 / from.width, 1 / from.height);
      uu.uRadius.value = 1.0;
      uu.uWeight.value = i === this.mips.length - 1 ? 1.0 : 0.85;
      r.setRenderTarget(this.mips[i - 1]);
      r.render(this.quadScene, this.quadCam);
    }
    r.autoClear = prevAutoClear;

    // --- composite to screen
    this.quad.material = this.compMat;
    const u = this.compMat.uniforms;
    u.tScene.value = this.sceneRT.texture;
    u.tBloom.value = this.mips.length ? this.mips[0].texture : this.sceneRT.texture;
    u.uResolution.value.set(this.width, this.height);
    u.uTime.value = this.time;
    u.uExposure.value = p.exposure;
    u.uBloom.value = this.mips.length ? p.bloom * 0.22 : 0;
    u.uBlur.value = p.blur;
    u.uCA.value = p.ca;
    u.uLines.value = p.lines;
    u.uLineColor.value.copy(p.lineColor);
    u.uVignette.value = p.vignette;
    u.uGrain.value = p.grain;
    u.uSaturation.value = p.saturation;
    u.uContrast.value = p.contrast;
    u.uLift.value.copy(p.lift);
    u.uGain.value.copy(p.gain);
    u.uFlash.value = p.flash;
    u.uFlashColor.value.copy(p.flashColor);
    u.uFade.value = p.fade;
    u.uCenter.value.copy(p.center);
    r.setRenderTarget(null);
    r.render(this.quadScene, this.quadCam);
  }

  dispose(): void {
    this.sceneRT.dispose();
    for (const m of this.mips) m.dispose();
    this.downMat.dispose();
    this.upMat.dispose();
    this.compMat.dispose();
  }
}
