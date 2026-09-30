import * as THREE from 'three';

/**
 * Stateless GPU particles: the CPU only writes spawn attributes into a ring
 * buffer; the vertex shader integrates motion (drag + gravity) from the spawn
 * time, so thousands of live sparks cost nothing per frame on the CPU.
 * Fast particles are drawn as screen-space streaks along their velocity.
 */
const VERT = /* glsl */ `
#include <common>
#include <fog_pars_vertex>
attribute vec3 aP0;
attribute vec3 aV0;
attribute vec4 aLife;   // spawnTime, life, sizeStart, sizeEnd
attribute vec4 aColor;  // rgb (HDR), alpha
attribute vec4 aParams; // drag, gravity, stretch, spin
uniform float uTime;
varying vec4 vColor;
varying vec2 vUv;
varying float vT;
void main() {
  float age = uTime - aLife.x;
  float t = age / max(aLife.y, 1e-3);
  vUv = position.xy + 0.5;
  if (t < 0.0 || t > 1.0) {
    gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
    vColor = vec4(0.0);
    vT = 1.0;
    return;
  }
  vT = t;
  float k = max(aParams.x, 1e-3);
  float decay = exp(-k * age);
  vec3 g = vec3(0.0, -aParams.y, 0.0);
  vec3 p = aP0 + aV0 * (1.0 - decay) / k + 0.5 * g * age * age;
  vec3 vel = aV0 * decay + g * age;
  float size = mix(aLife.z, aLife.w, t);
  vec4 mvPosition = viewMatrix * vec4(p, 1.0);
  vec2 corner;
  if (aParams.z > 0.0) {
    vec3 vv = (viewMatrix * vec4(vel, 0.0)).xyz;
    // project velocity to screen-ish plane scaled by depth for a consistent streak
    vec2 d2 = vv.xy / max(-mvPosition.z, 0.5);
    float l2 = length(d2);
    vec2 dir = l2 > 1e-4 ? d2 / l2 : vec2(0.0, 1.0);
    vec2 perp = vec2(-dir.y, dir.x);
    float len = size + aParams.z * length(vv) * 0.035;
    corner = perp * position.x * size + dir * position.y * len;
  } else {
    float a = aParams.w * age;
    float c = cos(a), s = sin(a);
    corner = vec2(c * position.x - s * position.y, s * position.x + c * position.y) * size;
  }
  mvPosition.xy += corner;
  gl_Position = projectionMatrix * mvPosition;
  float fadeIn = smoothstep(0.0, 0.08, t);
  vColor = vec4(aColor.rgb, aColor.a * fadeIn * (1.0 - t) * (1.0 - t * 0.3));
  #include <fog_vertex>
}`;

const FRAG = /* glsl */ `
#include <common>
#include <fog_pars_fragment>
uniform float uSoft;
varying vec4 vColor;
varying vec2 vUv;
varying float vT;
void main() {
  vec2 q = vUv * 2.0 - 1.0;
  float r = dot(q, q);
  float a = uSoft > 0.5 ? smoothstep(1.0, 0.0, r) * (0.75 + 0.25 * (1.0 - vT)) : pow(max(0.0, 1.0 - r), 2.2);
  if (a <= 0.003) discard;
  gl_FragColor = vec4(vColor.rgb, vColor.a * a);
  #include <fog_fragment>
}`;

export interface EmitParams {
  life: number;
  size0: number;
  size1: number;
  r: number;
  g: number;
  b: number;
  a: number;
  drag?: number;
  gravity?: number;
  stretch?: number;
  spin?: number;
}

export class GpuParticles {
  readonly mesh: THREE.Mesh;
  readonly capacity: number;
  private head = 0;
  private readonly p0: THREE.InstancedBufferAttribute;
  private readonly v0: THREE.InstancedBufferAttribute;
  private readonly life: THREE.InstancedBufferAttribute;
  private readonly color: THREE.InstancedBufferAttribute;
  private readonly params: THREE.InstancedBufferAttribute;
  private readonly material: THREE.ShaderMaterial;
  private dirtyLo = Infinity;
  private dirtyHi = -1;
  private wrapped = false;
  time = 0;

  constructor(capacity: number, mode: 'additive' | 'alpha') {
    this.capacity = capacity;
    const geo = new THREE.InstancedBufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0], 3));
    geo.setIndex([0, 1, 2, 0, 2, 3]);
    const mk = (n: number) => {
      const a = new THREE.InstancedBufferAttribute(new Float32Array(capacity * n), n);
      a.setUsage(THREE.DynamicDrawUsage);
      return a;
    };
    this.p0 = mk(3);
    this.v0 = mk(3);
    this.life = mk(4);
    this.color = mk(4);
    this.params = mk(4);
    // mark all slots dead
    for (let i = 0; i < capacity; i++) this.life.setXYZW(i, -1e6, 1, 0, 0);
    geo.setAttribute('aP0', this.p0);
    geo.setAttribute('aV0', this.v0);
    geo.setAttribute('aLife', this.life);
    geo.setAttribute('aColor', this.color);
    geo.setAttribute('aParams', this.params);
    geo.instanceCount = capacity;
    this.material = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { uTime: { value: 0 }, uSoft: { value: mode === 'alpha' ? 1 : 0 } }]),
      transparent: true,
      depthWrite: false,
      blending: mode === 'additive' ? THREE.AdditiveBlending : THREE.NormalBlending,
      fog: true,
    });
    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = mode === 'additive' ? 20 : 10;
  }

  emit(px: number, py: number, pz: number, vx: number, vy: number, vz: number, e: EmitParams): void {
    const i = this.head;
    this.head = (this.head + 1) % this.capacity;
    if (this.head === 0) this.wrapped = true;
    this.p0.setXYZ(i, px, py, pz);
    this.v0.setXYZ(i, vx, vy, vz);
    this.life.setXYZW(i, this.time, e.life, e.size0, e.size1);
    this.color.setXYZW(i, e.r, e.g, e.b, e.a);
    this.params.setXYZW(i, e.drag ?? 0.5, e.gravity ?? 0, e.stretch ?? 0, e.spin ?? 0);
    if (i < this.dirtyLo) this.dirtyLo = i;
    if (i > this.dirtyHi) this.dirtyHi = i;
  }

  /** Upload only the ring slots written this frame. */
  update(time: number): void {
    this.time = time;
    this.material.uniforms.uTime.value = time;
    if (this.dirtyHi < 0) return;
    const attrs = [this.p0, this.v0, this.life, this.color, this.params];
    for (const a of attrs) {
      a.clearUpdateRanges();
      if (this.wrapped) {
        // wrapped this frame: simplest correct thing is a full upload
        a.needsUpdate = true;
      } else {
        a.addUpdateRange(this.dirtyLo * a.itemSize, (this.dirtyHi - this.dirtyLo + 1) * a.itemSize);
        a.needsUpdate = true;
      }
    }
    this.dirtyLo = Infinity;
    this.dirtyHi = -1;
    this.wrapped = false;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}
