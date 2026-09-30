import * as THREE from 'three';
import type { Vehicle } from '../vehicle/Vehicle';
import type { Track } from '../track/Track';
import { makeFrame } from '../track/Track';
import { F_LOOP } from '../track/types';
import { clamp, damp, noise1 } from '../core/math';

export type CamMode = 'chase' | 'far' | 'hood' | 'bumper';
export const CAM_MODES: CamMode[] = ['chase', 'far', 'hood', 'bumper'];

/** Critically damped spring (implicit Euler, unconditionally stable). */
function spring(x: number, v: number, target: number, omega: number, dt: number): [number, number] {
  const f = 1 + 2 * dt * omega;
  const oo = omega * omega;
  const hoo = dt * oo;
  const hhoo = dt * hoo;
  const inv = 1 / (f + hhoo);
  const nx = (f * x + dt * v + hhoo * target) * inv;
  const nv = (v + hoo * (target - x)) * inv;
  return [nx, nv];
}

/**
 * Racing camera: spring-follow chase cams with speed-driven FOV and pull-back,
 * drift-aware framing, trauma shake, loop handling and a cinematic override.
 */
export class CameraRig {
  readonly camera: THREE.PerspectiveCamera;
  mode: CamMode = 'chase';
  target: Vehicle | null = null;
  trauma = 0;
  shakeScale = 1;
  lookBack = false;
  /** 0..1 speed factor for other systems (post FX). */
  speedFx = 0;

  /** When set, the camera is driven externally (director). */
  cinematic: { pos: THREE.Vector3; look: THREE.Vector3; fov: number; up?: THREE.Vector3; roll?: number } | null = null;

  private pos = new THREE.Vector3(0, 5, 10);
  private vel = new THREE.Vector3();
  private offset = new THREE.Vector3(0, 2, 6);
  private offVel = new THREE.Vector3();
  private accelLag = 0;
  private look = new THREE.Vector3();
  private upVec = new THREE.Vector3(0, 1, 0);
  private fov = 60;
  private fovKick = 0;
  private fovKickV = 0;
  private time = 0;
  private roll = 0;
  private initialized = false;
  private readonly fr = makeFrame();
  private tmp = new THREE.Vector3();
  private tmp2 = new THREE.Vector3();
  private desired = new THREE.Vector3();
  private lookTarget = new THREE.Vector3();
  private aspect = 16 / 9;

  constructor(aspect: number, far: number) {
    this.camera = new THREE.PerspectiveCamera(60, aspect, 0.2, far);
    this.aspect = aspect;
  }

  setAspect(aspect: number): void {
    this.aspect = aspect;
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }

  setFar(far: number): void {
    this.camera.far = far;
    this.camera.updateProjectionMatrix();
  }

  cycleMode(): void {
    const i = CAM_MODES.indexOf(this.mode);
    this.mode = CAM_MODES[(i + 1) % CAM_MODES.length];
    this.initialized = false;
  }

  addTrauma(x: number): void {
    this.trauma = Math.min(1, this.trauma + x);
  }

  /** Nitro "kick": an underdamped FOV punch. */
  kickFov(amount: number): void {
    this.fovKickV += amount * 22;
  }

  reset(): void {
    this.initialized = false;
  }

  update(dt: number, track: Track): void {
    this.time += dt;
    this.trauma = Math.max(0, this.trauma - dt * 1.6);
    const cam = this.camera;

    // FOV kick spring (underdamped)
    const a = -110 * this.fovKick - 9 * this.fovKickV;
    this.fovKickV += a * dt;
    this.fovKick += this.fovKickV * dt;

    if (this.cinematic) {
      const c = this.cinematic;
      cam.position.copy(c.pos);
      cam.up.copy(c.up ?? THREE.Object3D.DEFAULT_UP);
      cam.lookAt(c.look);
      if (c.roll) cam.rotateZ(c.roll);
      this.setFov(c.fov);
      this.applyShake(dt);
      this.initialized = false;
      return;
    }
    const car = this.target;
    if (!car) return;
    const b = car.body;
    const spec = car.spec;
    const v = Math.abs(b.vf);
    const vn = clamp(v / spec.vTop, 0, 1.4);
    this.speedFx = damp(this.speedFx, vn, 3, dt);
    const F = car.forward, R = car.right, N = car.up;
    const magnetic = (track.flagsAt(car.renderS) & F_LOOP) !== 0;

    if (this.mode === 'hood' || this.mode === 'bumper') {
      const hood = this.mode === 'hood';
      const off = hood ? spec.length * 0.05 : -spec.length * 0.5 - 0.1;
      const hgt = hood ? spec.height + 0.12 : 0.55;
      this.desired.copy(car.pos).addScaledVector(F, -off).addScaledVector(N, hgt);
      if (this.lookBack) {
        this.desired.copy(car.pos).addScaledVector(F, spec.length * 0.55).addScaledVector(N, spec.height + 0.1);
        this.lookTarget.copy(this.desired).addScaledVector(F, 20);
      } else {
        this.lookTarget.copy(this.desired).addScaledVector(F, 30).addScaledVector(N, -0.4);
      }
      this.pos.copy(this.desired);
      this.vel.set(0, 0, 0);
      this.upVec.copy(N);
      cam.position.copy(this.pos);
      cam.up.copy(this.upVec);
      cam.lookAt(this.lookTarget);
      this.setFov(68 + 16 * Math.pow(vn, 1.5) + this.fovKick);
      this.applyShake(dt, 0.6 + vn);
      this.initialized = true;
      return;
    }

    const far = this.mode === 'far';
    // Acceleration pulls the camera back (and braking pushes it in) — the
    // offset itself is car-relative, so constant speed never builds lag.
    this.accelLag = damp(this.accelLag, clamp(b.longAccel, -30, 25), 4, dt);
    const dist = (far ? 8.6 : 6.0) + 1.3 * vn + (b.nitroActive ? 1.0 : 0) + clamp(this.accelLag * 0.07, -0.9, 1.4);
    const height = (far ? 2.9 : 1.95) + 0.25 * vn;

    // Behind direction blends heading and travel direction (shows drift angle).
    const vel = car.velocity;
    const vlen = vel.length();
    this.tmp.copy(F);
    if (vlen > 4) {
      this.tmp2.copy(vel).multiplyScalar(1 / vlen);
      // project into the road plane
      this.tmp2.addScaledVector(N, -this.tmp2.dot(N)).normalize();
      if (b.vf < -1) this.tmp2.negate();
      this.tmp.lerp(this.tmp2, 0.62).normalize();
    }
    const B = this.tmp; // "behind axis"

    if (this.lookBack) {
      this.desired.copy(car.pos).addScaledVector(B, dist * 0.9).addScaledVector(N, height);
      this.lookTarget.copy(car.pos).addScaledVector(B, -8).addScaledVector(N, 1.0);
    } else if (magnetic) {
      // Ride the track surface behind the car so we never cut through the loop.
      const s = car.renderS - dist;
      const fr = track.surface(s, car.renderD, this.fr);
      this.desired.copy(fr.pos).addScaledVector(fr.U, height + 0.4);
      this.lookTarget.copy(car.pos).addScaledVector(F, 4).addScaledVector(N, 0.9);
    } else {
      this.desired.copy(car.pos).addScaledVector(B, -dist).addScaledVector(N, height);
      // look slightly ahead, into the turn
      this.lookTarget
        .copy(car.pos)
        .addScaledVector(F, 3.5 + vn * 2)
        .addScaledVector(N, 0.95)
        .addScaledVector(R, clamp(b.omega * 3.2, -2.5, 2.5));
    }

    // Offsets relative to the car (desired and current).
    const dOff = this.tmp2.copy(this.desired).sub(car.pos);
    if (!this.initialized) {
      this.offset.copy(dOff);
      this.offVel.set(0, 0, 0);
      this.look.copy(this.lookTarget);
      this.upVec.copy(N);
      this.initialized = true;
    }

    // Springs on the car-relative offset, per car axis: stiff vertically,
    // softer laterally so turns and drifts swing the camera.
    const wLong = magnetic ? 25 : 9;
    const wLat = magnetic ? 25 : 6.5;
    const wVert = magnetic ? 25 : 12;
    const o = this.offset, ov = this.offVel;
    const [nF, nvF] = spring(o.dot(F), ov.dot(F), dOff.dot(F), wLong, dt);
    const [nR, nvR] = spring(o.dot(R), ov.dot(R), dOff.dot(R), wLat, dt);
    const [nN, nvN] = spring(o.dot(N), ov.dot(N), dOff.dot(N), wVert, dt);
    o.set(0, 0, 0).addScaledVector(F, nF).addScaledVector(R, nR).addScaledVector(N, nN);
    ov.set(0, 0, 0).addScaledVector(F, nvF).addScaledVector(R, nvR).addScaledVector(N, nvN);
    // never drift too far from the ideal framing
    const dev = this.tmp.copy(o).sub(dOff);
    const maxDev = 2.5 + vn;
    if (dev.length() > maxDev) o.copy(dOff).addScaledVector(dev.normalize(), maxDev);
    this.pos.copy(car.pos).add(o);

    this.look.lerp(this.lookTarget, 1 - Math.exp(-18 * dt));

    // Up vector: mostly world-up on normal roads, follow the road on steep banks/loops.
    const steep = 1 - clamp(N.y, 0, 1);
    const k = magnetic ? 1 : clamp(0.35 + steep * 1.5, 0.35, 0.85);
    this.tmp.set(0, 1, 0).lerp(N, k).normalize();
    this.upVec.lerp(this.tmp, 1 - Math.exp(-(magnetic ? 14 : 8) * dt)).normalize();

    // Drift roll
    const rollT = b.drifting ? -b.driftDir * 0.035 : clamp(-b.omega * 0.015, -0.03, 0.03);
    this.roll = damp(this.roll, rollT, 4, dt);

    cam.position.copy(this.pos);
    cam.up.copy(this.upVec);
    cam.lookAt(this.look);
    cam.rotateZ(this.roll);

    const baseFov = far ? 56 : 58;
    this.setFov(baseFov + 14 * Math.pow(Math.min(vn, 1.2), 1.6) + (b.boostTime > 0 ? 4 : 0) + this.fovKick);
    this.applyShake(dt, vn);
  }

  private setFov(target: number): void {
    // Cap horizontal FOV at 110° on ultrawide screens.
    const maxV = (2 * Math.atan(Math.tan((110 * Math.PI) / 360) / this.aspect) * 180) / Math.PI;
    const fov = Math.min(target, maxV, 100);
    this.fov = damp(this.fov, fov, 6, 1 / 60);
    if (Math.abs(this.camera.fov - this.fov) > 0.01) {
      this.camera.fov = this.fov;
      this.camera.updateProjectionMatrix();
    }
  }

  private applyShake(dt: number, speed = 0): void {
    const t = this.time;
    const s = this.shakeScale;
    if (s <= 0) return;
    const tr = this.trauma * this.trauma;
    const buzz = Math.pow(clamp(speed, 0, 1.3), 3) * 0.0026;
    const pitch = (tr * 0.044 * noise1(t * 25, 1) + buzz * noise1(t * 40, 7)) * s;
    const yaw = (tr * 0.035 * noise1(t * 25, 2) + buzz * noise1(t * 43, 8)) * s;
    const roll = tr * 0.052 * noise1(t * 22, 3) * s;
    this.camera.rotateX(pitch);
    this.camera.rotateY(yaw);
    this.camera.rotateZ(roll);
    void dt;
  }

  /** Screen-space point toward which the scene streams (for radial blur). */
  focusOfExpansion(out: THREE.Vector2): THREE.Vector2 {
    const car = this.target;
    if (!car || this.cinematic || car.velocity.lengthSq() < 4) return out.set(0.5, 0.52);
    const p = this.tmp.copy(this.camera.position).addScaledVector(car.velocity, 10);
    p.project(this.camera);
    if (p.z > 1) return out.set(0.5, 0.52);
    return out.set(clamp(p.x * 0.5 + 0.5, 0.25, 0.75), clamp(p.y * 0.5 + 0.5, 0.3, 0.75));
  }
}
