import * as THREE from 'three';
import { buildTrack, validateTrack } from '../track/TrackBuilder';
import { computeRacingLine } from '../track/RacingLine';
import { computeCurbRuns, curbMask } from '../track/TrackMesh';
import type { Track } from '../track/Track';
import type { TrackDef, ThemeId } from '../track/types';
import type { ThemeBuilder, ThemeInstance } from './types';
import type { QualityProfile } from '../render/Renderer';
import { Rng } from '../core/rng';
import { neonCity } from '../track/defs/neonCity';
import { sunsetCoast } from '../track/defs/sunsetCoast';
import { hyperGrid } from '../track/defs/hyperGrid';
import { buildNeon } from './themes/neon';
import { buildCoast } from './themes/coast';
import { buildGrid } from './themes/grid';

export interface TrackEntry {
  id: string;
  def: () => TrackDef;
}

export const TRACKS: TrackEntry[] = [
  { id: 'neon', def: neonCity },
  { id: 'coast', def: sunsetCoast },
  { id: 'grid', def: hyperGrid },
];

const THEMES: Record<ThemeId, ThemeBuilder> = {
  neon: buildNeon,
  coast: buildCoast,
  grid: buildGrid,
};

export function registerTrack(entry: TrackEntry, theme?: [ThemeId, ThemeBuilder]): void {
  if (!TRACKS.find((t) => t.id === entry.id)) TRACKS.push(entry);
  if (theme) THEMES[theme[0]] = theme[1];
}

const trackCache = new Map<string, Track>();

/** Build (and cache) the sampled track + racing line for a definition. */
export function getTrack(id: string): Track {
  let t = trackCache.get(id);
  if (t) return t;
  const entry = TRACKS.find((e) => e.id === id) ?? TRACKS[0];
  const def = entry.def();
  t = buildTrack(def);
  computeRacingLine(t);
  t.curbMask = curbMask(t, computeCurbRuns(t, 260));
  if (import.meta.env.DEV) for (const line of validateTrack(t)) console.info(line);
  trackCache.set(id, t);
  return t;
}

export class World {
  readonly scene = new THREE.Scene();
  readonly track: Track;
  theme!: ThemeInstance;
  readonly shared = { uTime: { value: 0 }, uBeat: { value: 0 } };
  time = 0;

  private constructor(track: Track) {
    this.track = track;
    this.scene.matrixWorldAutoUpdate = true;
  }

  static async create(
    trackId: string,
    gl: THREE.WebGLRenderer,
    quality: QualityProfile,
    progress: (p: number, label: string) => Promise<void>,
  ): Promise<World> {
    const track = getTrack(trackId);
    await progress(0.05, '트랙 생성');
    const w = new World(track);
    const builder = THEMES[track.def.theme];
    w.theme = await builder({
      track,
      scene: w.scene,
      gl,
      quality,
      rng: new Rng(track.def.seed),
      shared: w.shared,
      progress,
    });
    w.scene.add(w.theme.root);
    return w;
  }

  update(dt: number, camera: THREE.Camera, beat: number): void {
    this.time += dt;
    this.shared.uTime.value = this.time;
    this.shared.uBeat.value = beat;
    this.theme.update(dt, this.time, camera, beat);
  }

  dispose(): void {
    // Lights own GPU resources the themes don't track (shadow-map render targets),
    // and scene-level textures (environment/background) outlive the theme root.
    const lights: THREE.Light[] = [];
    this.scene.traverse((o) => {
      if ((o as THREE.Light).isLight) lights.push(o as THREE.Light);
    });
    this.theme.dispose();
    for (const l of lights) l.dispose();
    const env = this.scene.environment, bg = this.scene.background;
    if (env) env.dispose();
    if (bg && (bg as THREE.Texture).isTexture) (bg as THREE.Texture).dispose();
    this.scene.environment = null;
    this.scene.background = null;
    this.scene.clear();
  }
}
