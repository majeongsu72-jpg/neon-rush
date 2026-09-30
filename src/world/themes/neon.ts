import * as THREE from 'three';
import type { ThemeBuilder, ThemeContext, ThemeInstance } from '../types';
import { Sky, type SkyParams } from '../Sky';
import { buildEnvMap } from '../Env';
import { buildRoad, computeCurbRuns, mirrorProfile, sweep, type ProfilePoint, type RoadStyle } from '../../track/TrackMesh';
import { asphaltTexture, checkerTexture, puddleRoughnessTexture, stripeTexture, dashTexture, canvasTexture, noiseNormalTexture } from '../textures';
import { signAtlas, makeSignMaterial, signInstanceAttrs, SIGN_DESIGNS, makeHoloMaterial } from '../NeonSigns';
import { makeLampUniforms, patchRoadLamps } from '../RoadShader';
import { instanceAlongTrack, instanceWorld, bakeGeometry, type Placement } from '../props';
import { makeFacadeMaterial, unitBoxGeometry } from '../Buildings';
import { F_TUNNEL } from '../../track/types';
import type { Track } from '../../track/Track';
import { makeFrame } from '../../track/Track';

const C = (hex: number) => new THREE.Color(hex);

export const buildNeon: ThemeBuilder = async (ctx: ThemeContext): Promise<ThemeInstance> => {
  const { track, scene, gl, quality, rng, shared } = ctx;
  const root = new THREE.Group();
  root.name = 'theme-neon';
  const disposables: { dispose(): void }[] = [];
  const keep = <T extends { dispose(): void }>(x: T): T => {
    disposables.push(x);
    return x;
  };

  // ---------------------------------------------------------------- sky/fog
  const skyP: SkyParams = {
    zenith: C(0x030309),
    mid: C(0x0a0818),
    horizon: C(0x241538),
    ground: C(0x06050b),
    sunDir: new THREE.Vector3(0.3, 0.35, -0.9).normalize(),
    sunColor: C(0xbfc8ff),
    sunSize: 0.0,
    sunStripes: 0,
    glowColor: C(0xff2f7a),
    glowStrength: 0.42,
    stars: 0.25,
    clouds: 0.8,
    cloudColor: C(0x2a1638),
  };
  const sky = keep(new Sky(skyP, 900));
  root.add(sky.mesh);
  scene.fog = new THREE.FogExp2(0x120c22, 0.0021);
  scene.background = C(0x07060c);

  const env = buildEnvMap(gl, skyP, [
    { dir: [1, 0.15, 0.2], color: 0xff2bd6, intensity: 5, w: 30, h: 10 },
    { dir: [-1, 0.2, -0.3], color: 0x19f5ff, intensity: 5, w: 26, h: 12 },
    { dir: [0.2, 0.25, 1], color: 0xff8a2a, intensity: 4, w: 30, h: 8 },
    { dir: [-0.3, 0.1, -1], color: 0x7a3bff, intensity: 4, w: 40, h: 10 },
    { dir: [0.6, 0.05, -0.8], color: 0xffe14d, intensity: 3, w: 12, h: 6 },
    { dir: [0, 1, 0], color: 0x1b1030, intensity: 1, w: 80, h: 80 },
  ]);
  disposables.push(env);
  scene.environment = env.texture;
  scene.environmentIntensity = 1;
  await ctx.progress(0.15, '환경 조명');

  // ---------------------------------------------------------------- lights
  const hemi = new THREE.HemisphereLight(0x4a4a9a, 0x140a1a, 0.55);
  root.add(hemi);
  const moon = new THREE.DirectionalLight(0x9fb0ff, 0.45);
  const sd = track.def.sunDir ?? [-0.4, 0.8, -0.45];
  moon.position.set(sd[0], sd[1], sd[2]).multiplyScalar(100);
  moon.castShadow = quality.shadows;
  if (quality.shadows) {
    moon.shadow.mapSize.set(quality.shadowSize, quality.shadowSize);
    const cam = moon.shadow.camera;
    cam.left = -34; cam.right = 34; cam.top = 34; cam.bottom = -34;
    cam.near = 1; cam.far = 260;
    moon.shadow.bias = -0.0004;
    moon.shadow.normalBias = 0.03;
  }
  root.add(moon, moon.target);

  // ---------------------------------------------------------------- road
  const L = track.length;
  const tunnels = track.sectionsOf('tunnel');
  const inTunnel = (s: number) => tunnels.some((t) => track.inRange(s, t.s0 - 2, t.s1 + 2));
  const lampSpacing = L / Math.round(L / 42);
  const lampParams = {
    spacing: lampSpacing,
    phase: 7,
    height: 8.6,
    inset: -0.5,
    range: 38,
    intensity: 70,
    color: new THREE.Color(1.0, 0.64, 0.36),
    tunnelSpacing: 9,
    tunnelHeight: 6.3,
    tunnelD: 3.2,
    tunnelColor: new THREE.Color(0.75, 0.9, 1.0),
    tunnelIntensity: 26,
  };
  const lampUniforms = makeLampUniforms(lampParams);

  const asphalt = keep(asphaltTexture([30, 30, 36], 5, 384));
  const puddles = keep(puddleRoughnessTexture(0.58, 0.05, 0.36, 21));
  puddles.repeat.set(0.33, 0.33);
  const roadMat = keep(
    new THREE.MeshStandardMaterial({
      map: asphalt,
      roughnessMap: puddles,
      roughness: 1,
      metalness: 0.05,
      color: C(0x9a9aa8),
      envMapIntensity: 1.25,
    }),
  );
  patchRoadLamps(roadMat, lampUniforms);

  const wallTex = keep(asphaltTexture([88, 90, 102], 9, 256));
  const wallMat = keep(new THREE.MeshStandardMaterial({ map: wallTex, color: C(0x8a8c9c), roughness: 0.72, metalness: 0.1, envMapIntensity: 0.6 }));
  patchRoadLamps(wallMat, lampUniforms);
  const curbMat = keep(new THREE.MeshStandardMaterial({ map: keep(stripeTexture('#dfe3ee', '#e0115f')), roughness: 0.45, metalness: 0.05 }));
  patchRoadLamps(curbMat, lampUniforms);
  const markingMat = keep(
    new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.35,
      metalness: 0,
      emissive: C(0x2a2a30),
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    }),
  );
  const dash = keep(dashTexture(0.62, 0.12));
  const stripMatR = keep(
    new THREE.MeshBasicMaterial({ color: new THREE.Color(0.25, 2.6, 3.4), map: dash, fog: true }),
  );
  const stripMatL = keep(
    new THREE.MeshBasicMaterial({ color: new THREE.Color(3.2, 0.35, 2.4), map: dash, fog: true }),
  );
  const slabMat = keep(new THREE.MeshStandardMaterial({ color: C(0x24252e), roughness: 0.85, metalness: 0.1 }));
  const startMat = keep(
    new THREE.MeshStandardMaterial({ map: keep(checkerTexture(10, 2)), roughness: 0.5, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 }),
  );

  const roadStyle: RoadStyle = {
    road: roadMat,
    roadOverhang: 0.4,
    slab: slabMat,
    slabDepth: 1.4,
    marking: markingMat,
    laneColor: new THREE.Color(0.82, 0.83, 0.88),
    edgeColor: new THREE.Color(1.0, 0.78, 0.22),
    laneWidth: 4,
    dash: [5, 7],
    curb: curbMat,
    wall: wallMat,
    wallProfile: [
      [0, 0],
      [0.06, 0.1],
      [0.17, 0.34],
      [0.24, 0.96],
      [0.24, 0.96],
      [0.62, 0.96],
      [0.62, 0.96],
      [0.66, -0.3],
    ],
    wallStrip: { material: stripMatR, materialLeft: stripMatL, d: 0.215, h: 0.72, width: 0.07, vScale: 1 / 6 },
    startLine: startMat,
    zone: (s) => (inTunnel(s) ? 1 : 0),
  };
  const curbRuns = computeCurbRuns(track, 260);
  const road = buildRoad(track, roadStyle, curbRuns);
  root.add(road);
  await ctx.progress(0.35, '도로');

  // ---------------------------------------------------------------- ground
  const b = track.bounds();
  const cx = (b.minX + b.maxX) / 2, cz = (b.minZ + b.maxZ) / 2;
  const groundSize = Math.max(b.maxX - b.minX, b.maxZ - b.minZ) + 3200;
  const groundRough = keep(puddleRoughnessTexture(0.7, 0.12, 0.45, 33));
  groundRough.repeat.set(groundSize / 60, groundSize / 60);
  const groundCol = keep(asphaltTexture([22, 22, 28], 17, 256));
  groundCol.repeat.set(groundSize / 14, groundSize / 14);
  const ground = new THREE.Mesh(
    keep(new THREE.PlaneGeometry(groundSize, groundSize)),
    keep(new THREE.MeshStandardMaterial({ map: groundCol, roughnessMap: groundRough, roughness: 1, metalness: 0.15, color: C(0x6a6a78), envMapIntensity: 0.8 })),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.set(cx, -0.05, cz);
  ground.receiveShadow = true;
  ground.name = 'ground';
  root.add(ground);
  // Sodium-lit avenues between the city blocks (same 58 m lattice as the buildings), with
  // lamp pools along the kerbs and little head/tail-light pairs of city traffic crawling
  // along them — what you glimpse over the parapet from the elevated section.
  const streetTime = { value: 0 };
  {
    const gm = ground.material as THREE.MeshStandardMaterial;
    const origin = new THREE.Vector2(b.minX - 650 + 29, b.minZ - 650 + 29);
    gm.onBeforeCompile = (shader) => {
      shader.uniforms.uStreetOrigin = { value: origin };
      shader.uniforms.uStreetTime = streetTime;
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vGW;')
        .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvGW = (modelMatrix * vec4(transformed, 1.0)).xyz;');
      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          `#include <common>
varying vec3 vGW;
uniform vec2 uStreetOrigin;
uniform float uStreetTime;
float stHash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
// One avenue: fo = signed offset from its centre line, a = coordinate along it, id = avenue id.
vec3 stAvenue(float fo, float a, float id, float aw, float fade) {
  float af = abs(fo);
  float street = 1.0 - smoothstep(4.0, 5.5, af);
  if (street <= 0.0) return vec3(0.0);
  // lamp pools on both kerbs, every 20 m (staggered per side)
  float la = a + step(0.0, fo) * 10.0;
  vec2 pd = vec2(af - 4.6, (fract(la / 20.0) - 0.5) * 20.0);
  float pool = exp(-dot(pd, pd) / 5.5);
  vec3 col = vec3(1.0, 0.55, 0.22) * (street * 0.02 + pool * 0.3);
  // traffic: lane at |fo| = 2 m, direction = side of the centre line
  float dir = fo < 0.0 ? -1.0 : 1.0;
  float lane = 1.0 - smoothstep(0.32, 0.32 + aw * 1.5, abs(af - 2.0));
  if (lane > 0.0 && fade > 0.0) {
    float t = a * dir - uStreetTime * (11.0 + 5.0 * stHash(vec2(id, dir)));
    float slot = floor(t / 23.0);
    float u = t - slot * 23.0;
    float occ = step(0.42, stHash(vec2(slot, id * 3.7 + dir)));
    float head = 1.0 - smoothstep(0.35, 0.35 + aw * 1.5, abs(u - 4.1));
    float tail = 1.0 - smoothstep(0.3, 0.3 + aw * 1.5, abs(u - 0.3));
    col += (vec3(1.6, 1.45, 1.2) * head + vec3(1.5, 0.06, 0.04) * tail) * lane * occ * fade;
  }
  return col;
}`,
        )
        .replace(
          '#include <emissivemap_fragment>',
          `#include <emissivemap_fragment>
{
  vec2 q = (vGW.xz - uStreetOrigin) / 58.0;
  vec2 cell = floor(q);
  vec2 f = (fract(q) - 0.5) * 58.0;            // signed metres from the avenue centre lines
  vec2 aw = max(fwidth(vGW.xz), vec2(0.01));    // metres per pixel (for anti-aliasing)
  float fade = 1.0 - smoothstep(0.35, 1.2, max(aw.x, aw.y));
  vec3 st = stAvenue(f.x, vGW.z, cell.x, aw.x, fade) + stAvenue(f.y, vGW.x, cell.y + 91.0, aw.y, fade);
  totalEmissiveRadiance += min(st, vec3(2.0));
}`,
        );
    };
    gm.customProgramCacheKey = () => 'neonGround2';
  }

  // ---------------------------------------------------------------- lamps
  const passables: number[] = [];
  const lampPlacements: Placement[] = [];
  const nLamps = Math.round(L / lampSpacing);
  for (let k = 0; k < nLamps; k++) {
    const s = k * lampSpacing + lampParams.phase;
    if (inTunnel(s)) continue;
    const hw = track.halfWidthAt(s);
    for (const side of [-1, 1]) {
      lampPlacements.push({ s, d: side * (hw + 1.5), yaw: side < 0 ? Math.PI : 0 });
    }
    passables.push(s);
  }
  const poleGeo = keep(
    bakeGeometry([
      { geo: new THREE.CylinderGeometry(0.1, 0.16, 9, 8), matrix: new THREE.Matrix4().makeTranslation(0, 4.5, 0) },
      { geo: new THREE.BoxGeometry(2.4, 0.12, 0.14), matrix: new THREE.Matrix4().makeTranslation(-1.1, 8.85, 0) },
      { geo: new THREE.BoxGeometry(0.5, 0.5, 0.5), matrix: new THREE.Matrix4().makeTranslation(0, 0.25, 0) },
    ]),
  );
  const headGeo = keep(bakeGeometry([{ geo: new THREE.BoxGeometry(0.9, 0.1, 0.34), matrix: new THREE.Matrix4().makeTranslation(-2.0, 8.74, 0) }]));
  const poleMat = keep(new THREE.MeshStandardMaterial({ color: C(0x2a2d36), roughness: 0.4, metalness: 0.8 }));
  const headMat = keep(new THREE.MeshBasicMaterial({ color: new THREE.Color(5.5, 3.6, 2.2) }));
  for (const m of instanceAlongTrack(track, poleGeo, poleMat, lampPlacements, { name: 'lampPoles' })) root.add(m);
  for (const m of instanceAlongTrack(track, headGeo, headMat, lampPlacements, { name: 'lampHeads' })) root.add(m);
  await ctx.progress(0.45, '가로등');

  // ---------------------------------------------------------------- elevated pillars
  const fr = makeFrame();
  const pillarItems: { matrix: THREE.Matrix4 }[] = [];
  for (let s = 0; s < L; s += 26) {
    track.sample(s, fr);
    if (fr.pos.y < 3.4 || inTunnel(s)) continue;
    const hw = fr.halfWidth;
    for (const side of [-1, 1]) {
      const p = fr.pos.clone().addScaledVector(fr.R, side * hw * 0.42);
      const hgt = p.y - 1.3;
      const yaw = Math.atan2(fr.T.x, fr.T.z);
      const mtx = new THREE.Matrix4().compose(
        new THREE.Vector3(p.x, 0, p.z),
        new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw),
        new THREE.Vector3(1.6, hgt, 2.2),
      );
      pillarItems.push({ matrix: mtx });
    }
    passables.push(s);
  }
  if (pillarItems.length) {
    const pillarMat = keep(new THREE.MeshStandardMaterial({ color: C(0x3a3c48), roughness: 0.8, metalness: 0.05 }));
    for (const m of instanceWorld(keep(unitBoxGeometry()), pillarMat, pillarItems, 400, 'pillars')) root.add(m);
  }

  // ---------------------------------------------------------------- tunnels
  const tunnelWallTex = keep(
    canvasTexture(256, 256, (c, w, h) => {
      c.fillStyle = '#4a4e5c';
      c.fillRect(0, 0, w, h);
      for (let y = 0; y < 8; y++)
        for (let x = 0; x < 8; x++) {
          const v = 70 + Math.floor(rng.next() * 30);
          c.fillStyle = `rgb(${v},${v + 2},${v + 12})`;
          c.fillRect(x * 32 + 1, y * 32 + 1, 30, 30);
        }
    }),
  );
  const tunnelMat = keep(new THREE.MeshStandardMaterial({ map: tunnelWallTex, color: C(0xa0a4b4), roughness: 0.35, metalness: 0.2, envMapIntensity: 0.5 }));
  patchRoadLamps(tunnelMat, lampUniforms);
  const tunnelLightMat = keep(new THREE.MeshBasicMaterial({ color: new THREE.Color(4.2, 4.8, 5.4) }));
  const tunnelLedMat = keep(new THREE.MeshBasicMaterial({ color: new THREE.Color(0.3, 2.2, 3.6), map: dash }));
  for (const t of tunnels) {
    const len = track.delta(t.s0, t.s1) > 0 ? track.delta(t.s0, t.s1) : track.wrap(t.s1 - t.s0);
    const shellR: ProfilePoint[] = [
      { e: 1, d: 0.9, h: -0.2 },
      { e: 1, d: 0.9, h: 4.9 },
      { e: 1, d: 0.2, h: 5.9 },
      { e: 1, d: -2.2, h: 6.6 },
      { e: 0, d: 0, h: 6.9 },
    ];
    const shell = [...shellR, ...mirrorProfile(shellR).slice(1)];
    for (const g of sweep(track, { s0: t.s0, len, step: 2, chunk: 200, profile: shell, uScale: 0.25, vScale: 0.25, roadAttrs: () => 1 })) {
      const m = new THREE.Mesh(g, tunnelMat);
      m.receiveShadow = true;
      root.add(m);
    }
    // outer hull (seen from outside) — simple box profile
    const hullR: ProfilePoint[] = [
      { e: 0, d: 0, h: 9.5 },
      { e: 1, d: 3.5, h: 9.5 },
      { e: 1, d: 3.5, h: -0.3 },
    ];
    const hull = [...mirrorProfile(hullR), ...hullR.slice(1)];
    for (const g of sweep(track, { s0: t.s0, len, step: 6, chunk: 300, profile: hull, uScale: 0.1, vScale: 0.1 })) {
      root.add(new THREE.Mesh(g, slabMat));
    }
    // ceiling light rows (two rows) as instanced boxes
    const lights: Placement[] = [];
    const k0 = Math.ceil((t.s0 - lampParams.phase) / lampParams.tunnelSpacing);
    const k1 = Math.floor((t.s0 + len - lampParams.phase) / lampParams.tunnelSpacing);
    for (let k = k0; k <= k1; k++) {
      const s = k * lampParams.tunnelSpacing + lampParams.phase;
      for (const side of [-1, 1]) lights.push({ s, d: side * lampParams.tunnelD, h: 6.55, upright: false, scale: [0.5, 0.08, 2.6] });
      passables.push(s);
    }
    for (const m of instanceAlongTrack(track, keep(new THREE.BoxGeometry(1, 1, 1)), tunnelLightMat, lights, { name: 'tunnelLights' })) root.add(m);
    // LED lines on the walls
    const ledR: ProfilePoint[] = [
      { e: 1, d: 0.88, h: 1.6 },
      { e: 1, d: 0.88, h: 1.72 },
    ];
    for (const prof of [ledR, mirrorProfile(ledR)]) {
      for (const g of sweep(track, { s0: t.s0, len, step: 2, chunk: 300, profile: prof, uScale: 1, vScale: 1 / 4 })) root.add(new THREE.Mesh(g, tunnelLedMat));
    }
  }
  await ctx.progress(0.55, '터널');

  // ---------------------------------------------------------------- neon signs
  const atlas = keep(signAtlas());
  const signMat = keep(makeSignMaterial(atlas, shared, 3.3));
  const poleMat2 = keep(new THREE.MeshStandardMaterial({ color: C(0x1c1e26), roughness: 0.5, metalness: 0.7 }));
  const signChunks = new Map<number, { m: THREE.Matrix4[]; tile: number[]; tint: THREE.Color[]; phase: number[] }>();
  const signPoles: { matrix: THREE.Matrix4 }[] = [];
  const upV = new THREE.Vector3(0, 1, 0);
  const fr2 = makeFrame();
  const vertTiles = SIGN_DESIGNS.map((d, i) => (d.vertical ? i : -1)).filter((i) => i >= 0);
  const horzTiles = SIGN_DESIGNS.map((d, i) => (d.vertical ? -1 : i)).filter((i) => i >= 0);
  const signStep = 34 / Math.max(0.4, quality.props);
  for (let s = 50; s < L - 30; s += rng.range(signStep * 0.7, signStep * 1.3)) {
    if (inTunnel(s)) continue;
    const side = rng.sign();
    const hw = track.halfWidthAt(s);
    const vertical = rng.chance(0.3);
    const w = vertical ? rng.range(2.4, 3.4) : rng.range(5.5, 9);
    const h = vertical ? w * rng.range(2.4, 3.2) : w * rng.range(0.55, 0.85);
    const off = hw + rng.range(6.5, 12);
    track.surface(s, side * off, fr2);
    const base = fr2.pos.clone();
    const y0 = rng.range(4.5, 14);
    // face the road and slightly toward approaching traffic
    const Th = fr2.T.clone().setY(0).normalize();
    const Rh = fr2.R.clone().setY(0).normalize();
    const normal = Rh.multiplyScalar(-side * 0.82).addScaledVector(Th, -0.55).normalize();
    const pos = base.clone().add(new THREE.Vector3(0, y0 + h / 2, 0));
    const m = new THREE.Matrix4().lookAt(pos.clone().add(normal), pos, upV);
    m.setPosition(pos);
    m.scale(new THREE.Vector3(w, h, 1));
    const k = Math.floor(s / 400);
    let ch = signChunks.get(k);
    if (!ch) signChunks.set(k, (ch = { m: [], tile: [], tint: [], phase: [] }));
    ch.m.push(m);
    ch.tile.push(vertical ? vertTiles[rng.int(0, vertTiles.length - 1)] : horzTiles[rng.int(0, horzTiles.length - 1)]);
    ch.tint.push(new THREE.Color(1, 1, 1).multiplyScalar(rng.range(0.8, 1.25)));
    ch.phase.push(rng.next() < 0.12 ? rng.range(0.85, 1) : rng.range(0, 0.75));
    // support pole
    if (y0 > 1) {
      signPoles.push({
        matrix: new THREE.Matrix4().compose(
          new THREE.Vector3(base.x, base.y - 0.5, base.z),
          new THREE.Quaternion(),
          new THREE.Vector3(0.35, y0 + h * 0.5 + 0.5, 0.35),
        ),
      });
    }
    passables.push(s);
  }
  const planeGeo = new THREE.PlaneGeometry(1, 1);
  for (const ch of signChunks.values()) {
    const g = planeGeo.clone();
    signInstanceAttrs(g, ch.tile, ch.tint, ch.phase);
    const im = new THREE.InstancedMesh(g, signMat, ch.m.length);
    ch.m.forEach((mm, i) => im.setMatrixAt(i, mm));
    im.computeBoundingSphere();
    im.name = 'signs';
    root.add(im);
  }
  planeGeo.dispose();
  if (signPoles.length) for (const m of instanceWorld(keep(unitBoxGeometry()), poleMat2, signPoles, 420, 'signPoles')) root.add(m);

  // ---------------------------------------------------------------- holographic billboards
  {
    const holoMat = keep(makeHoloMaterial(shared));
    const mats: THREE.Matrix4[] = [];
    const kinds: number[] = [];
    const cols: number[] = [];
    const palette = [new THREE.Color(0.2, 1, 1.3), new THREE.Color(1.3, 0.25, 1.1), new THREE.Color(1.2, 0.9, 0.2), new THREE.Color(0.6, 0.35, 1.4)];
    for (let s = 220; s < L - 100; s += rng.range(300, 420)) {
      if (inTunnel(s)) continue;
      const side = rng.sign();
      const hw = track.halfWidthAt(s);
      const fr4 = track.surface(s, side * (hw + rng.range(18, 26)), makeFrame());
      const w = rng.range(14, 22), h = w * rng.range(0.45, 0.6);
      const pos = fr4.pos.clone().add(new THREE.Vector3(0, rng.range(16, 30), 0));
      const Th = fr4.T.clone().setY(0).normalize();
      const Rh = fr4.R.clone().setY(0).normalize();
      const normal = Rh.multiplyScalar(-side * 0.6).addScaledVector(Th, -0.8).normalize();
      const m = new THREE.Matrix4().lookAt(pos.clone().add(normal), pos, upV);
      m.setPosition(pos);
      m.scale(new THREE.Vector3(w, h, 1));
      mats.push(m);
      kinds.push(rng.int(0, 3));
      const c = palette[rng.int(0, palette.length - 1)];
      cols.push(c.r, c.g, c.b);
    }
    if (mats.length) {
      const g = new THREE.PlaneGeometry(1, 1);
      g.setAttribute('aKind', new THREE.InstancedBufferAttribute(new Float32Array(kinds), 1));
      g.setAttribute('aCol', new THREE.InstancedBufferAttribute(new Float32Array(cols), 3));
      const im = new THREE.InstancedMesh(g, holoMat, mats.length);
      mats.forEach((mm, i) => im.setMatrixAt(i, mm));
      im.computeBoundingSphere();
      im.name = 'holoBoards';
      root.add(im);
      disposables.push(g);
    }
  }

  // ---------------------------------------------------------------- overhead gantries + start arch
  const gantryMat = keep(new THREE.MeshStandardMaterial({ color: C(0x2a2d38), roughness: 0.45, metalness: 0.75 }));
  const gantryItems: { matrix: THREE.Matrix4 }[] = [];
  const boardChunks = { m: [] as THREE.Matrix4[], tile: [] as number[], tint: [] as THREE.Color[], phase: [] as number[] };
  const gantryS: number[] = [0];
  for (let s = 380; s < L - 200; s += 430) if (!inTunnel(s) && !inTunnel(s + 20)) gantryS.push(s);
  const boardTiles = [15, 9, 1, 12, 14, 5, 0];
  gantryS.forEach((s, gi) => {
    const fr3 = track.surface(s, 0, makeFrame());
    const hw = fr3.halfWidth;
    const isStart = gi === 0;
    const H = isStart ? 9 : 7.6;
    const yaw = Math.atan2(fr3.T.x, fr3.T.z);
    const q = new THREE.Quaternion().setFromAxisAngle(upV, yaw);
    const Rh = fr3.R.clone().setY(0).normalize();
    for (const side of [-1, 1]) {
      const p = fr3.pos.clone().addScaledVector(Rh, side * (hw + 1.4));
      gantryItems.push({ matrix: new THREE.Matrix4().compose(new THREE.Vector3(p.x, p.y - 0.4, p.z), q, new THREE.Vector3(0.7, H + 1.4, 0.7)) });
    }
    const beamP = fr3.pos.clone().add(new THREE.Vector3(0, H, 0));
    gantryItems.push({ matrix: new THREE.Matrix4().compose(new THREE.Vector3(beamP.x, beamP.y - 0.3, beamP.z), q, new THREE.Vector3(2 * hw + 3.5, isStart ? 1.6 : 0.9, 0.9)) });
    // LED board facing oncoming cars (plane +Z toward -T)
    const bw = isStart ? 2 * hw : Math.min(12, hw * 1.2);
    const bh = isStart ? 3.2 : 2.6;
    const bp = fr3.pos.clone().add(new THREE.Vector3(0, H + (isStart ? 2.5 : 1.9), 0)).addScaledVector(fr3.T, -0.5);
    const m = new THREE.Matrix4().lookAt(bp.clone().addScaledVector(fr3.T, -1), bp, upV);
    m.setPosition(bp);
    m.scale(new THREE.Vector3(bw, bh, 1));
    boardChunks.m.push(m);
    boardChunks.tile.push(isStart ? 15 : boardTiles[gi % boardTiles.length]);
    boardChunks.tint.push(new THREE.Color(1.2, 1.2, 1.2));
    boardChunks.phase.push(0.3);
    passables.push(s);
  });
  for (const m of instanceWorld(keep(unitBoxGeometry()), gantryMat, gantryItems, 500, 'gantries')) root.add(m);
  {
    const g = new THREE.PlaneGeometry(1, 1);
    signInstanceAttrs(g, boardChunks.tile, boardChunks.tint, boardChunks.phase);
    const im = new THREE.InstancedMesh(g, signMat, boardChunks.m.length);
    boardChunks.m.forEach((mm, i) => im.setMatrixAt(i, mm));
    im.computeBoundingSphere();
    root.add(im);
    disposables.push(g);
  }
  // countdown lights on the start arch
  const startFr = track.surface(0, 0, makeFrame());
  const lightGeo = keep(new THREE.SphereGeometry(0.42, 16, 12));
  const cdLights: THREE.MeshBasicMaterial[] = [];
  for (let i = 0; i < 5; i++) {
    const mat = keep(new THREE.MeshBasicMaterial({ color: new THREE.Color(0.08, 0.02, 0.02) }));
    const mesh = new THREE.Mesh(lightGeo, mat);
    mesh.position.copy(startFr.pos).add(new THREE.Vector3(0, 9 - 1.4, 0)).addScaledVector(startFr.R, (i - 2) * 1.5).addScaledVector(startFr.T, -0.9);
    root.add(mesh);
    cdLights.push(mat);
  }

  // ---------------------------------------------------------------- canal
  const canals = track.sectionsOf('canal');
  const waterNormal = keep(noiseNormalTexture(256, 5, 3.2, 41));
  waterNormal.repeat.set(3, 6);
  const waterMat = keep(
    new THREE.MeshStandardMaterial({
      color: C(0x04050a),
      roughness: 0.06,
      metalness: 0.3,
      normalMap: waterNormal,
      normalScale: new THREE.Vector2(0.35, 0.35),
      envMapIntensity: 2.2,
    }),
  );
  const bankMat = keep(new THREE.MeshStandardMaterial({ color: C(0x3a3c48), roughness: 0.8, map: wallTex }));
  for (const c of canals) {
    const side = c.def.side ?? -1;
    const len = track.wrap(c.s1 - c.s0);
    const e = (side < 0 ? -1 : 1) as -1 | 1;
    const water: ProfilePoint[] = [
      { e, d: 2.6, h: -2.3 },
      { e, d: 44, h: -2.3 },
    ];
    const bank: ProfilePoint[] = [
      { e, d: 0.66, h: -0.3 },
      { e, d: 2.6, h: -2.4 },
    ];
    const farBank: ProfilePoint[] = [
      { e, d: 44, h: -2.4 },
      { e, d: 44, h: 0.8 },
      { e, d: 52, h: 0.8 },
    ];
    const fix = (p: ProfilePoint[]) => (side < 0 ? mirrorProfile(p.map((q) => ({ ...q, e: (-q.e) as -1 | 1 }))) : p);
    for (const g of sweep(track, { s0: c.s0, len, step: 4, chunk: 250, profile: fix(water), uScale: 0.05, vScale: 0.02 })) root.add(new THREE.Mesh(g, waterMat));
    for (const g of sweep(track, { s0: c.s0, len, step: 4, chunk: 250, profile: fix(bank), uScale: 0.3, vScale: 0.2 })) root.add(new THREE.Mesh(g, bankMat));
    for (const g of sweep(track, { s0: c.s0, len, step: 4, chunk: 250, profile: fix(farBank), uScale: 0.3, vScale: 0.2 })) root.add(new THREE.Mesh(g, bankMat));
  }
  await ctx.progress(0.65, '네온사인');

  // ---------------------------------------------------------------- buildings
  const facade = keep(
    makeFacadeMaterial(
      {
        base: C(0x1a1c26),
        warm: new THREE.Color(1.0, 0.72, 0.42),
        cool: new THREE.Color(0.45, 0.78, 1.0),
        accentA: new THREE.Color(0.2, 1.6, 2.2),
        accentB: new THREE.Color(2.4, 0.3, 1.6),
        litRatio: 0.34,
        brightness: 1.35,
        floorH: 3.1,
        winW: 1.9,
      },
      shared,
    ),
  );
  const near = { dist: 0, i: 0, y: 0 };
  const canalExclude = (x: number, z: number): boolean => {
    if (!canals.length) return false;
    track.nearest(x, z, 90, near);
    if (near.i < 0) return false;
    const s = near.i * track.ds;
    for (const c of canals) {
      if (!track.inRange(s, c.s0 - 30, c.s1 + 30)) continue;
      const side = (x - track.px[near.i]) * track.rx[near.i] + (z - track.pz[near.i]) * track.rz[near.i];
      if (Math.sign(side) === Math.sign(c.def.side ?? -1) && near.dist < track.halfWidth[near.i] + 60) return true;
    }
    return false;
  };
  const items = placeBuildings(track, rng, quality.props, canalExclude);
  const boxGeo = keep(unitBoxGeometry());
  for (const m of instanceWorld(boxGeo, facade, items, 420, 'buildings')) {
    m.castShadow = false;
    root.add(m);
  }
  await ctx.progress(0.8, '도시');

  // ---------------------------------------------------------------- instance
  const passArr = new Float32Array(passables.sort((a, b2) => a - b2));
  const inst: ThemeInstance = {
    root,
    look: {
      exposure: 1.0,
      bloom: 1.1,
      threshold: 1.0,
      saturation: 1.12,
      contrast: 1.06,
      lift: [0.012, 0.004, 0.03],
      gain: [1.0, 0.97, 1.04],
      vignette: 0.42,
      grain: 0.035,
      lineColor: [0.75, 0.95, 1.0],
    },
    songId: 'neon',
    ambientTint: C(0x3a2a6a),
    passables: passArr,
    rain: 1,
    night: true,
    sunLight: moon,
    update(dt, time, camera, beat) {
      sky.update(camera, time, beat);
      streetTime.value = time;
      waterNormal.offset.y -= dt * 0.03;
      waterNormal.offset.x += dt * 0.008;
    },
    lampsNear(s, d, pos, col) {
      const tun = inTunnel(s);
      const spacing = tun ? lampParams.tunnelSpacing : lampParams.spacing;
      const k = Math.floor((s - lampParams.phase) / spacing);
      const c = tun ? lampParams.tunnelColor : lampParams.color;
      const inten = tun ? lampParams.tunnelIntensity : lampParams.intensity;
      let n = 0;
      for (const kk of [k, k + 1]) {
        const ls = kk * spacing + lampParams.phase;
        if (!tun && inTunnel(ls)) continue;
        const hw = track.halfWidthAt(ls);
        for (const side of [-1, 1]) {
          const ld = tun ? side * lampParams.tunnelD : side * (hw + lampParams.inset);
          track.point(ls, ld, tun ? lampParams.tunnelHeight : lampParams.height, pos[n]);
          col[n].copy(c).multiplyScalar(inten);
          n++;
        }
      }
      for (; n < 4; n++) col[n].setRGB(0, 0, 0);
      void d;
      return true;
    },
    onCountdown(n) {
      const on = n === 3 ? 2 : n === 2 ? 4 : n === 1 ? 5 : 0;
      cdLights.forEach((m, i) => {
        if (n === 0) m.color.setRGB(0.3, 6, 1.2);
        else if (n < 0) m.color.setRGB(0.08, 0.02, 0.02);
        else m.color.setRGB(i < on ? 7 : 0.08, i < on ? 0.3 : 0.02, i < on ? 0.2 : 0.02);
      });
    },
    dispose() {
      scene.environment = null;
      scene.fog = null;
      root.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (mesh.isMesh) mesh.geometry.dispose();
      });
      for (const d of disposables) d.dispose();
    },
  };
  return inst;
};

/** City blocks around the circuit, kept clear of the road corridor. */
function placeBuildings(
  track: Track,
  rng: { next(): number; range(a: number, b: number): number },
  density: number,
  exclude: (x: number, z: number) => boolean,
) {
  const b = track.bounds();
  const margin = 650;
  const cell = 58;
  const items: { matrix: THREE.Matrix4 }[] = [];
  const near = { dist: 0, i: 0, y: 0 };
  const q = new THREE.Quaternion();
  for (let x = b.minX - margin; x <= b.maxX + margin; x += cell) {
    for (let z = b.minZ - margin; z <= b.maxZ + margin; z += cell) {
      if (rng.next() > 0.86 * density + 0.1) continue;
      const jx = x + rng.range(-10, 10);
      const jz = z + rng.range(-10, 10);
      if (exclude(jx, jz)) continue;
      track.nearest(jx, jz, 240, near);
      const hw = near.i >= 0 ? track.halfWidth[near.i] : 9;
      const clear = near.dist - hw - 8;
      if (clear < 10) continue;
      const maxHalf = Math.min(26, clear / 1.42);
      const w = rng.range(12, 2 * maxHalf);
      const dpt = rng.range(12, 2 * maxHalf);
      let hgt: number;
      if (near.dist < 70) hgt = rng.range(14, 48);
      else if (near.dist < 220) hgt = rng.range(26, 110);
      else hgt = rng.range(50, 240) * (rng.next() < 0.15 ? 1.4 : 1);
      // elevated road nearby: keep low-rise walls from clipping the deck
      const yaw = (Math.round(rng.range(0, 3)) * Math.PI) / 2 + rng.range(-0.06, 0.06);
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
      items.push({ matrix: new THREE.Matrix4().compose(new THREE.Vector3(jx, -0.2, jz), q, new THREE.Vector3(w, hgt, dpt)) });
    }
  }
  return items;
}
