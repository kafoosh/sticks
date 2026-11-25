// Making the real drawing disappear, and borrowing the real paper's colour.
//
// The camera still sees the pen drawing after the copy has walked off, so every frame the
// ink is painted out with paper. The paper colour is taken from the live picture around
// each line (so it keeps up with shadows and the camera's exposure), and the lines are
// looked for again in the live picture inside a band around where they were first seen —
// which means the cover still lands on the ink when the tracking is a pixel or two out.

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
  constructor(mask, mw, mh, rect, makeCanvas) {
    const w = this.w = Math.ceil(mw / 2), h = this.h = Math.ceil(mh / 2);
    this.rect = rect;
    const small = new Uint8Array(w * h);
    for (let y = 0; y < mh; y++) for (let x = 0; x < mw; x++) if (mask[y * mw + x]) small[(y >> 1) * w + (x >> 1)] = 1;
    this.core = dilate(small, w, h, 2);                // always covered
    this.band = dilate(this.core, w, h, 6);            // where ink is looked for live
    this.rgb = new Float32Array(w * h * 3);
    this.bg = [0, 1, 2].map(() => new Float32Array(w * h));
    this.wt = new Float32Array(w * h);
    this.alpha = new Float32Array(w * h);
    this.tmp = new Float32Array(w * h);
    this.canvas = makeCanvas(w, h);
    this.ctx = this.canvas.getContext('2d');
    this.image = this.ctx.createImageData(w, h);
    this.paper = [200, 200, 200];
  }

  /// `H`: stage → frame pixels, for the RGBA frame given.
  update(rgba, fw, fh, H) {
    const { w, h, rect, rgb, bg, wt, alpha, tmp, core, band } = this;
    const n = w * h, sx = rect.w / w, sy = rect.h / h;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const p = apply(H, rect.x + (x + 0.5) * sx, rect.y + (y + 0.5) * sy);
      sample(rgba, fw, fh, p.x - 0.5, p.y - 0.5, rgb, (y * w + x) * 3);
    }
    // Paper colour under the lines: the average of nearby paper, ink left out.
    for (let i = 0; i < n; i++) {
      const keep = band[i] ? 0 : 1;
      wt[i] = keep;
      bg[0][i] = rgb[i * 3] * keep; bg[1][i] = rgb[i * 3 + 1] * keep; bg[2][i] = rgb[i * 3 + 2] * keep;
    }
    const R = 9;
    for (let pass = 0; pass < 2; pass++) { boxBlur(wt, tmp, w, h, R); for (const c of bg) boxBlur(c, tmp, w, h, R); }
    let pr = 0, pg = 0, pb = 0, pn = 0;
    for (let i = 0; i < n; i++) {
      const k = wt[i] > 1e-3 ? 1 / wt[i] : 0;
      bg[0][i] *= k; bg[1][i] *= k; bg[2][i] *= k;
      let a = core[i];
      if (!a && band[i] && k) {
        const lum = rgb[i * 3] * 0.3 + rgb[i * 3 + 1] * 0.59 + rgb[i * 3 + 2] * 0.11;
        const ref = bg[0][i] * 0.3 + bg[1][i] * 0.59 + bg[2][i] * 0.11;
        if (ref - lum > Math.max(7, ref * 0.07)) a = 1;
      }
      alpha[i] = a;
      if (!band[i]) { pr += rgb[i * 3]; pg += rgb[i * 3 + 1]; pb += rgb[i * 3 + 2]; pn += 1; }
    }
    if (pn) this.paper = [pr / pn, pg / pn, pb / pn];
    boxBlur(alpha, tmp, w, h, 1);
    const d = this.image.data;
    for (let i = 0; i < n; i++) {
      d[i * 4] = bg[0][i]; d[i * 4 + 1] = bg[1][i]; d[i * 4 + 2] = bg[2][i];
      d[i * 4 + 3] = Math.min(1, alpha[i] * 2.4) * 255;
    }
    this.ctx.putImageData(this.image, 0, 0);
  }

  draw(ctx, opacity = 1) {
    ctx.save();
    ctx.globalAlpha = opacity;
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(this.canvas, this.rect.x, this.rect.y, this.rect.w, this.rect.h);
    ctx.restore();
  }
}

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
    this.ctx.putImageData(this.image, 0, 0);
  }
}
