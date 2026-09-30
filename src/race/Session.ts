import type { World } from '../world/World';
import type { Track } from '../track/Track';
import { Vehicle } from '../vehicle/Vehicle';
import { CARS, type CarSpec } from '../vehicle/specs';
import { AIDriver } from '../ai/AIDriver';
import { collidePair, type Contact } from '../vehicle/Collision';
import { gridSlot } from './grid';
import type { GameEvents } from '../core/Events';
import type { Difficulty } from '../core/Settings';
import { Rng } from '../core/rng';
import { clamp, smoothstep } from '../core/math';

export type SessionMode = 'race' | 'timeattack' | 'rush' | 'attract';
export type SessionState = 'intro' | 'countdown' | 'racing' | 'finished';

export interface SessionConfig {
  mode: SessionMode;
  car: CarSpec;
  paint: number;
  laps: number;
  difficulty: Difficulty;
  opponents: number;
  autopilot?: boolean;
  seed?: number;
}

const RIVALS = ['VIPER', 'NOVA', 'RONIN', 'BLAZE', 'ECHO', 'KAIJU', 'ZERO', 'HAVOC', 'SPECTRE', 'JINX'];

const DIFF: Record<Difficulty, { skill: [number, number]; rubber: number }> = {
  easy: { skill: [0.86, 0.9], rubber: 0.1 },
  normal: { skill: [0.925, 0.965], rubber: 0.06 },
  hard: { skill: [0.975, 1.005], rubber: 0.035 },
  insane: { skill: [1.005, 1.035], rubber: 0.02 },
};

interface PairState {
  active: boolean;
  startSign: number;
  minGap: number;
  touched: boolean;
  maxRel: number;
}

export interface Standing {
  car: Vehicle;
  position: number;
  time: number; // finish or projected time
  finished: boolean;
  bestLap: number;
}

export class Session {
  readonly world: World;
  readonly track: Track;
  readonly cfg: SessionConfig;
  readonly events: GameEvents;
  readonly cars: Vehicle[] = [];
  player: Vehicle | null = null;
  readonly drivers = new Map<Vehicle, AIDriver>();
  playerDriver: AIDriver | null = null;
  state: SessionState = 'intro';
  /** Race clock (s since GO). Negative during the countdown. */
  time = 0;
  countdown = 3;
  private lastBeep = 4;
  finishOrder: Vehicle[] = [];
  standings: Vehicle[] = [];
  private pairs = new Map<string, PairState>();
  private contact: Contact = { impact: 0, nS: 0, nD: 0, s: 0, d: 0 };
  wrongWay = false;
  private wrongTimer = 0;
  finalLapAnnounced = false;
  playerFinishedAt = -1;
  /** Seconds the player has been effectively stuck. */
  private playerStuck = 0;
  readonly rng: Rng;
  onRespawn: ((car: Vehicle) => void) | null = null;
  /** Mode hook executed at the end of every fixed step (e.g. traffic). */
  onFixedStep: ((dt: number) => void) | null = null;
  /** Ignore player input (coast) — used after time-up / finish. */
  inputLocked = false;

  constructor(world: World, cfg: SessionConfig, events: GameEvents) {
    this.world = world;
    this.track = world.track;
    this.cfg = cfg;
    this.events = events;
    this.rng = new Rng(cfg.seed ?? 77);
    this.setupCars();
  }

  private setupCars(): void {
    const cfg = this.cfg;
    const rng = this.rng;
    const diff = DIFF[cfg.difficulty];
    const total = cfg.mode === 'attract' ? 8 : 1 + cfg.opponents;
    const playerSlot = cfg.mode === 'race' ? Math.min(5, total - 1) : 0;
    const names = rng.shuffle(RIVALS.slice());
    let nameIdx = 0;
    for (let i = 0; i < total; i++) {
      const isPlayer = cfg.mode !== 'attract' && i === playerSlot;
      let spec: CarSpec;
      let paintIdx: number;
      if (isPlayer) {
        spec = cfg.car;
        paintIdx = cfg.paint;
      } else {
        spec = CARS[(i + rng.int(0, 3)) % CARS.length];
        paintIdx = rng.int(0, spec.paints.length - 1);
      }
      const name = isPlayer ? 'YOU' : names[nameIdx++ % names.length];
      const car = new Vehicle(i, name, spec, spec.paints[paintIdx], isPlayer ? 'player' : 'ai', isPlayer ? 1 : 1);
      car.events = this.events;
      const g = gridSlot(i);
      car.body.place(this.track.wrap(g.s), g.d, 0);
      car.body.progress = g.s;
      car.startProgress = g.s;
      car.body.frozen = true;
      car.body.brakeDrift = isPlayer && !cfg.autopilot;
      car.snap();
      this.cars.push(car);
      this.world.scene.add(car.model.root);
      if (isPlayer) {
        this.player = car;
        if (cfg.autopilot) {
          this.playerDriver = new AIDriver(0.97, 0.5, 991);
        }
      } else {
        const skill = rng.range(diff.skill[0], diff.skill[1]) * (cfg.mode === 'attract' ? 1 : 1);
        this.drivers.set(car, new AIDriver(skill, rng.next(), i * 31 + 7));
      }
    }
    // grid order = starting positions
    this.standings = this.cars.slice().sort((a, b) => b.body.progress - a.body.progress);
    this.standings.forEach((c, i) => {
      c.position = i + 1;
      c.lastPosition = i + 1;
    });
  }

  get laps(): number {
    return this.cfg.laps;
  }

  startCountdown(): void {
    this.state = 'countdown';
    this.countdown = 3.0;
    this.lastBeep = 4;
    this.time = -3;
  }

  /** Skip straight to racing (debug / attract). */
  startImmediately(): void {
    this.state = 'racing';
    this.time = 0;
    for (const c of this.cars) c.body.launch('none');
  }

  // -------------------------------------------------------------------------
  fixedUpdate(dt: number, playerInputSource: (car: Vehicle) => void): void {
    const track = this.track;
    const racing = this.state === 'racing' || this.state === 'finished';

    if (this.state === 'countdown') {
      this.countdown -= dt;
      this.time = -this.countdown;
      const n = Math.ceil(this.countdown);
      if (n < this.lastBeep && n >= 1) {
        this.lastBeep = n;
        this.events.emit('countdown', { n });
      }
      if (this.countdown <= 0) {
        this.state = 'racing';
        this.time = 0;
        this.events.emit('countdown', { n: 0 });
        for (const c of this.cars) {
          let q: 'perfect' | 'good' | 'spin' | 'none' = 'none';
          if (c.isPlayer && !this.playerDriver) {
            const r = c.body.rpmNorm;
            if (c.body.throttle > 0.4) {
              if (r > 0.6 && r < 0.84) q = 'perfect';
              else if (r > 0.42 && r < 0.95) q = 'good';
              else if (r >= 0.95) q = 'spin';
            }
          } else {
            const x = this.rng.next();
            q = x < 0.3 ? 'good' : x < 0.4 ? 'perfect' : 'none';
          }
          c.body.launch(q);
          if (c.isPlayer) this.events.emit('startResult', { car: c, quality: q });
        }
      }
    } else if (racing) {
      this.time += dt;
    }

    // --- inputs
    const leader = this.standings[0];
    for (const car of this.cars) {
      if (car.isPlayer) {
        if (this.playerDriver) {
          this.playerDriver.update(car, this.cars, track, dt, { playerGap: 0, rubber: 0, raceActive: racing, noRubber: true, time: this.time });
        } else if (this.inputLocked) {
          const i = car.input;
          i.throttle = 0; i.brake = 0.25; i.steer *= 0.9; i.drift = false; i.nitro = false;
        } else {
          playerInputSource(car);
          if (this.state === 'countdown' || this.state === 'intro') {
            car.input.steer = 0;
          }
        }
        continue;
      }
      const drv = this.drivers.get(car)!;
      const p = this.player;
      const gap = p ? p.body.progress - car.body.progress : 0;
      const lastStretch = p ? p.body.progress > (this.laps * track.length - 400) : false;
      const stuck = drv.update(car, this.cars, track, dt, {
        playerGap: this.cfg.mode === 'attract' ? (leader ? leader.body.progress - car.body.progress : 0) * 0.3 : gap,
        rubber: this.cfg.mode === 'race' || this.cfg.mode === 'attract' ? DIFF[this.cfg.difficulty].rubber : 0,
        raceActive: racing,
        noRubber: lastStretch || car.finished,
        time: this.time,
      });
      if (stuck) this.respawn(car);
    }

    // --- slipstream targets
    for (const car of this.cars) {
      let best = 0;
      const b = car.body;
      for (const o of this.cars) {
        if (o === car || o.body.noCollide) continue;
        const ds = track.delta(b.s, o.body.s);
        const dd = Math.abs(o.body.d - b.d);
        if (ds > 2 && ds < 40 && dd < 1.8) {
          const f = (1 - ds / 40) * (1 - dd / 1.8) * smoothstep(25, 45, b.vf);
          if (f > best) best = f;
        }
      }
      b.draftTarget = best;
    }

    // --- physics
    for (const car of this.cars) {
      car.saveState();
      car.body.step(car.input, dt, track);
    }

    // --- car-car collisions
    const n = this.cars.length;
    for (let i = 0; i < n; i++) {
      const a = this.cars[i];
      if (a.body.noCollide || a.body.ghostTime > 0) continue;
      for (let j = i + 1; j < n; j++) {
        const b = this.cars[j];
        if (b.body.noCollide || b.body.ghostTime > 0) continue;
        const c = collidePair(a.body, b.body, track, 0.25, this.contact);
        if (c) {
          this.markTouched(a, b);
          if (c.impact > 1.5) this.events.emit('carHit', { a, b, impact: c.impact, s: c.s, d: c.d });
        }
      }
    }

    for (const car of this.cars) car.captureState();

    if (racing) {
      this.updateRaceLogic(dt);
      this.updateNearMisses();
    }
    this.onFixedStep?.(dt);
  }

  private pairKey(a: Vehicle, b: Vehicle): string {
    return a.id < b.id ? `${a.id}-${b.id}` : `${b.id}-${a.id}`;
  }

  private markTouched(a: Vehicle, b: Vehicle): void {
    const st = this.pairs.get(this.pairKey(a, b));
    if (st) st.touched = true;
  }

  private updateNearMisses(): void {
    const p = this.player;
    if (!p) return;
    const track = this.track;
    const pb = p.body;
    for (const o of this.cars) {
      if (o === p || o.body.noCollide) continue;
      const key = this.pairKey(p, o);
      let st = this.pairs.get(key);
      if (!st) this.pairs.set(key, (st = { active: false, startSign: 0, minGap: 99, touched: false, maxRel: 0 }));
      const ds = track.delta(pb.s, o.body.s);
      const reach = (p.spec.length + o.spec.length) / 2 + 2;
      const ob = o.body;
      const ext = (bd: typeof pb) => bd.halfW * Math.abs(Math.cos(bd.theta)) + bd.halfL * Math.abs(Math.sin(bd.theta));
      if (Math.abs(ds) < reach) {
        if (!st.active) {
          st.active = true;
          st.startSign = Math.sign(ds) || 1;
          st.minGap = 99;
          st.touched = false;
          st.maxRel = 0;
        }
        const gap = Math.abs(ob.d - pb.d) - (ext(pb) + ext(ob));
        st.minGap = Math.min(st.minGap, gap);
        st.maxRel = Math.max(st.maxRel, Math.abs(pb.vf - ob.vf));
      } else if (st.active) {
        st.active = false;
        const endSign = Math.sign(ds) || 1;
        if (endSign !== st.startSign && !st.touched && st.minGap < 1.0 && st.maxRel > 8 && pb.vf > 28) {
          const side = Math.sign(ob.d - pb.d) || 1;
          p.nearMisses++;
          pb.addNitro(0.07);
          this.events.emit('nearMiss', { car: p, other: o, side, speed: pb.vf, oncoming: false, points: 250 });
        }
      }
    }
  }

  private updateRaceLogic(dt: number): void {
    const track = this.track;
    const L = track.length;
    const laps = this.laps;
    const endless = this.cfg.mode === 'attract' || this.cfg.mode === 'rush';
    for (const car of this.cars) {
      const b = car.body;
      car.topSpeed = Math.max(car.topSpeed, b.speedKmh);
      const lapsDone = Math.floor(b.progress / L);
      // lap completion (lapsDone 0 = crossed the line once from the grid)
      if (lapsDone > car.lap && lapsDone >= 1) {
        // crossing time interpolated inside the step
        const over = b.progress - lapsDone * L;
        const cross = this.time - over / Math.max(1, b.sdot);
        const lapTime = cross - car.lapStart;
        car.lapStart = cross;
        car.lapTimes.push(lapTime);
        const best = lapTime < car.bestLap;
        if (best) car.bestLap = lapTime;
        car.lap = lapsDone;
        this.events.emit('lap', { car, lap: lapsDone, lapTime, best, personalBest: best });
        if (!endless && lapsDone >= laps && !car.finished) {
          car.finished = true;
          car.finishTime = cross;
          this.finishOrder.push(car);
          this.events.emit('finish', { car, position: this.finishOrder.length, time: cross });
          if (car.isPlayer) {
            this.state = 'finished';
            this.playerFinishedAt = this.time;
            // the cool-down lap is driven by the AI so the finish shots look good
            if (!this.playerDriver) this.playerDriver = new AIDriver(0.8, 0.2, 4242);
          }
        }
        if (car.isPlayer && !endless && lapsDone === laps - 1 && !this.finalLapAnnounced) {
          this.finalLapAnnounced = true;
          this.events.emit('finalLap', {});
        }
      } else if (lapsDone > car.lap) {
        car.lap = lapsDone;
      }
      // sector splits (player only): sectors end at L/3 and 2L/3 of each lap
      if (car.isPlayer && b.progress > 0) {
        const lapPos = b.progress - Math.floor(b.progress / L) * L;
        const sec = Math.min(2, Math.floor(lapPos / (L / 3)));
        if (sec > car.sector) {
          const t = this.time - car.lapStart;
          car.sectorTimes.push(t);
          this.events.emit('sector', { car, sector: sec, time: t, delta: null });
        }
        car.sector = sec;
      }
    }

    // standings: finished first (by finish order), then by progress
    const prevPos = this.player ? this.player.position : 0;
    this.standings = this.cars.slice().sort((a, b) => {
      if (a.finished && b.finished) return a.finishTime - b.finishTime;
      if (a.finished) return -1;
      if (b.finished) return 1;
      return b.body.progress - a.body.progress;
    });
    this.standings.forEach((c, i) => (c.position = i + 1));
    if (this.player && this.cfg.mode === 'race' && this.player.position < prevPos && this.time > 1.5 && !this.player.finished) {
      const passed = this.standings[this.player.position] ?? null;
      this.events.emit('overtake', { car: this.player, position: this.player.position, passed });
      this.player.body.addNitro(0.04);
    }

    // wrong way / stuck (player)
    const p = this.player;
    if (p && !p.finished && !this.playerDriver) {
      const b = p.body;
      const backwards = Math.abs(b.theta) > 1.9 && b.sdot < -3;
      this.wrongTimer = backwards ? this.wrongTimer + dt : Math.max(0, this.wrongTimer - dt * 2);
      const ww = this.wrongTimer > 1.2;
      if (ww !== this.wrongWay) {
        this.wrongWay = ww;
        this.events.emit('wrongWay', { on: ww });
      }
      if (Math.abs(b.vf) < 2 && this.time > 3) this.playerStuck += dt;
      else this.playerStuck = 0;
      if (this.playerStuck > 5 || this.wrongTimer > 7) {
        this.playerStuck = 0;
        this.wrongTimer = 0;
        this.respawn(p);
      }
    }
  }

  respawn(car: Vehicle): void {
    const track = this.track;
    const s = track.wrap(car.body.s - 12);
    const d = clamp(track.lerp(track.lineD, s), -3, 3);
    const lapBase = car.body.progress;
    car.body.respawn(track, s, d, 16);
    // keep progress continuous (moved back 12 m)
    car.body.progress = lapBase - 12;
    car.snap();
    this.events.emit('respawn', { car });
    this.onRespawn?.(car);
  }

  /** Final standings with projected times for unfinished cars. */
  results(): Standing[] {
    const L = this.track.length;
    const total = this.laps * L;
    return this.standings.map((car, i) => {
      let time = car.finishTime;
      if (!car.finished) {
        const remain = Math.max(0, total - car.body.progress);
        const avg = Math.max(20, car.body.progress / Math.max(1, this.time));
        time = this.time + remain / avg;
      }
      return { car, position: i + 1, time, finished: car.finished, bestLap: car.bestLap };
    });
  }

  dispose(): void {
    for (const c of this.cars) {
      this.world.scene.remove(c.model.root);
      c.dispose();
    }
    this.cars.length = 0;
  }
}
