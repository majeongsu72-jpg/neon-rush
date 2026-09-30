import { clamp, clamp01 } from '../core/math';
import { cleanupOnEnd, expRampAt, glide, rampAt, setAt, type JobQueue } from './dsp';
import { kitJobs, sharedFxJobs, type DrumName } from './drums';
import { MonoSynth, PadSynth, PingPong, StabSynth } from './instruments';
import { SONGS, type DrumSet, type SectionDef, type SongDef, type SongId } from './songs';
import { HOLD, REST, arpLadder, bassInterval, noteSteps, parseChord, parseMelody, placeAbove, voiceChord, type Chord } from './theory';

// Lookahead step sequencer (setInterval-driven, scheduled on the audio clock)
// playing the arrangements in songs.ts through persistent synth voices,
// pre-rendered drums, sidechain pumping and a shared reverb send.

const LOOKAHEAD = 0.12; // s scheduled ahead of ctx.currentTime
const STALL = 0.05; // behind by more than this → skip to the grid instead of a backlog
const LANES = ['kick', 'snare', 'clap', 'hat', 'ohat', 'perc'] as const;
const KIT_SIZE = 7; // song-specific drum buffers (see kitJobs)

export interface BeatInfo {
  phase: number;
  kick: number;
  bar: number;
}

interface Section extends SectionDef {
  start: number; // first bar
  chordList: Chord[];
}

interface Pos {
  sec: Section;
  index: number;
  bar: number; // bar inside the section
}

/** Shared state a song player needs from the manager. */
interface MusicHost {
  readonly ctx: BaseAudioContext;
  readonly mixIn: AudioNode;
  readonly wetIn: AudioNode;
  readonly shared: Map<DrumName, AudioBuffer>;
  readonly intensity: number;
}

/** One running arrangement with its own instruments (two exist while crossfading). */
class SongPlayer {
  readonly song: SongDef;
  readonly kit: Map<DrumName, AudioBuffer>;
  private readonly host: MusicHost;
  private readonly ctx: BaseAudioContext;
  private readonly fade: GainNode;
  private readonly wet: GainNode;
  private readonly sweep: BiquadFilterNode;
  private readonly drumBus: GainNode;
  private readonly bassDuck: GainNode;
  private readonly synthDuck: GainNode;
  private readonly bass: MonoSynth;
  private readonly lead: MonoSynth;
  private readonly arp: MonoSynth;
  private readonly pad: PadSynth;
  private readonly stab: StabSynth | null;
  private readonly delay: PingPong;
  private readonly extra: AudioNode[] = [];
  private readonly sections: Section[] = [];
  private readonly leads = new Map<string, number[]>();
  private readonly totalBars: number;
  private readonly loopBar: number;
  readonly stepDur: number;
  readonly beatDur: number;
  private readonly sweepMax: number;

  started = false;
  t0 = 0;
  private step = 0;
  endAt = Infinity;
  private fadeIn = 1;
  private I = 0.7; // intensity latched per bar
  private voicing: number[] | null = null;
  private ladder: number[] = [];
  private bassHeld = false;
  private leadHeldUntil = -1;
  private readonly kicks = new Float64Array(8).fill(-1);
  private kickN = 0;

  constructor(host: MusicHost, song: SongDef, kit: Map<DrumName, AudioBuffer>, fadeIn: number) {
    this.host = host;
    this.song = song;
    this.kit = kit;
    this.fadeIn = fadeIn;
    const ctx = (this.ctx = host.ctx);
    this.beatDur = 60 / song.bpm;
    this.stepDur = this.beatDur / 4;
    this.sweepMax = Math.min(20000, ctx.sampleRate * 0.45);

    // Buses: instruments → section sweep LP → crossfade gain → music mix.
    this.sweep = ctx.createBiquadFilter();
    this.sweep.type = 'lowpass';
    this.sweep.frequency.value = this.sweepMax;
    this.sweep.Q.value = 0.9;
    this.fade = ctx.createGain();
    this.fade.gain.value = 0;
    this.sweep.connect(this.fade).connect(host.mixIn);
    this.wet = ctx.createGain(); // reverb send follows the crossfade
    this.wet.gain.value = 0;
    this.wet.connect(host.wetIn);
    this.drumBus = ctx.createGain();
    this.drumBus.gain.value = song.mix.drums;
    this.drumBus.connect(this.sweep);
    this.bassDuck = ctx.createGain();
    this.bassDuck.connect(this.sweep);
    this.synthDuck = ctx.createGain();
    this.synthDuck.connect(this.sweep);

    this.bass = new MonoSynth(ctx, song.bassPatch);
    this.bass.out.connect(this.bassDuck);
    this.lead = new MonoSynth(ctx, song.leadPatch);
    this.arp = new MonoSynth(ctx, song.arpPatch);
    this.pad = new PadSynth(ctx, song.padPatch);
    this.delay = new PingPong(ctx, this.beatDur * song.delayBeats, song.delayFb);
    this.lead.out.connect(this.sweep);
    this.arp.out.connect(this.synthDuck);
    this.pad.out.connect(this.synthDuck);
    this.delay.out.connect(this.synthDuck);
    const send = (from: AudioNode, to: AudioNode, g: number) => {
      const s = ctx.createGain();
      s.gain.value = g;
      from.connect(s).connect(to);
      this.extra.push(s);
    };
    send(this.lead.out, this.delay.input, song.mix.leadDelay);
    send(this.arp.out, this.delay.input, song.mix.arpDelay);
    send(this.lead.out, this.wet, song.mix.leadVerb);
    send(this.pad.out, this.wet, song.mix.padVerb);
    // Stabs only exist in songs that use them.
    this.stab = song.stabPatch.level > 0 && Object.keys(song.stabs).length ? new StabSynth(ctx, song.stabPatch) : null;
    if (this.stab) {
      this.stab.out.connect(this.synthDuck);
      send(this.stab.out, this.wet, 0.25);
    }
    this.extra.push(this.sweep, this.fade, this.wet, this.drumBus, this.bassDuck, this.synthDuck);

    // Parse the arrangement once.
    let bar = 0;
    for (const s of song.sections) {
      const chordList = s.chords.map((c) => parseChord(c) ?? { root: 0, tones: [0, 4, 7] });
      this.sections.push({ ...s, start: bar, chordList });
      bar += s.bars;
    }
    this.totalBars = Math.max(1, bar);
    this.loopBar = this.sections[clamp(song.loopTo, 0, this.sections.length - 1)].start;
    for (const [k, m] of Object.entries(song.leads)) {
      try {
        this.leads.set(k, parseMelody(m));
      } catch (err) {
        console.warn(`[audio] bad melody ${song.id}/${k}`, err);
      }
    }
  }

  get ready(): boolean {
    return this.kit.size >= KIT_SIZE;
  }

  start(t: number): void {
    this.started = true;
    this.t0 = t;
    this.step = 0;
    const g = this.fade.gain;
    setAt(g, 0, t);
    glide(g, 1, t, Math.max(0.01, this.fadeIn / 3));
    setAt(this.wet.gain, 0, t);
    glide(this.wet.gain, 1, t, Math.max(0.01, this.fadeIn / 3));
  }

  /** Fade out and retire after `dur` seconds. */
  fadeOut(now: number, dur: number): void {
    const d = Math.max(0.02, dur);
    for (const g of [this.fade.gain, this.wet.gain]) {
      g.cancelScheduledValues(now);
      glide(g, 0, now, d / 4);
    }
    this.endAt = now + d + 0.3;
  }

  /** Cancel a pending fade-out (the same song was requested again). */
  revive(now: number, dur: number): void {
    this.endAt = Infinity;
    for (const g of [this.fade.gain, this.wet.gain]) {
      g.cancelScheduledValues(now);
      glide(g, 1, now, Math.max(0.01, dur / 3));
    }
  }

  private stepTime(i: number): number {
    return this.t0 + i * this.stepDur + (i & 1 ? this.song.swing * this.stepDur : 0);
  }

  schedule(now: number, until: number): void {
    if (!this.started) return;
    let t = this.stepTime(this.step);
    if (t < now - STALL) {
      // Main thread stalled: jump to the next grid step, never fire a backlog.
      this.step = Math.max(this.step, Math.ceil((now - this.t0) / this.stepDur));
      t = this.stepTime(this.step);
    }
    while (t < until && t < this.endAt) {
      this.scheduleStep(this.step, t);
      this.step++;
      t = this.stepTime(this.step);
    }
  }

  private locate(bar: number): Pos {
    let b = bar;
    if (b >= this.totalBars) b = this.loopBar + ((b - this.loopBar) % Math.max(1, this.totalBars - this.loopBar));
    for (let i = this.sections.length - 1; i >= 0; i--) {
      const s = this.sections[i];
      if (b >= s.start) return { sec: s, index: i, bar: b - s.start };
    }
    return { sec: this.sections[0], index: 0, bar: 0 };
  }

  private scheduleStep(i: number, t: number): void {
    const step = i & 15;
    const pos = this.locate(i >> 4);
    const sec = pos.sec;
    const chord = sec.chordList[pos.bar % sec.chordList.length];
    if (step === 0) this.onBar(pos, chord, t);
    const I = this.I;

    // Drums (the fill set replaces the groove on the section's last bar).
    const setName = pos.bar === sec.bars - 1 && sec.fill ? sec.fill : sec.drums;
    const set = setName ? this.song.drums[setName] : undefined;
    if (set) this.drums(set, pos.bar, step, t, I);

    if (sec.bass) this.bassStep(sec.bass, pos.bar, step, t, chord);
    if (sec.arp) this.arpStep(sec.arp, pos.bar, step, t);
    if (sec.stab) this.stabStep(sec.stab, pos.bar, step, t, chord);
    if (sec.lead && I >= this.song.mix.leadMin) this.leadStep(sec, pos.bar, step, t);
  }

  private onBar(pos: Pos, chord: Chord, t: number): void {
    const sec = pos.sec;
    const barDur = this.beatDur * 4;
    this.I = this.host.intensity;
    if (pos.bar === 0) {
      // Section downbeat: FX and the section's filter sweep.
      if (sec.crash) this.hit('crash', t, this.song.kit.crash.level);
      if (sec.impact) this.hit('impact', t, 0.55);
      const f = this.sweep.frequency;
      f.cancelScheduledValues(t);
      if (sec.sweep) {
        setAt(f, clamp(sec.sweep[0], 40, this.sweepMax), t);
        expRampAt(f, clamp(sec.sweep[1], 40, this.sweepMax), t + sec.bars * barDur);
      } else glide(f, this.sweepMax, t, 0.05);
    }
    if (sec.riser && pos.bar === sec.bars - 2) this.hit('riser', t, 0.3);
    this.ladder = arpLadder(chord, this.song.arpBase);
    if (sec.pad) {
      this.voicing = voiceChord(chord, this.song.padRange[0], this.song.padRange[1], this.voicing);
      this.pad.chord(t, this.voicing, barDur);
      this.pad.gate(t, true);
    } else this.pad.gate(t, false);
    this.lead.setOctave(this.I >= 0.9, t);
  }

  private drums(set: DrumSet, bar: number, step: number, t: number, I: number): void {
    const kit = this.song.kit;
    for (const lane of LANES) {
      const s = set[lane];
      if (!s) continue;
      const c = s.charAt((bar * 16 + step) % s.length);
      if (c === '.') {
        // Top intensity: extra ghost hats between the written ones.
        if (lane === 'hat' && I >= 0.9 && step & 1) this.hit('hat', t, kit.hat.level * 0.3, 1.04);
        continue;
      }
      if (I < 0.4 && (lane === 'ohat' || lane === 'perc' || (lane === 'hat' && (c === 'g' || step & 1)))) continue;
      const vel = c === 'x' ? 1 : c === 'o' ? 0.72 : 0.42;
      switch (lane) {
        case 'kick':
          this.hit('kick', t, kit.kick.level * vel);
          this.kicks[this.kickN++ & 7] = t;
          this.duck(t);
          break;
        case 'snare':
          this.hit('snare', t, kit.snare.level * vel);
          break;
        case 'clap':
          this.hit('clap', t, kit.clap.level * vel);
          break;
        case 'hat':
          this.hit('hat', t, kit.hat.level * vel, 0.98 + 0.04 * ((step * 7) % 5) / 4);
          break;
        case 'ohat':
          this.hit('ohat', t, kit.ohat.level * vel);
          break;
        case 'perc':
          this.hit('perc', t, kit.perc.level * vel);
          break;
      }
    }
  }

  /** Sidechain pump on every kick. */
  private duck(t: number): void {
    const m = this.song.mix;
    const rel = this.beatDur * 0.2;
    const b = this.bassDuck.gain, s = this.synthDuck.gain;
    b.cancelScheduledValues(t);
    glide(b, 1 - m.duck, t, 0.003);
    glide(b, 1, t + 0.03, rel);
    s.cancelScheduledValues(t);
    glide(s, 1 - m.synthDuck, t, 0.004);
    glide(s, 1, t + 0.03, rel);
  }

  private bassStep(name: string, bar: number, step: number, t: number, chord: Chord): void {
    const line = this.song.bass[name];
    if (!line) return;
    const notes = line.notes;
    const n = notes.length;
    const idx = (bar * 16 + step) % n;
    const c = notes.charAt(idx);
    if (c === '.' || c === '-') return;
    const key = this.song.key % 12;
    const ch: Chord = line.pedal ? { root: key, tones: [0, 3, 7, 10] } : chord;
    const iv = bassInterval(c, ch);
    if (!Number.isFinite(iv)) return;
    let len = 1;
    while (len < n && notes.charAt((idx + len) % n) === '-') len++;
    const nextIdx = (idx + len) % n;
    const nextC = notes.charAt(nextIdx);
    const slides = line.slide;
    const slideNext = !!slides && slides.charAt(nextIdx % slides.length) === 's' && nextC !== '.' && nextC !== '-';
    const slideIn = !!slides && slides.charAt(idx % slides.length) === 's' && this.bassHeld;
    const accent = !!line.accent && line.accent.charAt(idx % line.accent.length) === 'x';
    let cut = 1;
    const sw = this.song.bassPatch.sweep;
    if (sw) {
      const bars = ((this.step >> 4) + step / 16) / sw.bars;
      cut = Math.pow(2, sw.depth * Math.sin(bars * Math.PI * 2 - Math.PI / 2));
    }
    const gate = slideNext ? 0 : Math.max(0.03, len * this.stepDur - 0.012);
    this.bass.noteOn(t, placeAbove(ch.root, this.song.bassLo) + iv, gate, accent ? 1 : 0.7, slideIn ? 'slide' : 'retrig', accent ? cut * 1.3 : cut);
    this.bassHeld = slideNext;
  }

  private arpStep(name: string, bar: number, step: number, t: number): void {
    const pat = this.song.arps[name];
    if (!pat) return;
    const n = pat.length;
    const idx = (bar * 16 + step) % n;
    const code = pat.charCodeAt(idx) - 48;
    if (code < 0 || code > 9 || !this.ladder.length) return;
    let len = 1;
    while (len < n && pat.charAt((idx + len) % n) === '-') len++;
    const midi = this.ladder[Math.min(this.ladder.length - 1, code)];
    this.arp.noteOn(t, midi, len * this.stepDur * 0.9, step % 4 === 0 ? 1 : 0.75, 'retrig');
  }

  private stabStep(name: string, bar: number, step: number, t: number, chord: Chord): void {
    const pat = this.song.stabs[name];
    if (!pat || !this.stab) return;
    const c = pat.charAt((bar * 16 + step) % pat.length);
    if (c !== 'x' && c !== 'o') return;
    const root = placeAbove(chord.root, this.song.stabBase);
    const tones = chord.tones.slice(0, 3).map((x) => root + x);
    this.stab.hit(t, tones, this.stepDur * 0.9, c === 'x' ? 1 : 0.7);
  }

  private leadStep(sec: Section, bar: number, step: number, t: number): void {
    const mel = this.leads.get(sec.lead ?? '');
    if (!mel || !mel.length) return;
    const n = mel.length;
    const idx = (bar * 16 + step) % n;
    const v = mel[idx];
    if (v === HOLD || v === REST) return;
    const len = noteSteps(mel, idx);
    const legatoOut = mel[(idx + len) % n] >= 0; // next note follows without a rest
    const legatoIn = this.leadHeldUntil >= t - 0.002;
    const dur = len * this.stepDur;
    // Phrase starts (and notes after a rest) re-attack; connected notes play legato.
    const mode = legatoIn && step % 8 !== 0 ? 'legato' : 'retrig';
    this.lead.noteOn(t, v + 12 * (sec.leadOct ?? 0), legatoOut ? dur : dur * 0.92, step % 4 === 0 ? 0.9 : 0.8, mode);
    this.leadHeldUntil = legatoOut ? t + dur : -1;
  }

  private hit(name: DrumName, t: number, gain: number, rate = 1): void {
    const buf = this.kit.get(name) ?? this.host.shared.get(name);
    if (!buf || gain <= 0) return;
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    if (rate !== 1) src.playbackRate.value = rate;
    const g = ctx.createGain();
    g.gain.value = gain;
    src.connect(g).connect(this.drumBus);
    src.start(t);
    cleanupOnEnd(src, g);
  }

  /** Beat clock at audible time `ta`. */
  beat(ta: number, out: BeatInfo): void {
    if (!this.started || ta < this.t0) {
      out.phase = 0;
      out.kick = 0;
      out.bar = 0;
      return;
    }
    const beats = (ta - this.t0) / this.beatDur;
    out.phase = beats - Math.floor(beats);
    out.bar = Math.floor(beats / 4);
    let last = -1;
    for (let i = 0; i < 8; i++) {
      const k = this.kicks[i];
      if (k <= ta && k > last) last = k;
    }
    const x = last >= 0 ? 1 - (ta - last) / 0.15 : 0;
    out.kick = x > 0 ? x * x : 0;
  }

  /** Short swell from the tail of this song's riser (nitro). */
  swell(t: number): void {
    const buf = this.kit.get('riser');
    if (!buf) return;
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const g = ctx.createGain();
    g.gain.value = 0.28;
    src.connect(g).connect(this.drumBus);
    const len = Math.min(1.2, buf.duration);
    src.start(t, buf.duration - len);
    cleanupOnEnd(src, g);
  }

  dispose(): void {
    for (const x of [this.bass, this.lead, this.arp, this.pad, this.delay]) x.dispose();
    this.stab?.dispose();
    for (const n of this.extra) n.disconnect();
  }
}

// ---------------------------------------------------------------------------

/** Music manager: song crossfades, intensity, pause / nitro filter, beat clock. */
export class Music implements MusicHost {
  readonly ctx: AudioContext;
  readonly mixIn: GainNode;
  readonly wetIn: GainNode;
  readonly shared = new Map<DrumName, AudioBuffer>();
  intensity = 0.7;
  private readonly queue: JobQueue;
  private readonly filter: BiquadFilterNode;
  private readonly out: GainNode;
  private readonly wetOut: GainNode;
  private readonly kits = new Map<SongId, Map<DrumName, AudioBuffer>>();
  private readonly sr: number;
  private readonly maxHz: number;
  private current: SongPlayer | null = null;
  private fading: SongPlayer[] = [];
  private paused = false;
  private gain = 0;
  private readonly info: BeatInfo = { phase: 0, kick: 0, bar: 0 };

  constructor(ctx: AudioContext, queue: JobQueue, dest: AudioNode, verb: AudioNode) {
    this.ctx = ctx;
    this.queue = queue;
    this.sr = Math.min(48000, ctx.sampleRate);
    this.maxHz = Math.min(20000, ctx.sampleRate * 0.45);
    this.mixIn = ctx.createGain();
    this.filter = ctx.createBiquadFilter();
    this.filter.type = 'lowpass';
    this.filter.frequency.value = this.maxHz;
    this.filter.Q.value = 0.7;
    this.out = ctx.createGain();
    this.out.gain.value = 0; // setGain() fades in
    this.mixIn.connect(this.filter).connect(this.out).connect(dest);
    this.wetIn = ctx.createGain();
    this.wetOut = ctx.createGain();
    this.wetOut.gain.value = 0;
    this.wetIn.connect(this.wetOut).connect(verb);
    for (const j of sharedFxJobs(ctx, this.sr, this.shared)) queue.add(j, 1, 'music:fx');
  }

  /** Queue a song's kit for rendering (idempotent). */
  prepare(id: SongId, pri: number): void {
    const tag = 'kit:' + id;
    if (this.kits.has(id)) {
      this.queue.bump(tag, pri);
      return;
    }
    const kit = new Map<DrumName, AudioBuffer>();
    this.kits.set(id, kit);
    const s = SONGS[id];
    for (const j of kitJobs(this.ctx, this.sr, s.kit, s.bpm, kit)) this.queue.add(j, pri, tag);
  }

  play(id: SongId, fadeIn: number): void {
    const now = this.ctx.currentTime;
    const cur = this.current;
    if (cur && cur.song.id === id) {
      if (cur.endAt !== Infinity) cur.revive(now, fadeIn);
      return;
    }
    // Revive the same song if it is still fading out.
    const idx = this.fading.findIndex((p) => p.song.id === id && p.started);
    if (cur) this.retire(cur, now, Math.max(0.3, fadeIn));
    if (idx >= 0) {
      const p = this.fading.splice(idx, 1)[0];
      p.revive(now, fadeIn);
      this.current = p;
      return;
    }
    this.prepare(id, 7);
    this.current = new SongPlayer(this, SONGS[id], this.kits.get(id)!, Math.max(0.02, fadeIn));
    this.tick();
  }

  stop(fadeOut: number): void {
    if (this.current) this.retire(this.current, this.ctx.currentTime, fadeOut);
    this.current = null;
  }

  private retire(p: SongPlayer, now: number, dur: number): void {
    if (p.started) {
      p.fadeOut(now, dur);
      this.fading.push(p);
    } else p.dispose();
  }

  /** Scheduler pass (every ~25 ms). */
  tick(): void {
    const now = this.ctx.currentTime;
    const until = now + LOOKAHEAD;
    const cur = this.current;
    if (cur) {
      if (!cur.started && cur.ready) cur.start(now + 0.06);
      cur.schedule(now, until);
    }
    for (let i = this.fading.length - 1; i >= 0; i--) {
      const p = this.fading[i];
      if (now > p.endAt) {
        p.dispose();
        this.fading.splice(i, 1);
      } else p.schedule(now, until);
    }
  }

  setIntensity(x: number): void {
    this.intensity = clamp01(x);
  }

  /** Output level (volume × mute × ducking), smoothed. */
  setGain(g: number): void {
    if (Math.abs(g - this.gain) < 1e-4) return;
    this.gain = g;
    const now = this.ctx.currentTime;
    glide(this.out.gain, g, now, 0.08);
    glide(this.wetOut.gain, g * (this.paused ? 0.3 : 1), now, 0.08);
  }

  /** Pause → heavy low-pass (and a drier mix). */
  setPaused(p: boolean): void {
    if (p === this.paused) return;
    this.paused = p;
    const now = this.ctx.currentTime;
    const f = this.filter.frequency;
    f.cancelScheduledValues(now);
    glide(f, p ? 480 : this.maxHz, now, p ? 0.12 : 0.25);
    glide(this.filter.Q, p ? 1.4 : 0.7, now, 0.1);
    glide(this.wetOut.gain, this.gain * (p ? 0.3 : 1), now, 0.15);
  }

  /** Nitro: resonant filter swell opening up + a short riser. */
  nitro(): void {
    if (this.paused) return;
    const now = this.ctx.currentTime;
    const f = this.filter.frequency, q = this.filter.Q;
    f.cancelScheduledValues(now);
    q.cancelScheduledValues(now);
    // Quick dip, then a resonant sweep back open ("whoosh").
    setAt(f, this.maxHz, now);
    rampAt(f, 2600, now + 0.05);
    expRampAt(f, this.maxHz, now + 0.7);
    setAt(q, 0.7, now);
    rampAt(q, 4.5, now + 0.05);
    glide(q, 0.7, now + 0.35, 0.15);
    this.current?.swell(now);
  }

  get keyRoot(): number {
    return this.current?.song.key ?? 57;
  }

  /** Beat clock of the current song at the audible time. */
  beat(latency: number): BeatInfo {
    const p = this.current;
    if (p) p.beat(this.ctx.currentTime - latency, this.info);
    else {
      this.info.phase = 0;
      this.info.kick = 0;
      this.info.bar = 0;
    }
    return this.info;
  }

  dispose(): void {
    this.current?.dispose();
    for (const p of this.fading) p.dispose();
    this.current = null;
    this.fading = [];
    this.mixIn.disconnect();
    this.filter.disconnect();
    this.out.disconnect();
    this.wetIn.disconnect();
    this.wetOut.disconnect();
  }
}
