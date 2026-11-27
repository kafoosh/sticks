// One camera frame, as a look for a figure works from it: shrunk to the analysis size, with
// close-ups sampled from the full-resolution picture. Plain arithmetic on pixels — no canvas
// — so it runs the same in the page, in its worker (look.worker.js), and in the bench and
// the tests under Node.

import { apply } from './homography.js';
import { detectFigure } from './detect.js';
import { traceFigure, plainTrace, inkMask, removeRuledLines } from './ink.js';
import { readCard } from './card.js';

export const PROC_LONG = 640;     // the camera picture is analysed at this size (long side)

/// RGBA pixels as grey.
export function toGray(rgba, W, H) {
  const g = new Uint8Array(W * H);
  for (let i = 0, n = W * H; i < n; i++) g[i] = (rgba[i * 4] * 77 + rgba[i * 4 + 1] * 151 + rgba[i * 4 + 2] * 28) >> 8;
  return g;
}

/// Look for a figure in one full-resolution frame (RGBA, W×H). `near`: see detectFigure.
/// Returns its findings in the analysis frame's pixels, as plain data (it may cross from a
/// worker), or null.
export function lookAt(rgba, W, H, near) {
  const gray = toGray(rgba, W, H), P = shrink(gray, W, H);
  const hit = detectFigure(P.g, P.w, P.h, grabber(gray, W, H, P.s), { near });
  return hit && { box: hit.box, confident: !!hit.confident, sure: !!hit.sure, jointed: !!hit.jointed, pointed: !!hit.pointed, crop: hit.crop || null };
}

/// The playing card in one full-resolution frame (RGBA, W×H), if exactly one can be read for
/// sure: { value 1…13, suit } (see card.js), or null.
export function cardAt(rgba, W, H) {
  const card = readCard(rgba, W, H);
  return card && { value: card.value, suit: card.suit, score: card.score, seen: card.seen };
}

/// Read the figure a look found, for waking it: trace its lines in crop `crop` (see detect.js)
/// of a full-resolution frame (RGBA, W×H) — usually a later frame than the one it was found
/// in. Returns null if nothing figure-like is there, else plain data (it may cross from a
/// worker): { crop (as used), trace (ink.js traceFigure; see reviveTrace), ink (the pen's
/// colour, CSS), rules (on ruled paper: the analysis frame's ink with and without the rules) }.
export function readAt(rgba, W, H, crop) {
  const gray = toGray(rgba, W, H), s = Math.min(1, PROC_LONG / Math.max(W, H)), grab = grabber(gray, W, H, s);
  let c = crop, g = grab(c).g, trace = traceFigure(g, c.outW, c.outH);
  if (!trace) return null;
  // The crop was chosen a moment ago and the camera has moved since: if the figure is no
  // longer in the middle of it, slide the crop onto the figure and read again, so it is
  // read just as it was when found (not cut off at an edge, or with a neighbour let in).
  const dx = (trace.box.minX + trace.box.maxX) / 2 - c.outW / 2, dy = (trace.box.minY + trace.box.maxY) / 2 - c.outH / 2;
  if (Math.hypot(dx, dy) > c.outH * 0.04) {
    const m = c.toProc, c2 = { ...c, toProc: [m[0], m[1], m[0] * dx + m[1] * dy + m[2], m[3], m[4], m[3] * dx + m[4] * dy + m[5], m[6], m[7], m[6] * dx + m[7] * dy + m[8]] };
    const g2 = grab(c2).g, t2 = traceFigure(g2, c2.outW, c2.outH);
    if (t2) { c = c2; g = g2; trace = t2; }
  }
  // The pen's colour: the darker half of the ink pixels.
  const tones = new Uint32Array(256);
  let count = 0;
  for (let i = 0; i < g.length; i++) if (trace.mask[i]) { tones[g[i]] += 1; count += 1; }
  let cut = 0;
  for (let seen = tones[0]; seen <= (count >> 1) && cut < 255;) seen += tones[++cut];
  let r = 0, gg = 0, b = 0, n = 0;
  for (let v = 0; v < c.outH; v++) for (let u = 0; u < c.outW; u++) {
    const i = v * c.outW + u;
    if (!trace.mask[i] || g[i] > cut) continue;
    const q = apply(c.toProc, u + 0.5, v + 0.5), x = Math.min(W - 1, Math.max(0, Math.floor(q.x / s))), y = Math.min(H - 1, Math.max(0, Math.floor(q.y / s))), j = (y * W + x) * 4;
    r += rgba[j]; gg += rgba[j + 1]; b += rgba[j + 2]; n += 1;
  }
  const ink = n ? `rgba(${Math.round(r / n)},${Math.round(gg / n)},${Math.round(b / n)},0.94)` : 'rgba(28,27,25,0.94)';
  let rules = null;
  if (trace.ruleAngle !== undefined) {
    const P = shrink(gray, W, H), rr = Math.max(8, Math.round(Math.max(P.w, P.h) * 0.022)), lineR = Math.max(3, Math.round(rr * 0.4));
    const all = inkMask(P.g, P.w, P.h, rr, 0.13, 9, lineR);
    rules = { all, ink: removeRuledLines(all, P.w, P.h, Math.round(Math.max(P.w, P.h) * 0.3), P.g) };   // (`all` minus `ink` = the rules)
  }
  return { crop: c, trace: plainTrace(trace), ink, rules };
}

/// Shrink to the analysis size by area averaging.
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

/// A crop (see detect.js) sampled from the FULL-resolution frame: a small drawing is only a
/// few dozen pixels tall in the analysis frame — too few to read its lines from — but
/// several times that in the camera's own picture.
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

