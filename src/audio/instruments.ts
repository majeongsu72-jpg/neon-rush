import { clamp } from '../core/math';
import { cleanupOnEnd, glide, midiToHz, setAt } from './dsp';
import type { MonoPatch, PadPatch, StabPatch } from './songs';

// Persistent synth voices for the sequencer. Oscillators run continuously and
// notes are pure AudioParam automation (setTarget chains start from the
// current value, so retriggers and slides never click).

/** Monophonic subtractive voice (bass / lead / arp): 2 oscillators (+ sub) → LP → VCA. */
export class MonoSynth {
  readonly out: GainNode;
  private readonly p: MonoPatch;
  private readonly o1: OscillatorNode;
  private readonly o2: OscillatorNode;
  private readonly sub: OscillatorNode | null = null;
  private readonly filter: BiquadFilterNode;
  private readonly vca: GainNode;
  private readonly vibDepth: GainNode | null = null;
  private readonly oscs: OscillatorNode[] = [];
  private readonly nodes: AudioNode[] = [];
  private octave = 0;

  constructor(ctx: BaseAudioContext, p: MonoPatch) {
    this.p = p;
    const t = ctx.currentTime;
    this.o1 = ctx.createOscillator();
    this.o1.type = p.wave;
    this.o1.detune.value = -p.detune / 2;
    this.o2 = ctx.createOscillator();
    this.o2.type = p.wave2;
    this.o2.detune.value = p.detune / 2 + 1200 * p.oct2;
    const g2 = ctx.createGain();
    g2.gain.value = p.mix2;
    this.filter = ctx.createBiquadFilter();
    this.filter.type = 'lowpass';
    this.filter.Q.value = p.q;
    this.filter.frequency.value = p.cutoff;
    this.vca = ctx.createGain();
    this.vca.gain.value = 0;
    this.out = this.vca;
    this.o1.connect(this.filter);
    this.o2.connect(g2).connect(this.filter);
    this.filter.connect(this.vca);
    this.oscs.push(this.o1, this.o2);
    this.nodes.push(g2, this.filter, this.vca);
    if (p.sub > 0) {
      const sub = ctx.createOscillator();
      sub.type = 'sine';
      const sg = ctx.createGain();
      sg.gain.value = p.sub;
      sub.connect(sg).connect(this.vca); // weight bypasses the filter
      this.sub = sub;
      this.oscs.push(sub);
      this.nodes.push(sg);
    }
    if (p.vibrato > 0) {
      const lfo = ctx.createOscillator();
      lfo.frequency.value = 5.6;
      const depth = ctx.createGain();
      depth.gain.value = 0;
      lfo.connect(depth);
      depth.connect(this.o1.detune);
      depth.connect(this.o2.detune);
      this.vibDepth = depth;
      this.oscs.push(lfo);
      this.nodes.push(depth);
    }
    for (const o of this.oscs) o.start(t);
  }

  /**
   * Play a note at `t`. `gate` = seconds until release (0 → held until the next note).
   * Modes: 'retrig' — full envelopes; 'legato' — quick glide from the previous
   * note with a softer filter re-attack (lead lines); 'slide' — 303-style glide,
   * no envelope retrigger.
   */
  noteOn(t: number, midi: number, gate: number, vel: number, mode: 'retrig' | 'legato' | 'slide', cutMul = 1): void {
    const p = this.p;
    const f = midiToHz(midi + p.transpose);
    if (!Number.isFinite(f) || f <= 0 || f > 20000) return;
    const oscFreqs = [this.o1.frequency, this.o2.frequency];
    if (this.sub) oscFreqs.push(this.sub.frequency);
    const glideTc = mode === 'slide' ? p.glide : Math.min(p.glide, 0.016);
    for (const fp of oscFreqs) {
      if (mode === 'retrig') setAt(fp, f, t);
      else glide(fp, f, t, glideTc);
    }
    // Filter envelope (slides keep decaying, like a 303).
    const base = clamp(p.cutoff * cutMul, 30, 16000);
    const fq = this.filter.frequency;
    fq.cancelScheduledValues(t);
    if (mode !== 'slide') {
      const depth = mode === 'legato' ? 0.55 : 1;
      glide(fq, clamp(base * (1 + p.env * vel * depth), 30, 18000), t, mode === 'legato' ? 0.006 : 0.0015);
    }
    glide(fq, base, t + 0.004, p.decay);
    // Amp envelope.
    const g = this.vca.gain;
    g.cancelScheduledValues(t);
    const lvl = p.level * (0.6 + 0.4 * vel);
    if (mode === 'retrig') {
      glide(g, lvl, t, p.attack);
      glide(g, lvl * p.sustain, t + p.attack * 3 + 0.005, p.ampDecay);
    } else if (mode === 'legato') {
      glide(g, lvl * 0.92, t, 0.012);
      glide(g, lvl * p.sustain, t + 0.03, p.ampDecay);
    } else glide(g, lvl * Math.max(p.sustain, 0.45), t, 0.01);
    if (gate > 0) glide(g, 0, t + gate, p.release);
    // Delayed vibrato on fresh notes.
    if (this.vibDepth && mode === 'retrig') {
      const d = this.vibDepth.gain;
      d.cancelScheduledValues(t);
      glide(d, 0, t, 0.01);
      glide(d, p.vibrato, t + 0.18, 0.12);
    }
  }

  /** Double oscillator 2 an octave up (high-intensity layer). */
  setOctave(up: boolean, t: number): void {
    const o = up ? 1 : 0;
    if (o === this.octave) return;
    this.octave = o;
    setAt(this.o2.detune, this.p.detune / 2 + 1200 * (this.p.oct2 + o), t);
  }

  release(t: number): void {
    const g = this.vca.gain;
    g.cancelScheduledValues(t);
    glide(g, 0, t, 0.05);
  }

  dispose(): void {
    for (const o of this.oscs) {
      try {
        o.stop();
      } catch {
        /* already stopped */
      }
      o.disconnect();
    }
    for (const n of this.nodes) n.disconnect();
  }
}

/** Four-voice pad: two detuned oscillators per voice spread L/R → LP → VCA. */
export class PadSynth {
  readonly out: GainNode;
  private readonly p: PadPatch;
  private readonly a: OscillatorNode[] = [];
  private readonly b: OscillatorNode[] = [];
  private readonly nodes: AudioNode[] = [];
  private readonly filter: BiquadFilterNode;
  private readonly vca: GainNode;
  private on = false;
  private fresh = true;
  private last = '';

  constructor(ctx: BaseAudioContext, p: PadPatch) {
    this.p = p;
    const merger = ctx.createChannelMerger(2);
    this.filter = ctx.createBiquadFilter();
    this.filter.type = 'lowpass';
    this.filter.frequency.value = p.cutoff;
    this.filter.Q.value = p.q;
    this.vca = ctx.createGain();
    this.vca.gain.value = 0;
    this.out = this.vca;
    merger.connect(this.filter).connect(this.vca);
    const t = ctx.currentTime;
    const spread = [-3, 2, -1, 3];
    for (let v = 0; v < 4; v++) {
      const oa = ctx.createOscillator(), ob = ctx.createOscillator();
      oa.type = ob.type = p.wave;
      oa.detune.value = -p.detune + spread[v];
      ob.detune.value = p.detune - spread[v];
      oa.connect(merger, 0, 0);
      ob.connect(merger, 0, 1);
      oa.start(t);
      ob.start(t);
      this.a.push(oa);
      this.b.push(ob);
    }
    this.nodes.push(merger, this.filter, this.vca);
  }

  /** Move to a voicing at `t` (short glide + gentle re-articulation when it changes). */
  chord(t: number, midis: number[], barDur: number): void {
    const key = midis.join(',');
    const changed = key !== this.last;
    this.last = key;
    if (changed) {
      for (let v = 0; v < 4; v++) {
        const f = midiToHz(midis[v % midis.length]);
        if (this.fresh) {
          setAt(this.a[v].frequency, f, t);
          setAt(this.b[v].frequency, f, t);
        } else {
          glide(this.a[v].frequency, f, t, 0.035);
          glide(this.b[v].frequency, f, t, 0.035);
        }
      }
    }
    this.fresh = false;
    const lvl = this.p.level;
    if (this.on && changed) {
      const g = this.vca.gain;
      g.cancelScheduledValues(t);
      glide(g, lvl * 0.78, t, 0.03);
      glide(g, lvl, t + 0.08, 0.35);
    }
    // Filter "breathes" open across the bar.
    const fq = this.filter.frequency;
    fq.cancelScheduledValues(t);
    glide(fq, this.p.cutoff * 0.75, t, 0.05);
    glide(fq, this.p.cutoff * 1.3, t + 0.1, barDur * 0.45);
  }

  gate(t: number, on: boolean): void {
    if (on === this.on) return;
    this.on = on;
    const g = this.vca.gain;
    g.cancelScheduledValues(t);
    glide(g, on ? this.p.level : 0, t, on ? this.p.attack : this.p.release);
  }

  dispose(): void {
    for (const o of [...this.a, ...this.b]) {
      try {
        o.stop();
      } catch {
        /* already stopped */
      }
      o.disconnect();
    }
    for (const n of this.nodes) n.disconnect();
  }
}

/** Short polyphonic chord stabs: per-hit oscillators into a shared filter / VCA. */
export class StabSynth {
  readonly out: GainNode;
  private readonly ctx: BaseAudioContext;
  private readonly p: StabPatch;
  private readonly filter: BiquadFilterNode;
  private readonly vca: GainNode;

  constructor(ctx: BaseAudioContext, p: StabPatch) {
    this.ctx = ctx;
    this.p = p;
    this.filter = ctx.createBiquadFilter();
    this.filter.type = 'lowpass';
    this.filter.Q.value = p.q;
    this.filter.frequency.value = p.cutoff;
    this.vca = ctx.createGain();
    this.vca.gain.value = 0;
    this.out = this.vca;
    this.filter.connect(this.vca);
  }

  hit(t: number, midis: number[], dur: number, vel: number): void {
    const p = this.p;
    if (p.level <= 0) return;
    midis.forEach((m, i) => {
      const o = this.ctx.createOscillator();
      o.type = p.wave;
      o.frequency.value = midiToHz(m);
      o.detune.value = (i % 2 ? 1 : -1) * p.detune * 0.5;
      o.connect(this.filter);
      o.start(t);
      o.stop(t + dur + 0.3);
      cleanupOnEnd(o);
    });
    const fq = this.filter.frequency;
    fq.cancelScheduledValues(t);
    glide(fq, clamp(p.cutoff * (1 + p.env * vel), 60, 18000), t, 0.001);
    glide(fq, p.cutoff, t + 0.003, p.decay);
    const g = this.vca.gain;
    g.cancelScheduledValues(t);
    glide(g, p.level * vel, t, 0.002);
    glide(g, 0, t + dur, 0.05);
  }

  dispose(): void {
    this.filter.disconnect();
    this.vca.disconnect();
  }
}

/** Stereo ping-pong delay with a damped feedback path. */
export class PingPong {
  readonly input: GainNode;
  readonly out: GainNode;
  private readonly dl: DelayNode;
  private readonly dr: DelayNode;
  private readonly nodes: AudioNode[];

  constructor(ctx: BaseAudioContext, time: number, feedback: number) {
    this.input = ctx.createGain();
    this.out = ctx.createGain();
    this.dl = ctx.createDelay(2);
    this.dr = ctx.createDelay(2);
    const tt = clamp(time, 0.01, 1.9);
    this.dl.delayTime.value = tt;
    this.dr.delayTime.value = tt;
    const fb = ctx.createGain();
    fb.gain.value = clamp(feedback, 0, 0.85);
    const tone = ctx.createBiquadFilter();
    tone.type = 'lowpass';
    tone.frequency.value = 3200;
    tone.Q.value = 0.5;
    const merger = ctx.createChannelMerger(2);
    this.input.connect(this.dl);
    this.dl.connect(merger, 0, 0);
    this.dl.connect(this.dr);
    this.dr.connect(merger, 0, 1);
    this.dr.connect(fb).connect(tone).connect(this.dl);
    merger.connect(this.out);
    this.nodes = [this.input, this.out, this.dl, this.dr, fb, tone, merger];
  }

  dispose(): void {
    for (const n of this.nodes) n.disconnect();
  }
}
