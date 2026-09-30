import * as THREE from 'three';
import { Game, type GameOptions } from './Game';
import { Director } from './Director';
import { Showroom } from './Showroom';
import { Hud, type HudModel, type StandingRow } from '../ui/Hud';
import { Menus, type ResultsData, type Selection, type TrackCard, type ModeId } from '../ui/Menus';
import type { SessionConfig } from '../race/Session';
import { CARS, carById } from '../vehicle/specs';
import { settings } from '../core/Settings';
import { getRecords, saveRecords, setRecordPersistence } from '../core/Storage';
import { TRACKS, getTrack } from '../world/World';
import { clamp, formatInt, formatTime, ordinal } from '../core/math';
import type { Vehicle } from '../vehicle/Vehicle';
import type { MapDot } from '../ui/Gauges';
import { ModeController, createMode } from '../race/modes';

export interface AudioFrameLike {
  dt: number;
  timeScale: number;
  paused: boolean;
  listener: { pos: THREE.Vector3; forward: THREE.Vector3; up: THREE.Vector3; right: THREE.Vector3; velocity: THREE.Vector3 };
  player: {
    id: number; pos: THREE.Vector3; velocity: THREE.Vector3; rpm: number; rpmNorm: number; throttle: number;
    engine: Vehicle['spec']['engine']; redline: number;
    gear: number; speed: number; speedNorm: number; slip: number; drifting: boolean; nitro: boolean; boost: number;
    scrape: number; onCurb: boolean; airborne: boolean; tunnel: number;
  } | null;
  others: { id: number; pos: THREE.Vector3; velocity: THREE.Vector3; rpm: number; rpmNorm: number; throttle: number; engine: Vehicle['spec']['engine']; redline: number }[];
}

/** The subset of the audio engine the app talks to. */
export interface AudioLike {
  unlock(): void;
  readonly ready: boolean;
  setVolumes(master: number, music: number, sfx: number): void;
  setMusicMuted(m: boolean): void;
  update(frame: AudioFrameLike): void;
  playSong(id: 'menu' | 'neon' | 'coast' | 'grid', fadeIn?: number): void;
  stopSong(fadeOut?: number): void;
  setIntensity(x: number): void;
  ui(name: 'move' | 'select' | 'back' | 'start' | 'error'): void;
  beat(): { phase: number; kick: number; bar: number };
  suspend(): void;
  resume(): void;
}

class NullAudio implements AudioLike {
  ready = false;
  unlock(): void {}
  setVolumes(): void {}
  setMusicMuted(): void {}
  update(): void {}
  playSong(): void {}
  stopSong(): void {}
  setIntensity(): void {}
  ui(): void {}
  beat() {
    return { phase: 0, kick: 0, bar: 0 };
  }
  suspend(): void {}
  resume(): void {}
}

type AppState = 'boot' | 'menu' | 'loading' | 'intro' | 'race' | 'paused' | 'results';

const TRACK_COLORS: Record<string, [string, string]> = {
  neon: ['#1a0b3b', '#ff2bd6'],
  coast: ['#ff7a3d', '#6a2cff'],
  grid: ['#02101e', '#19f5ff'],
};

export class App {
  readonly game: Game;
  readonly hud: Hud;
  readonly menus: Menus;
  readonly director: Director;
  audio: AudioLike = new NullAudio();
  private showroom: Showroom | null = null;
  state: AppState = 'boot';
  selection: Selection | null = null;
  mode: ModeController | null = null;
  private musicMuted = false;
  private fpsEl: HTMLDivElement;
  private resultsTimer = -1;
  private lastLapShown = 0;
  private listenerVel = new THREE.Vector3();
  private lastCamPos = new THREE.Vector3();
  private readonly frameObj: AudioFrameLike;
  private tunnelMix = 0;

  constructor(opts: GameOptions, ui: HTMLElement) {
    this.game = new Game(opts);
    this.director = new Director(this.game.rig);
    this.hud = new Hud(ui);
    this.menus = new Menus(ui, {
      sound: (n) => this.audio.ui(n),
      previewCar: (id, paint) => this.showroom?.setCar(id, paint),
      tracks: () => this.trackCards(),
      start: (sel) => void this.startRace(sel),
      resume: () => this.resume(),
      restart: () => void this.restart(),
      quit: () => void this.quitToMenu(),
      enterCarSelect: (on) => this.enterShowroom(on),
      settingChanged: (k) => this.applySetting(k),
      unlock: () => this.unlockAudio(),
    });
    const fade = document.createElement('div');
    fade.id = 'fade';
    ui.appendChild(fade);
    this.fpsEl = document.createElement('div');
    this.fpsEl.id = 'fps';
    ui.appendChild(this.fpsEl);
    this.frameObj = {
      dt: 0,
      timeScale: 1,
      paused: false,
      listener: { pos: new THREE.Vector3(), forward: new THREE.Vector3(), up: new THREE.Vector3(), right: new THREE.Vector3(), velocity: new THREE.Vector3() },
      player: null,
      others: [],
    };
    this.game.beforeFrame = (dt) => this.beforeFrame(dt);
    this.game.onFrame = (dt) => this.afterFrame(dt);
    this.game.beforeCamera = (dt) => {
      const s = this.game.session, w = this.game.world;
      if (s && w && this.director.active) this.director.update(dt, s.cars, w.track);
    };
    this.game.beatSource = () => this.audio.beat().kick;
    this.wireEvents();
    this.director.onIntroDone = () => this.beginCountdown();
    window.addEventListener('resize', () => this.showroom?.resize(this.game.renderer.aspect));
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        this.audio.suspend();
        if (this.state === 'race' && !this.game.params_.get('autopilot')) this.pause();
      } else this.audio.resume();
    });
  }

  setAudio(a: AudioLike): void {
    this.audio = a;
    this.applySetting('masterVolume');
  }

  private trackCards(): TrackCard[] {
    return TRACKS.map((t) => {
      const tr = getTrack(t.id);
      return {
        id: t.id,
        name: tr.def.name,
        nameKo: tr.def.nameKo,
        subtitle: tr.def.subtitle,
        track: tr,
        colors: TRACK_COLORS[t.id] ?? ['#111', '#555'],
      };
    });
  }

  // ------------------------------------------------------------------ boot
  async boot(params: URLSearchParams): Promise<void> {
    this.menus.show('loading');
    const quick = params.get('quick');
    if (params.get('autopilot') === '1') setRecordPersistence(false);
    this.game.start();
    if (quick) {
      const sel: Selection = {
        mode: (quick === 'ta' ? 'timeattack' : quick) as ModeId,
        car: params.get('car') ?? settings.get('car'),
        paint: Number(params.get('paint') ?? settings.get('paint')) || 0,
        track: params.get('track') ?? settings.get('track'),
        difficulty: (params.get('difficulty') as Selection['difficulty']) ?? settings.get('difficulty'),
      };
      await this.startRace(sel, params.get('autopilot') === '1', params.get('nointro') === '1');
      return;
    }
    await this.startAttract(params.get('track') ?? 'neon');
    this.menus.show('title');
    this.state = 'menu';
  }

  private async startAttract(trackId: string): Promise<void> {
    const cfg: SessionConfig = {
      mode: 'attract',
      car: CARS[0],
      paint: 0,
      laps: 999,
      difficulty: 'hard',
      opponents: 7,
    };
    this.mode?.dispose();
    this.mode = null;
    await this.game.loadRace(trackId, cfg, (p, l) => this.menus.setLoading(p, l));
    this.game.session!.startImmediately();
    this.game.timeScale = 1;
    this.director.attract();
    this.hud.show(false);
    this.audio.playSong('menu', 1.5);
    this.audio.setIntensity(0.35);
  }

  private unlockAudio(): void {
    this.audio.unlock();
    this.applySetting('masterVolume');
    this.audio.playSong('menu', 1);
  }

  // ------------------------------------------------------------------ race
  async startRace(sel: Selection, autopilot = false, skipIntro = false): Promise<void> {
    this.selection = sel;
    this.state = 'loading';
    this.enterShowroom(false);
    this.menus.show('loading');
    this.hud.show(false);
    this.hud.clear();
    this.director.off();
    this.mode?.dispose();
    const spec = carById(sel.car);
    const cfg: SessionConfig = {
      mode: sel.mode,
      car: spec,
      paint: sel.paint,
      laps: sel.mode === 'rush' ? 999 : 3,
      difficulty: sel.difficulty,
      opponents: sel.mode === 'race' ? 7 : 0,
      autopilot,
    };
    await this.game.loadRace(sel.track, cfg, (p, l) => this.menus.setLoading(p, l));
    const s = this.game.session!;
    this.mode = createMode(sel.mode, this.game, s, this.hud);
    this.applySteering();
    this.hud.setTrack(s.track);
    this.lastLapShown = 0;
    this.resultsTimer = -1;
    this.game.timeScale = 1;
    this.game.paused = false;
    this.menus.show('none');
    this.audio.stopSong(0.6);
    if (skipIntro) {
      this.beginCountdown();
    } else {
      this.state = 'intro';
      this.director.intro(s.player!, 4.2);
      this.hud.banner(s.track.def.name, s.track.def.nameKo + ' · ' + s.track.def.subtitle, '', 3800);
    }
  }

  private beginCountdown(): void {
    const s = this.game.session;
    if (!s) return;
    this.director.off();
    this.game.rig.target = s.player;
    this.hud.show(true);
    this.state = 'race';
    s.startCountdown();
    const song = (s.track.def.theme === 'neon' ? 'neon' : s.track.def.theme) as 'neon' | 'coast' | 'grid';
    this.audio.playSong(song, 0.3);
    this.audio.setIntensity(0.7);
  }

  private pause(): void {
    if (this.state !== 'race') return;
    this.state = 'paused';
    this.game.paused = true;
    this.menus.show('pause');
    this.audio.setIntensity(0.2);
  }

  private resume(): void {
    if (this.state !== 'paused') return;
    this.state = 'race';
    this.game.paused = false;
    this.menus.show('none');
    this.audio.setIntensity(this.game.session?.finalLapAnnounced ? 1 : 0.7);
  }

  private async restart(): Promise<void> {
    if (this.selection) await this.startRace(this.selection, false, true);
  }

  private async quitToMenu(): Promise<void> {
    this.game.paused = false;
    this.hud.show(false);
    this.hud.clear();
    this.menus.show('loading');
    await this.startAttract(this.game.world?.track.def.id ?? 'neon');
    this.menus.show('main');
    this.state = 'menu';
  }

  private enterShowroom(on: boolean): void {
    if (on) {
      if (!this.showroom) this.showroom = new Showroom(this.game.renderer.gl, this.game.renderer.aspect);
      const sr = this.showroom;
      sr.setCar(this.menus.sel.car, this.menus.sel.paint);
      this.game.sceneOverride = { scene: sr.scene, camera: sr.camera, update: (dt) => sr.update(dt) };
    } else {
      this.game.sceneOverride = null;
    }
  }

  // ------------------------------------------------------------------ settings
  /** 조향 반응 속도 setting → the player's steering ramp and yaw response (×0.7 … ×1.3). */
  private applySteering(): void {
    const p = this.game.session?.player;
    if (p && !this.game.session?.cfg.autopilot) p.body.steerResponse = 0.7 + 0.6 * settings.get('steering');
  }

  private applySetting(key: string): void {
    const r = this.game.renderer;
    if (key === 'quality') {
      r.setQuality(settings.get('quality'));
      this.game.rig.setFar(r.profile.far);
    }
    if (key === 'dynamicResolution') r.dynamicEnabled = settings.get('dynamicResolution');
    if (key === 'steering') this.applySteering();
    if (key === 'masterVolume' || key === 'musicVolume' || key === 'sfxVolume') {
      this.audio.setVolumes(settings.get('masterVolume'), settings.get('musicVolume'), settings.get('sfxVolume'));
    }
  }

  // ------------------------------------------------------------------ frame hooks
  private beforeFrame(dt: number): void {
    const inp = this.game.input;
    const menuActs = inp.consumeMenu();
    const acts = inp.consumeActions();
    for (const a of acts) {
      if (a === 'fullscreen') this.game.toggleFullscreen();
      if (a === 'mute') {
        this.musicMuted = !this.musicMuted;
        this.audio.setMusicMuted(this.musicMuted);
      }
      if (a === 'fps') settings.set('showFps', !settings.get('showFps'));
      if (this.state === 'race') {
        if (a === 'camera') this.game.rig.cycleMode();
        if (a === 'reset' && this.game.session?.player && !this.game.session.player.finished) this.game.session.respawn(this.game.session.player);
        if (a === 'pause') this.pause();
      }
    }
    if (this.state === 'intro') {
      if (menuActs.includes('confirm') || menuActs.includes('back') || acts.includes('pause')) this.director.skipIntro();
    } else if (this.state === 'menu' || this.state === 'paused' || this.state === 'results') {
      if (this.state === 'menu' && this.menus.current === 'title' && inp.anyPressed && menuActs.length === 0) {
        menuActs.push('confirm');
      }
      this.menus.handle(menuActs);
    }
    inp.anyPressed = false;
    void dt;
  }

  private afterFrame(dt: number): void {
    const g = this.game;
    const s = g.session;
    const w = g.world;
    if (s && w) {
      this.mode?.update(dt);
      if (this.state === 'race' || this.state === 'paused') {
        const hm = this.buildHud(dt);
        if (hm) this.hud.update(hm, dt);
        this.checkRaceEnd(dt);
      }
    }
    this.updateAudio(dt);
    if (settings.get('showFps')) {
      const p = g.perf();
      this.fpsEl.textContent = `${p.fps} FPS · ${p.calls} DC · ${(p.triangles / 1000).toFixed(0)}k TRI · x${p.scale.toFixed(2)}${p.gpuMs >= 0 ? ` · GPU ${p.gpuMs.toFixed(1)}ms` : ''}`;
    } else if (this.fpsEl.textContent) this.fpsEl.textContent = '';
  }

  private checkRaceEnd(dt: number): void {
    const s = this.game.session!;
    const m = this.mode;
    const over = m ? m.isOver() : s.state === 'finished';
    if (over && this.resultsTimer < 0) {
      this.resultsTimer = 3.8;
      if (s.player) this.director.finish(s.player);
      this.hud.show(false);
    }
    if (this.resultsTimer >= 0) {
      this.resultsTimer -= dt;
      if (this.resultsTimer < 0 && this.state === 'race') {
        this.state = 'results';
        const r = m ? m.results() : this.defaultResults();
        this.menus.showResults(r);
        this.audio.setIntensity(0.4);
      }
    }
  }

  private defaultResults(): ResultsData {
    return { mode: 'race', title: '-', subtitle: '', record: null, rows: [], stats: [] };
  }

  // ------------------------------------------------------------------ HUD
  private buildHud(dt: number): HudModel | null {
    const s = this.game.session;
    const p = s?.player;
    if (!s || !p) return null;
    const b = p.body;
    const units = settings.get('units');
    const speed = units === 'mph' ? b.speedKmh * 0.621371 : b.speedKmh;
    const L = s.track.length;
    const lapsDone = Math.floor(b.progress / L);
    const lap = clamp(lapsDone + 1, 1, s.laps);
    let standings: StandingRow[] | null = null;
    if (s.cfg.mode === 'race') {
      const leader = s.standings[0];
      standings = s.standings.map((c) => {
        let gap = '';
        if (c === leader) gap = 'LEADER';
        else if (c.finished && leader.finished) gap = `+${(c.finishTime - leader.finishTime).toFixed(1)}`;
        else {
          const dp = leader.body.progress - c.body.progress;
          const v = Math.max(20, Math.abs(c.body.vf));
          gap = dp > L ? `+${Math.floor(dp / L)}LAP` : `+${(dp / v).toFixed(1)}`;
        }
        return { name: c.name, color: '#' + new THREE.Color(c.paint.glow).getHexString(), gap, me: c === p };
      });
    }
    const dots: MapDot[] = s.cars.map((c) => ({
      s: c.renderS,
      d: c.renderD,
      color: '#' + new THREE.Color(c.paint.glow).getHexString(),
      me: c === p,
    }));
    this.mode?.mapDots(dots);
    const heading = Math.atan2(p.forward.x, -p.forward.z);
    const lapTime = s.time - p.lapStart;
    const lastLap = p.lapTimes.length ? p.lapTimes[p.lapTimes.length - 1] : 0;
    const hm: HudModel = {
      mode: s.cfg.mode === 'attract' ? 'attract' : s.cfg.mode,
      position: p.position,
      total: s.cars.length,
      lap,
      laps: s.laps,
      raceTime: Math.max(0, s.time),
      lapTime: Math.max(0, s.state === 'countdown' ? 0 : lapTime),
      bestLap: p.bestLap,
      lastLap,
      delta: null,
      speedo: {
        speed,
        unit: units === 'mph' ? 'MPH' : 'KM/H',
        rpmNorm: b.rpmNorm,
        redline: p.spec.redline,
        gear: b.gear,
        reverse: b.vf < -0.5,
        nitro: b.nitro,
        nitroActive: b.nitroActive,
        drift: b.drifting ? this.driftProgress(b.driftCharge, b.driftLevel) : 0,
        driftLevel: b.driftLevel,
        drifting: b.drifting,
        boost: b.boostTime > 0,
        startZone: s.state === 'countdown',
        time: this.game.world!.time,
      },
      standings,
      dots,
      heading,
      drift: { active: b.drifting, score: b.driftScore, level: b.driftLevel },
      rush: null,
    };
    this.mode?.fillHud(hm);
    void dt;
    return hm;
  }

  private driftProgress(charge: number, level: number): number {
    const th = [0, 0.8, 1.8, 3.0];
    if (level >= 3) return 1;
    return clamp((charge - th[level]) / (th[level + 1] - th[level]), 0, 1);
  }

  // ------------------------------------------------------------------ events → HUD
  private wireEvents(): void {
    const ev = this.game.events;
    const isP = (c: Vehicle) => c === this.game.session?.player;
    ev.on('countdown', ({ n }) => this.hud.countdown(n));
    ev.on('startResult', ({ quality }) => {
      if (quality === 'perfect') this.hud.toast('PERFECT START!', 'gold', '완벽한 출발');
      else if (quality === 'good') this.hud.toast('GOOD START', 'good');
      else if (quality === 'spin') this.hud.toast('WHEELSPIN!', 'warn', '너무 높은 RPM');
    });
    ev.on('nearMiss', ({ car, points }) => {
      if (isP(car) && this.game.session?.cfg.mode !== 'rush') this.hud.toast('NEAR MISS', 'good', `+${points}`);
    });
    ev.on('driftEnd', ({ car, level, score }) => {
      if (!isP(car) || level <= 0) return;
      const names = ['', 'BLUE', 'ORANGE', 'PURPLE'];
      this.hud.toast(`${names[level]} BOOST`, level === 3 ? 'great' : 'good', formatInt(score));
    });
    ev.on('boost', ({ car, kind }) => {
      if (!isP(car)) return;
      if (kind === 'slingshot') this.hud.toast('SLINGSHOT!', 'great');
      if (kind === 'pad') this.hud.toast('BOOST', 'good');
    });
    ev.on('slipstream', ({ car }) => {
      if (isP(car)) this.hud.toast('SLIPSTREAM', 'info', '옆으로 빠져 추월!', 1.2);
    });
    ev.on('overtake', ({ car, position }) => {
      if (isP(car)) this.hud.toast(`OVERTAKE`, 'good', `${position}${ordinal(position)}`);
    });
    ev.on('lap', ({ car, lap, lapTime, best }) => {
      const s = this.game.session;
      if (!isP(car) || !s || s.cfg.mode === 'rush') return;
      if (lap > this.lastLapShown && lap < s.laps) {
        this.lastLapShown = lap;
        this.hud.toast(best && lap > 1 ? 'BEST LAP' : `LAP ${lap}`, best && lap > 1 ? 'gold' : 'info', formatTime(lapTime));
      }
    });
    ev.on('finalLap', () => {
      this.hud.banner('FINAL LAP', '마지막 랩!');
      this.audio.setIntensity(1);
    });
    ev.on('finish', ({ car, position }) => {
      if (!isP(car)) return;
      const s = this.game.session;
      if (s?.cfg.mode === 'race') this.hud.banner('FINISH', `${position}${ordinal(position)} PLACE`, '', 3200);
      else this.hud.banner('FINISH', '', '', 3000);
      if (s && (s.cfg.mode !== 'race' || position <= 3)) this.celebrate(position);
    });
    ev.on('wrongWay', ({ on }) => this.hud.wrongWay(on));
    ev.on('respawn', ({ car }) => {
      if (isP(car)) this.hud.toast('RESPAWN', 'info', '트랙 복귀', 1);
    });
    ev.on('landing', ({ car, airTime }) => {
      if (isP(car) && airTime > 0.55) this.hud.toast('AIR TIME', 'good', `${airTime.toFixed(1)}s`);
    });
  }

  /** Fireworks over the finish line (more for a win). */
  private celebrate(position: number): void {
    const s = this.game.session;
    const fx = this.game.fx;
    if (!s || !fx) return;
    const bursts = position === 1 ? 14 : 7;
    const base = new THREE.Vector3();
    const fr = s.track.sample(0, { s: 0, pos: base, T: new THREE.Vector3(), R: new THREE.Vector3(), U: new THREE.Vector3(), kappa: 0, kappaV: 0, tau: 0, metric: 1, halfWidth: 9, flags: 0 });
    for (let i = 0; i < bursts; i++) {
      setTimeout(() => {
        const p = fr.pos
          .clone()
          .addScaledVector(fr.R, (Math.random() - 0.5) * 50)
          .addScaledVector(fr.T, (Math.random() - 0.2) * 80)
          .add(new THREE.Vector3(0, 28 + Math.random() * 25, 0));
        fx.firework(p);
      }, i * 260 + Math.random() * 200);
    }
  }

  // ------------------------------------------------------------------ audio frame
  private updateAudio(dt: number): void {
    const g = this.game;
    const f = this.frameObj;
    const cam = g.rig.camera;
    f.dt = dt;
    f.timeScale = g.timeScale;
    // Only a real pause muffles the music; results and the showroom just let the cars go quiet.
    f.paused = g.paused;
    const quiet = this.state === 'results' || this.state === 'menu' || this.state === 'boot' || !!g.sceneOverride;
    const L = f.listener;
    L.pos.copy(cam.position);
    cam.getWorldDirection(L.forward);
    L.up.copy(cam.up);
    L.right.crossVectors(L.forward, cam.up).normalize();
    if (dt > 0) {
      this.listenerVel.copy(cam.position).sub(this.lastCamPos).multiplyScalar(1 / dt);
      if (this.listenerVel.lengthSq() > 150 * 150) this.listenerVel.set(0, 0, 0);
    }
    this.lastCamPos.copy(cam.position);
    L.velocity.copy(this.listenerVel);
    const s = g.session;
    const focus = g.rig.target;
    f.others.length = 0;
    f.player = null;
    if (s && focus && !quiet) {
      const b = focus.body;
      const inTunnel = (s.track.flagsAt(focus.renderS) & 1) !== 0;
      this.tunnelMix += ((inTunnel ? 1 : 0) - this.tunnelMix) * Math.min(1, dt * 4);
      f.player = {
        id: focus.id,
        pos: focus.pos,
        velocity: focus.velocity,
        rpm: b.rpm,
        rpmNorm: b.rpmNorm,
        throttle: b.throttle,
        engine: focus.spec.engine,
        redline: focus.spec.redline,
        gear: b.gear,
        speed: Math.abs(b.vf),
        speedNorm: Math.abs(b.vf) / focus.spec.vTop,
        slip: clamp(b.drifting ? 0.6 + Math.abs(b.driftAngle) : (Math.abs(b.slipAngle) - 0.06) * 6, 0, 1) * (b.grounded ? 1 : 0),
        drifting: b.drifting,
        nitro: b.nitroActive,
        boost: b.boostTime > 0 ? 1 : 0,
        scrape: b.scrape,
        onCurb: b.onCurb,
        airborne: !b.grounded,
        tunnel: this.tunnelMix,
      };
      for (const c of s.cars) {
        if (c === focus) continue;
        f.others.push({
          id: c.id,
          pos: c.pos,
          velocity: c.velocity,
          rpm: c.body.rpm,
          rpmNorm: c.body.rpmNorm,
          throttle: c.body.throttle,
          engine: c.spec.engine,
          redline: c.spec.redline,
        });
      }
      this.mode?.audioOthers(f.others);
    }
    this.audio.update(f);
  }

  /** Results helper shared by modes. */
  static placeLabel(p: number): string {
    return `${p}${ordinal(p)}`;
  }

  recordsTouch(): void {
    saveRecords();
    void getRecords;
  }
}
