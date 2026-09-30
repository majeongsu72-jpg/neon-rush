import { clamp } from './math';

export interface CarInput {
  throttle: number; // 0..1
  brake: number; // 0..1
  steer: number; // -1 (left) .. 1 (right)
  drift: boolean;
  nitro: boolean;
}

export const emptyInput = (): CarInput => ({ throttle: 0, brake: 0, steer: 0, drift: false, nitro: false });

export type MenuAction = 'up' | 'down' | 'left' | 'right' | 'confirm' | 'back';
export type GameAction = 'camera' | 'reset' | 'pause' | 'mute' | 'fps' | 'fullscreen';

const BLOCK_DEFAULT = new Set([
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space', 'Tab', 'F3',
]);

const KEY_MENU: Record<string, MenuAction> = {
  ArrowUp: 'up', KeyW: 'up',
  ArrowDown: 'down', KeyS: 'down',
  ArrowLeft: 'left', KeyA: 'left',
  ArrowRight: 'right', KeyD: 'right',
  Enter: 'confirm', NumpadEnter: 'confirm', Space: 'confirm',
  Escape: 'back', Backspace: 'back',
};

const KEY_ACTION: Record<string, GameAction> = {
  KeyC: 'camera', KeyV: 'camera',
  KeyR: 'reset',
  Escape: 'pause', KeyP: 'pause',
  KeyM: 'mute',
  F3: 'fps', Backquote: 'fps',
  KeyF: 'fullscreen',
};

// Standard gamepad mapping
const GP = { A: 0, B: 1, X: 2, Y: 3, LB: 4, RB: 5, LT: 6, RT: 7, VIEW: 8, START: 9, UP: 12, DOWN: 13, LEFT: 14, RIGHT: 15 };

export class Input {
  readonly drive: CarInput = emptyInput();
  lookBack = false;
  lastDevice: 'keyboard' | 'gamepad' = 'keyboard';
  /** Any key/button was pressed since last consume (used for "press any key"). */
  anyPressed = false;

  private held = new Set<string>();
  private menuQueue: MenuAction[] = [];
  private actionQueue: GameAction[] = [];
  private gpPrev: boolean[] = [];
  private gpRepeat = new Map<number, number>();
  private gpAxisRepeat = { dir: '' as '' | MenuAction, t: 0 };
  private rumbleCooldown = 0;
  private enabled = true;

  constructor(target: Window = window) {
    target.addEventListener('keydown', (e) => this.onKey(e, true));
    target.addEventListener('keyup', (e) => this.onKey(e, false));
    target.addEventListener('blur', () => this.held.clear());
    target.addEventListener('pointerdown', () => {
      this.anyPressed = true;
    });
  }

  private onKey(e: KeyboardEvent, down: boolean): void {
    if (BLOCK_DEFAULT.has(e.code)) e.preventDefault();
    if (!this.enabled) return;
    this.lastDevice = 'keyboard';
    if (down) {
      this.anyPressed = true;
      const m = KEY_MENU[e.code];
      if (m) this.menuQueue.push(m);
      if (!e.repeat) {
        this.held.add(e.code);
        const a = KEY_ACTION[e.code];
        if (a) this.actionQueue.push(a);
      }
    } else {
      this.held.delete(e.code);
    }
  }

  /** Poll gamepads and rebuild the combined driving input. Call once per frame. */
  update(dt: number): void {
    this.rumbleCooldown = Math.max(0, this.rumbleCooldown - dt);
    const k = this.held;
    let throttle = k.has('ArrowUp') || k.has('KeyW') ? 1 : 0;
    let brake = k.has('ArrowDown') || k.has('KeyS') ? 1 : 0;
    let steer = (k.has('ArrowRight') || k.has('KeyD') ? 1 : 0) - (k.has('ArrowLeft') || k.has('KeyA') ? 1 : 0);
    let drift = k.has('Space');
    let nitro = k.has('ShiftLeft') || k.has('ShiftRight') || k.has('KeyN');
    let lookBack = k.has('KeyB');

    const pad = this.getPad();
    if (pad) {
      const btn = (i: number) => !!pad.buttons[i]?.pressed;
      const val = (i: number) => pad.buttons[i]?.value ?? 0;
      const lx = pad.axes[0] ?? 0;
      const ly = pad.axes[1] ?? 0;
      const dz = 0.14;
      const sx = Math.abs(lx) < dz ? 0 : Math.sign(lx) * Math.pow((Math.abs(lx) - dz) / (1 - dz), 1.35);
      const rt = val(GP.RT);
      const lt = val(GP.LT);
      const padActive = Math.abs(sx) > 0 || rt > 0.05 || lt > 0.05 || pad.buttons.some((b) => b.pressed);
      if (padActive) this.lastDevice = 'gamepad';
      throttle = Math.max(throttle, rt);
      brake = Math.max(brake, lt);
      if (Math.abs(sx) > Math.abs(steer)) steer = sx;
      drift = drift || btn(GP.B) || btn(GP.X) || btn(GP.LB);
      nitro = nitro || btn(GP.A);
      lookBack = lookBack || btn(GP.RB);

      // Edge-triggered buttons
      const edge = (i: number) => btn(i) && !this.gpPrev[i];
      if (edge(GP.Y)) this.actionQueue.push('camera');
      if (edge(GP.START)) this.actionQueue.push('pause');
      if (edge(GP.VIEW)) this.actionQueue.push('reset');
      for (let i = 0; i < pad.buttons.length; i++) if (edge(i)) this.anyPressed = true;

      // Menu navigation with auto-repeat
      const menuBtn: [number, MenuAction][] = [
        [GP.UP, 'up'], [GP.DOWN, 'down'], [GP.LEFT, 'left'], [GP.RIGHT, 'right'], [GP.A, 'confirm'], [GP.B, 'back'],
      ];
      for (const [i, act] of menuBtn) {
        if (edge(i)) {
          this.menuQueue.push(act);
          this.gpRepeat.set(i, 0.38);
        } else if (btn(i) && (act !== 'confirm' && act !== 'back')) {
          const t = (this.gpRepeat.get(i) ?? 0.38) - dt;
          if (t <= 0) {
            this.menuQueue.push(act);
            this.gpRepeat.set(i, 0.09);
          } else this.gpRepeat.set(i, t);
        }
      }
      // Left stick as menu d-pad
      let dir: '' | MenuAction = '';
      if (ly < -0.6) dir = 'up';
      else if (ly > 0.6) dir = 'down';
      else if (lx < -0.6) dir = 'left';
      else if (lx > 0.6) dir = 'right';
      if (dir !== this.gpAxisRepeat.dir) {
        this.gpAxisRepeat.dir = dir;
        this.gpAxisRepeat.t = 0.38;
        if (dir) this.menuQueue.push(dir);
      } else if (dir) {
        this.gpAxisRepeat.t -= dt;
        if (this.gpAxisRepeat.t <= 0) {
          this.menuQueue.push(dir);
          this.gpAxisRepeat.t = 0.1;
        }
      }
      this.gpPrev = pad.buttons.map((b) => b.pressed);
    }

    const d = this.drive;
    d.throttle = clamp(throttle, 0, 1);
    d.brake = clamp(brake, 0, 1);
    d.steer = clamp(steer, -1, 1);
    d.drift = drift;
    d.nitro = nitro;
    this.lookBack = lookBack;
  }

  private getPad(): Gamepad | null {
    if (!navigator.getGamepads) return null;
    let pads: (Gamepad | null)[];
    try {
      pads = navigator.getGamepads();
    } catch {
      return null; // blocked by permissions policy (e.g. sandboxed iframe)
    }
    for (const p of pads) if (p && p.connected && p.mapping === 'standard') return p;
    for (const p of pads) if (p && p.connected) return p;
    return null;
  }

  consumeMenu(): MenuAction[] {
    const q = this.menuQueue;
    this.menuQueue = [];
    return q;
  }

  consumeActions(): GameAction[] {
    const q = this.actionQueue;
    this.actionQueue = [];
    return q;
  }

  clearQueues(): void {
    this.menuQueue.length = 0;
    this.actionQueue.length = 0;
    this.anyPressed = false;
  }

  isHeld(code: string): boolean {
    return this.held.has(code);
  }

  /** Gamepad haptics. strong/weak in 0..1. */
  rumble(strong: number, weak: number, ms: number): void {
    if (this.rumbleCooldown > 0 || this.lastDevice !== 'gamepad') return;
    const pad = this.getPad();
    const act = (pad as unknown as { vibrationActuator?: { playEffect?: (t: string, p: object) => Promise<unknown> } })
      ?.vibrationActuator;
    if (!act?.playEffect) return;
    this.rumbleCooldown = 0.05;
    act
      .playEffect('dual-rumble', {
        startDelay: 0,
        duration: ms,
        strongMagnitude: clamp(strong, 0, 1),
        weakMagnitude: clamp(weak, 0, 1),
      })
      .catch(() => {});
  }

  setEnabled(v: boolean): void {
    this.enabled = v;
    if (!v) this.held.clear();
  }
}
