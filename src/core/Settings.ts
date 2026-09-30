import { loadJSON, saveJSON } from './Storage';

export type QualityLevel = 'low' | 'medium' | 'high' | 'ultra';
export type Difficulty = 'easy' | 'normal' | 'hard' | 'insane';

export interface SettingsData {
  quality: QualityLevel;
  dynamicResolution: boolean;
  speedEffects: number; // 0..1 — radial blur, chromatic aberration, speed lines
  cameraShake: boolean;
  steering: number; // 0..1 — steering response (0.5 = default feel)
  reduceMotion: boolean;
  masterVolume: number;
  musicVolume: number;
  sfxVolume: number;
  units: 'kmh' | 'mph';
  showFps: boolean;
  difficulty: Difficulty;
  cameraMode: number;
  car: string;
  paint: number;
  track: string;
}

export const defaultSettings = (): SettingsData => ({
  quality: 'high',
  dynamicResolution: true,
  speedEffects: 1,
  cameraShake: true,
  steering: 0.5,
  reduceMotion: false,
  masterVolume: 0.8,
  musicVolume: 0.65,
  sfxVolume: 0.9,
  units: 'kmh',
  showFps: false,
  difficulty: 'normal',
  cameraMode: 0,
  car: 'volt',
  paint: 0,
  track: 'neon',
});

type Listener = (s: SettingsData, key: keyof SettingsData) => void;

/** First-run guess: integrated / mobile GPUs start at 'medium'. */
function detectQuality(): QualityLevel {
  try {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl2') as WebGL2RenderingContext | null;
    if (!gl) return 'low';
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const name = String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    if (/Intel|UHD|Iris|Mali|Adreno|PowerVR|Apple GPU|SwiftShader|llvmpipe/i.test(name)) return /SwiftShader|llvmpipe/i.test(name) ? 'low' : 'medium';
    return 'high';
  } catch {
    return 'high';
  }
}

class SettingsStore {
  data: SettingsData;
  private listeners = new Set<Listener>();

  constructor() {
    const saved = loadJSON<Partial<SettingsData>>('settings', {});
    this.data = { ...defaultSettings(), ...saved };
    if (saved.quality === undefined) {
      this.data.quality = detectQuality();
      if (typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches) this.data.reduceMotion = true;
    }
  }

  get<K extends keyof SettingsData>(key: K): SettingsData[K] {
    return this.data[key];
  }

  set<K extends keyof SettingsData>(key: K, value: SettingsData[K]): void {
    if (this.data[key] === value) return;
    this.data[key] = value;
    saveJSON('settings', this.data);
    for (const l of this.listeners) l(this.data, key);
  }

  onChange(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}

export const settings = new SettingsStore();
