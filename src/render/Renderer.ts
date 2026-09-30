import * as THREE from 'three';
import { PostFX } from './PostFX';
import type { QualityLevel } from '../core/Settings';
import { clamp } from '../core/math';

export interface QualityProfile {
  pixelRatioCap: number;
  msaa: number;
  bloomMips: number;
  blurTaps: number;
  shadows: boolean;
  shadowSize: number;
  particles: number; // particle budget multiplier
  far: number; // camera far / draw distance
  props: number; // prop density multiplier
  rain: number;
}

export const QUALITY: Record<QualityLevel, QualityProfile> = {
  low: { pixelRatioCap: 1, msaa: 0, bloomMips: 4, blurTaps: 6, shadows: false, shadowSize: 512, particles: 0.45, far: 1500, props: 0.55, rain: 0.4 },
  medium: { pixelRatioCap: 1.25, msaa: 2, bloomMips: 5, blurTaps: 8, shadows: false, shadowSize: 1024, particles: 0.7, far: 2000, props: 0.8, rain: 0.7 },
  high: { pixelRatioCap: 1.5, msaa: 4, bloomMips: 6, blurTaps: 10, shadows: true, shadowSize: 1024, particles: 1, far: 2600, props: 1, rain: 1 },
  ultra: { pixelRatioCap: 2, msaa: 4, bloomMips: 6, blurTaps: 12, shadows: true, shadowSize: 2048, particles: 1.25, far: 3200, props: 1.15, rain: 1.2 },
};

/**
 * Owns the WebGL renderer, the post pipeline and resolution management
 * (device pixel ratio × dynamic resolution scale).
 */
export class Renderer {
  readonly gl: THREE.WebGLRenderer;
  readonly post: PostFX;
  readonly canvas: HTMLCanvasElement;
  profile: QualityProfile;
  quality: QualityLevel;
  dynamicEnabled = true;
  /** 0.55..1 multiplier on the pixel ratio, adjusted from frame times. */
  dynamicScale = 1;
  cssWidth = 1;
  cssHeight = 1;
  private frameAvg = 1 / 60;
  private scaleCooldown = 2;
  private slowFor = 0;
  private healthyFor = 0;
  /** Seconds of smooth frames before trying a higher resolution (doubles when a try fails). */
  private probeWait = 4;
  private sinceRaise = 1e9;
  /** fps-only fallback: a drop that bought no frames is undone and not retried for a while. */
  private dropCheck: { fps: number; at: number } | null = null;
  private noDropUntil = 0;
  private clock = 0;
  // GPU frame time from EXT_disjoint_timer_query_webgl2 (−1 until measured / unsupported)
  private timer: { TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number } | null = null;
  private queryPool: WebGLQuery[] = [];
  private pending: WebGLQuery[] = [];
  gpuMs = -1;
  private currentPR = 1;
  maxAnisotropy = 1;

  constructor(canvas: HTMLCanvasElement, quality: QualityLevel) {
    this.canvas = canvas;
    this.quality = quality;
    this.profile = QUALITY[quality];
    this.gl = new THREE.WebGLRenderer({
      canvas,
      antialias: false,
      powerPreference: 'high-performance',
      stencil: false,
      depth: true,
      alpha: false,
      preserveDrawingBuffer: false,
    });
    this.gl.toneMapping = THREE.NoToneMapping;
    this.gl.outputColorSpace = THREE.SRGBColorSpace;
    this.gl.shadowMap.enabled = this.profile.shadows;
    this.gl.shadowMap.type = THREE.PCFShadowMap; // PCFSoftShadowMap was removed in r18x
    this.gl.info.autoReset = false;
    this.gl.debug.checkShaderErrors = import.meta.env.DEV;
    this.maxAnisotropy = this.gl.capabilities.getMaxAnisotropy();
    try {
      this.timer = this.gl.getContext().getExtension('EXT_disjoint_timer_query_webgl2');
    } catch {
      this.timer = null;
    }
    this.post = new PostFX(this.gl, { msaa: this.profile.msaa, mips: this.profile.bloomMips, taps: this.profile.blurTaps });
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  setQuality(q: QualityLevel): void {
    this.quality = q;
    this.profile = QUALITY[q];
    this.gl.shadowMap.enabled = this.profile.shadows;
    this.post.configure({ msaa: this.profile.msaa, mips: this.profile.bloomMips, taps: this.profile.blurTaps });
    this.dynamicScale = 1;
    this.resize();
  }

  resize(): void {
    const w = Math.max(1, window.innerWidth);
    const h = Math.max(1, window.innerHeight);
    this.cssWidth = w;
    this.cssHeight = h;
    const dpr = Math.min(window.devicePixelRatio || 1, this.profile.pixelRatioCap);
    const pr = clamp(dpr * this.dynamicScale, 0.5, 3);
    this.currentPR = pr;
    this.gl.setPixelRatio(pr);
    this.gl.setSize(w, h, false);
    this.post.setSize(w * pr, h * pr);
  }

  get aspect(): number {
    return this.cssWidth / this.cssHeight;
  }

  get pixelRatio(): number {
    return this.currentPR;
  }

  /**
   * Feed real frame time; adjusts dynamic resolution with hysteresis.
   * Judged against a fixed 50/56 fps bar rather than the display refresh: vsync
   * pins frame times at 16.7 ms on a 60 Hz screen, so the old recovery test
   * (frames under 14.5 ms) could never pass there and one slow moment left the
   * game at 55 % resolution for good. Now it probes back up after a stretch of
   * smooth frames, and waits longer each time a probe immediately costs frames.
   */
  trackFrame(dt: number): void {
    if (dt <= 0 || dt > 0.25) return;
    this.clock += dt;
    this.frameAvg += (dt - this.frameAvg) * 0.05;
    this.scaleCooldown -= dt;
    this.sinceRaise += dt;
    if (!this.dynamicEnabled) return;
    const fps = 1 / this.frameAvg;
    const s = this.dynamicScale;

    if (this.gpuMs >= 0) {
      // GPU-timed: resolution only helps when the GPU is the bottleneck.
      const BUDGET = 12.5; // ms of GPU work per frame (headroom inside 16.7 ms)
      if (this.gpuMs > BUDGET * 1.15 && fps < 57) {
        this.slowFor += dt;
        this.healthyFor = 0;
      } else {
        this.slowFor = 0;
        const next = Math.min(1, s + 0.1);
        const predicted = this.gpuMs * (next * next) / (s * s); // fill cost ∝ pixel count
        if (predicted < BUDGET * 0.85) this.healthyFor += dt;
        else this.healthyFor = 0;
      }
      if (this.scaleCooldown > 0) return;
      if (this.slowFor > 0.6 && s > 0.55) this.setDynamicScale(Math.max(0.55, s - 0.1));
      else if (this.healthyFor > 2 && s < 1) this.setDynamicScale(Math.min(1, s + 0.1));
      return;
    }

    // Fallback without a GPU timer: judge frame rate against a fixed 50/56 fps bar
    // (never the display refresh — vsync pins 60 Hz screens at 16.7 ms, which kept
    // the old "under 14.5 ms" recovery test from ever passing).
    if (this.dropCheck && this.clock - this.dropCheck.at > 2) {
      // a drop that bought no frames means we are not GPU-bound: undo it
      if (fps < this.dropCheck.fps * 1.08 && s < 1) {
        this.setDynamicScale(Math.min(1, s + 0.1));
        this.noDropUntil = this.clock + 30;
      }
      this.dropCheck = null;
    }
    if (fps < 50) {
      this.slowFor += dt;
      this.healthyFor = 0;
    } else {
      this.slowFor = 0;
      if (fps >= 56) this.healthyFor += dt;
    }
    if (this.scaleCooldown > 0) return;
    if (this.slowFor > 0.6 && s > 0.55 && this.clock > this.noDropUntil) {
      if (this.sinceRaise < 4) this.probeWait = Math.min(64, this.probeWait * 2);
      this.dropCheck = { fps, at: this.clock };
      this.setDynamicScale(Math.max(0.55, s - 0.1));
    } else if (this.healthyFor > this.probeWait && s < 1) {
      this.setDynamicScale(Math.min(1, s + 0.1));
      this.sinceRaise = 0;
    }
  }

  /** Collect finished GPU timer queries (results arrive a few frames late). */
  private pollGpuTimer(ctx: WebGL2RenderingContext): void {
    const t = this.timer!;
    while (this.pending.length) {
      const q = this.pending[0];
      if (!ctx.getQueryParameter(q, ctx.QUERY_RESULT_AVAILABLE)) break;
      this.pending.shift();
      const disjoint = ctx.getParameter(t.GPU_DISJOINT_EXT);
      if (!disjoint) {
        const ms = ctx.getQueryParameter(q, ctx.QUERY_RESULT) / 1e6;
        if (ms > 0 && ms < 250) this.gpuMs = this.gpuMs < 0 ? ms : this.gpuMs + (ms - this.gpuMs) * 0.08;
      }
      this.queryPool.push(q);
    }
  }

  private setDynamicScale(s: number): void {
    this.dynamicScale = Math.round(s * 100) / 100;
    this.scaleCooldown = 1.5;
    this.slowFor = 0;
    this.healthyFor = 0;
    this.resize();
  }

  get fps(): number {
    return 1 / Math.max(1e-4, this.frameAvg);
  }

  render(scene: THREE.Scene, camera: THREE.Camera, dt: number): void {
    this.gl.info.reset();
    let query: WebGLQuery | null = null;
    const ctx = this.gl.getContext() as WebGL2RenderingContext;
    if (this.timer) {
      try {
        this.pollGpuTimer(ctx);
        if (this.pending.length < 4) {
          query = this.queryPool.pop() ?? ctx.createQuery();
          if (query) ctx.beginQuery(this.timer.TIME_ELAPSED_EXT, query);
        }
      } catch {
        this.timer = null; // driver refused: fall back to frame-rate heuristics
        this.gpuMs = -1;
        query = null;
      }
    }
    this.post.render(scene, camera, dt);
    if (query && this.timer) {
      ctx.endQuery(this.timer.TIME_ELAPSED_EXT);
      this.pending.push(query);
    }
  }

  configureTexture(tex: THREE.Texture, anisotropy = 16): THREE.Texture {
    tex.anisotropy = Math.min(anisotropy, this.maxAnisotropy);
    return tex;
  }
}
