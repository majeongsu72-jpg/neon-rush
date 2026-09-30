import '@fontsource/orbitron/latin-700.css';
import '@fontsource/orbitron/latin-900.css';
import '@fontsource/rajdhani/latin-500.css';
import '@fontsource/rajdhani/latin-700.css';
import './ui/styles.css';
import { App } from './game/App';
import { STEP } from './game/Game';

const params = new URLSearchParams(location.search);
const canvas = document.getElementById('gl') as HTMLCanvasElement;
const ui = document.getElementById('ui') as HTMLDivElement;

const errors: string[] = [];
window.addEventListener('error', (e) => errors.push(String(e.message)));
window.addEventListener('unhandledrejection', (e) => errors.push(String(e.reason)));

const app = new App({ canvas, params }, ui);
const game = app.game;

// Canvas gauges bake text: make sure the webfonts are ready first.
const fontsReady = Promise.all([
  document.fonts.load('900 48px Orbitron'),
  document.fonts.load('700 48px Orbitron'),
  document.fonts.load('700 20px Rajdhani'),
  document.fonts.load('500 20px Rajdhani'),
]).catch(() => undefined);

async function start(): Promise<void> {
  await Promise.race([fontsReady, new Promise((r) => setTimeout(r, 1500))]);
  try {
    // glob import: resolves to nothing (instead of a compile error) if the module is absent
    const mods = import.meta.glob('./audio/AudioEngine.ts');
    const load = mods['./audio/AudioEngine.ts'];
    if (load) {
      const mod = (await load()) as { AudioEngine: new (events: unknown, isFocus: (car: unknown) => boolean) => unknown };
      const isFocus = (car: unknown) => car === game.rig.target;
      app.setAudio(new mod.AudioEngine(game.events, isFocus) as never);
    }
  } catch (err) {
    console.warn('[audio] unavailable', err);
  }
  await app.boot(params);
  if (params.get('speed')) game.debugTimeScale = Number(params.get('speed')) || 1;
}

// Automation / debugging hooks (used for verification in the browser pane).
Object.assign(window, {
  __game: {
    app,
    game,
    errors,
    get ready() {
      return !!game.session && app.state !== 'loading' && app.state !== 'boot';
    },
    state: () => {
      const s = game.session;
      if (!s) return null;
      return {
        app: app.state,
        session: s.state,
        mode: s.cfg.mode,
        time: s.time,
        cars: s.cars.map((c) => ({
          name: c.name,
          pos: c.position,
          lap: c.lap,
          progress: +c.body.progress.toFixed(1),
          kmh: +c.body.speedKmh.toFixed(0),
          d: +c.body.d.toFixed(2),
          finished: c.finished,
          best: c.bestLap,
          walls: c.wallHits,
        })),
      };
    },
    perf: () => game.perf(),
    /** Advance simulation only (no render) — works while rAF is paused. */
    simulate: (sec: number) => game.simulate(sec),
    /** Advance n real frames incl. UI/audio/render. */
    frames: (n: number, dt = 1 / 60) => {
      for (let i = 0; i < n; i++) game.frame(dt);
    },
    renderOnce: () => game.renderOnce(),
    setTimeScale: (x: number) => (game.debugTimeScale = x),
    press: (code: string, ms = 120) => {
      window.dispatchEvent(new KeyboardEvent('keydown', { code, bubbles: true }));
      setTimeout(() => window.dispatchEvent(new KeyboardEvent('keyup', { code, bubbles: true })), ms);
    },
    step: STEP,
  },
});

start().catch((err) => {
  console.error(err);
  errors.push(String(err?.stack ?? err));
});
