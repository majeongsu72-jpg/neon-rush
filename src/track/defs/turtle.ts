import type { ControlPoint, SectionDef, SectionKind, BoostPadDef } from '../types';

const D2R = Math.PI / 180;
const smooth = (t: number): number => t * t * (3 - 2 * t);

/**
 * "Turtle graphics" track authoring: straights and constant-radius arcs with
 * smooth elevation changes. Guarantees exact corner radii, which hand-placed
 * spline points never do. Heading 0 = north (-Z), positive = turning right.
 */
export class Turtle {
  x: number;
  y: number;
  z: number;
  h: number;
  private readonly x0: number;
  private readonly y0: number;
  private readonly z0: number;
  private w: number | undefined;
  private bankDeg = 0;
  private readonly step: number;
  readonly points: ControlPoint[] = [];
  readonly sections: SectionDef[] = [];
  readonly pads: BoostPadDef[] = [];
  private readonly open = new Map<string, { from: number; side?: number; param?: number }>();

  constructor(x: number, y: number, z: number, headingDeg: number, step = 40) {
    this.x = this.x0 = x;
    this.y = this.y0 = y;
    this.z = this.z0 = z;
    this.h = headingDeg * D2R;
    this.step = step;
    this.emit();
  }

  private emit(): void {
    const p: ControlPoint = { x: this.x, y: this.y, z: this.z };
    if (this.w !== undefined) p.w = this.w;
    if (this.bankDeg) p.bank = this.bankDeg;
    this.points.push(p);
  }

  get index(): number {
    return this.points.length - 1;
  }

  width(halfWidth: number | undefined): this {
    this.w = halfWidth;
    return this;
  }

  bank(deg: number): this {
    this.bankDeg = deg;
    return this;
  }

  /** Straight segment. dy = elevation change (smoothstep profile). */
  straight(len: number, dy = 0, step = this.step): this {
    const n = Math.max(1, Math.round(len / step));
    const dx = Math.sin(this.h), dz = -Math.cos(this.h);
    const y0 = this.y;
    for (let i = 1; i <= n; i++) {
      const t = i / n;
      this.x += (dx * len) / n;
      this.z += (dz * len) / n;
      this.y = y0 + dy * smooth(t);
      this.emit();
    }
    return this;
  }

  /** Constant radius arc. angle > 0 turns right. */
  arc(radius: number, angleDeg: number, dy = 0, maxStepDeg = 11): this {
    const a = angleDeg * D2R;
    const n = Math.max(2, Math.ceil(Math.abs(angleDeg) / maxStepDeg));
    const sgn = Math.sign(a);
    // right vector r(h) = (cos h, sin h)
    const cx = this.x + sgn * radius * Math.cos(this.h);
    const cz = this.z + sgn * radius * Math.sin(this.h);
    const h0 = this.h;
    const y0 = this.y;
    for (let i = 1; i <= n; i++) {
      const t = i / n;
      const hh = h0 + a * t;
      this.x = cx - sgn * radius * Math.cos(hh);
      this.z = cz - sgn * radius * Math.sin(hh);
      this.y = y0 + dy * smooth(t);
      this.emit();
    }
    this.h = h0 + a;
    return this;
  }

  /**
   * Vertical 360° loop rising toward +Y, displaced sideways by `shift`
   * (positive = to the right) so the exit clears the entry.
   */
  loop(radius: number, shift: number, lead = 30): this {
    this.straight(lead, 0, lead / 2);
    const from = this.index - 1;
    const dx = Math.sin(this.h), dz = -Math.cos(this.h);
    const rx = Math.cos(this.h), rz = Math.sin(this.h);
    const px = this.x, py = this.y, pz = this.z;
    const n = 28;
    for (let i = 1; i <= n; i++) {
      const phi = (i / n) * Math.PI * 2;
      const side = shift * smooth(i / n);
      this.x = px + dx * radius * Math.sin(phi) + rx * side;
      this.y = py + radius * (1 - Math.cos(phi));
      this.z = pz + dz * radius * Math.sin(phi) + rz * side;
      this.emit();
    }
    this.y = py;
    this.straight(lead, 0, lead / 2);
    this.sections.push({ kind: 'loop', from, to: this.index, axis: [rx, 0, rz] });
    return this;
  }

  begin(kind: SectionKind, side?: number, param?: number): this {
    this.open.set(kind, { from: this.index, side, param });
    return this;
  }

  end(kind: SectionKind): this {
    const o = this.open.get(kind);
    if (!o) throw new Error(`section ${kind} not open`);
    this.open.delete(kind);
    const sec: SectionDef = { kind, from: o.from, to: this.index };
    if (o.side !== undefined) sec.side = o.side;
    if (o.param !== undefined) sec.param = o.param;
    this.sections.push(sec);
    return this;
  }

  /** Boost pad `ahead` metres from the current point (approximate, by index fraction). */
  pad(d: number, length = 16, width = 5): this {
    this.pads.push({ at: this.index, d, length, width });
    return this;
  }

  /** Current closure error (how far the turtle is from the start). */
  closureError(): { dx: number; dy: number; dz: number; dist: number; headingDeg: number } {
    const dx = this.x - this.x0, dy = this.y - this.y0, dz = this.z - this.z0;
    const hd = (((this.h / D2R) % 360) + 540) % 360 - 180;
    return { dx, dy, dz, dist: Math.hypot(dx, dz), headingDeg: hd };
  }

  /**
   * Finish the loop: drops the duplicated end point and spreads the residual
   * closure error along the path (weighted by distance).
   */
  close(): { points: ControlPoint[]; sections: SectionDef[]; pads: BoostPadDef[] } {
    const pts = this.points.slice();
    const last = pts[pts.length - 1];
    const ex = last.x - this.x0, ey = last.y - this.y0, ez = last.z - this.z0;
    pts.pop();
    const cum: number[] = [0];
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i];
      cum.push(cum[i - 1] + Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z));
    }
    const total = cum[cum.length - 1] + Math.hypot(last.x - pts[pts.length - 1].x, last.z - pts[pts.length - 1].z);
    for (let i = 1; i < pts.length; i++) {
      const f = cum[i] / total;
      pts[i] = { ...pts[i], x: pts[i].x - ex * f, y: pts[i].y - ey * f, z: pts[i].z - ez * f };
    }
    const n = pts.length;
    const fix = (idx: number) => Math.min(idx, n - 0.001);
    return {
      points: pts,
      sections: this.sections.map((s) => ({ ...s, from: fix(s.from), to: fix(s.to) })),
      pads: this.pads.map((p) => ({ ...p, at: fix(p.at) })),
    };
  }
}
