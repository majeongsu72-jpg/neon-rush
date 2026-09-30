import * as THREE from 'three';
import { GpuParticles } from './GpuParticles';
import { SkidMarks } from './SkidMarks';
import { LightTrails } from './LightTrails';
import { Weather } from './Weather';
import type { Vehicle } from '../vehicle/Vehicle';
import type { GameEvents } from '../core/Events';
import type { ThemeId } from '../track/types';
import { F_TUNNEL } from '../track/types';
import type { Track } from '../track/Track';
import { clamp } from '../core/math';

const DRIFT_COLORS: [number, number, number][] = [
  [3.2, 1.6, 0.5],
  [0.5, 1.6, 5.5],
  [5.0, 1.5, 0.25],
  [3.6, 0.5, 5.2],
];

interface ThemeFx {
  smoke: [number, number, number];
  smokeAlpha: number;
  rain: boolean;
  dust: THREE.Color;
}

const THEME_FX: Record<ThemeId, ThemeFx> = {
  neon: { smoke: [0.32, 0.3, 0.42], smokeAlpha: 0.22, rain: true, dust: new THREE.Color(0.35, 0.45, 0.7) },
  coast: { smoke: [0.85, 0.72, 0.66], smokeAlpha: 0.2, rain: false, dust: new THREE.Color(1.0, 0.75, 0.5) },
  grid: { smoke: [0.25, 0.55, 0.8], smokeAlpha: 0.16, rain: false, dust: new THREE.Color(0.3, 1.4, 1.8) },
};

/** Drives all particle-ish effects from vehicle state + gameplay events. */
export class Effects {
  readonly group = new THREE.Group();
  readonly add: GpuParticles;
  readonly smoke: GpuParticles;
  readonly skids: SkidMarks;
  readonly trails: LightTrails;
  readonly rain: Weather | null;
  readonly dust: Weather;
  private readonly fx: ThemeFx;
  private readonly scale: number;
  private time = 0;
  private readonly unsub: (() => void)[] = [];
  private readonly v = new THREE.Vector3();
  private readonly w = new THREE.Vector3();
  private readonly r = new THREE.Vector3();
  private readonly tailCol = new THREE.Color(3.2, 0.12, 0.16);
  private readonly camVel = new THREE.Vector3();
  private readonly lastCam = new THREE.Vector3();
  private acc = new Map<Vehicle, number>();
  focus: Vehicle | null = null;
  hideFocusTrails = true;

  constructor(theme: ThemeId, events: GameEvents, particleScale: number, rainScale: number) {
    this.scale = particleScale;
    this.fx = THEME_FX[theme];
    this.add = new GpuParticles(Math.round(5000 * particleScale), 'additive');
    this.smoke = new GpuParticles(Math.round(1800 * particleScale), 'alpha');
    this.skids = new SkidMarks(2600);
    this.trails = new LightTrails(40, 28);
    this.group.add(this.skids.mesh, this.smoke.mesh, this.add.mesh, this.trails.mesh);
    if (this.fx.rain && rainScale > 0) {
      this.rain = new Weather(
        {
          count: Math.round(5200 * rainScale),
          box: [70, 40, 70],
          fall: [1.5, -17, 0.8],
          color: new THREE.Color(0.55, 0.62, 0.8),
          opacity: 0.35,
          width: 0.012,
          len: 0.035,
        },
        3,
      );
      this.group.add(this.rain.mesh);
    } else this.rain = null;
    this.dust = new Weather(
      {
        count: Math.round(900 * Math.max(0.5, particleScale)),
        box: [90, 40, 90],
        fall: [0.3, -0.25, 0.2],
        color: this.fx.dust,
        opacity: 0.22,
        width: 0.02,
        len: 0.022,
      },
      11,
    );
    this.group.add(this.dust.mesh);
    this.wire(events);
  }

  private wire(ev: GameEvents): void {
    this.unsub.push(
      ev.on('wallHit', ({ car, impact, side }) => {
        const n = Math.round(clamp(impact * 3, 6, 60) * this.scale);
        this.localPoint(car, side * car.spec.width * 0.5, 0.35, -car.spec.length * 0.25, this.v);
        this.sparkBurst(this.v, car, n, side, impact);
      }),
      ev.on('carHit', ({ a, b, impact }) => {
        this.v.copy(a.pos).add(b.pos).multiplyScalar(0.5);
        this.v.y += 0.4;
        this.sparkBurst(this.v, a, Math.round(clamp(impact * 3, 5, 45) * this.scale), 0, impact);
      }),
      ev.on('landing', ({ car, impact }) => {
        if (impact < 3) return;
        for (const i of [2, 3]) {
          this.wheelContact(car, i, this.v);
          this.sparkBurst(this.v, car, Math.round(impact * 2.5 * this.scale), 0, impact * 0.7);
        }
      }),
      ev.on('backfire', ({ car, strength }) => this.flameBurst(car, 6 + Math.round(strength * 8), [5, 2.1, 0.5], 0.5)),
      ev.on('boost', ({ car, kind }) => this.flameBurst(car, kind === 'pad' ? 30 : 18, [1.5, 2.8, 6], 1)),
      ev.on('nitroStart', ({ car }) => this.flameBurst(car, 30, [2, 3.4, 7], 1.3)),
    );
  }

  /** World position of a point in car-local coordinates. */
  private localPoint(car: Vehicle, x: number, y: number, z: number, out: THREE.Vector3): THREE.Vector3 {
    return out.set(x, y, z).applyMatrix4(car.model.root.matrixWorld);
  }

  private wheelContact(car: Vehicle, i: number, out: THREE.Vector3): THREE.Vector3 {
    const wp = car.model.wheelPos[i];
    return this.localPoint(car, wp.x, 0.03, wp.z, out);
  }

  private sparkBurst(p: THREE.Vector3, car: Vehicle, n: number, side: number, impact: number): void {
    const vel = car.velocity;
    for (let i = 0; i < n; i++) {
      const sp = 3 + Math.random() * (4 + impact * 0.8);
      const vx = vel.x * 0.55 + (Math.random() - 0.5) * sp * 2 - car.right.x * side * sp;
      const vy = Math.random() * sp * 0.9 + 1;
      const vz = vel.z * 0.55 + (Math.random() - 0.5) * sp * 2 - car.right.z * side * sp;
      this.add.emit(p.x, p.y, p.z, vx, vy, vz, {
        life: 0.25 + Math.random() * 0.55,
        size0: 0.05 + Math.random() * 0.05,
        size1: 0.015,
        r: 6,
        g: 2.8 + Math.random() * 1.5,
        b: 0.9,
        a: 1,
        drag: 1.2,
        gravity: 9.8,
        stretch: 1.2,
      });
    }
  }

  private flameBurst(car: Vehicle, n: number, col: [number, number, number], size: number): void {
    const back = this.w.copy(car.forward).multiplyScalar(-1);
    for (const ex of car.model.exhausts) {
      this.localPoint(car, ex.x, ex.y, ex.z + 0.1, this.v);
      for (let i = 0; i < n; i++) {
        const sp = 4 + Math.random() * 7;
        this.add.emit(
          this.v.x, this.v.y, this.v.z,
          car.velocity.x + back.x * sp + (Math.random() - 0.5) * 2,
          car.velocity.y + back.y * sp + Math.random() * 1.2,
          car.velocity.z + back.z * sp + (Math.random() - 0.5) * 2,
          { life: 0.08 + Math.random() * 0.16, size0: 0.22 * size, size1: 0.5 * size, r: col[0], g: col[1], b: col[2], a: 0.9, drag: 5, gravity: -2, stretch: 0.4 },
        );
      }
    }
  }

  /** Per-frame emission from continuous car states. */
  update(dt: number, simTime: number, cars: readonly Vehicle[], camera: THREE.Camera, track: Track): void {
    this.time = simTime;
    const sc = this.scale;
    for (const car of cars) {
      if (!car.visible) continue;
      const b = car.body;
      const speed = Math.abs(b.vf);
      const camDist = car.pos.distanceTo(camera.position);
      const lod = camDist < 60 ? 1 : camDist < 160 ? 0.5 : 0.15;

      // --- tyre marks + smoke + drift sparks
      const sliding = b.grounded && (b.drifting || Math.abs(b.slipAngle) > 0.09 || (b.brake > 0.8 && speed > 15 && speed < 45));
      for (const i of [2, 3]) {
        this.wheelContact(car, i, this.v);
        this.r.copy(car.right);
        this.skids.track(`${car.id}-${i}`, this.v, this.r, sliding && speed > 6, b.drifting ? 1 : 0.6);
      }
      if (b.drifting && b.grounded && speed > 12) {
        const lvl = b.driftLevel;
        const col = DRIFT_COLORS[lvl];
        const rate = (lvl > 0 ? 70 : 28) * sc * lod;
        const n = this.accumulate(car, rate * dt);
        for (let k = 0; k < n; k++) {
          const wi = Math.random() < 0.5 ? 2 : 3;
          this.wheelContact(car, wi, this.v);
          const sp = 2 + Math.random() * 5;
          this.add.emit(
            this.v.x, this.v.y + 0.05, this.v.z,
            car.velocity.x * 0.7 - car.forward.x * sp + (Math.random() - 0.5) * 3,
            1 + Math.random() * 3,
            car.velocity.z * 0.7 - car.forward.z * sp + (Math.random() - 0.5) * 3,
            { life: 0.2 + Math.random() * 0.35, size0: 0.05 + lvl * 0.012, size1: 0.01, r: col[0], g: col[1], b: col[2], a: 1, drag: 1.5, gravity: 7, stretch: 1.3 },
          );
        }
      }
      if (sliding && speed > 8 && lod > 0.2) {
        const rate = (b.drifting ? 26 : 12) * sc * lod * clamp(speed / 30, 0.3, 1.2);
        const n = Math.floor(rate * dt + Math.random());
        const [cr, cg, cb] = this.fx.smoke;
        for (let k = 0; k < n; k++) {
          const wi = Math.random() < 0.5 ? 2 : 3;
          this.wheelContact(car, wi, this.v);
          this.smoke.emit(
            this.v.x, this.v.y + 0.25, this.v.z,
            car.velocity.x * 0.35 + (Math.random() - 0.5) * 2,
            0.6 + Math.random() * 1.2,
            car.velocity.z * 0.35 + (Math.random() - 0.5) * 2,
            { life: 1.1 + Math.random() * 1.1, size0: 0.6, size1: 3.6 + Math.random() * 1.5, r: cr, g: cg, b: cb, a: this.fx.smokeAlpha, drag: 1.8, gravity: -0.6, spin: (Math.random() - 0.5) * 1.5 },
          );
        }
      }

      // --- wall grind sparks
      if (b.wallSide !== 0 && b.scrape > 0.05 && speed > 5) {
        const n = Math.floor(80 * b.scrape * sc * lod * dt + Math.random());
        for (let k = 0; k < n; k++) {
          const z = (Math.random() - 0.3) * car.spec.length * 0.8;
          this.localPoint(car, b.wallSide * car.spec.width * 0.5, 0.3 + Math.random() * 0.3, z, this.v);
          const sp = 2 + Math.random() * 5;
          this.add.emit(
            this.v.x, this.v.y, this.v.z,
            car.velocity.x * 0.8 - car.right.x * b.wallSide * sp,
            Math.random() * 3 + 0.5,
            car.velocity.z * 0.8 - car.right.z * b.wallSide * sp,
            { life: 0.2 + Math.random() * 0.4, size0: 0.05, size1: 0.012, r: 6, g: 3, b: 1, a: 1, drag: 1, gravity: 9.8, stretch: 1.3 },
          );
        }
      }

      // --- exhaust flames (nitro / mini-turbo)
      const boosting = b.nitroActive || b.boostTime > 0;
      if (boosting && lod > 0.2) {
        const nitro = b.nitroActive;
        const rate = (nitro ? 120 : 70) * sc * lod;
        for (const ex of car.model.exhausts) {
          const n = Math.floor(rate * dt + Math.random());
          this.localPoint(car, ex.x, ex.y, ex.z + 0.05, this.v);
          for (let k = 0; k < n; k++) {
            const sp = 7 + Math.random() * 7;
            const hot = Math.random();
            this.add.emit(
              this.v.x, this.v.y, this.v.z,
              car.velocity.x - car.forward.x * sp + (Math.random() - 0.5) * 1.2,
              car.velocity.y - car.forward.y * sp + (Math.random() - 0.5) * 1.2,
              car.velocity.z - car.forward.z * sp + (Math.random() - 0.5) * 1.2,
              nitro
                ? { life: 0.06 + Math.random() * 0.1, size0: 0.28, size1: 0.12, r: 1.6 + hot * 2, g: 2.6 + hot * 2, b: 7, a: 0.85, drag: 3, gravity: 0, stretch: 0.6 }
                : { life: 0.05 + Math.random() * 0.08, size0: 0.2, size1: 0.1, r: 4.5, g: 1.8 + hot * 2, b: 0.8 + hot * 3, a: 0.8, drag: 3, gravity: 0, stretch: 0.6 },
            );
          }
        }
      }

      // --- slipstream: air streaks peeling off the body
      if (b.draft > 0.25 && lod > 0.4) {
        const n = Math.floor(90 * b.draft * sc * dt + Math.random());
        for (let k = 0; k < n; k++) {
          const side = Math.random() < 0.5 ? -1 : 1;
          const z = (Math.random() - 0.5) * car.spec.length;
          this.localPoint(car, side * (car.spec.width * 0.55 + Math.random() * 0.5), 0.4 + Math.random() * 0.9, z, this.v);
          const sp = 14 + Math.random() * 10;
          this.add.emit(
            this.v.x, this.v.y, this.v.z,
            car.velocity.x - car.forward.x * sp,
            car.velocity.y - car.forward.y * sp,
            car.velocity.z - car.forward.z * sp,
            { life: 0.18 + Math.random() * 0.15, size0: 0.02, size1: 0.01, r: 0.9, g: 1.1, b: 1.4, a: 0.35 * b.draft, drag: 0.5, gravity: 0, stretch: 2.2 },
          );
        }
      }

      // --- light trails (tail lights) at speed
      const trailI = clamp((speed - 30) / 40, 0, 1) * (car === this.focus && this.hideFocusTrails ? 0 : 1);
      car.model.tailLights.forEach((tl, i) => {
        this.localPoint(car, tl.x, tl.y, tl.z + 0.05, this.v);
        const col = this.tailCol;
        const k = 0.6 + car.brakeGlow * 1.6;
        this.trails.feed(`${car.id}-${i}`, this.v, col.setRGB(3.2 * k, 0.12 * k, 0.16 * k), trailI * 0.55, 0.13, car.id);
      });
    }

    // --- weather follows the camera
    const cam = camera.position;
    if (dt > 0) {
      this.camVel.copy(cam).sub(this.lastCam).multiplyScalar(1 / Math.max(dt, 1e-3));
      if (this.camVel.lengthSq() > 150 * 150) this.camVel.set(0, 0, 0); // camera cut
    }
    this.lastCam.copy(cam);
    if (this.rain) {
      const focus = this.focus;
      const inTunnel = focus ? (track.flagsAt(focus.renderS) & F_TUNNEL) !== 0 : false;
      this.rain.amount += ((inTunnel ? 0 : 1) - this.rain.amount) * Math.min(1, dt * 3);
      this.rain.update(simTime, cam, this.camVel);
    }
    this.dust.update(simTime, cam, this.camVel);

    this.add.update(simTime);
    this.smoke.update(simTime);
    this.skids.update(simTime);
    // a car driving in someone's light streak cuts it off just ahead of its nose
    this.trails.clearOccluders();
    for (const car of cars) {
      if (!car.visible) continue;
      this.w.copy(car.pos).addScaledVector(car.up, 0.6);
      this.trails.addOccluder(this.w, car.forward, car.spec.length / 2 + 1.0, car.spec.width / 2 + 0.5, car.id);
    }
    this.trails.update(camera);
  }

  /** Firework burst (celebrations). */
  firework(center: THREE.Vector3, hue = Math.random()): void {
    const col = new THREE.Color().setHSL(hue, 1, 0.55).multiplyScalar(5);
    const n = Math.round(160 * Math.max(0.5, this.scale));
    for (let i = 0; i < n; i++) {
      // uniform directions on a sphere
      const u = Math.random() * 2 - 1, a = Math.random() * Math.PI * 2;
      const r = Math.sqrt(1 - u * u);
      const sp = 14 + Math.random() * 6;
      const white = Math.random() < 0.15;
      this.add.emit(center.x, center.y, center.z, r * Math.cos(a) * sp, u * sp, r * Math.sin(a) * sp, {
        life: 1.3 + Math.random() * 1.1,
        size0: 0.35,
        size1: 0.1,
        r: white ? 6 : col.r,
        g: white ? 6 : col.g,
        b: white ? 6 : col.b,
        a: 1,
        drag: 1.1,
        gravity: 4,
        stretch: 0.6,
      });
    }
  }

  private accumulate(car: Vehicle, n: number): number {
    const a = (this.acc.get(car) ?? 0) + n;
    const whole = Math.floor(a);
    this.acc.set(car, a - whole);
    return whole;
  }

  reset(): void {
    this.skids.clear();
    this.trails.clear();
    this.acc.clear();
  }

  dispose(): void {
    for (const u of this.unsub) u();
    this.add.dispose();
    this.smoke.dispose();
    this.skids.dispose();
    this.trails.dispose();
    this.rain?.dispose();
    this.dust.dispose();
  }
}
