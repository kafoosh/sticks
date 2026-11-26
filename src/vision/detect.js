// Finding THE figure in a camera frame: candidates from the ink, each traced (upright if
// drawn at a slant) and rigged; the first that reads as a stick figure wins. Shared by the
// page and by tools/bench (which runs it over hard, made-up scenes), so both test the same
// code. DOM-free.

import { fit } from '../rig/fitter.js';
import { stabilizeSeams } from '../rig/seams.js';
import { rigIsConfident, nonArticulated } from '../rig/model.js';
import { inkMask, findCandidates, traceFigure, cropFor, uprightTilt, removeRuledLines, NORM_H } from './ink.js';
import { apply } from './homography.js';

/// Does a traced drawing have the SHAPE of a stick figure? Checked on its upright tracing,
/// separately from the rig (which will make something of almost anything): a head; one body
/// line going down from under it; two feet apart at the bottom; hands out to both sides;
/// sensible proportions — and not a head ringed with rays (a sun, a flower). Returns
/// { ok, why }.
export function looksLikeStickFigure(trace) {
  if (!trace.head) return { ok: false, why: 'no head' };
  const [loop, ...rest] = trace.strokes, wd = trace.width;
  let hx0 = 1e9, hy0 = 1e9, hx1 = -1e9, hy1 = -1e9;
  for (const p of loop) { hx0 = Math.min(hx0, p.x); hx1 = Math.max(hx1, p.x); hy0 = Math.min(hy0, p.y); hy1 = Math.max(hy1, p.y); }
  const hcx = (hx0 + hx1) / 2, hcy = (hy0 + hy1) / 2, R = Math.max(hx1 - hx0, hy1 - hy0) / 2;
  const outside = rest.filter((st) => st.some((p) => Math.hypot(p.x - hcx, p.y - hcy) > R + wd));
  if (!outside.length) return { ok: false, why: 'nothing but a head' };
  let maxY = hy1;
  for (const st of outside) for (const p of st) maxY = Math.max(maxY, p.y);
  const H = maxY - hy0;
  if (R * 2 > H * 0.55) return { ok: false, why: 'head too big for the body' };
  if (H < R * 2 * 1.8) return { ok: false, why: 'too short below the head' };
  // A body: a line from just under the head reaching well down.
  const neck = { x: hcx, y: hy1 };
  // (Of the lines starting there, the one reaching furthest down: an arm hanging down
  // starts at the neck too.)
  let body = null, bodyLow = -1e9;
  for (const st of outside) {
    if (!st.some((p) => Math.hypot(p.x - neck.x, p.y - neck.y) < R * 0.9 + wd * 2)) continue;
    const low = Math.max(...st.map((p) => p.y));
    if (low > bodyLow) { bodyLow = low; body = st; }
  }
  if (!body || bodyLow < hy1 + R * 1.5) return { ok: false, why: 'no body under the head' };
  // Rays: many lines starting right at the head and pointing away from it.
  let rays = 0;
  for (const st of outside) {
    const a = st[0], b = st[st.length - 1], da = Math.hypot(a.x - hcx, a.y - hcy), db = Math.hypot(b.x - hcx, b.y - hcy);
    const near = da < db ? a : b;
    // Only the ones leaving the lower half of the head count: hair stands up, a sun's rays
    // go all the way round.
    if (Math.min(da, db) < R + wd * 2.5 && Math.max(da, db) > R * 1.4 && near.y > hcy + R * 0.2) rays += 1;
  }
  if (rays >= 4) return { ok: false, why: 'rays round the head' };
  // Line ends: feet at the bottom, hands to each side.
  const ends = [];
  for (const st of outside) for (const p of [st[0], st[st.length - 1]]) if (Math.hypot(p.x - hcx, p.y - hcy) > R + wd * 1.5) ends.push(p);
  const feet = ends.filter((p) => p.y > maxY - H * 0.18);
  // Two feet, spread like legs (a stem, a tail, a single line don't count).
  const spread = Math.max(wd * 1.5, (maxY - hy1) * 0.12);
  const feetApart = feet.some((p) => feet.some((q) => Math.abs(p.x - q.x) > spread));
  if (!feetApart) return { ok: false, why: 'not two feet' };
  // Arms: ink reaching well out to both sides of the body in its upper half. The body's
  // line is taken from the neck to midway between the feet (it may lean).
  feet.sort((p, q) => q.y - p.y);
  const f1 = feet[0], f2 = feet.find((q) => Math.abs(q.x - f1.x) > wd * 1.5) || f1;
  const foot = { x: (f1.x + f2.x) / 2, y: Math.max(f1.y, f2.y) };
  const axisX = (y) => neck.x + (foot.x - neck.x) * Math.max(0, Math.min(1, (y - neck.y) / Math.max(1, foot.y - neck.y)));
  let outL = 0, outR = 0;
  const upper = hy1 + (maxY - hy1) * 0.5;
  for (const st of outside) for (const p of st) {
    if (p.y > upper || Math.hypot(p.x - hcx, p.y - hcy) < R + wd) continue;
    const d = p.x - axisX(p.y);
    if (d < outL) outL = d; if (d > outR) outR = d;
  }
  // (People often draw both arms out to the same side; one side is enough, but then it must
  // reach well out.)
  // (Arms are measured against the body, not the head: people draw big heads.)
  const u = Math.max(wd * 1.5, Math.min(R * 0.7, (foot.y - neck.y) * 0.2));
  if (Math.max(-outL, outR) < u * 1.6 && Math.min(-outL, outR) < u) return { ok: false, why: 'no arms' };
  return { ok: true, why: '' };
}

export function rigFrom(trace, color, dx = 0, dy = 0) {
  const strokes = trace.strokes.map((pts, i) => ({ points: pts.map((p) => ({ x: p.x + dx, y: p.y + dy })), width: trace.width, color, head: trace.head && i === 0 }));
  let rig = stabilizeSeams(fit(strokes));
  const confident = rigIsConfident(rig);
  if (!confident) rig = nonArticulated(rig);
  return { rig, confident };
}

// A crop is { toProc, outW, outH, scale }: an outW×outH picture whose pixel (u, v) shows the
// analysis frame's point toProc·(u, v, 1). `scale` is crop pixels per frame pixel.

/// A crop round a box in the frame, upright, scaled so the box is NORM_H pixels tall.
export function axisCrop(box) {
  const c = cropFor(box);
  return { toProc: [1 / c.scale, 0, c.x, 0, 1 / c.scale, c.y, 0, 0, 1], outW: c.outW, outH: c.outH, scale: c.scale };
}

/// A crop turned by `tilt` (radians, clockwise) so that a figure drawn at a slant to the
/// camera stands straight up in it, scaled so the figure is NORM_H tall. `trace` is the
/// figure as traced in crop `c0`.
export function uprightCrop(c0, trace, tilt) {
  const cs = Math.cos(tilt), sn = Math.sin(tilt);
  const pts = trace.strokes.flat().map((p) => apply(c0.toProc, p.x, p.y));
  // The figure in a frame turned upright (about the origin; only extents matter here).
  let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
  for (const p of pts) {
    const u = p.x * cs + p.y * sn, v = -p.x * sn + p.y * cs;
    x0 = Math.min(x0, u); x1 = Math.max(x1, u); y0 = Math.min(y0, v); y1 = Math.max(y1, v);
  }
  const L = Math.max(4, y1 - y0), m = L * 0.22, scale = NORM_H / L;
  const cw = (x1 - x0) + 2 * m, ch = L + 2 * m, outW = Math.round(cw * scale), outH = Math.round(ch * scale);
  const cu = (x0 + x1) / 2, cv = (y0 + y1) / 2;          // centre, upright frame
  const cx = cu * cs - cv * sn, cy = cu * sn + cv * cs;  // … back in the analysis frame
  // (u, v) → centre + R(tilt)·((u − outW/2, v − outH/2) / scale)
  const k = 1 / scale;
  return {
    toProc: [cs * k, -sn * k, cx - (cs * outW / 2 - sn * outH / 2) * k, sn * k, cs * k, cy - (sn * outW / 2 + cs * outH / 2) * k, 0, 0, 1],
    outW, outH, scale,
  };
}

/// Trace the figure in a box, turned upright if it was drawn at a slant to the camera.
/// { crop, trace } or null.
export function readFigure(box, grab) {
  let crop = axisCrop(box);
  let trace = traceFigure(grab(crop).g, crop.outW, crop.outH);
  if (!trace || trace.strokes.length < 2) return null;
  const tilt = uprightTilt(trace.strokes);
  if (Math.abs(tilt) > 0.12) {
    const turned = uprightCrop(crop, trace, tilt);
    const t2 = traceFigure(grab(turned).g, turned.outW, turned.outH);
    if (t2 && t2.strokes.length >= 2) { crop = turned; trace = t2; }
  }
  return { crop, trace };
}

/// The most figure-like drawing in a frame (grey, pw×ph), or null. `grab(crop)` returns
/// { g } — that crop of the picture in grey, ideally from a sharper source than `gray`.
/// { box (frame px), confident,
/// crop } — only a `confident` one, read as head, body, arms and legs, is ever brought to
/// life. Paper edges are left out: see findCandidates.
export function detectFigure(gray, pw, ph, grab) {
  const r = Math.max(8, Math.round(Math.max(pw, ph) * 0.022)), lineR = Math.max(3, Math.round(r * 0.4));
  const mask = removeRuledLines(inkMask(gray, pw, ph, r, 0.13, 9, lineR), pw, ph, Math.round(Math.max(pw, ph) * 0.3), gray);
  const cands = findCandidates(mask, pw, ph, { gray, reach: lineR + 2 }).slice(0, 4);
  let best = null;
  for (const box of cands) {
    const f = readFigure(box, grab);
    if (!f) continue;
    // The shape test decides whether this is a stick figure at all. The rig decides how
    // well it can move: fully jointed, or — when it can't place every limb — as one piece.
    const shape = looksLikeStickFigure(f.trace);
    const { confident: jointed } = rigFrom(f.trace, '#000');
    if (shape.ok) {
      const hit = { box, confident: true, jointed, crop: f.crop };
      if (jointed) return hit;
      if (!best || !best.confident) best = hit;
    } else if (!best) best = { box, confident: false };
  }
  return best;
}

