import * as THREE from 'three';

const VERT = /* glsl */ `
#include <common>
#include <fog_pars_vertex>
attribute vec4 aSeed; // xyz offset in [0,1), w random
uniform vec3 uCamPos;
uniform vec3 uCamVel;
uniform vec3 uBox;
uniform vec3 uFall;
uniform float uTime;
uniform float uLen;
uniform float uWidth;
uniform float uAmount;
varying float vA;
varying float vAlong;
void main() {
  vAlong = position.y;
  if (aSeed.w > uAmount) { gl_Position = vec4(0.0, 0.0, 2.0, 1.0); vA = 0.0; return; }
  vec3 p = aSeed.xyz * uBox + uFall * uTime * (0.75 + 0.5 * aSeed.w);
  vec3 rel = mod(p - uCamPos + uBox * 0.5, uBox) - uBox * 0.5;
  vec3 head = uCamPos + rel;
  vec3 v = uFall * (0.75 + 0.5 * aSeed.w) - uCamVel;
  float speed = length(v);
  vec3 tail = head - v * uLen - normalize(v + vec3(1e-4)) * 0.05;
  vec4 h = viewMatrix * vec4(head, 1.0);
  vec4 t = viewMatrix * vec4(tail, 1.0);
  vec4 mvPosition = mix(h, t, position.y);
  vec2 dir = t.xy / max(-t.z, 0.1) - h.xy / max(-h.z, 0.1);
  float l = length(dir);
  vec2 perp = l > 1e-5 ? vec2(-dir.y, dir.x) / l : vec2(1.0, 0.0);
  mvPosition.xy += perp * position.x * uWidth;
  gl_Position = projectionMatrix * mvPosition;
  float dist = length(rel);
  vA = smoothstep(0.6, 2.5, dist) * smoothstep(uBox.x * 0.5, uBox.x * 0.25, dist) * clamp(speed / 6.0, 0.25, 1.0);
  #include <fog_vertex>
}`;

const FRAG = /* glsl */ `
#include <common>
#include <fog_pars_fragment>
uniform vec3 uColor;
uniform float uOpacity;
varying float vA;
varying float vAlong;
void main() {
  float a = vA * uOpacity * (1.0 - vAlong * 0.85);
  if (a < 0.003) discard;
  gl_FragColor = vec4(uColor, a);
  #include <fog_fragment>
}`;

export interface WeatherParams {
  count: number;
  box: [number, number, number];
  fall: [number, number, number]; // m/s
  color: THREE.Color; // HDR ok
  opacity: number;
  width: number; // metres (view space)
  len: number; // exposure seconds: streak length = |relative velocity| × len
}

/**
 * Stateless camera-local precipitation / air motes. Each drop lives in a box
 * that wraps around the camera; its streak follows the velocity relative to
 * the camera, so at 300 km/h the rain lances straight at the lens.
 */
export class Weather {
  readonly mesh: THREE.Mesh;
  private readonly mat: THREE.ShaderMaterial;
  amount = 1;

  constructor(p: WeatherParams, seed = 1) {
    const geo = new THREE.InstancedBufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute([-1, 0, 0, 1, 0, 0, 1, 1, 0, -1, 1, 0], 3));
    geo.setIndex([0, 1, 2, 0, 2, 3]);
    const seeds = new Float32Array(p.count * 4);
    let s = seed * 9301 + 49297;
    const rnd = () => {
      s = (s * 9301 + 49297) % 233280;
      return s / 233280;
    };
    for (let i = 0; i < p.count * 4; i++) seeds[i] = rnd();
    geo.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seeds, 4));
    geo.instanceCount = p.count;
    this.mat = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: THREE.UniformsUtils.merge([
        THREE.UniformsLib.fog,
        {
          uCamPos: { value: new THREE.Vector3() },
          uCamVel: { value: new THREE.Vector3() },
          uBox: { value: new THREE.Vector3(...p.box) },
          uFall: { value: new THREE.Vector3(...p.fall) },
          uTime: { value: 0 },
          uLen: { value: p.len },
          uWidth: { value: p.width },
          uAmount: { value: 1 },
          uColor: { value: p.color },
          uOpacity: { value: p.opacity },
        },
      ]),
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      fog: true,
    });
    this.mesh = new THREE.Mesh(geo, this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 30;
  }

  update(time: number, camPos: THREE.Vector3, camVel: THREE.Vector3): void {
    const u = this.mat.uniforms;
    u.uTime.value = time;
    u.uCamPos.value.copy(camPos);
    u.uCamVel.value.copy(camVel);
    u.uAmount.value = this.amount;
    this.mesh.visible = this.amount > 0.01;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.mat.dispose();
  }
}
