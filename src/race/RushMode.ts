import * as THREE from 'three';
import { ModeController, type AudioOther } from './ModeController';
import type { Game } from '../game/Game';
import type { Session } from './Session';
import type { Hud, HudModel } from '../ui/Hud';
import type { MapDot } from '../ui/Gauges';
import type { ResultsData } from '../ui/Menus';
import { Traffic, type TrafficCar } from '../ai/Traffic';
import { collidePair, type Contact } from '../vehicle/Collision';
import { getRecords, saveRecords } from '../core/Storage';
import { formatInt } from '../core/math';
import { makeFrame } from '../track/Track';

const CP_SPACING = 1400;

/** OutRun/Burnout-style score attack through traffic against the clock. */
export class RushMode extends ModeController {
  private traffic: Traffic;
  timeLeft = 50;
  score = 0;
  multiplier = 1;
  private combo = 0;
  private comboTimer = 0;
  private maxCombo = 0;
  private crashes = 0;
  private nearMisses = 0;
  private nextCp = CP_SPACING;
  private cpCount = 0;
  private ended = false;
  private oncoming = false;
  private lastProgress = 0;
  private distance = 0;
  private gate: THREE.Group;
  private readonly contact: Contact = { impact: 0, nS: 0, nD: 0, s: 0, d: 0 };
  private readonly unsub: (() => void)[] = [];
  private newHigh = false;
  private audioList: AudioOther[] = [];
  private readonly fr = makeFrame();

  constructor(game: Game, session: Session, hud: Hud) {
    super(game, session, hud);
    const track = session.track;
    this.traffic = new Traffic(track, track.def.seed * 3 + 1, 46);
    this.traffic.density = 0.8;
    session.world.scene.add(this.traffic.group);
    this.traffic.reset(session.player!.body.s);
    this.gate = this.buildGate();
    session.world.scene.add(this.gate);
    this.placeGate();
    session.onFixedStep = (dt) => this.fixedStep(dt);
    const p = session.player!;
    this.unsub.push(
      game.events.on('driftEnd', ({ car, score }) => {
        if (car !== p || this.ended) return;
        const pts = Math.round(score * this.multiplier);
        if (pts > 50) {
          this.score += pts;
          this.hud.toast('DRIFT', 'great', `+${formatInt(pts)}`);
        }
      }),
    );
  }

  private buildGate(): THREE.Group {
    const g = new THREE.Group();
    const mat = new THREE.MeshBasicMaterial({ color: new THREE.Color(4.5, 3.6, 0.4) });
    const matB = new THREE.MeshBasicMaterial({ color: new THREE.Color(0.3, 3.2, 1.6) });
    const post = new THREE.BoxGeometry(0.5, 8, 0.5);
    const beam = new THREE.BoxGeometry(1, 0.6, 0.5);
    const l = new THREE.Mesh(post, mat), r = new THREE.Mesh(post, mat), t = new THREE.Mesh(beam, matB);
    l.position.y = r.position.y = 4;
    t.position.y = 8;
    l.name = 'l';
    r.name = 'r';
    t.name = 't';
    g.add(l, r, t);
    return g;
  }

  private placeGate(): void {
    const s = this.session;
    const cpS = s.track.wrap(this.nextCp);
    const fr = s.track.surface(cpS, 0, this.fr);
    const hw = fr.halfWidth;
    this.gate.position.copy(fr.pos);
    const m = new THREE.Matrix4().makeBasis(fr.R, fr.U, fr.T.clone().negate());
    this.gate.quaternion.setFromRotationMatrix(m);
    const [l, r, t] = ['l', 'r', 't'].map((n) => this.gate.getObjectByName(n)!);
    l.position.x = -hw - 0.6;
    r.position.x = hw + 0.6;
    t.scale.x = 2 * hw + 1.7;
  }

  /** Runs inside the 120 Hz simulation step. */
  private fixedStep(dt: number): void {
    const s = this.session;
    const p = s.player!;
    const pb = p.body;
    if (s.state !== 'racing' || this.ended) {
      if (s.state === 'racing') this.traffic.update(dt, pb.s);
      return;
    }
    this.traffic.update(dt, pb.s);
    const track = s.track;

    // collisions & near misses
    for (const c of this.traffic.cars) {
      if (!c.active || c.wreck > 0) continue;
      const hit = pb.ghostTime <= 0 ? collidePair(pb, c, track, 0.15, this.contact) : null;
      if (hit) {
        c.nmTouched = true;
        if (hit.impact > 5) this.crash(c, hit.impact);
      }
      // near miss bookkeeping
      const ds = track.delta(pb.s, c.s);
      const reach = pb.halfL + c.halfL + 2;
      const ext = pb.halfW * Math.abs(Math.cos(pb.theta)) + pb.halfL * Math.abs(Math.sin(pb.theta));
      if (Math.abs(ds) < reach) {
        if (!c.nmActive) {
          c.nmActive = true;
          c.nmSign = Math.sign(ds) || 1;
          c.nmGap = 99;
          c.nmTouched = false;
        }
        c.nmGap = Math.min(c.nmGap, Math.abs(c.d - pb.d) - ext - c.halfW);
      } else if (c.nmActive) {
        c.nmActive = false;
        if ((Math.sign(ds) || 1) !== c.nmSign && !c.nmTouched && c.nmGap < 1.3 && pb.vf > 25) {
          this.nearMiss(c);
        }
      }
    }

    // scoring: distance, oncoming bonus, speed
    const dp = Math.max(0, pb.progress - this.lastProgress);
    this.lastProgress = pb.progress;
    this.distance += dp;
    this.oncoming = this.traffic.isOncoming(pb.s, pb.d) && pb.vf > 15;
    const speedBonus = pb.speedKmh > 250 ? 1.5 : 1;
    this.score += dp * this.multiplier * (this.oncoming ? 2 : 1) * speedBonus;

    // combo decay
    if (this.combo > 0) {
      this.comboTimer -= dt;
      if (this.comboTimer <= 0) {
        this.combo = 0;
        this.multiplier = 1;
      }
    }

    // timer & checkpoints
    this.timeLeft -= dt;
    if (pb.progress >= this.nextCp) {
      this.cpCount++;
      const add = Math.max(14, 24 - this.cpCount);
      this.timeLeft += add;
      this.nextCp += CP_SPACING;
      this.placeGate();
      this.hud.toast('CHECKPOINT', 'gold', `+${add}s`, 1.8);
      this.game.events.emit('checkpoint', { added: add, index: this.cpCount });
      this.traffic.density = Math.min(1, 0.8 + this.cpCount * 0.05);
    }
    if (this.timeLeft <= 0) {
      this.timeLeft = 0;
      this.ended = true;
      s.inputLocked = true;
      this.game.timeScale = 0.4;
      this.hud.banner('TIME UP', `최종 점수 ${formatInt(this.score)}`, '', 3400);
      const rec = getRecords();
      const id = s.track.def.id;
      if (!(rec.rushHigh[id] >= this.score)) {
        rec.rushHigh[id] = Math.round(this.score);
        this.newHigh = true;
        saveRecords();
      }
    }
  }

  private nearMiss(c: TrafficCar): void {
    const onc = c.dir < 0;
    this.combo++;
    this.maxCombo = Math.max(this.maxCombo, this.combo);
    this.comboTimer = 3;
    this.multiplier = Math.min(5, 1 + 0.5 * Math.min(8, this.combo - 1));
    const pts = Math.round((onc ? 600 : 300) * this.multiplier);
    this.score += pts;
    this.nearMisses++;
    const p = this.session.player!;
    p.nearMisses++;
    p.body.addNitro(onc ? 0.1 : 0.06);
    this.hud.toast(onc ? 'ONCOMING NEAR MISS' : 'NEAR MISS', onc ? 'great' : 'good', `+${formatInt(pts)}${this.combo > 1 ? ` · x${this.multiplier.toFixed(1)}` : ''}`, 1.2);
    this.game.events.emit('nearMiss', { car: p, other: null, side: Math.sign(c.d - p.body.d) || 1, speed: p.body.vf, oncoming: onc, points: pts });
    if (this.combo > 1) this.game.events.emit('combo', { count: this.combo, multiplier: this.multiplier });
  }

  private crash(c: TrafficCar, impact: number): void {
    const p = this.session.player!;
    this.crashes++;
    this.combo = 0;
    this.multiplier = 1;
    this.timeLeft = Math.max(0, this.timeLeft - 1.5);
    const push = p.velocity.clone().multiplyScalar(0.6);
    this.traffic.wreckCar(c, push);
    p.body.ghostTime = 1.2;
    this.hud.toast('CRASH!', 'warn', '-1.5s', 1.2);
    this.game.events.emit('crash', { car: p, other: null, impact });
  }

  override update(_dt: number): void {
    this.traffic.render();
    // pulse the gate
    const t = this.session.world.time;
    this.gate.scale.setScalar(1 + Math.sin(t * 6) * 0.03);
  }

  override fillHud(hm: HudModel): void {
    const p = this.session.player!;
    hm.rush = {
      timeLeft: this.timeLeft,
      score: this.score,
      multiplier: this.multiplier * (this.oncoming ? 2 : 1),
      oncoming: this.oncoming,
      cpDist: this.nextCp - p.body.progress,
    };
  }

  override mapDots(dots: MapDot[]): void {
    for (const c of this.traffic.cars) {
      if (!c.active || c.wreck > 0) continue;
      dots.push({ s: c.s, d: c.d, color: c.dir > 0 ? '#8890a0' : '#ffcc66', ghost: true });
    }
  }

  override audioOthers(list: AudioOther[]): void {
    // add the closest traffic as engine voices (steady cruising revs)
    const p = this.session.player!;
    this.audioList.length = 0;
    for (const c of this.traffic.cars) {
      if (!c.active) continue;
      const pos = this.traffic.pos.get(c)!;
      if (pos.distanceToSquared(p.pos) > 120 * 120) continue;
      list.push({
        id: 1000 + c.id,
        pos,
        velocity: this.traffic.vel.get(c)!,
        rpm: 2600,
        rpmNorm: 0.3,
        throttle: 0.4,
        engine: { cylinders: 4, rasp: 0.2, body: 0.5, turbo: 0, pitch: 0.9 },
        redline: 6500,
      });
    }
  }

  override isOver(): boolean {
    return this.ended;
  }

  results(): ResultsData {
    const p = this.session.player!;
    const high = getRecords().rushHigh[this.session.track.def.id] ?? 0;
    return {
      mode: 'rush',
      title: formatInt(this.score),
      subtitle: `SCORE · 최고 ${formatInt(high)}`,
      record: this.newHigh ? 'NEW HIGH SCORE · 최고 점수 갱신!' : null,
      rows: [
        { pos: '📏', name: '주행 거리', time: `${(this.distance / 1000).toFixed(2)} km`, best: '', me: false },
        { pos: '⚡', name: '니어미스', time: String(this.nearMisses), best: `최대 콤보 x${this.maxCombo}`, me: false },
        { pos: '🏁', name: '체크포인트', time: String(this.cpCount), best: '', me: false },
        { pos: '💥', name: '충돌', time: String(this.crashes), best: '', me: false },
      ],
      stats: [
        { k: '최고 속도', v: `${Math.round(p.topSpeed)} km/h` },
        { k: '드리프트 점수', v: formatInt(p.driftTotal) },
        { k: '최대 배율', v: `x${(1 + 0.5 * Math.min(8, Math.max(0, this.maxCombo - 1))).toFixed(1)}` },
        { k: '공중 체공', v: `${p.airTotal.toFixed(1)}s` },
      ],
    };
  }

  override dispose(): void {
    for (const u of this.unsub) u();
    this.session.onFixedStep = null;
    this.traffic.group.removeFromParent();
    this.traffic.dispose();
    this.gate.removeFromParent();
    this.gate.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) {
        m.geometry.dispose();
        (m.material as THREE.Material).dispose();
      }
    });
  }
}
