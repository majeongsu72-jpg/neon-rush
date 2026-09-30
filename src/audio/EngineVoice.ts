import { clamp, clamp01, noise1, smoothstep } from '../core/math';
import { cleanupOnEnd, glide, softSquareWave, tanhCurve } from './dsp';
import { ENGINE_RPMS, type EngineBank } from './engineSynth';

// Runtime engine voice. Four looping sources are live at any time: the two
// grid loops bracketing the current rpm × {on, off}-throttle. Slot parity
// (even / odd grid index) means that when the rpm crosses a grid point the
// loop being replaced sits at zero weight, so swaps are inaudible.

const LOG_RPM = ENGINE_RPMS.map((r) => Math.log(r));
const HYST = 0.025; // log-rpm margin before re-bracketing (no churn around a grid point)
const HALF_PI = Math.PI / 2;

interface Slot {
  src: AudioBufferSourceNode | null;
  gain: GainNode | null;
  idx: number;
}

export interface VoiceInput {
  rpm: number;
  throttle: number; // 0..1 engine load
  rate: number; // extra playback factor (Doppler × slow-mo)
  gain: number; // linear output level
  pan: number; // −1..1
  lp: number; // low-pass cutoff (Hz)
}

export class EngineVoice {
  private readonly ctx: BaseAudioContext;
  /** Where the slot loops mix in (EQ for the player, the low-pass for AI voices). */
  private readonly input: AudioNode;
  private readonly lp: BiquadFilterNode;
  private readonly dip: GainNode | null = null;
  private readonly lim: GainNode | null = null;
  private readonly limDepth: GainNode | null = null;
  private readonly lfo: OscillatorNode | null = null;
  private readonly level: GainNode;
  private readonly panner: StereoPannerNode;
  private readonly chain: AudioNode[] = [];
  private readonly slots: Slot[] = [];
  private bank: EngineBank | null = null;
  private lower = 3;
  private cutUntil = 0;
  private blipUntil = 0;
  private live = false;
  private readonly seed: number;
  private static voices = 0;

  /** Player voices get the full chain (EQ, saturation, shift dip, rev limiter); AI voices stay lean. */
  constructor(ctx: BaseAudioContext, dest: AudioNode, player: boolean) {
    this.ctx = ctx;
    this.seed = 101 + 17 * EngineVoice.voices++;
    this.lp = ctx.createBiquadFilter();
    this.lp.type = 'lowpass';
    this.lp.Q.value = 0.5;
    this.lp.frequency.value = 8000;
    this.level = ctx.createGain();
    this.level.gain.value = 0;
    this.panner = ctx.createStereoPanner();
    this.chain.push(this.lp, this.level, this.panner);
    let node: AudioNode = this.lp;
    if (player) {
      // Chest-thump EQ before the low-pass.
      const eq = ctx.createBiquadFilter();
      eq.type = 'peaking';
      eq.frequency.value = 180;
      eq.Q.value = 0.9;
      eq.gain.value = 4;
      eq.connect(this.lp);
      this.input = eq;
      this.chain.push(eq);
      const sh = ctx.createWaveShaper();
      sh.curve = tanhCurve(1.5);
      sh.oversample = '2x';
      const dip = ctx.createGain();
      // Rev limiter: a ~17 Hz rounded-square LFO chops the level when depth > 0.
      const lim = ctx.createGain();
      const depth = ctx.createGain();
      depth.gain.value = 0;
      const lfo = ctx.createOscillator();
      lfo.setPeriodicWave(softSquareWave(ctx));
      lfo.frequency.value = 17;
      lfo.connect(depth).connect(lim.gain);
      lfo.start();
      node.connect(sh).connect(dip).connect(lim);
      node = lim;
      this.dip = dip;
      this.lim = lim;
      this.limDepth = depth;
      this.lfo = lfo;
      this.chain.push(sh, dip, lim, depth);
    } else this.input = this.lp;
    node.connect(this.level);
    this.level.connect(this.panner).connect(dest);
    for (let i = 0; i < 4; i++) this.slots.push({ src: null, gain: null, idx: -1 });
  }

  /** Switch sample bank; loops are restarted from the new bank on the next update. */
  setBank(bank: EngineBank | null): void {
    if (bank === this.bank) return;
    this.bank = bank;
    for (const s of this.slots) s.idx = -1;
  }

  update(v: VoiceInput, now: number): void {
    const bank = this.bank;
    if (!bank || !bank.ready) {
      if (this.live) this.stop(now);
      return;
    }
    this.live = true;
    // Tiny rpm flutter + a slow drift of the crossfade point: a steady rpm never
    // parks on one loop, so the loop period can't be heard as a pattern.
    const rpm = clamp(v.rpm, 200, 20000) * (1 + 0.003 * noise1(now * 6, this.seed));
    const lr = Math.log(rpm);
    let i = this.lower;
    const top = LOG_RPM.length - 2;
    while (i > 0 && lr < LOG_RPM[i] - HYST) i--;
    while (i < top && lr > LOG_RPM[i + 1] + HYST) i++;
    this.lower = i;
    const drift = 0.12 * noise1(now * 0.6, this.seed + 1);
    const x = clamp((lr - LOG_RPM[i]) / (LOG_RPM[i + 1] - LOG_RPM[i]) + drift, 0.04, 0.96);
    const wLo = Math.cos(x * HALF_PI), wHi = Math.sin(x * HALF_PI);
    // Load blend (equal power); shifts cut / blip the throttle briefly.
    let thr = clamp01(v.throttle);
    if (now < this.cutUntil) thr = Math.min(thr, 0.08);
    else if (now < this.blipUntil) thr = Math.max(thr, 0.85);
    const tl = Math.pow(thr, 0.7) * HALF_PI;
    const lOn = Math.sin(tl), lOff = Math.cos(tl);
    const rate = clamp(v.rate, 0.25, 4);
    for (let s = 0; s < 4; s++) {
      const onLoad = s < 2;
      const idx = (i & 1) === (s & 1) ? i : i + 1;
      const slot = this.slots[s];
      const buf = onLoad ? bank.on[idx] : bank.off[idx];
      if (!buf) continue;
      const pr = (rpm / bank.rpm[idx]) * rate;
      if (slot.idx !== idx || !slot.src || !slot.gain) this.swap(slot, buf, idx, pr, now);
      glide(slot.gain!.gain, (idx === i ? wLo : wHi) * (onLoad ? lOn : lOff), now, 0.025);
      glide(slot.src!.playbackRate, pr, now, 0.012);
    }
    glide(this.lp.frequency, clamp(v.lp, 200, 20000), now, 0.04);
    glide(this.level.gain, Math.max(0, v.gain), now, 0.035);
    glide(this.panner.pan, clamp(v.pan, -1, 1), now, 0.05);
  }

  private swap(slot: Slot, buf: AudioBuffer, idx: number, rate: number, now: number): void {
    this.retire(slot, now, now + 0.09);
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    src.playbackRate.value = clamp(rate, 0.05, 8);
    const g = ctx.createGain();
    g.gain.value = 0;
    src.connect(g).connect(this.input);
    src.start(now, Math.random() * buf.duration * 0.99); // random phase: voices never lock
    slot.src = src;
    slot.gain = g;
    slot.idx = idx;
  }

  private retire(slot: Slot, now: number, stopAt: number): void {
    const src = slot.src, g = slot.gain;
    slot.src = null;
    slot.gain = null;
    slot.idx = -1;
    if (!src || !g) return;
    glide(g.gain, 0, now, 0.012);
    src.stop(stopAt);
    cleanupOnEnd(src, g);
  }

  /** Gear change: ignition cut (upshift) or throttle blip (downshift), plus a level dip on the player. */
  shift(up: boolean, now: number): void {
    if (this.dip) {
      const g = this.dip.gain;
      g.cancelScheduledValues(now);
      glide(g, up ? 0.5 : 0.72, now, 0.008);
      glide(g, 1, now + (up ? 0.07 : 0.045), 0.03);
    }
    if (up) this.cutUntil = now + 0.085;
    else this.blipUntil = now + 0.1;
  }

  /** Rev-limiter bounce depth (0 = off). */
  setLimiter(depth: number, now: number): void {
    if (!this.lim || !this.limDepth) return;
    const d = clamp(depth, 0, 0.45);
    glide(this.limDepth.gain, d, now, 0.02);
    glide(this.lim.gain, 1 - d, now, 0.02);
  }

  /** Fade out and release every loop (voice idle). Cheap to call repeatedly. */
  stop(now: number): void {
    if (!this.live) {
      let any = false;
      for (const s of this.slots) if (s.src) any = true;
      if (!any) return;
    }
    this.live = false;
    glide(this.level.gain, 0, now, 0.04);
    for (const s of this.slots) this.retire(s, now + 0.15, now + 0.35);
  }

  dispose(): void {
    const now = this.ctx.currentTime;
    for (const s of this.slots) this.retire(s, now, now);
    if (this.lfo) {
      this.lfo.stop();
      this.lfo.disconnect();
    }
    for (const n of this.chain) n.disconnect();
  }
}

// ---------------------------------------------------------------------------

export interface DrivetrainInput {
  active: boolean;
  rpm: number;
  rpmNorm: number;
  throttle: number;
  speed: number; // m/s
  turbo: number; // 0..1 (spec)
  airborne: boolean;
  rate: number; // slow-mo pitch factor
}

/** Player-only mechanical layers: straight-cut gear whine and turbo whistle / hiss. */
export class Drivetrain {
  spool = 0;
  private readonly whine: OscillatorNode;
  private readonly whineBp: BiquadFilterNode;
  private readonly whineGain: GainNode;
  private readonly whistle: OscillatorNode;
  private readonly whistleGain: GainNode;
  private readonly hiss: AudioBufferSourceNode;
  private readonly hissBp: BiquadFilterNode;
  private readonly hissGain: GainNode;

  constructor(ctx: BaseAudioContext, dest: AudioNode, noise: AudioBuffer) {
    this.whine = ctx.createOscillator();
    this.whine.type = 'triangle';
    this.whineBp = ctx.createBiquadFilter();
    this.whineBp.type = 'bandpass';
    this.whineBp.Q.value = 2.5;
    this.whineGain = ctx.createGain();
    this.whineGain.gain.value = 0;
    this.whine.connect(this.whineBp).connect(this.whineGain).connect(dest);
    this.whistle = ctx.createOscillator();
    this.whistle.type = 'sine';
    this.whistleGain = ctx.createGain();
    this.whistleGain.gain.value = 0;
    this.whistle.connect(this.whistleGain).connect(dest);
    this.hiss = ctx.createBufferSource();
    this.hiss.buffer = noise;
    this.hiss.loop = true;
    this.hiss.playbackRate.value = 1.07; // decorrelate from the wind bed
    this.hissBp = ctx.createBiquadFilter();
    this.hissBp.type = 'bandpass';
    this.hissBp.frequency.value = 5200;
    this.hissBp.Q.value = 1.4;
    this.hissGain = ctx.createGain();
    this.hissGain.gain.value = 0;
    this.hiss.connect(this.hissBp).connect(this.hissGain).connect(dest);
    const t = ctx.currentTime;
    this.whine.start(t);
    this.whistle.start(t);
    this.hiss.start(t, 0.37);
  }

  update(d: DrivetrainInput, now: number, dt: number): void {
    // Turbo spools up with lag and dumps quickly.
    const target = d.active && d.turbo > 0.01 ? clamp01((d.rpmNorm - 0.3) / 0.55) * Math.pow(clamp01(d.throttle), 1.2) : 0;
    this.spool += (target - this.spool) * (1 - Math.exp(-(target > this.spool ? 2.4 : 7) * dt));
    const sp = this.spool;
    glide(this.whistle.frequency, clamp((1800 + 5200 * sp) * d.rate, 200, 12000), now, 0.03);
    glide(this.whistleGain.gain, d.active ? 0.05 * d.turbo * sp * sp : 0, now, 0.04);
    glide(this.hissGain.gain, d.active ? 0.07 * d.turbo * Math.pow(sp, 1.5) * (0.4 + 0.6 * d.throttle) : 0, now, 0.05);
    // Gear whine follows the input shaft (∝ rpm), grows with road speed.
    const wf = clamp((d.rpm / 60) * 7.2 * d.rate, 60, 6000);
    glide(this.whine.frequency, wf, now, 0.015);
    glide(this.whineBp.frequency, wf, now, 0.015);
    const lvl = d.active ? 0.03 * smoothstep(6, 50, d.speed) * (0.35 + 0.65 * d.throttle) * (d.airborne ? 0.6 : 1) : 0;
    glide(this.whineGain.gain, lvl, now, 0.03);
  }

  dispose(): void {
    for (const s of [this.whine, this.whistle, this.hiss]) {
      try {
        s.stop();
      } catch {
        /* already stopped */
      }
      s.disconnect();
    }
    for (const n of [this.whineBp, this.whineGain, this.whistleGain, this.hissBp, this.hissGain]) n.disconnect();
  }
}
