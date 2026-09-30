import * as THREE from 'three';
import type { Vehicle } from '../vehicle/Vehicle';
import type { Track } from '../track/Track';
import { makeFrame } from '../track/Track';
import { computeSpeedProfile } from '../track/RacingLine';
import type { CarSpec } from '../vehicle/specs';
import { clamp, noise1 } from '../core/math';
import { F_LOOP } from '../track/types';
import { AIR_YAW } from '../vehicle/Physics';

const profileCache = new WeakMap<Track, Map<string, Float64Array>>();

export function speedProfileFor(track: Track, spec: CarSpec): Float64Array {
  let m = profileCache.get(track);
  if (!m) profileCache.set(track, (m = new Map()));
  let p = m.get(spec.id);
  if (!p) {
    p = computeSpeedProfile(track, {
      vTop: spec.vTop,
      aLat: spec.aLat * 0.86,
      aBrake: spec.brake * 0.82,
      accel: (v) => spec.accel * Math.max(0, 1 - Math.pow(v / spec.vTop, spec.accelExp)),
    });
    m.set(spec.id, p);
  }
  return p;
}

export interface AIContext {
  /** Positive when the player is ahead of this car (metres of progress). */
  playerGap: number;
  rubber: number; // 0..0.12
  raceActive: boolean;
  noRubber: boolean;
  time: number;
}

const fr = makeFrame();
const P = new THREE.Vector3();
const Q = new THREE.Vector3();
const H = new THREE.Vector3();
const Cr = new THREE.Vector3();

/** Drives a car through the same CarInput interface the player uses. */
export class AIDriver {
  skill: number;
  aggression: number;
  seed: number;
  useNitro = true;
  /** Hairpin drifting for spectacle — off: it costs the AI clean exits. */
  allowDrift = false;
  private avoid = 0;
  private avoidV = 0;
  private overtakeSide = 0;
  private overtakeTimer = 0;
  private stuckTimer = 0;
  private reverseTimer = 0;
  private nitroHold = 0;
  private startDelay: number;
  private profile: Float64Array | null = null;
  readonly dbg = { slope: 0, thetaDes: 0, travel: 0, ff: 0, cmd: 0, curv: 0 };
  private gridD: number | null = null;
  private passing: Vehicle | null = null;
  private pathK = 0;

  constructor(skill: number, aggression: number, seed: number) {
    this.skill = skill;
    this.aggression = aggression;
    this.seed = seed;
    this.startDelay = 0.08 + ((seed * 7919) % 100) / 100 * 0.3;
  }

  /** Returns true when the car is hopelessly stuck (caller should respawn). */
  update(car: Vehicle, others: readonly Vehicle[], track: Track, dt: number, ctx: AIContext): boolean {
    const b = car.body;
    const inp = car.input;
    const spec = car.spec;
    if (!this.profile) this.profile = speedProfileFor(track, spec);

    if (!ctx.raceActive) {
      // blip the throttle on the grid (engines can rev while frozen)
      const blip = Math.max(0, Math.sin(ctx.time * (2.2 + this.aggression * 2) + this.seed * 1.7));
      inp.throttle = b.frozen ? Math.pow(blip, 3) * (0.5 + this.aggression * 0.5) : 0;
      inp.brake = b.frozen ? 0 : 1;
      inp.steer = 0; inp.drift = false; inp.nitro = false;
      return false;
    }
    if (this.startDelay > 0) {
      this.startDelay -= dt;
      inp.throttle = 0.2; inp.brake = 0; inp.steer = 0;
      return false;
    }

    const v = b.vf;
    const av = Math.abs(v);

    // --- recovery
    if (this.reverseTimer > 0) {
      this.reverseTimer -= dt;
      inp.throttle = 0; inp.brake = 1; inp.drift = false; inp.nitro = false;
      inp.steer = -Math.sign(b.theta || 1);
      return false;
    }
    if (av < 3) this.stuckTimer += dt;
    else this.stuckTimer = Math.max(0, this.stuckTimer - dt * 2);
    if (this.stuckTimer > 5) {
      this.stuckTimer = 0;
      return true;
    }
    if (this.stuckTimer > 2 && Math.abs(b.theta) > 0.6) {
      this.reverseTimer = 1.0;
    }

    // --- personal line offset (slow wander) + avoidance
    if (this.gridD === null) this.gridD = b.d;
    const startBlend = clamp((ctx.time - 1.5) / 5, 0, 1); // hold the grid lane off the start
    // how tight the next stretch is (0 = open, 1 = technical): stay on the line there
    const kNear = Math.max(
      Math.abs(track.lerp(track.lineKappa, b.s + 15)),
      Math.abs(track.lerp(track.lineKappa, b.s + 40)),
      Math.abs(track.lerp(track.lineKappa, b.s + 70)),
    );
    const tight = clamp((kNear - 0.004) / 0.006, 0, 1);
    const freedom = 1 - 0.8 * tight;
    const personal = noise1(ctx.time * 0.07 + this.seed * 13.1, this.seed) * 0.9 * startBlend * freedom;
    let avoidTarget = 0;
    const W = spec.width;
    const lineHere = track.lerp(track.lineD, b.s);
    if (this.overtakeTimer > 0) this.overtakeTimer -= dt;
    // the pace this driver wants right now (profile × skill × rubber band)
    const prof0 = this.profile;
    const rbF0 = ctx.noRubber ? 0 : clamp(ctx.playerGap / 300, -1, 1);
    const myPace = Math.min(track.lerp(prof0, b.s), track.lerp(prof0, b.s + 0.12 * av + 2)) * this.skill * (1 + ctx.rubber * rbF0);
    let blockSpeed = Infinity;
    // hard lateral bounds from cars alongside (never steer into their lane)
    let lo = -Infinity, hi = Infinity;
    let target: Vehicle | null = null;
    let targetDs = Infinity;
    for (const o of others) {
      if (o === car || o.body.noCollide) continue;
      const ds = track.delta(b.s, o.body.s);
      const dd = o.body.d - b.d;
      if (ds > -spec.length * 0.6 && ds < (spec.length + o.spec.length) / 2 + 3) {
        const sep = (W + o.spec.width) / 2 + 1.0;
        if (dd >= 0) hi = Math.min(hi, o.body.d - sep);
        else lo = Math.max(lo, o.body.d + sep);
        // side by side into a tight section: the car behind yields
        if (ds > 2 && tight > 0.5) blockSpeed = Math.min(blockSpeed, o.body.vf - 0.4);
      }
      const laneOverlap = Math.abs(dd) < (W + o.spec.width) / 2 + 0.45;
      if (ds > 0 && ds < 70 && laneOverlap) {
        // time-gap following: keep ~0.3 s behind unless an overtake is underway
        const gap = 4.5 + 0.3 * av;
        const overtaking = this.overtakeTimer > 0 && Math.abs(dd) > W * 0.7;
        if (!overtaking) blockSpeed = Math.min(blockSpeed, o.body.vf + (ds - gap) * 1.1);
        // someone slower than the pace I want is in my lane ahead → candidate to pass
        if (ds < 55 && myPace > o.body.vf + 0.6 && ds < targetDs) {
          target = o;
          targetDs = ds;
        }
      }
      // keep committed while we are alongside the car we are passing
      if (this.passing === o && Math.abs(ds) < 9) this.overtakeTimer = Math.max(this.overtakeTimer, 0.4);
    }
    // don't start a pass right before a slow corner (that's how cars end up in walls)
    const cornerSoon = Math.min(track.lerp(prof0, b.s + 60), track.lerp(prof0, b.s + 110)) < av * 0.8;
    if (target && this.overtakeTimer <= 0 && !cornerSoon) {
      const ob = target.body;
      const hw = track.halfWidthAt(ob.s);
      const leftRoom = ob.d - W - 0.9 - (-hw + 1.8);
      const rightRoom = hw - 1.8 - (ob.d + W + 0.9);
      const k = track.lerp(track.lineKappa, ob.s + 60);
      let side = rightRoom > leftRoom ? 1 : -1;
      if (Math.abs(rightRoom - leftRoom) < 1.5 && Math.abs(k) > 0.002) side = k > 0 ? 1 : -1; // take the inside
      if (Math.max(leftRoom, rightRoom) > 0.3) {
        this.overtakeSide = side;
        this.overtakeTimer = 2.4;
        this.passing = target;
      }
    }
    if (this.overtakeTimer > 0 && this.overtakeSide !== 0 && this.passing) {
      const want = this.passing.body.d + this.overtakeSide * (W + 1.6);
      avoidTarget = (want - lineHere) * freedom;
    }
    if (lo > hi) lo = hi = (lo + hi) / 2;
    if (this.overtakeTimer <= 0) {
      this.overtakeSide = 0;
      this.passing = null;
    }
    avoidTarget = clamp(avoidTarget, -5, 5);
    // critically damped spring toward the avoidance target (gentler at speed)
    const wn = clamp(3.0 - av / 45, 1.1, 3.0);
    this.avoidV += (wn * wn * (avoidTarget - this.avoid) - 2 * wn * this.avoidV) * dt;
    this.avoid += this.avoidV * dt;

    // --- steering: road-curvature feedforward + heading/lateral cascade.
    // (Pure pursuit with a long lookahead cuts S-bends and oscillates at 300 km/h.)
    const maxYaw = Math.min(spec.yawLow, spec.aLat / Math.max(av, 3));
    let steer: number;
    if (Math.abs(b.theta) > 1.25 || v < 0) {
      // spun or reversing: point back down the road
      steer = -Math.sign(b.theta || 1) * (v < 0 ? -1 : 1);
    } else if (!b.grounded) {
      // In the air steering only turns the body, never the flight path: line the
      // nose up with the direction of travel so the car lands without slip.
      // (Chasing the line here winds the yaw up into a sideways landing.)
      const travel = Math.atan2(b.vd, Math.max(0.5, b.vs));
      steer = clamp(((travel - b.theta) * 3) / AIR_YAW, -1, 1);
    } else {
      // Hermite preview: plan a cubic in road coordinates from the current
      // lateral position + direction of travel to the target line's position
      // AND slope ~0.55 s ahead; steer with that path's initial curvature plus
      // the road's own curvature. Matching heading at the preview point is
      // what stops the overshoot a plain lateral-error controller has in S-bends.
      const vv = Math.max(av, 1);
      const lag = vv * 0.09; // steering/yaw lag compensation
      const s0 = b.s + lag;
      const gridD = this.gridD ?? 0;
      const tgt = (s: number) => {
        const line = track.lerp(track.lineD, s);
        let v2 = gridD + (line - gridD) * startBlend + personal + this.avoid;
        v2 = clamp(v2, lo, hi);
        const hwS = track.halfWidthAt(s);
        return clamp(v2, -hwS + 1.7, hwS - 1.7);
      };
      // Control the direction of travel, not the body: a gripping car corners
      // with a few degrees of slip, so its nose points inside its path.
      const travel = av > 3 ? Math.atan2(b.vd, Math.max(0.5, b.vs)) : b.theta;
      const m0 = Math.tan(clamp(travel, -1.1, 1.1));
      const d0 = b.d + m0 * lag;
      // Preview ~0.55 s ahead, stretched when the car is far off its target line so
      // the planned swerve needs at most half the tyres' grip (a short preview then
      // asks for the impossible, saturates the steering and overshoots into a wall).
      let Ld = clamp(0.55 * vv, 12, 46);
      const need = vv * Math.sqrt((6 * Math.abs(tgt(s0 + Ld) - d0)) / (0.5 * spec.aLat));
      if (need > Ld) Ld = Math.min(need, 110);
      const s1 = s0 + Ld;
      const d1 = tgt(s1);
      const m1 = (tgt(s1 + 2) - tgt(s1 - 2)) / 4;
      const a2 = (3 * (d1 - d0) - (2 * m0 + m1) * Ld) / (Ld * Ld);
      // (loops carry the car through their sideways shift — see CarBody.step)
      const kRoad = track.flags[track.idx(s0)] & F_LOOP ? 0 : track.kappaAt(s0);
      const pathK = kRoad + 2 * a2 * Math.pow(Math.cos(travel), 3);
      const omegaCmd = pathK * vv;
      steer = clamp(omegaCmd / maxYaw, -1, 1);
      if (b.drifting) {
        // Invert the drift model: path rate ω_p = dir·(driftLat/V)·(0.45 + 0.55u)
        const dir = b.driftDir;
        const base = spec.driftLat / Math.max(Math.hypot(b.vf, b.vl), 9);
        const u = clamp((omegaCmd * dir) / base - 0.45, 0, 0.55) / 0.55;
        steer = (2 * u - 1) * dir;
      }
      this.pathK = pathK;
      this.dbg.slope = m1;
      this.dbg.thetaDes = Math.atan(m1);
      this.dbg.travel = travel;
      this.dbg.ff = kRoad * vv;
      this.dbg.cmd = omegaCmd;
      this.dbg.curv = a2;
    }
    void fr; void P; void Q; void H; void Cr;

    // --- speed control
    const prof = this.profile;
    // The profile already contains braking zones; only a short lead for actuator lag.
    const look = b.s + 0.12 * av + 2;
    let vT = Math.min(track.lerp(prof, b.s), track.lerp(prof, look)) * this.skill;
    const rbF = ctx.noRubber ? 0 : clamp(ctx.playerGap / 300, -1, 1);
    vT *= 1 + ctx.rubber * rbF;
    vT = Math.min(vT, blockSpeed);
    const err = vT - av;
    let throttle = 0, brake = 0;
    if (err > -1.5) throttle = clamp(0.78 + 0.25 * err, 0, 1);
    else brake = clamp(-0.22 * (err + 1.2), 0, 1);

    // --- nitro on long straights
    let nitro = false;
    if (this.useNitro && b.nitro > 0.3 && Math.abs(steer) < 0.22 && av > 30) {
      const ahead = Math.min(track.lerp(prof, b.s + 120), track.lerp(prof, b.s + 240));
      if (ahead > spec.vTop * 0.95 || (this.passing && ahead > spec.vTop * 0.8)) {
        this.nitroHold = Math.max(this.nitroHold, 0.6 + this.aggression);
      }
    }
    if (this.nitroHold > 0) {
      this.nitroHold -= dt;
      nitro = true;
      if (Math.abs(steer) > 0.4) this.nitroHold = 0;
    }

    // --- showboat drifts through hairpins (entry needs the drift button + steer)
    let drift = false;
    if (this.allowDrift && b.grounded && !this.passing) {
      const kNow = track.lerp(track.lineKappa, b.s + av * 0.3);
      const kFar = Math.abs(track.lerp(track.lineKappa, b.s + av * 0.7));
      if (b.drifting) {
        // let go early: grip has to straighten the car before the exit kerb
        drift = kFar > 1 / 90 && Math.abs(kNow) > 1 / 75 && Math.abs(b.d) < track.halfWidthAt(b.s) - 2.5;
      } else if (Math.abs(kNow) > 1 / 60 && kFar > 1 / 60 && av > 22 && av < 44 && Math.abs(err) < 4) {
        drift = true;
        steer = Math.sign(kNow) * Math.max(0.6, Math.abs(steer));
      }
    }

    inp.steer = steer;
    inp.throttle = throttle;
    inp.brake = brake;
    inp.nitro = nitro && !drift;
    inp.drift = drift;
    return false;
  }
}
