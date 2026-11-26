// Made-up camera frames for testing recognition: a stick figure hand-drawn on a sheet or a
// card, lying on a table, seen by a phone at an angle — with the things that make it hard
// (small figure, pencil, ruled paper, a card edge right by the head, other doodles and
// writing, uneven light, a shadow across it, blur, noise). Each comes with the truth: where
// the figure is in the frame, or that there isn't one. Grey only — that is all the
// recogniser looks at. DOM-free; deterministic from the seed.

import { readFileSync } from 'node:fs';
import { apply, fromQuad } from '../../src/vision/homography.js';

const STONE = { w: 550, h: 320, g: new Uint8Array(readFileSync(new URL('./stone-550x320.gray', import.meta.url))) };

export function rng(seed) {
  let s = (seed * 2654435761) >>> 0 || 1;
  const r = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  r.range = (a, b) => a + (b - a) * r();
  r.pick = (xs) => xs[Math.floor(r() * xs.length)];
  r.bool = (p = 0.5) => r() < p;
  return r;
}

// ---------------------------------------------------------------------------------------
// Drawing in page units (the figure is about 100 tall)

const P = (x, y) => ({ x, y });
function lineP(a, b, n = 10) { const o = []; for (let i = 0; i <= n; i++) o.push(P(a.x + (b.x - a.x) * i / n, a.y + (b.y - a.y) * i / n)); return o; }
function poly(pts, n = 8) { const o = []; for (let i = 1; i < pts.length; i++) o.push(...lineP(pts[i - 1], pts[i], n).slice(i > 1 ? 1 : 0)); return o; }
function ellipse(c, rx, ry, a0 = 0, a1 = Math.PI * 2, n = 30) { const o = []; for (let i = 0; i <= n; i++) { const a = a0 + (a1 - a0) * i / n; o.push(P(c.x + rx * Math.cos(a), c.y + ry * Math.sin(a))); } return o; }
/// A hand's unsteadiness: slow drift plus a little jitter.
function wobble(pts, r, amt) {
  const f1 = r.range(0.5, 2), f2 = r.range(3, 7), p1 = r.range(0, 7), p2 = r.range(0, 7);
  return pts.map((p, i) => {
    const t = i / Math.max(1, pts.length - 1);
    return P(p.x + amt * (Math.sin(t * f1 * 6.28 + p1) + 0.4 * Math.sin(t * f2 * 6.28 + p2)) + (r() - 0.5) * amt * 0.3,
      p.y + amt * (Math.cos(t * f1 * 6.28 + p2) + 0.4 * Math.cos(t * f2 * 6.28 + p1)) + (r() - 0.5) * amt * 0.3);
  });
}

/// A stick figure, ~100 units tall, feet at y = 100, centred on x = 0. Returns strokes.
export function stickFigure(r) {
  const headR = r.range(9, 17), headRy = headR * r.range(0.85, 1.2);
  const neckY = headRy * 2 + r.range(-1, 3);
  const hipY = r.range(52, 66), shY = neckY + r.range(4, 12);
  const strokes = [];
  // Head: a loop, sometimes not quite closed, sometimes overshooting.
  const a0 = r.range(-2.2, -1.2), gap = r.pick([0, 0, 0.25, -0.35]);
  strokes.push(ellipse(P(r.range(-2, 2), headRy), headR, headRy, a0, a0 + Math.PI * 2 - gap, 34));
  const lean = r.range(-5, 5);
  const body = lineP(P(0, neckY), P(lean, hipY), 12);
  // Arms: one stroke across the body, or two.
  const armStyle = r.pick(['down', 'out', 'up', 'wave', 'bent', 'hips']);
  const armL = r.range(26, 38);
  const arm = (side) => {
    const s = side;
    switch (armStyle) {
      case 'down': return [P(lean * 0.2, shY), P(s * armL * 0.55, shY + armL * 0.8)];
      case 'out': return [P(lean * 0.2, shY), P(s * armL, shY + r.range(-6, 8))];
      case 'up': return [P(lean * 0.2, shY), P(s * armL * 0.6, shY - armL * 0.75)];
      case 'wave': return s > 0 ? [P(lean * 0.2, shY), P(s * armL * 0.5, shY - 4), P(s * armL * 0.7, shY - armL * 0.6)] : [P(lean * 0.2, shY), P(s * armL * 0.55, shY + armL * 0.8)];
      case 'bent': return [P(lean * 0.2, shY), P(s * armL * 0.55, shY + armL * 0.45), P(s * armL * 0.95, shY + armL * 0.1)];
      default: return [P(lean * 0.2, shY), P(s * armL * 0.5, shY + armL * 0.35), P(s * armL * 0.25, hipY - 6)];
    }
  };
  if (r.bool(0.45) && armStyle !== 'hips') strokes.push(poly([...arm(-1)].reverse().concat(arm(1).slice(1)), 9));
  else { strokes.push(poly(arm(-1), 9)); strokes.push(poly(arm(1), 9)); }
  // Legs: a ∧ in one stroke, or two.
  const legStyle = r.pick(['splay', 'straight', 'walk', 'bent']);
  const legL = 100 - hipY, hip = P(lean, hipY);
  const foot = (s) => legStyle === 'straight' ? P(lean + s * 6, 100) : legStyle === 'walk' ? P(lean + s * legL * 0.5, 100) : P(lean + s * legL * r.range(0.3, 0.55), 100);
  const leg = (s) => legStyle === 'bent' ? [hip, P(lean + s * legL * 0.4, hipY + legL * 0.5), P(lean + s * legL * 0.3, 100)] : [hip, foot(s)];
  if (r.bool(0.35)) strokes.push(poly([...leg(-1)].reverse().concat(leg(1).slice(1)), 9), body);
  else strokes.push(body, poly(leg(-1), 9), poly(leg(1), 9));
  // Bits: feet, a face, hair, a hat.
  if (r.bool(0.25)) for (const s of [-1, 1]) { const f = leg(s).at(-1); strokes.push(lineP(f, P(f.x + s * 7, f.y), 3)); }
  if (r.bool(0.3)) { strokes.push([P(-headR * 0.35, headRy * 0.85)], [P(headR * 0.35, headRy * 0.85)]); strokes.push(ellipse(P(0, headRy * 1.25), headR * 0.4, headRy * 0.2, 0.3, Math.PI - 0.3, 8)); }
  if (r.bool(0.15)) for (let k = -2; k <= 2; k++) strokes.push(lineP(P(k * 4, 1), P(k * 6, -7), 3));
  if (r.bool(0.1)) strokes.push(poly([P(-headR * 1.3, 2), P(headR * 1.3, 2), P(headR * 0.7, 0), P(headR * 0.7, -14), P(-headR * 0.7, -14), P(-headR * 0.7, 0)], 4));
  const amt = r.range(0.4, 1.8);
  return strokes.map((s) => (s.length > 2 ? wobble(s, r, amt) : s));
}

/// Things that are not a figure, ~100 units across.
export function doodle(r, kind = r.pick(['house', 'sun', 'star', 'arrow', 'flower', 'tree', 'scribble', 'text', 'smiley', 'cat'])) {
  const s = [];
  switch (kind) {
    case 'house': s.push(poly([P(-40, 100), P(-40, 45), P(40, 45), P(40, 100), P(-40, 100)]), poly([P(-48, 47), P(0, 5), P(48, 47)]), poly([P(-10, 100), P(-10, 72), P(10, 72), P(10, 100)])); break;
    case 'sun': s.push(ellipse(P(0, 50), 22, 22)); for (let k = 0; k < 10; k++) { const a = k * Math.PI / 5; s.push(lineP(P(Math.cos(a) * 30, 50 + Math.sin(a) * 30), P(Math.cos(a) * 46, 50 + Math.sin(a) * 46), 4)); } break;
    case 'star': { const pts = []; for (let k = 0; k <= 5; k++) { const a = -Math.PI / 2 + k * 4 * Math.PI / 5; pts.push(P(Math.cos(a) * 45, 50 + Math.sin(a) * 45)); } s.push(poly(pts)); break; }
    case 'arrow': s.push(lineP(P(-45, 50), P(45, 50)), poly([P(25, 32), P(45, 50), P(25, 68)])); break;
    case 'flower': s.push(ellipse(P(0, 30), 9, 9)); for (let k = 0; k < 6; k++) { const a = k * Math.PI / 3; s.push(ellipse(P(Math.cos(a) * 18, 30 + Math.sin(a) * 18), 9, 9)); } s.push(lineP(P(0, 40), P(0, 100)), poly([P(0, 75), P(16, 62)])); break;
    case 'tree': s.push(ellipse(P(0, 35), 30, 30), lineP(P(-6, 63), P(-6, 100)), lineP(P(6, 63), P(6, 100))); break;
    case 'smiley': s.push(ellipse(P(0, 50), 40, 40), [P(-14, 38)], [P(14, 38)], ellipse(P(0, 55), 22, 14, 0.3, Math.PI - 0.3, 10)); break;
    case 'cat': s.push(ellipse(P(0, 45), 24, 20), poly([P(-20, 34), P(-16, 14), P(-6, 27)]), poly([P(20, 34), P(16, 14), P(6, 27)]), ellipse(P(0, 85), 22, 16), lineP(P(22, 85), P(40, 65))); break;
    case 'scribble': { const pts = []; let x = -40, y = 50; for (let k = 0; k < 40; k++) { x += r.range(-8, 10); y += r.range(-12, 12); pts.push(P(Math.max(-50, Math.min(50, x)), Math.max(0, Math.min(100, y)))); } s.push(poly(pts, 3)); break; }
    default: for (let line = 0; line < 3; line++) { let x = -60; while (x < 60) { const w = r.range(8, 26), pts = []; for (let k = 0; k <= w / 2; k++) pts.push(P(x + k * 2, 30 + line * 22 + Math.sin(k * 1.7 + r() * 2) * 6)); s.push(pts); x += w + r.range(5, 10); } }
  }
  return s.map((st) => (st.length > 2 ? wobble(st, r, 1) : st));
}

// ---------------------------------------------------------------------------------------
// The frame

/// A frame and its truth. opts can force any of the choices (see the defaults below).
export function makeScene(seed, opts = {}) {
  const r = rng(seed);
  const o = {
    W: 720, H: 960,
    figure: true,
    table: r.pick(['stone', 'stone', 'wood', 'dark', 'white']),
    paper: r.pick(['plain', 'plain', 'lined', 'squared', 'cream']),
    sheet: r.pick(['card', 'card', 'page']),
    pen: r.pick(['biro', 'biro', 'felt', 'pencil', 'marker']),
    figH: r.range(0.06, 0.32),          // figure height as a share of the frame height
    turn: r.bool(0.6) ? r.range(-40, 40) : r.range(-8, 8),   // degrees, the sheet on the table
    tilt: r.range(0, 0.35),             // perspective: how much narrower the far edge looks
    nearEdge: r.bool(0.3),              // figure drawn close to the top edge of a card
    clutter: r.pick([0, 0, 1, 2, 3]),   // other doodles / writing on the page
    light: r.range(0, 0.35),            // uneven light across the frame
    shadow: r.bool(0.3),                // a soft shadow (hand, phone) over part of the frame
    blur: r.pick([0, 0, 1, 1, 2]),
    noise: r.range(2, 9),
    ...opts,
  };
  const { W, H } = o;
  const img = new Float32Array(W * H);

  // Table.
  const tableTone = { stone: 0, wood: 120, dark: 55, white: 205 }[o.table];
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let v;
    if (o.table === 'stone') {
      const sx = Math.abs(((x * 0.9 + 37) % (2 * STONE.w)) - STONE.w) | 0, sy = Math.abs(((y * 0.9 + 11) % (2 * STONE.h)) - STONE.h) | 0;
      v = STONE.g[Math.min(STONE.h - 1, sy) * STONE.w + Math.min(STONE.w - 1, sx)];
    } else if (o.table === 'wood') v = tableTone + 22 * Math.sin(y * 0.09 + Math.sin(x * 0.01) * 3) + 10 * Math.sin(y * 0.41 + x * 0.002);
    else v = tableTone + 6 * Math.sin(x * 0.05 + y * 0.03);
    img[y * W + x] = v;
  }

  // The sheet in page units: the figure is 100 tall at FIG, the sheet round it.
  const sheetW = o.sheet === 'card' ? r.range(230, 330) : r.range(420, 600);
  const sheetH = o.sheet === 'card' ? sheetW / r.range(1.4, 1.7) : sheetW * r.range(1.3, 1.45);
  const figX = r.range(-sheetW * 0.25, sheetW * 0.25), figTop = o.nearEdge ? -sheetH / 2 + r.range(3, 9) : r.range(-sheetH / 2 + 15, sheetH / 2 - 120);
  // Page → frame: scale so the figure is figH of the frame, turned, tilted, placed near the middle.
  const k = o.figH * H / 100, th = o.turn * Math.PI / 180;
  const cx = W / 2 + r.range(-0.15, 0.15) * W, cy = H / 2 + r.range(-0.12, 0.12) * H;
  const place = (p) => {                                  // page → frame, before perspective
    const x = (p.x - figX) * k, y = (p.y - figTop - 50) * k;
    return P(cx + x * Math.cos(th) - y * Math.sin(th), cy + x * Math.sin(th) + y * Math.cos(th));
  };
  // Perspective: squeeze the top of the frame picture (a phone tipped back).
  const t = o.tilt, Hp = fromQuad([P(0, 0), P(W, 0), P(W, H), P(0, H)], [P(W * t / 2, H * t * 0.15), P(W * (1 - t / 2), H * t * 0.15), P(W, H), P(0, H)]);
  const toFrame = (p) => apply(Hp, ...Object.values(place(p)));
  const corners = [P(-sheetW / 2, -sheetH / 2), P(sheetW / 2, -sheetH / 2), P(sheetW / 2, sheetH / 2), P(-sheetW / 2, sheetH / 2)].map(toFrame);

  // The sheet: its thin shadow edge, then the paper (anti-aliased convex fill).
  const paperTone = o.paper === 'cream' ? r.range(170, 195) : r.range(195, 235);
  fillQuad(img, W, H, corners, Math.max(30, paperTone * 0.45), 1.6, 0.6);
  fillQuad(img, W, H, corners, paperTone, 0, 1);
  const scale = Math.hypot(toFrame(P(1, 0)).x - toFrame(P(0, 0)).x, toFrame(P(1, 0)).y - toFrame(P(0, 0)).y);
  if (o.paper === 'lined' || o.paper === 'squared') {
    const step = o.paper === 'lined' ? sheetH / r.range(12, 22) : sheetW / r.range(18, 30);
    const ink = paperTone - r.range(25, 45), lw = Math.max(0.6, 0.5 * scale);
    for (let y = -sheetH / 2 + step; y < sheetH / 2; y += step) stroke(img, W, H, [toFrame(P(-sheetW / 2, y)), toFrame(P(sheetW / 2, y))], lw, ink, 0.8);
    if (o.paper === 'squared') for (let x = -sheetW / 2 + step; x < sheetW / 2; x += step) stroke(img, W, H, [toFrame(P(x, -sheetH / 2)), toFrame(P(x, sheetH / 2))], lw, ink, 0.8);
  }

  // Pen.
  const pen = { biro: [r.range(1.6, 2.6), r.range(30, 70), 0.95], felt: [r.range(2.5, 4), r.range(20, 45), 1], pencil: [r.range(1.4, 2.4), r.range(95, 140), 0.85], marker: [r.range(4.5, 7), r.range(15, 40), 1] }[o.pen];
  const lw = Math.max(0.7, pen[0] * scale * 1.1);
  const draw = (strokes, dx, dy) => { for (const s of strokes) stroke(img, W, H, s.map((p) => toFrame(P(p.x + dx, p.y + dy))), lw, pen[1], pen[2]); };

  // Other things on the page, kept clear of the figure.
  const placed = o.figure ? [{ x: figX, y: figTop, sz: 1.15 }] : [];
  for (let c = 0; c < o.clutter; c++) {
    for (let tries = 0; tries < 20; tries++) {
      const dx = r.range(-sheetW / 2 + 40, sheetW / 2 - 40), dy = r.range(-sheetH / 2 + 5, sheetH / 2 - 100);
      const sz = r.range(0.4, 0.9);
      // Apart from the figure and from each other, as on a real page.
      if (placed.some((q) => Math.abs(dx - q.x) < 60 * (sz + q.sz) && Math.abs(dy + 50 * sz - q.y - 50 * q.sz) < 55 * (sz + q.sz))) continue;
      placed.push({ x: dx, y: dy, sz });
      draw(doodle(r).map((s) => s.map((p) => P(p.x * sz, p.y * sz))), dx, dy);
      break;
    }
  }
  let truth = null;
  if (o.figure) {
    const fig = stickFigure(r);
    draw(fig, figX, figTop);
    const pts = fig.flat().map((p) => toFrame(P(p.x + figX, p.y + figTop)));
    truth = { minX: Math.min(...pts.map((p) => p.x)), minY: Math.min(...pts.map((p) => p.y)), maxX: Math.max(...pts.map((p) => p.x)), maxY: Math.max(...pts.map((p) => p.y)) };
  }

  // Light, shadow, lens, sensor.
  const ga = r.range(0, Math.PI * 2);
  const sh = o.shadow ? { x: r.range(0.2, 0.8) * W, y: r.range(0.2, 0.8) * H, rx: r.range(0.15, 0.4) * W, ry: r.range(0.15, 0.4) * H, d: r.range(0.25, 0.5) } : null;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let f = 1 + o.light * (((x / W - 0.5) * Math.cos(ga) + (y / H - 0.5) * Math.sin(ga)));
    if (sh) { const d = Math.hypot((x - sh.x) / sh.rx, (y - sh.y) / sh.ry); f *= 1 - sh.d * Math.max(0, Math.min(1, (1.3 - d) / 0.6)); }
    img[y * W + x] *= f;
  }
  for (let b = 0; b < o.blur; b++) boxBlur3(img, W, H);
  const gray = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) gray[i] = Math.max(0, Math.min(255, img[i] + (r() + r() + r() - 1.5) * o.noise));
  return { gray, W, H, truth, opts: o };
}

// ---------------------------------------------------------------------------------------

/// Draw a polyline in frame pixels, width lw, toward grey `ink` with opacity `alpha`.
function stroke(img, W, H, pts, lw, ink, alpha) {
  const r = lw / 2;
  if (pts.length === 1) pts = [pts[0], { x: pts[0].x + 0.01, y: pts[0].y }];
  let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
  for (const p of pts) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); }
  x0 = Math.max(0, Math.floor(x0 - r - 1)); y0 = Math.max(0, Math.floor(y0 - r - 1)); x1 = Math.min(W - 1, Math.ceil(x1 + r + 1)); y1 = Math.min(H - 1, Math.ceil(y1 + r + 1));
  if (x1 < x0 || y1 < y0) return;
  const cov = new Float32Array((x1 - x0 + 1) * (y1 - y0 + 1));
  const cw = x1 - x0 + 1;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    const bx0 = Math.max(x0, Math.floor(Math.min(a.x, b.x) - r - 1)), bx1 = Math.min(x1, Math.ceil(Math.max(a.x, b.x) + r + 1));
    const by0 = Math.max(y0, Math.floor(Math.min(a.y, b.y) - r - 1)), by1 = Math.min(y1, Math.ceil(Math.max(a.y, b.y) + r + 1));
    const dx = b.x - a.x, dy = b.y - a.y, L2 = dx * dx + dy * dy || 1e-9;
    for (let y = by0; y <= by1; y++) for (let x = bx0; x <= bx1; x++) {
      const px = x + 0.5 - a.x, py = y + 0.5 - a.y, t = Math.max(0, Math.min(1, (px * dx + py * dy) / L2));
      const d = Math.hypot(px - t * dx, py - t * dy), c = Math.max(0, Math.min(1, r + 0.5 - d));
      const j = (y - y0) * cw + (x - x0);
      if (c > cov[j]) cov[j] = c;
    }
  }
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    const c = cov[(y - y0) * cw + (x - x0)] * alpha;
    if (c > 0) img[y * W + x] += (ink - img[y * W + x]) * c;
  }
}

/// Fill a convex quad, grown by `grow` px, toward grey `tone` with opacity `alpha`.
function fillQuad(img, W, H, q, tone, grow, alpha) {
  let sgn = 0;
  for (let i = 0; i < 4; i++) { const a = q[i], b = q[(i + 1) % 4], c = q[(i + 2) % 4]; sgn += (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x); }
  sgn = Math.sign(sgn) || 1;
  const edges = q.map((a, i) => { const b = q[(i + 1) % 4], L = Math.hypot(b.x - a.x, b.y - a.y); return { a, nx: sgn * (b.y - a.y) / L, ny: -sgn * (b.x - a.x) / L }; });
  const xs = q.map((p) => p.x), ys = q.map((p) => p.y);
  for (let y = Math.max(0, Math.floor(Math.min(...ys) - grow - 1)); y <= Math.min(H - 1, Math.ceil(Math.max(...ys) + grow + 1)); y++) {
    for (let x = Math.max(0, Math.floor(Math.min(...xs) - grow - 1)); x <= Math.min(W - 1, Math.ceil(Math.max(...xs) + grow + 1)); x++) {
      let inside = 1e9;
      for (const e of edges) inside = Math.min(inside, -((x + 0.5 - e.a.x) * e.nx + (y + 0.5 - e.a.y) * e.ny));
      const c = Math.max(0, Math.min(1, inside + grow + 0.5)) * alpha;
      if (c > 0) img[y * W + x] += (tone - img[y * W + x]) * c;
    }
  }
}

function boxBlur3(img, W, H) {
  const t = new Float32Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const i = y * W + x; t[i] = (img[i - (x > 0)] + img[i] + img[i + (x < W - 1)]) / 3; }
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const i = y * W + x; img[i] = (t[i - (y > 0 ? W : 0)] + t[i] + t[i + (y < H - 1 ? W : 0)]) / 3; }
}
