import * as THREE from 'three';

const VERT = /* glsl */ `
#include <common>
#include <fog_pars_vertex>
attribute vec4 aCol;
varying vec4 vCol;
varying float vV;
void main() {
  vCol = aCol;
  vV = uv.y;
  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}`;

const FRAG = /* glsl */ `
#include <common>
#include <fog_pars_fragment>
varying vec4 vCol;
varying float vV;
void main() {
  // (clamped: vV overshoots [0,1] by an ulp at the edges, and pow(<0) is NaN → black seams)
  float core = clamp(1.0 - abs(vV * 2.0 - 1.0), 0.0, 1.0);
  float a = vCol.a * pow(core, 1.6);
  if (a < 0.004) discard;
  gl_FragColor = vec4(vCol.rgb * (0.6 + 0.8 * core), a);
  #include <fog_fragment>
}`;

interface Trail {
  pts: THREE.Vector3[];
  n: number;
  color: THREE.Color;
  width: number;
  intensity: number;
  /** Id of the car that lays this trail (its own body never cuts it). */
  owner: number;
}

/** Floats per occluder: centre xyz, forward xyz, half length, radius², owner. */
const OCC = 9;

/**
 * Long-exposure style light ribbons behind tail lights. Each trail keeps a
 * short history of points spaced ~1.2 m apart; the ribbon faces the camera.
 */
export class LightTrails {
  readonly mesh: THREE.Mesh;
  private readonly K: number;
  private readonly maxTrails: number;
  private readonly trails = new Map<string, Trail>();
  private readonly pos: THREE.BufferAttribute;
  private readonly col: THREE.BufferAttribute;
  private readonly geo: THREE.BufferGeometry;
  private readonly mat: THREE.ShaderMaterial;
  private tmp = new THREE.Vector3();
  private dir = new THREE.Vector3();
  private side = new THREE.Vector3();
  private view = new THREE.Vector3();
  private occ = new Float32Array(64 * OCC);
  private occN = 0;

  constructor(maxTrails = 40, points = 28) {
    this.K = points;
    this.maxTrails = maxTrails;
    const verts = maxTrails * points * 2;
    this.geo = new THREE.BufferGeometry();
    this.pos = new THREE.BufferAttribute(new Float32Array(verts * 3), 3);
    this.col = new THREE.BufferAttribute(new Float32Array(verts * 4), 4);
    this.pos.setUsage(THREE.DynamicDrawUsage);
    this.col.setUsage(THREE.DynamicDrawUsage);
    const uv = new Float32Array(verts * 2);
    const idx: number[] = [];
    for (let t = 0; t < maxTrails; t++) {
      for (let i = 0; i < points; i++) {
        const v = (t * points + i) * 2;
        uv[v * 2] = i / (points - 1);
        uv[v * 2 + 1] = 0;
        uv[v * 2 + 2] = i / (points - 1);
        uv[v * 2 + 3] = 1;
        if (i < points - 1) idx.push(v, v + 1, v + 2, v + 1, v + 3, v + 2);
      }
    }
    this.geo.setAttribute('position', this.pos);
    this.geo.setAttribute('aCol', this.col);
    this.geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    this.geo.setIndex(idx);
    this.geo.setDrawRange(0, 0);
    this.mat = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog]),
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      fog: true,
    });
    this.mesh = new THREE.Mesh(this.geo, this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 15;
  }

  /** Push the current light position for trail `key`; returns false if the pool is full. */
  feed(key: string, p: THREE.Vector3, color: THREE.Color, intensity: number, width = 0.16, owner = -1): boolean {
    let tr = this.trails.get(key);
    if (!tr) {
      if (this.trails.size >= this.maxTrails) return false;
      tr = { pts: [], n: 0, color: color.clone(), width, intensity, owner };
      for (let i = 0; i < this.K; i++) tr.pts.push(p.clone());
      this.trails.set(key, tr);
    }
    tr.intensity = intensity;
    tr.width = width;
    tr.color.copy(color);
    // pts[0] is the live head; history shifts when the head moved far enough
    const head = tr.pts[0];
    const d2 = head.distanceToSquared(tr.pts[1]);
    if (d2 > 1.4 * 1.4) {
      if (d2 > 60 * 60) {
        for (const q of tr.pts) q.copy(p); // teleport
      } else {
        const last = tr.pts.pop()!;
        last.copy(head);
        tr.pts.splice(1, 0, last);
        tr.n = Math.min(this.K, tr.n + 1);
      }
    }
    head.copy(p);
    return true;
  }

  /**
   * Cars the trails must not run through: a trail laid by the car ahead stops
   * at the nose of the car following in it instead of piercing its body.
   * Call clearOccluders() then addOccluder() for each car, once per frame.
   */
  clearOccluders(): void {
    this.occN = 0;
  }

  addOccluder(center: THREE.Vector3, forward: THREE.Vector3, halfLength: number, radius: number, owner: number): void {
    if (this.occN * OCC >= this.occ.length) return;
    const o = this.occ, k = this.occN++ * OCC;
    o[k] = center.x; o[k + 1] = center.y; o[k + 2] = center.z;
    o[k + 3] = forward.x; o[k + 4] = forward.y; o[k + 5] = forward.z;
    o[k + 6] = halfLength; o[k + 7] = radius * radius; o[k + 8] = owner;
  }

  /** Index of the first history point that lies inside another car (K if none). */
  private cutIndex(tr: Trail): number {
    const o = this.occ;
    for (let i = 1; i < tr.n; i++) {
      const p = tr.pts[i];
      for (let j = 0; j < this.occN; j++) {
        const k = j * OCC;
        if (o[k + 8] === tr.owner) continue;
        const dx = p.x - o[k], dy = p.y - o[k + 1], dz = p.z - o[k + 2];
        let t = dx * o[k + 3] + dy * o[k + 4] + dz * o[k + 5];
        const hl = o[k + 6];
        if (t > hl) t = hl;
        else if (t < -hl) t = -hl;
        const ex = dx - o[k + 3] * t, ey = dy - o[k + 4] * t, ez = dz - o[k + 5] * t;
        if (ex * ex + ey * ey + ez * ez < o[k + 7]) return i;
      }
    }
    return this.K;
  }

  remove(key: string): void {
    this.trails.delete(key);
  }

  clear(): void {
    this.trails.clear();
  }

  update(camera: THREE.Camera): void {
    let t = 0;
    const P = this.pos.array as Float32Array;
    const C = this.col.array as Float32Array;
    const cam = camera.position;
    for (const tr of this.trails.values()) {
      if (tr.intensity <= 0.01) continue;
      const base = t * this.K * 2;
      const cut = this.occN > 0 ? this.cutIndex(tr) : this.K;
      for (let i = 0; i < this.K; i++) {
        const a = tr.pts[Math.min(i, this.K - 1)];
        const b = tr.pts[Math.min(i + 1, this.K - 1)];
        this.dir.copy(a).sub(b);
        if (this.dir.lengthSq() < 1e-6) this.dir.set(0, 0, 1);
        this.dir.normalize();
        this.view.copy(cam).sub(a).normalize();
        this.side.crossVectors(this.dir, this.view);
        if (this.side.lengthSq() < 1e-6) this.side.set(1, 0, 0);
        this.side.normalize().multiplyScalar(tr.width);
        const v = (base + i * 2) * 3;
        this.tmp.copy(a).add(this.side);
        P[v] = this.tmp.x; P[v + 1] = this.tmp.y; P[v + 2] = this.tmp.z;
        this.tmp.copy(a).sub(this.side);
        P[v + 3] = this.tmp.x; P[v + 4] = this.tmp.y; P[v + 5] = this.tmp.z;
        const fade = i >= tr.n || i >= cut ? 0 : Math.pow(1 - i / this.K, 1.4) * tr.intensity;
        const c = (base + i * 2) * 4;
        C[c] = tr.color.r; C[c + 1] = tr.color.g; C[c + 2] = tr.color.b; C[c + 3] = fade;
        C[c + 4] = tr.color.r; C[c + 5] = tr.color.g; C[c + 6] = tr.color.b; C[c + 7] = fade;
      }
      t++;
      if (t >= this.maxTrails) break;
    }
    this.pos.needsUpdate = true;
    this.col.needsUpdate = true;
    this.geo.setDrawRange(0, t * (this.K - 1) * 6);
  }

  dispose(): void {
    this.geo.dispose();
    this.mat.dispose();
  }
}
