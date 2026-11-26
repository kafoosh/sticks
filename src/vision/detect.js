// Finding THE figure in a camera frame: candidates from the ink, each traced (upright if
// drawn at a slant) and rigged; the first that reads as a stick figure wins. Shared by the
// page and by tools/bench (which runs it over hard, made-up scenes), so both test the same
// code. DOM-free.

import { fit } from '../rig/fitter.js';
import { stabilizeSeams } from '../rig/seams.js';
import { rigIsConfident, nonArticulated } from '../rig/model.js';
import { inkMask, findCandidates, traceFigure, cropFor, uprightTilt, removeRuledLines, NORM_H } from './ink.js';
import { apply } from './homography.js';
import { labelFigure } from './label.js';

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

/// The rig for a traced figure. First by reading its anatomy from how its lines join
/// (label.js) — when the figure reads that way, every limb is placed and jointed. Otherwise
/// the general rigger guesses from where the strokes sit, and if it can't place every limb
/// the figure moves as one piece. { rig, confident (fully jointed), labelled }
export function rigFrom(trace, color, dx = 0, dy = 0) {
  const read = labelFigure(trace, color, dx, dy);
  if (read) return { rig: read, confident: true, labelled: true };
  const strokes = trace.strokes.map((pts, i) => ({ points: pts.map((p) => ({ x: p.x + dx, y: p.y + dy })), width: trace.width, color, head: trace.head && i === 0 }));
  let rig = stabilizeSeams(fit(strokes));
  const confident = rigIsConfident(rig);
  if (!confident) rig = nonArticulated(rig);
  return { rig, confident, labelled: false };
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

/// Where a reading's drawing is in the frame (the box round its traced ink).
function traceBox(f) {
  const t = f.trace.box, c = [[t.minX, t.minY], [t.maxX, t.minY], [t.maxX, t.maxY], [t.minX, t.maxY]].map(([x, y]) => apply(f.crop.toProc, x, y));
  return { minX: Math.round(Math.min(...c.map((p) => p.x))), minY: Math.round(Math.min(...c.map((p) => p.y))), maxX: Math.round(Math.max(...c.map((p) => p.x))), maxY: Math.round(Math.max(...c.map((p) => p.y))) };
}

const boxArea = (b) => Math.max(1, b.maxX - b.minX) * Math.max(1, b.maxY - b.minY);
/// Is the point on the box, give or take `slack` of the box's size?
function onBox(b, p, slack) {
  const sx = (b.maxX - b.minX) * slack, sy = (b.maxY - b.minY) * slack;
  return p.x >= b.minX - sx && p.x <= b.maxX + sx && p.y >= b.minY - sy && p.y <= b.maxY + sy;
}

/// Boxes of whatever is drawn at a point, from close-ups centred on it at a few sizes — for
/// when the candidates in the whole frame don't single the drawing out.
function boxesAt(point, grab, pw, ph) {
  const long = Math.max(pw, ph), out = [];
  for (const g of [0.09, 0.2, 0.42]) {
    const hh = g * long / 2, hw = hh * 0.8;
    const crop = axisCrop({ minX: point.x - hw, minY: point.y - hh, maxX: point.x + hw, maxY: point.y + hh });
    const trace = traceFigure(grab(crop).g, crop.outW, crop.outH);
    if (!trace || trace.strokes.length < 2) continue;
    const box = traceBox({ crop, trace });
    if (onBox(box, point, 0.5)) out.push(box);
  }
  return out;
}

/// The most figure-like drawing in a frame (grey, pw×ph), or null. `grab(crop)` returns
/// { g } — that crop of the picture in grey, ideally from a sharper source than `gray`.
/// Returns { box (frame px), confident, jointed, crop }; only a `confident` one is ever
/// brought to life. Paper edges are left out: see findCandidates.
///
/// Unprompted, `confident` means it passed the shape test: head, body, arms, legs. With
/// `near` — a point the performer touched to say "this one" — the drawing at that point is
/// taken on their word: it is confident if it can be traced at all (and `sure` says whether
/// it also passed the shape test). Only if nothing is drawn there does it fall back to
/// looking over the whole frame.
export function detectFigure(gray, pw, ph, grab, { near = null } = {}) {
  const r = Math.max(8, Math.round(Math.max(pw, ph) * 0.022)), lineR = Math.max(3, Math.round(r * 0.4));
  const mask = removeRuledLines(inkMask(gray, pw, ph, r, 0.13, 9, lineR), pw, ph, Math.round(Math.max(pw, ph) * 0.3), gray);
  const all = findCandidates(mask, pw, ph, { gray, reach: lineR + 2 });
  if (near) {
    // Try, in turn: the candidates the point is on (tightest first), then close-ups centred
    // on the point. Whenever what is read inside a box is much smaller than the box (the
    // box was a card's outline, say, with the figure inside), read again at that tighter
    // spot. The first to pass the shape test wins; failing that, the tightest drawing there.
    const minSide = Math.max(pw, ph) * 0.03;
    const queue = all.filter((b) => onBox(b, near, 0.3)).sort((p, q) => boxArea(p) - boxArea(q)).slice(0, 3);
    let fallback = null, seeded = false, reads = 0;
    const tried = [];
    while (reads < 9) {
      if (!queue.length) { if (seeded) break; seeded = true; queue.push(...boxesAt(near, grab, pw, ph)); continue; }
      const box = queue.shift();
      if (Math.max(box.maxX - box.minX, box.maxY - box.minY) < minSide) continue;
      if (tried.some((t) => Math.abs(t.minX - box.minX) + Math.abs(t.minY - box.minY) + Math.abs(t.maxX - box.maxX) + Math.abs(t.maxY - box.maxY) < 12)) continue;
      tried.push(box); reads += 1;
      const f = readFigure(box, grab);
      if (!f) continue;
      const tb = traceBox(f);
      if (boxArea(tb) < boxArea(box) * 0.5 && onBox(tb, near, 0.5)) { queue.unshift(tb); continue; }   // zoom in
      if (!onBox(tb, near, 0.5)) continue;                                                           // something else
      const rigged = rigFrom(f.trace, '#000');
      const sure = rigged.labelled || looksLikeStickFigure(f.trace).ok;
      const hit = { box: tb, confident: true, sure, jointed: rigged.confident, crop: f.crop, pointed: true };
      if (sure) return hit;
      if (!fallback || boxArea(tb) < boxArea(fallback.box)) fallback = hit;
    }
    if (fallback) return fallback;
  }
  // Nothing drawn where the point was (or no point given): look over the whole frame —
  // nearest the point first, if there was one.
  const dist = (b) => Math.hypot((b.minX + b.maxX) / 2 - near.x, (b.minY + b.maxY) / 2 - near.y);
  const cands = (near ? all.slice(0, 8).sort((p, q) => dist(p) - dist(q)) : all).slice(0, 4);
  let best = null;
  for (const box of cands) {
    const f = readFigure(box, grab);
    if (!f) continue;
    // The shape test decides whether this is a stick figure at all. The rig decides how
    // well it can move: fully jointed, or — when it can't place every limb — as one piece.
    // Unprompted, it is a stick figure only if its anatomy can be read from how its lines
    // join: head, body, two legs, an arm (label.js). (The looser shape test alone lets the
    // odd doodle through; it still counts when the performer has pointed at the drawing.)
    const { confident: jointed, labelled } = rigFrom(f.trace, '#000');
    const shape = { ok: labelled };
    if (shape.ok) {
      const hit = { box, confident: true, sure: true, jointed, crop: f.crop };
      if (jointed) return hit;
      if (!best || !best.confident) best = hit;
    } else if (!best) best = { box, confident: false };
  }
  return best;
}
