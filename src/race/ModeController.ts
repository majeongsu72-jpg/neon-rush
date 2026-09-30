import type * as THREE from 'three';
import type { Game } from '../game/Game';
import type { Session } from './Session';
import type { Hud, HudModel } from '../ui/Hud';
import type { MapDot } from '../ui/Gauges';
import type { ResultsData } from '../ui/Menus';
import type { Vehicle } from '../vehicle/Vehicle';
import { formatInt } from '../core/math';

export interface AudioOther {
  id: number;
  pos: THREE.Vector3;
  velocity: THREE.Vector3;
  rpm: number;
  rpmNorm: number;
  throttle: number;
  engine: Vehicle['spec']['engine'];
  redline: number;
}

export abstract class ModeController {
  readonly game: Game;
  readonly session: Session;
  readonly hud: Hud;

  constructor(game: Game, session: Session, hud: Hud) {
    this.game = game;
    this.session = session;
    this.hud = hud;
  }

  update(_dt: number): void {}
  fillHud(_hm: HudModel): void {}
  mapDots(_dots: MapDot[]): void {}
  audioOthers(_list: AudioOther[]): void {}
  isOver(): boolean {
    return this.session.state === 'finished';
  }
  abstract results(): ResultsData;
  dispose(): void {}

  protected commonStats(): { k: string; v: string }[] {
    const p = this.session.player!;
    return [
      { k: '최고 속도', v: `${Math.round(p.topSpeed)} km/h` },
      { k: '드리프트 점수', v: formatInt(p.driftTotal) },
      { k: '니어미스', v: String(p.nearMisses) },
      { k: '공중 체공', v: `${p.airTotal.toFixed(1)}s` },
    ];
  }
}

