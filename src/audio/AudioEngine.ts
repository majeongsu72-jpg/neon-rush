import type * as THREE from 'three';
import type { GameEvents } from '../core/Events';
import type { Vehicle } from '../vehicle/Vehicle';
import { CARS, type EngineSound } from '../vehicle/specs';
import { approach, clamp, clamp01, damp, lerp, smoothstep } from '../core/math';
import { JobQueue, glide, makeIR } from './dsp';
import { EngineBanks } from './engineSynth';
import { Drivetrain, EngineVoice, type DrivetrainInput, type VoiceInput } from './EngineVoice';
import { Music, type BeatInfo } from './Music';
import { Sfx, type LayerInput, type Stinger, type UiName } from './Sfx';
import type { SfxName } from './sfxSynth';
import type { SongId } from './songs';

// NEON RUSH audio engine. Everything is synthesized: engine sample banks,
// SFX, drums and the music are rendered in JS (time-sliced) after unlock();
// the live graph is Web Audio only (no AudioWorklet, works from file://).
//
//  engine voices ─┐
//  sfx / layers ──┴→ slow-mo LP → game out ─┬──────────────→ pre-master
//                                           ├→ tunnel send → convolver ─→ (return) ─┘
//                                           └→ slap-back (tunnel flutter echo) ───────┘
//  ui / stingers ────────────────────────────────────────────→ pre-master
//  music → music filter → music out ─────────────────────────→ pre-master (+ wet → convolver)
//  pre-master → compressor → limiter → master volume → destination (+ analyser tap)

export interface AudioCar {
  id: number;
  pos: THREE.Vector3; // world position
  velocity: THREE.Vector3; // world velocity (m/s)
  rpm: number;
  rpmNorm: number; // 0..~1.05 (idle..redline)
  throttle: number; // 0..1
  engine: EngineSound;
  redline: number;
}

export interface AudioFrame {
  dt: number; // real seconds
  timeScale: number; // sim slow-mo factor (0.1..1) → pitch down / muffle a bit
  paused: boolean;
  listener: { pos: THREE.Vector3; forward: THREE.Vector3; up: THREE.Vector3; right: THREE.Vector3; velocity: THREE.Vector3 };
  player:
    | (AudioCar & {
        gear: number;
        speed: number /* m/s */;
        speedNorm: number /* 0..1.3 of top speed */;
        slip: number /* 0..1 tire squeal intensity */;
        drifting: boolean;
        nitro: boolean;
        boost: number /* 0..1 */;
        scrape: number /* 0..1 wall grind */;
        onCurb: boolean;
        airborne: boolean;
        tunnel: number /* 0..1 reverb zone */;
      })
    | null;
  others: AudioCar[]; // all other cars (the nearest 3 get engine voices)
}

type Vec = { readonly x: number; readonly y: number; readonly z: number };

const AI_VOICES = 3;
const AI_RADIUS = 220; // m — beyond this an engine is inaudible anyway
const C_SOUND = 343;
const POPS: SfxName[] = ['pop0', 'pop1', 'pop2'];
const GESTURES = ['pointerdown', 'keydown', 'touchend'] as const;

interface AiVoice {
  voice: EngineVoice;
  car: number; // assigned car id (−1 none)
  pending: number | null; // car to switch to once faded out (−1 → release)
  fade: number;
  doppler: number;
}

interface PassState {
  lon: number;
  valid: boolean;
  cool: number;
}

/** Everything that exists only after unlock(). */
interface Core {
  ctx: AudioContext;
  queue: JobQueue;
  banks: EngineBanks;
  music: Music;
  sfx: Sfx;
  player: EngineVoice;
  drivetrain: Drivetrain | null;
  ai: AiVoice[];
  master: GainNode;
  analyser: AnalyserNode;
  engineBus: GainNode;
  slowLp: BiquadFilterNode;
  gameOut: GainNode;
  uiBus: GainNode;
  sfxVerb: GainNode;
  tunnelSend: GainNode;
  slapSend: GainNode;
  nodes: AudioNode[];
  maxHz: number;
}

export class AudioEngine {
  private readonly events: GameEvents;
  private readonly isFocus: (car: Vehicle) => boolean;
  private readonly offs: (() => void)[] = [];
  private ctx: AudioContext | null = null;
  private core: Core | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private disposed = false;
  private pageHidden = false;

  // Settings survive until unlock() and are applied then.
  private volMaster = 0.8;
  private volMusic = 0.65;
  private volSfx = 0.9;
  private musicMuted = false;
  private volApplied = false;
  private intensity = 0.7;
  private song: { id: SongId; fade: number } | null = null;

  // Per-frame state.
  private paused = false;
  private slowPitch = 1;
  private racing = false;
  private aiTimer = 0;
  private playerLive = false;
  private playerDoppler = 1;
  private lastThrottle = 0;
  private blowCool = 0;
  private whooshCool = 0;
  private lapPending = false;
  private readonly lis = { px: 0, py: 0, pz: 0, fx: 0, fy: 0, fz: -1, rx: 1, ry: 0, rz: 0, vx: 0, vy: 0, vz: 0 };
  private readonly sp = { gain: 0, pan: 0, dist: 0, front: 1 };
  private readonly pass = new Map<number, PassState>();
  private readonly nearest: { id: number; d2: number }[] = [];
  private readonly zeroBeat: BeatInfo = { phase: 0, kick: 0, bar: 0 };
  private scope: Float32Array<ArrayBuffer> | null = null;
  // Reused per-frame inputs (no allocation in update()).
  private readonly vin: VoiceInput = { rpm: 1000, throttle: 0, rate: 1, gain: 0, pan: 0, lp: 8000 };
  private readonly din: DrivetrainInput = { active: false, rpm: 0, rpmNorm: 0, throttle: 0, speed: 0, turbo: 0, airborne: false, rate: 1 };
  private readonly lin: LayerInput = { active: false, speed: 0, speedNorm: 0, slip: 0, drifting: false, onCurb: false, scrape: 0, airborne: false, nitro: false, tunnel: 0, rate: 1 };

  constructor(events: GameEvents, isFocus: (car: Vehicle) => boolean) {
    this.events = events;
    this.isFocus = isFocus;
    this.wire();
  }

  // ===========================================================================
  // Lifecycle

  /** Idempotent; creates / resumes the AudioContext. Call from a user gesture. */
  unlock(): void {
    if (this.disposed) return;
    if (!this.ctx) {
      const w = window as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext };
      const AC = w.AudioContext ?? w.webkitAudioContext;
      if (!AC) return;
      try {
        this.ctx = new AC({ latencyHint: 'interactive' });
      } catch {
        try {
          this.ctx = new AC();
        } catch {
          return;
        }
      }
      try {
        this.core = this.build(this.ctx);
      } catch (err) {
        console.error('[audio] init failed', err);
        this.core = null;
        this.ctx.close().catch(() => {});
        this.ctx = null;
        return;
      }
      this.applyVolumes();
      this.core.music.setIntensity(this.intensity);
      if (this.song) this.core.music.play(this.song.id, this.song.fade);
      this.startTimer();
      // Safety net: any later gesture resumes a suspended / interrupted context.
      for (const type of GESTURES) window.addEventListener(type, this.onGesture, true);
    }
    const st = this.ctx.state as string;
    if (st !== 'running' && st !== 'closed' && !this.pageHidden) this.ctx.resume().catch(() => {});
  }

  private readonly onGesture = (): void => {
    const ctx = this.ctx;
    if (!ctx || this.pageHidden) return;
    const st = ctx.state as string;
    if (st !== 'running' && st !== 'closed') ctx.resume().catch(() => {});
  };

  get ready(): boolean {
    return !!this.core && this.ctx?.state === 'running';
  }

  suspend(): void {
    this.pageHidden = true;
    this.stopTimer();
    if (this.ctx && this.ctx.state === 'running') this.ctx.suspend().catch(() => {});
  }

  resume(): void {
    this.pageHidden = false;
    if (!this.ctx || !this.core) return;
    const st = this.ctx.state as string;
    if (st !== 'running' && st !== 'closed') this.ctx.resume().catch(() => {});
    this.startTimer();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const off of this.offs) off();
    this.offs.length = 0;
    this.stopTimer();
    if (this.ctx) for (const type of GESTURES) window.removeEventListener(type, this.onGesture, true);
    const c = this.core;
    if (c) {
      c.queue.clear();
      c.music.dispose();
      c.sfx.dispose();
      c.player.dispose();
      c.drivetrain?.dispose();
      for (const v of c.ai) v.voice.dispose();
      for (const n of c.nodes) n.disconnect();
    }
    this.core = null;
    this.ctx?.close().catch(() => {});
    this.ctx = null;
  }

  private startTimer(): void {
    if (this.timer !== null || this.pageHidden) return;
    // Music lookahead scheduler + background rendering share one 25 ms timer.
    this.timer = setInterval(() => {
      const c = this.core;
      if (!c) return;
      c.queue.run(4);
      c.music.tick();
    }, 25);
  }

  private stopTimer(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  private build(ctx: AudioContext): Core {
    const nodes: AudioNode[] = [];
    const gain = (v = 1): GainNode => {
      const g = ctx.createGain();
      g.gain.value = v;
      nodes.push(g);
      return g;
    };
    const maxHz = Math.min(20000, ctx.sampleRate * 0.45);

    // Master chain: bus compressor → brick-wall-ish limiter → volume.
    const preMaster = gain(1);
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -18;
    comp.knee.value = 6;
    comp.ratio.value = 4;
    comp.attack.value = 0.006;
    comp.release.value = 0.2;
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -2;
    limiter.knee.value = 0;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.001;
    limiter.release.value = 0.08;
    const master = gain(0);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    preMaster.connect(comp).connect(limiter).connect(master).connect(ctx.destination);
    master.connect(analyser);
    nodes.push(comp, limiter, analyser);

    // The single convolver: generated stereo hall / tunnel IR.
    const verb = ctx.createConvolver();
    verb.buffer = makeIR(ctx, {
      seconds: 2.2,
      rt60: 1.6,
      preDelay: 0.012,
      lpStart: 9000,
      lpEnd: 1100,
      early: [[0.011, 0.5], [0.019, 0.35], [0.027, 0.3], [0.041, 0.22]],
      seed: 7,
    });
    const verbReturn = gain(0.9);
    verb.connect(verbReturn).connect(preMaster);
    nodes.push(verb);

    // Game audio: engines + SFX → slow-mo low-pass → game out (volume / pause).
    const engineBus = gain(1);
    const sfxBus = gain(1);
    const slowLp = ctx.createBiquadFilter();
    slowLp.type = 'lowpass';
    slowLp.frequency.value = maxHz;
    slowLp.Q.value = 0.6;
    nodes.push(slowLp);
    const gameOut = gain(0);
    engineBus.connect(slowLp);
    sfxBus.connect(slowLp);
    slowLp.connect(gameOut).connect(preMaster);
    // Tunnel: reverb send + slap-back flutter echo off the walls.
    const tunnelSend = gain(0);
    gameOut.connect(tunnelSend).connect(verb);
    const slapSend = gain(0);
    const slap = ctx.createDelay(0.5);
    slap.delayTime.value = 0.075;
    const slapFb = gain(0.3);
    gameOut.connect(slapSend).connect(slap).connect(preMaster);
    slap.connect(slapFb).connect(slap);
    nodes.push(slap);
    // UI / stingers bypass pause and slow-mo.
    const uiBus = gain(0);
    uiBus.connect(preMaster);
    const sfxVerb = gain(0);
    sfxVerb.connect(verb);

    const queue = new JobQueue();
    const banks = new EngineBanks(ctx, queue);
    const music = new Music(ctx, queue, preMaster, verb);
    const sfx = new Sfx(ctx, queue, sfxBus, uiBus, sfxVerb);
    const player = new EngineVoice(ctx, engineBus, true);
    const ai: AiVoice[] = [];
    for (let i = 0; i < AI_VOICES; i++) ai.push({ voice: new EngineVoice(ctx, engineBus, false), car: -1, pending: null, fade: 0, doppler: 1 });
    const core: Core = { ctx, queue, banks, music, sfx, player, drivetrain: null, ai, master, analyser, engineBus, slowLp, gameOut, uiBus, sfxVerb, tunnelSend, slapSend, nodes, maxHz };
    sfx.whenNoise(() => {
      if (this.core === core && sfx.noise) core.drivetrain = new Drivetrain(ctx, engineBus, sfx.noise);
    });
    // Background pre-render: every car's engine bank and every song's kit.
    for (const car of CARS) banks.get(car.engine, 0);
    for (const id of ['menu', 'neon', 'coast', 'grid'] as SongId[]) music.prepare(id, 0);
    return core;
  }

  // ===========================================================================
  // Mix controls

  setVolumes(master: number, music: number, sfx: number): void {
    this.volMaster = clamp01(Number(master) || 0);
    this.volMusic = clamp01(Number(music) || 0);
    this.volSfx = clamp01(Number(sfx) || 0);
    this.applyVolumes();
  }

  setMusicMuted(muted: boolean): void {
    this.musicMuted = muted;
    this.applyVolumes();
  }

  private applyVolumes(): void {
    const c = this.core;
    if (!c) return;
    const now = c.ctx.currentTime;
    const sfx = this.volSfx * this.volSfx;
    // First application is instant so the unlocking click's own UI blip is heard.
    const tc = this.volApplied ? 1 : 0;
    this.volApplied = true;
    glide(c.master.gain, this.volMaster * this.volMaster, now, 0.05 * tc);
    glide(c.gameOut.gain, this.paused ? 0 : sfx, now, 0.06 * tc);
    glide(c.uiBus.gain, sfx, now, 0.05 * tc);
    glide(c.sfxVerb.gain, sfx, now, 0.05 * tc);
    // Music sits under the engine while racing.
    c.music.setGain(this.musicMuted ? 0 : this.volMusic * this.volMusic * 0.9 * (this.racing ? 0.75 : 1));
  }

  playSong(id: 'menu' | 'neon' | 'coast' | 'grid', fadeIn = 1.5): void {
    this.song = { id, fade: Math.max(0, fadeIn) };
    this.core?.music.play(id, Math.max(0.02, fadeIn));
  }

  stopSong(fadeOut = 1): void {
    this.song = null;
    this.core?.music.stop(Math.max(0.02, fadeOut));
  }

  setIntensity(x: number): void {
    this.intensity = clamp01(Number(x) || 0);
    this.core?.music.setIntensity(this.intensity);
  }

  ui(name: 'move' | 'select' | 'back' | 'start' | 'error'): void {
    this.core?.sfx.ui(name as UiName);
  }

  /** Beat clock for audio-reactive visuals (audible time: output latency compensated). */
  beat(): { phase: number; kick: number; bar: number } {
    const c = this.core;
    if (!c) return this.zeroBeat;
    const ctx = c.ctx;
    const latency = (Number(ctx.outputLatency) || 0) + (Number(ctx.baseLatency) || 0);
    return c.music.beat(latency);
  }

  /** Output RMS in dBFS (−120 when silent / not started). */
  debugLevel(): number {
    const c = this.core;
    if (!c) return -120;
    const n = c.analyser.fftSize;
    if (!this.scope || this.scope.length !== n) this.scope = new Float32Array(n);
    c.analyser.getFloatTimeDomainData(this.scope);
    let s = 0;
    for (let i = 0; i < n; i++) s += this.scope[i] * this.scope[i];
    const rms = Math.sqrt(s / n);
    return rms > 1e-6 ? Math.max(-120, 20 * Math.log10(rms)) : -120;
  }

  /** Optional: warm up engine banks for specs that are about to be used. */
  preload(engines: EngineSound[]): void {
    const c = this.core;
    if (c) for (const e of engines) c.banks.get(e, 5);
  }

  // ===========================================================================
  // Per-frame update

  update(f: AudioFrame): void {
    const c = this.core;
    if (!c || this.disposed) return;
    c.queue.run(this.paused ? 6 : 3);
    const now = c.ctx.currentTime;
    const dt = clamp(Number(f.dt) || 0, 0, 0.1);
    const L = f.listener;
    const l = this.lis;
    l.px = L.pos.x;
    l.py = L.pos.y;
    l.pz = L.pos.z;
    l.fx = L.forward.x;
    l.fy = L.forward.y;
    l.fz = L.forward.z;
    l.rx = L.right.x;
    l.ry = L.right.y;
    l.rz = L.right.z;
    l.vx = L.velocity.x;
    l.vy = L.velocity.y;
    l.vz = L.velocity.z;

    // Pause: mute the game, muffle the music. Racing: music tucks under the engine.
    const racing = !!f.player;
    if (f.paused !== this.paused || racing !== this.racing) {
      this.paused = f.paused;
      this.racing = racing;
      c.music.setPaused(f.paused);
      this.applyVolumes();
    }
    // Slow-mo: low-pass sweep + pitch drop on engines / SFX.
    const ts = clamp(Number(f.timeScale) || 1, 0.05, 1);
    this.slowPitch = 0.78 + 0.22 * smoothstep(0.1, 1, ts);
    glide(c.slowLp.frequency, ts > 0.98 ? c.maxHz : clamp(20000 * Math.pow(ts, 1.6), 700, c.maxHz), now, 0.08);

    if (this.lapPending) {
      this.lapPending = false;
      c.sfx.stinger('lap', c.music.keyRoot);
    }
    c.music.tick(); // also driven by the 25 ms timer; frames keep it fed if timers lag
    if (f.paused) return; // game bus is muted; keep voices as they are

    this.updatePlayer(c, f, now, dt);
    this.updateAi(c, f, now, dt);
    const p = f.player;
    const lin = this.lin;
    lin.active = !!p;
    lin.speed = p ? p.speed : 0;
    lin.speedNorm = p ? p.speedNorm : 0;
    lin.slip = p ? p.slip : 0;
    lin.drifting = !!p && p.drifting;
    lin.onCurb = !!p && p.onCurb;
    lin.scrape = p ? p.scrape : 0;
    lin.airborne = !!p && p.airborne;
    lin.nitro = !!p && p.nitro;
    lin.tunnel = p ? p.tunnel : 0;
    lin.rate = this.slowPitch;
    c.sfx.updateLayers(lin, now);
    // Tunnel: engines roar off the walls.
    const tun = p ? clamp01(p.tunnel) : 0;
    glide(c.tunnelSend.gain, 0.45 * tun, now, 0.12);
    glide(c.slapSend.gain, 0.28 * tun, now, 0.12);
    glide(c.engineBus.gain, 1 + 0.2 * tun, now, 0.2);
    this.passBys(c, f, now);
  }

  private updatePlayer(c: Core, f: AudioFrame, now: number, dt: number): void {
    const p = f.player;
    const din = this.din;
    din.rate = this.slowPitch;
    if (!p) {
      if (this.playerLive) c.player.stop(now);
      this.playerLive = false;
      din.active = false;
      c.drivetrain?.update(din, now, dt);
      return;
    }
    this.playerLive = true;
    c.player.setBank(c.banks.get(p.engine, 10));
    const thr = clamp01(p.throttle);
    const rn = clamp(p.rpmNorm, 0, 1.1);
    this.spatial(p.pos);
    const sp = this.sp;
    this.playerDoppler = damp(this.playerDoppler, clamp(this.doppler(p.pos, p.velocity, sp.dist), 0.85, 1.2), 8, dt);
    const near = clamp(1.15 - sp.dist / 40, 0.7, 1.15); // camera modes change the distance
    const load = Math.pow(thr, 0.8);
    const vin = this.vin;
    vin.rpm = p.rpm;
    vin.throttle = thr;
    vin.rate = this.playerDoppler * this.slowPitch;
    vin.gain = 0.5 * (0.55 + 0.45 * load) * (0.78 + 0.22 * rn) * near;
    vin.pan = sp.pan * 0.5;
    vin.lp = lerp(3200, 16000, load) * lerp(0.75, 1, Math.min(1, rn));
    c.player.update(vin, now);
    // Rev limiter bounce while held against redline.
    const lim = thr > 0.5 ? smoothstep(p.redline * 0.985, p.redline * 1.01, p.rpm) : 0;
    c.player.setLimiter(0.32 * lim, now);
    const e = p.engine;
    if (c.drivetrain) {
      din.active = true;
      din.rpm = p.rpm;
      din.rpmNorm = rn;
      din.throttle = thr;
      din.speed = p.speed;
      din.turbo = e.turbo;
      din.airborne = p.airborne;
      c.drivetrain.update(din, now, dt);
      // Blow-off valve on a sharp lift with boost built up.
      if (e.turbo > 0.3 && c.drivetrain.spool > 0.5 && this.lastThrottle > 0.6 && thr < 0.2 && now > this.blowCool) {
        this.blowOff(c, e.turbo, now);
      }
    }
    this.lastThrottle = thr;
  }

  private blowOff(c: Core, turbo: number, now: number): void {
    c.sfx.play(turbo > 0.7 ? 'flutter' : 'blowoff', { gain: 0.12 + 0.3 * turbo, rate: (0.95 + Math.random() * 0.1) * this.slowPitch, delay: 0.02 });
    this.blowCool = now + 0.6;
  }

  private updateAi(c: Core, f: AudioFrame, now: number, dt: number): void {
    this.aiTimer -= dt;
    if (this.aiTimer <= 0) {
      this.aiTimer = 0.25;
      this.assignAi(c, f);
    }
    for (const v of c.ai) {
      // 0.2 s fades around reassignment.
      const target = v.car >= 0 && v.pending === null ? 1 : 0;
      v.fade = approach(v.fade, target, dt / 0.2);
      if (v.fade <= 0 && v.pending !== null) {
        v.car = v.pending;
        v.pending = null;
        v.doppler = 1;
        const car = v.car >= 0 ? this.findCar(f, v.car) : null;
        v.voice.setBank(car ? c.banks.get(car.engine, 2) : null);
      }
      const car = v.car >= 0 ? this.findCar(f, v.car) : null;
      if (!car) {
        v.voice.stop(now);
        continue;
      }
      this.spatial(car.pos);
      const sp = this.sp;
      v.doppler = damp(v.doppler, this.doppler(car.pos, car.velocity, sp.dist), 10, dt);
      const thr = clamp01(car.throttle);
      const vin = this.vin;
      vin.rpm = car.rpm;
      vin.throttle = thr;
      vin.rate = v.doppler * this.slowPitch;
      vin.gain = 0.55 * sp.gain * (0.6 + 0.4 * thr) * v.fade;
      vin.pan = sp.pan;
      // Air absorption + a little rear muffling (stereo panner has no front/back).
      vin.lp = (18000 / (1 + sp.dist / 40)) * lerp(0.6, 1, smoothstep(-0.6, 0.2, sp.front)) * lerp(0.55, 1, thr);
      v.voice.update(vin, now);
    }
  }

  /** Give the nearest cars a voice; keep existing assignments stable. */
  private assignAi(c: Core, f: AudioFrame): void {
    const near = this.nearest;
    near.length = 0;
    const l = this.lis;
    for (const o of f.others) {
      const dx = o.pos.x - l.px, dy = o.pos.y - l.py, dz = o.pos.z - l.pz;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 < AI_RADIUS * AI_RADIUS) near.push({ id: o.id, d2 });
    }
    near.sort((a, b) => a.d2 - b.d2);
    const wanted = new Set<number>();
    for (let i = 0; i < Math.min(AI_VOICES, near.length); i++) wanted.add(near[i].id);
    for (const v of c.ai) {
      if (v.pending !== null && v.pending >= 0 && !wanted.has(v.pending)) v.pending = -1;
      if (v.car >= 0 && wanted.has(v.car)) {
        wanted.delete(v.car);
        if (v.pending !== null) v.pending = null; // keep it after all
      } else if (v.car >= 0 && v.pending === null) v.pending = -1; // release
    }
    for (const id of wanted) {
      if (c.ai.some((v) => v.pending === id)) continue;
      const free = c.ai.find((v) => v.car < 0 && v.pending === null) ?? c.ai.find((v) => v.pending === -1);
      if (free) free.pending = id;
    }
  }

  private findCar(f: AudioFrame, id: number): AudioCar | null {
    for (const o of f.others) if (o.id === id) return o;
    return null;
  }

  /** Fast fly-by whoosh when a car crosses the listener's plane close by. */
  private passBys(c: Core, f: AudioFrame, now: number): void {
    const l = this.lis;
    for (const o of f.others) {
      let st = this.pass.get(o.id);
      if (!st) {
        st = { lon: 0, valid: false, cool: 0 };
        this.pass.set(o.id, st);
      }
      const dx = o.pos.x - l.px, dy = o.pos.y - l.py, dz = o.pos.z - l.pz;
      const lon = dx * l.fx + dy * l.fy + dz * l.fz;
      const lat = dx * l.rx + dy * l.ry + dz * l.rz;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (st.valid && (lon >= 0) !== (st.lon >= 0) && Math.abs(st.lon) < 15 && Math.abs(lat) < 5 && d2 < 64 && now > st.cool && now > this.whooshCool) {
        const rvx = o.velocity.x - l.vx, rvy = o.velocity.y - l.vy, rvz = o.velocity.z - l.vz;
        const rel = Math.sqrt(rvx * rvx + rvy * rvy + rvz * rvz);
        if (rel > 9) {
          const side = lat >= 0 ? 1 : -1;
          const k = clamp01(rel / 45) * (1 - Math.abs(lat) / 6);
          c.sfx.play('whoosh', { gain: 0.2 + 0.45 * k, pan: side * 0.8, panTo: -side * 0.25, rate: (0.85 + rel / 110) * this.slowPitch, optional: true });
          st.cool = now + 1;
          this.whooshCool = now + 0.15;
        }
      }
      st.lon = lon;
      st.valid = true;
    }
  }

  // ===========================================================================
  // Spatial helpers (numbers only — no allocation)

  /** Distance gain, pan, distance and frontness of a world position → this.sp. */
  private spatial(pos: Vec): void {
    const l = this.lis;
    const dx = pos.x - l.px, dy = pos.y - l.py, dz = pos.z - l.pz;
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
    const sp = this.sp;
    sp.dist = d;
    if (d < 1e-3) {
      sp.gain = 1;
      sp.pan = 0;
      sp.front = 1;
      return;
    }
    const inv = 1 / d;
    sp.gain = 1 / (1 + Math.pow(d / 12, 1.3));
    sp.pan = clamp((dx * l.rx + dy * l.ry + dz * l.rz) * inv * 0.9, -0.9, 0.9);
    sp.front = (dx * l.fx + dy * l.fy + dz * l.fz) * inv;
  }

  /** Doppler factor 343 / (343 − v_radial), clamped. */
  private doppler(pos: Vec, vel: Vec, dist: number): number {
    if (dist < 0.5) return 1;
    const l = this.lis;
    const inv = 1 / dist;
    const ux = (pos.x - l.px) * inv, uy = (pos.y - l.py) * inv, uz = (pos.z - l.pz) * inv;
    const vr = -((vel.x - l.vx) * ux + (vel.y - l.vy) * uy + (vel.z - l.vz) * uz); // + = approaching
    return clamp(C_SOUND / (C_SOUND - clamp(vr, -150, 150)), 0.75, 1.35);
  }

  // ===========================================================================
  // Game events

  private wire(): void {
    const ev = this.events;
    const focus = (car: Vehicle): boolean => {
      try {
        return this.isFocus(car);
      } catch {
        return false;
      }
    };
    this.offs.push(
      ev.on('gearShift', ({ car, up }) => {
        const c = this.core;
        if (!c) return;
        const now = c.ctx.currentTime;
        if (focus(car)) {
          c.player.shift(up, now);
          c.sfx.play('clunk', { gain: up ? 0.32 : 0.22, rate: (0.95 + Math.random() * 0.1) * this.slowPitch });
          const turbo = car.spec.engine.turbo;
          if (up && turbo > 0.3 && car.body.rpmNorm > 0.6 && (c.drivetrain?.spool ?? 0) > 0.35 && now > this.blowCool) this.blowOff(c, turbo, now);
        } else {
          for (const v of c.ai) if (v.car === car.id) v.voice.shift(up, now);
        }
      }),
      ev.on('backfire', ({ car, strength }) => {
        const c = this.core;
        if (!c) return;
        const s = clamp01(strength);
        if (focus(car)) {
          const n = s > 0.8 && Math.random() < 0.6 ? 2 : 1;
          for (let i = 0; i < n; i++) {
            c.sfx.play(POPS[Math.floor(Math.random() * 3)], { gain: 0.3 + 0.35 * s, rate: (0.9 + Math.random() * 0.25) * this.slowPitch, delay: i * (0.05 + Math.random() * 0.07), verb: 0.12 });
          }
        } else this.spatialShot(c, car.pos, POPS[Math.floor(Math.random() * 3)], 0.25 + 0.3 * s, 0.9 + Math.random() * 0.2);
      }),
      ev.on('nitroStart', ({ car }) => {
        const c = this.core;
        if (!c || !focus(car)) return;
        c.sfx.play('whump', { gain: 0.8, rate: this.slowPitch, verb: 0.15 });
        c.music.nitro();
      }),
      ev.on('nitroEnd', ({ car }) => {
        const c = this.core;
        if (!c || !focus(car)) return;
        c.sfx.play('fwoosh', { gain: 0.25, rate: 0.8 * this.slowPitch });
      }),
      ev.on('boost', ({ car, kind, strength }) => {
        const c = this.core;
        if (!c || !focus(car)) return;
        const s = clamp(strength, 0.3, 1.5);
        c.sfx.play('boost', { gain: 0.3 + 0.25 * s, rate: (0.8 + 0.25 * s) * this.slowPitch });
        if (kind === 'pad') c.sfx.play('zap', { gain: 0.22, rate: 1.2 * this.slowPitch });
        if (kind === 'start') c.sfx.play('whump', { gain: 0.45, rate: 1.1 });
      }),
      ev.on('driftStart', ({ car }) => {
        const c = this.core;
        if (c && focus(car)) c.sfx.play('chirp', { gain: 0.4, rate: (0.95 + Math.random() * 0.1) * this.slowPitch });
      }),
      ev.on('driftLevel', ({ car, level }) => {
        const c = this.core;
        if (!c || !focus(car)) return;
        const rate = [1, 1.26, 1.5][clamp(level, 1, 3) - 1];
        c.sfx.play('ting', { gain: 0.32, rate, verb: 0.25, ui: true });
      }),
      ev.on('driftEnd', ({ car, level }) => {
        const c = this.core;
        if (c && focus(car) && level > 0) c.sfx.play('fwoosh', { gain: 0.35 + 0.12 * level, rate: (1 + 0.08 * level) * this.slowPitch });
      }),
      ev.on('wallHit', ({ car, impact, side }) => {
        const c = this.core;
        if (!c) return;
        const k = clamp01(impact / 18);
        const name: SfxName = Math.random() < 0.5 ? 'crunch0' : 'crunch1';
        if (focus(car)) {
          c.sfx.play(name, { gain: 0.25 + 0.6 * k, rate: (1.1 - 0.25 * k) * this.slowPitch, lp: 3000 + 15000 * k, pan: side * 0.35, verb: 0.15 });
        } else this.spatialShot(c, car.pos, name, 0.2 + 0.5 * k, 1.1 - 0.2 * k);
      }),
      ev.on('carHit', ({ a, b, impact }) => {
        const c = this.core;
        if (!c) return;
        const k = clamp01(impact / 14);
        const fa = focus(a), fb = focus(b);
        if (fa || fb) {
          const other = fa ? b : a;
          this.spatial(other.pos);
          c.sfx.play('bump', { gain: 0.3 + 0.55 * k, rate: (1.05 - 0.2 * k) * this.slowPitch, pan: this.sp.pan * 0.6, verb: 0.1 });
          if (impact > 8) c.sfx.play('crunch1', { gain: 0.3 * k, rate: 1.1 * this.slowPitch, pan: this.sp.pan * 0.6 });
        } else {
          const mid = { x: (a.pos.x + b.pos.x) / 2, y: (a.pos.y + b.pos.y) / 2, z: (a.pos.z + b.pos.z) / 2 };
          this.spatialShot(c, mid, 'bump', 0.25 + 0.4 * k, 1);
        }
      }),
      ev.on('landing', ({ car, impact }) => {
        const c = this.core;
        if (!c || impact < 1.2) return;
        const k = clamp01(impact / 12);
        if (focus(car)) {
          c.sfx.play('thud', { gain: 0.3 + 0.6 * k, rate: (1.05 - 0.15 * k) * this.slowPitch });
          if (k > 0.4) c.sfx.play('chirp', { gain: 0.3 * k, delay: 0.02, rate: this.slowPitch });
        } else this.spatialShot(c, car.pos, 'thud', 0.2 + 0.4 * k, 1.05);
      }),
      ev.on('nearMiss', ({ car, side, speed }) => {
        const c = this.core;
        if (!c || !focus(car)) return;
        const s = side >= 0 ? 1 : -1;
        c.sfx.play('whoosh', { gain: 0.6, pan: s * 0.85, panTo: -s * 0.2, rate: (0.9 + clamp(speed, 0, 100) / 220) * this.slowPitch });
        c.sfx.play('ding', { gain: 0.22, delay: 0.06, verb: 0.25, ui: true });
        this.whooshCool = c.ctx.currentTime + 0.35;
      }),
      ev.on('countdown', ({ n }) => this.stinger(n > 0 ? 'beep' : 'go')),
      ev.on('lap', ({ car }) => {
        // Deferred a frame: the final-lap fanfare / finish chord replace it.
        if (this.core && focus(car)) this.lapPending = true;
      }),
      ev.on('finalLap', () => {
        this.lapPending = false;
        this.stinger('finalLap');
        this.setIntensity(1);
      }),
      ev.on('finish', ({ car }) => {
        if (!focus(car)) return;
        this.lapPending = false;
        this.stinger('finish');
      }),
      ev.on('overtake', ({ car }) => {
        if (focus(car)) this.stinger('overtake');
      }),
      ev.on('checkpoint', () => this.stinger('checkpoint')),
      ev.on('wrongWay', ({ on }) => {
        if (on) this.stinger('wrongWay');
      }),
      ev.on('record', () => this.stinger('record')),
      ev.on('combo', ({ count }) => this.stinger('combo', count)),
      ev.on('respawn', ({ car }) => {
        const c = this.core;
        if (c && focus(car)) c.sfx.play('rswoosh', { gain: 0.45, verb: 0.2 });
      }),
      ev.on('slipstream', ({ car }) => {
        const c = this.core;
        if (c && focus(car)) c.sfx.play('whistle', { gain: 0.25 });
      }),
      ev.on('slingshot', ({ car }) => {
        const c = this.core;
        if (c && focus(car)) c.sfx.play('zap', { gain: 0.4, rate: this.slowPitch });
      }),
      ev.on('crash', ({ car, impact }) => {
        const c = this.core;
        if (!c) return;
        const k = clamp01(impact / 20);
        if (focus(car)) c.sfx.play('crash', { gain: 0.45 + 0.5 * k, rate: (1.05 - 0.15 * k) * this.slowPitch, verb: 0.2 });
        else this.spatialShot(c, car.pos, 'crash', 0.3 + 0.4 * k, 1);
      }),
    );
  }

  private stinger(kind: Stinger, arg = 0): void {
    const c = this.core;
    if (c) c.sfx.stinger(kind, c.music.keyRoot, arg);
  }

  /** One-shot at a world position (distance gain, pan, air absorption). */
  private spatialShot(c: Core, pos: Vec, name: SfxName, gain: number, rate: number): void {
    this.spatial(pos);
    const sp = this.sp;
    const g = gain * sp.gain;
    if (g < 0.015) return;
    c.sfx.play(name, { gain: g, pan: sp.pan, lp: 18000 / (1 + sp.dist / 40), rate: rate * this.slowPitch, optional: true });
  }
}
