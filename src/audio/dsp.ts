import { Rng } from '../core/rng';
import { TAU, clamp } from '../core/math';

// Shared DSP toolkit: pitch/level helpers, allocation-free JS filters for
// offline synthesis, buffer / impulse-response generators, guarded AudioParam
// helpers and a time-sliced job queue so pre-rendering never hitches a frame.

/** Concrete Float32Array type accepted by the Web Audio copy APIs. */
export type F32 = Float32Array<ArrayBuffer>;

// ---------------------------------------------------------------------------
// Pitch / level

export const midiToHz = (m: number): number => 440 * Math.pow(2, (m - 69) / 12);

const LETTER: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

/** 'C', 'F#', 'Bb' → pitch class 0..11 (NaN if malformed). */
export function pitchClass(name: string): number {
  const base = LETTER[name.charAt(0).toUpperCase()];
  if (base === undefined) return NaN;
  const acc = name.charAt(1);
  return (base + (acc === '#' ? 1 : acc === 'b' ? -1 : 0) + 12) % 12;
}

/** 'A4', 'C#5', 'Bb3' → MIDI note (C4 = 60); NaN if malformed. */
export function noteToMidi(name: string): number {
  const m = /^([A-Ga-g])([#b]?)(-?\d)$/.exec(name);
  if (!m) return NaN;
  const pc = LETTER[m[1].toUpperCase()] + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0);
  return pc + (Number(m[3]) + 1) * 12;
}

/** Fast tanh (Padé 3/2), exact saturation at |x| ≥ 3. */
export function softTanh(x: number): number {
  if (x <= -3) return -1;
  if (x >= 3) return 1;
  const x2 = x * x;
  return (x * (27 + x2)) / (27 + 9 * x2);
}

// ---------------------------------------------------------------------------
// JS filters (offline rendering). RBJ cookbook biquads, direct form I.

export class Biquad {
  private b0 = 1;
  private b1 = 0;
  private b2 = 0;
  private a1 = 0;
  private a2 = 0;
  private x1 = 0;
  private x2 = 0;
  private y1 = 0;
  private y2 = 0;

  private set(b0: number, b1: number, b2: number, a0: number, a1: number, a2: number): this {
    const ia = 1 / a0;
    this.b0 = b0 * ia;
    this.b1 = b1 * ia;
    this.b2 = b2 * ia;
    this.a1 = a1 * ia;
    this.a2 = a2 * ia;
    return this;
  }

  private static w(sr: number, f: number): number {
    return (TAU * clamp(f, 5, sr * 0.49)) / sr;
  }

  lowpass(sr: number, f: number, q = Math.SQRT1_2): this {
    const w = Biquad.w(sr, f), c = Math.cos(w), al = Math.sin(w) / (2 * q);
    return this.set((1 - c) / 2, 1 - c, (1 - c) / 2, 1 + al, -2 * c, 1 - al);
  }

  highpass(sr: number, f: number, q = Math.SQRT1_2): this {
    const w = Biquad.w(sr, f), c = Math.cos(w), al = Math.sin(w) / (2 * q);
    return this.set((1 + c) / 2, -(1 + c), (1 + c) / 2, 1 + al, -2 * c, 1 - al);
  }

  /** Band-pass with 0 dB peak gain. */
  bandpass(sr: number, f: number, q = 1): this {
    const w = Biquad.w(sr, f), c = Math.cos(w), al = Math.sin(w) / (2 * q);
    return this.set(al, 0, -al, 1 + al, -2 * c, 1 - al);
  }

  peak(sr: number, f: number, q: number, db: number): this {
    const w = Biquad.w(sr, f), c = Math.cos(w), al = Math.sin(w) / (2 * q);
    const A = Math.pow(10, db / 40);
    return this.set(1 + al * A, -2 * c, 1 - al * A, 1 + al / A, -2 * c, 1 - al / A);
  }

  process(x: number): number {
    const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
    this.x2 = this.x1;
    this.x1 = x;
    this.y2 = this.y1;
    this.y1 = y;
    return y;
  }
}

/** One-pole low-pass (and complementary high-pass). */
export class OnePole {
  private a = 0;
  private z = 0;

  cutoff(sr: number, f: number): this {
    this.a = Math.exp((-TAU * clamp(f, 1, sr * 0.49)) / sr);
    return this;
  }

  lp(x: number): number {
    this.z = x + (this.z - x) * this.a;
    return this.z;
  }

  hp(x: number): number {
    return x - this.lp(x);
  }
}

/** Compact Freeverb-style mono reverb (damped combs + all-passes) for baking tails. */
export class Reverb {
  private readonly combs: { buf: Float32Array; i: number; g: number; z: number }[] = [];
  private readonly aps: { buf: Float32Array; i: number }[] = [];
  private readonly damp: number;

  constructor(sr: number, rt60: number, damp = 0.35, size = 1) {
    this.damp = clamp(damp, 0, 0.95);
    for (const ms of [29.7, 37.1, 41.1, 43.7, 31.3, 39.9]) {
      const len = Math.max(8, Math.round(ms * size * 1e-3 * sr));
      // Feedback for the requested RT60: g^(rt60/delay) = 1e-3.
      const g = Math.pow(10, (-3 * (len / sr)) / Math.max(0.05, rt60));
      this.combs.push({ buf: new Float32Array(len), i: 0, g, z: 0 });
    }
    for (const ms of [5.0, 1.7]) this.aps.push({ buf: new Float32Array(Math.max(4, Math.round(ms * 1e-3 * sr))), i: 0 });
  }

  process(x: number): number {
    let out = 0;
    const d = this.damp;
    for (const c of this.combs) {
      const y = c.buf[c.i];
      c.z = y * (1 - d) + c.z * d;
      c.buf[c.i] = x + c.z * c.g;
      if (++c.i >= c.buf.length) c.i = 0;
      out += y;
    }
    out *= 1 / this.combs.length;
    for (const a of this.aps) {
      const b = a.buf[a.i];
      const y = -out + b;
      a.buf[a.i] = out + b * 0.5;
      if (++a.i >= a.buf.length) a.i = 0;
      out = y;
    }
    return out;
  }
}

// ---------------------------------------------------------------------------
// Noise & array utilities

/** Fill with fast xorshift32 white noise in [-1, 1) (bulk noise; `Rng` is slower). */
export function fillNoise(buf: Float32Array, seed: number): void {
  let s = seed >>> 0 || 0x9e3779b9;
  for (let i = 0; i < buf.length; i++) {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    buf[i] = (s >>> 0) / 2147483648 - 1;
  }
}

/** Pink noise (Paul Kellet's refined filter), roughly unit peak. */
export function pink(n: number, seed: number): F32 {
  const rng = new Rng(seed);
  const out = new Float32Array(n);
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
  for (let i = 0; i < n; i++) {
    const w = rng.next() * 2 - 1;
    b0 = 0.99886 * b0 + w * 0.0555179;
    b1 = 0.99332 * b1 + w * 0.0750759;
    b2 = 0.969 * b2 + w * 0.153852;
    b3 = 0.8665 * b3 + w * 0.3104856;
    b4 = 0.55 * b4 + w * 0.5329522;
    b5 = -0.7616 * b5 - w * 0.016898;
    out[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
    b6 = w * 0.115926;
  }
  return out;
}

/** Equal-power crossfade of the tail into the head → seamless loop (length − fade). */
export function loopify(x: Float32Array, fade: number): F32 {
  const f = Math.max(1, Math.min(Math.floor(fade), Math.floor(x.length / 2)));
  const n = x.length - f;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = x[i];
  for (let i = 0; i < f; i++) {
    const w = i / f;
    out[i] = x[i] * Math.sqrt(w) + x[n + i] * Math.sqrt(1 - w);
  }
  return out;
}

export function rmsOf(x: Float32Array, from = 0, to = x.length): number {
  let s = 0;
  for (let i = from; i < to; i++) s += x[i] * x[i];
  return Math.sqrt(s / Math.max(1, to - from));
}

export function peakOf(x: Float32Array): number {
  let p = 0;
  for (let i = 0; i < x.length; i++) {
    const a = Math.abs(x[i]);
    if (a > p) p = a;
  }
  return p;
}

export function scaleBy(x: Float32Array, g: number): void {
  for (let i = 0; i < x.length; i++) x[i] *= g;
}

export function normalizePeak(x: Float32Array, peak: number): void {
  const p = peakOf(x);
  if (p > 1e-9) scaleBy(x, peak / p);
}

/** Scale to an RMS target, but never let the peak exceed `ceil`. */
export function normalizeRms(x: Float32Array, target: number, ceil = 0.98): void {
  const r = rmsOf(x);
  if (r < 1e-9) return;
  let g = target / r;
  const p = peakOf(x) * g;
  if (p > ceil) g *= ceil / p;
  scaleBy(x, g);
}

/** Short raised-cosine fades at the ends of a one-shot (no clicks). */
export function fadeEdges(x: Float32Array, inSamples: number, outSamples: number): void {
  const n = x.length;
  const a = Math.min(inSamples, n);
  for (let i = 0; i < a; i++) x[i] *= 0.5 - 0.5 * Math.cos((Math.PI * i) / a);
  const b = Math.min(outSamples, n);
  for (let i = 0; i < b; i++) x[n - 1 - i] *= 0.5 - 0.5 * Math.cos((Math.PI * i) / b);
}

export function reversed(x: Float32Array): F32 {
  const n = x.length;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = x[n - 1 - i];
  return out;
}

// ---------------------------------------------------------------------------
// Buffers, curves, waves

export function toBuffer(ctx: BaseAudioContext, chans: F32[], sr: number): AudioBuffer {
  const len = Math.max(1, chans[0].length);
  const b = ctx.createBuffer(chans.length, len, sr);
  for (let c = 0; c < chans.length; c++) b.copyToChannel(chans[c], c);
  return b;
}

export interface IROptions {
  seconds: number;
  rt60: number;
  preDelay: number;
  /** Brightness at the start / end of the tail (one-pole cutoff, Hz). */
  lpStart: number;
  lpEnd: number;
  /** Discrete early reflections (s, gain) — hard walls such as tunnels. */
  early?: [number, number][];
  seed?: number;
}

/** Stereo reverb impulse: decorrelated noise × exponential decay, progressively darker. */
export function makeIR(ctx: BaseAudioContext, o: IROptions): AudioBuffer {
  const sr = ctx.sampleRate;
  const n = Math.max(1, Math.round(o.seconds * sr));
  const buf = ctx.createBuffer(2, n, sr);
  const k = Math.exp(-6.908 / Math.max(1, o.rt60 * sr)); // per-sample decay: −60 dB at rt60
  const pre = Math.round(o.preDelay * sr);
  const atk = 0.006 * sr;
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    fillNoise(d, Math.imul((o.seed ?? 11) + 1, 7919) + ch * 104729);
    d.fill(0, 0, Math.min(n, pre));
    const lp = new OnePole();
    let env = 1;
    for (let i = pre, j = 0; i < n; i++, j++) {
      if ((j & 63) === 0) lp.cutoff(sr, o.lpStart * Math.pow(o.lpEnd / o.lpStart, Math.min(1, j / sr / o.seconds)));
      d[i] = lp.lp(d[i]) * env * (j < atk ? j / atk : 1);
      env *= k;
    }
    const early: [number, number][] = o.early ?? [];
    for (let k = 0; k < early.length; k++) {
      const when: number = early[k][0];
      const gain: number = early[k][1];
      const idx = Math.round(when * sr) + (ch ? Math.round(0.0013 * sr * (k + 1)) : 0);
      if (idx < n) d[idx] += gain * (ch === k % 2 ? 1 : 0.55);
    }
  }
  return buf;
}

export function tanhCurve(drive: number, n = 2048): F32 {
  const c = new Float32Array(n);
  const norm = Math.tanh(drive);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    c[i] = Math.tanh(drive * x) / norm;
  }
  return c;
}

/** Band-limited pulse wave with the given duty cycle. */
export function pulseWave(ctx: BaseAudioContext, duty: number, harmonics = 40): PeriodicWave {
  const re = new Float32Array(harmonics + 1);
  const im = new Float32Array(harmonics + 1);
  for (let k = 1; k <= harmonics; k++) re[k] = (2 / (k * Math.PI)) * Math.sin(k * Math.PI * duty);
  return ctx.createPeriodicWave(re, im);
}

/** Rounded square (first odd harmonics only) — click-free gating LFO. */
export function softSquareWave(ctx: BaseAudioContext): PeriodicWave {
  const re = new Float32Array(8);
  const im = new Float32Array(8);
  im[1] = 1;
  im[3] = 1 / 3 * 0.8;
  im[5] = 1 / 5 * 0.45;
  im[7] = 1 / 7 * 0.15;
  return ctx.createPeriodicWave(re, im);
}

// ---------------------------------------------------------------------------
// Guarded AudioParam helpers — never throw on NaN/Infinity or negative times.

export function glide(p: AudioParam, v: number, t: number, tc: number): void {
  if (!Number.isFinite(v) || !Number.isFinite(t)) return;
  p.setTargetAtTime(v, Math.max(0, t), Math.max(0.001, tc));
}

export function setAt(p: AudioParam, v: number, t: number): void {
  if (!Number.isFinite(v) || !Number.isFinite(t)) return;
  p.setValueAtTime(v, Math.max(0, t));
}

export function rampAt(p: AudioParam, v: number, t: number): void {
  if (!Number.isFinite(v) || !Number.isFinite(t)) return;
  p.linearRampToValueAtTime(v, Math.max(0, t));
}

export function expRampAt(p: AudioParam, v: number, t: number): void {
  if (!Number.isFinite(v) || !Number.isFinite(t)) return;
  p.exponentialRampToValueAtTime(Math.max(1e-4, v), Math.max(0, t));
}

/** Disconnect `nodes` once `src` has finished playing. */
export function cleanupOnEnd(src: AudioScheduledSourceNode, ...nodes: (AudioNode | null)[]): void {
  src.onended = () => {
    src.disconnect();
    for (const n of nodes) n?.disconnect();
  };
}

// ---------------------------------------------------------------------------
// Resumable render tasks + time-sliced job queue.

/** A render that yields every few thousand samples so it can be time-sliced. */
export type Task<T> = Generator<void, T, void>;

/** Samples between yields inside render loops. */
export const YIELD_EVERY = 4096;

/** Run a task to completion synchronously. */
export function finish<T>(task: Task<T>): T {
  let r = task.next();
  while (!r.done) r = task.next();
  return r.value;
}

type JobFn = () => void | Iterator<unknown>;

interface Job {
  fn: JobFn;
  it: Iterator<unknown> | null;
  pri: number;
  seq: number;
  tag: string;
}

/** Highest priority first, FIFO within a priority; generator jobs resume across slices. */
export class JobQueue {
  private readonly jobs: Job[] = [];
  private seq = 0;

  add(fn: JobFn, pri = 0, tag = ''): void {
    this.jobs.push({ fn, it: null, pri, seq: this.seq++, tag });
  }

  /** Raise the priority of every pending job carrying `tag`. */
  bump(tag: string, pri: number): void {
    for (const j of this.jobs) if (j.tag === tag && j.pri < pri) j.pri = pri;
  }

  get size(): number {
    return this.jobs.length;
  }

  /** Work until `budgetMs` has been used. */
  run(budgetMs: number): void {
    const t0 = performance.now();
    while (this.jobs.length) {
      let best = 0;
      for (let i = 1; i < this.jobs.length; i++) {
        const a = this.jobs[i], b = this.jobs[best];
        if (a.pri > b.pri || (a.pri === b.pri && a.seq < b.seq)) best = i;
      }
      const job = this.jobs[best];
      try {
        if (!job.it) {
          const r = job.fn();
          if (r) job.it = r;
        }
        let done = true;
        if (job.it) {
          done = false;
          while (!done && performance.now() - t0 < budgetMs) done = !!job.it.next().done;
        }
        if (done) this.jobs.splice(this.jobs.indexOf(job), 1);
      } catch (err) {
        console.error('[audio] render job failed', err);
        this.jobs.splice(this.jobs.indexOf(job), 1);
      }
      if (performance.now() - t0 >= budgetMs) return;
    }
  }

  clear(): void {
    this.jobs.length = 0;
  }
}
