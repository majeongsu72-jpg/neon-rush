import * as THREE from 'three';
import type { Track } from '../../track/Track';
import type { Rng } from '../../core/rng';
import { CLOCK_WRAP, GLSL_COMMON, PAL, fogUniforms, type GridUniforms } from './common';

const VERT = /* glsl */ `
attribute vec3 aBary;
attribute vec4 aSpin; // axis (unit), angular rate (rad/s)
attribute vec3 aColor;
uniform float uClock;
varying vec3 vBary;
varying vec3 vN;
varying vec3 vView;
varying vec3 vColor;
#include <fog_pars_vertex>
vec3 gRot(vec3 p, vec3 a, float ang) {
  float c = cos(ang), s = sin(ang);
  return p * c + cross(a, p) * s + a * dot(a, p) * (1.0 - c);
}
void main() {
  float ang = uClock * aSpin.w;
  vec3 p = gRot(position, aSpin.xyz, ang);
  vec3 n = gRot(normal, aSpin.xyz, ang);
  mat4 mw = modelMatrix * instanceMatrix;
  vec4 wp = mw * vec4(p, 1.0);
  vN = normalize(mat3(mw) * n);
  vView = cameraPosition - wp.xyz;
  vBary = aBary;
  vColor = aColor;
  vec4 mvPosition = viewMatrix * wp;
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}
`;

/** Near-black glossy faces, pixel-crisp neon edges with a soft bloom skirt, fresnel sheen. */
const FRAG = /* glsl */ `
uniform float uPulse;
varying vec3 vBary;
varying vec3 vN;
varying vec3 vView;
varying vec3 vColor;
#include <fog_pars_fragment>
${GLSL_COMMON}
void main() {
  float e = min(min(vBary.x, vBary.y), vBary.z);
  float fw = max(fwidth(e), 1e-5);
  float edge = 1.0 - smoothstep(fw * 0.8, fw * 2.2, e);
  float skirt = exp(-e / (fw * 7.0)) * 0.3;
  vec3 N = normalize(vN);
  vec3 V = normalize(vView);
  float fres = pow(max(1.0 - abs(dot(N, V)), 0.0), 3.0);
  vec3 col = vec3(0.01, 0.008, 0.022) + vColor * fres * 0.22;
  col += vColor * (edge * 2.8 + skirt) * (1.0 + 1.3 * uPulse);
  gl_FragColor = vec4(col, 1.0);
  #include <fog_fragment>
}
`;

/**
 * Non-indexed copy with barycentric coordinates for edge drawing. Edges shared
 * by two coplanar triangles (quad diagonals, fan centres) are hidden by
 * lifting that barycentric component for the whole triangle.
 */
function withBarycentrics(src: THREE.BufferGeometry): THREE.BufferGeometry {
  const g = src.index ? src.toNonIndexed() : src.clone();
  g.deleteAttribute('uv');
  g.deleteAttribute('normal');
  g.computeVertexNormals();
  const pos = g.getAttribute('position');
  const tris = pos.count / 3;
  const v = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
  const normals: THREE.Vector3[] = [];
  const key = (i: number) => `${pos.getX(i).toFixed(3)},${pos.getY(i).toFixed(3)},${pos.getZ(i).toFixed(3)}`;
  const edgeKey = (a: number, b: number) => {
    const ka = key(a), kb = key(b);
    return ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
  };
  const edges = new Map<string, number[]>();
  for (let t = 0; t < tris; t++) {
    for (let k = 0; k < 3; k++) v[k].fromBufferAttribute(pos, t * 3 + k);
    normals.push(new THREE.Vector3().subVectors(v[1], v[0]).cross(new THREE.Vector3().subVectors(v[2], v[0])).normalize());
    for (let k = 0; k < 3; k++) {
      const ek = edgeKey(t * 3 + k, t * 3 + ((k + 1) % 3));
      let arr = edges.get(ek);
      if (!arr) edges.set(ek, (arr = []));
      arr.push(t);
    }
  }
  const bary = new Float32Array(pos.count * 3);
  for (let t = 0; t < tris; t++) {
    // edge (k, k+1) is opposite vertex k+2
    const lift = [0, 0, 0];
    for (let k = 0; k < 3; k++) {
      const ek = edgeKey(t * 3 + k, t * 3 + ((k + 1) % 3));
      const other = (edges.get(ek) ?? []).find((o) => o !== t);
      if (other !== undefined && normals[other].dot(normals[t]) > 0.999) lift[(k + 2) % 3] = 1;
    }
    for (let k = 0; k < 3; k++) {
      for (let c = 0; c < 3; c++) bary[(t * 3 + k) * 3 + c] = (c === k ? 1 : 0) + lift[c];
    }
  }
  g.setAttribute('aBary', new THREE.BufferAttribute(bary, 3));
  return g;
}

interface Item {
  matrix: THREE.Matrix4;
  spin: [number, number, number, number];
  color: THREE.Color;
}

export interface Monoliths {
  meshes: THREE.InstancedMesh[];
  disposables: { dispose(): void }[];
}

/**
 * Monoliths, octahedra, pyramids and tetrahedra drifting in the void: a near
 * field beside the circuit (parallax that sells the speed), a sparse far field
 * of giants, and one colossal octahedron — the core — at `core`.
 */
export function buildMonoliths(
  track: Track,
  U: GridUniforms,
  rng: Rng,
  density: number,
  core: { center: THREE.Vector3; radius: number },
): Monoliths {
  const b = track.bounds();
  const cx = (b.minX + b.maxX) / 2, cz = (b.minZ + b.maxZ) / 2;
  const span = Math.max(b.maxX - b.minX, b.maxZ - b.minZ) / 2 + 1300;
  const near = { dist: 0, i: 0, y: 0 };
  const shapes: THREE.BufferGeometry[] = [
    new THREE.BoxGeometry(4, 9, 1), // 1:4:9 monolith
    new THREE.OctahedronGeometry(1, 0),
    new THREE.ConeGeometry(1, 1.5, 4, 1),
    new THREE.TetrahedronGeometry(1, 0),
  ];
  const lists: Item[][] = shapes.map(() => []);
  const palette = [PAL.cyan, PAL.magenta, PAL.violet, PAL.cyan];
  const count = Math.round(170 * density);
  const nearCount = Math.round(count * 0.55);
  const up = new THREE.Vector3(0, 1, 0);
  // the core: one colossal octahedron in the infield
  lists[1].push({
    matrix: new THREE.Matrix4().compose(core.center, new THREE.Quaternion(), new THREE.Vector3(core.radius, core.radius * 1.25, core.radius)),
    spin: [0, 1, 0, (2 * Math.PI * 4) / CLOCK_WRAP],
    color: PAL.cyan.clone().multiplyScalar(1.4),
  });
  let tries = 0;
  let placed = 0;
  while (placed < count && tries++ < count * 25) {
    const nearField = placed < nearCount;
    let x: number, z: number;
    if (nearField) {
      const i = rng.int(0, track.N - 1);
      const a = rng.range(0, Math.PI * 2), r = rng.range(140, 650);
      x = track.px[i] + Math.cos(a) * r;
      z = track.pz[i] + Math.sin(a) * r;
    } else {
      x = cx + rng.range(-span, span);
      z = cz + rng.range(-span, span);
    }
    const type = rng.int(0, 3);
    const size = type === 0 ? (nearField ? rng.range(3, 9) : rng.range(6, 18)) : nearField ? rng.range(8, 28) : rng.range(18, 55);
    const extent = type === 0 ? size * 5 : size * 1.6;
    track.nearest(x, z, 220, near);
    if (near.i >= 0 && near.dist < 110 + extent) continue;
    if (Math.hypot(x - core.center.x, z - core.center.z) < core.radius * 3 + extent) continue;
    const y = type === 0 ? rng.range(40, 260) : rng.range(25, 330);
    const q = new THREE.Quaternion().setFromAxisAngle(up, rng.range(0, Math.PI * 2));
    if (type === 2 && rng.chance(0.4)) q.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI));
    const matrix = new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), q, new THREE.Vector3(size, size, size));
    // spin rates are whole turns per CLOCK_WRAP so the clock wrap is seamless
    const turns = type === 0 ? rng.int(1, 3) : rng.int(2, 9);
    const rate = ((rng.chance(0.5) ? 1 : -1) * turns * Math.PI * 2) / CLOCK_WRAP;
    const axis = type === 0 ? up.clone() : new THREE.Vector3(rng.range(-0.4, 0.4), 1, rng.range(-0.4, 0.4)).normalize();
    const color = palette[rng.int(0, palette.length - 1)].clone().multiplyScalar(rng.range(0.8, 1.2));
    lists[type].push({ matrix, spin: [axis.x, axis.y, axis.z, rate], color });
    placed++;
  }

  const mat = new THREE.ShaderMaterial({
    vertexShader: VERT,
    fragmentShader: FRAG,
    uniforms: { ...fogUniforms(), uClock: U.uClock, uPulse: U.uPulse },
    fog: true,
  });
  const disposables: { dispose(): void }[] = [mat];
  const meshes: THREE.InstancedMesh[] = [];
  shapes.forEach((shape, type) => {
    const items = lists[type];
    const g = withBarycentrics(shape);
    shape.dispose();
    disposables.push(g);
    if (!items.length) return;
    g.setAttribute('aSpin', new THREE.InstancedBufferAttribute(new Float32Array(items.flatMap((it) => it.spin)), 4));
    g.setAttribute('aColor', new THREE.InstancedBufferAttribute(new Float32Array(items.flatMap((it) => [it.color.r, it.color.g, it.color.b])), 3));
    const im = new THREE.InstancedMesh(g, mat, items.length);
    im.name = 'gridMonoliths';
    items.forEach((it, i) => im.setMatrixAt(i, it.matrix));
    im.instanceMatrix.needsUpdate = true;
    im.computeBoundingSphere();
    meshes.push(im);
  });
  return { meshes, disposables };
}
