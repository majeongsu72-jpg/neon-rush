import { noteToMidi, pitchClass } from './dsp';

// Tiny music-theory layer for the sequencer: chord symbols, voicings,
// arpeggio tone ladders and the step-string formats used by songs.ts.

export interface Chord {
  root: number; // pitch class 0..11
  tones: number[]; // semitone intervals above the root
}

const QUALITY: Record<string, number[]> = {
  '': [0, 4, 7],
  m: [0, 3, 7],
  '5': [0, 7],
  '6': [0, 4, 7, 9],
  m6: [0, 3, 7, 9],
  '7': [0, 4, 7, 10],
  maj7: [0, 4, 7, 11],
  m7: [0, 3, 7, 10],
  m9: [0, 3, 7, 10, 14],
  maj9: [0, 4, 7, 11, 14],
  add9: [0, 4, 7, 14],
  madd9: [0, 3, 7, 14],
  sus2: [0, 2, 7],
  sus4: [0, 5, 7],
  '7sus4': [0, 5, 7, 10],
  dim: [0, 3, 6],
  aug: [0, 4, 8],
};

/** 'F#m7', 'Dbmaj7', 'C' → chord; null if the symbol is not understood. */
export function parseChord(sym: string): Chord | null {
  const m = /^([A-G][#b]?)(.*)$/.exec(sym.trim());
  if (!m) return null;
  const root = pitchClass(m[1]);
  const tones = QUALITY[m[2]];
  if (!Number.isFinite(root) || !tones) return null;
  return { root, tones };
}

/** Lowest MIDI note ≥ `lo` with pitch class `pc`. */
export function placeAbove(pc: number, lo: number): number {
  return lo + ((((pc - lo) % 12) + 12) % 12);
}

/** Semitone offset (from the chord root) of a bass-line token; NaN if not a note. */
export function bassInterval(tok: string, ch: Chord): number {
  const t = ch.tones;
  switch (tok) {
    case '1':
      return 0;
    case 'o':
    case '8':
      return 12;
    case 'l':
      return -12;
    case '3':
      return t.length > 2 ? t[1] : 4;
    case '5':
      return t.find((x) => x >= 6 && x <= 8) ?? 7;
    case '7':
      return t.find((x) => x >= 9 && x <= 11) ?? 10;
    case 'b':
      return 1;
    case '2':
      return 2;
    case '4':
      return 5;
    default:
      return NaN;
  }
}

/** Sorted ladder of chord tones starting at the root placed at/above `base`. */
export function arpLadder(ch: Chord, base: number, count = 12): number[] {
  const root = placeAbove(ch.root, base);
  const set = new Set<number>();
  for (let o = 0; o < 4; o++) for (const t of ch.tones) set.add(root + t + 12 * o);
  return [...set].sort((a, b) => a - b).slice(0, count);
}

/** Stack pitch classes in close position from `first`, doubling upward to four voices. */
function stack(pcs: number[], r: number, first: number): number[] {
  const v: number[] = [first];
  for (let k = 1; k < pcs.length; k++) v.push(placeAbove(pcs[(r + k) % pcs.length], v[k - 1] + 1));
  while (v.length < 4) v.push(v[v.length - pcs.length] + 12);
  return v;
}

/** Four-voice pad voicing inside [lo, hi] moving as little as possible from `prev`. */
export function voiceChord(ch: Chord, lo: number, hi: number, prev: number[] | null): number[] {
  const t = ch.tones;
  // Five-note chords go rootless (3-5-7-9, lush — the bass has the root).
  const iv = t.length >= 5 ? t.slice(1, 5) : t;
  const pcs = [...new Set(iv.map((x) => (ch.root + x) % 12))].sort((a, b) => a - b);
  let best: number[] | null = null;
  let bestCost = Infinity;
  const mid = (lo + hi) / 2;
  for (let r = 0; r < pcs.length; r++) {
    for (let lift = 0; lift < 2; lift++) {
      const v = stack(pcs, r, placeAbove(pcs[r], lo) + 12 * lift);
      if (v[v.length - 1] > hi) continue;
      let cost = 0;
      if (prev && prev.length === v.length) for (let k = 0; k < v.length; k++) cost += Math.abs(v[k] - prev[k]);
      else cost = Math.abs(v.reduce((a, b) => a + b, 0) / v.length - mid);
      if (cost < bestCost) {
        bestCost = cost;
        best = v;
      }
    }
  }
  // Range too narrow: close position from the bottom.
  return best ?? stack(pcs, 0, placeAbove(pcs[0], lo));
}

// ---------------------------------------------------------------------------
// Melody strings: bars separated by '|', 16 whitespace-separated tokens per bar:
// note names ('A4', 'C#5'), '-' hold, '.' rest.

export const REST = -1;
export const HOLD = -2;

/** Parse a melody into a flat step array (MIDI, REST or HOLD). Throws on malformed input. */
export function parseMelody(src: string): number[] {
  const out: number[] = [];
  const bars = src.split('|');
  for (let b = 0; b < bars.length; b++) {
    const toks = bars[b].trim().split(/\s+/);
    if (toks.length !== 16) throw new Error(`melody bar ${b + 1} has ${toks.length} steps`);
    for (const tk of toks) {
      if (tk === '-') out.push(HOLD);
      else if (tk === '.') out.push(REST);
      else {
        const m = noteToMidi(tk);
        if (!Number.isFinite(m)) throw new Error(`bad note "${tk}"`);
        out.push(m);
      }
    }
  }
  return out;
}

/** Length (in steps) of the note starting at `i`, following holds with wrap-around. */
export function noteSteps(steps: ArrayLike<number>, i: number): number {
  const n = steps.length;
  let k = 1;
  while (k < n && steps[(i + k) % n] === HOLD) k++;
  return k;
}
