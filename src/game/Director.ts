import * as THREE from 'three';
import type { CameraRig } from '../render/CameraRig';
import type { Vehicle } from '../vehicle/Vehicle';
import type { Track } from '../track/Track';
import { makeFrame } from '../track/Track';
import { F_LOOP, F_TUNNEL } from '../track/types';
import { clamp, easeInOutCubic } from '../core/math';

type ShotKind = 'chase' | 'trackside' | 'heli' | 'front' | 'wheel' | 'orbit' | 'intro';

interface Shot {
  kind: ShotKind;
  car: Vehicle;
  t: number;
  dur: number;
  anchor: THREE.Vector3; // fixed trackside position
  side: number;
  seed: number;
}

/**
 * Broadcast-style camera director used by the attract mode, the pre-race
 * intro fly-around and the finish orbit. Drives CameraRig.cinematic.
 */
export class Director {
  private rig: CameraRig;
  private shot: Shot | null = null;
  private mode: 'off' | 'attract' | 'intro' | 'finish' = 'off';
  private readonly fr = makeFrame();
  private readonly pos = new THREE.Vector3();
  private readonly look = new THREE.Vector3();
  private readonly tmp = new THREE.Vector3();
  private rngState = 7;
  onIntroDone: (() => void) | null = null;

  constructor(rig: CameraRig) {
    this.rig = rig;
  }

  private rand(): number {
    this.rngState = (this.rngState * 16807) % 2147483647;
    return (this.rngState - 1) / 2147483646;
  }

  get active(): boolean {
    return this.mode !== 'off';
  }

  off(): void {
    this.mode = 'off';
    this.shot = null;
    this.rig.cinematic = null;
    this.rig.reset();
  }

  attract(): void {
    this.mode = 'attract';
    this.shot = null;
  }

  intro(car: Vehicle, dur = 4.2): void {
    this.mode = 'intro';
    this.shot = { kind: 'intro', car, t: 0, dur, anchor: new THREE.Vector3(), side: 1, seed: 0 };
  }

  finish(car: Vehicle): void {
    this.mode = 'finish';
    this.shot = { kind: 'orbit', car, t: 0, dur: 1e9, anchor: new THREE.Vector3(), side: this.rand() < 0.5 ? -1 : 1, seed: 0 };
  }

  skipIntro(): void {
    if (this.mode === 'intro' && this.shot) this.shot.t = this.shot.dur;
  }

  private pickShot(cars: readonly Vehicle[], track: Track): Shot {
    // prefer cars in a pack (more action on screen)
    let car = cars[Math.floor(this.rand() * cars.length)];
    let bestN = -1;
    for (let k = 0; k < 4; k++) {
      const c = cars[Math.floor(this.rand() * cars.length)];
      let n = 0;
      for (const o of cars) if (o !== c && Math.abs(track.delta(c.body.s, o.body.s)) < 40) n++;
      if (n > bestN) {
        bestN = n;
        car = c;
      }
    }
    const kinds: ShotKind[] = ['trackside', 'trackside', 'chase', 'heli', 'front', 'wheel', 'trackside'];
    let kind = kinds[Math.floor(this.rand() * kinds.length)];
    const flags = track.flagsAt(car.body.s + 80);
    if (flags & F_LOOP) kind = 'chase';
    const side = this.rand() < 0.5 ? -1 : 1;
    const anchor = new THREE.Vector3();
    let dur = 4.5 + this.rand() * 2.5;
    if (kind === 'trackside') {
      const v = Math.max(20, Math.abs(car.body.vf));
      const ahead = v * (1.6 + this.rand() * 1.2);
      const s = car.body.s + ahead;
      const fr = track.sample(s, this.fr);
      const inTunnel = (fr.flags & F_TUNNEL) !== 0;
      const off = inTunnel ? fr.halfWidth - 1.2 : fr.halfWidth + 3 + this.rand() * 6;
      anchor.copy(fr.pos).addScaledVector(fr.R, side * off).addScaledVector(fr.U, inTunnel ? 1.2 + this.rand() * 2 : 1.2 + this.rand() * 4.5);
      dur = clamp((ahead + 40) / v, 3, 7);
    }
    return { kind, car, t: 0, dur, anchor, side, seed: this.rand() * 100 };
  }

  update(dt: number, cars: readonly Vehicle[], track: Track): void {
    if (this.mode === 'off' || cars.length === 0) return;
    if (this.mode === 'attract' && (!this.shot || this.shot.t >= this.shot.dur)) {
      this.shot = this.pickShot(cars, track);
    }
    const sh = this.shot!;
    sh.t += dt;
    const car = sh.car;
    const P = car.pos, F = car.forward, R = car.right, U = car.up;
    let fov = 50;
    switch (sh.kind) {
      case 'chase': {
        this.rig.cinematic = null;
        this.rig.target = car;
        return;
      }
      case 'trackside': {
        this.pos.copy(sh.anchor);
        this.look.copy(P).addScaledVector(U, 0.6);
        const dist = this.pos.distanceTo(P);
        fov = clamp(18 + dist * 0.35, 18, 55); // long lens when far, wide when close
        break;
      }
      case 'heli': {
        const a = sh.seed + sh.t * 0.25;
        this.pos.copy(P).addScaledVector(F, -14 + Math.sin(a) * 6).addScaledVector(R, Math.cos(a) * 16 * sh.side).add(this.tmp.set(0, 14, 0));
        this.look.copy(P).addScaledVector(F, 8);
        fov = 45;
        break;
      }
      case 'front': {
        this.pos.copy(P).addScaledVector(F, 9 + Math.sin(sh.t * 0.7) * 1.5).addScaledVector(R, 2.4 * sh.side).addScaledVector(U, 0.8);
        this.look.copy(P).addScaledVector(U, 0.7);
        fov = 48;
        break;
      }
      case 'wheel': {
        this.pos.copy(P).addScaledVector(R, (car.spec.width / 2 + 0.9) * sh.side).addScaledVector(F, -car.spec.length * 0.35).addScaledVector(U, 0.35);
        this.look.copy(P).addScaledVector(F, 12).addScaledVector(U, 0.4);
        fov = 62;
        break;
      }
      case 'intro': {
        const k = easeInOutCubic(clamp(sh.t / sh.dur, 0, 1));
        const ang = -2.4 + k * 2.4; // sweep from front-side to behind
        const r = 7.5 - k * 1.5;
        this.pos
          .copy(P)
          .addScaledVector(F, Math.cos(ang) * r)
          .addScaledVector(R, Math.sin(ang) * r)
          .addScaledVector(U, 1.2 + (1 - k) * 1.8);
        this.look.copy(P).addScaledVector(U, 0.7).addScaledVector(F, k * 3);
        fov = 42 + k * 16;
        if (sh.t >= sh.dur) {
          this.mode = 'off';
          this.rig.cinematic = null;
          this.rig.target = car;
          this.rig.reset();
          this.onIntroDone?.();
          return;
        }
        break;
      }
      case 'orbit': {
        const a = sh.t * 0.35 * sh.side + 0.6;
        this.pos.copy(P).addScaledVector(F, Math.cos(a) * 8).addScaledVector(R, Math.sin(a) * 8).addScaledVector(U, 2.2);
        this.look.copy(P).addScaledVector(U, 0.6);
        fov = 45;
        break;
      }
    }
    const c = this.rig.cinematic ?? { pos: new THREE.Vector3(), look: new THREE.Vector3(), fov: 50 };
    c.pos.copy(this.pos);
    c.look.copy(this.look);
    c.fov = fov;
    c.up = U.y > 0.3 ? undefined : U;
    this.rig.cinematic = c;
    this.rig.target = car;
  }
}
