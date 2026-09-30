import { Rng } from '../core/rng';
import { TAU, noise1 } from '../core/math';
import { Biquad, YIELD_EVERY, fadeEdges, loopify, normalizePeak, normalizeRms, pink, reversed, type F32, type Task } from './dsp';

// Procedural game SFX rendered offline in plain JS: one-shots (mono, spatialized
// at playback) and seamless loops. Each renderer is a resumable task.

export type SfxName =
  | 'clunk' | 'blowoff' | 'flutter' | 'pop0' | 'pop1' | 'pop2' | 'whump' | 'whoosh' | 'boost' | 'ding' | 'ting'
  | 'fwoosh' | 'crunch0' | 'crunch1' | 'bump' | 'thud' | 'rswoosh' | 'crash' | 'zap' | 'whistle' | 'chirp';

export type LoopName = 'squeal' | 'scrape' | 'nitro';

const MASK = YIELD_EVERY - 1;
const secs = (sr: number, s: number): number => Math.max(1, Math.round(s * sr));
const decayK = (sr: number, tau: number): number => Math.exp(-1 / Math.max(1e-5, tau * sr));

/** Fast inline white-noise source (xorshift32). */
function noiseGen(seed: number): () => number {
  let s = Math.imul(seed | 0, 2654435761) >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 2147483648 - 1;
  };
}

function finalize(out: F32, sr: number, peak: number, fadeOut = 0.03): F32 {
  normalizePeak(out, peak);
  fadeEdges(out, 12, secs(sr, fadeOut));
  return out;
}

/** Sine with an exponential pitch glide f0 → f1 and an exponential decay. */
function addSweep(out: F32, sr: number, f0: number, f1: number, glideTau: number, amp: number, decay: number, start = 0, attack = 0.001): void {
  const kS = decayK(sr, glideTau), kA = decayK(sr, decay);
  const atk = Math.max(1, attack * sr);
  let eS = 1, eA = amp, ph = 0;
  for (let i = Math.round(start * sr), j = 0; i < out.length; i++, j++) {
    ph += (TAU * (f1 + (f0 - f1) * eS)) / sr;
    out[i] += Math.sin(ph) * eA * Math.min(1, j / atk);
    eS *= kS;
    eA *= kA;
    if (eA < 1e-5 && j > atk) break;
  }
}

/** Decaying sine modes (metal panels, glass, bells). */
function addModes(out: F32, sr: number, freqs: number[], decays: number[], amps: number[], start = 0): void {
  const s0 = Math.round(start * sr);
  for (let k = 0; k < freqs.length; k++) {
    const w = (TAU * freqs[k]) / sr, kA = decayK(sr, decays[k]);
    const end = Math.min(out.length, s0 + Math.ceil(decays[k] * sr * 7));
    let e = amps[k];
    for (let i = s0, j = 0; i < end; i++, j++) {
      out[i] += Math.sin(w * j) * e * Math.min(1, j / 24);
      e *= kA;
    }
  }
}

/** Filtered noise burst with attack / exponential decay. */
function addNoise(out: F32, sr: number, seed: number, amp: number, attack: number, decay: number, start: number, filters: Biquad[]): void {
  const nz = noiseGen(seed);
  const kA = decayK(sr, decay);
  const atk = Math.max(1, attack * sr);
  let e = amp;
  for (let i = Math.round(start * sr), j = 0; i < out.length; i++, j++) {
    let x = nz();
    for (const f of filters) x = f.process(x);
    out[i] += x * e * Math.min(1, j / atk);
    e *= kA;
    if (e < 1e-5 && j > atk) break;
  }
}

// ---------------------------------------------------------------------------
// One-shots

function* clunk(sr: number): Task<F32> {
  const out = new Float32Array(secs(sr, 0.22));
  addSweep(out, sr, 150, 55, 0.02, 0.9, 0.035);
  addNoise(out, sr, 11, 0.45, 0.0002, 0.0025, 0, [new Biquad().highpass(sr, 1800, 0.7)]);
  addModes(out, sr, [1210, 1873, 2644, 3517], [0.03, 0.025, 0.02, 0.015], [0.08, 0.06, 0.05, 0.03], 0.002);
  yield;
  return finalize(out, sr, 0.9);
}

/** Turbo blow-off "pssh"; `flutter` adds the compressor-surge stutter. */
function* blowoff(sr: number, flutter: boolean): Task<F32> {
  const n = secs(sr, flutter ? 0.8 : 0.55);
  const out = new Float32Array(n);
  const nz = noiseGen(flutter ? 202 : 201);
  const bp = new Biquad(), hp = new Biquad().highpass(sr, 900, 0.7);
  const kF = decayK(sr, 0.12), kA = decayK(sr, flutter ? 0.22 : 0.14);
  const atk = 0.006 * sr;
  let eF = 1, eA = 1, fl = 1;
  for (let i = 0; i < n; i++) {
    if ((i & 31) === 0) {
      bp.bandpass(sr, 1900 + 3600 * eF, 1.3);
      if (flutter) {
        const t = i / sr;
        const c = 0.5 + 0.5 * Math.cos(TAU * (24 * t - 9 * t * t));
        fl = 0.25 + 0.75 * c * c;
      }
    }
    out[i] = hp.process(bp.process(nz())) * eA * Math.min(1, i / atk) * fl;
    eF *= kF;
    eA *= kA;
    if ((i & MASK) === MASK) yield;
  }
  return finalize(out, sr, 0.85, 0.04);
}

/** Exhaust backfire: sharp crack + low thump + crackle tail. */
function* pop(sr: number, v: number): Task<F32> {
  const out = new Float32Array(secs(sr, 0.32));
  addNoise(out, sr, 300 + v, 1, 0.0001, 0.0012 + 0.0006 * v, 0, [new Biquad().lowpass(sr, 6500 + 800 * v, 0.7)]);
  addSweep(out, sr, 110 - 10 * v, 45, 0.015, 0.7, 0.03);
  const rng = new Rng(310 + v);
  const k = 3 + 2 * v + Math.floor(rng.next() * 3);
  for (let c = 0; c < k; c++) {
    const at = 0.02 + rng.next() * (0.12 + 0.05 * v);
    const amp = 0.5 * (1 - c / (k + 1)) * (0.5 + rng.next());
    addNoise(out, sr, 320 + c + v * 17, amp, 0.0001, 0.0006 + rng.next() * 0.0015, at, [new Biquad().highpass(sr, 1200, 0.7)]);
  }
  yield;
  return finalize(out, sr, 0.95, 0.03);
}

/** Nitro ignition: low whump + air rush. */
function* whump(sr: number): Task<F32> {
  const out = new Float32Array(secs(sr, 1.1));
  addSweep(out, sr, 120, 36, 0.12, 0.9, 0.28, 0, 0.01);
  addNoise(out, sr, 401, 0.8, 0.02, 0.22, 0, [new Biquad().lowpass(sr, 500, 0.7)]);
  yield;
  addNoise(out, sr, 402, 0.25, 0.01, 0.09, 0, [new Biquad().highpass(sr, 3500, 0.7)]);
  return finalize(out, sr, 0.95, 0.1);
}

/** Pass-by / near-miss whoosh with a Doppler-ish filter arc. */
function* whoosh(sr: number): Task<F32> {
  const n = secs(sr, 0.8);
  const out = new Float32Array(n);
  const nz = noiseGen(501);
  const bp = new Biquad(), lp = new Biquad().lowpass(sr, 6500, 0.7);
  const tc = 0.28;
  let env = 0;
  for (let i = 0; i < n; i++) {
    if ((i & 15) === 0) {
      const t = i / sr;
      const x = (t - tc) / 0.13;
      env = Math.exp(-x * x * (x < 0 ? 1.2 : 0.6));
      bp.bandpass(sr, t < tc ? 500 + 2600 * env : 350 + 1500 * env, 0.9);
    }
    out[i] = lp.process(bp.process(nz())) * env;
    if ((i & MASK) === MASK) yield;
  }
  return finalize(out, sr, 0.9, 0.05);
}

/** Boost: rising air rush + thrust. */
function* boost(sr: number): Task<F32> {
  const n = secs(sr, 1.0);
  const out = new Float32Array(n);
  const nz = noiseGen(601);
  const bp = new Biquad();
  let env = 0;
  for (let i = 0; i < n; i++) {
    if ((i & 15) === 0) {
      const t = i / sr;
      const a = Math.min(1, t / 0.25);
      env = a * a * Math.exp(-Math.max(0, t - 0.3) / 0.25);
      bp.bandpass(sr, 400 * Math.pow(10, Math.min(1, t / 0.45)), 1.2);
    }
    out[i] = bp.process(nz()) * env;
    if ((i & MASK) === MASK) yield;
  }
  addSweep(out, sr, 55, 120, 0.2, 0.35, 0.3, 0, 0.05);
  return finalize(out, sr, 0.9, 0.08);
}

/** FM bell: `fc` carrier, `ratio` modulator, `index` initial brightness. */
function* bell(sr: number, seconds: number, fc: number, ratio: number, index: number, decay: number, extra: [number, number, number][]): Task<F32> {
  const n = secs(sr, seconds);
  const out = new Float32Array(n);
  const kI = decayK(sr, decay * 0.3), kA = decayK(sr, decay);
  let eI = index, eA = 1;
  const wc = (TAU * fc) / sr, wm = wc * ratio;
  for (let i = 0; i < n; i++) {
    out[i] = Math.sin(wc * i + eI * Math.sin(wm * i)) * eA * Math.min(1, i / 48);
    eI *= kI;
    eA *= kA;
    if ((i & MASK) === MASK) yield;
  }
  addModes(out, sr, extra.map((e) => e[0]), extra.map((e) => e[1]), extra.map((e) => e[2]));
  return finalize(out, sr, 0.8, 0.05);
}

/** Drift release: descending air "fwoosh". */
function* fwoosh(sr: number): Task<F32> {
  const n = secs(sr, 0.7);
  const out = new Float32Array(n);
  const nz = noiseGen(701);
  const bp = new Biquad();
  const kF = decayK(sr, 0.18);
  let eF = 1, env = 0;
  for (let i = 0; i < n; i++) {
    if ((i & 15) === 0) {
      const t = i / sr;
      env = Math.min(1, t / 0.02) * Math.exp(-t / 0.2);
      bp.bandpass(sr, 450 + 2150 * eF, 0.8);
    }
    out[i] = bp.process(nz()) * env;
    eF *= kF;
    if ((i & MASK) === MASK) yield;
  }
  addSweep(out, sr, 90, 50, 0.05, 0.3, 0.08);
  return finalize(out, sr, 0.85, 0.06);
}

/** Wall hit: thump, bent-panel modes, crunch texture, crackle and debris. */
function* crunch(sr: number, v: number): Task<F32> {
  const out = new Float32Array(secs(sr, 0.8));
  addSweep(out, sr, 85 + v * 10, 40, 0.03, 1, 0.07);
  const modes = v ? [340, 790, 1420, 2330, 3100] : [310, 730, 1370, 2210, 2950];
  addModes(out, sr, modes, [0.12, 0.09, 0.07, 0.05, 0.04], [0.35, 0.3, 0.22, 0.15, 0.1], 0.003);
  addNoise(out, sr, 400 + v, 0.8, 0.0005, 0.09, 0, [new Biquad().bandpass(sr, 1800, 0.7)]);
  yield;
  const rng = new Rng(410 + v);
  for (let c = 0; c < 26; c++) {
    const at = Math.pow(rng.next(), 1.8) * 0.4;
    addNoise(out, sr, 420 + c, (0.6 - at) * (0.4 + rng.next() * 0.6), 0.0001, 0.0004 + rng.next() * 0.001, at, [new Biquad().highpass(sr, 2000, 0.7)]);
  }
  for (let c = 0; c < 8; c++) {
    const at = 0.1 + rng.next() * 0.6;
    addModes(out, sr, [3000 + rng.next() * 4000], [0.01], [0.08 * (1 - at)], at);
  }
  yield;
  return finalize(out, sr, 0.95, 0.08);
}

/** Car-to-car contact: body thump + panel "bonk". */
function* bump(sr: number): Task<F32> {
  const out = new Float32Array(secs(sr, 0.5));
  addSweep(out, sr, 120, 60, 0.02, 0.9, 0.04);
  addModes(out, sr, [180, 420, 690, 1130], [0.09, 0.07, 0.05, 0.04], [0.4, 0.3, 0.2, 0.12], 0.002);
  addNoise(out, sr, 801, 0.4, 0.0002, 0.004, 0, [new Biquad().highpass(sr, 1500, 0.7)]);
  yield;
  return finalize(out, sr, 0.9, 0.05);
}

/** Landing: heavy thud, suspension clank and a little spring. */
function* thud(sr: number): Task<F32> {
  const out = new Float32Array(secs(sr, 0.7));
  addSweep(out, sr, 70, 32, 0.04, 1, 0.14);
  addNoise(out, sr, 901, 0.6, 0.001, 0.05, 0, [new Biquad().lowpass(sr, 300, 0.7)]);
  addModes(out, sr, [820, 1330, 2090, 2870], [0.05, 0.04, 0.03, 0.02], [0.15, 0.12, 0.08, 0.05], 0.035);
  addSweep(out, sr, 260, 190, 0.08, 0.1, 0.12, 0.05, 0.01);
  yield;
  return finalize(out, sr, 0.95, 0.06);
}

/** Respawn: reversed swoosh (swells in, ends abruptly). */
function* rswoosh(sr: number): Task<F32> {
  const n = secs(sr, 0.9);
  const fwd = new Float32Array(n);
  const nz = noiseGen(1001);
  const bp = new Biquad();
  let env = 0;
  for (let i = 0; i < n; i++) {
    if ((i & 15) === 0) {
      const t = i / sr;
      env = Math.min(1, t / 0.005) * Math.exp(-t / 0.25);
      bp.bandpass(sr, 400 + 2600 * Math.exp(-t / 0.3), 1.1);
    }
    fwd[i] = bp.process(nz()) * env;
    if ((i & MASK) === MASK) yield;
  }
  addSweep(fwd, sr, 1200, 300, 0.25, 0.25, 0.3, 0, 0.005);
  const out = reversed(fwd);
  return finalize(out, sr, 0.85, 0.008);
}

/** Heavy crash: crunch + shattering pings + boom. */
function* crash(sr: number): Task<F32> {
  const out = new Float32Array(secs(sr, 1.5));
  addSweep(out, sr, 75, 30, 0.06, 1, 0.35);
  addModes(out, sr, [290, 650, 1230, 1990, 2870, 3700], [0.2, 0.15, 0.1, 0.08, 0.06, 0.05], [0.35, 0.3, 0.25, 0.2, 0.15, 0.1], 0.004);
  addNoise(out, sr, 1101, 0.9, 0.0005, 0.15, 0, [new Biquad().bandpass(sr, 1500, 0.6)]);
  yield;
  const rng = new Rng(1102);
  for (let c = 0; c < 40; c++) {
    const at = Math.pow(rng.next(), 1.5) * 0.6;
    addModes(out, sr, [3000 + rng.next() * 6000], [0.02 + rng.next() * 0.04], [0.12 * (1 - at) * (0.3 + rng.next())], at);
  }
  yield;
  return finalize(out, sr, 0.97, 0.15);
}

/** Slingshot: rising FM zap + air. */
function* zap(sr: number): Task<F32> {
  const n = secs(sr, 0.6);
  const out = new Float32Array(n);
  let ph = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const f = 300 * Math.pow(8, Math.min(1, t / 0.35)) * (1 + 0.03 * Math.sin(TAU * 30 * t) * Math.exp(-t / 0.2));
    ph += (TAU * f) / sr;
    out[i] = Math.sin(ph) * Math.min(1, t / 0.01) * Math.exp(-t / 0.25) * 0.5;
    if ((i & MASK) === MASK) yield;
  }
  addNoise(out, sr, 1201, 0.4, 0.08, 0.15, 0, [new Biquad().bandpass(sr, 2500, 0.8)]);
  return finalize(out, sr, 0.85, 0.06);
}

/** Slipstream whistle: airy tone swelling in and out. */
function* whistle(sr: number): Task<F32> {
  const n = secs(sr, 1.4);
  const out = new Float32Array(n);
  const nz = noiseGen(1301);
  const bp = new Biquad().bandpass(sr, 3000, 3);
  let ph = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const s = Math.sin((Math.PI * t) / 1.4);
    const env = s * s;
    ph += (TAU * (2600 + 15 * Math.sin(TAU * 5 * t))) / sr;
    out[i] = (Math.sin(ph) * 0.6 + bp.process(nz()) * 0.8) * env;
    if ((i & MASK) === MASK) yield;
  }
  return finalize(out, sr, 0.7, 0.05);
}

/** Tire chirp (drift entry / hard landing). */
function* chirp(sr: number): Task<F32> {
  const out = new Float32Array(secs(sr, 0.2));
  addSweep(out, sr, 1450, 1250, 0.05, 0.6, 0.05, 0, 0.005);
  addNoise(out, sr, 1401, 0.4, 0.005, 0.05, 0, [new Biquad().bandpass(sr, 1600, 1.5)]);
  yield;
  return finalize(out, sr, 0.8, 0.03);
}

// ---------------------------------------------------------------------------
// Loops (seamless: rendered long, tail crossfaded into the head)

function* squeal(sr: number): Task<F32> {
  const T = 1.5, F = 0.12;
  const n = secs(sr, T + F);
  const out = new Float32Array(n);
  const nz = noiseGen(1501);
  const bp1 = new Biquad().bandpass(sr, 1800, 1.2), bp2 = new Biquad().bandpass(sr, 700, 0.8);
  let ph = 0, fm = 1, am = 1;
  for (let i = 0; i < n; i++) {
    if ((i & 31) === 0) {
      const t = i / sr;
      fm = 1 + 0.025 * noise1(t * 7, 3) + 0.01 * noise1(t * 23, 5);
      am = 0.65 + 0.35 * noise1(t * 11, 7);
    }
    ph += (TAU * 1050 * fm) / sr;
    const tone = Math.sin(ph) + 0.45 * Math.sin(2.01 * ph) + 0.2 * Math.sin(3.03 * ph);
    out[i] = tone * am * 0.5 + bp1.process(nz()) * 0.35 + bp2.process(nz()) * 0.2;
    if ((i & MASK) === MASK) yield;
  }
  const loop = loopify(out, F * sr);
  normalizeRms(loop, 0.25, 0.9);
  return loop;
}

function* scrape(sr: number): Task<F32> {
  const T = 1.2, F = 0.1;
  const n = secs(sr, T + F);
  const out = new Float32Array(n);
  const nz = noiseGen(1601);
  const bp1 = new Biquad().bandpass(sr, 2800, 0.8), bp2 = new Biquad().bandpass(sr, 4000, 2);
  const hp = new Biquad().highpass(sr, 2000, 0.7);
  const rng = new Rng(1602);
  let p1 = 0, p2 = 0, p3 = 0, fm = 1, am = 0, click = 0;
  const kClick = decayK(sr, 0.0006);
  for (let i = 0; i < n; i++) {
    if ((i & 31) === 0) {
      const t = i / sr;
      fm = 1 + 0.03 * noise1(t * 9, 11);
      am = Math.max(0, noise1(t * 5, 13) + 0.3);
    }
    if (rng.next() < 60 / sr) click = 0.4 + rng.next() * 0.6; // ~60 crackles/s
    p1 += (TAU * 1330 * fm) / sr;
    p2 += (TAU * 2710 * fm) / sr;
    p3 += (TAU * 4130 * fm) / sr;
    const w = nz();
    const screech = (Math.sin(p1) + 0.6 * Math.sin(p2) + 0.4 * Math.sin(p3)) * am * 0.25;
    out[i] = bp1.process(w) * 0.6 + bp2.process(w) * 0.3 + screech + hp.process(nz()) * click;
    click *= kClick;
    if ((i & MASK) === MASK) yield;
  }
  const loop = loopify(out, F * sr);
  normalizeRms(loop, 0.25, 0.9);
  return loop;
}

function* nitroLoop(sr: number): Task<F32> {
  const T = 2, F = 0.15;
  const n = secs(sr, T + F);
  const out = new Float32Array(n);
  const nz = noiseGen(1701);
  const lpRoar = new Biquad().lowpass(sr, 900, 0.7), lpRumble = new Biquad().lowpass(sr, 150, 0.7);
  const bp = new Biquad().bandpass(sr, 3200, 0.7);
  let brown = 0, am = 1;
  for (let i = 0; i < n; i++) {
    if ((i & 31) === 0) {
      const t = i / sr;
      am = 1 + 0.08 * Math.sin(TAU * 13 * t) + 0.05 * noise1(t * 6, 17);
    }
    const w = nz();
    brown = (brown + 0.02 * w) / 1.02;
    out[i] = (lpRoar.process(brown * 3.5) * 0.9 + bp.process(nz()) * 0.35 + lpRumble.process(brown * 3.5) * 0.5) * am;
    if ((i & MASK) === MASK) yield;
  }
  const loop = loopify(out, F * sr);
  normalizeRms(loop, 0.25, 0.9);
  return loop;
}

/** Stereo decorrelated pink noise loop (wind / road bed). */
export function* windLoop(sr: number): Task<[F32, F32]> {
  const n = secs(sr, 3.2), F = secs(sr, 0.2);
  const l = pink(n, 1801);
  yield;
  const r = pink(n, 1802);
  yield;
  const L = loopify(l, F), R = loopify(r, F);
  normalizePeak(L, 0.9);
  normalizePeak(R, 0.9);
  return [L, R];
}

// ---------------------------------------------------------------------------

export const SFX_TASKS: Record<SfxName, (sr: number) => Task<F32>> = {
  clunk,
  blowoff: (sr) => blowoff(sr, false),
  flutter: (sr) => blowoff(sr, true),
  pop0: (sr) => pop(sr, 0),
  pop1: (sr) => pop(sr, 1),
  pop2: (sr) => pop(sr, 2),
  whump,
  whoosh,
  boost,
  ding: (sr) => bell(sr, 1.0, 1760, 3.5, 2.5, 0.3, [[2637, 0.2, 0.3], [3520, 0.12, 0.15]]),
  ting: (sr) => bell(sr, 0.7, 1318.5, 2, 1.5, 0.25, [[2637, 0.12, 0.25]]),
  fwoosh,
  crunch0: (sr) => crunch(sr, 0),
  crunch1: (sr) => crunch(sr, 1),
  bump,
  thud,
  rswoosh,
  crash,
  zap,
  whistle,
  chirp,
};

export const LOOP_TASKS: Record<LoopName, (sr: number) => Task<F32>> = {
  squeal,
  scrape,
  nitro: nitroLoop,
};
