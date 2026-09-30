import * as THREE from 'three';

const VERT = /* glsl */ `
#include <common>
#include <fog_pars_vertex>
attribute float aBirth;
attribute float aAlpha;
uniform float uTime;
varying float vA;
varying float vSide;
void main() {
  float age = uTime - aBirth;
  vA = aAlpha * clamp(1.0 - age / 22.0, 0.0, 1.0);
  vSide = uv.x;
  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}`;

const FRAG = /* glsl */ `
#include <common>
#include <fog_pars_fragment>
uniform vec3 uColor;
varying float vA;
varying float vSide;
void main() {
  float edge = smoothstep(0.0, 0.25, vSide) * smoothstep(1.0, 0.75, vSide);
  float a = vA * edge;
  if (a < 0.01) discard;
  gl_FragColor = vec4(uColor, a);
  #include <fog_fragment>
}`;

/**
 * Tyre marks as a ring buffer of quads laid on the road. Each wheel keeps its
 * last point; a new segment is appended while the wheel slides.
 */
export class SkidMarks {
  readonly mesh: THREE.Mesh;
  private readonly cap: number;
  private head = 0;
  private readonly pos: THREE.BufferAttribute;
  private readonly birth: THREE.BufferAttribute;
  private readonly alpha: THREE.BufferAttribute;
  private readonly mat: THREE.ShaderMaterial;
  private readonly last = new Map<string, { p: THREE.Vector3; r: THREE.Vector3; ok: boolean }>();
  private time = 0;
  private dirty = false;

  constructor(capacity = 2400, color = new THREE.Color(0.02, 0.02, 0.025)) {
    this.cap = capacity;
    const geo = new THREE.BufferGeometry();
    this.pos = new THREE.BufferAttribute(new Float32Array(capacity * 4 * 3), 3);
    this.birth = new THREE.BufferAttribute(new Float32Array(capacity * 4).fill(-1e6), 1);
    this.alpha = new THREE.BufferAttribute(new Float32Array(capacity * 4), 1);
    const uv = new Float32Array(capacity * 4 * 2);
    const idx = new Uint32Array(capacity * 6);
    for (let i = 0; i < capacity; i++) {
      uv.set([0, 0, 1, 0, 0, 1, 1, 1], i * 8);
      const b = i * 4;
      idx.set([b, b + 1, b + 2, b + 1, b + 3, b + 2], i * 6);
    }
    for (const a of [this.pos, this.birth, this.alpha]) a.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('position', this.pos);
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    geo.setAttribute('aBirth', this.birth);
    geo.setAttribute('aAlpha', this.alpha);
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    this.mat = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { uTime: { value: 0 }, uColor: { value: color } }]),
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -4,
      fog: true,
    });
    this.mesh = new THREE.Mesh(geo, this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 3;
  }

  private tmpA = new THREE.Vector3();
  private tmpB = new THREE.Vector3();

  /**
   * Feed one wheel contact. `p` = contact point on the road (world), `right` =
   * wheel lateral axis, `on` = currently sliding, `strength` = mark darkness 0..1.
   */
  track(key: string, p: THREE.Vector3, right: THREE.Vector3, on: boolean, strength: number, width = 0.26): void {
    let st = this.last.get(key);
    if (!st) {
      st = { p: p.clone(), r: right.clone(), ok: false };
      this.last.set(key, st);
    }
    if (!on) {
      st.ok = false;
      st.p.copy(p);
      st.r.copy(right);
      return;
    }
    const dist = st.p.distanceToSquared(p);
    if (!st.ok) {
      st.ok = true;
      st.p.copy(p);
      st.r.copy(right);
      return;
    }
    if (dist < 0.6 * 0.6) return;
    if (dist > 25) {
      // teleport/respawn: restart the strip
      st.p.copy(p);
      st.r.copy(right);
      return;
    }
    const i = this.head;
    this.head = (this.head + 1) % this.cap;
    const hw = width / 2;
    const a0 = this.tmpA.copy(st.p).addScaledVector(st.r, -hw);
    const a1 = this.tmpB.copy(st.p).addScaledVector(st.r, hw);
    this.pos.setXYZ(i * 4, a0.x, a0.y, a0.z);
    this.pos.setXYZ(i * 4 + 1, a1.x, a1.y, a1.z);
    a0.copy(p).addScaledVector(right, -hw);
    a1.copy(p).addScaledVector(right, hw);
    this.pos.setXYZ(i * 4 + 2, a0.x, a0.y, a0.z);
    this.pos.setXYZ(i * 4 + 3, a1.x, a1.y, a1.z);
    for (let k = 0; k < 4; k++) {
      this.birth.setX(i * 4 + k, this.time);
      this.alpha.setX(i * 4 + k, 0.55 * strength);
    }
    st.p.copy(p);
    st.r.copy(right);
    this.dirty = true;
  }

  update(time: number): void {
    this.time = time;
    this.mat.uniforms.uTime.value = time;
    if (this.dirty) {
      this.pos.needsUpdate = true;
      this.birth.needsUpdate = true;
      this.alpha.needsUpdate = true;
      this.dirty = false;
    }
  }

  clear(): void {
    this.birth.array.fill(-1e6);
    this.birth.needsUpdate = true;
    this.last.clear();
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.mat.dispose();
  }
}
