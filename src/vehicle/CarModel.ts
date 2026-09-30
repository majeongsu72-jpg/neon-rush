import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { BodyStyle, CarSpec, PaintDef } from './specs';
import { canvasTexture, glowTexture } from '../world/textures';
import { makeCarLamps, patchCarLamps, type CarLamps } from '../world/RoadShader';

// Model space: +X right, +Y up, -Z forward. Origin = ground under the car centre.

type Keys = [number, number][];

/** Smooth (cardinal) interpolation through sorted keyframes. */
function curve(keys: Keys): (t: number) => number {
  return (t: number) => {
    if (t <= keys[0][0]) return keys[0][1];
    const n = keys.length;
    if (t >= keys[n - 1][0]) return keys[n - 1][1];
    let i = 0;
    while (i < n - 2 && t > keys[i + 1][0]) i++;
    const [t0, v0] = keys[i];
    const [t1, v1] = keys[i + 1];
    const h = t1 - t0;
    const u = (t - t0) / h;
    const tan = (k: number) => {
      const a = keys[Math.max(0, k - 1)];
      const b = keys[Math.min(n - 1, k + 1)];
      return b[0] === a[0] ? 0 : (b[1] - a[1]) / (b[0] - a[0]);
    };
    const m0 = tan(i) * h * 0.85;
    const m1 = tan(i + 1) * h * 0.85;
    const u2 = u * u, u3 = u2 * u;
    return (2 * u3 - 3 * u2 + 1) * v0 + (u3 - 2 * u2 + u) * m0 + (-2 * u3 + 3 * u2) * v1 + (u3 - u2) * m1;
  };
}

interface Shape {
  halfWidth: Keys; // fraction of width/2 along t (0 = rear, 1 = front)
  bottom: Keys; // metres
  top: Keys; // metres
  cabin: { t0: number; t1: number; roof: Keys; width: Keys; belt: number };
  roundness: number; // superellipse exponent
  wing: 'none' | 'lip' | 'duck' | 'gt' | 'active';
  scoop: boolean;
  stripes: 'twin' | 'center' | 'side' | 'none';
  rimStyle: number; // spokes
}

const SHAPES: Record<BodyStyle, Shape> = {
  gt: {
    halfWidth: [[0, 0.86], [0.06, 0.95], [0.2, 1.0], [0.5, 0.965], [0.78, 0.99], [0.93, 0.94], [1, 0.8]],
    bottom: [[0, 0.3], [0.08, 0.2], [0.5, 0.15], [0.94, 0.17], [1, 0.26]],
    top: [[0, 0.74], [0.05, 0.86], [0.2, 0.9], [0.4, 0.86], [0.62, 0.8], [0.84, 0.72], [0.96, 0.6], [1, 0.46]],
    cabin: {
      t0: 0.2, t1: 0.66,
      roof: [[0, 0.88], [0.12, 1.05], [0.34, 1.22], [0.52, 1.23], [0.66, 1.13], [0.86, 0.9], [1, 0.8]],
      width: [[0, 0.8], [0.4, 0.74], [0.8, 0.78], [1, 0.84]],
      belt: 0.84,
    },
    roundness: 3.6,
    wing: 'duck',
    scoop: false,
    stripes: 'twin',
    rimStyle: 10,
  },
  hyper: {
    halfWidth: [[0, 0.9], [0.06, 0.99], [0.25, 1.0], [0.55, 0.93], [0.8, 0.97], [0.95, 0.9], [1, 0.74]],
    bottom: [[0, 0.3], [0.07, 0.17], [0.5, 0.12], [0.95, 0.14], [1, 0.2]],
    top: [[0, 0.8], [0.06, 0.9], [0.28, 0.88], [0.44, 0.8], [0.66, 0.66], [0.86, 0.56], [0.97, 0.46], [1, 0.36]],
    cabin: {
      t0: 0.34, t1: 0.74,
      roof: [[0, 0.8], [0.2, 1.02], [0.45, 1.1], [0.62, 1.06], [0.84, 0.82], [1, 0.62]],
      width: [[0, 0.7], [0.45, 0.72], [1, 0.8]],
      belt: 0.72,
    },
    roundness: 3.1,
    wing: 'active',
    scoop: false,
    stripes: 'side',
    rimStyle: 5,
  },
  jdm: {
    halfWidth: [[0, 0.92], [0.05, 0.99], [0.25, 1.0], [0.5, 0.98], [0.8, 1.0], [0.94, 0.96], [1, 0.84]],
    bottom: [[0, 0.3], [0.06, 0.19], [0.5, 0.15], [0.95, 0.16], [1, 0.26]],
    top: [[0, 0.82], [0.05, 0.9], [0.25, 0.9], [0.4, 0.88], [0.6, 0.84], [0.85, 0.78], [0.97, 0.66], [1, 0.52]],
    cabin: {
      t0: 0.22, t1: 0.64,
      roof: [[0, 0.9], [0.14, 1.14], [0.3, 1.25], [0.6, 1.26], [0.72, 1.18], [0.9, 0.95], [1, 0.86]],
      width: [[0, 0.84], [0.5, 0.8], [1, 0.84]],
      belt: 0.86,
    },
    roundness: 4.4,
    wing: 'gt',
    scoop: false,
    stripes: 'side',
    rimStyle: 6,
  },
  muscle: {
    halfWidth: [[0, 0.92], [0.05, 0.98], [0.2, 1.0], [0.5, 0.97], [0.8, 1.0], [0.95, 0.99], [1, 0.9]],
    bottom: [[0, 0.32], [0.07, 0.2], [0.5, 0.17], [0.95, 0.2], [1, 0.3]],
    top: [[0, 0.86], [0.05, 0.95], [0.18, 0.96], [0.36, 0.94], [0.6, 0.92], [0.9, 0.9], [0.98, 0.82], [1, 0.7]],
    cabin: {
      t0: 0.16, t1: 0.54,
      roof: [[0, 0.95], [0.16, 1.12], [0.34, 1.3], [0.62, 1.31], [0.76, 1.24], [0.92, 1.0], [1, 0.93]],
      width: [[0, 0.84], [0.5, 0.78], [1, 0.84]],
      belt: 0.93,
    },
    roundness: 5.0,
    wing: 'lip',
    scoop: true,
    stripes: 'center',
    rimStyle: 5,
  },
};

// ---------------------------------------------------------------------------
// Shared materials (one set per paint; the rest shared by all cars)

let shared: {
  trim: THREE.MeshStandardMaterial;
  glass: THREE.MeshPhysicalMaterial;
  chrome: THREE.MeshStandardMaterial;
  tire: THREE.MeshStandardMaterial;
  well: THREE.MeshStandardMaterial;
  head: THREE.MeshBasicMaterial;
  glowTex: THREE.Texture;
  shadowTex: THREE.Texture;
  poolTex: THREE.Texture;
  coneTex: THREE.Texture;
} | null = null;

/** Forward headlight pool: bright near the bumper, widening and fading ahead. */
function poolTexture(): THREE.Texture {
  return canvasTexture(
    128,
    256,
    (ctx, w, h) => {
      const img = ctx.createImageData(w, h);
      for (let y = 0; y < h; y++) {
        const v = 1 - y / h; // 0 near (bottom of canvas = v 0 after flip)
        const width = 0.22 + v * 0.7;
        const along = Math.pow(1 - v, 1.1) * Math.min(1, v * 9);
        for (let x = 0; x < w; x++) {
          const u = Math.abs(x / w - 0.5) * 2;
          const across = Math.max(0, 1 - Math.pow(u / width, 2.2));
          const k = Math.min(255, along * across * 255);
          const o = (y * w + x) * 4;
          img.data[o] = img.data[o + 1] = img.data[o + 2] = k;
          img.data[o + 3] = 255;
        }
      }
      ctx.putImageData(img, 0, 0);
    },
    { repeat: false, srgb: false },
  );
}

function coneTexture(): THREE.Texture {
  return canvasTexture(
    8,
    128,
    (ctx, w, h) => {
      const g = ctx.createLinearGradient(0, 0, 0, h);
      g.addColorStop(0, '#ffffff');
      g.addColorStop(0.25, '#888888');
      g.addColorStop(1, '#000000');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);
    },
    { repeat: false, srgb: false },
  );
}

function sharedMats() {
  if (shared) return shared;
  shared = {
    trim: new THREE.MeshStandardMaterial({ color: 0x0a0b0e, roughness: 0.5, metalness: 0.35 }),
    glass: new THREE.MeshPhysicalMaterial({
      color: 0x05070b,
      metalness: 0.1,
      roughness: 0.04,
      clearcoat: 1,
      clearcoatRoughness: 0.02,
      envMapIntensity: 1.6,
    }),
    chrome: new THREE.MeshStandardMaterial({ color: 0xe6e8ee, metalness: 1, roughness: 0.16 }),
    tire: new THREE.MeshStandardMaterial({ color: 0x141416, roughness: 0.82, metalness: 0.05 }),
    well: new THREE.MeshStandardMaterial({ color: 0x050506, roughness: 0.95, metalness: 0 }),
    head: new THREE.MeshBasicMaterial({ color: new THREE.Color(5.5, 5.8, 6.4) }),
    glowTex: glowTexture(128, 1.6),
    shadowTex: glowTexture(128, 1.1),
    poolTex: poolTexture(),
    coneTex: coneTexture(),
  };
  return shared;
}

function liveryTexture(style: BodyStyle, paint: PaintDef, stripes: Shape['stripes']): THREE.Texture {
  const base = '#' + new THREE.Color(paint.color).getHexString();
  const acc = '#' + new THREE.Color(paint.accent).getHexString();
  return canvasTexture(
    128,
    512,
    (ctx, w, h) => {
      ctx.fillStyle = base;
      ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = acc;
      if (stripes === 'twin') {
        ctx.fillRect(w * 0.41, 0, w * 0.05, h);
        ctx.fillRect(w * 0.54, 0, w * 0.05, h);
      } else if (stripes === 'center') {
        ctx.fillRect(w * 0.36, 0, w * 0.1, h);
        ctx.fillRect(w * 0.54, 0, w * 0.1, h);
      } else if (stripes === 'side') {
        // diagonal side flashes near the sills (u ≈ 0 / 1 are the flanks)
        for (const x0 of [0, w * 0.93]) {
          ctx.save();
          ctx.translate(x0, 0);
          ctx.fillRect(0, h * 0.25, w * 0.07, h * 0.4);
          ctx.restore();
        }
      }
      // subtle panel sheen variation
      const g = ctx.createLinearGradient(0, 0, 0, h);
      g.addColorStop(0, 'rgba(0,0,0,0.12)');
      g.addColorStop(0.5, 'rgba(255,255,255,0.03)');
      g.addColorStop(1, 'rgba(0,0,0,0.1)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);
      void style;
    },
    { repeat: false },
  );
}

// ---------------------------------------------------------------------------
// Geometry builders

function superellipse(phi: number, n: number): [number, number] {
  const c = Math.cos(phi), s = Math.sin(phi);
  const e = 2 / n;
  return [Math.sign(c) * Math.pow(Math.abs(c), e), Math.sign(s) * Math.pow(Math.abs(s), e)];
}

interface LoftSpec {
  stations: number[]; // t values 0..1 (rear→front)
  z: (t: number) => number;
  halfWidth: (t: number) => number;
  bottom: (t: number) => number;
  top: (t: number) => number;
  tumble: (y01: number) => number; // width multiplier by relative height
  n: number;
  ring: number;
  /** Lowers the centre of the top surface (hood/deck between raised fenders). */
  dip?: (t: number) => number;
}

/** Closed loft with end caps. Returns geometry with UVs from a top projection. */
function loft(spec: LoftSpec, uvW: number, uvL: number): THREE.BufferGeometry {
  const { stations, ring } = spec;
  const pos: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  for (const t of stations) {
    const W = spec.halfWidth(t), B = spec.bottom(t), T = spec.top(t);
    const yc = (B + T) / 2, hh = Math.max(0.01, (T - B) / 2);
    const z = spec.z(t);
    const dip = spec.dip ? spec.dip(t) : 0;
    for (let k = 0; k < ring; k++) {
      const phi = (k / ring) * Math.PI * 2;
      const [sx, sy] = superellipse(phi, spec.n);
      const up = Math.max(0, sy);
      const y = yc + hh * sy - dip * (1 - sx * sx) * up * up;
      const y01 = (y - B) / Math.max(0.01, T - B);
      const x = W * sx * spec.tumble(y01);
      pos.push(x, y, z);
      uv.push(x / uvW + 0.5, z / uvL + 0.5);
    }
  }
  const S = stations.length;
  for (let i = 0; i < S - 1; i++) {
    for (let k = 0; k < ring; k++) {
      const k1 = (k + 1) % ring;
      const a = i * ring + k, b = i * ring + k1, c = (i + 1) * ring + k, d = (i + 1) * ring + k1;
      idx.push(a, c, b, c, d, b);
    }
  }
  // caps
  const capAt = (i: number, front: boolean) => {
    let cx = 0, cy = 0, cz = 0;
    for (let k = 0; k < ring; k++) {
      cx += pos[(i * ring + k) * 3];
      cy += pos[(i * ring + k) * 3 + 1];
      cz += pos[(i * ring + k) * 3 + 2];
    }
    const ci = pos.length / 3;
    pos.push(cx / ring, cy / ring, cz / ring);
    uv.push(0.5, (cz / ring) / uvL + 0.5);
    for (let k = 0; k < ring; k++) {
      const k1 = (k + 1) % ring;
      if (front) idx.push(ci, i * ring + k, i * ring + k1);
      else idx.push(ci, i * ring + k1, i * ring + k);
    }
  };
  capAt(0, false);
  capAt(S - 1, true);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

function box(w: number, h: number, d: number, x: number, y: number, z: number, rx = 0, ry = 0, rz = 0): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(w, h, d);
  if (rx || ry || rz) g.applyMatrix4(new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(rx, ry, rz)));
  g.translate(x, y, z);
  return g;
}

function stripAttrs(g: THREE.BufferGeometry): THREE.BufferGeometry {
  // keep position/normal/uv only so merges are compatible
  for (const name of Object.keys(g.attributes)) if (!['position', 'normal', 'uv'].includes(name)) g.deleteAttribute(name);
  if (!g.attributes.uv) {
    const n = g.attributes.position.count;
    g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(n * 2), 2));
  }
  return g.index ? g : g;
}

function merge(list: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const prepared = list.map((g) => stripAttrs(g.index ? g : g));
  // mergeGeometries requires all indexed or all non-indexed
  const allIndexed = prepared.every((g) => g.index);
  const final = allIndexed ? prepared : prepared.map((g) => (g.index ? g.toNonIndexed() : g));
  const m = mergeGeometries(final, false);
  if (!m) throw new Error('merge failed');
  return m;
}

function tireGeometry(r: number, w: number): THREE.BufferGeometry {
  const pts: THREE.Vector2[] = [];
  const rim = r * 0.64;
  const bev = 0.06;
  pts.push(new THREE.Vector2(rim, -w / 2));
  pts.push(new THREE.Vector2(r - bev, -w / 2));
  for (let i = 0; i <= 5; i++) {
    const a = -Math.PI / 2 + (i / 5) * (Math.PI / 2);
    pts.push(new THREE.Vector2(r - bev + Math.cos(a) * bev, -w / 2 + bev + Math.sin(a) * bev));
  }
  for (let i = 0; i <= 5; i++) {
    const a = (i / 5) * (Math.PI / 2);
    pts.push(new THREE.Vector2(r - bev + Math.cos(a) * bev, w / 2 - bev + Math.sin(a) * bev));
  }
  pts.push(new THREE.Vector2(rim, w / 2));
  const g = new THREE.LatheGeometry(pts, 28);
  g.rotateZ(Math.PI / 2); // axis along X
  return g;
}

function rimGeometry(r: number, w: number, spokes: number): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const rr = r * 0.64;
  // barrel (dish)
  const dish = new THREE.CylinderGeometry(rr, rr, w * 0.85, 24, 1, true);
  dish.rotateZ(Math.PI / 2);
  parts.push(dish);
  // outer lip ring
  const lip = new THREE.TorusGeometry(rr - 0.012, 0.018, 6, 28);
  lip.rotateY(Math.PI / 2);
  lip.translate(w * 0.4, 0, 0);
  parts.push(lip);
  // face disc slightly recessed
  const face = new THREE.CylinderGeometry(rr * 0.3, rr * 0.3, 0.04, 16);
  face.rotateZ(Math.PI / 2);
  face.translate(w * 0.36, 0, 0);
  parts.push(face);
  // spokes
  for (let i = 0; i < spokes; i++) {
    const a = (i / spokes) * Math.PI * 2;
    const sp = new THREE.BoxGeometry(0.035, rr * 0.72, spokes > 6 ? 0.035 : 0.06);
    sp.translate(0, rr * 0.5, 0);
    sp.rotateX(a);
    sp.rotateY(0);
    sp.translate(w * 0.37, 0, 0);
    parts.push(sp);
  }
  // brake disc (dark) behind spokes
  const disc = new THREE.CylinderGeometry(rr * 0.82, rr * 0.82, 0.03, 24);
  disc.rotateZ(Math.PI / 2);
  disc.translate(w * 0.05, 0, 0);
  parts.push(disc);
  return merge(parts.map((p) => p.toNonIndexed()));
}

// ---------------------------------------------------------------------------

export interface CarModel {
  root: THREE.Group;
  body: THREE.Group;
  tires: THREE.InstancedMesh;
  rims: THREE.InstancedMesh;
  wheelPos: THREE.Vector3[];
  wheelRadius: number;
  exhausts: THREE.Vector3[];
  tailLights: THREE.Vector3[];
  headLights: THREE.Vector3[];
  tailMat: THREE.MeshBasicMaterial;
  glowMat: THREE.MeshBasicMaterial;
  shadow: THREE.Mesh;
  paintMat: THREE.MeshPhysicalMaterial;
  wing: THREE.Object3D | null;
  /** Nearest trackside lamps lighting the paint (filled by the game each frame). */
  lamps: CarLamps;
  /** Headlight pool + cones (night themes). */
  beams: THREE.Group;
  dispose(): void;
}

export function buildCarModel(spec: CarSpec, paint: PaintDef, opts: { detail?: number } = {}): CarModel {
  const S = SHAPES[spec.style];
  const m = sharedMats();
  const L = spec.length;
  const Wd = spec.width;
  const halfW = Wd / 2;
  const wr = spec.wheelRadius;
  const zRear = L / 2;
  const zOf = (t: number) => zRear - t * L;
  const axleR = spec.wheelBase / 2 + (spec.style === 'hyper' ? 0.1 : 0.05);
  const axleF = -spec.wheelBase / 2 + (spec.style === 'muscle' ? -0.05 : 0.0);
  const archR = wr + 0.07;

  const hwC = curve(S.halfWidth);
  const botC = curve(S.bottom);
  const topC = curve(S.top);
  // wheel arches carve the bottom profile
  const bottom = (t: number) => {
    const z = zOf(t);
    let b = botC(t);
    for (const az of [axleR, axleF]) {
      const dz = z - az;
      if (Math.abs(dz) < archR) b = Math.max(b, wr + Math.sqrt(archR * archR - dz * dz) * 0.96);
    }
    return b;
  };

  // stations: denser near ends and around arches
  const stations: number[] = [];
  const N = opts.detail === 0 ? 40 : 72;
  for (let i = 0; i <= N; i++) {
    const u = i / N;
    stations.push(0.5 - 0.5 * Math.cos(Math.PI * u) * 0.35 + (u - 0.5) * 0.65);
  }
  stations.sort((a, b) => a - b);
  stations[0] = 0;
  stations[stations.length - 1] = 1;

  const bodyGeo = loft(
    {
      stations,
      z: zOf,
      halfWidth: (t) => hwC(t) * halfW,
      bottom,
      top: topC,
      tumble: (y) => 1 - Math.max(0, y - 0.55) * 0.18,
      n: S.roundness,
      ring: opts.detail === 0 ? 20 : 30,
      // fender bulges: hood and rear deck sit lower than the wheel arches
      dip: (t) => {
        const hood = Math.max(0, Math.min(1, (t - S.cabin.t1) / 0.08)) * Math.max(0, Math.min(1, (0.99 - t) / 0.08));
        const deck = Math.max(0, Math.min(1, (S.cabin.t0 - t) / 0.06)) * Math.max(0, Math.min(1, (t - 0.01) / 0.05));
        return (hood * 0.075 + deck * 0.045) * (spec.style === 'muscle' ? 0.6 : 1);
      },
    },
    Wd,
    L,
  );

  // Cabin
  const cab = S.cabin;
  const roofC = curve(cab.roof);
  const cwC = curve(cab.width);
  const cabStations: number[] = [];
  const CN = opts.detail === 0 ? 14 : 26;
  for (let i = 0; i <= CN; i++) cabStations.push(i / CN);
  const cabT = (u: number) => cab.t0 + (cab.t1 - cab.t0) * u;
  const cabinGeo = loft(
    {
      stations: cabStations,
      z: (u) => zOf(cabT(u)),
      halfWidth: (u) => cwC(u) * halfW,
      bottom: () => cab.belt - 0.12,
      top: (u) => Math.max(cab.belt + 0.02, roofC(u)),
      tumble: (y) => 1 - Math.max(0, y) * 0.22,
      n: 3.2,
      ring: opts.detail === 0 ? 16 : 24,
    },
    Wd,
    L,
  );
  // Split cabin into roof (paint) and glass by normal
  const roofIdx: number[] = [];
  const glassIdx: number[] = [];
  {
    const idx = cabinGeo.index!.array;
    const nrm = cabinGeo.attributes.normal;
    const p = cabinGeo.attributes.position;
    for (let i = 0; i < idx.length; i += 3) {
      const a = idx[i], b = idx[i + 1], c = idx[i + 2];
      const ny = (nrm.getY(a) + nrm.getY(b) + nrm.getY(c)) / 3;
      const y = (p.getY(a) + p.getY(b) + p.getY(c)) / 3;
      const isRoof = ny > 0.83 && y > cab.belt + 0.25;
      const isLow = y < cab.belt + 0.03;
      (isRoof || isLow ? roofIdx : glassIdx).push(a, b, c);
    }
  }
  const roofGeo = cabinGeo.clone();
  roofGeo.setIndex(roofIdx);
  const glassGeo = cabinGeo.clone();
  glassGeo.setIndex(glassIdx);

  // ---- paint parts
  const paintParts: THREE.BufferGeometry[] = [bodyGeo, roofGeo];
  // mirrors
  const mirrorT = cab.t1 - 0.05;
  const my = cab.belt + 0.08;
  for (const sx of [-1, 1]) {
    paintParts.push(box(0.2, 0.09, 0.14, sx * (cwC(0.9) * halfW + 0.12), my, zOf(mirrorT)));
  }
  if (S.scoop) paintParts.push(box(0.55, 0.1, 0.8, 0, topC(0.78) + 0.04, zOf(0.78)));

  // ---- trim parts (black)
  const trimParts: THREE.BufferGeometry[] = [];
  const frontT = 0.985;
  const yNose = topC(frontT);
  // grille / intake
  trimParts.push(box(halfW * 1.1, Math.max(0.12, yNose * 0.35), 0.06, 0, botC(0.99) + 0.14, zOf(1) + 0.03));
  // splitter
  trimParts.push(box(Wd * 0.86, 0.04, 0.3, 0, botC(1) - 0.02, zOf(0.97)));
  // side skirts
  for (const sx of [-1, 1]) trimParts.push(box(0.06, 0.1, spec.wheelBase - archR * 2 - 0.1, sx * (hwC(0.5) * halfW - 0.01), botC(0.5) + 0.05, (axleR + axleF) / 2));
  // diffuser with fins
  trimParts.push(box(Wd * 0.7, 0.14, 0.3, 0, botC(0) + 0.02, zOf(0.02)));
  for (let i = -2; i <= 2; i++) trimParts.push(box(0.025, 0.16, 0.34, i * 0.22, botC(0) + 0.04, zOf(0.03)));
  // window trim line at belt
  for (const sx of [-1, 1]) {
    trimParts.push(box(0.02, 0.025, (cab.t1 - cab.t0) * L * 0.92, sx * (cwC(0.5) * halfW * 1.02), cab.belt + 0.02, zOf((cab.t0 + cab.t1) / 2)));
  }
  // wings
  let wingObj: THREE.Object3D | null = null;
  const wingParts: THREE.BufferGeometry[] = [];
  const deckY = topC(0.06);
  if (S.wing === 'duck') {
    paintParts.push(box(Wd * 0.8, 0.05, 0.22, 0, deckY + 0.04, zOf(0.03), -0.25));
  } else if (S.wing === 'lip') {
    paintParts.push(box(Wd * 0.84, 0.04, 0.16, 0, topC(0.02) + 0.03, zOf(0.02), -0.18));
  } else if (S.wing === 'gt' || S.wing === 'active') {
    const big = S.wing === 'gt';
    const wy = deckY + (big ? 0.38 : 0.2);
    const wz = zOf(big ? 0.045 : 0.06);
    wingParts.push(box(Wd * (big ? 0.98 : 0.88), 0.035, big ? 0.34 : 0.3, 0, wy, wz, big ? 0.1 : 0.06));
    for (const sx of [-1, 1]) {
      wingParts.push(box(0.02, big ? 0.2 : 0.14, big ? 0.38 : 0.32, sx * Wd * (big ? 0.49 : 0.44), wy + 0.02, wz)); // endplates
      trimParts.push(box(0.035, wy - deckY + 0.02, 0.12, sx * Wd * 0.25, (wy + deckY) / 2, wz + 0.02)); // struts
    }
  }

  // Wheel wells (hide see-through arches)
  for (const az of [axleR, axleF]) {
    trimParts.push(box(Wd * 0.72, archR * 1.1, archR * 1.8, 0, wr + archR * 0.35, az));
  }

  const paintMat = new THREE.MeshPhysicalMaterial({
    color: 0xffffff,
    map: liveryTexture(spec.style, paint, S.stripes),
    metalness: paint.metal * 0.85,
    roughness: 0.3,
    clearcoat: 1,
    clearcoatRoughness: 0.05,
    envMapIntensity: 1.25,
  });
  const lamps = makeCarLamps();
  patchCarLamps(paintMat, lamps);
  const body = new THREE.Group();
  body.name = 'body';
  const paintMesh = new THREE.Mesh(merge(paintParts), paintMat);
  paintMesh.castShadow = true;
  body.add(paintMesh);
  const trimMesh = new THREE.Mesh(merge(trimParts), m.trim);
  trimMesh.castShadow = true;
  body.add(trimMesh);
  const glassMesh = new THREE.Mesh(glassGeo, m.glass);
  body.add(glassMesh);
  if (wingParts.length) {
    const wm = new THREE.Mesh(merge(wingParts), S.wing === 'gt' ? m.trim : paintMat);
    wm.castShadow = true;
    body.add(wm);
    wingObj = wm;
  }

  // ---- lights
  const headParts: THREE.BufferGeometry[] = [];
  const hlY = yNose + (topC(0.93) - yNose) * 0.3;
  const hlZ = zOf(0.975);
  for (const sx of [-1, 1]) {
    const x = sx * hwC(0.96) * halfW * 0.7;
    headParts.push(box(0.36, 0.05, 0.05, x, hlY, hlZ - 0.02, 0, sx * 0.25, 0));
    headParts.push(box(0.12, 0.08, 0.05, x - sx * 0.1, hlY - 0.07, hlZ - 0.01));
  }
  const headMesh = new THREE.Mesh(merge(headParts), m.head);
  body.add(headMesh);

  const tailMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(2.4, 0.08, 0.1) });
  const tailParts: THREE.BufferGeometry[] = [];
  const tlY = topC(0.02) - 0.1;
  const tlZ = zOf(0) + 0.015;
  tailParts.push(box(Wd * 0.74, 0.045, 0.04, 0, tlY, tlZ));
  for (const sx of [-1, 1]) tailParts.push(box(0.2, 0.1, 0.04, sx * Wd * 0.36, tlY - 0.03, tlZ));
  const tailMesh = new THREE.Mesh(merge(tailParts), tailMat);
  body.add(tailMesh);

  // Accent glow strips (DRL) in the glow colour
  const glowCol = new THREE.Color(paint.glow);
  const accentMat = new THREE.MeshBasicMaterial({ color: glowCol.clone().multiplyScalar(3) });
  const accentParts: THREE.BufferGeometry[] = [];
  for (const sx of [-1, 1]) {
    accentParts.push(box(0.02, 0.02, 0.9, sx * (hwC(0.85) * halfW + 0.005), hlY - 0.12, zOf(0.86)));
  }
  body.add(new THREE.Mesh(merge(accentParts), accentMat));

  // Exhausts
  const exhaustParts: THREE.BufferGeometry[] = [];
  const exhausts: THREE.Vector3[] = [];
  const exX = spec.style === 'muscle' ? [-0.62, 0.62] : spec.style === 'hyper' ? [-0.12, 0.12] : [-0.5, 0.5];
  const exY = spec.style === 'hyper' ? tlY - 0.05 : botC(0) + 0.1;
  for (const x of exX) {
    const c = new THREE.CylinderGeometry(0.055, 0.055, 0.2, 14, 1, true);
    c.rotateX(Math.PI / 2);
    c.translate(x, exY, zOf(0) - 0.05);
    exhaustParts.push(c.toNonIndexed());
    exhausts.push(new THREE.Vector3(x, exY, zOf(0) + 0.08));
  }
  body.add(new THREE.Mesh(merge(exhaustParts), m.chrome));

  // ---- root, wheels, underglow, shadow
  const root = new THREE.Group();
  root.name = `car-${spec.id}`;
  root.add(body);

  const tireGeo = tireGeometry(wr, 0.3);
  const rimGeo = rimGeometry(wr, 0.3, S.rimStyle);
  const rimMat = new THREE.MeshStandardMaterial({
    color: paint.metal > 0.6 ? 0x2a2c30 : 0xc9ccd4,
    metalness: 0.95,
    roughness: 0.3,
  });
  const tires = new THREE.InstancedMesh(tireGeo, m.tire, 4);
  const rims = new THREE.InstancedMesh(rimGeo, rimMat, 4);
  tires.castShadow = true;
  tires.frustumCulled = false;
  rims.frustumCulled = false;
  root.add(tires, rims);
  const tx = spec.track / 2;
  const wheelPos = [
    new THREE.Vector3(-tx, wr, axleF),
    new THREE.Vector3(tx, wr, axleF),
    new THREE.Vector3(-tx, wr, axleR),
    new THREE.Vector3(tx, wr, axleR),
  ];

  const glowMat = new THREE.MeshBasicMaterial({
    map: m.glowTex,
    color: glowCol.clone().multiplyScalar(1.2),
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const glow = new THREE.Mesh(new THREE.PlaneGeometry(Wd * 2.1, L * 1.35), glowMat);
  glow.rotation.x = -Math.PI / 2;
  glow.position.y = 0.03;
  glow.renderOrder = 2;
  root.add(glow);

  const shadowMat = new THREE.MeshBasicMaterial({
    map: m.shadowTex,
    color: 0x000000,
    transparent: true,
    opacity: 0.75,
    depthWrite: false,
    blending: THREE.NormalBlending,
  });
  // alphaMap from the glow texture gives a soft blob
  shadowMat.alphaMap = m.shadowTex;
  shadowMat.map = null;
  const shadow = new THREE.Mesh(new THREE.PlaneGeometry(Wd * 1.45, L * 1.12), shadowMat);
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.y = 0.02;
  shadow.renderOrder = 1;

  // Headlights at night: a projected pool on the road + faint volumetric cones.
  const beams = new THREE.Group();
  beams.name = 'beams';
  const poolMat = new THREE.MeshBasicMaterial({
    map: m.poolTex,
    color: new THREE.Color(0.9, 0.92, 1.0).multiplyScalar(0.4),
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const pool = new THREE.Mesh(new THREE.PlaneGeometry(9, 26), poolMat);
  pool.rotation.x = -Math.PI / 2;
  pool.position.set(0, 0.045, zOf(1) - 12.5);
  pool.renderOrder = 2;
  beams.add(pool);
  const coneMat = new THREE.MeshBasicMaterial({
    map: m.coneTex,
    color: new THREE.Color(0.8, 0.85, 1.0).multiplyScalar(0.06),
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const coneGeo = new THREE.CylinderGeometry(0.12, 2.6, 16, 16, 1, true);
  coneGeo.rotateX(-Math.PI / 2 + 0.04); // point forward (-Z), slightly down
  coneGeo.translate(0, -0.35, -8);
  for (const sx of [-1, 1]) {
    const cone = new THREE.Mesh(coneGeo, coneMat);
    cone.position.set(sx * hwC(0.96) * halfW * 0.7, hlY, hlZ);
    cone.renderOrder = 25;
    beams.add(cone);
  }
  root.add(beams);
  root.add(shadow);

  const tailLights = [new THREE.Vector3(-Wd * 0.36, tlY, tlZ), new THREE.Vector3(Wd * 0.36, tlY, tlZ)];
  const headLights = [new THREE.Vector3(-hwC(0.96) * halfW * 0.7, hlY, hlZ), new THREE.Vector3(hwC(0.96) * halfW * 0.7, hlY, hlZ)];

  const model: CarModel = {
    root,
    body,
    tires,
    rims,
    wheelPos,
    wheelRadius: wr,
    exhausts,
    tailLights,
    headLights,
    tailMat,
    glowMat,
    shadow,
    paintMat,
    wing: wingObj,
    lamps,
    beams,
    dispose() {
      poolMat.dispose();
      coneMat.dispose();
      root.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (mesh.geometry) mesh.geometry.dispose();
      });
      paintMat.map?.dispose();
      paintMat.dispose();
      tailMat.dispose();
      glowMat.dispose();
      accentMat.dispose();
      rimMat.dispose();
      shadowMat.dispose();
    },
  };
  setWheelPose(model, 0, 0, 0);
  return model;
}

/**
 * Bake a procedural car into three static geometries for instancing
 * (traffic): painted body, dark parts (trim/glass/wheels), and lights with
 * HDR vertex colours. Model space as usual (-Z forward, y up).
 */
export function bakeCarGeometries(spec: CarSpec, paint: PaintDef): { body: THREE.BufferGeometry; dark: THREE.BufferGeometry; lights: THREE.BufferGeometry } {
  const model = buildCarModel(spec, paint, { detail: 0 });
  const root = model.root;
  root.matrixAutoUpdate = true;
  root.position.set(0, 0, 0);
  root.quaternion.identity();
  root.updateMatrixWorld(true);
  const body: THREE.BufferGeometry[] = [];
  const dark: THREE.BufferGeometry[] = [];
  const lightPos: number[] = [];
  const lightCol: number[] = [];
  const take = (g: THREE.BufferGeometry, m: THREE.Matrix4) => {
    const c = g.clone().applyMatrix4(m);
    return stripAttrs(c.index ? c.toNonIndexed() : c);
  };
  const addLights = (g: THREE.BufferGeometry, m: THREE.Matrix4, col: [number, number, number]) => {
    const c = g.clone().applyMatrix4(m);
    const nonIdx = c.index ? c.toNonIndexed() : c;
    const p = nonIdx.attributes.position;
    for (let i = 0; i < p.count; i++) {
      lightPos.push(p.getX(i), p.getY(i), p.getZ(i));
      lightCol.push(col[0], col[1], col[2]);
    }
  };
  const shared = sharedMats();
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    if ((mesh as THREE.InstancedMesh).isInstancedMesh) {
      const im = mesh as THREE.InstancedMesh;
      const mm = new THREE.Matrix4();
      for (let i = 0; i < im.count; i++) {
        im.getMatrixAt(i, mm);
        dark.push(take(im.geometry, mm.clone().premultiply(im.matrixWorld)));
      }
      return;
    }
    const mat = mesh.material as THREE.Material;
    if (mat === model.paintMat) body.push(take(mesh.geometry, mesh.matrixWorld));
    else if (mat === shared.head) addLights(mesh.geometry, mesh.matrixWorld, [5, 5, 4.5]);
    else if (mat === model.tailMat) addLights(mesh.geometry, mesh.matrixWorld, [3.2, 0.1, 0.12]);
    else if (mat === shared.trim || mat === shared.glass || mat === shared.chrome) dark.push(take(mesh.geometry, mesh.matrixWorld));
  });
  const lights = new THREE.BufferGeometry();
  lights.setAttribute('position', new THREE.Float32BufferAttribute(lightPos, 3));
  lights.setAttribute('color', new THREE.Float32BufferAttribute(lightCol, 3));
  const out = { body: mergeGeometries(body, false)!, dark: mergeGeometries(dark, false)!, lights };
  model.dispose();
  return out;
}

const wm = new THREE.Matrix4();
const wq = new THREE.Quaternion();
const we = new THREE.Euler();
const ws = new THREE.Vector3(1, 1, 1);
const wp = new THREE.Vector3();

/** Update instanced wheel transforms: spin angle (rad), steer angle (rad), per-wheel suspension offset. */
export function setWheelPose(model: CarModel, spin: number, steer: number, bounce: number, compress?: number[]): void {
  for (let i = 0; i < 4; i++) {
    const p = model.wheelPos[i];
    const left = p.x < 0;
    const front = i < 2;
    we.set(spin, front ? steer : 0, 0, 'YXZ');
    wq.setFromEuler(we);
    if (left) {
      // mirror so the rim face points outward
      const flip = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI);
      wq.multiply(flip);
    }
    wp.set(p.x, p.y + bounce + (compress ? compress[i] : 0), p.z);
    wm.compose(wp, wq, ws);
    model.tires.setMatrixAt(i, wm);
    model.rims.setMatrixAt(i, wm);
  }
  model.tires.instanceMatrix.needsUpdate = true;
  model.rims.instanceMatrix.needsUpdate = true;
}
