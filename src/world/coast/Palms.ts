import * as THREE from 'three';
import type { Track } from '../../track/Track';
import type { Island } from './Island';
import type { Rng } from '../../core/rng';
import { smoothstep } from '../../core/math';

/**
 * Procedural coconut palm: a curved, ringed trunk and a crown of drooping
 * serrated fronds, merged into one geometry (one draw call per chunk) with an
 * `aLeaf` attribute so only the fronds get the backlit translucency glow.
 * Model space: base at the origin (trunk buried 1.4 m), bend toward +X.
 */
export function buildPalmGeometry(rng: Rng): THREE.BufferGeometry {
  const pos: number[] = [];
  const col: number[] = [];
  const leaf: number[] = [];
  const idx: number[] = [];

  // ---- trunk
  const RINGS = 12, SIDES = 7, HT = 10.6, BEND = 1.7, BASE = -1.4;
  const trunkTop = new THREE.Vector3();
  for (let r = 0; r <= RINGS; r++) {
    const t = r / RINGS;
    const cx = BEND * Math.pow(t, 1.8), cy = BASE + t * HT;
    const tx = BEND * 1.8 * Math.pow(Math.max(t, 1e-3), 0.8), ty = HT;
    const tl = Math.hypot(tx, ty);
    const nx = ty / tl, ny = -tx / tl; // in-plane normal
    let rad = 0.3 * (1 - 0.42 * t) + 0.17 * (1 - smoothstep(0.08, 0.2, t));
    rad *= r % 2 ? 1.07 : 0.96;
    const shade = r % 2 ? 1 : 0.72;
    for (let s = 0; s <= SIDES; s++) {
      const th = (s / SIDES) * Math.PI * 2;
      const c = Math.cos(th), sn = Math.sin(th);
      pos.push(cx + nx * c * rad, cy + ny * c * rad, sn * rad);
      col.push(0.2 * shade, 0.15 * shade, 0.11 * shade);
      leaf.push(0);
    }
    if (r === RINGS) trunkTop.set(cx, cy, 0);
  }
  for (let r = 0; r < RINGS; r++) {
    for (let s = 0; s < SIDES; s++) {
      const a = r * (SIDES + 1) + s, b = a + 1, c = a + SIDES + 1, d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
  }

  // ---- coconuts under the crown
  const nut = new THREE.IcosahedronGeometry(0.19, 0);
  const np = nut.getAttribute('position');
  for (let k = 0; k < 3; k++) {
    const ang = (k / 3) * Math.PI * 2 + 0.4;
    const ox = trunkTop.x + Math.cos(ang) * 0.24, oy = trunkTop.y - 0.35 - (k % 2) * 0.12, oz = Math.sin(ang) * 0.24;
    const base = pos.length / 3;
    for (let i = 0; i < np.count; i++) {
      pos.push(np.getX(i) + ox, np.getY(i) + oy, np.getZ(i) + oz);
      col.push(0.14, 0.12, 0.04);
      leaf.push(0);
    }
    for (let i = 0; i < np.count; i += 3) idx.push(base + i, base + i + 1, base + i + 2);
  }
  nut.dispose();

  // ---- fronds
  const FRONDS = 9, SEG = 10;
  const up = new THREE.Vector3(0, 1, 0);
  const dir = new THREE.Vector3(), side = new THREE.Vector3(), fold = new THREE.Vector3(), p = new THREE.Vector3();
  for (let f = 0; f < FRONDS; f++) {
    const dead = f === 3 || f === 7;
    const phi = (f / FRONDS) * Math.PI * 2 + rng.range(-0.25, 0.25);
    const el0 = dead ? rng.range(-0.9, -0.5) : rng.range(0.2, 0.75);
    const droop = dead ? rng.range(0.5, 0.8) : rng.range(1.35, 2.05);
    const len = dead ? rng.range(3.2, 3.8) : rng.range(4.3, 5.4);
    const wMax = dead ? 0.45 : rng.range(0.8, 1.0);
    p.copy(trunkTop).add(new THREE.Vector3(0, 0.12, 0));
    const base = pos.length / 3;
    for (let k = 0; k <= SEG; k++) {
      const t = k / SEG;
      const el = el0 - droop * Math.pow(t, 1.6);
      dir.set(Math.cos(el) * Math.cos(phi), Math.sin(el), Math.cos(el) * Math.sin(phi));
      if (k > 0) p.addScaledVector(dir, len / SEG);
      side.crossVectors(dir, up);
      if (side.lengthSq() < 1e-6) side.set(1, 0, 0);
      side.normalize();
      fold.crossVectors(side, dir).normalize(); // "up" across the frond
      const serr = k % 2 ? 1 : 0.58;
      const w = wMax * Math.pow(Math.sin(Math.PI * Math.min(1, t * 1.12 + 0.04)), 0.65) * serr;
      const g = dead ? [0.17, 0.1, 0.045] : [0.03 + 0.05 * t, 0.065 + 0.05 * t, 0.018 + 0.012 * t];
      // left edge, rachis, right edge — leaflets droop in a V along the rachis
      for (const sd of [-1, 0, 1]) {
        const off = sd === 0 ? 0 : w;
        const x = p.x + side.x * sd * off - fold.x * off * 0.5;
        const y = p.y + side.y * sd * off - fold.y * off * 0.5;
        const z = p.z + side.z * sd * off - fold.z * off * 0.5;
        pos.push(x, y, z);
        const sh = sd === 0 ? 0.7 : 1;
        col.push(g[0] * sh, g[1] * sh, g[2] * sh);
        leaf.push(dead ? 0.35 : 1);
      }
    }
    for (let k = 0; k < SEG; k++) {
      const a = base + k * 3;
      const L0 = a, C0 = a + 1, R0 = a + 2, L1 = a + 3, C1 = a + 4, R1 = a + 5;
      idx.push(L0, C0, L1, C0, C1, L1, C0, R0, C1, R0, R1, C1);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  geo.setAttribute('aLeaf', new THREE.Float32BufferAttribute(leaf, 1));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  return geo;
}

/**
 * Foliage material: vertex colours, double-sided, and light transmitted
 * through thin leaves when the low sun is behind them (golden rim glow).
 */
export function makeFoliageMaterial(sunDir: THREE.Vector3, transmit: THREE.Color): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({
    vertexColors: true,
    side: THREE.DoubleSide,
    roughness: 0.78,
    metalness: 0,
    envMapIntensity: 0.6,
  });
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uLeafSun = { value: sunDir };
    shader.uniforms.uLeafTransmit = { value: transmit };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aLeaf;\nvarying float vLeaf;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvLeaf = aLeaf;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vLeaf;\nuniform vec3 uLeafSun;\nuniform vec3 uLeafTransmit;')
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
{
  vec3 viewToFrag = normalize( ( vec4( - vViewPosition, 0.0 ) * viewMatrix ).xyz );
  float back = pow( max( dot( viewToFrag, normalize( uLeafSun ) ), 0.0 ), 4.0 );
  totalEmissiveRadiance += diffuseColor.rgb * uLeafTransmit * back * vLeaf;
}`,
      );
  };
  mat.customProgramCacheKey = () => 'coastFoliage';
  return mat;
}

export interface PalmPlacement {
  matrices: THREE.Matrix4[];
  passables: number[];
}

/**
 * Palms along the low beachfront road (both sides, irregular rhythm for speed
 * cues), groves inland of the boulevard and along the lagoon shore.
 */
export function placePalms(track: Track, isl: Island, rng: Rng, density: number): PalmPlacement {
  const matrices: THREE.Matrix4[] = [];
  const passables: number[] = [];
  const tunnel = track.sectionsOf('tunnel')[0];
  const bridge = track.sectionsOf('bridge')[0];
  const lh = isl.lighthouse;
  const q = new THREE.Quaternion(), q2 = new THREE.Quaternion();
  const Y = new THREE.Vector3(0, 1, 0);
  const tilt = new THREE.Vector3();
  const add = (x: number, z: number, yaw: number, scale: number): boolean => {
    const h = isl.heightAt(x, z);
    if (h < 0.7 || h > 9) return false;
    if (Math.hypot(x - lh.x, z - lh.z) < 30) return false;
    q.setFromAxisAngle(Y, yaw);
    // a little random lean on top of the modelled bend
    tilt.set(rng.range(-1, 1), 0, rng.range(-1, 1)).normalize();
    q2.setFromAxisAngle(tilt, rng.range(0, 0.1));
    q.premultiply(q2);
    matrices.push(new THREE.Matrix4().compose(new THREE.Vector3(x, h, z), q, new THREE.Vector3(scale, scale, scale)));
    return true;
  };

  const L = track.length;
  for (const sideSign of [-1, 1]) {
    let s = rng.range(0, 20);
    while (s < L) {
      const step = rng.range(19, 33) / density;
      s += step;
      const y = track.lerp(track.py, s);
      if (y > 4.2) continue;
      if (tunnel && track.inRange(s, tunnel.s0 - 20, tunnel.s1 + 20)) continue;
      if (bridge && track.inRange(s, bridge.s0 - 20, bridge.s1 + 20)) continue;
      const hw = track.halfWidthAt(s);
      const off = hw + rng.range(3.2, 8.5);
      const rx = track.lerp(track.rx, s), rz = track.lerp(track.rz, s);
      const rl = Math.hypot(rx, rz) || 1;
      const x = track.lerp(track.px, s) + (rx / rl) * off * sideSign;
      const z = track.lerp(track.pz, s) + (rz / rl) * off * sideSign;
      // bend leans away from the road (seaward on the beach side)
      const out = Math.atan2(-(rz / rl) * sideSign, (rx / rl) * sideSign);
      if (add(x, z, out + rng.range(-0.6, 0.6), rng.range(0.82, 1.22))) passables.push(track.wrap(s));
      // occasional pair behind the first row
      if (rng.chance(0.22 * density)) {
        const off2 = off + rng.range(6, 16);
        add(
          track.lerp(track.px, s) + (rx / rl) * off2 * sideSign + rng.range(-4, 4),
          track.lerp(track.pz, s) + (rz / rl) * off2 * sideSign + rng.range(-4, 4),
          rng.range(0, Math.PI * 2),
          rng.range(0.75, 1.15),
        );
      }
    }
  }
  // groves on sandy/grassy low ground and around the lagoon
  const tries = Math.round(900 * density);
  for (let i = 0; i < tries; i++) {
    const x = rng.range(isl.x0, isl.x1), z = rng.range(isl.z0, isl.z1);
    const lag = isl.lagoonDist(x, z);
    const h = isl.heightAt(x, z);
    const nearLagoon = lag > 4 && lag < 45;
    const lowland = h > 0.8 && h < 4.5;
    if (!(nearLagoon || (lowland && rng.chance(0.35)))) continue;
    // keep the corridor clear
    const smp = isl.sample(x, z, { h: 0, natural: 0, s: 0, d: 0, dist: 0, road: 0, rock: 0, lagoon: 0 });
    if (smp.dist < track.halfWidthAt(smp.s) + 12) continue;
    add(x, z, rng.range(0, Math.PI * 2), rng.range(0.7, 1.2));
  }
  passables.sort((a, b) => a - b);
  return { matrices, passables };
}
