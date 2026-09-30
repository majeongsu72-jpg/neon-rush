import * as THREE from 'three';
import { fbm2, hash2, noise2 } from '../core/math';
import { Rng } from '../core/rng';

/** Max anisotropy is injected once the renderer exists. */
let ANISO = 8;
export function setTextureAnisotropy(a: number): void {
  ANISO = a;
}

export function canvasTexture(
  w: number,
  h: number,
  draw: (ctx: CanvasRenderingContext2D, w: number, h: number) => void,
  opts: { srgb?: boolean; repeat?: boolean; aniso?: number; mipmaps?: boolean } = {},
): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: false })!;
  draw(ctx, w, h);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = opts.srgb === false ? THREE.NoColorSpace : THREE.SRGBColorSpace;
  if (opts.repeat !== false) tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = Math.min(opts.aniso ?? 16, ANISO);
  tex.generateMipmaps = opts.mipmaps !== false;
  tex.minFilter = tex.generateMipmaps ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex;
}

/** Per-pixel painter via ImageData (tileable noise uses wrapped coords). */
function paintPixels(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  fn: (x: number, y: number) => [number, number, number, number?],
): void {
  const img = ctx.createImageData(w, h);
  const d = img.data;
  let o = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [r, g, b, a] = fn(x, y);
      d[o++] = r;
      d[o++] = g;
      d[o++] = b;
      d[o++] = a ?? 255;
    }
  }
  ctx.putImageData(img, 0, 0);
}

/** Tileable value noise: sample on a torus-ish by blending wrapped lattices. */
function tileNoise(x: number, y: number, period: number, seed: number): number {
  // noise2 lattice with period wrap
  const px = ((x % period) + period) % period;
  const py = ((y % period) + period) % period;
  const ix = Math.floor(px), iy = Math.floor(py);
  const fx = px - ix, fy = py - iy;
  const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy);
  const h = (a: number, b: number) => hash2(((a % period) + period) % period + seed * 1013, ((b % period) + period) % period);
  const a = h(ix, iy), b = h(ix + 1, iy), c = h(ix, iy + 1), d = h(ix + 1, iy + 1);
  return (a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy) * 2 - 1;
}

function tileFbm(x: number, y: number, period: number, octaves: number, seed: number): number {
  let amp = 0.5, sum = 0, norm = 0, f = 1;
  for (let o = 0; o < octaves; o++) {
    sum += amp * tileNoise(x * f, y * f, period * f, seed + o);
    norm += amp;
    amp *= 0.5;
    f *= 2;
  }
  return sum / norm;
}

// ---------------------------------------------------------------------------

export function asphaltTexture(tint: [number, number, number], seed = 3, size = 512): THREE.CanvasTexture {
  return canvasTexture(size, size, (ctx, w, h) => {
    const period = 8;
    paintPixels(ctx, w, h, (x, y) => {
      const u = (x / w) * period, v = (y / h) * period;
      const large = tileFbm(u, v, period, 4, seed) * 10;
      const grain = (hash2(x * 7 + seed, y * 13) - 0.5) * 26;
      const fleck = hash2(x * 31 + 5, y * 17 + seed) > 0.985 ? 22 : 0;
      const k = large + grain + fleck;
      return [tint[0] + k, tint[1] + k, tint[2] + k * 1.05];
    });
    // cracks & tar seams
    const rng = new Rng(seed * 7 + 1);
    ctx.globalCompositeOperation = 'multiply';
    for (let i = 0; i < 14; i++) {
      ctx.strokeStyle = `rgba(20,20,24,${rng.range(0.25, 0.55)})`;
      ctx.lineWidth = rng.range(0.6, 2.2);
      ctx.beginPath();
      let x = rng.range(0, w), y = rng.range(0, h);
      ctx.moveTo(x, y);
      for (let k = 0; k < 8; k++) {
        x += rng.range(-18, 18);
        y += rng.range(-18, 18);
        ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
    for (let i = 0; i < 5; i++) {
      ctx.fillStyle = `rgba(10,10,12,${rng.range(0.12, 0.28)})`;
      ctx.beginPath();
      ctx.ellipse(rng.range(0, w), rng.range(0, h), rng.range(8, 40), rng.range(4, 18), rng.range(0, 3), 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalCompositeOperation = 'source-over';
  });
}

/** Roughness map (G channel): puddles are smooth (dark). */
export function puddleRoughnessTexture(base: number, puddle: number, coverage: number, seed = 11, size = 256): THREE.CanvasTexture {
  return canvasTexture(
    size,
    size,
    (ctx, w, h) => {
      const period = 4;
      paintPixels(ctx, w, h, (x, y) => {
        const n = tileFbm((x / w) * period, (y / h) * period, period, 4, seed) * 0.5 + 0.5;
        const t = Math.min(1, Math.max(0, (n - (1 - coverage)) / 0.08));
        const r = base + (puddle - base) * t + (hash2(x, y + seed) - 0.5) * 0.05;
        const g = Math.max(0, Math.min(255, r * 255));
        return [g, g, g];
      });
    },
    { srgb: false },
  );
}

export function stripeTexture(a: string, b: string, stripes = 2, w = 32, h = 128): THREE.CanvasTexture {
  return canvasTexture(w, h, (ctx) => {
    const sh = h / stripes;
    for (let i = 0; i < stripes; i++) {
      ctx.fillStyle = i % 2 === 0 ? a : b;
      ctx.fillRect(0, i * sh, w, sh);
    }
    // bevel shading at the inner edge
    const g = ctx.createLinearGradient(0, 0, w, 0);
    g.addColorStop(0, 'rgba(0,0,0,0.35)');
    g.addColorStop(0.25, 'rgba(0,0,0,0)');
    g.addColorStop(0.85, 'rgba(255,255,255,0.05)');
    g.addColorStop(1, 'rgba(0,0,0,0.3)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
  });
}

/** Horizontal dashes along V for light strips. */
export function dashTexture(duty = 0.5, soft = 0.15, h = 128): THREE.CanvasTexture {
  return canvasTexture(
    8,
    h,
    (ctx, w, hh) => {
      paintPixels(ctx, w, hh, (_x, y) => {
        const t = y / hh;
        const edge = Math.min(t / soft, (duty - t) / soft, 1);
        const on = t < duty ? Math.max(0, edge) : 0;
        const v = Math.round(on * 255);
        return [v, v, v];
      });
    },
    { srgb: false },
  );
}

export function checkerTexture(cells = 8, rows = 2): THREE.CanvasTexture {
  return canvasTexture(cells * 32, rows * 32, (ctx) => {
    for (let x = 0; x < cells; x++)
      for (let y = 0; y < rows; y++) {
        ctx.fillStyle = (x + y) % 2 ? '#f4f4f4' : '#111';
        ctx.fillRect(x * 32, y * 32, 32, 32);
      }
  });
}

/** Soft radial glow (for halos / light pools / sprites). */
export function glowTexture(size = 128, falloff = 2.2): THREE.CanvasTexture {
  return canvasTexture(
    size,
    size,
    (ctx, w, h) => {
      paintPixels(ctx, w, h, (x, y) => {
        const dx = (x + 0.5) / w - 0.5, dy = (y + 0.5) / h - 0.5;
        const r = Math.min(1, Math.sqrt(dx * dx + dy * dy) * 2);
        const v = Math.pow(1 - r, falloff) * 255;
        return [v, v, v];
      });
    },
    { srgb: false, repeat: false },
  );
}

/** Vertical streak for fake wet-road reflections (bright core, long falloff). */
export function streakTexture(w = 64, h = 256): THREE.CanvasTexture {
  return canvasTexture(
    w,
    h,
    (ctx, ww, hh) => {
      paintPixels(ctx, ww, hh, (x, y) => {
        const dx = Math.abs((x + 0.5) / ww - 0.5) * 2;
        const t = (y + 0.5) / hh;
        const along = Math.pow(Math.sin(Math.PI * t), 0.8);
        const across = Math.pow(Math.max(0, 1 - dx), 2.4);
        const flicker = 0.85 + 0.15 * noise2(x * 0.3, y * 0.08, 5);
        const v = Math.min(255, along * across * flicker * 255);
        return [v, v, v];
      });
    },
    { srgb: false, repeat: false },
  );
}

/** Generic grayscale noise (tileable). */
export function noiseTexture(size = 256, period = 4, octaves = 5, seed = 1): THREE.CanvasTexture {
  return canvasTexture(
    size,
    size,
    (ctx, w, h) => {
      paintPixels(ctx, w, h, (x, y) => {
        const n = tileFbm((x / w) * period, (y / h) * period, period, octaves, seed) * 0.5 + 0.5;
        const v = Math.max(0, Math.min(255, n * 255));
        return [v, v, v];
      });
    },
    { srgb: false },
  );
}

/** Tileable tangent-space normal map from fbm height (for water ripples etc.). */
export function noiseNormalTexture(size = 256, period = 6, strength = 2.5, seed = 5): THREE.CanvasTexture {
  const hgt = new Float32Array(size * size);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) hgt[y * size + x] = tileFbm((x / size) * period, (y / size) * period, period, 4, seed);
  return canvasTexture(
    size,
    size,
    (ctx, w, h) => {
      paintPixels(ctx, w, h, (x, y) => {
        const l = hgt[y * size + ((x - 1 + size) % size)], r = hgt[y * size + ((x + 1) % size)];
        const u = hgt[((y - 1 + size) % size) * size + x], d = hgt[((y + 1) % size) * size + x];
        let nx = (l - r) * strength, ny = (u - d) * strength;
        const nz = 1;
        const len = Math.hypot(nx, ny, nz);
        nx /= len;
        ny /= len;
        return [(nx * 0.5 + 0.5) * 255, (ny * 0.5 + 0.5) * 255, (nz / len * 0.5 + 0.5) * 255];
      });
    },
    { srgb: false },
  );
}

export { fbm2 };
