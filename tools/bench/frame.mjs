// A made-up frame as the page would see it: shrunk to the analysis size, with close-ups
// sampled from the full-resolution picture. Shared by the bench and the tests.

import { apply } from '../../src/vision/homography.js';

const PROC_LONG = 640;

/// Shrink to the analysis size by area averaging, as the page's canvas would.
export function shrink(gray, W, H) {
  const s = Math.min(1, PROC_LONG / Math.max(W, H)), w = Math.round(W * s), h = Math.round(H * s);
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const x0 = Math.floor(x / s), x1 = Math.max(x0 + 1, Math.floor((x + 1) / s)), y0 = Math.floor(y / s), y1 = Math.max(y0 + 1, Math.floor((y + 1) / s));
    let sum = 0, n = 0;
    for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) { sum += gray[yy * W + xx]; n++; }
    out[y * w + x] = sum / n;
  }
  return { g: out, w, h, s };
}

/// The page's grabCrop: a crop sampled from the FULL-resolution frame.
export function grabber(gray, W, H, s) {
  return (c) => {
    const g = new Uint8Array(c.outW * c.outH);
    for (let v = 0; v < c.outH; v++) for (let u = 0; u < c.outW; u++) {
      const p = apply(c.toProc, u + 0.5, v + 0.5);
      let x = p.x / s - 0.5, y = p.y / s - 0.5;
      if (x < 0 || y < 0 || x > W - 1.001 || y > H - 1.001) { g[v * c.outW + u] = 128; continue; }
      const x0 = x | 0, y0 = y | 0, tx = x - x0, ty = y - y0, i = y0 * W + x0;
      g[v * c.outW + u] = (gray[i] * (1 - tx) + gray[i + 1] * tx) * (1 - ty) + (gray[i + W] * (1 - tx) + gray[i + W + 1] * tx) * ty;
    }
    return { g };
  };
}

