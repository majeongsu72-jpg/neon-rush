import * as THREE from 'three';
import { CarBody, type BodySink } from './Physics';
import { buildCarModel, setWheelPose, type CarModel } from './CarModel';
import type { CarSpec, PaintDef } from './specs';
import type { Track, TrackFrame } from '../track/Track';
import { makeFrame } from '../track/Track';
import type { GameEvents } from '../core/Events';
import type { CarInput } from '../core/Input';
import { emptyInput } from '../core/Input';
import { clamp, damp } from '../core/math';

export type Role = 'player' | 'ai' | 'ghost';

interface Snapshot {
  s: number;
  d: number;
  h: number;
  theta: number;
  vh: number;
}

/** Underdamped spring for suspension-style secondary motion. */
class Spring {
  x = 0;
  v = 0;
  constructor(public k: number, public c: number) {}
  step(target: number, dt: number): number {
    const a = this.k * (target - this.x) - this.c * this.v;
    this.v += a * dt;
    this.x += this.v * dt;
    return this.x;
  }
}

/**
 * A racing car: physics body + procedural model + race bookkeeping.
 * Implements BodySink to turn physics callbacks into bus events.
 */
export class Vehicle implements BodySink {
  readonly id: number;
  readonly name: string;
  readonly spec: CarSpec;
  readonly paint: PaintDef;
  readonly body: CarBody;
  readonly model: CarModel;
  role: Role;
  input: CarInput = emptyInput();
  events: GameEvents | null = null;

  // race bookkeeping
  lap = 0;
  position = 1;
  finished = false;
  finishTime = 0;
  lapStart = 0;
  bestLap = Infinity;
  lapTimes: number[] = [];
  sectorTimes: number[] = [];
  /** Current sector index within the lap (0..2). */
  sector = 0;
  startProgress = 0;
  topSpeed = 0;
  nearMisses = 0;
  driftTotal = 0;
  airTotal = 0;
  wallHits = 0;
  wrongWayTime = 0;
  stuckTime = 0;
  lastPosition = 1;

  // interpolation
  private prev: Snapshot = { s: 0, d: 0, h: 0, theta: 0, vh: 0 };
  private curr: Snapshot = { s: 0, d: 0, h: 0, theta: 0, vh: 0 };

  // world-space pose (after interpolation)
  readonly pos = new THREE.Vector3();
  readonly quat = new THREE.Quaternion();
  readonly forward = new THREE.Vector3(0, 0, -1);
  readonly right = new THREE.Vector3(1, 0, 0);
  readonly up = new THREE.Vector3(0, 1, 0);
  readonly velocity = new THREE.Vector3();
  readonly frame: TrackFrame = makeFrame();
  renderS = 0;
  renderD = 0;

  // visuals
  private wheelSpin = 0;
  private steerVis = 0;
  private pitch = new Spring(90, 11);
  private roll = new Spring(80, 10);
  private heave = new Spring(160, 14);
  private airPitch = 0;
  private hop = 0;
  brakeGlow = 0;
  visible = true;

  constructor(id: number, name: string, spec: CarSpec, paint: PaintDef, role: Role, detail = 1) {
    this.id = id;
    this.name = name;
    this.spec = spec;
    this.paint = paint;
    this.role = role;
    this.body = new CarBody(spec);
    this.body.sink = this;
    this.model = buildCarModel(spec, paint, { detail });
    this.model.root.matrixAutoUpdate = false;
  }

  get isPlayer(): boolean {
    return this.role === 'player';
  }

  /** Call before each fixed step so rendering can interpolate. */
  saveState(): void {
    const b = this.body;
    const p = this.prev, c = this.curr;
    p.s = c.s; p.d = c.d; p.h = c.h; p.theta = c.theta; p.vh = c.vh;
    void b;
  }

  /** Call after each fixed step. */
  captureState(): void {
    const b = this.body, c = this.curr;
    c.s = b.s; c.d = b.d; c.h = b.h; c.theta = b.theta; c.vh = b.vh;
  }

  /** Reset interpolation history (after teleport / respawn). */
  snap(): void {
    this.captureState();
    const p = this.prev, c = this.curr;
    p.s = c.s; p.d = c.d; p.h = c.h; p.theta = c.theta; p.vh = c.vh;
  }

  private tmpH = new THREE.Vector3();
  private tmpC = new THREE.Vector3();
  private tmpM = new THREE.Matrix4();
  private tmpQ = new THREE.Quaternion();
  private tmpAxis = new THREE.Vector3();
  private tmpNegH = new THREE.Vector3();

  /** Interpolate pose, update model transform, wheels and secondary motion. */
  updateVisual(track: Track, alpha: number, dt: number): void {
    const p = this.prev, c = this.curr;
    const s = p.s + track.delta(p.s, c.s) * alpha;
    const d = p.d + (c.d - p.d) * alpha;
    const h = p.h + (c.h - p.h) * alpha;
    let dth = c.theta - p.theta;
    if (dth > Math.PI) dth -= Math.PI * 2;
    else if (dth < -Math.PI) dth += Math.PI * 2;
    const theta = p.theta + dth * alpha;
    this.renderS = track.wrap(s);
    this.renderD = d;

    const fr = track.surface(s, d, this.frame);
    const ct = Math.cos(theta), st = Math.sin(theta);
    const H = this.tmpH.copy(fr.T).multiplyScalar(ct).addScaledVector(fr.R, st);
    const C = this.tmpC.copy(fr.T).multiplyScalar(-st).addScaledVector(fr.R, ct);
    this.pos.copy(fr.pos).addScaledVector(fr.U, h);
    this.forward.copy(H);
    this.right.copy(C);
    this.up.copy(fr.U);

    const b = this.body;
    this.velocity.copy(fr.T).multiplyScalar(b.vs).addScaledVector(fr.R, b.vd).addScaledVector(fr.U, b.vh);

    // Airborne: nose follows the flight path.
    const targetAir = b.grounded ? 0 : Math.atan2(b.vh, Math.max(5, Math.abs(b.vs)));
    this.airPitch = damp(this.airPitch, targetAir, b.grounded ? 12 : 4, dt);

    this.tmpM.makeBasis(C, fr.U, this.tmpNegH.copy(H).negate());
    this.quat.setFromRotationMatrix(this.tmpM);
    if (Math.abs(this.airPitch) > 1e-4) {
      this.tmpQ.setFromAxisAngle(this.tmpAxis.set(1, 0, 0), this.airPitch);
      this.quat.multiply(this.tmpQ);
    }
    const root = this.model.root;
    root.position.copy(this.pos);
    root.quaternion.copy(this.quat);
    root.updateMatrix();
    root.updateMatrixWorld(true);

    // Secondary motion (suspension)
    const pitchT = clamp(b.longAccel * 0.0026, -0.09, 0.05) + (b.drifting ? -0.012 : 0);
    const rollT = clamp(b.latAccel * 0.0021, -0.085, 0.085) + (b.drifting ? b.driftDir * 0.02 : 0);
    const pd = this.pitch.step(pitchT, dt);
    const rd = this.roll.step(rollT, dt);
    const hv = this.heave.step(0, dt);
    this.hop = Math.max(0, this.hop - dt * 1.8);
    const hopY = Math.sin(Math.min(1, this.hop) * Math.PI) * 0.12;
    const bodyObj = this.model.body;
    bodyObj.rotation.set(pd, 0, rd);
    bodyObj.position.y = hv + hopY;

    // Wheels
    this.wheelSpin = (this.wheelSpin - (b.vf * dt) / this.model.wheelRadius) % (Math.PI * 2);
    const steerTarget = b.drifting ? -b.driftDir * 0.3 + -b.steer * 0.25 : -b.steer * 0.42;
    this.steerVis = damp(this.steerVis, steerTarget, 14, dt);
    setWheelPose(this.model, this.wheelSpin, this.steerVis, 0);

    // Lights
    const braking = b.brake > 0.1 && b.vf > 1 ? 1 : 0;
    this.brakeGlow = damp(this.brakeGlow, braking, 20, dt);
    const k = 2.4 + this.brakeGlow * 5.5;
    this.model.tailMat.color.setRGB(k, k * 0.035, k * 0.045);

    // Shadow blob stays on the road when airborne
    const sh = this.model.shadow;
    sh.position.y = 0.02 - h;
    const shMat = sh.material as THREE.MeshBasicMaterial;
    shMat.opacity = 0.75 * clamp(1 - h / 6, 0.15, 1);
    this.model.root.visible = this.visible;
  }

  kickHop(): void {
    this.hop = 1;
  }

  bump(v: number): void {
    this.heave.v -= v;
  }

  // ---- BodySink → events -----------------------------------------------
  onShift(gear: number, up: boolean): void {
    this.events?.emit('gearShift', { car: this, gear, up });
  }
  onBackfire(strength: number): void {
    this.events?.emit('backfire', { car: this, strength });
  }
  onDriftStart(dir: number): void {
    this.kickHop();
    this.events?.emit('driftStart', { car: this, dir });
  }
  onDriftLevel(level: number): void {
    this.events?.emit('driftLevel', { car: this, level });
  }
  onDriftEnd(level: number, duration: number, score: number): void {
    this.driftTotal += score;
    this.events?.emit('driftEnd', { car: this, level, duration, score });
  }
  onBoost(kind: 'mini' | 'slingshot' | 'pad' | 'start', strength: number): void {
    this.events?.emit('boost', { car: this, kind, strength });
  }
  onNitro(active: boolean): void {
    this.events?.emit(active ? 'nitroStart' : 'nitroEnd', { car: this });
  }
  onWall(impact: number, side: number): void {
    this.wallHits++;
    this.events?.emit('wallHit', { car: this, impact, side });
  }
  onAirborne(): void {
    this.events?.emit('airborne', { car: this });
  }
  onLanding(airTime: number, impact: number): void {
    this.airTotal += airTime;
    this.bump(Math.min(4, impact * 0.6));
    if (airTime > 0.35) this.body.addNitro(Math.min(0.14, airTime * 0.11));
    this.events?.emit('landing', { car: this, airTime, impact });
  }
  onDraft(): void {
    this.events?.emit('slipstream', { car: this });
  }

  dispose(): void {
    this.model.dispose();
  }
}
