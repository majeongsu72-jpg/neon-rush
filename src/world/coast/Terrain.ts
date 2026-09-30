import * as THREE from 'three';
import type { GroundSample, Island } from './Island';
import { clamp, fbm2, smoothstep } from '../../core/math';

/**
 * Island terrain mesh: square tiles whose vertex spacing depends on their
 * distance to the road (fine where the car is, coarse in the hinterland),
 * skirts to hide LOD cracks, merged into large blocks so the whole island is
 * a handful of draw calls that still frustum-cull.
 */
export interface TerrainOptions {
  tile: number;
  spacingNear: number;
  spacingMid: number;
  spacingFar: number;
  /** Tiles are merged into blocks of this size (m) — one draw call each. */
  block: number;
  skirt: number;
}

export interface TerrainGeometry {
  geometries: THREE.BufferGeometry[];
  triangles: number;
}

// Linear albedos (golden-hour palette; the sun and haze do the rest).
const SAND = [0.56, 0.4, 0.24];
const SAND_WET = [0.24, 0.15, 0.09];
const GRASS_DRY = [0.25, 0.19, 0.065];
const GRASS_GREEN = [0.085, 0.12, 0.045];
const SCRUB = [0.055, 0.06, 0.035];
const ROCK = [0.21, 0.15, 0.115];
const ROCK_DARK = [0.085, 0.065, 0.06];
const SHOULDER = [0.26, 0.2, 0.15];

/** Visual height: the seabed drops quickly below the waterline so the sea plane never z-fights it. */
export function displayHeight(h: number): number {
  return h < 0 ? h - 2.2 * smoothstep(0, 1.2, -h) : h;
}

interface Block {
  pos: number[];
  nrm: number[];
  col: number[];
  idx: number[];
}

export async function buildTerrainGeometry(
  isl: Island,
  o: TerrainOptions,
  yieldFn?: () => Promise<void>,
): Promise<TerrainGeometry> {
  const tilesX = Math.ceil((isl.x1 - isl.x0) / o.tile);
  const tilesZ = Math.ceil((isl.z1 - isl.z0) / o.tile);
  const blocks = new Map<string, Block>();
  const smp: GroundSample = { h: 0, natural: 0, s: 0, d: 0, dist: 0, road: 0, rock: 0, lagoon: 0 };
  let triangles = 0;
  let processed = 0;

  for (let tj = 0; tj < tilesZ; tj++) {
    for (let ti = 0; ti < tilesX; ti++) {
      const tx0 = isl.x0 + ti * o.tile;
      const tz0 = isl.z0 + tj * o.tile;
      const md = isl.minRoadDist(tx0 - 12, tz0 - 12, tx0 + o.tile + 12, tz0 + o.tile + 12);
      const G = md < 75 ? o.spacingNear : md < 330 ? o.spacingMid : o.spacingFar;
      const n = Math.max(2, Math.round(o.tile / G));
      const g = o.tile / n;
      const W = n + 3; // one extra ring for central-difference normals
      const H = new Float32Array(W * W);
      const V = n + 1;
      const rock = new Float32Array(V * V);
      const road = new Float32Array(V * V);
      const trueH = new Float32Array(V * V);
      let maxH = -Infinity;
      for (let j = -1; j <= n + 1; j++) {
        for (let i = -1; i <= n + 1; i++) {
          const x = tx0 + i * g, z = tz0 + j * g;
          const inner = i >= 0 && j >= 0 && i <= n && j <= n;
          let h: number;
          if (inner) {
            isl.sample(x, z, smp);
            h = smp.h;
            const k = j * V + i;
            rock[k] = smp.rock;
            road[k] = smp.road;
            trueH[k] = h;
            if (h > maxH) maxH = h;
          } else {
            h = isl.heightAt(x, z);
          }
          H[(j + 1) * W + (i + 1)] = displayHeight(h);
        }
      }
      processed++;
      if (yieldFn && processed % 12 === 0) await yieldFn();
      if (maxH < -2.5) continue; // open water: the sea covers it

      const bkey = `${Math.floor((tx0 - isl.x0) / o.block)},${Math.floor((tz0 - isl.z0) / o.block)}`;
      let b = blocks.get(bkey);
      if (!b) blocks.set(bkey, (b = { pos: [], nrm: [], col: [], idx: [] }));
      const base = b.pos.length / 3;

      // vertices
      const nrmTmp = new THREE.Vector3();
      const vNx = new Float32Array(V * V), vNy = new Float32Array(V * V), vNz = new Float32Array(V * V);
      for (let j = 0; j <= n; j++) {
        for (let i = 0; i <= n; i++) {
          const k = j * V + i;
          const hc = H[(j + 1) * W + (i + 1)];
          const hl = H[(j + 1) * W + i], hr = H[(j + 1) * W + i + 2];
          const hu = H[j * W + (i + 1)], hd = H[(j + 2) * W + (i + 1)];
          nrmTmp.set((hl - hr) / (2 * g), 1, (hu - hd) / (2 * g)).normalize();
          vNx[k] = nrmTmp.x; vNy[k] = nrmTmp.y; vNz[k] = nrmTmp.z;
          const x = tx0 + i * g, z = tz0 + j * g;
          b.pos.push(x, hc, z);
          b.nrm.push(nrmTmp.x, nrmTmp.y, nrmTmp.z);
          terrainColor(x, z, trueH[k], nrmTmp.y, rock[k], road[k], b.col);
        }
      }
      // triangles (diagonal a–d), dropping the ones inside tunnel mouths
      const nearPortal = isl.portals.some((p) => p.x > tx0 - 80 && p.x < tx0 + o.tile + 80 && p.z > tz0 - 80 && p.z < tz0 + o.tile + 80);
      for (let j = 0; j < n; j++) {
        for (let i = 0; i < n; i++) {
          const a = base + j * V + i, bb = a + 1, c = a + V, d = c + 1;
          const t1Skip = nearPortal && isl.inPortalMouth(tx0 + (i + 2 / 3) * g, tz0 + (j + 1 / 3) * g, 1.5 * g, 2.5 * g);
          const t2Skip = nearPortal && isl.inPortalMouth(tx0 + (i + 1 / 3) * g, tz0 + (j + 2 / 3) * g, 1.5 * g, 2.5 * g);
          if (!t1Skip) b.idx.push(a, d, bb);
          if (!t2Skip) b.idx.push(a, c, d);
          triangles += (t1Skip ? 0 : 1) + (t2Skip ? 0 : 1);
        }
      }
      // skirts along the four edges (both windings: they only plug LOD cracks)
      const edge = (k0: number, step: number) => {
        const sBase = b.pos.length / 3;
        for (let m = 0; m <= n; m++) {
          const k = k0 + m * step;
          const vi = (base + k) * 3;
          b.pos.push(b.pos[vi], b.pos[vi + 1] - o.skirt, b.pos[vi + 2]);
          b.nrm.push(vNx[k], vNy[k], vNz[k]);
          b.col.push(b.col[vi], b.col[vi + 1], b.col[vi + 2]);
        }
        for (let m = 0; m < n; m++) {
          const top0 = base + k0 + m * step, top1 = base + k0 + (m + 1) * step;
          const bot0 = sBase + m, bot1 = sBase + m + 1;
          b.idx.push(top0, bot0, top1, top1, bot0, bot1);
          b.idx.push(top0, top1, bot0, top1, bot1, bot0);
          triangles += 4;
        }
      };
      edge(0, 1); // north
      edge(n * V, 1); // south
      edge(0, V); // west
      edge(n, V); // east
    }
  }

  const geometries: THREE.BufferGeometry[] = [];
  for (const b of blocks.values()) {
    if (!b.idx.length) continue;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(b.pos, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(b.nrm, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(b.col, 3));
    const vCount = b.pos.length / 3;
    geo.setIndex(vCount > 65535 ? new THREE.Uint32BufferAttribute(b.idx, 1) : new THREE.Uint16BufferAttribute(b.idx, 1));
    geo.computeBoundingSphere();
    geo.computeBoundingBox();
    geometries.push(geo);
  }
  return { geometries, triangles };
}

/** Vertex albedo from height, slope, rockiness and the road corridor. */
function terrainColor(x: number, z: number, h: number, ny: number, rock: number, road: number, out: number[]): void {
  const slope = Math.sqrt(Math.max(0, 1 - ny * ny)) / Math.max(ny, 0.05);
  const n1 = fbm2(x / 38, z / 38, 3, 71);
  const n2 = fbm2(x / 9, z / 9, 2, 73);
  // grass: dry gold with greener hollows and dark scrub patches
  const green = smoothstep(-0.25, 0.35, n1);
  let r = GRASS_DRY[0] + (GRASS_GREEN[0] - GRASS_DRY[0]) * green;
  let g = GRASS_DRY[1] + (GRASS_GREEN[1] - GRASS_DRY[1]) * green;
  let b = GRASS_DRY[2] + (GRASS_GREEN[2] - GRASS_DRY[2]) * green;
  const scrub = smoothstep(0.1, 0.45, n2) * 0.6 * smoothstep(4, 12, h);
  r += (SCRUB[0] - r) * scrub; g += (SCRUB[1] - g) * scrub; b += (SCRUB[2] - b) * scrub;
  // sand: beaches, lagoon shores, dunes (low and flat)
  const sand = smoothstep(4.2 + 1.2 * n1, 2.4, h) * (1 - smoothstep(0.35, 0.6, slope));
  r += (SAND[0] - r) * sand; g += (SAND[1] - g) * sand; b += (SAND[2] - b) * sand;
  const wet = smoothstep(0.55, 0.05, h);
  r += (SAND_WET[0] - r) * wet; g += (SAND_WET[1] - g) * wet; b += (SAND_WET[2] - b) * wet;
  // rock: steep faces, cliffs and the lighthouse point
  const rk = clamp(Math.max(smoothstep(0.62, 1.05, slope), rock * smoothstep(0.15, 0.5, slope + 0.25 * rock)), 0, 1);
  const dark = smoothstep(-0.2, 0.5, n2) * 0.7;
  const rr = ROCK[0] + (ROCK_DARK[0] - ROCK[0]) * dark;
  const rg = ROCK[1] + (ROCK_DARK[1] - ROCK[1]) * dark;
  const rb = ROCK[2] + (ROCK_DARK[2] - ROCK[2]) * dark;
  r += (rr - r) * rk; g += (rg - g) * rk; b += (rb - b) * rk;
  // dusty gravel shoulder along the road
  const sh = smoothstep(0.55, 0.95, road) * 0.85;
  r += (SHOULDER[0] - r) * sh; g += (SHOULDER[1] - g) * sh; b += (SHOULDER[2] - b) * sh;
  out.push(r, g, b);
}

const TERRAIN_VERT_PARS = /* glsl */ `
varying vec2 vTerrXZ;
`;
const TERRAIN_FRAG_PARS = /* glsl */ `
varying vec2 vTerrXZ;
uniform sampler2D uTerrDetail;
`;
const TERRAIN_DETAIL = /* glsl */ `
{
  float dt1 = texture2D( uTerrDetail, vTerrXZ * ( 1.0 / 11.0 ) ).r;
  float dt2 = texture2D( uTerrDetail, vTerrXZ * ( 1.0 / 67.0 ) + 0.37 ).r;
  diffuseColor.rgb *= ( 0.62 + 0.75 * dt1 ) * ( 0.76 + 0.48 * dt2 );
}
`;

/** Terrain material: vertex albedo × two octaves of world-space detail noise. */
export function makeTerrainMaterial(detail: THREE.Texture): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.93, metalness: 0, envMapIntensity: 0.5 });
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTerrDetail = { value: detail };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${TERRAIN_VERT_PARS}`)
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvTerrXZ = position.xz;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${TERRAIN_FRAG_PARS}`)
      .replace('#include <color_fragment>', `#include <color_fragment>\n${TERRAIN_DETAIL}`);
  };
  mat.customProgramCacheKey = () => 'coastTerrain';
  return mat;
}
