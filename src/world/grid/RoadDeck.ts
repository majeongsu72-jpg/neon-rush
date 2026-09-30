import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { Track } from '../../track/Track';
import { sweep, mirrorProfile, type ProfilePoint } from '../../track/TrackMesh';
import { instanceAlongTrack, type Placement } from '../props';
import { gridSlot, GRID_SIZE } from '../../race/grid';
import { GLSL_COMMON, GLSL_FOG_FADE, PAL, cornerStrength, fogUniforms, type GridUniforms } from './common';

/** Cross-section, measured outward from the road edge (|d| = halfWidth). */
export const DECK = {
  railIn: 0.3, // rail inner face (the road surface runs up to it)
  railOut: 0.75,
  railTop: 0.32,
  wallD: 0.52, // energy barrier plane (centre of the rail)
  wallH: 1.75,
};

const MAX_PADS = 8;

const ROAD_VERT_PARS = /* glsl */ `
attribute vec4 aRoad;
attribute float aHw;
varying vec4 vRoad;
varying float vHw;
`;

const ROAD_FRAG_PARS = /* glsl */ `
varying vec4 vRoad;
varying float vHw;
uniform float uClock;
uniform float uPulse;
uniform float uBeatAge;
uniform float uBeatS;
uniform float uLen;
uniform vec4 uPads[${MAX_PADS}];
uniform int uPadCount;
uniform vec2 uSlots[${GRID_SIZE}];
${GLSL_COMMON}
`;

/** Analytic road surface: hex panels, edge lines, lanes, chevrons, pads, start line, beat wave. */
const ROAD_FRAG = /* glsl */ `
{
  float rs = vRoad.x;
  float rd = vRoad.y;
  float hw = vHw;
  float ad = abs(rd);
  // pixel footprints, taken here in uniform control flow for the branches below
  float fs = fwidth(rs);
  float fd = fwidth(rd);
  vec3 sideCol = rd >= 0.0 ? G_CYAN : G_MAGENTA;
  float kick = uPulse;
  // light wave that races down the road ahead of the camera on every kick
  float wv = gWrap(rs - uBeatS - 14.0 - uBeatAge * 260.0, uLen);
  float wave = exp(-wv * wv * 0.015) * exp(-uBeatAge * 1.3);

  // glossy hex panels (2.4 m) with faint violet seams; detail fades out before it can shimmer
  vec4 hx = gHex(vec2(rd, rs) * (1.0 / 2.4));
  float hd = 0.5 - gHexDist(hx.xy);
  float hfw = max(fwidth(hd), 1e-5);
  float fine = 1.0 - smoothstep(0.025, 0.07, hfw);
  float seam = clamp((0.03 - hd) / hfw + 0.5, 0.0, 1.0) * fine;
  float rnd = gHash21(hx.zw);
  diffuseColor.rgb *= mix(1.0, 0.7 + 0.6 * rnd, fine);
  roughnessFactor = mix(roughnessFactor, 0.14 + 0.28 * rnd, fine);
  roughnessFactor = mix(roughnessFactor, 0.9, seam);
  float blink = step(0.955, rnd) * (0.5 + 0.5 * sin(uClock * (2.0 + 5.0 * rnd) + 60.0 * rnd));
  vec3 em = G_VIOLET * seam * (0.14 + 0.25 * kick + 0.9 * wave);
  em += mix(G_CYAN, G_MAGENTA, step(0.5, fract(rnd * 7.0))) * blink * fine * 0.3 * (1.0 - smoothstep(hw - 2.4, hw - 1.2, ad));

  // bright edge line + fine inner line (cyan right, magenta left)
  float e1 = gLine(ad - (hw - 0.42), 0.1);
  float e2 = gLine(ad - (hw - 0.85), 0.035);
  em += sideCol * (e1 * (3.4 + 2.2 * kick + 3.0 * wave) + e2 * (1.1 + 1.6 * wave));

  // lane dashes at ±hw/3, strobing on the kick
  float lane = gLine(ad - hw / 3.0, 0.06) * gBand(rs / 9.0, 0.45);
  em += vec3(0.55, 0.6, 1.0) * lane * (0.6 + 1.2 * kick + 1.5 * wave);

  // centre chevrons flowing forward
  float chev = gBand((rs + ad * 0.3) / 8.0 - uClock * 2.5, 0.16) * (1.0 - smoothstep(1.3, 1.8, ad));
  em += G_CYAN * chev * (0.8 + 1.8 * kick + 2.5 * wave);

  // start / finish chequer + grid boxes
  float sl = gWrap(rs, uLen);
  if (abs(sl) < 1.6) {
    float ch = mod(floor(sl / 0.8 + 8.0) + floor(rd / 0.8 + 40.0), 2.0);
    float band = 1.0 - smoothstep(1.2, 1.4, abs(sl));
    diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.75 * ch), band);
    em += vec3(0.9, 0.95, 1.0) * ch * band * 1.3;
  }
  if (sl > -72.0 && sl < 0.0) {
    for (int i = 0; i < ${GRID_SIZE}; i++) {
      vec2 q = vec2(sl - uSlots[i].x, rd - uSlots[i].y);
      float bar = gBoxW(q, vec2(0.14, 1.3), vec2(fs, fd));
      float legs = gBoxW(vec2(q.x + 0.75, abs(q.y) - 1.3), vec2(0.75, 0.06), vec2(fs, fd));
      em += vec3(0.75, 0.85, 1.0) * max(bar, legs) * 1.6;
    }
  }

  // boost pads: amber frame, fast chevrons
  for (int i = 0; i < ${MAX_PADS}; i++) {
    if (i >= uPadCount) break;
    vec4 P = uPads[i]; // s0, length, d, halfWidth
    float ls = rs - P.x;
    ls -= uLen * floor(ls / uLen);
    float ld = rd - P.z;
    if (ls < P.y + 0.8 && abs(ld) < P.w + 0.8) {
      vec2 q = vec2(ls - 0.5 * P.y, ld);
      vec2 fq = vec2(fs, fd);
      float inside = gBoxW(q, vec2(0.5 * P.y, P.w), fq);
      float frame = inside - gBoxW(q, vec2(0.5 * P.y - 0.22, P.w - 0.22), fq);
      float arrows = gBandW((ls + abs(ld) * 0.85) / 3.0 - uClock * 3.0, 0.4, (fs + 0.85 * fd) / 3.0) * gBoxW(q, vec2(0.5 * P.y - 0.6, P.w - 0.5), fq);
      diffuseColor.rgb *= 1.0 - 0.8 * inside;
      em += G_AMBER * (inside * (0.9 + 0.8 * kick) + frame * 5.0) + mix(G_AMBER, vec3(1.0, 0.95, 0.75), 0.6) * arrows * (6.5 + 3.0 * kick);
    }
  }
  totalEmissiveRadiance += em;
}
`;

const HULL_VERT_PARS = /* glsl */ `
attribute vec4 aRoad;
attribute vec3 aFeat;
varying vec4 vRoad;
varying vec3 vFeat;
`;

const HULL_FRAG_PARS = /* glsl */ `
varying vec4 vRoad;
varying vec3 vFeat;
uniform float uClock;
uniform float uPulse;
uniform float uBeatAge;
uniform float uBeatS;
uniform float uLen;
${GLSL_COMMON}
`;

/** Floating deck body: solid glowing rails, running underglow, violet keel strip. */
const HULL_FRAG = /* glsl */ `
{
  float rs = vRoad.x;
  vec3 sideCol = vRoad.y >= 0.0 ? G_CYAN : G_MAGENTA;
  float wv = gWrap(rs - uBeatS - 14.0 - uBeatAge * 260.0, uLen);
  float wave = exp(-wv * wv * 0.015) * exp(-uBeatAge * 1.3);
  float run = gBand(rs / 16.0 - uClock * 4.0, 0.28);
  float seg = gBand(rs / 4.0, 0.9);
  vec3 em = sideCol * vFeat.r * (2.4 + 1.6 * uPulse + 3.0 * wave) * mix(0.5, 1.0, seg);
  em += sideCol * vFeat.g * (0.9 + 2.8 * run + 1.2 * uPulse);
  em += G_VIOLET * vFeat.b * (0.5 + 2.2 * gBand(rs / 24.0 + uClock * 2.0, 0.18));
  float panel = gLineW(gWrap(rs, 6.0), 0.03, fwidth(rs));
  diffuseColor.rgb *= 1.0 - 0.6 * panel * (1.0 - max(vFeat.r, max(vFeat.g, vFeat.b)));
  totalEmissiveRadiance += em;
}
`;

const WALL_VERT = /* glsl */ `
attribute vec4 aRoad;
varying vec4 vRoad;
#include <fog_pars_vertex>
void main() {
  vRoad = aRoad;
  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}
`;

/** Translucent energy barrier: hex mesh, rising scanlines, hot top edge, corner chevrons. */
const WALL_FRAG = /* glsl */ `
uniform float uClock;
uniform float uPulse;
uniform float uBeatAge;
uniform float uBeatS;
uniform float uLen;
uniform float uBase;
uniform float uHeight;
varying vec4 vRoad;
#include <fog_pars_fragment>
${GLSL_COMMON}
void main() {
  float rs = vRoad.x;
  float rd = vRoad.y;
  float v = clamp((vRoad.z - uBase) / uHeight, 0.0, 1.0);
  float zone = vRoad.w;
  vec3 sideCol = rd >= 0.0 ? G_CYAN : G_MAGENTA;
  float wv = gWrap(rs - uBeatS - 14.0 - uBeatAge * 260.0, uLen);
  float wave = exp(-wv * wv * 0.015) * exp(-uBeatAge * 1.3);

  vec4 hx = gHex(vec2(rs, vRoad.z) * (1.0 / 0.9));
  float hd = 0.5 - gHexDist(hx.xy);
  float hfw = max(fwidth(hd), 1e-5);
  float fine = 1.0 - smoothstep(0.05, 0.16, hfw);
  float mesh = clamp((0.045 - hd) / hfw + 0.5, 0.0, 1.0);
  float cellLit = step(0.86, gHash21(hx.zw + floor(uClock * 2.0)));
  float scan = gBand(vRoad.z / 0.25 - uClock * 1.5, 0.3);
  float body = 0.05 + 0.11 * mesh + 0.05 * scan + 0.12 * cellLit * (1.0 - 2.0 * hd);
  body = mix(0.075, body, fine);
  body *= 1.0 - 0.55 * v;
  float topCore = gLine((1.0 - v) * uHeight - 0.04, 0.035);
  float topGlow = exp(-(1.0 - v) * uHeight * 7.0);
  float baseGlow = exp(-v * uHeight * 9.0);
  float I = body + topGlow * 0.55 + topCore * 3.2 + baseGlow * 0.35;

  // chevrons on the outside barrier of corners, pointing (and flowing) the way the road bends
  float outer = clamp(-zone * sign(rd), 0.0, 1.0);
  float cx = (rs + abs(v - 0.5) * 1.8) / 3.6 - uClock * 4.0;
  float chev = gBand(cx, 0.32) * smoothstep(0.0, 0.18, v) * (1.0 - smoothstep(0.82, 1.0, v)) * outer;
  vec3 col = sideCol * I * (1.0 + 0.8 * uPulse + 2.0 * wave) + mix(sideCol, vec3(1.0, 0.85, 0.6), 0.5) * chev * 2.6;
  gl_FragColor = vec4(col, 1.0);
  ${GLSL_FOG_FADE}
}
`;

export interface RoadDeck {
  group: THREE.Group;
  passables: number[];
  disposables: { dispose(): void }[];
}

/** Road surface, floating hull with rails, energy barriers and passing light posts. */
export function buildRoadDeck(track: Track, U: GridUniforms, propDensity: number): RoadDeck {
  const group = new THREE.Group();
  group.name = 'grid-deck';
  const disposables: { dispose(): void }[] = [];
  const L = track.length;
  const addAll = (geos: THREE.BufferGeometry[], mat: THREE.Material, name: string, receiveShadow: boolean) => {
    for (const g of geos) {
      const m = new THREE.Mesh(g, mat);
      m.name = name;
      m.receiveShadow = receiveShadow;
      m.matrixAutoUpdate = false;
      m.updateMatrix();
      group.add(m);
    }
  };

  // ---------------------------------------------------------------- road surface
  const pads = new Array(MAX_PADS).fill(0).map(() => new THREE.Vector4());
  track.boostPads.slice(0, MAX_PADS).forEach((p, i) => pads[i].set(p.s0, track.wrap(p.s1 - p.s0), p.d, p.halfWidth));
  const slots = new Array(GRID_SIZE).fill(0).map((_, i) => {
    const g = gridSlot(i);
    return new THREE.Vector2(g.s + 2.9, g.d);
  });
  const roadMat = new THREE.MeshStandardMaterial({
    color: new THREE.Color(0.03, 0.032, 0.055),
    roughness: 0.28,
    metalness: 0.55,
    envMapIntensity: 1.1,
  });
  roadMat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, {
      uClock: U.uClock,
      uPulse: U.uPulse,
      uBeatAge: U.uBeatAge,
      uBeatS: U.uBeatS,
      uLen: U.uLen,
      uPads: { value: pads },
      uPadCount: { value: Math.min(MAX_PADS, track.boostPads.length) },
      uSlots: { value: slots },
    });
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>\n${ROAD_VERT_PARS}`)
      .replace('#include <project_vertex>', '#include <project_vertex>\n  vRoad = aRoad;\n  vHw = aHw;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>\n${ROAD_FRAG_PARS}`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>\n${ROAD_FRAG}`);
  };
  roadMat.customProgramCacheKey = () => 'gridRoad';
  disposables.push(roadMat);
  addAll(
    sweep(track, {
      s0: 0,
      len: L,
      step: track.ds,
      chunk: 240,
      profile: [
        { e: -1, d: DECK.railIn, h: 0 },
        { e: 1, d: DECK.railIn, h: 0 },
      ],
      roadAttrs: () => 0,
    }),
    roadMat,
    'gridRoad',
    true,
  );

  // ---------------------------------------------------------------- hull (+ rails)
  // Right half from the rail's road-side face down to the keel; duplicated points
  // give flat-shaded faces with their own feature flags (r = rail, g = underglow, b = keel).
  const halfHull: [ProfilePoint, number, number, number][] = [
    [{ e: 1, d: DECK.railIn, h: 0 }, 0, 0, 0],
    [{ e: 1, d: DECK.railIn, h: DECK.railTop }, 0, 0, 0],
    [{ e: 1, d: DECK.railIn, h: DECK.railTop }, 1, 0, 0],
    [{ e: 1, d: DECK.railOut, h: DECK.railTop }, 1, 0, 0],
    [{ e: 1, d: DECK.railOut, h: DECK.railTop }, 0, 0, 0],
    [{ e: 1, d: DECK.railOut, h: -0.95 }, 0, 0, 0],
    [{ e: 1, d: DECK.railOut, h: -0.95 }, 0, 1, 0],
    [{ e: 1, d: 0.55, h: -1.15 }, 0, 1, 0],
    [{ e: 1, d: 0.55, h: -1.15 }, 0, 0, 0],
    [{ e: 1, d: -2.6, h: -1.9 }, 0, 0, 0],
    [{ e: 0, d: 0.35, h: -2.2 }, 0, 0, 0],
    [{ e: 0, d: 0.35, h: -2.2 }, 0, 0, 1],
    [{ e: 0, d: 0, h: -2.2 }, 0, 0, 1],
  ];
  const rightPts = halfHull.map((x) => x[0]);
  const hullProfile = [...rightPts, ...mirrorProfile(rightPts).slice(1)];
  const feats = [...halfHull.map((x) => [x[1], x[2], x[3]]), ...halfHull.slice(0, -1).reverse().map((x) => [x[1], x[2], x[3]])];
  const hullMat = new THREE.MeshStandardMaterial({
    color: new THREE.Color(0.035, 0.035, 0.06),
    roughness: 0.42,
    metalness: 0.75,
    envMapIntensity: 0.9,
  });
  hullMat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, {
      uClock: U.uClock,
      uPulse: U.uPulse,
      uBeatAge: U.uBeatAge,
      uBeatS: U.uBeatS,
      uLen: U.uLen,
    });
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>\n${HULL_VERT_PARS}`)
      .replace('#include <project_vertex>', '#include <project_vertex>\n  vRoad = aRoad;\n  vFeat = aFeat;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>\n${HULL_FRAG_PARS}`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>\n${HULL_FRAG}`);
  };
  hullMat.customProgramCacheKey = () => 'gridHull';
  disposables.push(hullMat);
  const hullGeos = sweep(track, {
    s0: 0,
    len: L,
    step: 2.5,
    chunk: 300,
    profile: hullProfile,
    roadAttrs: () => 0,
    color: (_s, k, out) => {
      const f = feats[k];
      out.setRGB(f[0], f[1], f[2]);
    },
  });
  for (const g of hullGeos) {
    g.setAttribute('aFeat', g.getAttribute('color'));
    g.deleteAttribute('color');
  }
  addAll(hullGeos, hullMat, 'gridHull', false);

  // ---------------------------------------------------------------- energy barriers
  const corner = cornerStrength(track);
  const wallMat = new THREE.ShaderMaterial({
    vertexShader: WALL_VERT,
    fragmentShader: WALL_FRAG,
    uniforms: {
      ...fogUniforms(),
      uClock: U.uClock,
      uPulse: U.uPulse,
      uBeatAge: U.uBeatAge,
      uBeatS: U.uBeatS,
      uLen: U.uLen,
      uBase: { value: DECK.railTop },
      uHeight: { value: DECK.wallH },
    },
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    fog: true,
  });
  disposables.push(wallMat);
  const wallR: ProfilePoint[] = [
    { e: 1, d: DECK.wallD, h: DECK.railTop },
    { e: 1, d: DECK.wallD, h: DECK.railTop + DECK.wallH },
  ];
  const wallOpts = { s0: 0, len: L, step: 2, chunk: 300, roadAttrs: (s: number) => corner[track.idx(s)] };
  const wallsR = sweep(track, { ...wallOpts, profile: wallR });
  const wallsL = sweep(track, { ...wallOpts, profile: mirrorProfile(wallR) });
  wallsR.forEach((gr, i) => {
    // both barriers of a chunk in one draw
    const g = mergeGeometries([gr, wallsL[i]]) ?? gr;
    if (g !== gr) {
      gr.dispose();
      wallsL[i].dispose();
    }
    g.computeBoundingSphere();
    const m = new THREE.Mesh(g, wallMat);
    m.name = 'gridWall';
    m.renderOrder = 2;
    m.matrixAutoUpdate = false;
    m.updateMatrix();
    group.add(m);
  });

  // ---------------------------------------------------------------- light posts (speed cue)
  const passables: number[] = [];
  const spacing = propDensity >= 0.8 ? 20 : 25;
  const n = Math.round(L / spacing);
  const step = L / n;
  const posts: Placement[] = [];
  const cR = PAL.cyan.clone().multiplyScalar(4.5);
  const cL = PAL.magenta.clone().multiplyScalar(4.5);
  for (let k = 0; k < n; k++) {
    const s = k * step + 3;
    const hw = track.halfWidthAt(s);
    for (const side of [-1, 1]) {
      posts.push({ s, d: side * (hw + DECK.wallD), h: DECK.railTop, upright: false, color: side > 0 ? cR : cL });
    }
    passables.push(s);
  }
  const postGeo = new THREE.BoxGeometry(0.14, DECK.wallH, 0.14);
  postGeo.translate(0, DECK.wallH / 2, 0);
  disposables.push(postGeo);
  const postMat = new THREE.MeshBasicMaterial({ color: 0xffffff, fog: true });
  postMat.onBeforeCompile = (sh) => {
    sh.uniforms.uPulse = U.uPulse;
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uPulse;')
      .replace('#include <color_fragment>', '#include <color_fragment>\n  diffuseColor.rgb *= 1.0 + 0.9 * uPulse;');
  };
  postMat.customProgramCacheKey = () => 'gridPost';
  disposables.push(postMat);
  for (const m of instanceAlongTrack(track, postGeo, postMat, posts, { chunk: 400, name: 'gridPosts' })) group.add(m);

  return { group, passables, disposables };
}
