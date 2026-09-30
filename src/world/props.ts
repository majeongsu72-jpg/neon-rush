import * as THREE from 'three';
import type { Track } from '../track/Track';
import { makeFrame } from '../track/Track';

export interface Placement {
  s: number;
  d: number;
  h?: number;
  /** Extra yaw (rad) around the up axis. */
  yaw?: number;
  scale?: [number, number, number];
  color?: THREE.Color;
  /** Keep world-up (true) or follow road bank/slope (false). */
  upright?: boolean;
}

const fr = makeFrame();
const m = new THREE.Matrix4();
const q = new THREE.Quaternion();
const q2 = new THREE.Quaternion();
const p = new THREE.Vector3();
const sc = new THREE.Vector3();
const X = new THREE.Vector3(), Y = new THREE.Vector3(), Z = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);

/** Transform for a prop standing at road coordinate (s, d). */
export function placementMatrix(track: Track, pl: Placement, out: THREE.Matrix4): THREE.Matrix4 {
  track.surface(pl.s, pl.d, fr);
  p.copy(fr.pos).addScaledVector(fr.U, pl.h ?? 0);
  if (pl.upright !== false) {
    // forward = road tangent flattened; up = world Y
    Z.copy(fr.T).setY(0);
    if (Z.lengthSq() < 1e-6) Z.set(0, 0, -1);
    Z.normalize().negate(); // model forward is -Z
    Y.copy(UP);
    X.crossVectors(Y, Z).normalize();
  } else {
    Z.copy(fr.T).negate();
    Y.copy(fr.U);
    X.crossVectors(Y, Z).normalize();
  }
  m.makeBasis(X, Y, Z);
  q.setFromRotationMatrix(m);
  if (pl.yaw) {
    q2.setFromAxisAngle(UP, pl.yaw);
    q.multiply(q2);
  }
  const s = pl.scale ?? [1, 1, 1];
  sc.set(s[0], s[1], s[2]);
  return out.compose(p, q, sc);
}

/** InstancedMeshes chunked along the track so frustum culling works. */
export function instanceAlongTrack(
  track: Track,
  geo: THREE.BufferGeometry,
  mat: THREE.Material,
  placements: Placement[],
  opts: { chunk?: number; castShadow?: boolean; name?: string } = {},
): THREE.InstancedMesh[] {
  const chunk = opts.chunk ?? 400;
  const buckets = new Map<number, Placement[]>();
  for (const pl of placements) {
    const k = Math.floor(track.wrap(pl.s) / chunk);
    let arr = buckets.get(k);
    if (!arr) buckets.set(k, (arr = []));
    arr.push(pl);
  }
  const out: THREE.InstancedMesh[] = [];
  const tm = new THREE.Matrix4();
  for (const arr of buckets.values()) {
    const im = new THREE.InstancedMesh(geo, mat, arr.length);
    im.name = opts.name ?? 'props';
    const hasColor = arr.some((a) => a.color);
    arr.forEach((pl, i) => {
      im.setMatrixAt(i, placementMatrix(track, pl, tm));
      if (hasColor) im.setColorAt(i, pl.color ?? new THREE.Color(1, 1, 1));
    });
    im.instanceMatrix.needsUpdate = true;
    if (im.instanceColor) im.instanceColor.needsUpdate = true;
    im.computeBoundingSphere();
    im.castShadow = !!opts.castShadow;
    im.receiveShadow = false;
    out.push(im);
  }
  return out;
}

/** InstancedMeshes from world matrices, bucketed into XZ tiles for culling. */
export function instanceWorld(
  geo: THREE.BufferGeometry,
  mat: THREE.Material,
  items: { matrix: THREE.Matrix4; color?: THREE.Color }[],
  tile = 400,
  name = 'world-props',
): THREE.InstancedMesh[] {
  const buckets = new Map<string, typeof items>();
  const v = new THREE.Vector3();
  for (const it of items) {
    v.setFromMatrixPosition(it.matrix);
    const key = `${Math.floor(v.x / tile)},${Math.floor(v.z / tile)}`;
    let arr = buckets.get(key);
    if (!arr) buckets.set(key, (arr = []));
    arr.push(it);
  }
  const out: THREE.InstancedMesh[] = [];
  for (const arr of buckets.values()) {
    const im = new THREE.InstancedMesh(geo, mat, arr.length);
    im.name = name;
    const hasColor = arr.some((a) => a.color);
    arr.forEach((it, i) => {
      im.setMatrixAt(i, it.matrix);
      if (hasColor) im.setColorAt(i, it.color ?? new THREE.Color(1, 1, 1));
    });
    im.instanceMatrix.needsUpdate = true;
    if (im.instanceColor) im.instanceColor.needsUpdate = true;
    im.computeBoundingSphere();
    out.push(im);
  }
  return out;
}

/** Merge a list of (geometry, matrix) pairs into one non-indexed geometry. */
export function bakeGeometry(parts: { geo: THREE.BufferGeometry; matrix?: THREE.Matrix4 }[]): THREE.BufferGeometry {
  const pos: number[] = [];
  const nrm: number[] = [];
  const uv: number[] = [];
  const nm = new THREE.Matrix3();
  const v = new THREE.Vector3();
  for (const part of parts) {
    const g = part.geo.index ? part.geo.toNonIndexed() : part.geo;
    const P = g.attributes.position;
    const Nn = g.attributes.normal;
    const U = g.attributes.uv;
    const mat = part.matrix ?? new THREE.Matrix4();
    nm.getNormalMatrix(mat);
    for (let i = 0; i < P.count; i++) {
      v.fromBufferAttribute(P, i).applyMatrix4(mat);
      pos.push(v.x, v.y, v.z);
      if (Nn) {
        v.fromBufferAttribute(Nn, i).applyMatrix3(nm).normalize();
        nrm.push(v.x, v.y, v.z);
      } else nrm.push(0, 1, 0);
      if (U) uv.push(U.getX(i), U.getY(i));
      else uv.push(0, 0);
    }
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  out.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  out.computeBoundingSphere();
  return out;
}
