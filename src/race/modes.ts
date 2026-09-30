import * as THREE from 'three';
import type { Game } from '../game/Game';
import type { Session } from './Session';
import type { Hud, HudModel } from '../ui/Hud';
import type { MapDot } from '../ui/Gauges';
import type { ModeId, ResultsData } from '../ui/Menus';
import { getRecords, saveRecords, saveGhost, loadGhost } from '../core/Storage';
import { formatInt, formatTime, ordinal } from '../core/math';
import { Vehicle } from '../vehicle/Vehicle';
import { speedProfileFor } from '../ai/AIDriver';
import { lapTimeOf } from '../track/RacingLine';
import { RushMode } from './RushMode';
import { ModeController } from './ModeController';
export { ModeController } from './ModeController';
export type { AudioOther } from './ModeController';

// ---------------------------------------------------------------------------

export class RaceMode extends ModeController {
  private saved = false;

  results(): ResultsData {
    const s = this.session;
    const p = s.player!;
    const res = s.results();
    const me = res.find((r) => r.car === p)!;
    const rec = getRecords();
    const trackId = s.track.def.id;
    let record: string | null = null;
    if (!this.saved) {
      this.saved = true;
      rec.races++;
      if (me.position === 1) rec.wins++;
      const key = `${trackId}:${p.spec.id}`;
      if (isFinite(p.bestLap)) {
        if (!(rec.bestLap[key] <= p.bestLap)) rec.bestLap[key] = p.bestLap;
        if (!(rec.bestLapAny[trackId] <= p.bestLap)) {
          rec.bestLapAny[trackId] = p.bestLap;
          record = 'NEW LAP RECORD · 코스 레코드 갱신!';
        }
      }
      if (me.position === 1 && !(rec.bestRace[trackId] <= me.time)) {
        rec.bestRace[trackId] = me.time;
        record = record ?? 'NEW RACE RECORD · 최고 기록!';
      }
      saveRecords();
    }
    const leaderTime = res[0].time;
    return {
      mode: 'race',
      title: `${me.position}${ordinal(me.position)}`,
      subtitle: me.position === 1 ? 'VICTORY · 우승!' : me.position <= 3 ? 'PODIUM · 시상대 입성' : 'FINISH',
      record,
      rows: res.map((r) => ({
        pos: String(r.position),
        name: r.car.isPlayer ? `${r.car.name} · ${r.car.spec.name}` : `${r.car.name} · ${r.car.spec.name}`,
        time: r.position === 1 ? formatTime(r.time) : `+${(r.time - leaderTime).toFixed(3)}${r.finished ? '' : '*'}`,
        best: isFinite(r.bestLap) ? formatTime(r.bestLap) : '-',
        me: r.car === p,
      })),
      stats: [{ k: '최고 랩', v: isFinite(p.bestLap) ? formatTime(p.bestLap) : '-' }, ...this.commonStats().slice(0, 3)],
    };
  }
}

// ---------------------------------------------------------------------------

const GHOST_HZ = 30;

/** Solo laps against your own best-lap hologram, with a live delta. */
export class TimeAttackMode extends ModeController {
  private ghost: Vehicle | null = null;
  private best: Float32Array | null; // [s,d,h,theta] × n at 30 Hz, lap-relative
  private bestTimeAtS: Float32Array | null = null; // time at each metre of the best lap
  private rec: number[] = [];
  private recTimer = 0;
  private lapIndex = 0;
  private delta: number | null = null;
  private readonly key: string;
  private medalRef: number;
  private newRecord = false;
  private readonly unsub: () => void;

  constructor(game: Game, session: Session, hud: Hud) {
    super(game, session, hud);
    const p = session.player!;
    this.key = `${session.track.def.id}:${p.spec.id}`;
    this.best = loadGhost(this.key);
    if (this.best) this.bestTimeAtS = this.timeTable(this.best);
    const prof = speedProfileFor(session.track, p.spec);
    this.medalRef = lapTimeOf(session.track, prof);
    this.unsub = game.events.on('lap', ({ car, lapTime }) => {
      if (car !== p) return;
      this.onLap(lapTime);
    });
    // record in the fixed simulation step (frame-rate independent)
    session.onFixedStep = (dt) => {
      if (session.state !== 'racing' || p.body.progress < 0) return;
      if (this.rec.length === 0 && this.lapIndex === 0) {
        // lap 1 is timed from GO but recording starts at the line: pad so playback lines up
        const pad = Math.floor((session.time - p.lapStart) * GHOST_HZ);
        const b = p.body;
        for (let i = 0; i < pad; i++) this.rec.push(b.s, b.d, b.h, b.theta);
      }
      this.recTimer += dt;
      while (this.recTimer >= 1 / GHOST_HZ) {
        this.recTimer -= 1 / GHOST_HZ;
        const b = p.body;
        this.rec.push(b.s, b.d, b.h, b.theta);
      }
    };
    this.makeGhost();
  }

  private makeGhost(): void {
    const s = this.session;
    const p = s.player!;
    const g = new Vehicle(99, 'GHOST', p.spec, p.paint, 'ghost', 0);
    g.body.noCollide = true;
    const holo = new THREE.MeshBasicMaterial({
      color: new THREE.Color(0.3, 1.6, 2.4),
      transparent: true,
      opacity: 0.22,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    g.model.root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) {
        m.material = holo;
        m.castShadow = false;
      }
    });
    g.model.shadow.visible = false;
    g.visible = false;
    s.world.scene.add(g.model.root);
    this.ghost = g;
  }

  /** time (s) at which the recorded lap passed each metre of s */
  private timeTable(data: Float32Array): Float32Array {
    const L = this.session.track.length;
    const n = Math.floor(data.length / 4);
    const out = new Float32Array(Math.ceil(L) + 1).fill(-1);
    let prevS = -1;
    for (let i = 0; i < n; i++) {
      const s = data[i * 4];
      const si = Math.floor(s);
      if (si > prevS) {
        for (let k = Math.max(0, prevS + 1); k <= si && k < out.length; k++) out[k] = i / GHOST_HZ;
        prevS = si;
      }
    }
    return out;
  }

  private onLap(lapTime: number): void {
    const s = this.session;
    const p = s.player!;
    const data = new Float32Array(this.rec);
    const valid = this.lapIndex >= 1; // lap 1 includes the standing start
    const prevBest = getRecords().bestLap[this.key];
    if (data.length > 40 && (lapTime < (prevBest ?? Infinity) || !this.best)) {
      this.best = data;
      this.bestTimeAtS = this.timeTable(data);
      saveGhost(this.key, data);
      const rec = getRecords();
      if (!(rec.bestLap[this.key] <= lapTime)) rec.bestLap[this.key] = lapTime;
      if (!(rec.bestLapAny[s.track.def.id] <= lapTime)) {
        rec.bestLapAny[s.track.def.id] = lapTime;
        this.newRecord = true;
        this.hud.toast('COURSE RECORD', 'gold', formatTime(lapTime), 2.2);
      }
      saveRecords();
    }
    void valid;
    void p;
    this.rec = [];
    this.recTimer = 0;
    this.lapIndex++;
  }

  override update(dt: number): void {
    const s = this.session;
    const p = s.player!;
    if (s.state !== 'racing') {
      if (this.ghost) this.ghost.visible = false;
      return;
    }
    const L = s.track.length;
    const b = p.body;
    const inLap = b.progress >= 0;
    // ghost playback relative to the current lap start
    const g = this.ghost;
    if (g && this.best && inLap) {
      const t = s.time - p.lapStart;
      const n = Math.floor(this.best.length / 4);
      const f = t * GHOST_HZ;
      const i = Math.min(n - 2, Math.floor(f));
      if (i >= 0 && f < n - 1) {
        const a = this.best, k = f - i;
        const j = i + 1;
        let ds = a[j * 4] - a[i * 4];
        if (ds < -L / 2) ds += L;
        g.body.s = s.track.wrap(a[i * 4] + ds * k);
        g.body.d = a[i * 4 + 1] + (a[j * 4 + 1] - a[i * 4 + 1]) * k;
        g.body.h = a[i * 4 + 2] + (a[j * 4 + 2] - a[i * 4 + 2]) * k;
        g.body.theta = a[i * 4 + 3] + (a[j * 4 + 3] - a[i * 4 + 3]) * k;
        g.body.vf = ds * GHOST_HZ;
        g.snap();
        g.updateVisual(s.track, 1, dt);
        const dist = g.pos.distanceTo(p.pos);
        g.visible = true;
        g.model.root.visible = dist > 3;
      } else g.visible = false;
    }
    // live delta vs best lap at the same point on track
    if (this.bestTimeAtS && inLap) {
      const si = Math.floor(b.s);
      const tb = this.bestTimeAtS[si];
      this.delta = tb >= 0 ? s.time - p.lapStart - tb : null;
    }
  }

  override fillHud(hm: HudModel): void {
    hm.delta = this.delta;
  }

  override mapDots(dots: MapDot[]): void {
    const g = this.ghost;
    if (g && g.visible) dots.push({ s: g.body.s, d: g.body.d, color: '#5ae0ff', ghost: true });
  }

  results(): ResultsData {
    const p = this.session.player!;
    const best = p.bestLap;
    const ref = this.medalRef;
    const medal = best <= ref * 1.03 ? 'GOLD' : best <= ref * 1.08 ? 'SILVER' : best <= ref * 1.15 ? 'BRONZE' : null;
    const medalKo = medal === 'GOLD' ? '금메달' : medal === 'SILVER' ? '은메달' : medal === 'BRONZE' ? '동메달' : '메달 없음';
    return {
      mode: 'timeattack',
      title: isFinite(best) ? formatTime(best) : '-:--.---',
      subtitle: `BEST LAP · ${medal ?? 'NO MEDAL'} · ${medalKo}`,
      record: this.newRecord ? 'NEW COURSE RECORD · 코스 레코드!' : null,
      rows: [
        ...p.lapTimes.map((t, i) => ({ pos: `L${i + 1}`, name: `LAP ${i + 1}`, time: formatTime(t), best: t === best ? '★ BEST' : '', me: t === best })),
        { pos: '🥇', name: 'GOLD 목표', time: formatTime(ref * 1.03), best: '', me: false },
        { pos: '🥈', name: 'SILVER 목표', time: formatTime(ref * 1.08), best: '', me: false },
        { pos: '🥉', name: 'BRONZE 목표', time: formatTime(ref * 1.15), best: '', me: false },
      ],
      stats: this.commonStats(),
    };
  }

  override dispose(): void {
    this.unsub();
    this.session.onFixedStep = null;
    if (this.ghost) {
      this.ghost.model.root.removeFromParent();
      this.ghost.dispose();
    }
  }
}

export function createMode(mode: ModeId, game: Game, session: Session, hud: Hud): ModeController {
  if (mode === 'timeattack') return new TimeAttackMode(game, session, hud);
  if (mode === 'rush') return new RushMode(game, session, hud);
  return new RaceMode(game, session, hud);
}

export type { ModeId };
