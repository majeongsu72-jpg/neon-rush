import { Rng } from '../core/rng';
import { TAU, clamp } from '../core/math';
import { Biquad, Reverb, YIELD_EVERY, fadeEdges, fillNoise, normalizePeak, softTanh, type F32, type Task } from './dsp';
import type { KitPatch } from './songs';

// Drum kit + arrangement FX, pre-rendered in plain JS (deterministic, cheap to
// play back: one buffer source per hit). Every renderer is a resumable task
// (yields every few thousand samples) and avoids per-sample exp/pow, so the
// job queue can spread the work over frames without hitches.

export type DrumName = 'kick' | 'snare' | 'clap' | 'hat' | 'ohat' | 'perc' | 'crash' | 'riser' | 'impact';

const MASK = YIELD_EVERY - 1;
const secs = (sr: number, s: number): number => Math.max(1, Math.round(s * sr));
/** Per-sample multiplier of an exponential decay with time constant `tau` (s). */
const decayK = (sr: number, tau: number): number => Math.exp(-1 / Math.max(1e-5, tau * sr));

/** Bank of fixed-frequency sine phasors (rotation instead of sin()). */
class Partials {
  private readonly re: Float64Array;
  private readonly im: Float64Array;
  private readonly cs: Float64Array;
  private readonly sn: Float64Array;

  constructor(sr: number, freqs: number[], rng: Rng) {
    const K = freqs.length;
    this.re = new Float64Array(K);
    this.im = new Float64Array(K);
    this.cs = new Float64Array(K);
    this.sn = new Float64Array(K);
    for (let k = 0; k < K; k++) {
      const w = (TAU * freqs[k]) / sr;
      const p = rng.next() * TAU;
      this.cs[k] = Math.cos(w);
      this.sn[k] = Math.sin(w);
      this.re[k] = Math.cos(p);
      this.im[k] = Math.sin(p);
    }
  }

  next(): number {
    const re = this.re, im = this.im, cs = this.cs, sn = this.sn;
    let m = 0;
    for (let k = 0; k < re.length; k++) {
      const x = re[k] * cs[k] - im[k] * sn[k];
      im[k] = re[k] * sn[k] + im[k] * cs[k];
      re[k] = x;
      m += im[k];
    }
    return m;
  }
}

export function* renderKick(sr: number, p: KitPatch['kick']): Task<F32> {
  const n = secs(sr, Math.min(0.8, p.decay * 3 + 0.08));
  const out = new Float32Array(n);
  const kS = decayK(sr, p.sweep), kA = decayK(sr, p.decay);
  let eS = 1, eA = 1, ph = 0;
  const atk = 0.0012 * sr;
  for (let i = 0; i < n; i++) {
    ph += (TAU * (p.f1 + (p.f0 - p.f1) * eS)) / sr;
    out[i] = Math.sin(ph) * eA * Math.min(1, i / atk);
    eS *= kS;
    eA *= kA;
    if ((i & MASK) === MASK) yield;
  }
  // Beater click.
  const nc = secs(sr, 0.012);
  const click = new Float32Array(nc);
  fillNoise(click, 77);
  const hp = new Biquad().highpass(sr, 2200, 0.8);
  const kC = decayK(sr, 0.0022);
  let eC = p.click;
  for (let i = 0; i < nc; i++) {
    out[i] += hp.process(click[i]) * eC;
    eC *= kC;
  }
  for (let i = 0; i < n; i++) out[i] = softTanh(out[i] * p.drive);
  normalizePeak(out, 0.95);
  fadeEdges(out, 0, secs(sr, 0.03));
  return out;
}

export function* renderSnare(sr: number, p: KitPatch['snare']): Task<F32> {
  const n = secs(sr, p.gate > 0 ? Math.max(0.3, p.gate + 0.05) : 0.75);
  const dry = new Float32Array(n);
  const nz = new Float32Array(n);
  fillNoise(nz, 5);
  const hp = new Biquad().highpass(sr, 900, 0.7);
  const pk = new Biquad().peak(sr, 4500, 0.8, 5);
  const lp = new Biquad().lowpass(sr, 11000, 0.7);
  const kDrop = decayK(sr, 0.012), kTone = decayK(sr, 0.045), kNoise = decayK(sr, p.decay);
  let eDrop = 0.35, eTone = 0.9, eNoise = p.noise, ph1 = 0, ph2 = 0;
  const atk = 0.0008 * sr;
  for (let i = 0; i < n; i++) {
    const w = (TAU * p.tone * (1 + eDrop)) / sr;
    ph1 += w;
    ph2 += w * 1.87;
    dry[i] = (Math.sin(ph1) * 0.8 + Math.sin(ph2) * 0.35) * eTone + lp.process(pk.process(hp.process(nz[i]))) * eNoise * Math.min(1, i / atk);
    eDrop *= kDrop;
    eTone *= kTone;
    eNoise *= kNoise;
    if ((i & MASK) === MASK) yield;
  }
  // 80s gated room (gate > 0) or a natural plate tail.
  const out = new Float32Array(n);
  const verb = new Reverb(sr, p.gate > 0 ? 1.6 : 1.1, 0.3, 1.1);
  const gateEnd = p.gate * sr, gateFade = 0.012 * sr;
  for (let i = 0; i < n; i++) {
    let w = verb.process(dry[i]);
    if (p.gate > 0) w *= i < gateEnd ? 1 : Math.max(0, 1 - (i - gateEnd) / gateFade);
    out[i] = dry[i] + p.verb * w * 3;
    if ((i & MASK) === MASK) yield;
  }
  normalizePeak(out, 0.95);
  fadeEdges(out, 0, secs(sr, 0.02));
  return out;
}

export function* renderClap(sr: number, p: KitPatch['clap']): Task<F32> {
  const n = secs(sr, 0.55);
  const nz = new Float32Array(n);
  fillNoise(nz, 9);
  const bp = new Biquad().bandpass(sr, 1150, 1.1);
  const hp = new Biquad().highpass(sr, 500, 0.7);
  const starts = [0, 0.0105, 0.0205, 0.0325].map((s) => Math.round(s * sr));
  const kShort = decayK(sr, 0.0045), kLong = decayK(sr, 0.085);
  const env = [0, 0, 0, 0];
  const out = new Float32Array(n);
  const verb = new Reverb(sr, 0.9, 0.4, 0.8);
  for (let i = 0; i < n; i++) {
    let e = 0;
    for (let b = 0; b < 4; b++) {
      if (i === starts[b]) env[b] = 1;
      else env[b] *= b === 3 ? kLong : kShort;
      if (env[b] > e) e = env[b];
    }
    const d = hp.process(bp.process(nz[i])) * e;
    out[i] = d + p.verb * 2.5 * verb.process(d);
    if ((i & MASK) === MASK) yield;
  }
  normalizePeak(out, 0.95);
  fadeEdges(out, 0, secs(sr, 0.05));
  return out;
}

export function* renderHat(sr: number, decay: number, bright: number, seed: number): Task<F32> {
  const n = secs(sr, Math.min(0.9, decay * 5 + 0.02));
  const out = new Float32Array(n);
  const nz = new Float32Array(n);
  fillNoise(nz, seed);
  const metal = new Partials(sr, [3150, 4720, 5530, 6980, 8340, 10250], new Rng(seed));
  const hp = new Biquad().highpass(sr, 6500 + 1500 * bright, 0.7);
  const bp = new Biquad().bandpass(sr, 9500 + 2000 * bright, 0.6);
  const k = decayK(sr, decay);
  const atk = 0.0005 * sr;
  let e = 1;
  for (let i = 0; i < n; i++) {
    const x = nz[i] * 0.8 + metal.next() * 0.1;
    out[i] = (hp.process(x) * 0.6 + bp.process(x) * 0.8) * e * Math.min(1, i / atk);
    e *= k;
    if ((i & MASK) === MASK) yield;
  }
  normalizePeak(out, 0.9);
  fadeEdges(out, 0, secs(sr, 0.01));
  return out;
}

/** Short tuned FM blip (techno rim / perc). */
export function* renderPerc(sr: number, p: KitPatch['perc']): Task<F32> {
  const n = secs(sr, Math.max(0.08, p.decay * 5));
  const out = new Float32Array(n);
  const kI = decayK(sr, 0.01), kA = decayK(sr, p.decay);
  let eI = 2.5, eA = 1;
  const w = (TAU * p.freq) / sr;
  for (let i = 0; i < n; i++) {
    out[i] = Math.sin(w * i + eI * Math.sin(w * 1.48 * i)) * eA;
    eI *= kI;
    eA *= kA;
    if ((i & MASK) === MASK) yield;
  }
  normalizePeak(out, 0.9);
  fadeEdges(out, 8, secs(sr, 0.01));
  return out;
}

export function* renderCrash(sr: number): Task<F32> {
  const n = secs(sr, 2.2);
  const out = new Float32Array(n);
  const nz = new Float32Array(n);
  fillNoise(nz, 31);
  const rng = new Rng(31);
  const freqs: number[] = [];
  for (let k = 0; k < 14; k++) freqs.push(2500 + rng.next() * 8500);
  const shimmer = new Partials(sr, freqs, rng);
  const hp = new Biquad().highpass(sr, 3000, 0.6);
  const lp = new Biquad().lowpass(sr, 14000, 0.6);
  const k1 = decayK(sr, 0.35), k2 = decayK(sr, 1.1);
  const atk = 0.001 * sr;
  let e1 = 0.7, e2 = 0.3;
  for (let i = 0; i < n; i++) {
    out[i] = lp.process(hp.process(nz[i] + shimmer.next() * 0.06)) * (e1 + e2) * Math.min(1, i / atk);
    e1 *= k1;
    e2 *= k2;
    if ((i & MASK) === MASK) yield;
  }
  normalizePeak(out, 0.9);
  fadeEdges(out, 0, secs(sr, 0.2));
  return out;
}

/** Noise + tone riser lasting `seconds` (ends at full level). */
export function* renderRiser(sr: number, seconds: number): Task<F32> {
  const n = secs(sr, seconds);
  const out = new Float32Array(n);
  const nz = new Float32Array(n);
  fillNoise(nz, 41);
  const bp = new Biquad();
  // Swept tones as phasors whose rotation is updated at control rate.
  let re1 = 1, im1 = 0, re2 = 1, im2 = 0, c1 = 1, s1 = 0, c2 = 1, s2 = 0, env = 0;
  for (let i = 0; i < n; i++) {
    if ((i & 31) === 0) {
      const x = i / n;
      bp.bandpass(sr, 250 * Math.pow(28, x), 1.8 + 1.5 * x);
      const w = (TAU * 220 * Math.pow(8, x) * (1 + 0.006 * Math.sin(TAU * 6 * (i / sr)))) / sr;
      c1 = Math.cos(w);
      s1 = Math.sin(w);
      c2 = Math.cos(w * 2.01);
      s2 = Math.sin(w * 2.01);
      env = Math.pow(x, 2.2);
      const m1 = 1 / Math.hypot(re1, im1), m2 = 1 / Math.hypot(re2, im2);
      re1 *= m1;
      im1 *= m1;
      re2 *= m2;
      im2 *= m2;
    }
    let t = re1 * c1 - im1 * s1;
    im1 = re1 * s1 + im1 * c1;
    re1 = t;
    t = re2 * c2 - im2 * s2;
    im2 = re2 * s2 + im2 * c2;
    re2 = t;
    out[i] = (bp.process(nz[i]) * 1.6 + im1 * 0.12 + im2 * 0.05) * env;
    if ((i & MASK) === MASK) yield;
  }
  normalizePeak(out, 0.9);
  fadeEdges(out, 64, secs(sr, 0.015));
  return out;
}

/** Cinematic drop: sub boom + noise hit with a long dark tail. */
export function* renderImpact(sr: number): Task<F32> {
  const n = secs(sr, 2.6);
  const out = new Float32Array(n);
  const nz = new Float32Array(n);
  fillNoise(nz, 55);
  const lp = new Biquad().lowpass(sr, 1800, 0.7);
  const verb = new Reverb(sr, 2.8, 0.55, 1.3);
  const kF = decayK(sr, 0.15), kA = decayK(sr, 0.45), kH = decayK(sr, 0.07);
  let eF = 1, eA = 1, eH = 0.7, ph = 0;
  const atk = 0.002 * sr;
  for (let i = 0; i < n; i++) {
    ph += (TAU * (30 + 42 * eF)) / sr;
    const hit = lp.process(nz[i]) * eH;
    out[i] = Math.sin(ph) * eA * Math.min(1, i / atk) + hit + verb.process(hit) * 2;
    eF *= kF;
    eA *= kA;
    eH *= kH;
    if ((i & MASK) === MASK) yield;
  }
  normalizePeak(out, 0.95);
  fadeEdges(out, 0, secs(sr, 0.3));
  return out;
}

// ---------------------------------------------------------------------------

type Put = (name: DrumName, data: F32) => void;

function putter(ctx: BaseAudioContext, sr: number, into: Map<DrumName, AudioBuffer>): Put {
  return (name, data) => {
    const b = ctx.createBuffer(1, data.length, sr);
    b.copyToChannel(data, 0);
    into.set(name, b);
  };
}

function* store(put: Put, name: DrumName, task: Task<F32>): Task<void> {
  put(name, yield* task);
}

/** Jobs rendering a song's own kit (tuned per song; the riser spans two bars). */
export function kitJobs(ctx: BaseAudioContext, sr: number, kit: KitPatch, bpm: number, into: Map<DrumName, AudioBuffer>): (() => Task<void>)[] {
  const put = putter(ctx, sr, into);
  const beat = 60 / clamp(bpm, 40, 240);
  return [
    () => store(put, 'kick', renderKick(sr, kit.kick)),
    () => store(put, 'snare', renderSnare(sr, kit.snare)),
    () => store(put, 'hat', renderHat(sr, kit.hat.decay, kit.hat.bright, 17)),
    () => store(put, 'clap', renderClap(sr, kit.clap)),
    () => store(put, 'ohat', renderHat(sr, kit.ohat.decay, kit.hat.bright, 23)),
    () => store(put, 'perc', renderPerc(sr, kit.perc)),
    () => store(put, 'riser', renderRiser(sr, beat * 8)),
  ];
}

/** Jobs rendering the FX every song shares (crash, impact). */
export function sharedFxJobs(ctx: BaseAudioContext, sr: number, into: Map<DrumName, AudioBuffer>): (() => Task<void>)[] {
  const put = putter(ctx, sr, into);
  return [() => store(put, 'crash', renderCrash(sr)), () => store(put, 'impact', renderImpact(sr))];
}
