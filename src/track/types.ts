export type ThemeId = 'neon' | 'coast' | 'grid';

export interface ControlPoint {
  x: number;
  y: number; // elevation (m)
  z: number;
  /** Half road width override (m). */
  w?: number;
  /** Manual bank in degrees (positive = right edge lower), added on top of auto-banking. */
  bank?: number;
}

export type SectionKind =
  | 'tunnel'
  | 'bridge'
  | 'loop'
  | 'jump'
  | 'noAutoBank'
  | 'canal'
  | 'plaza'
  | 'elevated'
  | 'beach'
  | 'cliff'
  | 'rings'
  | 'city'
  | 'lighthouse';

export interface SectionDef {
  kind: SectionKind;
  /** Control point index (fractional allowed) where the section starts / ends. */
  from: number;
  to: number;
  /** Loop sections: fixed right-vector (the loop axis). */
  axis?: [number, number, number];
  /** Free-form parameters for theme builders. */
  side?: number;
  param?: number;
}

export interface BoostPadDef {
  at: number; // control point index (fractional)
  d: number; // lateral offset of pad center
  length?: number;
  width?: number;
}

export interface TrackDef {
  id: string;
  name: string;
  nameKo: string;
  subtitle: string;
  theme: ThemeId;
  points: ControlPoint[];
  halfWidth: number;
  /** Auto-bank factor: bank(rad) = autoBank * curvature(1/m). */
  autoBank: number;
  /** Max auto bank in degrees. */
  maxBank: number;
  sections: SectionDef[];
  boostPads?: BoostPadDef[];
  laps: number;
  seed: number;
  /** Direction the sun / key light comes from (theme lighting). */
  sunDir?: [number, number, number];
}

// Per-sample bit flags
export const F_TUNNEL = 1;
export const F_BRIDGE = 2;
export const F_LOOP = 4;
export const F_JUMP = 8;
export const F_ELEVATED = 16;
export const F_BOOST = 32;

export interface ResolvedSection {
  kind: SectionKind;
  s0: number;
  s1: number;
  def: SectionDef;
}

export interface ResolvedBoostPad {
  s0: number;
  s1: number;
  d: number;
  halfWidth: number;
}
