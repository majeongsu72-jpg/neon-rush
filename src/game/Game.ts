import * as THREE from 'three';
import { Renderer } from '../render/Renderer';
import { CameraRig } from '../render/CameraRig';
import { Input } from '../core/Input';
import { EventBus, type GameEventMap } from '../core/Events';
import { settings } from '../core/Settings';
import { World } from '../world/World';
import { Session, type SessionConfig } from '../race/Session';
import { carById } from '../vehicle/specs';
import { setTextureAnisotropy } from '../world/textures';
import { Effects } from '../fx/Effects';
import { clamp, damp, smoothstep } from '../core/math';
import type { Vehicle } from '../vehicle/Vehicle';

export const STEP = 1 / 120;
const MAX_STEPS = 8;

/** Yield to the event loop without relying on rAF/timers (both pause or throttle in hidden tabs). */
export function yieldToBrowser(): Promise<void> {
  return new Promise((resolve) => {
    const ch = new MessageChannel();
    ch.port1.onmessage = () => resolve();
    ch.port2.postMessage(0);
  });
}

export interface GameOptions {
  canvas: HTMLCanvasElement;
  params: URLSearchParams;
}

export class Game {
  readonly renderer: Renderer;
  readonly input: Input;
  readonly rig: CameraRig;
  readonly events = new EventBus<GameEventMap>();
  world: World | null = null;
  session: Session | null = null;
  fx: Effects | null = null;
  timeScale = 1;
  debugTimeScale = 1;
  paused = false;
  private acc = 0;
  private last = 0;
  private running = false;
  private params: URLSearchParams;
  private hitStop = 0;
  private flash = 0;
  private caKick = 0;
  private readonly camFwd = new THREE.Vector3();
  private readonly camTmp = new THREE.Vector3();
  private fovTmp = new THREE.Vector2();
  readonly log: string[] = [];
  onFrame: ((dt: number) => void) | null = null;

  constructor(opts: GameOptions) {
    this.params = opts.params;
    const q = (opts.params.get('quality') as never) ?? settings.get('quality');
    this.renderer = new Renderer(opts.canvas, q);
    setTextureAnisotropy(this.renderer.maxAnisotropy);
    this.renderer.dynamicEnabled = settings.get('dynamicResolution');
    this.input = new Input();
    this.rig = new CameraRig(this.renderer.aspect, this.renderer.profile.far);
    window.addEventListener('resize', () => this.rig.setAspect(this.renderer.aspect));
    document.addEventListener('visibilitychange', () => {
      this.last = performance.now();
    });
    this.wireEvents();
  }

  private wireEvents(): void {
    const ev = this.events;
    const rig = this.rig;
    const isP = (c: Vehicle) => c === this.session?.player || (this.session?.cfg.mode === 'attract' && c === rig.target);
    ev.on('wallHit', ({ car, impact }) => {
      if (!isP(car)) return;
      rig.addTrauma(Math.min(0.85, impact / 14));
      if (impact > 14) this.hitStop = 0.07;
      if (impact > 10) {
        this.flash = Math.min(0.22, impact / 90);
        this.renderer.post.params.flashColor.setRGB(1, 0.25, 0.3);
      }
      this.input.rumble(Math.min(1, impact / 18), 0.6, 160);
    });
    ev.on('carHit', ({ a, b, impact }) => {
      if (!isP(a) && !isP(b)) return;
      rig.addTrauma(Math.min(0.7, impact / 12));
      this.input.rumble(Math.min(1, impact / 14), 0.5, 140);
    });
    ev.on('landing', ({ car, impact }) => {
      if (!isP(car)) return;
      rig.addTrauma(Math.min(0.6, impact / 9));
      this.input.rumble(0.6, 0.3, 120);
    });
    ev.on('nitroStart', ({ car }) => {
      if (!isP(car)) return;
      rig.kickFov(9);
      rig.addTrauma(0.25);
      this.flash = 0.12;
      this.renderer.post.params.flashColor.setRGB(0.75, 0.9, 1);
      this.input.rumble(0.3, 0.8, 250);
    });
    ev.on('boost', ({ car, kind, strength }) => {
      if (!isP(car)) return;
      rig.kickFov(kind === 'pad' ? 7 : 4 * strength);
      rig.addTrauma(0.15);
    });
    ev.on('finish', ({ car }) => {
      if (car === this.session?.player) this.timeScale = 0.35;
    });
    ev.on('countdown', ({ n }) => this.world?.theme.onCountdown?.(n));
    ev.on('nearMiss', ({ car }) => {
      if (!isP(car)) return;
      // a split-second of bullet time + lens punch sells the close call
      this.hitStop = Math.max(this.hitStop, 0.09);
      this.caKick = 0.012;
      rig.kickFov(3);
      this.input.rumble(0.15, 0.7, 90);
    });
  }

  // -------------------------------------------------------------------------

  async loadRace(trackId: string, cfg: SessionConfig, onProgress?: (p: number, label: string) => void): Promise<void> {
    this.disposeSession();
    if (!this.world || this.world.track.def.id !== trackId) {
      this.world?.dispose();
      this.world = null;
      this.world = await World.create(trackId, this.renderer.gl, this.renderer.profile, async (p, label) => {
        onProgress?.(p, label);
        await yieldToBrowser();
      });
    }
    this.session = new Session(this.world, cfg, this.events);
    const s = this.session;
    this.rig.target = s.player ?? s.cars[0];
    this.rig.reset();
    if (this.fx) {
      this.fx.group.removeFromParent();
      this.fx.dispose();
    }
    const prof = this.renderer.profile;
    this.fx = new Effects(this.world.track.def.theme, this.events, prof.particles, prof.rain);
    this.fx.focus = this.rig.target;
    this.world.scene.add(this.fx.group);
    this.timeScale = 1;
    onProgress?.(0.92, '셰이더 준비');
    // Warm up shader programs so the first seconds do not hitch.
    this.updateVisuals(0, 0.016);
    const gl = this.renderer.gl;
    if (document.hidden) {
      gl.compile(this.world.scene, this.rig.camera); // timers are throttled in background tabs
    } else {
      try {
        await Promise.race([gl.compileAsync(this.world.scene, this.rig.camera), new Promise((r) => setTimeout(r, 6000))]);
      } catch {
        gl.compile(this.world.scene, this.rig.camera);
      }
    }
    onProgress?.(1, '완료');
  }

  disposeSession(): void {
    if (this.session) {
      this.session.dispose();
      this.session = null;
    }
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.last = performance.now();
    const loop = (now: number) => {
      if (!this.running) return;
      requestAnimationFrame(loop);
      const dt = Math.min(0.1, Math.max(0, (now - this.last) / 1000));
      this.last = now;
      this.frame(dt);
    };
    requestAnimationFrame(loop);
  }

  stop(): void {
    this.running = false;
  }

  /** Rendered instead of the world when set (e.g. the car-select showroom). */
  sceneOverride: { scene: THREE.Scene; camera: THREE.Camera; update(dt: number): void } | null = null;
  /** Called before the simulation each frame (input, UI). */
  beforeFrame: ((dt: number) => void) | null = null;
  /**
   * Called after the cars take this frame's interpolated pose and before the camera
   * is placed: cinematic cameras must aim at *this* frame's cars (a camera placed
   * from last frame's pose lags the car by a variable v·dt and makes it stutter).
   */
  beforeCamera: ((dt: number) => void) | null = null;
  /** Music kick envelope 0..1 for audio-reactive visuals. */
  beatSource: () => number = () => 0;

  /** One real-time frame. */
  frame(dt: number): void {
    this.input.update(dt);
    this.beforeFrame?.(dt);
    this.rig.lookBack = this.input.lookBack;

    const s = this.session;
    // Slow-mo recovery (after finish slow-mo, ease back)
    if (s && s.state === 'finished' && s.playerFinishedAt >= 0 && s.time - s.playerFinishedAt > 1.2) {
      this.timeScale = damp(this.timeScale, 1, 1.5, dt);
    }
    let simDt = dt * this.timeScale * this.debugTimeScale;
    if (this.hitStop > 0) {
      this.hitStop -= dt;
      simDt *= 0.12;
    }
    if (s && !this.paused) {
      this.acc += simDt;
      let steps = 0;
      const maxSteps = Math.max(MAX_STEPS, Math.ceil(this.debugTimeScale) * 4);
      while (this.acc >= STEP && steps < maxSteps) {
        s.fixedUpdate(STEP, (car) => this.applyPlayerInput(car));
        this.acc -= STEP;
        steps++;
      }
      if (steps >= maxSteps) this.acc = 0;
    }
    const alpha = clamp(this.acc / STEP, 0, 1);
    this.updateVisuals(alpha, dt);
    this.renderer.trackFrame(dt);
    this.onFrame?.(dt);
    const ov = this.sceneOverride;
    if (ov) {
      ov.update(dt);
      const p = this.renderer.post.params;
      p.blur = 0;
      p.ca = 0.0012;
      p.lines = 0;
      p.flash = 0;
      p.vignette = 0.45;
      p.bloom = 1.1;
      p.threshold = 0.9;
      p.center.set(0.5, 0.5);
      this.renderer.render(ov.scene, ov.camera, dt);
    } else if (this.world) this.renderer.render(this.world.scene, this.rig.camera, dt);
  }

  toggleFullscreen(): void {
    try {
      if (document.fullscreenElement) document.exitFullscreen?.()?.catch(() => {});
      else document.documentElement.requestFullscreen?.()?.catch(() => {});
    } catch {
      /* fullscreen not permitted here (sandboxed frame) */
    }
  }

  private applyPlayerInput(car: Vehicle): void {
    const d = this.input.drive;
    const i = car.input;
    i.throttle = d.throttle;
    i.brake = d.brake;
    i.steer = d.steer;
    i.drift = d.drift;
    i.nitro = d.nitro;
  }

  private updateVisuals(alpha: number, dt: number): void {
    const s = this.session;
    const w = this.world;
    if (!s || !w) return;
    const lampsNear = w.theme.lampsNear;
    const night = !!w.theme.night;
    const cam = this.rig.camera;
    cam.getWorldDirection(this.camFwd);
    for (const car of s.cars) {
      car.updateVisual(w.track, alpha, dt);
      const beams = car.model.beams;
      beams.visible = night && car.body.grounded;
      if (beams.visible) {
        // volumetric cones of cars behind the lens would wash the whole frame out
        const ahead = this.camTmp.copy(car.pos).sub(cam.position).dot(this.camFwd);
        beams.children[1].visible = beams.children[2].visible = ahead > 4;
        beams.children[0].visible = ahead > 1;
      }
      const L = car.model.lamps;
      if (!lampsNear || !lampsNear.call(w.theme, car.renderS, car.renderD, L.pos, L.col)) for (const c of L.col) c.setRGB(0, 0, 0);
    }
    this.beforeCamera?.(dt);
    this.rig.update(dt, w.track);
    w.update(dt * this.timeScale, this.rig.camera, this.beatSource());
    if (this.fx) {
      this.fx.focus = this.rig.target;
      this.fx.hideFocusTrails = !this.rig.cinematic && (this.rig.mode === 'chase' || this.rig.mode === 'far');
      this.fx.update(dt * this.timeScale, w.time, s.cars, this.rig.camera, w.track);
    }

    // Shadow camera follows the focus car, snapped to texels (no shimmer).
    const sun = w.theme.sunLight;
    const focus = this.rig.target;
    if (sun && focus && sun.castShadow) {
      const dir = sun.position.clone().sub(sun.target.position).normalize();
      const tgt = focus.pos.clone().addScaledVector(focus.forward, 10);
      const texel = (sun.shadow.camera.right - sun.shadow.camera.left) / sun.shadow.mapSize.x;
      tgt.x = Math.round(tgt.x / texel) * texel;
      tgt.z = Math.round(tgt.z / texel) * texel;
      sun.target.position.copy(tgt);
      sun.position.copy(tgt).addScaledVector(dir, 120);
      sun.target.updateMatrixWorld();
    }

    // Post look
    const p = this.renderer.post.params;
    const look = w.theme.look;
    const car = this.rig.target;
    // Cinematic shots aren't "riding" the car: keep speed effects subtle there.
    const cine = this.rig.cinematic ? 0.2 : 1;
    const fxScale = (settings.get('reduceMotion') ? 0.25 : settings.get('speedEffects')) * cine;
    const vn = car ? clamp(Math.abs(car.body.vf) / car.spec.vTop, 0, 1.4) : 0;
    const nitro = car && car.body.nitroActive ? 1 : 0;
    const boost = car && car.body.boostTime > 0 ? 1 : 0;
    p.exposure = look.exposure;
    p.bloom = look.bloom;
    p.threshold = look.threshold;
    p.saturation = look.saturation;
    p.contrast = look.contrast;
    p.lift.setRGB(...look.lift);
    p.gain.setRGB(...look.gain);
    p.grain = look.grain;
    p.lineColor.setRGB(...look.lineColor);
    const blurT = (0.1 * smoothstep(0.42, 1.05, vn) + 0.06 * nitro + 0.02 * boost) * fxScale;
    p.blur = damp(p.blur, blurT, 5, dt);
    this.caKick = Math.max(0, this.caKick - dt * 0.05);
    p.ca = damp(p.ca, (0.0035 * vn * vn + 0.004 * nitro) * fxScale + this.caKick, 5, dt);
    if (car && car.body.onCurb && Math.abs(car.body.vf) > 15 && car === s.player) {
      this.rig.trauma = Math.max(this.rig.trauma, 0.16);
      this.input.rumble(0.35, 0.15, 60);
    }
    p.lines = damp(p.lines, (nitro * 0.75 + boost * 0.22 + smoothstep(1.05, 1.25, vn) * 0.35) * fxScale * (this.rig.cinematic ? 0 : 1), 6, dt);
    p.vignette = look.vignette + 0.18 * vn * fxScale + 0.1 * nitro;
    this.flash = Math.max(0, this.flash - dt * 1.8);
    p.flash = this.flash;
    this.rig.focusOfExpansion(this.fovTmp);
    p.center.lerp(this.fovTmp, 1 - Math.exp(-6 * dt));
    this.rig.shakeScale = settings.get('cameraShake') ? (settings.get('reduceMotion') ? 0.2 : 1) : 0;
  }

  // -------------------------------------------------------------------------
  // Debug / automation API

  /** Advance the simulation without rendering (works while rAF is paused). */
  simulate(seconds: number): void {
    const s = this.session;
    if (!s) return;
    const n = Math.round(seconds / STEP);
    for (let i = 0; i < n; i++) s.fixedUpdate(STEP, (car) => this.applyPlayerInput(car));
  }

  renderOnce(): void {
    this.updateVisuals(1, 1 / 60);
    if (this.world) this.renderer.render(this.world.scene, this.rig.camera, 1 / 60);
  }

  get params_(): URLSearchParams {
    return this.params;
  }

  perf() {
    const info = this.renderer.gl.info;
    return {
      fps: Math.round(this.renderer.fps),
      calls: info.render.calls,
      triangles: info.render.triangles,
      programs: info.programs?.length ?? 0,
      geometries: info.memory.geometries,
      textures: info.memory.textures,
      scale: this.renderer.dynamicScale,
      pixelRatio: this.renderer.pixelRatio,
      /** GPU time per frame in ms (−1 when the timer extension is unavailable). */
      gpuMs: Math.round(this.renderer.gpuMs * 10) / 10,
    };
  }
}

export function sessionConfigFromParams(params: URLSearchParams): SessionConfig {
  const mode = (params.get('mode') as SessionConfig['mode']) ?? 'race';
  return {
    mode,
    car: carById(params.get('car') ?? settings.get('car')),
    paint: Number(params.get('paint') ?? settings.get('paint')) || 0,
    laps: Number(params.get('laps') ?? 3) || 3,
    difficulty: (params.get('difficulty') as SessionConfig['difficulty']) ?? settings.get('difficulty'),
    opponents: mode === 'race' || mode === 'attract' ? 7 : 0,
    autopilot: params.get('autopilot') === '1',
  };
}
