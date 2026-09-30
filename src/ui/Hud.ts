import { Speedometer, Minimap, type SpeedoState, type MapDot } from './Gauges';
import type { Track } from '../track/Track';
import { formatDelta, formatInt, formatTime, ordinal } from '../core/math';

export interface StandingRow {
  name: string;
  color: string;
  gap: string;
  me: boolean;
}

export interface HudModel {
  mode: 'race' | 'timeattack' | 'rush' | 'attract';
  position: number;
  total: number;
  lap: number;
  laps: number;
  raceTime: number;
  lapTime: number;
  bestLap: number;
  lastLap: number;
  delta: number | null;
  speedo: SpeedoState;
  standings: StandingRow[] | null;
  dots: MapDot[];
  heading: number;
  drift: { active: boolean; score: number; level: number };
  rush: { timeLeft: number; score: number; multiplier: number; oncoming: boolean; cpDist: number } | null;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, html?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html !== undefined) e.innerHTML = html;
  return e;
}

/** In-race heads-up display. DOM writes are skipped when values don't change. */
export class Hud {
  readonly root: HTMLDivElement;
  private speedo: Speedometer;
  private minimap: Minimap;
  private posEl: HTMLDivElement;
  private lapEl: HTMLDivElement;
  private timeMain: HTMLSpanElement;
  private timeBest: HTMLSpanElement;
  private timeLast: HTMLSpanElement;
  private deltaEl: HTMLDivElement;
  private tower: HTMLDivElement;
  private toasts: HTMLDivElement;
  private driftPop: HTMLDivElement;
  private cd: HTMLDivElement;
  private bannerHost: HTMLDivElement;
  private rushTop: HTMLDivElement;
  private rushScore: HTMLDivElement;
  private tl: HTMLDivElement;
  private tr: HTMLDivElement;
  private last = new Map<HTMLElement, string>();
  private towerTimer = 0;
  private wrongWayEl: HTMLDivElement | null = null;

  constructor(parent: HTMLElement) {
    this.root = el('div', 'layer');
    this.root.id = 'hud';
    parent.appendChild(this.root);

    this.tl = el('div', 'hud-tl');
    this.posEl = el('div', 'pos-big');
    this.lapEl = el('div', 'lap-box');
    this.tl.append(this.posEl, this.lapEl);

    this.tr = el('div', 'hud-tr');
    const row = (lbl: string, main = false) => {
      const r = el('div', 'time-row' + (main ? ' main' : ''));
      const v = el('span', 'val');
      r.append(el('span', 'lbl', lbl), v);
      this.tr.appendChild(r);
      return v;
    };
    this.timeMain = row('TIME', true);
    this.timeLast = row('LAST');
    this.timeBest = row('BEST');
    this.deltaEl = el('div', 'delta');
    this.tr.appendChild(this.deltaEl);

    this.tower = el('div', 'tower');
    const speedCanvas = el('canvas');
    speedCanvas.id = 'speedo';
    const mapCanvas = el('canvas');
    mapCanvas.id = 'minimap';
    this.speedo = new Speedometer(speedCanvas);
    this.minimap = new Minimap(mapCanvas);
    this.toasts = el('div', 'toasts');
    this.driftPop = el('div', 'drift-pop', '<div class="t">DRIFT</div><div class="v">0</div>');
    this.cd = el('div', 'countdown');
    this.bannerHost = el('div', 'layer');
    this.rushTop = el('div', 'rush-top hidden', '<div class="timer">0</div><div class="cp"></div>');
    this.rushScore = el('div', 'rush-score hidden', '<div class="score">0</div><div class="mult">x1.0</div><div class="oncoming">역주행 ONCOMING x2</div>');
    this.root.append(this.tl, this.tr, this.tower, speedCanvas, mapCanvas, this.driftPop, this.rushTop, this.rushScore);
    // messages stay visible even when the gauges are hidden (intro, finish)
    const msg = el('div', 'layer');
    msg.append(this.toasts, this.cd, this.bannerHost);
    parent.appendChild(msg);
    const fit = () => {
      const s = Math.max(0.55, Math.min(1, window.innerHeight / 940, window.innerWidth / 1600));
      this.root.style.setProperty('--s', s.toFixed(3));
      msg.style.setProperty('--s', s.toFixed(3));
    };
    fit();
    window.addEventListener('resize', fit);
  }

  setTrack(track: Track): void {
    this.minimap.setTrack(track);
  }

  show(on: boolean): void {
    this.root.classList.toggle('on', on);
  }

  private set(e: HTMLElement, html: string): void {
    if (this.last.get(e) === html) return;
    this.last.set(e, html);
    e.innerHTML = html;
  }

  update(m: HudModel, dt: number): void {
    const rush = m.mode === 'rush';
    const ta = m.mode === 'timeattack';
    this.rushTop.classList.toggle('hidden', !rush);
    this.rushScore.classList.toggle('hidden', !rush);
    this.tr.classList.toggle('hidden', rush);
    this.tower.classList.toggle('hidden', !m.standings);

    if (m.mode === 'race') {
      this.set(this.posEl, `${m.position}<sup>${ordinal(m.position)}</sup><small>/${m.total}</small>`);
    } else if (ta) {
      this.set(this.posEl, `<span style="font-size:40px">TIME ATTACK</span>`);
    } else {
      this.set(this.posEl, '');
    }
    if (!rush) {
      this.set(this.lapEl, `<div class="lbl">LAP</div><div class="val">${Math.min(m.laps, Math.max(1, m.lap))}<small>/${m.laps}</small></div>`);
      this.set(this.timeMain, formatTime(Math.max(0, ta ? m.lapTime : m.raceTime)));
      this.set(this.timeLast, m.lastLap > 0 ? formatTime(m.lastLap) : '-:--.---');
      this.set(this.timeBest, isFinite(m.bestLap) ? formatTime(m.bestLap) : '-:--.---');
      if (m.delta !== null) {
        this.set(this.deltaEl, formatDelta(m.delta));
        this.deltaEl.className = 'delta ' + (m.delta <= 0 ? 'good' : 'bad');
      } else this.set(this.deltaEl, '');
    } else {
      this.set(this.lapEl, '');
    }
    if (rush && m.rush) {
      const r = m.rush;
      const tEl = this.rushTop.firstElementChild as HTMLElement;
      this.set(tEl, r.timeLeft.toFixed(1));
      tEl.classList.toggle('low', r.timeLeft < 10);
      this.set(this.rushTop.lastElementChild as HTMLElement, `CHECKPOINT ${Math.max(0, Math.round(r.cpDist))} m`);
      const [sc, mu, on] = Array.from(this.rushScore.children) as HTMLElement[];
      this.set(sc, formatInt(r.score));
      this.set(mu, `x${r.multiplier.toFixed(1)}`);
      on.classList.toggle('on', r.oncoming);
    }

    this.towerTimer -= dt;
    if (m.standings && this.towerTimer <= 0) {
      this.towerTimer = 0.2;
      const html = m.standings
        .map(
          (r, i) =>
            `<div class="row${r.me ? ' me' : ''}"><span class="p">${i + 1}</span><span class="sw" style="background:${r.color}"></span><span class="n">${r.name}</span><span class="g">${r.gap}</span></div>`,
        )
        .join('');
      this.set(this.tower, html);
    }

    // drift popup
    const dp = this.driftPop;
    dp.classList.toggle('on', m.drift.active && m.drift.score > 30);
    if (m.drift.active) {
      const cols = ['#ffd27a', '#39a8ff', '#ff8a1f', '#c04bff'];
      dp.style.color = cols[m.drift.level] ?? '#fff';
      this.set(dp.lastElementChild as HTMLElement, formatInt(m.drift.score));
    }

    this.speedo.draw(m.speedo);
    this.minimap.draw(m.dots, m.heading);
  }

  toast(text: string, cls: 'good' | 'great' | 'gold' | 'warn' | 'info' = 'good', sub?: string, life = 1.5): void {
    // the same call-out again replaces the old one instead of stacking up
    for (const old of Array.from(this.toasts.children) as HTMLElement[]) if (old.dataset.k === text) old.remove();
    const t = el('div', `toast ${cls}`, sub ? `${text}<small>${sub}</small>` : text);
    t.dataset.k = text;
    t.style.setProperty('--life', `${life}s`);
    this.toasts.appendChild(t);
    while (this.toasts.children.length > 3) this.toasts.firstElementChild?.remove();
    setTimeout(() => t.remove(), (life + 0.6) * 1000);
  }

  banner(text: string, sub = '', cls = '', ms = 2400): void {
    const b = el('div', `banner ${cls}`, `${text}${sub ? `<span class="sub">${sub}</span>` : ''}`);
    this.bannerHost.appendChild(b);
    setTimeout(() => b.remove(), ms);
  }

  wrongWay(on: boolean): void {
    if (on && !this.wrongWayEl) {
      this.wrongWayEl = el('div', 'banner warn', 'WRONG WAY<span class="sub">역주행 중입니다 — 방향을 돌리세요</span>');
      this.wrongWayEl.style.animation = 'blink 0.5s steps(2) infinite';
      this.bannerHost.appendChild(this.wrongWayEl);
    } else if (!on && this.wrongWayEl) {
      this.wrongWayEl.remove();
      this.wrongWayEl = null;
    }
  }

  countdown(n: number): void {
    const c = this.cd;
    c.className = 'countdown';
    void c.offsetWidth; // restart animation
    if (n > 0) {
      c.textContent = String(n);
      c.classList.add('pop');
    } else {
      c.textContent = 'GO!';
      c.classList.add('go');
    }
  }

  clear(): void {
    this.toasts.innerHTML = '';
    this.bannerHost.innerHTML = '';
    this.cd.className = 'countdown';
    this.cd.textContent = '';
    this.wrongWayEl = null;
    this.last.clear();
  }
}
