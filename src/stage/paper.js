// Making the real drawing disappear, and borrowing the real paper's colour.
//
// The camera still sees the pen drawing after the copy has walked off, so every frame the
// ink is covered with paper — real paper, copied by the compositor from the live picture
// just beside each line (see Eraser), so it keeps the page's grain, shadows and exposure.

import { apply } from '../vision/homography.js';

/// Bilinear RGB sample from an RGBA frame into out[o..o+2].
function sample(rgba, w, h, x, y, out, o) {
  if (x < 0) x = 0; else if (x > w - 1.001) x = w - 1.001;
  if (y < 0) y = 0; else if (y > h - 1.001) y = h - 1.001;
  const x0 = x | 0, y0 = y | 0, tx = x - x0, ty = y - y0;
  const i = (y0 * w + x0) * 4, j = i + w * 4;
  for (let c = 0; c < 3; c++) {
    const a = rgba[i + c] + (rgba[i + 4 + c] - rgba[i + c]) * tx;
    const b = rgba[j + c] + (rgba[j + 4 + c] - rgba[j + c]) * tx;
    out[o + c] = a + (b - a) * ty;
  }
}

function dilate(src, w, h, r) {
  let a = src;
  for (let k = 0; k < r; k++) {
    const b = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (a[i] || (x > 0 && a[i - 1]) || (x < w - 1 && a[i + 1]) || (y > 0 && a[i - w]) || (y < h - 1 && a[i + w])
        || (k % 2 === 1 && ((x > 0 && y > 0 && a[i - w - 1]) || (x < w - 1 && y > 0 && a[i - w + 1])
          || (x > 0 && y < h - 1 && a[i + w - 1]) || (x < w - 1 && y < h - 1 && a[i + w + 1])))) b[i] = 1;
    }
    a = b;
  }
  return a;
}

/// In-place box blur of a Float32 plane (radius r), using `tmp` as scratch.
function boxBlur(a, tmp, w, h, r) {
  for (let y = 0; y < h; y++) {
    let s = 0; const row = y * w;
    for (let x = -r; x <= r; x++) s += a[row + Math.min(w - 1, Math.max(0, x))];
    for (let x = 0; x < w; x++) {
      tmp[row + x] = s;
      s += a[row + Math.min(w - 1, x + r + 1)] - a[row + Math.max(0, x - r)];
    }
  }
  const n = (2 * r + 1) * (2 * r + 1);
  for (let x = 0; x < w; x++) {
    let s = 0;
    for (let y = -r; y <= r; y++) s += tmp[Math.min(h - 1, Math.max(0, y)) * w + x];
    for (let y = 0; y < h; y++) {
      a[y * w + x] = s / n;
      s += tmp[Math.min(h - 1, y + r + 1) * w + x] - tmp[Math.max(0, y - r) * w + x];
    }
  }
}

export class Eraser {
  /// `mask`: the figure's ink (Uint8, mw×mh) covering the stage rectangle `rect`
  /// {x, y, w, h}. Works at half that resolution.
  ///
  /// Nothing is painted here. Instead this builds, once, a little map the compositor's
  /// shader reads: for every cell on or near a line, WHERE in the picture to copy clean
  /// paper from — the nearest blank paper on one side of the line and on the other, blended
  /// across. So what covers the ink is the real page, at the camera's full sharpness, with
  /// its real grain, texture and lighting, taken from the very same frame.
  constructor(mask, mw, mh, rect) {
    const w = this.w = Math.ceil(mw / 2), h = this.h = Math.ceil(mh / 2);
    this.rect = rect;
    this.cell = rect.w / w;                            // stage units per cell
    const small = new Uint8Array(w * h);
    for (let y = 0; y < mh; y++) for (let x = 0; x < mw; x++) if (mask[y * mw + x]) small[(y >> 1) * w + (x >> 1)] = 1;
    const cover = dilate(small, w, h, 5);              // what gets covered: the line and a margin
    const dirty = dilate(cover, w, h, 2);              // never copy from this close to a line
    // Nearest clean cell for every cell (two-pass sweep carrying the source along).
    const n = w * h, sx = new Int16Array(n), sy = new Int16Array(n), dist = new Float32Array(n).fill(1e9);
    for (let i = 0; i < n; i++) if (!dirty[i]) { sx[i] = i % w; sy[i] = (i / w) | 0; dist[i] = 0; }
    const relax = (i, x, y, j) => {
      if (dist[j] >= 1e9) return;
      const d = Math.hypot(sx[j] - x, sy[j] - y);
      if (d < dist[i]) { dist[i] = d; sx[i] = sx[j]; sy[i] = sy[j]; }
    };
    for (let pass = 0; pass < 2; pass++) {
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (x > 0) relax(i, x, y, i - 1); if (y > 0) relax(i, x, y, i - w);
        if (x > 0 && y > 0) relax(i, x, y, i - w - 1); if (x < w - 1 && y > 0) relax(i, x, y, i - w + 1);
      }
      for (let y = h - 1; y >= 0; y--) for (let x = w - 1; x >= 0; x--) {
        const i = y * w + x;
        if (x < w - 1) relax(i, x, y, i + 1); if (y < h - 1) relax(i, x, y, i + w);
        if (x < w - 1 && y < h - 1) relax(i, x, y, i + w + 1); if (x > 0 && y < h - 1) relax(i, x, y, i + w - 1);
      }
    }
    // offsets: RG = step to the nearest clean paper, BA = step to clean paper on the far
    // side (both in cells, ±MAX_STEP). cover: R = how much to cover, G = share of the first.
    const offsets = this.offsets = new Uint8Array(n * 4), coverMap = this.cover = new Uint8Array(n * 4);
    const enc = (v) => Math.max(0, Math.min(255, Math.round(v / MAX_STEP * 127 + 128)));
    const alpha = new Float32Array(n), tmp = new Float32Array(n);
    for (let i = 0; i < n; i++) alpha[i] = cover[i];
    boxBlur(alpha, tmp, w, h, 1);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x;
      let ax = 0, ay = 0, bx = 0, by = 0, share = 1;
      if (dirty[i] && dist[i] < 1e9) {
        ax = sx[i] - x; ay = sy[i] - y;
        const d1 = Math.hypot(ax, ay) || 1, ux = -ax / d1, uy = -ay / d1;
        bx = ax; by = ay;
        for (let k = 1; k <= MAX_STEP; k++) {           // straight through the line to the other side
          const qx = Math.round(x + ux * k), qy = Math.round(y + uy * k);
          if (qx < 0 || qy < 0 || qx >= w || qy >= h) break;
          if (!dirty[qy * w + qx]) { bx = qx - x; by = qy - y; share = k / (k + d1); break; }
        }
      }
      offsets[i * 4] = enc(ax); offsets[i * 4 + 1] = enc(ay); offsets[i * 4 + 2] = enc(bx); offsets[i * 4 + 3] = enc(by);
      coverMap[i * 4] = Math.min(1, alpha[i] * 1.8) * 255; coverMap[i * 4 + 1] = share * 255; coverMap[i * 4 + 3] = 255;
    }
    this.paper = [236, 233, 226];
  }
}

/// Furthest (in cells) clean paper is ever copied from.
export const MAX_STEP = 40;

/// A small live sample of the paper over a stage rectangle, for painting the torn piece
/// with the page's own colour and shading.
export class Swatch {
  constructor(rect, makeCanvas, w = 20, h = 16) {
    this.rect = rect; this.w = w; this.h = h;
    this.canvas = makeCanvas(w, h);
    this.ctx = this.canvas.getContext('2d');
    this.image = this.ctx.createImageData(w, h);
    this.smooth = null;
    this.rgb = new Float32Array(3);
  }

  update(rgba, fw, fh, H) {
    const { w, h, rect, rgb } = this, d = this.image.data;
    if (!this.smooth) this.smooth = new Float32Array(w * h * 3).fill(-1);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const p = apply(H, rect.x + (x + 0.5) * rect.w / w, rect.y + (y + 0.5) * rect.h / h);
      sample(rgba, fw, fh, p.x - 0.5, p.y - 0.5, rgb, 0);
      const i = y * w + x;
      for (let c = 0; c < 3; c++) {                    // eased over time: no sensor flicker
        const s = this.smooth[i * 3 + c];
        this.smooth[i * 3 + c] = s < 0 ? rgb[c] : s + (rgb[c] - s) * 0.25;
        d[i * 4 + c] = this.smooth[i * 3 + c];
      }
      d[i * 4 + 3] = 255;
    }
    let r = 0, g = 0, b = 0;
    for (let i = 0; i < w * h; i++) { r += this.smooth[i * 3]; g += this.smooth[i * 3 + 1]; b += this.smooth[i * 3 + 2]; }
    this.mean = [r / (w * h), g / (w * h), b / (w * h)];
    this.ctx.putImageData(this.image, 0, 0);
  }
}
