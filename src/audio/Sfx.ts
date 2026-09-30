import { clamp, clamp01, noise1, smoothstep } from '../core/math';
import { cleanupOnEnd, glide, midiToHz, pulseWave, toBuffer, type F32, type JobQueue, type Task } from './dsp';
import { LOOP_TASKS, SFX_TASKS, windLoop, type LoopName, type SfxName } from './sfxSynth';

// Runtime SFX: pre-rendered one-shots (spatialized per play), continuous
// layers driven every frame (wind / road / squeal / curb / scrape / nitro),
// and small live-synth UI + race stingers tuned to the current song key.

export type UiName = 'move' | 'select' | 'back' | 'start' | 'error';
export type Stinger = 'beep' | 'go' | 'lap' | 'finalLap' | 'finish' | 'overtake' | 'checkpoint' | 'wrongWay' | 'record' | 'combo';

export interface PlayOpts {
  gain?: number;
  rate?: number;
  pan?: number;
  /** Pan target reached at the end of the sound (fly-bys). */
  panTo?: number;
  lp?: number;
  delay?: number;
  verb?: number;
  ui?: boolean;
  /** Skip when many one-shots are already playing. */
  optional?: boolean;
}

export interface LayerInput {
  active: boolean;
  speed: number; // m/s
  speedNorm: number;
  slip: number;
  drifting: boolean;
  onCurb: boolean;
  scrape: number;
  airborne: boolean;
  nitro: boolean;
  tunnel: number;
  rate: number; // slow-mo pitch factor
}

interface ToneOpts {
  type?: OscillatorType;
  gain?: number;
  attack?: number;
  decay?: number;
  glideTo?: number;
  detune?: number;
  lp?: number;
  verb?: number;
}

interface Layer {
  src: AudioBufferSourceNode;
  filter: BiquadFilterNode | null;
  gain: GainNode;
}

const MAX_ONESHOTS = 28;
const PENTA = [0, 2, 4, 7, 9, 12, 14, 16, 19, 21, 24];

function job<T>(make: () => Task<T>, done: (v: T) => void): () => Task<void> {
  return function* () {
    done(yield* make());
  };
}

export class Sfx {
  /** Stereo noise bed (also feeds the turbo hiss); null until rendered. */
  noise: AudioBuffer | null = null;
  private readonly ctx: AudioContext;
  private readonly sfxBus: AudioNode;
  private readonly uiBus: AudioNode;
  private readonly verb: AudioNode;
  private readonly bufs = new Map<SfxName, AudioBuffer>();
  private readonly layers = new Map<LoopName, Layer>();
  private bed: { src: AudioBufferSourceNode; windLp: BiquadFilterNode; wind: GainNode; whistleBp: BiquadFilterNode; whistle: GainNode; roadLp: BiquadFilterNode; road: GainNode } | null = null;
  private readonly curbOsc: OscillatorNode;
  private readonly curbLp: BiquadFilterNode;
  private readonly curbGain: GainNode;
  private active = 0;
  private readonly onNoise: (() => void)[] = [];

  constructor(ctx: AudioContext, queue: JobQueue, sfxBus: AudioNode, uiBus: AudioNode, verb: AudioNode) {
    this.ctx = ctx;
    this.sfxBus = sfxBus;
    this.uiBus = uiBus;
    this.verb = verb;
    const sr = Math.min(48000, ctx.sampleRate);
    queue.add(
      job(
        () => windLoop(sr),
        ([l, r]) => {
          this.noise = toBuffer(ctx, [l, r], sr);
          this.buildBed(this.noise);
          for (const cb of this.onNoise) cb();
        },
      ),
      6,
      'sfx:bed',
    );
    for (const name of Object.keys(SFX_TASKS) as SfxName[]) {
      queue.add(job(() => SFX_TASKS[name](sr), (d: F32) => this.bufs.set(name, toBuffer(ctx, [d], sr))), 4, 'sfx');
    }
    for (const name of Object.keys(LOOP_TASKS) as LoopName[]) {
      queue.add(job(() => LOOP_TASKS[name](sr), (d: F32) => this.buildLayer(name, toBuffer(ctx, [d], sr))), 4, 'sfx');
    }
    // Rumble-strip buzz: pulse oscillator at wheel speed / stripe length.
    this.curbOsc = ctx.createOscillator();
    this.curbOsc.setPeriodicWave(pulseWave(ctx, 0.28, 24));
    this.curbOsc.frequency.value = 40;
    this.curbLp = ctx.createBiquadFilter();
    this.curbLp.type = 'lowpass';
    this.curbLp.frequency.value = 900;
    this.curbGain = ctx.createGain();
    this.curbGain.gain.value = 0;
    this.curbOsc.connect(this.curbLp).connect(this.curbGain).connect(sfxBus);
    this.curbOsc.start();
  }

  /** Run `cb` once the noise bed exists (immediately if it already does). */
  whenNoise(cb: () => void): void {
    if (this.noise) cb();
    else this.onNoise.push(cb);
  }

  private buildBed(noise: AudioBuffer): void {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = noise;
    src.loop = true;
    const mk = (type: BiquadFilterType, f: number, q: number): [BiquadFilterNode, GainNode] => {
      const flt = ctx.createBiquadFilter();
      flt.type = type;
      flt.frequency.value = f;
      flt.Q.value = q;
      const g = ctx.createGain();
      g.gain.value = 0;
      src.connect(flt).connect(g).connect(this.sfxBus);
      return [flt, g];
    };
    const [windLp, wind] = mk('lowpass', 400, 0.5);
    const [whistleBp, whistle] = mk('bandpass', 2600, 8);
    const [roadLp, road] = mk('lowpass', 150, 0.7);
    src.start();
    this.bed = { src, windLp, wind, whistleBp, whistle, roadLp, road };
  }

  private buildLayer(name: LoopName, buf: AudioBuffer): void {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    let filter: BiquadFilterNode | null = null;
    if (name === 'nitro') {
      filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = 1500;
      src.connect(filter).connect(gain);
    } else src.connect(gain);
    gain.connect(this.sfxBus);
    src.start(0, Math.random() * buf.duration * 0.9);
    this.layers.set(name, { src, filter, gain });
  }

  /** Continuous layers, once per frame. */
  updateLayers(L: LayerInput, now: number): void {
    const a = L.active ? 1 : 0;
    const v = Math.max(0, L.speed);
    const sn = clamp(L.speedNorm, 0, 1.4);
    const air = L.airborne;
    const tun = clamp01(L.tunnel);
    const gust = 1 + 0.12 * noise1(now * 0.7, 9);
    const bed = this.bed;
    if (bed) {
      glide(bed.windLp.frequency, clamp((300 + 30 * v) * (air ? 1.25 : 1), 200, 16000), now, 0.1);
      glide(bed.wind.gain, a * 0.34 * sn * sn * gust * (1 + 0.35 * tun) * (air ? 1.3 : 1), now, 0.08);
      // Faint high whistle above ~250 km/h.
      glide(bed.whistleBp.frequency, 2200 + 14 * v, now, 0.1);
      glide(bed.whistle.gain, a * 0.05 * smoothstep(62, 85, v) * gust, now, 0.15);
      // Tire roll / road rumble (gone in the air).
      glide(bed.roadLp.frequency, 110 + 5 * v, now, 0.1);
      glide(bed.road.gain, air ? 0 : a * 0.5 * smoothstep(1, 40, v) * (0.6 + 0.4 * Math.min(1, sn)) * (1 + 0.3 * tun), now, air ? 0.05 : 0.12);
    }
    const sq = this.layers.get('squeal');
    if (sq) {
      const slip = air ? 0 : clamp01(Math.max(L.slip, L.drifting ? 0.45 : 0));
      glide(sq.gain.gain, a * 0.3 * Math.pow(slip, 1.5) * smoothstep(3, 15, v), now, 0.05);
      glide(sq.src.playbackRate, (0.9 + 0.2 * slip + 0.03 * Math.sin(now * 8.2)) * L.rate, now, 0.05);
    }
    // Curb: ~0.9 m stripes → buzz frequency tracks wheel speed.
    const curb = L.onCurb && !air && v > 2;
    glide(this.curbOsc.frequency, clamp((v / 0.9) * L.rate, 8, 240), now, 0.02);
    glide(this.curbGain.gain, curb ? a * 0.2 * smoothstep(2, 25, v) : 0, now, curb ? 0.015 : 0.05);
    const sc = this.layers.get('scrape');
    if (sc) {
      const s = clamp01(L.scrape);
      glide(sc.gain.gain, a * 0.36 * s, now, s > 0 ? 0.02 : 0.06);
      glide(sc.src.playbackRate, (0.85 + 0.3 * s + 0.04 * Math.sin(now * 13)) * L.rate, now, 0.05);
    }
    const ni = this.layers.get('nitro');
    if (ni) {
      const on = L.nitro && a > 0;
      glide(ni.gain.gain, on ? 0.3 : 0, now, on ? 0.05 : 0.25);
      if (ni.filter) glide(ni.filter.frequency, on ? 6000 : 1500, now, on ? 0.1 : 0.3);
      glide(ni.src.playbackRate, (0.95 + 0.1 * clamp01(sn)) * L.rate, now, 0.1);
    }
  }

  /** Play a pre-rendered one-shot. */
  play(name: SfxName, o: PlayOpts = {}): void {
    const buf = this.bufs.get(name);
    if (!buf) return;
    if (this.active >= MAX_ONESHOTS && o.optional) return;
    const gain = o.gain ?? 1;
    if (!(gain > 1e-3)) return;
    const ctx = this.ctx;
    const t = ctx.currentTime + (o.delay ?? 0);
    const rate = clamp(o.rate ?? 1, 0.1, 4);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = rate;
    const g = ctx.createGain();
    g.gain.value = gain;
    src.connect(g);
    let last: AudioNode = g;
    let f: BiquadFilterNode | null = null, p: StereoPannerNode | null = null, s: GainNode | null = null;
    if (o.lp && o.lp < 16000) {
      f = ctx.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.value = Math.max(80, o.lp);
      last.connect(f);
      last = f;
    }
    if (o.pan || o.panTo) {
      p = ctx.createStereoPanner();
      const p0 = clamp(o.pan ?? 0, -1, 1);
      p.pan.value = p0;
      if (o.panTo !== undefined) {
        p.pan.setValueAtTime(p0, t);
        p.pan.linearRampToValueAtTime(clamp(o.panTo, -1, 1), t + buf.duration / rate);
      }
      last.connect(p);
      last = p;
    }
    last.connect(o.ui ? this.uiBus : this.sfxBus);
    if (o.verb) {
      s = ctx.createGain();
      s.gain.value = o.verb;
      last.connect(s).connect(this.verb);
    }
    src.start(t);
    this.active++;
    const done = () => {
      this.active--;
      src.disconnect();
      g.disconnect();
      f?.disconnect();
      p?.disconnect();
      s?.disconnect();
    };
    src.onended = done;
  }

  // -------------------------------------------------------------------------
  // Live synth: UI blips and race stingers

  private tone(t: number, freq: number, dur: number, o: ToneOpts = {}): void {
    const ctx = this.ctx;
    if (!(freq > 0 && freq < 20000)) return;
    const osc = ctx.createOscillator();
    osc.type = o.type ?? 'sine';
    osc.frequency.setValueAtTime(freq, t);
    if (o.glideTo) osc.frequency.exponentialRampToValueAtTime(Math.max(20, o.glideTo), t + dur);
    if (o.detune) osc.detune.value = o.detune;
    const g = ctx.createGain();
    const a = o.attack ?? 0.004;
    const peak = o.gain ?? 0.15;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(peak, t + a);
    g.gain.setTargetAtTime(0, t + a, o.decay ?? dur / 4);
    g.gain.setTargetAtTime(0, t + dur, 0.006);
    osc.connect(g);
    let last: AudioNode = g;
    let f: BiquadFilterNode | null = null, s: GainNode | null = null;
    if (o.lp) {
      f = ctx.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.value = o.lp;
      g.connect(f);
      last = f;
    }
    last.connect(this.uiBus);
    if (o.verb) {
      s = ctx.createGain();
      s.gain.value = o.verb;
      last.connect(s).connect(this.verb);
    }
    osc.start(t);
    osc.stop(t + dur + 0.05);
    cleanupOnEnd(osc, g, f, s);
  }

  /** Brass-ish chord: detuned saws through a swelling low-pass. */
  private brass(t: number, midis: number[], dur: number, gain: number, swell: number, verb = 0.3): void {
    const ctx = this.ctx;
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.Q.value = 1.2;
    f.frequency.setValueAtTime(700, t);
    f.frequency.setTargetAtTime(3400, t, swell * 0.5 + 0.01);
    f.frequency.setTargetAtTime(1500, t + swell + 0.05, dur * 0.4);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.setTargetAtTime(gain, t, Math.max(0.005, swell * 0.4));
    g.gain.setTargetAtTime(0, t + dur, 0.12);
    const s = ctx.createGain();
    s.gain.value = verb;
    f.connect(g);
    g.connect(this.uiBus);
    g.connect(s).connect(this.verb);
    const oscs: OscillatorNode[] = [];
    for (const m of midis) {
      for (const d of [-7, 7]) {
        const o = ctx.createOscillator();
        o.type = 'sawtooth';
        o.frequency.value = midiToHz(m);
        o.detune.value = d;
        o.connect(f);
        o.start(t);
        o.stop(t + dur + 0.6);
        oscs.push(o);
      }
    }
    oscs[0].onended = () => {
      for (const o of oscs) o.disconnect();
      f.disconnect();
      g.disconnect();
      s.disconnect();
    };
  }

  ui(name: UiName): void {
    const t = this.ctx.currentTime + 0.005;
    switch (name) {
      case 'move':
        this.tone(t, 1567.98, 0.07, { type: 'triangle', gain: 0.09, decay: 0.02 });
        this.tone(t, 3135.96, 0.05, { gain: 0.025, decay: 0.012 });
        break;
      case 'select':
        this.tone(t, 987.77, 0.08, { type: 'square', gain: 0.045, lp: 4000, decay: 0.03 });
        this.tone(t + 0.055, 1479.98, 0.18, { type: 'square', gain: 0.045, lp: 5000, decay: 0.06, verb: 0.2 });
        break;
      case 'back':
        this.tone(t, 1318.51, 0.07, { type: 'square', gain: 0.045, lp: 3500, decay: 0.03 });
        this.tone(t + 0.05, 880, 0.14, { type: 'square', gain: 0.045, lp: 3000, decay: 0.05 });
        break;
      case 'start': {
        const notes = [880, 1108.73, 1318.51, 1760];
        notes.forEach((f, i) => this.tone(t + i * 0.05, f, 0.14, { type: 'square', gain: 0.045, lp: 5200, decay: 0.05 }));
        this.tone(t + 0.2, 1760, 0.8, { gain: 0.07, decay: 0.22, verb: 0.35 });
        this.tone(t + 0.2, 2637.02, 0.6, { gain: 0.03, decay: 0.15, verb: 0.3 });
        this.brass(t + 0.2, [69, 73, 76, 81], 0.5, 0.05, 0.02, 0.35);
        break;
      }
      case 'error':
        for (const dt of [0, 0.13]) {
          this.tone(t + dt, 185, 0.11, { type: 'square', gain: 0.06, lp: 1200, decay: 0.06 });
          this.tone(t + dt, 196, 0.11, { type: 'square', gain: 0.06, lp: 1200, decay: 0.06 });
        }
        break;
    }
  }

  /** Musical race cues, tuned to `key` (MIDI tonic of the playing song). */
  stinger(kind: Stinger, key: number, arg = 0): void {
    const t = this.ctx.currentTime + 0.005;
    const k = ((key % 12) + 12) % 12 + 60; // tonic in octave 4
    const hz = (m: number) => midiToHz(m);
    switch (kind) {
      case 'beep':
        this.tone(t, 880, 0.3, { gain: 0.3, decay: 0.09, verb: 0.15 });
        this.tone(t, 1760, 0.2, { type: 'triangle', gain: 0.07, decay: 0.04 });
        break;
      case 'go':
        this.tone(t, 1760, 1.0, { gain: 0.3, decay: 0.28, verb: 0.25 });
        this.tone(t, 3520, 0.5, { type: 'triangle', gain: 0.05, decay: 0.1 });
        this.brass(t, [k, k + 4, k + 7, k + 12], 0.7, 0.07, 0.02, 0.35);
        break;
      case 'lap':
        this.tone(t, hz(k + 19), 0.4, { gain: 0.13, decay: 0.12 });
        this.tone(t + 0.09, hz(k + 24), 0.7, { gain: 0.13, decay: 0.22, verb: 0.3 });
        break;
      case 'finalLap':
        this.brass(t, [k + 7, k + 11, k + 14, k + 19], 0.13, 0.08, 0.01);
        this.brass(t + 0.17, [k, k + 4, k + 7, k + 12, k + 16], 1.4, 0.085, 0.12, 0.4);
        this.tone(t + 0.17, hz(k + 24), 1.2, { type: 'triangle', gain: 0.05, decay: 0.4, verb: 0.3 });
        break;
      case 'finish': {
        this.brass(t, [k - 12, k - 5, k, k + 4, k + 7, k + 14], 2.8, 0.09, 0.25, 0.45);
        const arp = [0, 4, 7, 12, 16, 19, 24, 28];
        arp.forEach((iv, i) => this.tone(t + 0.25 + i * 0.07, hz(k + 12 + iv), 0.35, { type: 'triangle', gain: 0.07, decay: 0.12, verb: 0.35 }));
        break;
      }
      case 'overtake':
        this.tone(t, hz(k + 19), 0.08, { type: 'square', gain: 0.05, lp: 5000, decay: 0.03 });
        this.tone(t + 0.06, hz(k + 24), 0.14, { type: 'square', gain: 0.05, lp: 6000, decay: 0.05, verb: 0.15 });
        break;
      case 'checkpoint':
        [0, 4, 7, 12].forEach((iv, i) => {
          this.tone(t + i * 0.045, hz(k + 12 + iv), 0.3, { gain: 0.1, decay: 0.1, verb: 0.2 });
          this.tone(t + i * 0.045, hz(k + 24 + iv), 0.2, { type: 'triangle', gain: 0.03, decay: 0.06 });
        });
        break;
      case 'wrongWay':
        for (const dt of [0, 0.25]) {
          this.tone(t + dt, 220, 0.18, { type: 'square', gain: 0.07, lp: 1400, decay: 0.12 });
          this.tone(t + dt, 233.08, 0.18, { type: 'square', gain: 0.07, lp: 1400, decay: 0.12 });
        }
        break;
      case 'record': {
        const arp = [0, 4, 7, 12, 16, 19, 24, 28];
        arp.forEach((iv, i) => this.tone(t + i * 0.06, hz(k + 12 + iv), 0.3, { type: 'triangle', gain: 0.09, decay: 0.1, verb: 0.35 }));
        this.brass(t + 0.5, [k, k + 4, k + 7, k + 12], 1.0, 0.06, 0.08, 0.4);
        break;
      }
      case 'combo': {
        const iv = PENTA[clamp(Math.round(arg), 0, PENTA.length - 1)];
        this.tone(t, hz(k + 12 + iv), 0.12, { type: 'square', gain: 0.05, lp: 4500, decay: 0.05, verb: 0.1 });
        break;
      }
    }
  }

  dispose(): void {
    try {
      this.curbOsc.stop();
    } catch {
      /* already stopped */
    }
    this.curbOsc.disconnect();
    this.curbLp.disconnect();
    this.curbGain.disconnect();
    const b = this.bed;
    if (b) {
      b.src.stop();
      for (const n of [b.src, b.windLp, b.wind, b.whistleBp, b.whistle, b.roadLp, b.road]) n.disconnect();
    }
    for (const l of this.layers.values()) {
      l.src.stop();
      l.src.disconnect();
      l.gain.disconnect();
      l.filter?.disconnect();
    }
  }
}
