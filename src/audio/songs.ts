// Song data for the synthwave sequencer (Music.ts). Everything is text:
//  • drum lanes: 16 chars per bar — 'x' accent, 'o' hit, 'g' ghost, '.' rest
//  • bass lines: 16 chars per bar — '1' chord root, 'o' root+12, 'l' root−12,
//    '3' '5' '7' chord tones, 'b' root+1 (phrygian), '2' '4', '-' hold, '.' rest;
//    `accent` / `slide` lanes ('x' / 's') cycle independently
//  • arps: 16 chars per bar — digits index a ladder of chord tones, '-' hold, '.' rest
//  • leads: bars separated by '|', 16 tokens each: note names, '-' hold, '.' rest
//  • stabs: 16 chars per bar — 'x' accent chord hit, 'o' softer
// Multi-bar lanes cycle through their bars inside a section.

export type SongId = 'menu' | 'neon' | 'coast' | 'grid';

export interface MonoPatch {
  wave: OscillatorType;
  wave2: OscillatorType;
  mix2: number; // level of oscillator 2
  oct2: number; // octave offset of oscillator 2
  detune: number; // ± cents between the oscillators
  sub: number; // sine at the fundamental (weight; bypasses the filter)
  cutoff: number; // Hz
  q: number;
  env: number; // filter envelope depth (× cutoff)
  decay: number; // filter envelope time constant (s)
  attack: number; // amp attack time constant (s)
  ampDecay: number; // amp decay time constant (s)
  sustain: number; // 0..1
  release: number; // amp release time constant (s)
  glide: number; // portamento time constant (s) for slides / legato
  vibrato: number; // cents (delayed vibrato)
  level: number;
  transpose: number; // semitones
  /** Slow filter sweep for acid lines: period (bars) and depth (octaves). */
  sweep?: { bars: number; depth: number };
}

export interface PadPatch {
  wave: OscillatorType;
  cutoff: number;
  q: number;
  detune: number; // cents (left / right oscillator of each voice)
  attack: number; // time constant (s)
  release: number;
  level: number;
}

export interface StabPatch {
  wave: OscillatorType;
  cutoff: number;
  q: number;
  env: number;
  decay: number;
  detune: number;
  level: number;
}

export interface KitPatch {
  kick: { f0: number; f1: number; sweep: number; decay: number; click: number; drive: number; level: number };
  snare: { tone: number; noise: number; decay: number; verb: number; gate: number; level: number };
  clap: { verb: number; level: number };
  hat: { decay: number; bright: number; level: number };
  ohat: { decay: number; level: number };
  perc: { freq: number; decay: number; level: number };
  crash: { level: number };
}

export interface DrumSet {
  kick?: string;
  snare?: string;
  clap?: string;
  hat?: string;
  ohat?: string;
  perc?: string;
}

export interface BassLine {
  notes: string;
  accent?: string;
  slide?: string;
  /** Ignore the chord: play relative to the song key (techno pedal). */
  pedal?: boolean;
}

export interface SectionDef {
  name: string;
  bars: number;
  chords: string[]; // one per bar, cycled
  drums?: string;
  fill?: string; // drum set for the section's last bar
  bass?: string;
  arp?: string;
  pad?: boolean;
  lead?: string;
  leadOct?: number;
  stab?: string;
  crash?: boolean; // cymbal on the downbeat
  impact?: boolean; // sub drop on the downbeat
  riser?: boolean; // riser over the last two bars
  sweep?: [number, number]; // song low-pass sweep across the section (Hz)
}

export interface SongMix {
  drums: number;
  duck: number; // bass sidechain depth (0..1)
  synthDuck: number; // pads / arp / delay sidechain depth
  padVerb: number;
  leadVerb: number;
  arpDelay: number;
  leadDelay: number;
  /** Lead is dropped below this intensity. */
  leadMin: number;
}

export interface SongDef {
  id: SongId;
  title: string;
  bpm: number;
  swing: number; // fraction of a 16th that odd steps are delayed
  key: number; // MIDI tonic (stingers are tuned to it)
  loopTo: number; // section index the arrangement loops back to
  bassLo: number; // bass roots are placed in [bassLo, bassLo + 12)
  arpBase: number;
  padRange: [number, number];
  stabBase: number;
  delayBeats: number;
  delayFb: number;
  sections: SectionDef[];
  drums: Record<string, DrumSet>;
  bass: Record<string, BassLine>;
  arps: Record<string, string>;
  leads: Record<string, string>;
  stabs: Record<string, string>;
  kit: KitPatch;
  bassPatch: MonoPatch;
  leadPatch: MonoPatch;
  arpPatch: MonoPatch;
  padPatch: PadPatch;
  stabPatch: StabPatch;
  mix: SongMix;
}

const mono = (p: Partial<MonoPatch>): MonoPatch => ({
  wave: 'sawtooth',
  wave2: 'sawtooth',
  mix2: 0.7,
  oct2: 0,
  detune: 8,
  sub: 0,
  cutoff: 1200,
  q: 1,
  env: 2,
  decay: 0.15,
  attack: 0.004,
  ampDecay: 0.3,
  sustain: 0.7,
  release: 0.08,
  glide: 0.04,
  vibrato: 0,
  level: 0.2,
  transpose: 0,
  ...p,
});

const noStab: StabPatch = { wave: 'sawtooth', cutoff: 1200, q: 2, env: 3, decay: 0.08, detune: 8, level: 0 };
const noPerc = { freq: 1000, decay: 0.03, level: 0 };

// ===========================================================================
// MENU — "Midnight Drive": 100 BPM, F minor, lush and unhurried.

const MENU_A = ['Fm9', 'Dbmaj7', 'Abmaj7', 'Ebadd9'];
const MENU_B = ['Bbm9', 'Fm9', 'Dbmaj7', 'C7'];

const menu: SongDef = {
  id: 'menu',
  title: 'Midnight Drive',
  bpm: 100,
  swing: 0.12,
  key: 65,
  loopTo: 1,
  bassLo: 29,
  arpBase: 60,
  padRange: [53, 77],
  stabBase: 60,
  delayBeats: 0.75,
  delayFb: 0.42,
  sections: [
    { name: 'intro', bars: 4, chords: MENU_A, pad: true, arp: 'gentle', sweep: [500, 9000] },
    { name: 'verse', bars: 8, chords: MENU_A, pad: true, arp: 'gentle', drums: 'half', fill: 'fill', bass: 'walk' },
    { name: 'theme', bars: 8, chords: MENU_A, pad: true, arp: 'gentle', drums: 'half', fill: 'fill', bass: 'walk', lead: 'm1', crash: true },
    { name: 'bridge', bars: 8, chords: MENU_B, pad: true, arp: 'gentle2', drums: 'half2', fill: 'fill', bass: 'long', lead: 'm2' },
    { name: 'float', bars: 4, chords: MENU_A, pad: true, arp: 'gentle', drums: 'soft', riser: true },
    { name: 'theme2', bars: 8, chords: MENU_A, pad: true, arp: 'gentle2', drums: 'half2', fill: 'fill', bass: 'walk', lead: 'm1', crash: true },
  ],
  drums: {
    half: { kick: 'x.........o.....', snare: '........x.......', hat: 'o.g.o.g.o.g.o.g.' },
    half2: { kick: 'x.........o..o..', snare: '........x.......', hat: 'o.gog.g.o.gog.g.', ohat: '..............g.' },
    fill: { kick: 'x.........o.....', snare: '........x...o.ox', hat: 'o.g.o.g.o.g.....' },
    soft: { kick: 'x...............', hat: '....g.......g...' },
  },
  bass: {
    walk: { notes: '1-----1-----5-o-' },
    long: { notes: '1-------1---5-3-' },
  },
  arps: {
    gentle: '0.1.2.3.4.3.2.1.',
    gentle2: '0.2.4.2.1.3.5.3.',
  },
  leads: {
    m1:
      'C5 - - - - - Ab4 - G4 - Ab4 - C5 - - - |' +
      'Db5 - - - - - C5 - Ab4 - - - F4 - - - |' +
      'Eb5 - - - - - C5 - Ab4 - C5 - Eb5 - F5 - |' +
      'G5 - - - - - - - F5 - Eb5 - - - . . |' +
      'C5 - - - - - Ab4 - G4 - Ab4 - C5 - Eb5 - |' +
      'F5 - - - - - Eb5 - Db5 - - - C5 - - - |' +
      'C5 - - - Eb5 - - - Ab5 - - - G5 - Eb5 - |' +
      'F5 - - - - - - - - - - - . . . .',
    m2:
      'Db5 - - - C5 - Bb4 - C5 - - - - - - - |' +
      'Ab4 - - - G4 - F4 - G4 - Ab4 - C5 - - - |' +
      'F5 - - - Eb5 - Db5 - Eb5 - - - F5 - - - |' +
      'G5 - - - - - - - F5 - - - E5 - - -',
  },
  stabs: {},
  kit: {
    kick: { f0: 130, f1: 44, sweep: 0.04, decay: 0.32, click: 0.12, drive: 1.1, level: 0.8 },
    snare: { tone: 200, noise: 0.6, decay: 0.2, verb: 0.6, gate: 0, level: 0.36 },
    clap: { verb: 0.5, level: 0.2 },
    hat: { decay: 0.03, bright: 0.4, level: 0.12 },
    ohat: { decay: 0.25, level: 0.1 },
    perc: noPerc,
    crash: { level: 0.2 },
  },
  bassPatch: mono({ wave: 'triangle', wave2: 'sawtooth', mix2: 0.35, detune: 6, sub: 0.7, cutoff: 320, q: 0.9, env: 1.6, decay: 0.2, attack: 0.008, ampDecay: 0.6, sustain: 0.75, release: 0.12, glide: 0.06, level: 0.45 }),
  leadPatch: mono({ wave: 'triangle', wave2: 'sine', mix2: 0.6, oct2: 1, detune: 4, cutoff: 2600, q: 0.7, env: 0.6, decay: 0.4, attack: 0.03, ampDecay: 0.8, sustain: 0.8, release: 0.3, glide: 0.06, vibrato: 12, level: 0.22 }),
  arpPatch: mono({ wave: 'square', wave2: 'triangle', mix2: 0.6, oct2: 1, detune: 3, cutoff: 1100, q: 2, env: 3, decay: 0.12, attack: 0.002, ampDecay: 0.18, sustain: 0, release: 0.08, glide: 0, level: 0.11 }),
  padPatch: { wave: 'sawtooth', cutoff: 1500, q: 0.6, detune: 9, attack: 0.9, release: 1.2, level: 0.1 },
  stabPatch: noStab,
  mix: { drums: 0.8, duck: 0.35, synthDuck: 0.15, padVerb: 0.5, leadVerb: 0.45, arpDelay: 0.5, leadDelay: 0.4, leadMin: 0.3 },
};

// ===========================================================================
// NEON — "Neon Veins": 128 BPM darksynth, A minor. Rolling 16th bass, gated
// snare, pedal-point arp and a 3-3-2 lead hook.

const NEON_MAIN = ['Am', 'F', 'C', 'G'];
const NEON_BUILD = ['F', 'F', 'G', 'G'];
const NEON_BREAK = ['Fmaj7', 'G', 'Em7', 'Am'];

const NEON_HOOK =
  'E5 - - A5 - - G5 - E5 - - - D5 - C5 - |' +
  'C5 - - F5 - - E5 - C5 - - - A4 - - - |' +
  'G5 - - C6 - - B5 - G5 - - - E5 - D5 - |' +
  'D5 - - - B4 - - - D5 - E5 - G5 - - -';
const NEON_HOOK2 =
  'A5 - - C6 - - B5 - A5 - - - G5 - E5 - |' +
  'F5 - - A5 - - G5 - F5 - - - E5 - C5 - |' +
  'E5 - - G5 - - C6 - B5 - - - G5 - - - |' +
  'B5 - - - D6 - - - B5 - A5 - G5 - - -';

const neon: SongDef = {
  id: 'neon',
  title: 'Neon Veins',
  bpm: 128,
  swing: 0,
  key: 57,
  loopTo: 3,
  bassLo: 33,
  arpBase: 57,
  padRange: [52, 76],
  stabBase: 60,
  delayBeats: 0.75,
  delayFb: 0.38,
  sections: [
    { name: 'intro', bars: 4, chords: NEON_MAIN, pad: true, arp: 'up', sweep: [350, 2400] },
    { name: 'rise', bars: 4, chords: NEON_MAIN, pad: true, arp: 'up', drums: 'kick', bass: 'pulse', sweep: [2400, 16000], riser: true },
    { name: 'build', bars: 4, chords: NEON_BUILD, pad: true, arp: 'drive', drums: 'build', fill: 'roll', bass: 'pulse', riser: true },
    { name: 'drop', bars: 16, chords: NEON_MAIN, pad: true, arp: 'drive', drums: 'four', fill: 'fill', bass: 'roll', lead: 'hook', crash: true, impact: true },
    { name: 'break', bars: 8, chords: NEON_BREAK, pad: true, arp: 'up', drums: 'half', bass: 'long' },
    { name: 'build2', bars: 4, chords: NEON_BUILD, pad: true, arp: 'drive', drums: 'build', fill: 'roll', bass: 'pulse', riser: true },
    { name: 'drop2', bars: 16, chords: NEON_MAIN, pad: true, arp: 'drive', drums: 'four2', fill: 'fill', bass: 'roll', lead: 'hookB', crash: true, impact: true },
  ],
  drums: {
    kick: { kick: 'x...x...x...x...' },
    build: { kick: 'x...x...x...x...', snare: '....x.......x...', hat: 'g.x.g.x.g.x.g.x.' },
    roll: { kick: 'x...x...x...x...', snare: 'g.g.o.o.ooooxxxx' },
    four: { kick: 'x...x...x...x...', snare: '....x.......x...', clap: '....o.......o...', hat: 'ggxgggxgggxgggxg', ohat: '..............o.' },
    four2: { kick: 'x...x...x...x..o', snare: '....x.......x...', clap: '....o.......o...', hat: 'gxgxgxgxgxgxgxgx', ohat: '..o...o...o...o.' },
    fill: { kick: 'x...x...x...x...', snare: '....x.......x.oo', clap: '....o...........', hat: 'ggxgggxgggxg....' },
    half: { kick: 'x.........x.....', snare: '........x.......', hat: 'o.g.o.g.o.g.o.g.' },
  },
  bass: {
    pulse: { notes: '1.1.1.1.1.1.1.1.' },
    roll: {
      notes: '.111.111.111.111' + '.111.111.111.111' + '.111.111.111.111' + '.111.111.o1o.5o5',
      accent: '.x...x...x...x..',
    },
    long: { notes: '1-------1-----5-' },
  },
  arps: {
    up: '0123012301230123',
    drive: '0102030102030405',
  },
  leads: { hook: NEON_HOOK, hookB: NEON_HOOK2 + '|' + NEON_HOOK },
  stabs: {},
  kit: {
    kick: { f0: 190, f1: 46, sweep: 0.035, decay: 0.3, click: 0.45, drive: 2.2, level: 0.95 },
    snare: { tone: 185, noise: 0.85, decay: 0.16, verb: 0.75, gate: 0.26, level: 0.5 },
    clap: { verb: 0.4, level: 0.26 },
    hat: { decay: 0.035, bright: 0.7, level: 0.18 },
    ohat: { decay: 0.2, level: 0.14 },
    perc: noPerc,
    crash: { level: 0.28 },
  },
  bassPatch: mono({ mix2: 0.8, detune: 9, sub: 0.55, cutoff: 260, q: 2.2, env: 5.5, decay: 0.07, attack: 0.002, ampDecay: 0.18, sustain: 0.55, release: 0.03, glide: 0.03, level: 0.5 }),
  leadPatch: mono({ wave2: 'square', mix2: 0.55, detune: 7, cutoff: 1500, q: 1.6, env: 2.2, decay: 0.25, attack: 0.006, ampDecay: 0.4, sustain: 0.75, release: 0.12, glide: 0.035, vibrato: 16, level: 0.2 }),
  arpPatch: mono({ wave2: 'square', mix2: 0.4, oct2: 1, detune: 4, cutoff: 700, q: 4.5, env: 7, decay: 0.06, attack: 0.001, ampDecay: 0.09, sustain: 0, release: 0.04, glide: 0, level: 0.14 }),
  padPatch: { wave: 'sawtooth', cutoff: 1300, q: 0.8, detune: 10, attack: 0.5, release: 0.6, level: 0.085 },
  stabPatch: noStab,
  mix: { drums: 0.85, duck: 0.8, synthDuck: 0.45, padVerb: 0.35, leadVerb: 0.22, arpDelay: 0.35, leadDelay: 0.3, leadMin: 0.4 },
};

// ===========================================================================
// COAST — "Golden Hour Overdrive": 118 BPM outrun, D major. Octave bass,
// punchy gated drums and a big singing lead through a dotted delay.

const COAST_A = ['D', 'A', 'Bm', 'G'];
const COAST_B = ['G', 'A', 'F#m', 'Bm'];
const COAST_LIFT = ['Em7', 'G', 'A', 'A'];

const coast: SongDef = {
  id: 'coast',
  title: 'Golden Hour Overdrive',
  bpm: 118,
  swing: 0,
  key: 62,
  loopTo: 1,
  bassLo: 33,
  arpBase: 62,
  padRange: [54, 78],
  stabBase: 62,
  delayBeats: 0.75,
  delayFb: 0.4,
  sections: [
    { name: 'intro', bars: 4, chords: COAST_A, pad: true, arp: 'eights', drums: 'hats', sweep: [700, 12000] },
    { name: 'verse', bars: 8, chords: COAST_A, pad: true, arp: 'sparkle', drums: 'beat', fill: 'fill', bass: 'oct' },
    { name: 'chorus', bars: 8, chords: COAST_A, pad: true, arp: 'sparkle', drums: 'beat2', fill: 'fill', bass: 'oct', lead: 'hook', crash: true },
    { name: 'bridge', bars: 8, chords: COAST_B, pad: true, arp: 'eights', drums: 'light', bass: 'walk', lead: 'bridge' },
    { name: 'lift', bars: 4, chords: COAST_LIFT, pad: true, arp: 'sparkle', drums: 'light', fill: 'fill', bass: 'oct', riser: true },
    { name: 'chorus2', bars: 8, chords: COAST_A, pad: true, arp: 'sparkle', drums: 'beat2', fill: 'fill', bass: 'oct16', lead: 'hook', crash: true, impact: true },
    { name: 'turn', bars: 4, chords: COAST_A, pad: true, arp: 'eights', drums: 'beat', bass: 'oct' },
  ],
  drums: {
    hats: { hat: 'g.o.g.o.g.o.g.o.' },
    beat: { kick: 'x.......x.x.....', snare: '....x.......x...', hat: 'g.x.g.x.g.x.g.x.', ohat: '..............o.' },
    beat2: { kick: 'x.......x.x...o.', snare: '....x.......x...', clap: '....o.......o...', hat: 'gxgxgxgxgxgxgxgx', ohat: '..o.......o.....' },
    light: { kick: 'x.......x.......', snare: '....o.......o...', hat: 'o.o.o.o.o.o.o.o.' },
    fill: { kick: 'x.......x.x.....', snare: '....x.......xgoo', hat: 'g.x.g.x.g.x.....' },
  },
  bass: {
    oct: { notes: '1-o-1-o-1-o-1-o-' },
    oct16: { notes: '1o1o1o1o1o1o1o1o' },
    walk: { notes: '1---5---o---5---' },
  },
  arps: {
    sparkle: '0123432101234321',
    eights: '0.2.3.2.4.2.3.2.',
  },
  leads: {
    hook:
      'F#5 - - - A5 - - - D6 - - - C#6 - A5 - |' +
      'E5 - - - - - - - C#5 - E5 - A5 - - - |' +
      'F#5 - - - D5 - F#5 - B5 - - - A5 - F#5 - |' +
      'G5 - - - - - - - F#5 - E5 - D5 - E5 - |' +
      'F#5 - - - A5 - - - D6 - - - E6 - F#6 - |' +
      'E6 - - - - - C#6 - A5 - - - E5 - - - |' +
      'D6 - - - C#6 - B5 - A5 - - - F#5 - - - |' +
      'G5 - - - A5 - - - . . . . . . . .',
    bridge:
      'B5 - - - A5 - G5 - A5 - - - D5 - - - |' +
      'C#6 - - - B5 - A5 - E5 - - - - - - - |' +
      'C#6 - - - A5 - F#5 - A5 - - - C#6 - - - |' +
      'D6 - - - - - - - F#6 - - - E6 - D6 -',
  },
  stabs: {},
  kit: {
    kick: { f0: 170, f1: 50, sweep: 0.03, decay: 0.22, click: 0.35, drive: 1.6, level: 0.9 },
    snare: { tone: 190, noise: 0.9, decay: 0.15, verb: 0.65, gate: 0.3, level: 0.52 },
    clap: { verb: 0.45, level: 0.26 },
    hat: { decay: 0.03, bright: 0.8, level: 0.17 },
    ohat: { decay: 0.18, level: 0.13 },
    perc: noPerc,
    crash: { level: 0.28 },
  },
  bassPatch: mono({ mix2: 0.7, detune: 8, sub: 0.5, cutoff: 480, q: 1.3, env: 3, decay: 0.12, attack: 0.003, ampDecay: 0.3, sustain: 0.6, release: 0.05, glide: 0.03, level: 0.42 }),
  leadPatch: mono({ mix2: 0.9, detune: 13, cutoff: 2600, q: 1.1, env: 1.4, decay: 0.3, attack: 0.008, ampDecay: 0.5, sustain: 0.8, release: 0.18, glide: 0.03, vibrato: 18, level: 0.19 }),
  arpPatch: mono({ wave: 'square', mix2: 0.5, detune: 5, cutoff: 1500, q: 2.2, env: 4, decay: 0.08, attack: 0.001, ampDecay: 0.12, sustain: 0, release: 0.05, glide: 0, level: 0.12 }),
  padPatch: { wave: 'sawtooth', cutoff: 2300, q: 0.7, detune: 11, attack: 0.4, release: 0.7, level: 0.09 },
  stabPatch: noStab,
  mix: { drums: 0.85, duck: 0.6, synthDuck: 0.3, padVerb: 0.35, leadVerb: 0.3, arpDelay: 0.35, leadDelay: 0.42, leadMin: 0.4 },
};

// ===========================================================================
// GRID — "Vector Overload": 140 BPM, E phrygian cyber-techno. Relentless
// four-on-the-floor, resonant acid pedal bass with slides, off-beat stabs.

const GRID_A = ['Em', 'Em', 'F', 'Em'];
const GRID_B = ['C', 'D', 'F', 'Em'];

const GRID_G1 =
  'E5 - - . E5 - G5 - F5 - E5 - . . B4 - |' +
  'E5 - - . E5 - G5 - A5 - G5 - F5 - - - |' +
  'F5 - - . F5 - A5 - G5 - F5 - . . C5 - |' +
  'E5 - - - - - - - . . . . B5 - C6 -';
const GRID_G2 =
  'B5 - E6 - B5 - G5 - E5 - G5 - B5 - D6 - |' +
  'E6 - - - D6 - B5 - C6 - B5 - G5 - - - |' +
  'C6 - A5 - F5 - A5 - C6 - F6 - E6 - C6 - |' +
  'B5 - - - - - - - E6 - - - - - - -';

const grid: SongDef = {
  id: 'grid',
  title: 'Vector Overload',
  bpm: 140,
  swing: 0,
  key: 64,
  loopTo: 2,
  bassLo: 36,
  arpBase: 64,
  padRange: [52, 76],
  stabBase: 60,
  delayBeats: 0.75,
  delayFb: 0.35,
  sections: [
    { name: 'boot', bars: 8, chords: GRID_A, drums: 'intro', bass: 'pulse', sweep: [300, 3500] },
    { name: 'charge', bars: 8, chords: GRID_A, drums: 'build', fill: 'roll', bass: 'acid', stab: 'off', sweep: [3500, 18000], riser: true },
    { name: 'overload', bars: 16, chords: GRID_A, drums: 'four', fill: 'fill', bass: 'acid', stab: 'sync', lead: 'g1', crash: true, impact: true },
    { name: 'void', bars: 8, chords: GRID_B, pad: true, arp: 'glass', drums: 'ticks', bass: 'drone', riser: true },
    { name: 'overload2', bars: 16, chords: GRID_A, drums: 'four2', fill: 'fill', bass: 'acid', stab: 'off', lead: 'gB', crash: true, impact: true },
  ],
  drums: {
    intro: { kick: 'x...x...x...x...', hat: '..o...o...o...o.' },
    build: { kick: 'x...x...x...x...', clap: '....x.......x...', hat: 'g.o.g.o.g.o.g.o.', ohat: '..g...g...g...g.' },
    roll: { kick: 'x...x...x...x...', snare: 'g.g.o.o.ooooxxxx', hat: 'g.o.g.o.g.o.g.o.' },
    four: { kick: 'x...x...x...x...', clap: '....x.......x...', hat: 'ggogggogggogggog', ohat: '..x...x...x...x.', perc: '...g..g....g..g.' },
    four2: { kick: 'x...x...x...x...', clap: '....x.......x..g', hat: 'gogogogogogogogo', ohat: '..x...x...x...x.', perc: '.g..g..g.g..g..g' },
    fill: { kick: 'x...x...x...x.x.', clap: '....x.......x...', snare: '............o.ox', hat: 'ggogggogggog....' },
    ticks: { hat: '..g...g...g...g.', perc: '.......g.......g' },
  },
  bass: {
    pulse: { notes: '..1...1...1...1.', pedal: true },
    acid: {
      notes: '1.1o1b.1o.1.51b1' + '1o.1o.1bo.1.1o5b',
      accent: 'x..x...x.x...x..' + 'x...x...x..x..x.',
      slide: '...s.s...s....s.' + '.s..s...s.....s.',
      pedal: true,
    },
    drone: { notes: '1---------------', pedal: true },
  },
  arps: { glass: '0.2.4.1.3.5.2.4.' },
  leads: { g1: GRID_G1, gB: GRID_G2 + '|' + GRID_G1 },
  stabs: { off: '..x...x...x...x.', sync: '...x..x....x..x.' },
  kit: {
    kick: { f0: 230, f1: 42, sweep: 0.025, decay: 0.28, click: 0.8, drive: 3.2, level: 1 },
    snare: { tone: 210, noise: 0.9, decay: 0.12, verb: 0.3, gate: 0.14, level: 0.4 },
    clap: { verb: 0.55, level: 0.38 },
    hat: { decay: 0.025, bright: 1, level: 0.19 },
    ohat: { decay: 0.13, level: 0.16 },
    perc: { freq: 1180, decay: 0.035, level: 0.13 },
    crash: { level: 0.26 },
  },
  bassPatch: mono({ wave2: 'square', mix2: 0.25, detune: 0, sub: 0.35, cutoff: 190, q: 13, env: 8, decay: 0.11, attack: 0.002, ampDecay: 0.2, sustain: 0.65, release: 0.03, glide: 0.045, level: 0.38, sweep: { bars: 8, depth: 1.4 } }),
  leadPatch: mono({ mix2: 0.8, detune: 16, cutoff: 2000, q: 2.8, env: 2.6, decay: 0.16, attack: 0.004, ampDecay: 0.3, sustain: 0.7, release: 0.1, glide: 0.05, vibrato: 10, level: 0.16 }),
  arpPatch: mono({ wave: 'square', wave2: 'square', mix2: 0.5, oct2: 1, detune: 6, cutoff: 1800, q: 3, env: 3, decay: 0.05, attack: 0.001, ampDecay: 0.08, sustain: 0, release: 0.04, glide: 0, level: 0.11 }),
  padPatch: { wave: 'sawtooth', cutoff: 850, q: 1.2, detune: 12, attack: 0.6, release: 0.8, level: 0.085 },
  stabPatch: { wave: 'sawtooth', cutoff: 1300, q: 5, env: 4, decay: 0.08, detune: 10, level: 0.2 },
  mix: { drums: 0.9, duck: 0.72, synthDuck: 0.4, padVerb: 0.45, leadVerb: 0.25, arpDelay: 0.4, leadDelay: 0.3, leadMin: 0.4 },
};

export const SONGS: Record<SongId, SongDef> = { menu, neon, coast, grid };
