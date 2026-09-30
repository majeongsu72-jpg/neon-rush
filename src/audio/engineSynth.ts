import type { EngineSound } from '../vehicle/specs';
import { Rng } from '../core/rng';
import { TAU, clamp, clamp01, lerp } from '../core/math';
import { Biquad, OnePole, YIELD_EVERY, fillNoise, finish, normalizeRms, rmsOf, scaleBy, softTanh, toBuffer, type F32, type JobQueue, type Task } from './dsp';

// Offline engine sample banks. Every EngineSound spec is rendered (plain JS)
// into seamless loops on an RPM grid × two loads, from a firing-pulse model:
// uneven/even bank firing → per-bank exhaust comb (pipe) → body resonances →
// muffler → intake noise gated by the firings → gentle saturation.

/** Engine rpm of every grid point (the spec's `pitch` scales the firing frequency). */
export const ENGINE_RPMS: readonly number[] = [1000, 1750, 2700, 3900, 5300, 6900, 8700];

const LOOP_SECONDS = 0.5;
const PRE_ROLL = 0.12; // filter warm-up taken from the loop's own tail (IIR state wraps)
const CROSS_PLANE = [0, 1, 0, 0, 1, 0, 1, 1]; // bank of each firing in a cross-plane V8
const MASK = YIELD_EVERY - 1;

export interface EngineLoopData {
  data: F32;
  /** Exact engine rpm of the loop (length is rounded to whole cycles). */
  rpm: number;
}

export function engineKey(e: EngineSound): string {
  const r = (v: number) => Math.round(v * 1000) / 1000;
  return `${Math.round(e.cylinders)}|${r(e.rasp)}|${r(e.body)}|${r(e.turbo)}|${r(e.pitch)}`;
}

function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Add an exhaust pressure pulse (1 − e^(−t/τr))·e^(−t/τd), normalized to peak 1,
 * wrapping around the loop. τd ≈ the classic t·e^(−t/τ) width; the short rise τr
 * (the exhaust valve cracking open) keeps the upper harmonics alive.
 */
function addPulse(buf: F32, t0: number, amp: number, tr: number, td: number, n: number, L: number): void {
  const start = Math.ceil(t0);
  let idx = start % L;
  if (idx < 0) idx += L;
  const peak = (td / (tr + td)) * Math.pow(tr / (tr + td), tr / td);
  const x0 = start - t0;
  let er = Math.exp(-x0 / tr); // exponentials advanced by multiplication
  let ed = (amp / peak) * Math.exp(-x0 / td);
  const kr = Math.exp(-1 / tr), kd = Math.exp(-1 / td);
  for (let j = 0; j < n; j++) {
    buf[idx] += (1 - er) * ed;
    er *= kr;
    ed *= kd;
    if (++idx === L) idx = 0;
  }
}

/** Add an exponentially decaying gate envelope, wrapping around the loop. */
function addDecay(buf: F32, t0: number, amp: number, tau: number, n: number, L: number): void {
  const start = Math.ceil(t0);
  let idx = start % L;
  if (idx < 0) idx += L;
  const k = Math.exp(-1 / tau);
  let e = amp * Math.exp(-(start - t0) / tau);
  for (let j = 0; j < n; j++) {
    buf[idx] += e;
    e *= k;
    if (++idx === L) idx = 0;
  }
}

/** Overrun crackle: sparse, sharp band-limited pops. */
function addCrackle(out: F32, rng: Rng, sr: number, rpmFrac: number, rasp: number): void {
  const L = out.length;
  const rate = (4 + 18 * rpmFrac) * (0.4 + rasp); // pops per second
  const count = Math.round(rate * (L / sr) * (0.6 + 0.8 * rng.next()));
  const lp = new OnePole();
  for (let p = 0; p < count; p++) {
    let idx = Math.floor(rng.next() * L);
    const len = (0.0015 + 0.004 * rng.next()) * sr;
    const amp = 0.5 + 1.1 * rng.next();
    lp.cutoff(sr, 3000 + 4000 * rng.next());
    const n = Math.ceil(len * 4);
    const k = Math.exp(-1 / len);
    let e = amp;
    for (let j = 0; j < n; j++) {
      out[idx] += lp.lp(rng.next() * 2 - 1) * e;
      e *= k;
      if (++idx === L) idx = 0;
    }
  }
}

/** DC blocker (≈25 Hz) whose state is warmed up on the loop's own tail. */
function dcBlockLoop(x: F32, sr: number): void {
  const L = x.length;
  const r = Math.exp((-TAU * 25) / sr);
  const warm = Math.min(L, Math.round(0.1 * sr));
  let x1 = 0, y1 = 0;
  for (let n = -warm; n < L; n++) {
    const i = n < 0 ? n + L : n;
    const v = x[i];
    const y = v - x1 + r * y1;
    x1 = v;
    y1 = y;
    if (n >= 0) x[n] = y;
  }
}

/** Synchronous render of one loop (see `engineLoopTask`). */
export function synthEngineLoop(e: EngineSound, rpmNominal: number, onLoad: boolean, sr: number, seed: number): EngineLoopData {
  return finish(engineLoopTask(e, rpmNominal, onLoad, sr, seed));
}

/**
 * Render one seamless engine loop. Firing frequency = rpm/60 · cylinders/2 · pitch.
 * The loop is an integer number of 4-stroke cycles long; all periodic content
 * (pulses, noise, crackle) wraps, and every IIR stage is warmed up on the
 * loop's own tail, so the end joins the start without a click. Resumable
 * (yields every few thousand samples) so the job queue can time-slice it.
 */
export function* engineLoopTask(e: EngineSound, rpmNominal: number, onLoad: boolean, sr: number, seed: number): Task<EngineLoopData> {
  const rng = new Rng(seed);
  const nc = clamp(Math.round(e.cylinders) || 4, 1, 16);
  const rasp = clamp01(e.rasp);
  const body = clamp01(e.body);
  const turbo = clamp01(e.turbo);
  const pitch = clamp(e.pitch || 1, 0.4, 2.5);
  const rpmFrac = clamp01(rpmNominal / 9000);

  // Loop = whole 4-stroke cycles (two revolutions each).
  const cycleSec = 120 / (rpmNominal * pitch);
  const nCycles = Math.max(2, Math.round(LOOP_SECONDS / cycleSec));
  const L = Math.round(nCycles * cycleSec * sr);
  const cyc = L / nCycles; // samples per cycle (fractional, exact)
  const fire = cyc / nc; // samples between firings

  // Firing layout: V / flat engines feed two exhaust banks. A cross-plane V8
  // fires its banks unevenly (L R L L R L R R) into asymmetric pipes → burble;
  // even-fire engines get near-identical banks → smooth, octave-true scream.
  const banks = nc >= 5 ? 2 : 1;
  const crossPlane = nc === 8;
  const bankOf = (k: number): number => (banks === 1 ? 0 : crossPlane ? CROSS_PLANE[k] : k & 1);
  const pipeRatio = crossPlane ? 1.12 : 1.015;
  const bankGain = crossPlane ? 0.78 : 0.97;

  // Fixed per-cylinder signature repeats every cycle → the half-order "lope".
  const lope = crossPlane ? 0.14 + 0.16 * body : nc >= 10 ? 0.03 : 0.06 + 0.05 * body;
  const offAmt = crossPlane ? 0.03 : 0.008;
  const cylAmp: number[] = [];
  const cylOff: number[] = [];
  for (let k = 0; k < nc; k++) {
    cylAmp.push(1 + lope * (rng.next() * 2 - 1));
    cylOff.push((rng.next() * 2 - 1) * offAmt * fire);
  }

  // Pulse: decay width τd (≈0.5–1.2 ms, shorter at high revs / for raspy
  // engines), plus a rasp-dependent sharp rise τr that keeps the top end.
  const td = Math.min(lerp(1.2, 0.45, rasp) * (onLoad ? 1 : 1.3) * lerp(1.2, 0.78, rpmFrac) * 1e-3 * sr, fire * 0.22);
  const tr = Math.max(0.6, td * (onLoad ? lerp(0.25, 0.08, rasp) : 0.45));
  const pulseN = Math.ceil(td * 9);
  const envTau = Math.min(2.4e-3 * sr * lerp(1.2, 0.8, rpmFrac), fire * 0.45);
  const envN = Math.ceil(envTau * 5);

  const exc = [new Float32Array(L), new Float32Array(L)];
  const env = [new Float32Array(L), new Float32Array(L)];
  const loadAmp = onLoad ? 1 : 0.34;
  for (let c = 0; c < nCycles; c++) {
    for (let k = 0; k < nc; k++) {
      let amp = loadAmp * cylAmp[k] * (1 + 0.1 * (rng.next() * 2 - 1));
      if (!onLoad) {
        // Overrun: weak, uneven combustion with the odd near-misfire (burble).
        amp *= 0.6 + 0.8 * rng.next();
        if (rng.next() < 0.08) amp *= 0.15;
      }
      const t0 = c * cyc + k * fire + cylOff[k] + (rng.next() * 2 - 1) * 0.003 * cyc;
      const b = bankOf(k);
      addPulse(exc[b], t0, amp, tr, td, pulseN, L);
      addDecay(env[b], t0, amp, envTau, envN, L);
    }
    if ((c & 7) === 7) yield;
  }

  // Combustion noise rides on each firing (roar / rasp).
  const noise = new Float32Array(L);
  fillNoise(noise, seed ^ 0x5bd1e995);
  const combust = onLoad ? 0.25 + 0.45 * rasp : 0.1;
  const half = L >> 1;
  for (let b = 0; b < banks; b++) {
    const ex = exc[b], ev = env[b];
    for (let i = 0, j = b * half; i < L; i++, j++) {
      if (j >= L) j -= L;
      ex[i] += combust * noise[j] * ev[i];
    }
  }

  // Exhaust: one damped comb per bank (open pipe end → negative reflection).
  const pipe = 1.6 + 1.0 * body; // m
  const l0 = new Float32Array(Math.max(8, Math.round(((2 * pipe) / 343) * sr)));
  const l1 = new Float32Array(Math.max(8, Math.round(((2 * pipe * pipeRatio) / 343) * sr)));
  const fb = onLoad ? -0.46 : -0.58;
  const dampHz = onLoad ? 3000 + 4000 * rasp : 1800 + 800 * rasp;
  const d0 = new OnePole().cutoff(sr, dampHz);
  const d1 = new OnePole().cutoff(sr, dampHz);

  // Body / manifold resonances, rasp presence, muffler (12 dB/oct on load,
  // 24 dB/oct on overrun), intake roar.
  const bodyEq = new Biquad().peak(sr, 105 + 30 * (1 - body), 1.0, 3 + 7 * body);
  const midEq = new Biquad().peak(sr, 380, 1.3, onLoad ? 2 : 4.5);
  const raspEq = new Biquad().peak(sr, 2000 + 1200 * rasp, 0.8, onLoad ? 3 + 6 * rasp : 1 + 2 * rasp);
  const mCut = (onLoad ? lerp(4000, 9000, rasp) * lerp(0.9, 1.15, rpmFrac) : lerp(1600, 3000, rasp)) * (1 - 0.25 * turbo);
  const muf1 = new Biquad().lowpass(sr, mCut, 0.7);
  const muf2 = onLoad ? null : new Biquad().lowpass(sr, mCut * 1.4, 0.8);
  const intakeAmt = onLoad ? 0.12 + 0.28 * rasp : 0.035;
  const intake = new Biquad().bandpass(sr, 2400 + 1600 * rasp, 0.8);

  const pre = Math.min(L, Math.round(PRE_ROLL * sr));
  const out = new Float32Array(L);
  const third = Math.floor(L / 3);
  const x0 = exc[0], x1 = exc[1], e0 = env[0], e1 = env[1];
  const two = banks === 2;
  let p0 = 0, p1 = 0;
  for (let n = -pre; n < L; n++) {
    const i = n < 0 ? n + L : n;
    const y0 = x0[i] + fb * d0.lp(l0[p0]);
    l0[p0] = y0;
    if (++p0 === l0.length) p0 = 0;
    let s = y0;
    if (two) {
      const y1 = x1[i] + fb * d1.lp(l1[p1]);
      l1[p1] = y1;
      if (++p1 === l1.length) p1 = 0;
      s += bankGain * y1;
    }
    s = muf1.process(raspEq.process(midEq.process(bodyEq.process(s))));
    if (muf2) s = muf2.process(s);
    let j = i + third;
    if (j >= L) j -= L;
    s += intakeAmt * intake.process(noise[j] * (e0[i] + e1[i]));
    if (n >= 0) out[n] = s;
    if ((n & MASK) === MASK) yield;
  }
  yield;

  // Level → crackle (overrun) → saturation → DC block → final level.
  const r = rmsOf(out);
  if (r > 1e-9) scaleBy(out, 0.3 / r);
  if (!onLoad) addCrackle(out, rng, sr, rpmFrac, rasp);
  const drive = onLoad ? 1.4 + 1.4 * rasp : 0.9;
  for (let i = 0; i < L; i++) out[i] = softTanh(out[i] * drive);
  dcBlockLoop(out, sr);
  normalizeRms(out, onLoad ? 0.2 : 0.12, 0.97);
  return { data: out, rpm: (120 * sr) / (cyc * pitch) };
}

// ---------------------------------------------------------------------------

/** All loops of one engine spec (filled asynchronously through the job queue). */
export class EngineBank {
  readonly key: string;
  readonly spec: EngineSound;
  readonly on: (AudioBuffer | null)[] = ENGINE_RPMS.map(() => null);
  readonly off: (AudioBuffer | null)[] = ENGINE_RPMS.map(() => null);
  /** Exact rpm of the loops at each grid index. */
  readonly rpm: number[] = ENGINE_RPMS.slice();
  pri = 0;
  private missing = ENGINE_RPMS.length * 2;

  constructor(spec: EngineSound, key: string) {
    this.key = key;
    this.spec = { ...spec };
  }

  get ready(): boolean {
    return this.missing === 0;
  }

  fill(onLoad: boolean, i: number, buf: AudioBuffer, rpm: number): void {
    const arr = onLoad ? this.on : this.off;
    if (arr[i]) return;
    arr[i] = buf;
    this.rpm[i] = rpm;
    this.missing--;
  }
}

/** Cache of engine banks keyed by spec values; renders lazily in time slices. */
export class EngineBanks {
  private readonly ctx: BaseAudioContext;
  private readonly queue: JobQueue;
  private readonly sr: number;
  private readonly banks = new Map<string, EngineBank>();
  /** Fast path for the per-frame lookup (callers pass the same spec object). */
  private readonly byRef = new WeakMap<EngineSound, EngineBank>();

  constructor(ctx: BaseAudioContext, queue: JobQueue) {
    this.ctx = ctx;
    this.queue = queue;
    // Buffers may run at a lower rate than the context (resampled on playback).
    this.sr = Math.min(48000, ctx.sampleRate);
  }

  /** Bank for `spec`; check `.ready` before use. Higher `pri` renders sooner. */
  get(spec: EngineSound, pri: number): EngineBank {
    const known = this.byRef.get(spec);
    if (known && (known.pri >= pri || known.ready)) return known;
    const key = engineKey(spec);
    let bank = this.banks.get(key);
    if (!bank) {
      const b = new EngineBank(spec, key);
      bank = b;
      b.pri = pri;
      this.banks.set(key, b);
      const seed = hashString(key);
      const tag = 'engine:' + key;
      const ctx = this.ctx, sr = this.sr;
      ENGINE_RPMS.forEach((rpm, i) => {
        for (const onLoad of [true, false]) {
          const s = (seed + i * 7919 + (onLoad ? 0 : 104729)) >>> 0;
          this.queue.add(
            function* () {
              const loop = yield* engineLoopTask(b.spec, rpm, onLoad, sr, s);
              b.fill(onLoad, i, toBuffer(ctx, [loop.data], sr), loop.rpm);
            },
            pri,
            tag,
          );
        }
      });
    } else if (pri > bank.pri) {
      bank.pri = pri;
      this.queue.bump('engine:' + key, pri);
    }
    this.byRef.set(spec, bank);
    return bank;
  }
}
