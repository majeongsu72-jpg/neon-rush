import type * as THREE from 'three';
import type { Track } from '../track/Track';
import type { QualityProfile } from '../render/Renderer';
import type { Rng } from '../core/rng';

/** Post-processing look for a theme. */
export interface ThemeLook {
  exposure: number;
  bloom: number;
  threshold: number;
  saturation: number;
  contrast: number;
  lift: [number, number, number];
  gain: [number, number, number];
  vignette: number;
  grain: number;
  lineColor: [number, number, number];
}

export interface ThemeContext {
  track: Track;
  scene: THREE.Scene;
  gl: THREE.WebGLRenderer;
  quality: QualityProfile;
  rng: Rng;
  shared: { uTime: THREE.IUniform; uBeat: THREE.IUniform };
  progress: (p: number, label: string) => Promise<void>;
}

export interface ThemeInstance {
  root: THREE.Group;
  look: ThemeLook;
  songId: string;
  /** Light pool colour for car underbodies etc. */
  ambientTint: THREE.Color;
  /** s positions of close trackside objects (pillars, lamps) for "whomp" sounds. */
  passables: Float32Array;
  rain: number; // 0..1
  /** Night theme: cars project headlight pools/beams. */
  night?: boolean;
  sunLight: THREE.DirectionalLight | null;
  update(dt: number, time: number, camera: THREE.Camera, beat: number): void;
  /** Optional: start-gantry lights (n = 3,2,1 red; 0 = green; -1 = off). */
  onCountdown?(n: number): void;
  /**
   * Optional: fill the 4 lamps nearest to road position (s, d) — world
   * positions and HDR colours — used to light car paint. Return false if none.
   */
  lampsNear?(s: number, d: number, pos: THREE.Vector3[], col: THREE.Color[]): boolean;
  dispose(): void;
}

export type ThemeBuilder = (ctx: ThemeContext) => Promise<ThemeInstance>;
