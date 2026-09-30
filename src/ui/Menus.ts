import type { MenuAction } from '../core/Input';
import { CARS } from '../vehicle/specs';
import { settings, type QualityLevel, type Difficulty, type SettingsData } from '../core/Settings';
import { getRecords } from '../core/Storage';
import { drawTrackThumb } from './Gauges';
import { formatInt, formatTime } from '../core/math';
import type { Track } from '../track/Track';

export type ModeId = 'race' | 'timeattack' | 'rush';

export interface Selection {
  mode: ModeId;
  car: string;
  paint: number;
  track: string;
  difficulty: Difficulty;
}

export interface TrackCard {
  id: string;
  name: string;
  nameKo: string;
  subtitle: string;
  track: Track;
  colors: [string, string];
}

export interface ResultsData {
  mode: ModeId;
  title: string;
  subtitle: string;
  record: string | null;
  rows: { pos: string; name: string; time: string; best: string; me: boolean }[];
  stats: { k: string; v: string }[];
}

export interface MenuDeps {
  sound(name: 'move' | 'select' | 'back' | 'start' | 'error'): void;
  previewCar(carId: string, paint: number): void;
  tracks(): TrackCard[];
  start(sel: Selection): void;
  resume(): void;
  restart(): void;
  quit(): void;
  enterCarSelect(on: boolean): void;
  settingChanged(key: keyof SettingsData): void;
  unlock(): void;
}

type Screen = 'title' | 'main' | 'car' | 'track' | 'settings' | 'controls' | 'pause' | 'results' | 'loading' | 'none';

const MODES: { id: ModeId | 'settings' | 'controls'; en: string; ko: string; desc: string }[] = [
  { id: 'race', en: 'RACE', ko: '레이스', desc: '7대의 라이벌과 3랩 승부. 드리프트 부스트·니트로·슬립스트림으로 추월하라.' },
  { id: 'timeattack', en: 'TIME ATTACK', ko: '타임 어택', desc: '혼자 달리며 최고 랩에 도전. 최고 기록은 홀로그램 고스트로 따라온다.' },
  { id: 'rush', en: 'HIGHWAY RUSH', ko: '하이웨이 러시', desc: '교통 차량 사이를 칼치기! 체크포인트로 시간을 연장하고 니어미스로 점수를 쌓아라.' },
  { id: 'settings', en: 'SETTINGS', ko: '설정', desc: '그래픽 품질, 속도 효과, 사운드, 단위 등을 조절합니다.' },
  { id: 'controls', en: 'CONTROLS', ko: '조작법', desc: '키보드와 게임패드 조작 방법.' },
];

const DIFFS: { id: Difficulty; ko: string }[] = [
  { id: 'easy', ko: '쉬움' },
  { id: 'normal', ko: '보통' },
  { id: 'hard', ko: '어려움' },
  { id: 'insane', ko: '광란' },
];

const TIPS = [
  '<b>Space</b>를 누른 채 방향키를 꺾으면 드리프트. 오래 유지할수록 <b>파랑 → 주황 → 보라</b> 부스트가 충전됩니다.',
  '앞차 바로 뒤에 붙으면 <b>슬립스트림</b>이 쌓이고, 옆으로 빠지는 순간 <b>SLINGSHOT</b> 가속!',
  '카운트다운 중 RPM을 <b>초록 구간</b>에 맞춰 두면 퍼펙트 스타트 부스트를 받습니다.',
  '<b>Shift</b>로 니트로 발동. 니어미스·드리프트·추월·공중부양으로 게이지가 찹니다.',
  '<b>C</b>로 카메라 전환, <b>B</b>를 누르면 뒤를 볼 수 있습니다.',
  '벽을 긁으면 속도를 크게 잃습니다. 코너 진입 전 짧게 브레이크를 밟아 보세요.',
  '하이웨이 러시에서는 <b>좌측 역주행 차선</b>을 달리면 점수가 2배!',
];

function h<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, html?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html !== undefined) e.innerHTML = html;
  return e;
}

const hint = (items: [string, string][]) =>
  `<div class="hint-bar">${items.map(([k, t]) => `<span><span class="key">${k}</span>${t}</span>`).join('')}</div>`;

export class Menus {
  readonly root: HTMLDivElement;
  private deps: MenuDeps;
  private screen: Screen = 'none';
  private el: HTMLDivElement | null = null;
  private idx = 0;
  sel: Selection;
  private carIdx = 0;
  private trackIdx = 0;
  private trackFocus: 'cards' | 'diff' | 'go' = 'cards';
  private settingsIdx = 0;
  private settingsReturn: Screen = 'main';
  private results: ResultsData | null = null;
  private loadingBar: HTMLElement | null = null;
  private loadingLbl: HTMLElement | null = null;

  constructor(parent: HTMLElement, deps: MenuDeps) {
    this.root = h('div', 'layer');
    this.root.id = 'screens';
    parent.appendChild(this.root);
    // The menus are laid out for ~1280×740; in smaller windows (an embedded frame,
    // a small laptop) scale the whole layer down instead of letting panels collide.
    // Zoom scales viewport units too, so the menu CSS uses --vw/--vh: 1% of the
    // viewport measured in the layer's own (zoomed) pixels — proportions stay put.
    const fit = () => {
      let z = Math.max(0.5, Math.min(1, window.innerWidth / 1280, window.innerHeight / 740));
      if (z >= 0.995) z = 1;
      this.root.style.zoom = z < 1 ? z.toFixed(3) : '';
      this.root.style.setProperty('--vw', `${(window.innerWidth / z / 100).toFixed(3)}px`);
      this.root.style.setProperty('--vh', `${(window.innerHeight / z / 100).toFixed(3)}px`);
    };
    fit();
    window.addEventListener('resize', fit);
    this.deps = deps;
    this.sel = {
      mode: 'race',
      car: settings.get('car'),
      paint: settings.get('paint'),
      track: settings.get('track'),
      difficulty: settings.get('difficulty'),
    };
    this.carIdx = Math.max(0, CARS.findIndex((c) => c.id === this.sel.car));
  }

  get current(): Screen {
    return this.screen;
  }

  show(s: Screen): void {
    const prev = this.el;
    if (prev) {
      prev.classList.remove('on');
      setTimeout(() => prev.remove(), 380);
    }
    if (this.screen === 'car' && s !== 'car') this.deps.enterCarSelect(false);
    this.screen = s;
    this.el = null;
    this.idx = 0;
    if (s === 'none') return;
    const e = h('div', 'screen');
    this.el = e;
    this.root.appendChild(e);
    this.render();
    requestAnimationFrame(() => e.classList.add('on'));
    setTimeout(() => e.classList.add('on'), 30);
    if (s === 'car') this.deps.enterCarSelect(true);
  }

  showResults(r: ResultsData): void {
    this.results = r;
    this.show('results');
  }

  setLoading(p: number, label: string): void {
    if (this.loadingBar) this.loadingBar.style.width = `${Math.round(p * 100)}%`;
    if (this.loadingLbl) this.loadingLbl.textContent = label;
  }

  // ------------------------------------------------------------------ render
  private render(): void {
    const e = this.el!;
    e.innerHTML = '';
    switch (this.screen) {
      case 'title':
        e.innerHTML = `<div class="scrim"></div>
          <div class="logo"><div class="word">NEON<br>RUSH</div><div class="ko">네온질주</div>
          <div class="tag">PROCEDURAL HYPER-SPEED ARCADE RACER</div></div>
          <div class="press">PRESS ANY KEY<span class="ko">아무 키나 누르거나 클릭하세요</span></div>`;
        e.addEventListener('pointerdown', () => this.act('confirm'));
        break;
      case 'main':
        this.renderMain(e);
        break;
      case 'car':
        this.renderCar(e);
        break;
      case 'track':
        this.renderTrack(e);
        break;
      case 'settings':
        this.renderSettings(e);
        break;
      case 'controls':
        this.renderControls(e);
        break;
      case 'pause':
        this.renderPause(e);
        break;
      case 'results':
        this.renderResults(e);
        break;
      case 'loading': {
        const tip = TIPS[Math.floor(Math.random() * TIPS.length)];
        e.innerHTML = `<div class="loading"><div class="t">LOADING</div><div class="bar"><i></i></div><div class="lbl">준비 중…</div><div class="tip">TIP · ${tip}</div></div>`;
        this.loadingBar = e.querySelector('.bar i');
        this.loadingLbl = e.querySelector('.lbl');
        break;
      }
    }
  }

  private renderMain(e: HTMLDivElement): void {
    e.innerHTML = `<div class="scrim left"></div>
      <div class="logo" style="top:calc(var(--vh) * 7)"><div class="word" style="font-size:clamp(44px,calc(var(--vw) * 6),92px)">NEON<br>RUSH</div><div class="ko">네온질주</div></div>
      <div class="menu main-menu"></div>${hint([['↑↓', '선택'], ['ENTER', '결정'], ['ESC', '뒤로']])}`;
    const m = e.querySelector('.menu')!;
    MODES.forEach((mo, i) => {
      const it = h('div', 'item', `<span class="en">${mo.en}</span><span class="ko">${mo.ko}</span>`);
      it.addEventListener('pointerenter', () => {
        if (this.idx !== i) {
          this.idx = i;
          this.deps.sound('move');
          this.refreshMain();
        }
      });
      it.addEventListener('click', () => {
        this.idx = i;
        this.act('confirm');
      });
      m.appendChild(it);
    });
    m.appendChild(h('div', 'desc'));
    this.refreshMain();
  }

  private refreshMain(): void {
    const e = this.el!;
    e.querySelectorAll('.menu .item').forEach((it, i) => it.classList.toggle('sel', i === this.idx));
    const d = e.querySelector('.menu .desc');
    if (d) d.textContent = MODES[this.idx].desc;
  }

  private renderCar(e: HTMLDivElement): void {
    e.innerHTML = `<div class="scrim left" style="background:linear-gradient(90deg,rgba(4,2,14,.85),rgba(4,2,14,.2) 40%,transparent 60%)"></div>
      <div class="panel-title"><div class="en">SELECT CAR</div><div class="ko">차량 선택</div></div>
      <div class="car-info"></div>
      <div class="arrows"><div class="arrow-btn" data-a="left">◀</div><div class="car-index"></div><div class="arrow-btn" data-a="right">▶</div></div>
      <div class="go-btn">NEXT ▶</div>
      ${hint([['←→', '차량'], ['↑↓', '도색'], ['ENTER', '결정'], ['ESC', '뒤로']])}`;
    e.querySelectorAll<HTMLElement>('.arrow-btn').forEach((b) => b.addEventListener('click', () => this.act(b.dataset.a as MenuAction)));
    e.querySelector('.go-btn')!.addEventListener('click', () => this.act('confirm'));
    this.refreshCar();
  }

  private refreshCar(): void {
    const e = this.el!;
    const car = CARS[this.carIdx];
    const paint = car.paints[this.sel.paint % car.paints.length];
    const stat = (k: string, v: number) => `<div class="stat"><span>${k}</span><div class="bar"><i style="width:${v * 10}%"></i></div></div>`;
    const info = e.querySelector('.car-info')!;
    info.innerHTML = `<div class="car-name">${car.name}</div><div class="car-ko">${car.nameKo}</div>
      <div class="car-tag">${car.tagline}</div>
      ${stat('최고속도', car.stats.speed)}${stat('가속', car.stats.accel)}${stat('핸들링', car.stats.handling)}${stat('드리프트', car.stats.drift)}${stat('니트로', car.stats.nitro)}
      <div class="paints">${car.paints
        .map((p, i) => `<div class="sw${i === this.sel.paint % car.paints.length ? ' sel' : ''}" data-i="${i}" style="background:#${p.color.toString(16).padStart(6, '0')}"></div>`)
        .join('')}<span class="pname">${paint.name}</span></div>
      <div style="margin-top:16px;font-family:var(--font-num);font-size:13px;color:var(--ink-dim)">TOP ${Math.round(car.vTop * 3.6)} KM/H · 0-100 ${(27.8 / car.accel).toFixed(1)}s</div>`;
    info.querySelectorAll<HTMLElement>('.sw').forEach((s) =>
      s.addEventListener('click', () => {
        this.sel.paint = Number(s.dataset.i);
        this.deps.sound('move');
        this.refreshCar();
      }),
    );
    // re-trigger bar animation
    requestAnimationFrame(() => info.querySelectorAll<HTMLElement>('.bar i').forEach((b) => (b.style.width = b.style.width)));
    const ci = e.querySelector('.car-index');
    if (ci) ci.textContent = `${this.carIdx + 1} / ${CARS.length}`;
    this.sel.car = car.id;
    this.deps.previewCar(car.id, this.sel.paint % car.paints.length);
  }

  private renderTrack(e: HTMLDivElement): void {
    const cards = this.deps.tracks();
    const rec = getRecords();
    const isRace = this.sel.mode === 'race';
    e.innerHTML = `<div class="scrim"></div>
      <div class="panel-title"><div class="en">SELECT TRACK</div><div class="ko">트랙 선택 · ${MODES.find((m) => m.id === this.sel.mode)?.ko ?? ''}</div></div>
      <div class="track-stage"><div class="tracks"></div>
      ${isRace ? '<div class="opt-row"><span class="lbl">난이도</span></div>' : ''}</div>
      <div class="go-btn">START ▶</div>
      ${hint([['←→', '선택'], ['↓', isRace ? '난이도' : '시작 버튼'], ['ENTER', '시작'], ['ESC', '뒤로']])}`;
    const wrap = e.querySelector('.tracks')!;
    this.trackIdx = Math.max(0, cards.findIndex((c) => c.id === this.sel.track));
    cards.forEach((c, i) => {
      const best =
        this.sel.mode === 'rush'
          ? rec.rushHigh[c.id] !== undefined ? formatInt(rec.rushHigh[c.id]) : '---'
          : rec.bestLapAny[c.id] !== undefined ? formatTime(rec.bestLapAny[c.id]) : '-:--.---';
      const card = h(
        'div',
        'tcard',
        `<canvas></canvas><div class="tn">${c.name}</div><div class="tk">${c.nameKo}</div><div class="td">${c.subtitle}</div>
         <div class="tr"><span>${(c.track.length / 1000).toFixed(2)} KM</span><span>${this.sel.mode === 'rush' ? 'HIGH' : 'BEST'} <b>${best}</b></span></div>`,
      );
      card.addEventListener('pointerenter', () => {
        if (this.trackIdx !== i) {
          this.trackIdx = i;
          this.trackFocus = 'cards';
          this.deps.sound('move');
          this.refreshTrack();
        }
      });
      card.addEventListener('click', () => {
        this.trackIdx = i;
        this.act('confirm');
      });
      wrap.appendChild(card);
      requestAnimationFrame(() => drawTrackThumb(card.querySelector('canvas')!, c.track, c.colors));
    });
    const row = e.querySelector('.opt-row');
    if (row) {
      DIFFS.forEach((d) => {
        const chip = h('div', 'chip', d.ko);
        chip.addEventListener('click', () => {
          this.sel.difficulty = d.id;
          this.deps.sound('move');
          this.refreshTrack();
        });
        row.appendChild(chip);
      });
    }
    e.querySelector('.go-btn')!.addEventListener('click', () => {
      this.trackFocus = 'go';
      this.act('confirm');
    });
    this.trackFocus = 'cards';
    this.refreshTrack();
  }

  private refreshTrack(): void {
    const e = this.el!;
    e.querySelectorAll('.tcard').forEach((c, i) => c.classList.toggle('sel', i === this.trackIdx));
    e.querySelectorAll('.chip').forEach((c, i) => c.classList.toggle('sel', DIFFS[i].id === this.sel.difficulty));
    e.querySelector('.opt-row')?.classList.toggle('focus', this.trackFocus === 'diff');
    e.querySelector('.go-btn')?.classList.toggle('focus', this.trackFocus === 'go');
    const cards = this.deps.tracks();
    this.sel.track = cards[this.trackIdx]?.id ?? this.sel.track;
  }

  // ---------------------------------------------------------------- settings
  private settingRows(): { key: keyof SettingsData; label: string; kind: 'enum' | 'range' | 'bool'; values?: (string | number | boolean)[]; names?: string[] }[] {
    return [
      { key: 'quality', label: '그래픽 품질', kind: 'enum', values: ['low', 'medium', 'high', 'ultra'], names: ['낮음', '중간', '높음', '최상'] },
      { key: 'dynamicResolution', label: '동적 해상도 (프레임 유지)', kind: 'bool' },
      { key: 'speedEffects', label: '속도 효과 (블러·스피드라인)', kind: 'range' },
      { key: 'steering', label: '조향 반응 속도', kind: 'range' },
      { key: 'cameraShake', label: '카메라 흔들림', kind: 'bool' },
      { key: 'reduceMotion', label: '모션 줄이기 (멀미 방지)', kind: 'bool' },
      { key: 'masterVolume', label: '전체 볼륨', kind: 'range' },
      { key: 'musicVolume', label: '음악 볼륨', kind: 'range' },
      { key: 'sfxVolume', label: '효과음 볼륨', kind: 'range' },
      { key: 'units', label: '속도 단위', kind: 'enum', values: ['kmh', 'mph'], names: ['KM/H', 'MPH'] },
      { key: 'showFps', label: 'FPS 표시', kind: 'bool' },
    ];
  }

  private renderSettings(e: HTMLDivElement): void {
    e.innerHTML = `<div class="scrim"></div>
      <div class="panel-title"><div class="en">SETTINGS</div><div class="ko">설정</div></div>
      <div class="settings"></div>${hint([['↑↓', '항목'], ['←→', '변경'], ['ESC', '뒤로']])}`;
    this.refreshSettings();
  }

  private refreshSettings(): void {
    const box = this.el!.querySelector('.settings')!;
    const rows = this.settingRows();
    box.innerHTML = '';
    rows.forEach((r, i) => {
      const v = settings.get(r.key);
      let val: string;
      if (r.kind === 'range') val = `<span class="arr">◀</span><span class="meter"><i style="width:${Math.round((v as number) * 100)}%"></i></span><span>${Math.round((v as number) * 100)}</span><span class="arr">▶</span>`;
      else if (r.kind === 'bool') val = `<span class="arr">◀</span><span>${v ? '켜짐 ON' : '꺼짐 OFF'}</span><span class="arr">▶</span>`;
      else {
        const k = r.values!.indexOf(v as string);
        val = `<span class="arr">◀</span><span>${r.names![k] ?? v}</span><span class="arr">▶</span>`;
      }
      const row = h('div', `srow${i === this.settingsIdx ? ' sel' : ''}`, `<span>${r.label}</span><span class="v">${val}</span>`);
      row.addEventListener('pointerenter', () => {
        if (this.settingsIdx !== i) {
          this.settingsIdx = i;
          this.refreshSettings();
        }
      });
      row.addEventListener('click', (ev) => {
        this.settingsIdx = i;
        const rect = row.getBoundingClientRect();
        this.changeSetting((ev as MouseEvent).clientX < rect.left + rect.width * 0.72 ? -1 : 1);
      });
      box.appendChild(row);
    });
  }

  private changeSetting(dir: number): void {
    const r = this.settingRows()[this.settingsIdx];
    const v = settings.get(r.key);
    if (r.kind === 'range') {
      settings.set(r.key, Math.round(Math.min(1, Math.max(0, (v as number) + dir * 0.1)) * 10) / 10 as never);
    } else if (r.kind === 'bool') {
      settings.set(r.key, !v as never);
    } else {
      const vals = r.values!;
      const k = (vals.indexOf(v as string) + dir + vals.length) % vals.length;
      settings.set(r.key, vals[k] as never);
    }
    this.deps.sound('move');
    this.deps.settingChanged(r.key);
    this.refreshSettings();
  }

  private renderControls(e: HTMLDivElement): void {
    const c = (a: string, b: string) => `<div class="c"><span>${a}</span><span>${b}</span></div>`;
    e.innerHTML = `<div class="scrim"></div>
      <div class="panel-title"><div class="en">CONTROLS</div><div class="ko">조작법</div></div>
      <div class="controls">
        <h3>KEYBOARD</h3>
        ${c('가속', '↑ / W')}${c('브레이크 · 후진', '↓ / S')}${c('조향', '← → / A D')}${c('드리프트', 'SPACE (+ 조향)')}
        ${c('니트로', 'SHIFT')}${c('카메라 전환', 'C')}${c('뒤보기', 'B')}${c('트랙 복귀', 'R')}
        ${c('일시정지', 'ESC / P')}${c('음악 켜기/끄기', 'M')}${c('전체화면', 'F')}${c('FPS 표시', 'F3')}
        <h3>GAMEPAD</h3>
        ${c('가속 / 브레이크', 'RT / LT')}${c('조향', 'L-STICK')}${c('드리프트', 'B · X · LB')}${c('니트로', 'A')}
        ${c('카메라', 'Y')}${c('뒤보기', 'RB')}${c('일시정지', 'START')}${c('트랙 복귀', 'VIEW')}
        <h3>TECHNIQUE</h3>
        <div class="c" style="grid-column:1/-1"><span>코너 진입 시 브레이크를 짧게 톡 치면서 꺾어도 드리프트가 시작됩니다. 드리프트를 길게 유지해 파랑→주황→보라 부스트를 모으세요.</span><span></span></div>
      </div>${hint([['ESC', '뒤로']])}`;
  }

  private renderPause(e: HTMLDivElement): void {
    e.innerHTML = `<div class="scrim" style="background:rgba(4,2,14,.62)"></div>
      <div class="pause-box"><div class="t">PAUSED</div><div class="menu"></div></div>`;
    const items = [
      ['RESUME', '계속하기'],
      ['RESTART', '재시작'],
      ['SETTINGS', '설정'],
      ['QUIT', '메인 메뉴'],
    ];
    const m = e.querySelector('.menu')!;
    items.forEach(([en, ko], i) => {
      const it = h('div', `item${i === 0 ? ' sel' : ''}`, `<span class="en">${en}</span><span class="ko">${ko}</span>`);
      it.addEventListener('pointerenter', () => {
        this.idx = i;
        this.refreshList();
      });
      it.addEventListener('click', () => {
        this.idx = i;
        this.act('confirm');
      });
      m.appendChild(it);
    });
  }

  private renderResults(e: HTMLDivElement): void {
    const r = this.results!;
    e.innerHTML = `<div class="scrim" style="background:rgba(4,2,14,.72)"></div>
      <div class="results">
        <div class="hero"><div class="place">${r.title}</div><div class="sub">${r.subtitle}</div>${r.record ? `<div class="rec">${r.record}</div>` : ''}</div>
        <div class="rtable">${r.rows
          .map((row, i) => `<div class="r${row.me ? ' me' : ''}" style="animation-delay:${0.15 + i * 0.06}s"><span>${row.pos}</span><span>${row.name}</span><span>${row.time}</span><span>${row.best}</span></div>`)
          .join('')}</div>
        <div class="rstats">${r.stats.map((s) => `<div class="s"><div class="k">${s.k}</div><div class="v">${s.v}</div></div>`).join('')}</div>
        <div class="menu"></div>
      </div>`;
    const m = e.querySelector('.menu')!;
    [
      ['RETRY', '다시 하기'],
      ['MENU', '메인 메뉴'],
    ].forEach(([en, ko], i) => {
      const it = h('div', `item${i === 0 ? ' sel' : ''}`, `<span class="en">${en}</span><span class="ko">${ko}</span>`);
      it.addEventListener('pointerenter', () => {
        this.idx = i;
        this.refreshList();
      });
      it.addEventListener('click', () => {
        this.idx = i;
        this.act('confirm');
      });
      m.appendChild(it);
    });
  }

  private refreshList(): void {
    this.el?.querySelectorAll('.menu .item').forEach((it, i) => it.classList.toggle('sel', i === this.idx));
  }

  // ------------------------------------------------------------------ input
  handle(actions: MenuAction[]): void {
    for (const a of actions) this.act(a);
  }

  private act(a: MenuAction): void {
    const d = this.deps;
    switch (this.screen) {
      case 'title':
        d.unlock();
        d.sound('start');
        this.show('main');
        return;
      case 'main': {
        if (a === 'up' || a === 'down') {
          this.idx = (this.idx + (a === 'down' ? 1 : -1) + MODES.length) % MODES.length;
          d.sound('move');
          this.refreshMain();
        } else if (a === 'confirm') {
          const m = MODES[this.idx];
          d.sound('select');
          if (m.id === 'settings') {
            this.settingsReturn = 'main';
            this.show('settings');
          } else if (m.id === 'controls') this.show('controls');
          else {
            this.sel.mode = m.id;
            this.show('car');
          }
        } else if (a === 'back') {
          d.sound('back');
          this.show('title');
        }
        return;
      }
      case 'car': {
        const car = CARS[this.carIdx];
        if (a === 'left' || a === 'right') {
          this.carIdx = (this.carIdx + (a === 'right' ? 1 : -1) + CARS.length) % CARS.length;
          this.sel.paint = 0;
          d.sound('move');
          this.refreshCar();
        } else if (a === 'up' || a === 'down') {
          this.sel.paint = (this.sel.paint + (a === 'down' ? 1 : -1) + car.paints.length) % car.paints.length;
          d.sound('move');
          this.refreshCar();
        } else if (a === 'confirm') {
          d.sound('select');
          settings.set('car', this.sel.car);
          settings.set('paint', this.sel.paint);
          this.show('track');
        } else if (a === 'back') {
          d.sound('back');
          this.show('main');
        }
        return;
      }
      case 'track': {
        const n = this.deps.tracks().length;
        const isRace = this.sel.mode === 'race';
        if (this.trackFocus === 'cards') {
          if (a === 'left' || a === 'right') {
            this.trackIdx = (this.trackIdx + (a === 'right' ? 1 : -1) + n) % n;
            d.sound('move');
          } else if (a === 'down') {
            this.trackFocus = isRace ? 'diff' : 'go';
            d.sound('move');
          } else if (a === 'confirm') {
            this.trackFocus = 'go';
            this.startSelected();
            return;
          }
        } else if (this.trackFocus === 'diff') {
          if (a === 'left' || a === 'right') {
            const k = DIFFS.findIndex((x) => x.id === this.sel.difficulty);
            this.sel.difficulty = DIFFS[(k + (a === 'right' ? 1 : -1) + DIFFS.length) % DIFFS.length].id;
            d.sound('move');
          } else if (a === 'up') this.trackFocus = 'cards';
          else if (a === 'down') this.trackFocus = 'go';
          else if (a === 'confirm') {
            this.startSelected();
            return;
          }
        } else {
          if (a === 'up') this.trackFocus = isRace ? 'diff' : 'cards';
          else if (a === 'confirm') {
            this.startSelected();
            return;
          }
        }
        if (a === 'back') {
          d.sound('back');
          this.show('car');
          return;
        }
        this.refreshTrack();
        return;
      }
      case 'settings': {
        const n = this.settingRows().length;
        if (a === 'up' || a === 'down') {
          this.settingsIdx = (this.settingsIdx + (a === 'down' ? 1 : -1) + n) % n;
          d.sound('move');
          this.refreshSettings();
        } else if (a === 'left' || a === 'right') this.changeSetting(a === 'right' ? 1 : -1);
        else if (a === 'confirm') this.changeSetting(1);
        else if (a === 'back') {
          d.sound('back');
          this.show(this.settingsReturn);
        }
        return;
      }
      case 'controls':
        if (a === 'back' || a === 'confirm') {
          d.sound('back');
          this.show('main');
        }
        return;
      case 'pause': {
        if (a === 'up' || a === 'down') {
          this.idx = (this.idx + (a === 'down' ? 1 : -1) + 4) % 4;
          d.sound('move');
          this.refreshList();
        } else if (a === 'confirm') {
          d.sound('select');
          if (this.idx === 0) d.resume();
          else if (this.idx === 1) d.restart();
          else if (this.idx === 2) {
            this.settingsReturn = 'pause';
            this.show('settings');
          } else d.quit();
        } else if (a === 'back') d.resume();
        return;
      }
      case 'results': {
        if (a === 'left' || a === 'right' || a === 'up' || a === 'down') {
          this.idx = 1 - this.idx;
          d.sound('move');
          this.refreshList();
        } else if (a === 'confirm') {
          d.sound('select');
          if (this.idx === 0) d.restart();
          else d.quit();
        }
        return;
      }
      default:
        return;
    }
  }

  private startSelected(): void {
    settings.set('track', this.sel.track);
    settings.set('difficulty', this.sel.difficulty);
    this.deps.sound('start');
    this.deps.start({ ...this.sel });
  }

  qualityOf(): QualityLevel {
    return settings.get('quality');
  }
}
