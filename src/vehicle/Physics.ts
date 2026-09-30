import type { CarInput } from '../core/Input';
import type { CarSpec } from './specs';
import type { Track } from '../track/Track';
import { makeFrame } from '../track/Track';
import { F_BOOST, F_JUMP, F_LOOP } from '../track/types';
import { approach, clamp, wrapAngle } from '../core/math';

export const G = 9.81;
const DOWNFORCE = 0.0015; // (m/s²) per (m/s)²
/** Yaw rate (rad/s) at full steer while airborne. */
export const AIR_YAW = 0.5;

/** Callbacks from the physics body to gameplay (events, sound, FX). */
export interface BodySink {
  onShift(gear: number, up: boolean): void;
  onBackfire(strength: number): void;
  onDriftStart(dir: number): void;
  onDriftLevel(level: number): void;
  onDriftEnd(level: number, duration: number, score: number): void;
  onBoost(kind: 'mini' | 'slingshot' | 'pad' | 'start', strength: number): void;
  onNitro(active: boolean): void;
  onWall(impact: number, side: number): void;
  onAirborne(): void;
  onLanding(airTime: number, impact: number): void;
  onDraft(): void;
}

const noopSink: BodySink = {
  onShift() {}, onBackfire() {}, onDriftStart() {}, onDriftLevel() {}, onDriftEnd() {},
  onBoost() {}, onNitro() {}, onWall() {}, onAirborne() {}, onLanding() {}, onDraft() {},
};

const DRIFT_LEVELS = [0.8, 1.8, 3.0];
const MINI_TIME = [0, 0.7, 1.1, 1.6];
const MINI_POWER = [0, 0.75, 1.0, 1.3];
const MINI_NITRO = [0, 0.05, 0.1, 0.16];

/**
 * Arcade vehicle integrated in road (curvilinear) coordinates.
 *   ds/dt = (vf cosθ − vl sinθ) / (1 − κ d)
 *   dd/dt =  vf sinθ + vl cosθ
 *   dθ/dt =  ω − κ ds/dt
 */
export class CarBody {
  readonly spec: CarSpec;
  sink: BodySink = noopSink;

  // road-space pose
  s = 0;
  d = 0;
  h = 0;
  theta = 0;
  // velocities
  vf = 0;
  vl = 0;
  omega = 0;
  vh = 0;
  /** Unwrapped distance travelled along s (for laps / positions). */
  progress = 0;
  sdot = 0;

  grounded = true;
  airTime = 0;

  // smoothed controls
  steer = 0;
  throttle = 0;
  brake = 0;
  handbrake = false;

  // drivetrain
  gear = 1;
  rpm = 900;
  shiftTimer = 0;
  private lastThrottle = 0;
  private liftTimer = 0;

  // drift
  drifting = false;
  driftDir = 0;
  driftTime = 0;
  driftCharge = 0;
  driftLevel = 0;
  driftAngle = 0;
  driftScore = 0;
  private driftByBrake = false;
  private driftExitTimer = 0;
  private gripRecovery = 1;
  private brakeHeld = 0;
  private brakeTap = 0;

  // boosts
  nitro = 0.35;
  nitroActive = false;
  boostTime = 0;
  boostStrength = 0;
  draft = 0;
  draftTarget = 0;
  private slingshotReady = false;
  private padCooldown = 0;

  // contacts / surface
  wallSide = 0;
  scrape = 0;
  onCurb = false;
  hitCooldown = 0;
  lastImpact = 0;
  /** Seconds of collision immunity (after respawn). */
  ghostTime = 0;
  /** Permanent non-colliding (time-attack ghost, attract). */
  noCollide = false;

  /** Before GO: wheels locked, engine can be revved. */
  frozen = false;
  /** Ridge-Racer style brake-tap drift entry (player only; AI brakes in short taps). */
  brakeDrift = false;
  /** Player steering-response multiplier (settings: 조향 반응 속도); 1 = stock. */
  steerResponse = 1;
  /** Wheelspin penalty after a bad start. */
  wheelspin = 0;

  // derived per step
  speed = 0;
  longAccel = 0;
  latAccel = 0;
  slipAngle = 0;
  vs = 0;
  vd = 0;

  private readonly fr = makeFrame();

  constructor(spec: CarSpec) {
    this.spec = spec;
  }

  get halfL(): number {
    return this.spec.length / 2;
  }

  get halfW(): number {
    return this.spec.width / 2;
  }

  get mass(): number {
    return this.spec.mass;
  }

  get rpmNorm(): number {
    return clamp((this.rpm - this.spec.idleRpm) / (this.spec.redline - this.spec.idleRpm), 0, 1.05);
  }

  get speedKmh(): number {
    return Math.abs(this.vf) * 3.6;
  }

  place(s: number, d: number, theta = 0): void {
    this.s = s;
    this.d = d;
    this.h = 0;
    this.theta = theta;
    this.vf = this.vl = this.omega = this.vh = 0;
    this.grounded = true;
    this.drifting = false;
    this.nitroActive = false;
    this.boostTime = 0;
    this.gear = 1;
    this.rpm = this.spec.idleRpm;
  }

  respawn(track: Track, s: number, d: number, speed: number): void {
    this.s = track.wrap(s);
    this.d = d;
    this.h = 0;
    this.theta = 0;
    this.vf = speed;
    this.vl = this.omega = this.vh = 0;
    this.grounded = true;
    this.drifting = false;
    this.driftCharge = 0;
    this.driftLevel = 0;
    this.gripRecovery = 1;
    this.ghostTime = 2.2;
    this.gear = 3;
  }

  step(inp: CarInput, dt: number, track: Track): void {
    const sp = this.spec;
    const fr = track.surface(this.s, this.d, this.fr);

    // ---- control smoothing (slower steering ramp at very high speed)
    // (full lock in ~0.12 s at low speed, ~0.18 s flat out; unwinding is faster still)
    const fast = clamp((Math.abs(this.vf) - 40) / 30, 0, 1);
    const upRate = (8.5 - 3 * fast) * this.steerResponse;
    const steerRate = Math.sign(inp.steer) !== Math.sign(this.steer) || Math.abs(inp.steer) < Math.abs(this.steer) ? 12 * this.steerResponse : upRate;
    this.steer = approach(this.steer, inp.steer, steerRate * dt);
    this.throttle = approach(this.throttle, inp.nitro && this.nitro > 0.01 ? 1 : inp.throttle, 7 * dt);
    this.brake = approach(this.brake, inp.brake, 9 * dt);
    this.handbrake = inp.drift;

    this.hitCooldown = Math.max(0, this.hitCooldown - dt);
    this.ghostTime = Math.max(0, this.ghostTime - dt);
    this.padCooldown = Math.max(0, this.padCooldown - dt);

    if (this.frozen) {
      // Free revving on the grid.
      const target = sp.idleRpm + (sp.redline * 1.02 - sp.idleRpm) * this.throttle;
      this.rpm += (target - this.rpm) * (1 - Math.exp(-(this.throttle > this.lastThrottle ? 9 : 5) * dt));
      this.lastThrottle = this.throttle;
      this.vf = this.vl = this.omega = 0;
      this.speed = 0;
      return;
    }

    const absV = Math.abs(this.vf);
    const cT = Math.cos(this.theta), sT = Math.sin(this.theta);
    const headingY = fr.T.y * cT + fr.R.y * sT;
    const gN = G * fr.U.y;

    this.updateDrift(inp, dt, absV);
    this.updateNitro(inp, dt);
    this.updateGearbox(dt, absV);

    // ---- propulsive acceleration (engine + boosts), shared by grip and drift
    const vTopEff =
      sp.vTop *
      (this.nitroActive ? sp.nitroTop : 1) *
      (this.boostTime > 0 ? 1 + 0.085 * this.boostStrength : 1) *
      (1 + 0.055 * this.draft);
    let engine = 0;
    if (this.throttle > 0.01 && this.vf > -0.5) {
      const x = absV / vTopEff;
      const shape = 1 - Math.pow(Math.min(x, 1.4), sp.accelExp);
      const tq = 0.8 + 0.32 * Math.sin(Math.PI * clamp(this.rpmNorm * 0.9 + 0.05, 0, 1));
      engine = sp.accel * tq * shape;
      if (engine < -6) engine = -6;
      engine *= this.throttle;
      if (this.shiftTimer > 0 && engine > 0) engine *= 0.3;
      if (this.wheelspin > 0 && engine > 0) engine *= 0.35;
    }
    const over = clamp((absV - vTopEff) / 12, 0, 1);
    let boostA = 0;
    if (this.nitroActive) boostA += sp.nitroAccel * (1 - over);
    if (this.boostTime > 0) boostA += 10.5 * this.boostStrength * (1 - over);
    boostA += 2.6 * this.draft * (1 - over);
    const slopeA = -G * headingY * 0.85;

    if (this.grounded && this.drifting) {
      // ---- DRIFT: direct slip-angle control (predictable on a keyboard).
      // The velocity vector turns at the "path rate" set by steering; the body
      // yaws toward a target slip angle on top of that.
      const dir = this.driftDir;
      let V = Math.hypot(this.vf, this.vl);
      const u = 0.5 + 0.5 * clamp(this.steer * dir, -1, 1); // 1 = steering into the drift
      const omegaP = dir * (sp.driftLat / Math.max(V, 9)) * (0.45 + 0.55 * u);
      const betaT = (0.16 + 0.44 * u) * (sp.driftMaxAngle / 0.92);
      let phi = Math.atan2(this.vl, Math.max(0.1, this.vf));
      const betaB = -dir * phi;
      const kick = this.driftTime < 0.2 ? 10 : 5;
      this.omega = clamp(omegaP + kick * (betaT - betaB) * dir, -3, 3);
      phi += (omegaP - this.omega) * dt;
      let dv = 0.72 * Math.max(0, engine) + boostA + slopeA - (1.0 + 4.5 * Math.abs(betaB)) * (sp.driftDrag / 2.2);
      if (this.brake > 0.02) dv -= sp.brake * 0.55 * this.brake;
      V = Math.max(0, V + dv * dt);
      this.vf = V * Math.cos(phi);
      this.vl = V * Math.sin(phi);
      this.longAccel = dv;
    } else {
      // ---- GRIP
      let a = 0;
      if (this.grounded) {
        a += engine + boostA;
        if (this.brake > 0.02) {
          if (this.vf > 1) a -= sp.brake * this.brake;
          else if (this.throttle < 0.1 && this.vf > -sp.reverseMax) a -= sp.reverseAccel * this.brake;
          else if (this.vf < -1) a += sp.brake * 0.5 * this.brake;
        }
        if (this.handbrake && absV > 2) a -= Math.sign(this.vf) * 5;
        if (this.throttle < 0.05) a -= Math.sign(this.vf) * (0.9 + 0.00022 * this.vf * this.vf);
        a -= Math.sign(this.vf) * (0.12 + 0.00004 * this.vf * this.vf);
        if (this.onCurb) a -= Math.sign(this.vf) * 0.8;
      } else {
        a -= Math.sign(this.vf) * 0.0001 * this.vf * this.vf;
      }
      a += slopeA;
      this.longAccel = a;
      const prevVf = this.vf;
      this.vf += a * dt;
      // Braking must not flip direction on its own.
      if (prevVf > 0 && this.vf < 0 && this.brake > 0.02 && this.throttle < 0.1 && absV > 0.5) this.vf = 0;
      if (Math.abs(this.vf) < 0.05 && this.throttle < 0.01 && this.brake < 0.01) this.vf = 0;

      // yaw toward the steering target
      if (this.grounded) {
        const maxYaw = Math.min(sp.yawLow, sp.aLat / Math.max(absV, 3));
        const lowSpeed = clamp(absV / 3.5, 0, 1);
        const omegaT = this.steer * maxYaw * Math.sign(this.vf || 1) * lowSpeed;
        this.omega += (omegaT - this.omega) * (1 - Math.exp(-sp.yawResp * this.steerResponse * dt));
      } else {
        // air control: a gentle yaw rate that stops when the stick is released
        // (integrating it let a held input wind up into a sideways landing)
        this.omega += (this.steer * AIR_YAW - this.omega) * (1 - Math.exp(-3 * dt));
      }

      // rotate the (world-fixed) velocity into the new heading
      const dYaw = this.omega * dt;
      const cy = Math.cos(dYaw), sy = Math.sin(dYaw);
      const vf2 = this.vf * cy + this.vl * sy;
      const vl2 = -this.vf * sy + this.vl * cy;
      this.vf = vf2;
      this.vl = vl2;

      // lateral grip bleeds sideways velocity (a little is converted forward)
      if (this.grounded) {
        const grip = sp.grip * (0.22 + 0.78 * this.gripRecovery);
        const vlNew = this.vl * Math.exp(-grip * dt);
        const lost = Math.abs(this.vl) - Math.abs(vlNew);
        if (this.vf > 0) this.vf += lost * 0.12;
        this.vl = vlNew;
      }
    }

    // ---- integrate road coordinates (surface metric includes bank torsion)
    const cT2 = Math.cos(this.theta), sT2 = Math.sin(this.theta);
    const vs = this.vf * cT2 - this.vl * sT2;
    const vd = this.vf * sT2 + this.vl * cT2;
    const metric = Math.max(0.25, fr.metric);
    const sdot = vs / metric;
    this.sdot = sdot;
    this.s = track.wrap(this.s + sdot * dt);
    this.progress += sdot * dt;
    this.d += vd * dt;
    // In a loop the road presses into the car at 10+ g: it carries the car through
    // the loop's sideways shift like a rail (no lateral curvature to steer against).
    const magnetic = (fr.flags & F_LOOP) !== 0;
    this.theta = wrapAngle(this.theta + (this.omega - (magnetic ? 0 : fr.kappa) * sdot) * dt);
    this.vs = vs;
    this.vd = vd;

    // ---- vertical (crest lift-off / landing)
    if (this.grounded) {
      // Arcade downforce keeps cars planted over ordinary crests; designed
      // JUMP sections switch it off so launches only happen where intended.
      const df = fr.flags & F_JUMP ? 0 : DOWNFORCE;
      const away = -fr.kappaV * vs * vs - gN - df * vs * vs;
      if (away > 0 && !magnetic) {
        this.grounded = false;
        this.vh = 0;
        this.airTime = 0;
        this.sink.onAirborne();
      } else {
        this.h = 0;
        this.vh = 0;
      }
    }
    if (!this.grounded) {
      const away = -fr.kappaV * vs * vs - gN;
      this.vh += away * dt;
      this.h += this.vh * dt;
      this.airTime += dt;
      if (this.h <= 0 || magnetic) {
        const impact = Math.max(0, -this.vh);
        this.h = 0;
        this.vh = 0;
        this.grounded = true;
        this.sink.onLanding(this.airTime, impact);
      }
    }

    // ---- boost pads
    if (fr.flags & F_BOOST && this.padCooldown <= 0 && this.grounded) {
      for (const pad of track.boostPads) {
        if (track.inRange(this.s, pad.s0, pad.s1) && Math.abs(this.d - pad.d) < pad.halfWidth + 0.5) {
          this.boostTime = Math.max(this.boostTime, 1.25);
          this.boostStrength = Math.max(this.boostStrength, 1.35);
          this.padCooldown = 0.6;
          this.sink.onBoost('pad', 1.35);
          break;
        }
      }
    }

    // ---- slipstream
    const draftRate = this.draftTarget > this.draft ? 0.85 : 2.2;
    this.draft = approach(this.draft, this.draftTarget, draftRate * dt);
    if (this.draft > 0.82 && !this.slingshotReady) {
      this.slingshotReady = true;
      this.sink.onDraft();
    }
    if (this.draft > 0.05) this.addNitro(this.draft * 0.035 * dt);
    if (this.slingshotReady && this.draftTarget < 0.05) {
      this.slingshotReady = false;
      if (this.draft > 0.35) {
        this.boostTime = Math.max(this.boostTime, 0.9);
        this.boostStrength = Math.max(this.boostStrength, 0.85);
        this.sink.onBoost('slingshot', 0.85);
      }
    }

    // ---- rumble strips
    const cm = track.curbMask;
    this.onCurb = !!cm && this.grounded && cm[track.idx(this.s)] === 1 && Math.abs(this.d) > fr.halfWidth - 1.25;

    // ---- walls
    this.collideWalls(fr.halfWidth, dt);

    // ---- timers & derived values
    if (this.boostTime > 0) {
      this.boostTime -= dt;
      if (this.boostTime <= 0) {
        this.boostTime = 0;
        this.boostStrength = 0;
      }
    }
    this.wheelspin = Math.max(0, this.wheelspin - dt);
    this.speed = Math.hypot(this.vf, this.vl);
    this.latAccel = this.vf * this.omega;
    this.slipAngle = Math.atan2(this.vl, Math.abs(this.vf) + 0.5);

    if (!isFinite(this.s + this.d + this.theta + this.vf + this.vl + this.omega)) {
      // Never let a numerical glitch escape; snap back to the road.
      this.respawn(track, isFinite(this.s) ? this.s : 0, 0, 20);
    }
  }

  // -------------------------------------------------------------------------

  private updateDrift(inp: CarInput, dt: number, absV: number): void {
    const sp = this.spec;
    if (!this.drifting) {
      this.gripRecovery = Math.min(1, this.gripRecovery + dt / 0.35);
      // brake tap detection (keyboard-friendly drift entry)
      if (inp.brake > 0.5) this.brakeHeld += dt;
      else {
        if (this.brakeHeld > 0 && this.brakeHeld < 0.22) this.brakeTap = 0.3;
        this.brakeHeld = 0;
      }
      this.brakeTap = Math.max(0, this.brakeTap - dt);
      const steerOk = Math.abs(inp.steer) > 0.3;
      const byButton = inp.drift;
      const byBrake = this.brakeDrift && this.brakeTap > 0 && Math.abs(inp.steer) > 0.7 && absV > 33;
      if (this.grounded && this.vf > 17 && steerOk && (byButton || byBrake) && !this.frozen) {
        this.drifting = true;
        this.driftDir = Math.sign(inp.steer);
        this.driftTime = 0;
        this.driftCharge = 0;
        this.driftLevel = 0;
        this.driftScore = 0;
        this.driftByBrake = !byButton;
        this.driftExitTimer = 0;
        this.brakeTap = 0;
        this.omega += this.driftDir * 0.32;
        this.sink.onDriftStart(this.driftDir);
      }
      this.driftAngle = 0;
      return;
    }

    this.driftTime += dt;
    const ang = Math.atan2(-this.vl * this.driftDir, Math.max(1, this.vf));
    this.driftAngle = ang;
    const rel = inp.steer * this.driftDir;
    if (this.grounded && ang > 0.12 && this.vf > 14) {
      this.driftCharge += dt * (0.75 + 0.5 * Math.max(0, rel));
      this.driftScore += dt * this.vf * Math.min(1, ang * 2) * 3;
    }
    const lvl = this.driftCharge >= DRIFT_LEVELS[2] ? 3 : this.driftCharge >= DRIFT_LEVELS[1] ? 2 : this.driftCharge >= DRIFT_LEVELS[0] ? 1 : 0;
    if (lvl > this.driftLevel) {
      this.driftLevel = lvl;
      this.sink.onDriftLevel(lvl);
    }

    let exit = false;
    let reward = true;
    if (!this.driftByBrake && !inp.drift) exit = true;
    if (this.driftByBrake) {
      if (Math.abs(inp.steer) < 0.15 || rel < -0.6) this.driftExitTimer += dt;
      else this.driftExitTimer = 0;
      if (this.driftExitTimer > 0.2) exit = true;
    }
    if (this.vf < 11) {
      exit = true;
      reward = this.vf > 6;
    }
    // Drift fizzled out (car straightened itself).
    if (this.driftTime > 0.45 && ang < 0.1) exit = true;
    if (exit) this.endDrift(reward);
    void sp;
  }

  endDrift(reward: boolean): void {
    if (!this.drifting) return;
    const lvl = reward ? this.driftLevel : 0;
    this.drifting = false;
    this.gripRecovery = 0.2;
    if (lvl > 0) {
      this.boostTime = Math.max(this.boostTime, MINI_TIME[lvl]);
      this.boostStrength = Math.max(this.boostStrength, MINI_POWER[lvl]);
      this.nitro = Math.min(1, this.nitro + MINI_NITRO[lvl]);
      this.sink.onBoost('mini', MINI_POWER[lvl]);
    }
    this.sink.onDriftEnd(lvl, this.driftTime, this.driftScore);
    this.driftLevel = 0;
    this.driftCharge = 0;
  }

  private updateNitro(inp: CarInput, dt: number): void {
    const sp = this.spec;
    if (inp.nitro && (this.nitroActive ? this.nitro > 0 : this.nitro > 0.06)) {
      if (!this.nitroActive) {
        this.nitroActive = true;
        this.sink.onNitro(true);
      }
    } else if (this.nitroActive) {
      this.nitroActive = false;
      this.sink.onNitro(false);
    }
    if (this.nitroActive) {
      this.nitro -= sp.nitroDrain * dt;
      if (this.nitro <= 0) {
        this.nitro = 0;
        this.nitroActive = false;
        this.sink.onNitro(false);
      }
    }
  }

  addNitro(amount: number): void {
    this.nitro = clamp(this.nitro + amount, 0, 1);
  }

  private updateGearbox(dt: number, absV: number): void {
    const sp = this.spec;
    const n = sp.gears.length;
    if (this.shiftTimer > 0) this.shiftTimer = Math.max(0, this.shiftTimer - dt);
    const gTop = (g: number) => sp.gears[g - 1] * sp.vTop * 1.04;
    const norm = absV / gTop(this.gear);
    if (this.shiftTimer <= 0 && this.grounded) {
      if (norm > 0.965 && this.gear < n && this.throttle > 0.2 && this.vf > 0) {
        this.gear++;
        this.shiftTimer = 0.16;
        this.sink.onShift(this.gear, true);
      } else if (this.gear > 1 && absV < gTop(this.gear - 1) * 0.68) {
        this.gear--;
        this.shiftTimer = 0.09;
        this.sink.onShift(this.gear, false);
      }
    }
    const span = sp.redline - sp.idleRpm;
    let target = sp.idleRpm + span * clamp(absV / gTop(this.gear), 0, 1.02);
    if (this.gear === 1 && this.throttle > 0.1) target = Math.max(target, sp.idleRpm + span * 0.5 * this.throttle);
    if (this.drifting || this.wheelspin > 0) target += span * 0.12 * this.throttle;
    if (!this.grounded && this.throttle > 0.3) target = Math.min(sp.redline * 1.02, this.rpm + 5000 * dt);
    target = Math.min(target, sp.redline * 1.03);
    const rate = this.shiftTimer > 0 ? 20 : 11;
    this.rpm += (target - this.rpm) * (1 - Math.exp(-rate * dt));

    // Backfire on sharp lift-off at high revs.
    if (this.lastThrottle > 0.7 && this.throttle < 0.25 && this.rpm > sp.redline * 0.55) {
      this.liftTimer = 0.25;
      this.sink.onBackfire(clamp(this.rpm / sp.redline, 0.4, 1));
    }
    this.liftTimer = Math.max(0, this.liftTimer - dt);
    this.lastThrottle = this.throttle;
  }

  private collideWalls(halfWidth: number, dt: number): void {
    const ext = this.halfW * Math.abs(Math.cos(this.theta)) + this.halfL * Math.abs(Math.sin(this.theta));
    const lim = Math.max(0.5, halfWidth - ext);
    let side = 0;
    if (this.d > lim) side = 1;
    else if (this.d < -lim) side = -1;
    if (!side) {
      this.wallSide = 0;
      this.scrape = Math.max(0, this.scrape - dt * 6);
      return;
    }
    this.d = side * lim;
    const cT = Math.cos(this.theta), sT = Math.sin(this.theta);
    let vs = this.vf * cT - this.vl * sT;
    let vd = this.vf * sT + this.vl * cT;
    const into = vd * side;
    if (into > 0) {
      const impact = into;
      vd = -side * into * 0.22;
      const loss = Math.min(Math.abs(vs) * 0.5, impact * 0.42 + 0.3);
      vs -= Math.sign(vs) * loss;
      if (this.theta * side > 0) this.theta *= clamp(0.92 - impact * 0.035, 0.3, 0.92);
      this.omega *= impact > 6 ? 0.3 : 0.75;
      if (impact > 2.2 && this.hitCooldown <= 0) {
        this.lastImpact = impact;
        this.sink.onWall(impact, side);
        this.hitCooldown = 0.25;
      }
      if (this.drifting && impact > 9) this.endDrift(false);
    }
    vs *= 1 - 0.55 * dt;
    this.scrape = Math.abs(vs) > 4 ? Math.min(1, Math.abs(vs) / 40 + 0.3) : 0;
    const cN = Math.cos(this.theta), sN = Math.sin(this.theta);
    this.vf = vs * cN + vd * sN;
    this.vl = -vs * sN + vd * cN;
    this.wallSide = side;
  }

  /** Perfect / good / bad launch at GO. */
  launch(quality: 'perfect' | 'good' | 'spin' | 'none'): void {
    this.frozen = false;
    if (quality === 'perfect') {
      this.boostTime = 1.4;
      this.boostStrength = 1.2;
      this.sink.onBoost('start', 1.2);
    } else if (quality === 'good') {
      this.boostTime = 0.7;
      this.boostStrength = 0.7;
      this.sink.onBoost('start', 0.7);
    } else if (quality === 'spin') {
      this.wheelspin = 0.9;
    }
  }
}
