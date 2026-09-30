// localStorage wrapper that never throws (private windows, sandboxed iframes,
// blocked storage all degrade to an in-memory store).

const PREFIX = 'neonrush.v1.';
const memory = new Map<string, string>();

function rawGet(key: string): string | null {
  try {
    const v = window.localStorage.getItem(PREFIX + key);
    if (v !== null) return v;
  } catch {
    /* storage unavailable */
  }
  return memory.has(key) ? memory.get(key)! : null;
}

function rawSet(key: string, value: string): void {
  memory.set(key, value);
  try {
    window.localStorage.setItem(PREFIX + key, value);
  } catch {
    /* quota or blocked — memory copy still works for this session */
  }
}

export function loadJSON<T>(key: string, fallback: T): T {
  const raw = rawGet(key);
  if (raw === null) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function saveJSON(key: string, value: unknown): void {
  try {
    rawSet(key, JSON.stringify(value));
  } catch {
    /* ignore */
  }
}

// ---------------------------------------------------------------------------
// Records

export interface Records {
  bestLap: Record<string, number>; // `${track}:${car}` → seconds
  bestLapAny: Record<string, number>; // track → seconds
  bestRace: Record<string, number>; // track → total seconds (race mode, 1st place only)
  rushHigh: Record<string, number>; // track → score
  wins: number;
  races: number;
}

const defaultRecords = (): Records => ({ bestLap: {}, bestLapAny: {}, bestRace: {}, rushHigh: {}, wins: 0, races: 0 });

let recordsCache: Records | null = null;
/** Off for autopilot/debug runs, so a bot's laps never become the player's records. */
let persist = true;

export function setRecordPersistence(on: boolean): void {
  persist = on;
}

export function getRecords(): Records {
  if (!recordsCache) recordsCache = { ...defaultRecords(), ...loadJSON<Partial<Records>>('records', {}) };
  return recordsCache;
}

export function saveRecords(): void {
  if (recordsCache && persist) saveJSON('records', recordsCache);
}

// ---------------------------------------------------------------------------
// Ghosts (Float32Array ⇄ base64)

export function saveGhost(key: string, data: Float32Array): void {
  if (!persist) return;
  const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  rawSet('ghost.' + key, btoa(bin));
}

export function loadGhost(key: string): Float32Array | null {
  const raw = rawGet('ghost.' + key);
  if (!raw) return null;
  try {
    const bin = atob(raw);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Float32Array(bytes.buffer, 0, Math.floor(bytes.length / 4));
  } catch {
    return null;
  }
}
