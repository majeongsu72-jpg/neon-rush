import * as THREE from 'three';
import type { ThemeBuilder, ThemeContext, ThemeInstance } from '../types';
import { buildRoad, computeCurbRuns, type RoadStyle } from '../../track/TrackMesh';
import { asphaltTexture, canvasTexture, checkerTexture, noiseTexture, puddleRoughnessTexture, stripeTexture } from '../textures';
import { bakeGeometry, instanceAlongTrack, instanceWorld, type Placement } from '../props';
import { makeFacadeMaterial, unitBoxGeometry } from '../Buildings';
import type { Track } from '../../track/Track';
import type { Rng } from '../../core/rng';
import { Atmosphere } from '../coast/Atmosphere';
import { Island, type GroundSample } from '../coast/Island';
import { buildTerrainGeometry, makeTerrainMaterial } from '../coast/Terrain';
import { Ocean } from '../coast/Ocean';
import {
  buildGuardrails,
  makeTunnelLampUniforms,
  makeTunnelMask,
  patchCoastRoad,
  patchTunnelMask,
  tunnelZoneFn,
} from '../coast/Roadside';
import { buildPalmGeometry, makeFoliageMaterial, placePalms } from '../coast/Palms';
import { buildBridge } from '../coast/Bridge';
import { buildTunnel } from '../coast/Tunnel';
import { buildBoats, buildLighthouse, buildRocks, buildTurbines, type Landmark } from '../coast/Landmarks';

const lin = (r: number, g: number, b: number) => new THREE.Color(r, g, b);

/**
 * SUNSET COAST — synthwave golden hour.
 * A huge striped sun sits low over the sea ahead of the seaside boulevard;
 * palms stand in silhouette, the sea glitters along the sun path, the bridge
 * towers glow orange against a violet dusk and a lighthouse sweeps the point.
 */
export const buildCoast: ThemeBuilder = async (ctx: ThemeContext): Promise<ThemeInstance> => {
  const { track, scene, gl, quality, rng, shared } = ctx;
  const root = new THREE.Group();
  root.name = 'theme-coast';
  const disposables: { dispose(): void }[] = [];
  const keep = <T extends { dispose(): void }>(x: T): T => {
    disposables.push(x);
    return x;
  };
  const passables: number[] = [];
  const L = track.length;

  // ---------------------------------------------------------------- sun & sky
  const sd = track.def.sunDir ?? [-0.329, 0.276, -0.903];
  const keyDir = new THREE.Vector3(sd[0], sd[1], sd[2]).normalize();
  // The visible disc shares the key light's azimuth but sits just above the sea
  // (the light itself is raised a little so the island stays readable).
  const flat = new THREE.Vector2(keyDir.x, keyDir.z).normalize();
  const sunEl = 0.066;
  const sunVis = new THREE.Vector3(flat.x * Math.cos(sunEl), Math.sin(sunEl), flat.y * Math.cos(sunEl));
  const atm = keep(
    new Atmosphere({
      sunDir: sunVis,
      sunRadius: 0.2,
      sunTop: lin(2.5, 1.45, 0.3),
      sunBottom: lin(2.1, 0.22, 0.52),
      zenith: lin(0.024, 0.009, 0.07),
      midSun: lin(0.72, 0.15, 0.2),
      midAnti: lin(0.19, 0.05, 0.21),
      hazeSun: lin(0.98, 0.38, 0.12),
      hazeAnti: lin(0.42, 0.17, 0.31),
      belt: lin(0.24, 0.07, 0.15),
      glow: lin(1.25, 0.48, 0.15),
      cloudLit: lin(0.85, 0.3, 0.32),
      cloudShade: lin(0.15, 0.045, 0.13),
      clouds: 0.85,
      stars: 1.0,
    }),
  );
  root.add(atm.sky);
  const hazeAvg = lin(0.62, 0.26, 0.2);
  // Density only: every coast material replaces the flat fog colour with the
  // directional haze (the flat colour remains for foreign materials like cars).
  const fog = new THREE.FogExp2(0x000000, 0.00105);
  fog.color.copy(hazeAvg);
  scene.fog = fog;
  scene.background = hazeAvg.clone();
  const prep = (m: THREE.Material) => atm.patchHaze(m);

  const env = atm.buildEnvMap(gl);
  disposables.push(env);
  scene.environment = env.texture;
  const envBase = 0.85;
  scene.environmentIntensity = envBase;
  await ctx.progress(0.1, '노을 하늘');

  // ---------------------------------------------------------------- lights
  const hemiBase = 1.15;
  const hemi = new THREE.HemisphereLight(lin(0.62, 0.4, 0.78), lin(0.36, 0.2, 0.12), hemiBase);
  root.add(hemi);
  const sunBase = 4.4;
  const sun = new THREE.DirectionalLight(lin(1.0, 0.6, 0.34), sunBase);
  sun.position.copy(keyDir).multiplyScalar(100);
  sun.castShadow = quality.shadows;
  if (quality.shadows) {
    sun.shadow.mapSize.set(quality.shadowSize, quality.shadowSize);
    const cam = sun.shadow.camera;
    cam.left = -46; cam.right = 46; cam.top = 46; cam.bottom = -46;
    cam.near = 1; cam.far = 330;
    cam.updateProjectionMatrix();
    // grazing golden-hour light: ~1 texel of normal offset keeps the terrain acne-free
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.1;
  }
  root.add(sun, sun.target);

  // ---------------------------------------------------------------- island
  const isl = new Island(track, track.def.seed);
  await ctx.progress(0.18, '섬 지형');
  const pr = quality.props;
  const sp = 5 / Math.sqrt(Math.max(0.4, pr));
  const terrain = await buildTerrainGeometry(
    isl,
    { tile: 160, spacingNear: sp, spacingMid: sp * 2, spacingFar: sp * 4, block: 480, skirt: 6 },
    () => ctx.progress(0.28, '섬 지형'),
  );
  const detail = keep(noiseTexture(256, 4, 5, 7));
  const terrainMat = keep(makeTerrainMaterial(detail));
  prep(terrainMat);
  for (const g of terrain.geometries) {
    const m = new THREE.Mesh(g, terrainMat);
    m.name = 'terrain';
    m.receiveShadow = true;
    m.castShadow = quality.shadows;
    m.matrixAutoUpdate = false;
    root.add(m);
  }
  await ctx.progress(0.36, '바다');

  const ocean = keep(
    new Ocean(isl, atm.uniforms, {
      deep: lin(0.014, 0.02, 0.038),
      shallow: lin(0.07, 0.24, 0.23),
      foam: lin(0.78, 0.62, 0.58),
      glint: lin(3.2, 1.5, 0.55),
      slope: 0.2,
    }),
  );
  root.add(ocean.mesh);
  await ctx.progress(0.44, '도로');

  // ---------------------------------------------------------------- road
  const zone = tunnelZoneFn(track);
  const lampColor = lin(1.0, 0.56, 0.22);
  const lampU = makeTunnelLampUniforms({ spacing: 9, phase: 4, height: 7.2, d: 5.4, range: 30, intensity: 30, color: lampColor });
  const roadPatch = (m: THREE.MeshStandardMaterial) => patchCoastRoad(m, lampU);
  const tunnelMask = makeTunnelMask(isl, zone);
  keep(tunnelMask.texture);

  const asphalt = keep(asphaltTexture([96, 88, 92], 29));
  const roadRough = keep(puddleRoughnessTexture(0.78, 0.52, 0.25, 41));
  roadRough.repeat.set(0.35, 0.35);
  const roadMat = keep(
    new THREE.MeshStandardMaterial({ map: asphalt, roughnessMap: roadRough, roughness: 1, metalness: 0.02, envMapIntensity: 0.9 }),
  );
  roadPatch(roadMat);
  prep(roadMat);
  const curbMat = keep(new THREE.MeshStandardMaterial({ map: keep(stripeTexture('#efe9e2', '#cf2a2c')), roughness: 0.5, metalness: 0 }));
  roadPatch(curbMat);
  prep(curbMat);
  const markingMat = keep(
    new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.55,
      metalness: 0,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    }),
  );
  patchTunnelMask(markingMat, tunnelMask, lampColor.clone().multiplyScalar(0.6));
  prep(markingMat);
  const slabMat = keep(new THREE.MeshStandardMaterial({ color: lin(0.3, 0.27, 0.25), roughness: 0.88 }));
  prep(slabMat);
  const startMat = keep(
    new THREE.MeshStandardMaterial({ map: keep(checkerTexture(10, 2)), roughness: 0.6, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 }),
  );
  prep(startMat);
  const roadStyle: RoadStyle = {
    road: roadMat,
    roadOverhang: 0.35,
    slab: slabMat,
    slabDepth: 1.8,
    marking: markingMat,
    laneColor: lin(0.86, 0.86, 0.84),
    edgeColor: lin(0.95, 0.7, 0.16),
    laneWidth: 4,
    dash: [5, 7],
    curb: curbMat,
    wall: null,
    wallProfile: [],
    wallStrip: null,
    startLine: startMat,
    zone,
  };
  const road = buildRoad(track, roadStyle, computeCurbRuns(track, 260));
  root.add(road);

  // W-beam guardrails (both edges, not inside the tunnel) + posts every 4 m
  const tunnels = track.sectionsOf('tunnel');
  const railMat = keep(new THREE.MeshStandardMaterial({ color: lin(0.66, 0.67, 0.7), metalness: 0.85, roughness: 0.32, envMapIntensity: 1.1 }));
  roadPatch(railMat);
  prep(railMat);
  for (const g of buildGuardrails(track, tunnels.map((t) => ({ s0: t.s0 - 1, s1: t.s1 + 1 })), zone)) {
    const m = new THREE.Mesh(g, railMat);
    m.name = 'guardrail';
    m.receiveShadow = true;
    m.castShadow = quality.shadows;
    m.matrixAutoUpdate = false;
    root.add(m);
  }
  const postMat = keep(new THREE.MeshStandardMaterial({ color: lin(0.3, 0.3, 0.32), metalness: 0.7, roughness: 0.5 }));
  prep(postMat);
  const postGeo = keep(new THREE.BoxGeometry(0.12, 1.05, 0.18).translate(0, 0.28, 0));
  const posts: Placement[] = [];
  const inTunnel = (s: number) => tunnels.some((t) => track.inRange(s, t.s0 - 2, t.s1 + 2));
  for (let s = 1; s < L; s += 4) {
    if (inTunnel(s)) continue;
    const hw = track.halfWidthAt(s);
    for (const side of [-1, 1]) posts.push({ s, d: side * (hw + 0.26) });
  }
  for (const m of instanceAlongTrack(track, postGeo, postMat, posts, { chunk: 1100, name: 'railPosts' })) root.add(m);
  await ctx.progress(0.52, '가드레일');

  // ---------------------------------------------------------------- tunnel & bridge
  const tunnel = buildTunnel(track, rng, { spacing: 9, phase: 4, lampD: 5.4, lampH: 7.25, lampColor }, zone, roadPatch, prep);
  if (tunnel) {
    root.add(tunnel.group);
    passables.push(...tunnel.passables);
    disposables.push(tunnel);
  }
  const bridge = buildBridge(track, prep);
  if (bridge) {
    root.add(bridge.group);
    passables.push(...bridge.passables);
    disposables.push(bridge);
  }
  await ctx.progress(0.6, '현수교');

  // ---------------------------------------------------------------- street lamps
  const bridgeSec = track.sectionsOf('bridge')[0];
  const lighthouseSec = track.sectionsOf('lighthouse')[0];
  const lampPl: Placement[] = [];
  {
    let k = 0;
    for (let s = 12; s < L - 6; s += 44) {
      const onBridge = !!bridgeSec && track.inRange(s, bridgeSec.s0 + 8, bridgeSec.s1 - 8);
      const low = track.lerp(track.py, s) < 4 && !inTunnel(s) && !(lighthouseSec && track.inRange(s, lighthouseSec.s0 - 40, lighthouseSec.s1 + 40));
      if (!onBridge && !low) continue;
      const hw = track.halfWidthAt(s);
      const sides = onBridge ? [-1, 1] : [k++ % 2 ? 1 : -1];
      for (const side of sides) lampPl.push({ s, d: side * (hw + 1.35), yaw: side < 0 ? Math.PI : 0 });
      passables.push(s);
    }
  }
  const lampPoleGeo = keep(
    bakeGeometry([
      { geo: new THREE.CylinderGeometry(0.09, 0.15, 9.8, 8), matrix: new THREE.Matrix4().makeTranslation(0, 4.4, 0) },
      { geo: new THREE.BoxGeometry(2.6, 0.12, 0.14), matrix: new THREE.Matrix4().makeTranslation(-1.2, 9.25, 0) },
      { geo: new THREE.BoxGeometry(0.45, 0.6, 0.45), matrix: new THREE.Matrix4().makeTranslation(0, 0.1, 0) },
    ]),
  );
  const lampHeadGeo = keep(bakeGeometry([{ geo: new THREE.BoxGeometry(0.95, 0.12, 0.36), matrix: new THREE.Matrix4().makeTranslation(-2.2, 9.14, 0) }]));
  const lampPoleMat = keep(new THREE.MeshStandardMaterial({ color: lin(0.12, 0.12, 0.13), roughness: 0.45, metalness: 0.75 }));
  const lampHeadMat = keep(new THREE.MeshBasicMaterial({ color: lin(4.2, 2.3, 0.95) }));
  prep(lampPoleMat);
  prep(lampHeadMat);
  for (const m of instanceAlongTrack(track, lampPoleGeo, lampPoleMat, lampPl, { name: 'lampPoles', chunk: 900, castShadow: quality.shadows })) root.add(m);
  for (const m of instanceAlongTrack(track, lampHeadGeo, lampHeadMat, lampPl, { name: 'lampHeads', chunk: 900 })) root.add(m);

  // ---------------------------------------------------------------- start gantry & cat's eyes
  addStartGantry(track, root, keep, prep, startMat);
  addCatsEyes(track, root, keep, prep, inTunnel);

  // ---------------------------------------------------------------- chevrons & delineators
  addCornerSigns(track, root, keep, prep, passables);
  addDelineators(track, root, keep, prep, (s) => inTunnel(s) || (!!bridgeSec && track.inRange(s, bridgeSec.s0 - 5, bridgeSec.s1 + 5)));
  await ctx.progress(0.66, '표지판');

  // ---------------------------------------------------------------- palms
  const palmGeo = keep(buildPalmGeometry(rng));
  const transmit = lin(3.6, 2.5, 0.9);
  const foliage = keep(makeFoliageMaterial(sunVis, transmit));
  prep(foliage);
  const palms = placePalms(track, isl, rng, pr);
  for (const m of instanceWorld(palmGeo, foliage, palms.matrices.map((matrix) => ({ matrix })), 480, 'palms')) {
    m.castShadow = quality.shadows;
    root.add(m);
  }
  passables.push(...palms.passables);
  await ctx.progress(0.74, '야자수');

  // ---------------------------------------------------------------- beach houses
  const facade = keep(
    makeFacadeMaterial(
      {
        base: lin(1, 1, 1),
        warm: lin(1.0, 0.7, 0.42),
        cool: lin(0.55, 0.78, 1.0),
        accentA: lin(2.8, 0.35, 1.5),
        accentB: lin(0.3, 2.2, 2.6),
        litRatio: 0.28,
        brightness: 0.75,
        floorH: 3.3,
        winW: 2.3,
      },
      shared,
    ),
  );
  facade.metalness = 0.04;
  facade.roughness = 0.82;
  prep(facade);
  const houses = placeBeachHouses(track, isl, rng, pr);
  const boxGeo = keep(unitBoxGeometry());
  for (const m of instanceWorld(boxGeo, facade, houses, 420, 'beachHouses')) {
    m.castShadow = quality.shadows;
    m.receiveShadow = true;
    root.add(m);
  }

  // ---------------------------------------------------------------- landmarks
  const landmarks: Landmark[] = [];
  landmarks.push(buildLighthouse(isl, prep));
  const windYaw = Math.atan2(sunVis.x, sunVis.z); // rotors face the sea breeze
  landmarks.push(buildTurbines(track, isl, rng, Math.round(7 * Math.min(1, pr + 0.2)), windYaw, prep));
  landmarks.push(buildBoats(isl, rng, sunVis, Math.round(7 * pr), prep));
  landmarks.push(buildRocks(isl, rng, Math.round(150 * pr), prep));
  for (const l of landmarks) {
    for (const o of l.objects) root.add(o);
    disposables.push(l);
  }
  await ctx.progress(0.86, '등대');

  // ---------------------------------------------------------------- detail distance culling
  // Small road furniture is sub-pixel and mostly hazed beyond ~800 m; hiding
  // those chunks keeps wide vistas (e.g. above the bay) within the draw budget.
  const maxDist: Record<string, number> = {
    markings: 800, curbR: 800, curbL: 800, catsEyes: 700, railPosts: 700, delineators: 700, reflectors: 900,
    chevronsR: 900, chevronsL: 900, chevronPosts: 700, guardrail: 1000, slab: 1000, rocks: 1100,
    lampPoles: 1100, lampHeads: 1700, palms: 1500, beachHouses: 1700, road: 1900,
    tunnelShell: 900, tunnelLights: 900, tunnelLeds: 700, gantryNeon: 1500, gantryBanner: 900,
  };
  const culled: { obj: THREE.Object3D; sphere: THREE.Sphere; max: number }[] = [];
  root.updateMatrixWorld(true);
  root.traverse((o) => {
    const max = maxDist[o.name];
    if (!max) return;
    const im = o as THREE.InstancedMesh;
    const bs = im.isInstancedMesh ? im.boundingSphere : (o as THREE.Mesh).geometry?.boundingSphere;
    if (bs) culled.push({ obj: o, sphere: bs.clone().applyMatrix4(o.matrixWorld), max });
  });

  // ---------------------------------------------------------------- instance
  const passArr = new Float32Array(passables.map((s) => track.wrap(s)).sort((a, b) => a - b));
  const near = { dist: 0, i: 0, y: 0 };
  let tunnelDim = 0;
  const inst: ThemeInstance = {
    root,
    look: {
      exposure: 0.98,
      bloom: 0.95,
      threshold: 1.12,
      saturation: 1.16,
      contrast: 1.05,
      lift: [0.02, 0.005, 0.038],
      gain: [1.03, 0.97, 0.98],
      vignette: 0.36,
      grain: 0.028,
      lineColor: [1.0, 0.82, 0.9],
    },
    songId: 'coast',
    ambientTint: lin(0.95, 0.5, 0.42),
    passables: passArr,
    rain: 0,
    sunLight: sun,
    update(dt, time, camera, beat) {
      atm.update(camera, time);
      ocean.update(camera, time);
      bridge?.update(time);
      for (const l of landmarks) l.update(dt, time);
      const cp = camera.position;
      for (const e of culled) e.obj.visible = cp.distanceTo(e.sphere.center) - e.sphere.radius < e.max;
      // Inside the tunnel the cars should not keep the open sky's ambient light.
      let target = 0;
      track.nearest(camera.position.x, camera.position.z, 40, near);
      if (near.i >= 0) {
        const z = zone(near.i * track.ds);
        if (z > 1 && camera.position.y < near.y + 7) target = z - 1;
      }
      tunnelDim += (target - tunnelDim) * (1 - Math.exp(-dt * 6));
      hemi.intensity = hemiBase * (1 - 0.85 * tunnelDim);
      scene.environmentIntensity = envBase * (1 - 0.8 * tunnelDim);
      if (!quality.shadows) sun.intensity = sunBase * (1 - 0.75 * tunnelDim);
      void beat;
    },
    dispose() {
      scene.environment = null;
      scene.fog = null;
      scene.background = null;
      root.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (mesh.isMesh) mesh.geometry.dispose();
      });
      for (const d of disposables) d.dispose();
    },
  };
  return inst;
};

// ---------------------------------------------------------------------------

/** Synthwave start/finish gantry over the grid: steel frame, neon tubes, chequered banners. */
function addStartGantry(
  track: Track,
  root: THREE.Group,
  keep: <T extends { dispose(): void }>(x: T) => T,
  prep: (m: THREE.Material) => void,
  bannerMat: THREE.Material,
): void {
  const fr = { pos: new THREE.Vector3(), T: new THREE.Vector3(), R: new THREE.Vector3() };
  fr.pos.set(track.px[0], track.py[0], track.pz[0]);
  fr.T.set(track.tx[0], 0, track.tz[0]).normalize();
  fr.R.set(-fr.T.z, 0, fr.T.x); // right of travel
  const hw = track.halfWidth[0];
  const X = hw + 2.4;
  // local frame: x = right, y = up, z = −forward (banner faces the grid at +z)
  const basis = new THREE.Matrix4().makeBasis(fr.R, new THREE.Vector3(0, 1, 0), fr.T.clone().negate()).setPosition(fr.pos);
  const at = (x: number, y: number, z: number) => new THREE.Matrix4().makeTranslation(x, y, z);
  const frame = bakeGeometry([
    { geo: new THREE.BoxGeometry(0.9, 11, 0.9), matrix: at(-X, 5.2, 0) },
    { geo: new THREE.BoxGeometry(0.9, 11, 0.9), matrix: at(X, 5.2, 0) },
    { geo: new THREE.BoxGeometry(2 * X + 1.4, 0.5, 1.2), matrix: at(0, 10.6, 0) },
    { geo: new THREE.BoxGeometry(2 * X + 1.4, 0.35, 1.2), matrix: at(0, 8.1, 0) },
    { geo: new THREE.BoxGeometry(1.8, 0.8, 1.8), matrix: at(-X, 0.1, 0) },
    { geo: new THREE.BoxGeometry(1.8, 0.8, 1.8), matrix: at(X, 0.1, 0) },
  ]);
  frame.applyMatrix4(basis);
  const neonPink = bakeGeometry([
    { geo: new THREE.BoxGeometry(2 * X - 0.8, 0.14, 0.14), matrix: at(0, 7.86, 0.62) },
    { geo: new THREE.BoxGeometry(2 * X - 0.8, 0.14, 0.14), matrix: at(0, 7.86, -0.62) },
    { geo: new THREE.BoxGeometry(2 * X + 1.2, 0.12, 0.12), matrix: at(0, 10.9, 0.64) },
  ]);
  neonPink.applyMatrix4(basis);
  const neonCyan = bakeGeometry([
    { geo: new THREE.BoxGeometry(0.12, 9.6, 0.12), matrix: at(-X + 0.52, 5.1, 0.52) },
    { geo: new THREE.BoxGeometry(0.12, 9.6, 0.12), matrix: at(X - 0.52, 5.1, 0.52) },
    { geo: new THREE.BoxGeometry(0.12, 9.6, 0.12), matrix: at(-X + 0.52, 5.1, -0.52) },
    { geo: new THREE.BoxGeometry(0.12, 9.6, 0.12), matrix: at(X - 0.52, 5.1, -0.52) },
  ]);
  neonCyan.applyMatrix4(basis);
  // chequered banners on both faces of the upper beam band
  const banner = new THREE.PlaneGeometry(2 * X - 1.2, 1.9);
  const bannerGeo = bakeGeometry([
    { geo: banner, matrix: at(0, 9.35, 0.61) },
    { geo: banner, matrix: new THREE.Matrix4().makeRotationY(Math.PI).setPosition(0, 9.35, -0.61) },
  ]);
  banner.dispose();
  bannerGeo.applyMatrix4(basis);
  const steel = keep(new THREE.MeshStandardMaterial({ color: new THREE.Color(0.1, 0.1, 0.12), roughness: 0.4, metalness: 0.8 }));
  const pink = keep(new THREE.MeshBasicMaterial({ color: new THREE.Color(4.2, 0.35, 2.4) }));
  const cyan = keep(new THREE.MeshBasicMaterial({ color: new THREE.Color(0.3, 2.6, 3.4) }));
  prep(steel);
  prep(pink);
  prep(cyan);
  const add = (g: THREE.BufferGeometry, m: THREE.Material, name: string) => {
    g.computeBoundingSphere();
    const mesh = new THREE.Mesh(g, m);
    mesh.name = name;
    mesh.castShadow = true;
    root.add(mesh);
  };
  add(frame, steel, 'gantry');
  add(neonPink, pink, 'gantryNeon');
  add(neonCyan, cyan, 'gantryNeon');
  add(bannerGeo, bannerMat, 'gantryBanner');
}

/** Amber cat's-eye studs on every lane line, one per dash gap: a stream of dots at speed. */
function addCatsEyes(
  track: Track,
  root: THREE.Group,
  keep: <T extends { dispose(): void }>(x: T) => T,
  prep: (m: THREE.Material) => void,
  skip: (s: number) => boolean,
): void {
  const pl: Placement[] = [];
  const edgeInset = 0.55, laneW = 4, period = 12;
  for (let s = 5 + 3.5; s < track.length; s += period) {
    if (skip(s)) continue;
    const hw = track.halfWidthAt(s);
    const usable = 2 * (hw - edgeInset);
    const lanes = Math.max(2, Math.round(usable / laneW));
    const lw = usable / lanes;
    for (let k = 0; k <= lanes; k++) {
      const d = -hw + edgeInset + k * lw + (k === 0 ? 0.28 : k === lanes ? -0.28 : 0);
      pl.push({ s, d, h: 0.02, upright: false });
    }
  }
  const geo = keep(new THREE.BoxGeometry(0.2, 0.05, 0.12));
  const mat = keep(new THREE.MeshBasicMaterial({ color: new THREE.Color(2.6, 1.15, 0.28) }));
  prep(mat);
  for (const m of instanceAlongTrack(track, geo, mat, pl, { name: 'catsEyes', chunk: 1300 })) root.add(m);
}

/** Red/white chevron boards on the outside of every real corner, facing the traffic. */
function addCornerSigns(
  track: Track,
  root: THREE.Group,
  keep: <T extends { dispose(): void }>(x: T) => T,
  prep: (m: THREE.Material) => void,
  passables: number[],
): void {
  const tex = keep(
    canvasTexture(256, 128, (c, w, h) => {
      c.fillStyle = '#c8141c';
      c.fillRect(0, 0, w, h);
      c.fillStyle = '#f4efe8';
      for (let i = 0; i < 3; i++) {
        const x0 = 30 + i * 70;
        c.beginPath();
        c.moveTo(x0, 14);
        c.lineTo(x0 + 34, 14);
        c.lineTo(x0 + 74, h / 2);
        c.lineTo(x0 + 34, h - 14);
        c.lineTo(x0, h - 14);
        c.lineTo(x0 + 40, h / 2);
        c.closePath();
        c.fill();
      }
    }),
  );
  const boardMat = keep(new THREE.MeshStandardMaterial({ map: tex, roughness: 0.5, emissive: new THREE.Color(0.9, 0.35, 0.25), emissiveMap: tex, emissiveIntensity: 0.35 }));
  prep(boardMat);
  const postMat = keep(new THREE.MeshStandardMaterial({ color: new THREE.Color(0.25, 0.25, 0.27), roughness: 0.6, metalness: 0.6 }));
  prep(postMat);
  // board faces +Z (toward oncoming cars); a mirrored-UV copy points left
  const boardR = keep(new THREE.PlaneGeometry(1.9, 0.95).translate(0, 1.75, 0.06));
  const boardL = keep(boardR.clone());
  const uv = boardL.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setX(i, 1 - uv.getX(i));
  const postGeo = keep(new THREE.BoxGeometry(0.1, 2.2, 0.1).translate(0, 1.1, 0));
  const right: Placement[] = [], left: Placement[] = [], postPl: Placement[] = [];
  let last = -1e9;
  for (let s = 0; s < track.length; s += 1) {
    const k = track.kappaAt(s);
    if (Math.abs(k) < 1 / 255 || s - last < 12) continue;
    last = s;
    const outside = k > 0 ? -1 : 1;
    const hw = track.halfWidthAt(s);
    // angled toward the approaching driver (local X = road right)
    const pl: Placement = { s, d: outside * (hw + 1.7), yaw: -outside * 0.28 };
    (k > 0 ? right : left).push(pl);
    postPl.push(pl);
    passables.push(s);
  }
  for (const m of instanceAlongTrack(track, boardR, boardMat, right, { name: 'chevronsR', chunk: 1000 })) root.add(m);
  for (const m of instanceAlongTrack(track, boardL, boardMat, left, { name: 'chevronsL', chunk: 1000 })) root.add(m);
  for (const m of instanceAlongTrack(track, postGeo, postMat, postPl, { name: 'chevronPosts', chunk: 1000 })) root.add(m);
}

/** White delineator posts with amber reflectors where nothing else marks the edge. */
function addDelineators(
  track: Track,
  root: THREE.Group,
  keep: <T extends { dispose(): void }>(x: T) => T,
  prep: (m: THREE.Material) => void,
  skip: (s: number) => boolean,
): void {
  const pl: Placement[] = [];
  for (let s = 6; s < track.length; s += 24) {
    if (skip(s) || track.lerp(track.py, s) < 4) continue;
    const hw = track.halfWidthAt(s);
    for (const side of [-1, 1]) pl.push({ s, d: side * (hw + 0.95) });
  }
  const postGeo = keep(new THREE.BoxGeometry(0.12, 1.2, 0.12).translate(0, 0.4, 0));
  const refGeo = keep(new THREE.BoxGeometry(0.13, 0.16, 0.14).translate(0, 0.86, 0));
  const postMat = keep(new THREE.MeshStandardMaterial({ color: new THREE.Color(0.8, 0.8, 0.78), roughness: 0.6 }));
  const refMat = keep(new THREE.MeshBasicMaterial({ color: new THREE.Color(3.2, 1.4, 0.25) }));
  prep(postMat);
  prep(refMat);
  for (const m of instanceAlongTrack(track, postGeo, postMat, pl, { name: 'delineators', chunk: 1300 })) root.add(m);
  for (const m of instanceAlongTrack(track, refGeo, refMat, pl, { name: 'reflectors', chunk: 1300 })) root.add(m);
}

/** Pastel art-deco beach houses and kiosks behind the palms of the beach roads. */
function placeBeachHouses(track: Track, isl: Island, rng: Rng, density: number): { matrix: THREE.Matrix4; color?: THREE.Color }[] {
  const pastel = [
    new THREE.Color(0.93, 0.5, 0.45),
    new THREE.Color(0.5, 0.85, 0.72),
    new THREE.Color(0.55, 0.72, 0.92),
    new THREE.Color(0.98, 0.74, 0.52),
    new THREE.Color(0.74, 0.58, 0.88),
    new THREE.Color(0.93, 0.91, 0.86),
    new THREE.Color(0.98, 0.6, 0.72),
  ];
  const items: { matrix: THREE.Matrix4; color?: THREE.Color }[] = [];
  const smp: GroundSample = { h: 0, natural: 0, s: 0, d: 0, dist: 0, road: 0, rock: 0, lagoon: 0 };
  const beaches = track.sectionsOf('beach');
  const q = new THREE.Quaternion();
  const Y = new THREE.Vector3(0, 1, 0);
  for (const b of beaches) {
    const len = track.wrap(b.s1 - b.s0);
    for (const side of [1, -1]) {
      let a = rng.range(10, 40);
      while (a < len - 10) {
        const s = b.s0 + a;
        const w = rng.range(12, 24);
        a += w + rng.range(8, 30) / density;
        if (side < 0 && !rng.chance(0.3)) continue; // few kiosks on the sand side
        const hw = track.halfWidthAt(s);
        const dpt = side > 0 ? rng.range(10, 17) : rng.range(6, 9);
        const hgt = side > 0 ? rng.range(6.5, 15) : rng.range(3.5, 4.5);
        const off = hw + (side > 0 ? rng.range(20, 34) : rng.range(16, 22)) + dpt / 2;
        const rx = track.lerp(track.rx, s), rz = track.lerp(track.rz, s);
        const rl = Math.hypot(rx, rz) || 1;
        const x = track.lerp(track.px, s) + (rx / rl) * off * side;
        const z = track.lerp(track.pz, s) + (rz / rl) * off * side;
        isl.sample(x, z, smp);
        if (smp.h < 0.8 || smp.h > 8 || smp.dist < hw + 14) continue;
        const tx = track.lerp(track.tx, s), tz = track.lerp(track.tz, s);
        // unit box: local X (width) runs along the road
        q.setFromAxisAngle(Y, Math.atan2(-tz, tx) + rng.range(-0.04, 0.04));
        items.push({
          matrix: new THREE.Matrix4().compose(new THREE.Vector3(x, smp.h - 0.6, z), q, new THREE.Vector3(w, hgt, dpt)),
          color: rng.pick(pastel).clone(),
        });
      }
    }
  }
  return items;
}
