import type { Track } from '../track/Track';
import { clamp } from '../core/math';

const TAU = Math.PI * 2;

export interface SpeedoState {
  speed: number; // display units
  unit: string;
  rpmNorm: number; // 0..1.05
  redline: number; // rpm
  gear: number;
  reverse: boolean;
  nitro: number; // 0..1
  nitroActive: boolean;
  drift: number; // 0..1 charge progress within current level
  driftLevel: number; // 0..3
  drifting: boolean;
  boost: boolean;
  startZone: boolean; // show perfect-start rev window
  time: number;
}

const DRIFT_COL = ['#ffd27a', '#39a8ff', '#ff8a1f', '#c04bff'];

/** Canvas tachometer + speed + nitro/drift arcs, drawn at device resolution. */
export class Speedometer {
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private size = 0;
  private dpr = 1;
  private displaySpeed = 0;
  private bg: HTMLCanvasElement | null = null;
  private lastRedline = -1;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d')!;
  }

  private fit(): void {
    const r = this.canvas.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const size = Math.round(Math.max(1, r.width) * dpr);
    if (size !== this.size || dpr !== this.dpr) {
      this.size = size;
      this.dpr = dpr;
      this.canvas.width = size;
      this.canvas.height = size;
      this.bg = null;
    }
  }

  // sweep: 225° from lower-left to lower-right
  private readonly a0 = Math.PI * 0.75;
  private readonly a1 = Math.PI * 2.25;

  private buildBackground(redline: number): void {
    const S = this.size;
    const c = document.createElement('canvas');
    c.width = c.height = S;
    const g = c.getContext('2d')!;
    const cx = S / 2, cy = S / 2, R = S * 0.44;
    const { a0, a1 } = this;
    // dark disc
    const grad = g.createRadialGradient(cx, cy, R * 0.2, cx, cy, R * 1.08);
    grad.addColorStop(0, 'rgba(6,4,18,0.78)');
    grad.addColorStop(0.8, 'rgba(6,4,18,0.55)');
    grad.addColorStop(1, 'rgba(6,4,18,0)');
    g.fillStyle = grad;
    g.beginPath();
    g.arc(cx, cy, R * 1.08, 0, TAU);
    g.fill();
    // tick marks
    const k = Math.ceil(redline / 1000) + 1;
    for (let i = 0; i <= k * 2; i++) {
      const f = i / (k * 2);
      const a = a0 + (a1 - a0) * f;
      const major = i % 2 === 0;
      const r0 = R * (major ? 0.8 : 0.85), r1 = R * 0.92;
      const rpm = f * k * 1000;
      g.strokeStyle = rpm >= redline * 0.9 ? 'rgba(255,59,92,0.9)' : major ? 'rgba(238,242,255,0.85)' : 'rgba(238,242,255,0.35)';
      g.lineWidth = (major ? 3 : 1.5) * this.dpr;
      g.beginPath();
      g.moveTo(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0);
      g.lineTo(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1);
      g.stroke();
      if (major) {
        g.fillStyle = rpm >= redline * 0.9 ? '#ff3b5c' : 'rgba(238,242,255,0.75)';
        g.font = `700 ${Math.round(S * 0.045)}px Orbitron, sans-serif`;
        g.textAlign = 'center';
        g.textBaseline = 'middle';
        const rt = R * 0.68;
        g.fillText(String(i / 2), cx + Math.cos(a) * rt, cy + Math.sin(a) * rt);
      }
    }
    // redline band
    const fr = (redline * 0.9) / (k * 1000);
    g.strokeStyle = 'rgba(255,59,92,0.55)';
    g.lineWidth = 5 * this.dpr;
    g.beginPath();
    g.arc(cx, cy, R * 0.955, a0 + (a1 - a0) * fr, a0 + (a1 - a0) * Math.min(1, redline / (k * 1000)));
    g.stroke();
    g.fillStyle = 'rgba(238,242,255,0.45)';
    g.font = `600 ${Math.round(S * 0.034)}px Rajdhani, sans-serif`;
    g.textAlign = 'center';
    g.fillText('x1000 RPM', cx, cy + R * 0.46);
    this.bg = c;
    this.lastRedline = redline;
  }

  draw(s: SpeedoState): void {
    this.fit();
    const S = this.size;
    if (S < 4) return;
    if (!this.bg || this.lastRedline !== s.redline) this.buildBackground(s.redline);
    const g = this.ctx;
    const cx = S / 2, cy = S / 2, R = S * 0.44;
    const { a0, a1 } = this;
    g.clearRect(0, 0, S, S);
    g.drawImage(this.bg!, 0, 0);
    const k = Math.ceil(s.redline / 1000) + 1;
    const rpmF = clamp((s.rpmNorm * s.redline) / (k * 1000), 0, 1);
    const shift = s.rpmNorm > 0.95;
    const flash = shift && Math.floor(s.time * 14) % 2 === 0;

    // perfect-start window
    if (s.startZone) {
      const z0 = (0.6 * s.redline) / (k * 1000), z1 = (0.84 * s.redline) / (k * 1000);
      g.strokeStyle = 'rgba(61,255,162,0.55)';
      g.lineWidth = 10 * this.dpr;
      g.beginPath();
      g.arc(cx, cy, R * 0.955, a0 + (a1 - a0) * z0, a0 + (a1 - a0) * z1);
      g.stroke();
    }
    // rpm arc
    const ag = g.createLinearGradient(cx - R, cy, cx + R, cy);
    ag.addColorStop(0, '#19f5ff');
    ag.addColorStop(0.65, '#8a5bff');
    ag.addColorStop(1, '#ff2bd6');
    g.save();
    g.shadowColor = flash ? '#ff3b5c' : '#19f5ff';
    g.shadowBlur = 16 * this.dpr;
    g.strokeStyle = flash ? '#ff3b5c' : ag;
    g.lineWidth = 7 * this.dpr;
    g.lineCap = 'round';
    g.beginPath();
    g.arc(cx, cy, R * 0.955, a0, a0 + (a1 - a0) * rpmF);
    g.stroke();
    g.restore();
    // needle
    const na = a0 + (a1 - a0) * rpmF;
    g.save();
    g.strokeStyle = '#ffffff';
    g.shadowColor = '#ff2bd6';
    g.shadowBlur = 10 * this.dpr;
    g.lineWidth = 3 * this.dpr;
    g.beginPath();
    g.moveTo(cx + Math.cos(na) * R * 0.3, cy + Math.sin(na) * R * 0.3);
    g.lineTo(cx + Math.cos(na) * R * 0.9, cy + Math.sin(na) * R * 0.9);
    g.stroke();
    g.restore();

    // nitro arc (inner, 3 segments)
    const nr = R * 0.56;
    const na0 = Math.PI * 0.82, na1 = Math.PI * 2.18;
    const seg = (na1 - na0) / 3;
    for (let i = 0; i < 3; i++) {
      const s0 = na0 + seg * i + 0.03, s1 = na0 + seg * (i + 1) - 0.03;
      g.strokeStyle = 'rgba(255,255,255,0.08)';
      g.lineWidth = 6 * this.dpr;
      g.beginPath();
      g.arc(cx, cy, nr, s0, s1);
      g.stroke();
      const fill = clamp(s.nitro * 3 - i, 0, 1);
      if (fill > 0) {
        g.save();
        const full = fill >= 1;
        g.shadowColor = '#3aa0ff';
        g.shadowBlur = (full ? 14 : 6) * this.dpr * (s.nitroActive ? 1.5 : 1);
        g.strokeStyle = s.nitroActive ? (Math.floor(s.time * 20) % 2 ? '#bff6ff' : '#3aa0ff') : full ? '#5ac8ff' : '#2a6cff';
        g.beginPath();
        g.arc(cx, cy, nr, s0, s0 + (s1 - s0) * fill);
        g.stroke();
        g.restore();
      }
    }
    // drift charge (outer thin arc)
    if (s.drifting) {
      const col = DRIFT_COL[Math.min(3, s.driftLevel + (s.driftLevel < 3 ? 1 : 0))];
      g.save();
      g.strokeStyle = col;
      g.shadowColor = col;
      g.shadowBlur = 14 * this.dpr;
      g.lineWidth = 4 * this.dpr;
      g.beginPath();
      g.arc(cx, cy, R * 1.04, a0, a0 + (a1 - a0) * clamp(s.drift, 0, 1));
      g.stroke();
      g.restore();
    }

    // speed digits
    this.displaySpeed += (s.speed - this.displaySpeed) * 0.35;
    const sp = Math.round(Math.abs(this.displaySpeed));
    g.save();
    g.textAlign = 'center';
    g.textBaseline = 'alphabetic';
    g.fillStyle = '#ffffff';
    g.shadowColor = s.boost || s.nitroActive ? '#3aa0ff' : 'rgba(25,245,255,0.7)';
    g.shadowBlur = (s.nitroActive ? 22 : 12) * this.dpr;
    g.font = `italic 900 ${Math.round(S * 0.2)}px Orbitron, sans-serif`;
    g.fillText(String(sp), cx - S * 0.02, cy + S * 0.07);
    g.restore();
    g.fillStyle = 'rgba(238,242,255,0.7)';
    g.font = `700 ${Math.round(S * 0.045)}px Orbitron, sans-serif`;
    g.textAlign = 'center';
    g.fillText(s.unit, cx - S * 0.02, cy + S * 0.14);
    // gear box
    const gx = cx + R * 0.52, gy = cy - R * 0.28;
    g.strokeStyle = shift ? '#ff3b5c' : 'rgba(25,245,255,0.7)';
    g.lineWidth = 2 * this.dpr;
    g.strokeRect(gx - S * 0.045, gy - S * 0.05, S * 0.09, S * 0.1);
    g.fillStyle = shift ? '#ff3b5c' : '#ffffff';
    g.font = `italic 900 ${Math.round(S * 0.07)}px Orbitron, sans-serif`;
    g.textBaseline = 'middle';
    g.fillText(s.reverse ? 'R' : s.speed < 1 && s.gear <= 1 ? 'N' : String(s.gear), gx, gy + S * 0.004);
  }
}

// ---------------------------------------------------------------------------

export interface MapDot {
  s: number;
  d: number;
  color: string;
  me?: boolean;
  ghost?: boolean;
}

/** North-up minimap with the track path pre-rendered; dots drawn per frame. */
export class Minimap {
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private bg: HTMLCanvasElement | null = null;
  private track: Track | null = null;
  private size = 0;
  private scale = 1;
  private ox = 0;
  private oz = 0;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d')!;
  }

  setTrack(track: Track): void {
    this.track = track;
    this.bg = null;
  }

  private build(): void {
    const t = this.track!;
    const r = this.canvas.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const S = Math.round(Math.max(1, r.width) * dpr);
    this.size = S;
    this.canvas.width = this.canvas.height = S;
    const b = t.bounds();
    const w = b.maxX - b.minX, h = b.maxZ - b.minZ;
    const pad = S * 0.1;
    this.scale = (S - pad * 2) / Math.max(w, h);
    this.ox = pad + ((S - pad * 2) - w * this.scale) / 2 - b.minX * this.scale;
    this.oz = pad + ((S - pad * 2) - h * this.scale) / 2 - b.minZ * this.scale;
    const c = document.createElement('canvas');
    c.width = c.height = S;
    const g = c.getContext('2d')!;
    const grad = g.createRadialGradient(S / 2, S / 2, S * 0.1, S / 2, S / 2, S * 0.5);
    grad.addColorStop(0, 'rgba(6,4,18,0.55)');
    grad.addColorStop(1, 'rgba(6,4,18,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, S, S);
    const path = () => {
      g.beginPath();
      for (let i = 0; i <= t.N; i += 4) {
        const k = i % t.N;
        const x = t.px[k] * this.scale + this.ox, z = t.pz[k] * this.scale + this.oz;
        if (i === 0) g.moveTo(x, z);
        else g.lineTo(x, z);
      }
      g.closePath();
    };
    g.lineJoin = 'round';
    g.strokeStyle = 'rgba(25,245,255,0.25)';
    g.lineWidth = 9 * dpr;
    path();
    g.stroke();
    g.strokeStyle = 'rgba(238,242,255,0.85)';
    g.lineWidth = 2.6 * dpr;
    g.shadowColor = '#19f5ff';
    g.shadowBlur = 8 * dpr;
    path();
    g.stroke();
    // start line
    g.shadowBlur = 0;
    const x0 = t.px[0] * this.scale + this.ox, z0 = t.pz[0] * this.scale + this.oz;
    g.fillStyle = '#ffe14d';
    g.fillRect(x0 - 3 * dpr, z0 - 3 * dpr, 6 * dpr, 6 * dpr);
    this.bg = c;
  }

  draw(dots: MapDot[], heading: number): void {
    if (!this.track) return;
    const r = this.canvas.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    if (!this.bg || Math.round(r.width * dpr) !== this.size) this.build();
    const g = this.ctx;
    const S = this.size;
    g.clearRect(0, 0, S, S);
    g.drawImage(this.bg!, 0, 0);
    const t = this.track;
    let me: MapDot | null = null;
    for (const d of dots) {
      if (d.me) {
        me = d;
        continue;
      }
      const i = t.idx(d.s);
      const x = (t.px[i] + t.rx[i] * d.d) * this.scale + this.ox;
      const z = (t.pz[i] + t.rz[i] * d.d) * this.scale + this.oz;
      g.fillStyle = d.color;
      g.globalAlpha = d.ghost ? 0.55 : 1;
      g.beginPath();
      g.arc(x, z, (d.ghost ? 3 : 3.6) * dpr, 0, TAU);
      g.fill();
    }
    g.globalAlpha = 1;
    if (me) {
      const i = t.idx(me.s);
      const x = (t.px[i] + t.rx[i] * me.d) * this.scale + this.ox;
      const z = (t.pz[i] + t.rz[i] * me.d) * this.scale + this.oz;
      g.save();
      g.translate(x, z);
      g.rotate(heading);
      g.fillStyle = '#ffffff';
      g.shadowColor = '#19f5ff';
      g.shadowBlur = 10 * dpr;
      g.beginPath();
      g.moveTo(0, -7 * dpr);
      g.lineTo(5 * dpr, 5 * dpr);
      g.lineTo(0, 2.5 * dpr);
      g.lineTo(-5 * dpr, 5 * dpr);
      g.closePath();
      g.fill();
      g.restore();
    }
  }
}

/** Static track outline thumbnail for menus. */
export function drawTrackThumb(canvas: HTMLCanvasElement, track: Track, colors: [string, string]): void {
  const r = canvas.getBoundingClientRect();
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const W = Math.max(64, Math.round(r.width * dpr)), H = Math.max(40, Math.round(r.height * dpr));
  canvas.width = W;
  canvas.height = H;
  const g = canvas.getContext('2d')!;
  const bgr = g.createLinearGradient(0, 0, W, H);
  bgr.addColorStop(0, colors[0]);
  bgr.addColorStop(1, colors[1]);
  g.fillStyle = bgr;
  g.fillRect(0, 0, W, H);
  const b = track.bounds();
  const w = b.maxX - b.minX, h = b.maxZ - b.minZ;
  const pad = Math.min(W, H) * 0.12;
  const sc = Math.min((W - pad * 2) / w, (H - pad * 2) / h);
  const ox = (W - w * sc) / 2 - b.minX * sc, oz = (H - h * sc) / 2 - b.minZ * sc;
  g.lineJoin = 'round';
  const path = () => {
    g.beginPath();
    for (let i = 0; i <= track.N; i += 4) {
      const k = i % track.N;
      const x = track.px[k] * sc + ox, z = track.pz[k] * sc + oz;
      if (i === 0) g.moveTo(x, z);
      else g.lineTo(x, z);
    }
    g.closePath();
  };
  g.strokeStyle = 'rgba(255,255,255,0.18)';
  g.lineWidth = 10 * dpr;
  path();
  g.stroke();
  g.strokeStyle = '#ffffff';
  g.shadowColor = 'rgba(255,255,255,0.9)';
  g.shadowBlur = 10 * dpr;
  g.lineWidth = 3 * dpr;
  path();
  g.stroke();
}
