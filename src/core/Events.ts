import type { Vehicle } from '../vehicle/Vehicle';

// Typed event bus. Gameplay systems emit; audio / HUD / FX / camera listen.

export type BoostKind = 'nitro' | 'mini' | 'slingshot' | 'pad' | 'start';

export interface GameEventMap {
  nearMiss: { car: Vehicle; other: Vehicle | null; side: number; speed: number; oncoming: boolean; points: number };
  driftStart: { car: Vehicle; dir: number };
  driftLevel: { car: Vehicle; level: number };
  driftEnd: { car: Vehicle; level: number; duration: number; score: number };
  boost: { car: Vehicle; kind: BoostKind; strength: number };
  nitroStart: { car: Vehicle };
  nitroEnd: { car: Vehicle };
  wallHit: { car: Vehicle; impact: number; side: number };
  carHit: { a: Vehicle; b: Vehicle; impact: number; s: number; d: number };
  airborne: { car: Vehicle };
  landing: { car: Vehicle; airTime: number; impact: number };
  gearShift: { car: Vehicle; gear: number; up: boolean };
  backfire: { car: Vehicle; strength: number };
  lap: { car: Vehicle; lap: number; lapTime: number; best: boolean; personalBest: boolean };
  sector: { car: Vehicle; sector: number; time: number; delta: number | null };
  finish: { car: Vehicle; position: number; time: number };
  overtake: { car: Vehicle; position: number; passed: Vehicle | null };
  slipstream: { car: Vehicle };
  slingshot: { car: Vehicle };
  countdown: { n: number };
  startResult: { car: Vehicle; quality: 'perfect' | 'good' | 'spin' | 'none' };
  wrongWay: { on: boolean };
  checkpoint: { added: number; index: number };
  crash: { car: Vehicle; other: Vehicle | null; impact: number };
  tunnel: { inside: boolean };
  finalLap: {};
  respawn: { car: Vehicle };
  combo: { count: number; multiplier: number };
  record: { kind: 'lap' | 'race' | 'score'; value: number };
}

type Handler<T> = (payload: T) => void;

export class EventBus<M extends object> {
  private handlers = new Map<keyof M, Set<Handler<any>>>();

  on<K extends keyof M>(type: K, fn: Handler<M[K]>): () => void {
    let set = this.handlers.get(type);
    if (!set) {
      set = new Set();
      this.handlers.set(type, set);
    }
    set.add(fn);
    return () => set!.delete(fn);
  }

  emit<K extends keyof M>(type: K, payload: M[K]): void {
    const set = this.handlers.get(type);
    if (!set) return;
    for (const fn of set) {
      try {
        fn(payload);
      } catch (err) {
        console.error(`[events] handler for "${String(type)}" failed`, err);
      }
    }
  }

  clear(): void {
    this.handlers.clear();
  }
}

export type GameEvents = EventBus<GameEventMap>;
