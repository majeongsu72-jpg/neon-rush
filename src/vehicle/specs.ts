export type BodyStyle = 'gt' | 'hyper' | 'jdm' | 'muscle';

export interface PaintDef {
  name: string;
  color: number;
  accent: number; // stripes / livery
  glow: number; // underglow + light accents
  metal: number; // metalness 0..1
}

export interface EngineSound {
  cylinders: number; // firing frequency = rpm/60 * cylinders/2
  /** 0..1 — how raspy / high-harmonic the tone is. */
  rasp: number;
  /** 0..1 — low-end body. */
  body: number;
  turbo: number; // 0..1 turbo whistle amount
  pitch: number; // multiplier on firing frequency
}

export interface CarSpec {
  id: string;
  name: string;
  nameKo: string;
  tagline: string;
  style: BodyStyle;
  stats: { speed: number; accel: number; handling: number; drift: number; nitro: number };
  // --- dynamics (SI units)
  mass: number; // relative mass for collisions
  vTop: number; // m/s
  accel: number; // m/s² base (0-100 km/h ≈ 27.8 / accel)
  accelExp: number;
  brake: number;
  reverseAccel: number;
  reverseMax: number;
  aLat: number; // lateral acceleration capability (grip)
  yawLow: number; // rad/s cap at low speed
  yawResp: number; // 1/s
  grip: number; // 1/s lateral velocity decay
  driftLat: number;
  driftGrip: number;
  driftDrag: number;
  driftMaxAngle: number; // rad
  nitroAccel: number;
  nitroTop: number;
  nitroDrain: number; // tank fraction per second
  gears: number[]; // fraction of vTop at the top of each gear
  idleRpm: number;
  redline: number;
  // --- dimensions (m)
  length: number;
  width: number;
  height: number;
  wheelBase: number;
  track: number;
  wheelRadius: number;
  engine: EngineSound;
  paints: PaintDef[];
}

const gears6 = [0.25, 0.41, 0.56, 0.7, 0.84, 1.0];

export const CARS: CarSpec[] = [
  {
    id: 'volt',
    name: 'VOLT GT',
    nameKo: '볼트 GT',
    tagline: '균형 잡힌 그랜드 투어러. 어떤 트랙에서도 믿을 수 있다.',
    style: 'gt',
    stats: { speed: 7, accel: 7, handling: 7, drift: 7, nitro: 7 },
    mass: 1.0,
    vTop: 90,
    accel: 15.5,
    accelExp: 2.4,
    brake: 30,
    reverseAccel: 9,
    reverseMax: 16,
    aLat: 31,
    yawLow: 1.75,
    yawResp: 12,
    grip: 13,
    driftLat: 39,
    driftGrip: 1.55,
    driftDrag: 2.2,
    driftMaxAngle: 0.92,
    nitroAccel: 11,
    nitroTop: 1.2,
    nitroDrain: 0.27,
    gears: gears6,
    idleRpm: 950,
    redline: 8200,
    length: 4.55,
    width: 1.98,
    height: 1.24,
    wheelBase: 2.72,
    track: 1.66,
    wheelRadius: 0.35,
    engine: { cylinders: 8, rasp: 0.45, body: 0.7, turbo: 0.35, pitch: 1.0 },
    paints: [
      { name: 'CYBER CYAN', color: 0x0fd8e8, accent: 0x101418, glow: 0x19f5ff, metal: 0.7 },
      { name: 'VOID BLACK', color: 0x0c0d12, accent: 0x19f5ff, glow: 0x19f5ff, metal: 0.55 },
      { name: 'PEARL WHITE', color: 0xe8ecf2, accent: 0x14c8ff, glow: 0x3ab8ff, metal: 0.35 },
      { name: 'ULTRAVIOLET', color: 0x6a2cff, accent: 0xffffff, glow: 0xb04bff, metal: 0.75 },
    ],
  },
  {
    id: 'raptor',
    name: 'RAPTOR R',
    nameKo: '랩터 R',
    tagline: '최고속도 특화 하이퍼카. 직선에서는 누구도 따라올 수 없다.',
    style: 'hyper',
    stats: { speed: 10, accel: 7, handling: 5, drift: 5, nitro: 8 },
    mass: 0.95,
    vTop: 97,
    accel: 15,
    accelExp: 2.7,
    brake: 32,
    reverseAccel: 9,
    reverseMax: 16,
    aLat: 28.5,
    yawLow: 1.6,
    yawResp: 10.5,
    grip: 13.5,
    driftLat: 35,
    driftGrip: 1.8,
    driftDrag: 2.6,
    driftMaxAngle: 0.8,
    nitroAccel: 12,
    nitroTop: 1.2,
    nitroDrain: 0.25,
    gears: [0.24, 0.39, 0.54, 0.68, 0.83, 1.0],
    idleRpm: 1100,
    redline: 9000,
    length: 4.7,
    width: 2.04,
    height: 1.1,
    wheelBase: 2.78,
    track: 1.72,
    wheelRadius: 0.36,
    engine: { cylinders: 12, rasp: 0.7, body: 0.5, turbo: 0.1, pitch: 1.0 },
    paints: [
      { name: 'INFERNO RED', color: 0xe8141e, accent: 0x111111, glow: 0xff2a3a, metal: 0.6 },
      { name: 'SOLAR GOLD', color: 0xf2b21c, accent: 0x111111, glow: 0xffc02a, metal: 0.85 },
      { name: 'CARBON', color: 0x1b1d22, accent: 0xff2a3a, glow: 0xff2a3a, metal: 0.4 },
      { name: 'ACID GREEN', color: 0x7cf21c, accent: 0x111111, glow: 0x9cff2a, metal: 0.55 },
    ],
  },
  {
    id: 'kitsune',
    name: 'KITSUNE',
    nameKo: '키츠네',
    tagline: '드리프트의 여우. 코너에서 부스트를 쌓아 추월한다.',
    style: 'jdm',
    stats: { speed: 6, accel: 7, handling: 9, drift: 10, nitro: 7 },
    mass: 0.9,
    vTop: 86,
    accel: 16,
    accelExp: 2.3,
    brake: 31,
    reverseAccel: 10,
    reverseMax: 17,
    aLat: 34,
    yawLow: 1.95,
    yawResp: 13.5,
    grip: 12.5,
    driftLat: 44,
    driftGrip: 1.3,
    driftDrag: 1.7,
    driftMaxAngle: 1.02,
    nitroAccel: 11,
    nitroTop: 1.19,
    nitroDrain: 0.27,
    gears: gears6,
    idleRpm: 1000,
    redline: 8800,
    length: 4.4,
    width: 1.9,
    height: 1.26,
    wheelBase: 2.6,
    track: 1.6,
    wheelRadius: 0.34,
    engine: { cylinders: 6, rasp: 0.6, body: 0.45, turbo: 0.9, pitch: 1.12 },
    paints: [
      { name: 'SAKURA WHITE', color: 0xf1f1f4, accent: 0xff2bd6, glow: 0xff2bd6, metal: 0.3 },
      { name: 'MIDNIGHT PURPLE', color: 0x2a0f4a, accent: 0x28f0ff, glow: 0xb04bff, metal: 0.8 },
      { name: 'HOT PINK', color: 0xff2b9a, accent: 0x111111, glow: 0xff5bd6, metal: 0.5 },
      { name: 'RALLY BLUE', color: 0x1446d8, accent: 0xf2d21c, glow: 0x3a8bff, metal: 0.6 },
    ],
  },
  {
    id: 'titan',
    name: 'TITAN V8',
    nameKo: '타이탄 V8',
    tagline: '폭발적인 가속의 머슬카. 몸싸움에서도 밀리지 않는다.',
    style: 'muscle',
    stats: { speed: 7, accel: 10, handling: 5, drift: 7, nitro: 8 },
    mass: 1.3,
    vTop: 89,
    accel: 18.5,
    accelExp: 2.2,
    brake: 28,
    reverseAccel: 10,
    reverseMax: 16,
    aLat: 29.5,
    yawLow: 1.65,
    yawResp: 11,
    grip: 12,
    driftLat: 38,
    driftGrip: 1.5,
    driftDrag: 2.0,
    driftMaxAngle: 0.98,
    nitroAccel: 12.5,
    nitroTop: 1.2,
    nitroDrain: 0.3,
    gears: [0.28, 0.45, 0.6, 0.74, 0.87, 1.0],
    idleRpm: 800,
    redline: 7200,
    length: 4.75,
    width: 2.0,
    height: 1.3,
    wheelBase: 2.8,
    track: 1.7,
    wheelRadius: 0.36,
    engine: { cylinders: 8, rasp: 0.3, body: 1.0, turbo: 0.0, pitch: 0.82 },
    paints: [
      { name: 'BLAZE ORANGE', color: 0xff6a12, accent: 0x111111, glow: 0xff8a2a, metal: 0.55 },
      { name: 'GUNMETAL', color: 0x3a3f48, accent: 0xff6a12, glow: 0xff6a12, metal: 0.8 },
      { name: 'VENOM GREEN', color: 0x12a84a, accent: 0xffffff, glow: 0x2aff8a, metal: 0.6 },
      { name: 'ROYAL NAVY', color: 0x14224a, accent: 0xffffff, glow: 0x3a6bff, metal: 0.65 },
    ],
  },
];

export const carById = (id: string): CarSpec => CARS.find((c) => c.id === id) ?? CARS[0];
