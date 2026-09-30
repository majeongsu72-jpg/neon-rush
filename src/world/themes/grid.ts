import * as THREE from 'three';
import type { ThemeBuilder, ThemeContext, ThemeInstance } from '../types';
import { Sky, type SkyParams } from '../Sky';
import { buildEnvMap } from '../Env';
import { settings } from '../../core/Settings';
import { BeatClock, CLOCK_WRAP, TrackLocator, findInfield, makeGridUniforms } from '../grid/common';
import { buildRoadDeck } from '../grid/RoadDeck';
import { buildGridFloor } from '../grid/GridFloor';
import { buildBackdrop } from '../grid/Backdrop';
import { buildCoreRings, buildGates } from '../grid/Gates';
import { buildBeams } from '../grid/Beams';
import { buildMonoliths } from '../grid/Monoliths';
import { buildParticles } from '../grid/Particles';

const C = (hex: number) => new THREE.Color(hex);

/**
 * HYPER GRID — "vector void". A neon circuit floating in a violet-black void
 * above an endless glowing grid; a ringed hologram planet and a striped
 * synthwave sun on the horizon, a colossal octahedron "core" spinning in a
 * gyroscope of rings over the infield, wireframe monoliths drifting past.
 * Almost every light in the world is emissive and keyed to the music: kicks
 * flash the lines, send a light wave racing down the road ahead of the player
 * and a ring wave across the grid floor.
 */
export const buildGrid: ThemeBuilder = async (ctx: ThemeContext): Promise<ThemeInstance> => {
  const { track, scene, gl, quality, rng, shared } = ctx;
  const root = new THREE.Group();
  root.name = 'theme-grid';
  const disposables: { dispose(): void }[] = [];
  const keep = <T extends { dispose(): void }>(x: T): T => {
    disposables.push(x);
    return x;
  };
  const U = makeGridUniforms(shared, track.length);
  const sd = track.def.sunDir ?? [0.35, 0.55, 0.75];

  // ---------------------------------------------------------------- void: sky, fog, reflections
  // synthwave sun low in the south-east (ahead on the back straight and the jump),
  // ringed hologram planet in the north-north-east (ahead on the launch straight)
  const sunAz: [number, number] = [sd[0] * 0.5, sd[2]];
  const planetAz: [number, number] = [0.33, -1];
  const skyP: SkyParams = {
    zenith: C(0x020108),
    mid: C(0x0a0520),
    horizon: C(0x2a0d4a),
    ground: C(0x04020a),
    sunDir: new THREE.Vector3(sunAz[0], 0.12, sunAz[1]).normalize(),
    sunColor: C(0xff4fd8),
    sunSize: 0, // drawn by the backdrop instead (stripes tuned for a low, large sun)
    sunStripes: 0,
    glowColor: C(0xff2bd6),
    glowStrength: 0.08,
    stars: 1.0,
    clouds: 0,
    cloudColor: C(0x000000),
  };
  const sky = keep(new Sky(skyP, 900));
  root.add(sky.mesh);
  // Haze = the sky's own colour just below the horizon (same formula as Sky.ts),
  // so distant geometry and the far edge of the grid dissolve into the glow band.
  const skyBelowHorizon = (h: number): THREE.Color => {
    const base = skyP.horizon.clone().lerp(skyP.ground, THREE.MathUtils.smoothstep(-h, 0, 0.12));
    return base.add(skyP.glowColor.clone().multiplyScalar(skyP.glowStrength * Math.exp(-Math.abs(h) * 14)));
  };
  const haze = skyBelowHorizon(-0.035);
  scene.fog = new THREE.FogExp2(haze, 0.0007);
  scene.background = haze.clone();
  const env = buildEnvMap(gl, skyP, [
    { dir: [1, 0.04, 0], color: 0x19f5ff, intensity: 5, w: 70, h: 2.5 },
    { dir: [-1, 0.04, 0], color: 0xff2bd6, intensity: 5, w: 70, h: 2.5 },
    { dir: [0.3, 0.02, 1], color: 0x19f5ff, intensity: 3, w: 60, h: 1.5 },
    { dir: [-0.3, 0.02, -1], color: 0xff2bd6, intensity: 3, w: 60, h: 1.5 },
    { dir: [sunAz[0], 0.12, sunAz[1]], color: 0xff7a3c, intensity: 3, w: 26, h: 26 },
    { dir: [planetAz[0], 0.16, planetAz[1]], color: 0xc02bff, intensity: 2, w: 30, h: 30 },
    { dir: [0, -1, 0], color: 0x2a6bff, intensity: 0.6, w: 120, h: 120 },
    { dir: [0, 1, 0], color: 0x1a0c40, intensity: 1, w: 80, h: 80 },
  ]);
  disposables.push(env);
  scene.environment = env.texture;
  scene.environmentIntensity = 1;
  await ctx.progress(0.15, '가상 공간');

  // ---------------------------------------------------------------- lights (cars; the world is emissive)
  const hemi = new THREE.HemisphereLight(0x6a58d0, 0x0a0616, 0.5);
  root.add(hemi);
  const key = new THREE.DirectionalLight(0xd0c4ff, 1.0);
  key.position.set(sd[0], sd[1], sd[2]).multiplyScalar(100);
  key.castShadow = quality.shadows;
  if (quality.shadows) {
    key.shadow.mapSize.set(quality.shadowSize, quality.shadowSize);
    const cam = key.shadow.camera;
    cam.left = -34; cam.right = 34; cam.top = 34; cam.bottom = -34;
    cam.near = 1; cam.far = 260;
    key.shadow.bias = -0.0004;
    key.shadow.normalBias = 0.03;
  }
  root.add(key, key.target);

  // ---------------------------------------------------------------- planet, sun, horizon line
  const backdrop = buildBackdrop(U, { planetAz, planetEl: 9, planetR: 16, sunAz, sunEl: 6, sunR: 11 });
  root.add(backdrop.mesh);
  disposables.push(...backdrop.disposables);

  // ---------------------------------------------------------------- the circuit
  const deck = buildRoadDeck(track, U, quality.props);
  root.add(deck.group);
  disposables.push(...deck.disposables);
  await ctx.progress(0.4, '네온 트랙');

  const floor = buildGridFloor(track, U, new THREE.Color(0.0016, 0.001, 0.0045), haze);
  for (const o of floor.objects) root.add(o);
  disposables.push(...floor.disposables);
  await ctx.progress(0.5, '그리드');

  // the core: colossal octahedron in a gyroscope of rings, on a sky beam, in the infield
  const infield = findInfield(track);
  const coreR = THREE.MathUtils.clamp(infield.clearance * 0.2, 20, 60);
  const ringMax = Math.min(coreR * 2.8, infield.clearance - 45);
  const core = { center: new THREE.Vector3(infield.x, Math.max(ringMax + 25, 150), infield.z), radius: coreR };

  const gates = buildGates(track, U, quality.props);
  for (const m of gates.meshes) root.add(m);
  disposables.push(...gates.disposables);
  const rings = buildCoreRings(gates, core.center, [ringMax * 0.64, ringMax * 0.82, ringMax]);
  root.add(rings.mesh);
  disposables.push(...rings.disposables);
  const beams = buildBeams(track, U, quality.props, [{ x: core.center.x, z: core.center.z, top: 900, width: 9 }]);
  for (const m of beams.meshes) root.add(m);
  disposables.push(...beams.disposables);
  await ctx.progress(0.65, '링 게이트');

  // ---------------------------------------------------------------- the void's inhabitants
  const mono = buildMonoliths(track, U, rng, quality.props, core);
  for (const m of mono.meshes) root.add(m);
  disposables.push(...mono.disposables);
  const motes = buildParticles(U, rng, quality.particles);
  root.add(motes.points);
  disposables.push(...motes.disposables);
  await ctx.progress(0.8, '부유 구조물');

  // ---------------------------------------------------------------- instance
  const passables = new Float32Array([...deck.passables, ...gates.passables].sort((a, b) => a - b));
  const clock = new BeatClock();
  const locator = new TrackLocator(track);
  const buf = new THREE.Vector2();
  const inst: ThemeInstance = {
    root,
    look: {
      exposure: 1.0,
      bloom: 1.5,
      threshold: 0.8,
      saturation: 1.2,
      contrast: 1.1,
      lift: [0.01, 0.0, 0.028],
      gain: [0.98, 0.96, 1.06],
      vignette: 0.5,
      grain: 0.03,
      lineColor: [0.55, 0.95, 1.0],
    },
    songId: 'grid',
    ambientTint: C(0x3a3aa8),
    passables,
    rain: 0,
    sunLight: key,
    update(dt, time, camera, beat) {
      const s = locator.locate(camera.position);
      if (clock.update(dt, beat)) {
        U.uBeatS.value = s;
        U.uBeatOrigin.value.copy(camera.position);
      }
      // "reduce motion": gentle glow instead of kick flashes, no travelling waves
      const calm = settings.get('reduceMotion');
      U.uPulse.value = clock.pulse * (calm ? 0.25 : 1);
      U.uBeatAge.value = calm ? 99 : clock.age;
      U.uCamS.value = s;
      U.uClock.value = time % CLOCK_WRAP;
      U.uFar.value = (camera as THREE.PerspectiveCamera).far ?? 2600;
      sky.update(camera, time, U.uPulse.value);
      backdrop.mesh.position.copy(camera.position);
      floor.update(camera);
      rings.update(time);
      gl.getDrawingBufferSize(buf);
      motes.update(camera, buf.y);
    },
    dispose() {
      scene.environment = null;
      scene.fog = null;
      root.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (mesh.isMesh || (o as THREE.Points).isPoints) mesh.geometry.dispose();
        if ((o as THREE.InstancedMesh).isInstancedMesh) (o as THREE.InstancedMesh).dispose();
      });
      for (const d of disposables) d.dispose();
    },
  };
  return inst;
};
