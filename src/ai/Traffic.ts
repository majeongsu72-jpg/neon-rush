import * as THREE from 'three';
import type { Track } from '../track/Track';
import { makeFrame } from '../track/Track';
import { F_LOOP } from '../track/types';
import type { Collider } from '../vehicle/Collision';
import { Rng } from '../core/rng';
import { bakeGeometry } from '../world/props';
import { bakeCarGeometries } from '../vehicle/CarModel';
import { carById } from '../vehicle/specs';

interface TrafficType {
  name: string;
  length: number;
  width: number;
  height: number;
  speed: [number, number]; // m/s
  weight: number;
}

const TYPES: TrafficType[] = [
  { name: 'sedan', length: 4.6, width: 1.85, height: 1.45, speed: [24, 33], weight: 5 },
  { name: 'taxi', length: 4.7, width: 1.85, height: 1.5, speed: [24, 31], weight: 2 },
  { name: 'van', length: 5.1, width: 2.0, height: 2.1, speed: [21, 28], weight: 2 },
  { name: 'truck', length: 9.5, width: 2.5, height: 3.5, speed: [18, 24], weight: 1.5 },
  { name: 'bus', length: 11.5, width: 2.55, height: 3.2, speed: [17, 23], weight: 1 },
];

const PAINTS = [0xd8dce3, 0x1c1e24, 0x8a1a22, 0x284b8c, 0x6c7078, 0x2f5d3a, 0xc9a13b, 0x5a3e8a];

export class TrafficCar implements Collider {
  s = 0;
  d = 0;
  h = 0;
  theta = 0;
  vf = 0;
  vl = 0;
  omega = 0;
  mass = 5;
  kinematic = true;
  halfL: number;
  halfW: number;
  type: number;
  dir = 1; // +1 same direction, -1 oncoming
  lane = 0;
  targetD = 0;
  speed = 25;
  active = false;
  blink = 0; // lane-change indicator: -1 / 0 / 1
  blinkTimer = 0;
  wreck = 0; // seconds since wrecked (0 = fine)
  wreckV = new THREE.Vector3();
  wreckSpin = 0;
  wreckPos = new THREE.Vector3();
  wreckYaw = 0;
  paint = 0;
  // near-miss tracking
  nmActive = false;
  nmSign = 0;
  nmGap = 99;
  nmTouched = false;
  readonly id: number;

  constructor(id: number, type: number) {
    this.id = id;
    this.type = type;
    this.halfL = TYPES[type].length / 2;
    this.halfW = TYPES[type].width / 2;
  }
}

/** Build one car-ish body per type: lower body + cabin + wheels (baked, unit colours). */
function bodyGeometry(t: TrafficType): { body: THREE.BufferGeometry; dark: THREE.BufferGeometry; lights: THREE.BufferGeometry } {
  const L = t.length, W = t.width, H = t.height;
  const tall = H > 1.9;
  const parts = [];
  const lowerH = tall ? H * 0.72 : H * 0.48;
  parts.push({ geo: new THREE.BoxGeometry(W, lowerH, L), matrix: new THREE.Matrix4().makeTranslation(0, 0.3 + lowerH / 2, 0) });
  if (!tall) {
    const cabL = L * 0.5;
    parts.push({ geo: new THREE.BoxGeometry(W * 0.86, H - lowerH - 0.3, cabL), matrix: new THREE.Matrix4().makeTranslation(0, 0.3 + lowerH + (H - lowerH - 0.3) / 2, L * 0.04) });
  } else if (t.name === 'truck') {
    // cab at the front
    parts.push({ geo: new THREE.BoxGeometry(W * 0.98, H * 0.3, 2.2), matrix: new THREE.Matrix4().makeTranslation(0, 0.3 + lowerH + H * 0.15 - 0.2, -L / 2 + 1.1) });
  }
  const body = bakeGeometry(parts);
  const dark = [];
  // wheels
  const wr = tall ? 0.5 : 0.34;
  const axles = tall ? [-L / 2 + 1.4, L / 2 - 1.8, L / 2 - 3.2] : [-L / 2 + 0.95, L / 2 - 0.95];
  for (const z of axles) {
    for (const sx of [-1, 1]) {
      const c = new THREE.CylinderGeometry(wr, wr, 0.3, 12);
      c.rotateZ(Math.PI / 2);
      dark.push({ geo: c, matrix: new THREE.Matrix4().makeTranslation(sx * (W / 2 - 0.12), wr, z) });
    }
  }
  // windows band
  if (!tall) {
    dark.push({ geo: new THREE.BoxGeometry(W * 0.88, (H - lowerH - 0.3) * 0.6, L * 0.47), matrix: new THREE.Matrix4().makeTranslation(0, 0.3 + lowerH + (H - lowerH - 0.3) * 0.45, L * 0.04) });
  } else {
    dark.push({ geo: new THREE.BoxGeometry(W * 1.01, H * 0.16, L * 0.9), matrix: new THREE.Matrix4().makeTranslation(0, 0.3 + lowerH * 0.72, 0) });
  }
  const darkGeo = bakeGeometry(dark);
  // lights: head (front = -Z) white, tail red — colours baked as vertex colours (HDR)
  const lp: number[] = [];
  const lc: number[] = [];
  const quad = (x: number, y: number, z: number, w: number, h: number, col: [number, number, number], facing: number) => {
    const g = new THREE.PlaneGeometry(w, h);
    if (facing > 0) g.rotateY(Math.PI);
    g.translate(x, y, z);
    const nonIdx = g.toNonIndexed();
    const p = nonIdx.attributes.position;
    for (let i = 0; i < p.count; i++) {
      lp.push(p.getX(i), p.getY(i), p.getZ(i));
      lc.push(col[0], col[1], col[2]);
    }
  };
  const ly = 0.3 + lowerH * 0.55;
  for (const sx of [-1, 1]) {
    quad(sx * W * 0.34, ly, -L / 2 - 0.02, W * 0.2, 0.14, [5, 5, 4.5], -1); // headlights
    quad(sx * W * 0.36, ly, L / 2 + 0.02, W * 0.18, 0.14, [3.2, 0.1, 0.12], 1); // tail
  }
  const lights = new THREE.BufferGeometry();
  lights.setAttribute('position', new THREE.Float32BufferAttribute(lp, 3));
  lights.setAttribute('color', new THREE.Float32BufferAttribute(lc, 3));
  return { body, dark: darkGeo, lights };
}

/**
 * Highway traffic: kinematic lane-followers kept in a window around the
 * player and recycled ahead of it. Two left lanes carry oncoming traffic.
 */
export class Traffic {
  readonly group = new THREE.Group();
  readonly cars: TrafficCar[] = [];
  private readonly track: Track;
  private readonly rng: Rng;
  private readonly bodies: THREE.InstancedMesh[] = [];
  private readonly darks: THREE.InstancedMesh[] = [];
  private readonly lights: THREE.InstancedMesh[] = [];
  private readonly blinkers: THREE.InstancedMesh;
  private readonly perType: number;
  private readonly fr = makeFrame();
  private readonly m = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly p = new THREE.Vector3();
  private readonly sc = new THREE.Vector3(1, 1, 1);
  private readonly basis = new THREE.Matrix4();
  private readonly X = new THREE.Vector3();
  private readonly Z = new THREE.Vector3();
  private time = 0;
  density = 1;
  readonly pos = new Map<TrafficCar, THREE.Vector3>();
  readonly vel = new Map<TrafficCar, THREE.Vector3>();

  constructor(track: Track, seed: number, count = 46) {
    this.track = track;
    this.rng = new Rng(seed);
    this.perType = count;
    const bodyMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.35, metalness: 0.55, envMapIntensity: 1.1 });
    const darkMat = new THREE.MeshStandardMaterial({ color: 0x08090c, roughness: 0.25, metalness: 0.4 });
    const lightMat = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide });
    for (const t of TYPES) {
      // cars reuse the procedural sports-car bodies; big vehicles stay boxy
      const g =
        t.name === 'sedan'
          ? bakeCarGeometries(carById('volt'), carById('volt').paints[2])
          : t.name === 'taxi'
            ? bakeCarGeometries(carById('kitsune'), carById('kitsune').paints[0])
            : bodyGeometry(t);
      const b = new THREE.InstancedMesh(g.body, bodyMat, count);
      const d = new THREE.InstancedMesh(g.dark, darkMat, count);
      const l = new THREE.InstancedMesh(g.lights, lightMat, count);
      for (const im of [b, d, l]) {
        im.count = 0;
        im.frustumCulled = false;
        im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      }
      b.setColorAt(0, new THREE.Color(1, 1, 1)); // allocate instanceColor before warm-up
      this.bodies.push(b);
      this.darks.push(d);
      this.lights.push(l);
      this.group.add(b, d, l);
    }
    const blinkGeo = new THREE.SphereGeometry(0.12, 8, 6);
    this.blinkers = new THREE.InstancedMesh(blinkGeo, new THREE.MeshBasicMaterial({ color: new THREE.Color(5, 2.6, 0.2) }), count * 2);
    this.blinkers.count = 0;
    this.blinkers.frustumCulled = false;
    this.group.add(this.blinkers);
    for (let i = 0; i < count; i++) {
      let r = this.rng.next() * TYPES.reduce((a, t) => a + t.weight, 0);
      let type = 0;
      for (let k = 0; k < TYPES.length; k++) {
        r -= TYPES[k].weight;
        if (r <= 0) {
          type = k;
          break;
        }
      }
      const c = new TrafficCar(i, type);
      c.paint = type === 1 ? -1 : this.rng.int(0, PAINTS.length - 1);
      this.cars.push(c);
      this.pos.set(c, new THREE.Vector3());
      this.vel.set(c, new THREE.Vector3());
    }
  }

  laneInfo(s: number): { n: number; w: number; hw: number; oncoming: number } {
    const hw = this.track.halfWidthAt(s);
    const n = Math.max(3, Math.round((2 * hw - 1.2) / 4));
    return { n, w: (2 * hw - 1.2) / n, hw, oncoming: n >= 4 ? 2 : 1 };
  }

  laneCenter(s: number, lane: number): number {
    const li = this.laneInfo(s);
    return -li.hw + 0.6 + (lane + 0.5) * li.w;
  }

  /** Is lateral offset d in an oncoming lane at s? */
  isOncoming(s: number, d: number): boolean {
    const li = this.laneInfo(s);
    return d < -li.hw + 0.6 + li.oncoming * li.w;
  }

  private spawn(c: TrafficCar, sBase: number, ahead: boolean): void {
    const t = TYPES[c.type];
    const li = this.laneInfo(sBase);
    const onc = this.rng.chance(0.3);
    c.dir = onc ? -1 : 1;
    c.lane = onc ? this.rng.int(0, li.oncoming - 1) : this.rng.int(li.oncoming, li.n - 1);
    c.speed = this.rng.range(t.speed[0], t.speed[1]) * (onc ? 1.1 : 1);
    const dist = ahead ? this.rng.range(420, 900) : this.rng.range(-80, 700);
    c.s = this.track.wrap(sBase + dist);
    if (this.track.flagsAt(c.s) & F_LOOP) c.s = this.track.wrap(c.s + 200);
    c.d = c.targetD = this.laneCenter(c.s, c.lane);
    c.theta = c.dir > 0 ? 0 : Math.PI;
    c.vf = c.speed;
    c.vl = 0;
    c.omega = 0;
    c.active = true;
    c.wreck = 0;
    c.blink = 0;
    c.nmActive = false;
    // avoid overlapping another car in the same lane
    for (const o of this.cars) {
      if (o === c || !o.active || o.lane !== c.lane || o.dir !== c.dir) continue;
      if (Math.abs(this.track.delta(o.s, c.s)) < 30) c.s = this.track.wrap(c.s + 45);
    }
  }

  reset(playerS: number): void {
    const active = Math.round(this.cars.length * this.density);
    this.cars.forEach((c, i) => {
      if (i < active) this.spawn(c, playerS + 80, false);
      else c.active = false;
    });
  }

  update(dt: number, playerS: number): void {
    this.time += dt;
    const tr = this.track;
    const target = Math.round(this.cars.length * this.density);
    let activeCount = 0;
    for (const c of this.cars) if (c.active) activeCount++;
    for (const c of this.cars) {
      if (!c.active) {
        if (activeCount < target) {
          this.spawn(c, playerS, true);
          activeCount++;
        }
        continue;
      }
      const rel = tr.delta(playerS, c.s);
      if (c.wreck > 0) {
        c.wreck += dt;
        c.wreckV.multiplyScalar(Math.exp(-1.2 * dt));
        c.wreckV.y -= 9.8 * dt;
        c.wreckPos.addScaledVector(c.wreckV, dt);
        if (c.wreckPos.y < this.wreckFloor(c)) {
          c.wreckPos.y = this.wreckFloor(c);
          c.wreckV.y = Math.abs(c.wreckV.y) * 0.25;
        }
        c.wreckYaw += c.wreckSpin * dt;
        c.wreckSpin *= Math.exp(-0.8 * dt);
        if (c.wreck > 3.5 || rel < -150) c.active = false;
        continue;
      }
      if (rel < -160 || rel > 1100) {
        c.active = false;
        continue;
      }
      // follow the car ahead in the same lane
      let v = c.speed;
      for (const o of this.cars) {
        if (o === c || !o.active || o.dir !== c.dir || o.wreck > 0) continue;
        if (Math.abs(o.d - c.d) > 2.2) continue;
        const ahead = tr.delta(c.s, o.s) * c.dir;
        if (ahead > 0 && ahead < 26 + c.halfL + o.halfL) v = Math.min(v, o.vf * 0.98);
      }
      c.vf += (v - c.vf) * Math.min(1, dt * 1.5);
      // occasional lane changes (same-direction lanes)
      c.blinkTimer -= dt;
      if (c.blinkTimer <= 0) {
        if (c.blink !== 0) {
          const li = this.laneInfo(c.s);
          const nl = c.lane + c.blink;
          const lo = c.dir > 0 ? li.oncoming : 0;
          const hi = c.dir > 0 ? li.n - 1 : li.oncoming - 1;
          if (nl >= lo && nl <= hi) c.lane = nl;
          c.blink = 0;
          c.blinkTimer = this.rng.range(6, 14);
        } else if (this.rng.chance(0.25)) {
          c.blink = this.rng.sign();
          c.blinkTimer = 1.6;
        } else c.blinkTimer = this.rng.range(3, 8);
      }
      c.targetD = this.laneCenter(c.s, c.lane);
      const dd = c.targetD - c.d;
      c.d += Math.sign(dd) * Math.min(Math.abs(dd), 1.8 * dt);
      c.s = tr.wrap(c.s + c.vf * c.dir * dt);
      c.theta = (c.dir > 0 ? 0 : Math.PI) + Math.atan2(Math.sign(dd) * Math.min(Math.abs(dd), 1.8) * c.dir, Math.max(5, c.vf)) * 0.6;
    }
  }

  private wreckFloor(c: TrafficCar): number {
    const fr = this.track.sample(c.s, this.fr);
    return fr.pos.y;
  }

  /** Knock a traffic car off its lane (called on a hard hit). */
  wreckCar(c: TrafficCar, impulse: THREE.Vector3): void {
    if (c.wreck > 0) return;
    const P = this.pos.get(c)!;
    c.wreck = 0.001;
    c.wreckPos.copy(P);
    const V = this.vel.get(c)!;
    c.wreckV.copy(V).add(impulse);
    c.wreckV.y += 3 + impulse.length() * 0.15;
    c.wreckSpin = (Math.random() - 0.5) * 6;
    c.wreckYaw = Math.atan2(-this.fr.T.x, -this.fr.T.z);
  }

  /** Update instance matrices + world positions (call once per render frame). */
  render(): void {
    const tr = this.track;
    const counts = new Array(TYPES.length).fill(0);
    let blinks = 0;
    const blinkOn = Math.floor(this.time * 3) % 2 === 0;
    for (const c of this.cars) {
      if (!c.active) continue;
      const t = c.type;
      const i = counts[t]++;
      if (c.wreck > 0) {
        this.p.copy(c.wreckPos);
        this.q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), c.wreckYaw);
        const tilt = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.sin(c.wreck * 5) * 0.3);
        this.q.multiply(tilt);
        this.m.compose(this.p, this.q, this.sc);
        this.pos.get(c)!.copy(this.p);
      } else {
        const fr = tr.surface(c.s, c.d, this.fr);
        this.p.copy(fr.pos);
        const ct = Math.cos(c.theta), st = Math.sin(c.theta);
        this.Z.copy(fr.T).multiplyScalar(ct).addScaledVector(fr.R, st).negate(); // model forward is -Z
        this.X.crossVectors(fr.U, this.Z).normalize();
        this.basis.makeBasis(this.X, fr.U, this.Z);
        this.q.setFromRotationMatrix(this.basis);
        this.m.compose(this.p, this.q, this.sc);
        this.pos.get(c)!.copy(this.p);
        this.vel.get(c)!.copy(fr.T).multiplyScalar(c.vf * c.dir);
      }
      this.bodies[t].setMatrixAt(i, this.m);
      this.darks[t].setMatrixAt(i, this.m);
      this.lights[t].setMatrixAt(i, this.m);
      const col = new THREE.Color(c.paint < 0 ? 0xf2c21a : PAINTS[c.paint]);
      this.bodies[t].setColorAt(i, col);
      if (c.blink !== 0 && blinkOn && c.wreck === 0) {
        const ty = TYPES[t];
        for (const zz of [-ty.length / 2, ty.length / 2]) {
          const bp = new THREE.Vector3(c.blink * ty.width * 0.48, 0.3 + ty.height * 0.3, zz).applyMatrix4(this.m);
          this.m.clone();
          this.blinkers.setMatrixAt(blinks++, new THREE.Matrix4().makeTranslation(bp.x, bp.y, bp.z));
        }
      }
    }
    for (let t = 0; t < TYPES.length; t++) {
      for (const im of [this.bodies[t], this.darks[t], this.lights[t]]) {
        im.count = counts[t];
        im.instanceMatrix.needsUpdate = true;
      }
      if (this.bodies[t].instanceColor) this.bodies[t].instanceColor!.needsUpdate = true;
    }
    this.blinkers.count = blinks;
    this.blinkers.instanceMatrix.needsUpdate = true;
  }

  dispose(): void {
    this.group.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) {
        m.geometry.dispose();
        (m.material as THREE.Material).dispose();
      }
    });
  }
}
