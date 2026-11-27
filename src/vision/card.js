// Reading a playing card the camera can see, so the performer needn't dial it in.
//
// Not the whole card: just a corner INDEX — the value with the suit symbol right beneath it,
// printed in the same colour on white. That pairing is what is looked for, at any angle and
// with the rest of the card covered or out of the picture; and since the suit is always
// below the value, it also says which way up the value is (a 6 from a 9).
//
// It would much rather say nothing than guess. A reading needs all of: the pair found; both
// marks the same colour, plainly red or plainly black; a suit shape that goes with that
// colour, the right way up; and a value its shape-readers are sure of. Two
// different cards readable in the picture: nothing. (The page then wants the same answer
// from several looks in a row before it believes it: see main.js.)
//
// Plain arithmetic on pixels, so it runs in the page, in its worker and under Node.

import { components, closing, thin } from './ink.js';
import { GW, GH, SW, SH, VALUE_NETS, SUIT_NETS } from './cardglyphs.js';

export const LONG = 640;          // the picture is searched at this size (long side)…
const PIP = 18;                   // …and each index read from a close-up with its suit mark this many pixels across
const CW = 76, CH = 124, CX = 38, CY = 98;   // the close-up, and where the suit mark's middle goes in it

export const SUIT_NAMES = ['clubs', 'hearts', 'spades', 'diamonds'];   // (the order the networks answer in)
const RED = { hearts: true, diamonds: true };
const NET_SCALE = 6;              // (as trained: tools/card-train.mjs)
export const LIMITS = { value: 0.8, suit: 0.8 };

// ---------------------------------------------------------------------------------------
// What a mark is, from a small picture of it: the shared opinion of a few small networks
// (cardglyphs.js; trained by tools/make-card-glyphs.cjs).

let NETS = null;
function nets() {
  if (NETS) return NETS;
  const bytes = (b64) => { const bin = atob(b64), a = new Int8Array(bin.length); for (let i = 0; i < a.length; i++) a[i] = bin.charCodeAt(i); return a; };
  const load = (list, IN) => list.map((n) => { const b2 = Float32Array.from(bytes(n.b2.q), (v) => v * n.b2.scale); return { hidden: n.hidden, IN, OUT: b2.length, W1: bytes(n.W1.q), s1: n.W1.scale, b1: Float32Array.from(bytes(n.b1.q), (v) => v * n.b1.scale), W2: bytes(n.W2.q), s2: n.W2.scale, b2 }; });
  return (NETS = { value: load(VALUE_NETS, GW * GH), suit: load(SUIT_NETS, SW * SH) });
}
/// { k: which answer (the last one is "none"), conf: 0…1 }.
function ask(list, shape) {
  // (zero-mean, unit length, as trained)
  let m = 0;
  for (let i = 0; i < shape.length; i++) m += shape[i];
  m /= shape.length;
  const u = new Float32Array(shape.length);
  let len = 0;
  for (let i = 0; i < u.length; i++) { u[i] = shape[i] - m; len += u[i] * u[i]; }
  len = (Math.sqrt(len) || 1) / NET_SCALE;
  for (let i = 0; i < u.length; i++) u[i] /= len;
  const OUT = list[0].OUT, p = new Float32Array(OUT), h = new Float32Array(64), z = new Float32Array(OUT);
  for (const n of list) {
    for (let j = 0; j < n.hidden; j++) { let a = 0; const off = j * n.IN; for (let i = 0; i < n.IN; i++) a += n.W1[off + i] * u[i]; a = a * n.s1 + n.b1[j]; h[j] = a > 0 ? a : 0; }
    let mx = -1e9, sum = 0;
    for (let k = 0; k < OUT; k++) { let a = 0; const off = k * n.hidden; for (let j = 0; j < n.hidden; j++) a += n.W2[off + j] * h[j]; z[k] = a * n.s2 + n.b2[k]; if (z[k] > mx) mx = z[k]; }
    for (let k = 0; k < OUT; k++) { z[k] = Math.exp(z[k] - mx); sum += z[k]; }
    for (let k = 0; k < OUT; k++) p[k] += z[k] / sum / list.length;
  }
  let b = 0;
  for (let k = 1; k < OUT; k++) if (p[k] > p[b]) b = k;
  return { k: b, conf: p[b] };
}
/// Which value a mark is, from its centre lines (see `lines`): { value 1…13, or 0 for "not a
/// value"; conf }.
export function valueOf(shape) { const a = ask(nets().value, shape); return { value: a.k === 13 ? 0 : a.k + 1, conf: a.conf }; }
/// Which suit a mark is, from the mark itself stretched to SW×SH: { suit, or null for "not a
/// suit, this way up"; conf }.
export function suitOf(shape) { const a = ask(nets().suit, shape); return { suit: a.k === 4 ? null : SUIT_NAMES[a.k], conf: a.conf }; }

/// A patch of a soft picture (`src`, sw wide, 0…1), stretched to dw×dh — how every mark is
/// brought to one size before it is compared. Only pixels where `keep` (if given) is set count.
export function stretch(src, sw, x0, y0, bw, bh, dw, dh, keep = null, want = null) {
  const out = new Float32Array(dw * dh), n = Math.max(2, Math.min(4, Math.ceil(Math.max(bw / dw, bh / dh))));
  for (let j = 0; j < dh; j++) for (let i = 0; i < dw; i++) {
    let sum = 0;
    for (let b = 0; b < n; b++) for (let a = 0; a < n; a++) {
      const x = Math.min(x0 + bw - 1, Math.floor(x0 + (i + (a + 0.5) / n) * bw / dw)), y = Math.min(y0 + bh - 1, Math.floor(y0 + (j + (b + 0.5) / n) * bh / dh)), k = y * sw + x;
      if (!keep || want.has(keep[k])) sum += src[k];
    }
    out[j * dw + i] = sum / (n * n);
  }
  return out;
}

/// A value's shape, for comparing: its CENTRE LINES (so that a hairline 7 and a fat one are
/// the same 7), stretched to dw×dh and softened a little. `labels`/`ids`: which pixels of a
/// picture lw wide are the mark; `box`: its bounds.
export function lines(labels, lw, ids, box, dw, dh) {
  const bw = box.maxX - box.minX + 1, bh = box.maxY - box.minY + 1, m = new Uint8Array(bw * bh);
  for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) if (ids.has(labels[(box.minY + y) * lw + box.minX + x])) m[y * bw + x] = 1;
  const sk = thin(m, bw, bh), raw = new Float32Array(dw * dh);
  for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) {
    if (!sk[y * bw + x]) continue;
    const fx = Math.min(dw - 1.001, Math.max(0, (x + 0.5) / bw * dw - 0.5)), fy = Math.min(dh - 1.001, Math.max(0, (y + 0.5) / bh * dh - 0.5));
    const x0 = fx | 0, y0 = fy | 0, tx = fx - x0, ty = fy - y0, i = y0 * dw + x0;
    raw[i] += (1 - tx) * (1 - ty); raw[i + 1] += tx * (1 - ty); raw[i + dw] += (1 - tx) * ty; raw[i + dw + 1] += tx * ty;
  }
  const out = new Float32Array(dw * dh);
  let top = 0;
  for (let y = 0; y < dh; y++) for (let x = 0; x < dw; x++) {
    let sum = 0;
    for (let b = -1; b <= 1; b++) for (let a = -1; a <= 1; a++) { const xx = x + a, yy = y + b; if (xx >= 0 && yy >= 0 && xx < dw && yy < dh) sum += raw[yy * dw + xx] * (a ? 1 : 2) * (b ? 1 : 2); }
    out[y * dw + x] = sum; if (sum > top) top = sum;
  }
  if (top > 0) for (let i = 0; i < out.length; i++) out[i] /= top;
  return out;
}

// ---------------------------------------------------------------------------------------

/// Every index readable in a frame (RGBA, W×H): [{ value 1…13, suit, score 0…1, x, y (frame
/// px, the suit mark's middle) }]. Usually none, one, or the same card twice (two corners).
export function findIndexes(rgba, W, H, { limits = LIMITS, debug = null } = {}) {
  // How dark each pixel is, by its DARKEST colour channel: red ink is then as dark as black.
  const full = new Uint8Array(W * H);
  for (let i = 0, j = 0; i < full.length; i++, j += 4) { const r = rgba[j], g = rgba[j + 1], b = rgba[j + 2]; full[i] = r < g ? (r < b ? r : b) : (g < b ? g : b); }
  const s = Math.min(1, LONG / Math.max(W, H)), w = Math.round(W * s), h = Math.round(H * s);
  const v = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const x0 = Math.floor(x / s), x1 = Math.min(W, Math.max(x0 + 1, Math.floor((x + 1) / s))), y0 = Math.floor(y / s), y1 = Math.min(H, Math.max(y0 + 1, Math.floor((y + 1) / s)));
    let sum = 0;
    for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) sum += full[yy * W + xx];
    v[y * w + x] = sum / ((x1 - x0) * (y1 - y0));
  }
  // Marks: dark details on something light — light being the same spot with such details
  // filled in (a closing far wider than any index).
  const white = closing(v, w, h, Math.round(Math.max(w, h) * 0.03)), mask = new Uint8Array(w * h);
  for (let i = 0; i < mask.length; i++) if (white[i] >= 80 && v[i] < white[i] * 0.62) mask[i] = 1;
  const { comps } = components(mask, w, h);
  const maxSize = Math.max(w, h) * 0.16;
  const blobs = [];
  for (const c of comps) {
    const bw = c.maxX - c.minX + 1, bh = c.maxY - c.minY + 1, size = Math.max(bw, bh);
    if (size < 5 || size > maxSize || Math.min(bw, bh) < 3 || c.area < 10) continue;
    if (c.minX <= 0 || c.minY <= 0 || c.maxX >= w - 1 || c.maxY >= h - 1) continue;
    blobs.push({ id: c.id, cx: (c.minX + c.maxX + 1) / 2, cy: (c.minY + c.maxY + 1) / 2, bw, bh, size, solid: c.area / (bw * bh) >= 0.42 && bw / bh > 0.55 && bw / bh < 1.8 });
  }
  if (debug) { debug.w = w; debug.h = h; debug.mask = mask; debug.blobs = blobs; debug.tried = 0; debug.why = {}; }
  // Pairs: a solid mark (the suit) with another mark (the value) the right distance away.
  const found = new Map();
  let tries = 0;
  for (const S of blobs) {
    if (!S.solid) continue;
    for (const R of blobs) {
      if (R === S || R.size < S.size * 0.75 || R.size > S.size * 3.2) continue;
      const d = Math.hypot(S.cx - R.cx, S.cy - R.cy);
      if (d < S.size * 0.75 || d > S.size * 2.7) continue;
      if (++tries > 220) break;
      const hit = closeUp(rgba, full, W, H, s, white[Math.floor(S.cy) * w + Math.floor(S.cx)], S, R, limits, debug);
      if (!hit) continue;
      // (The same index reached from two pairs — the 1 and the 0 of a ten — is one reading.)
      const key = `${Math.round(hit.x / (S.size / s))},${Math.round(hit.y / (S.size / s))}`, was = found.get(key);
      if (!was || hit.score > was.score) found.set(key, hit);
    }
  }
  if (debug) debug.tried = tries;
  return [...found.values()];
}

/// The card in a frame, if exactly one can be read: { value, suit, score, seen (how many of
/// its indexes were read), x, y } or null.
export function readCard(rgba, W, H, opts) {
  const hits = findIndexes(rgba, W, H, opts);
  if (!hits.length) return null;
  const a = hits.reduce((p, q) => (q.score > p.score ? q : p));
  for (const hh of hits) if (hh.value !== a.value || hh.suit !== a.suit) return null;   // two different cards: say nothing
  return { value: a.value, suit: a.suit, score: a.score, seen: hits.length, x: a.x, y: a.y };
}

/// One possible index, read from a close-up: suit mark S with value mark R "above" it.
function closeUp(rgba, full, W, H, s, light, S, R, limits, debug) {
  const no = (why) => { if (debug) debug.why[why] = (debug.why[why] || 0) + 1; return null; };
  let cx = S.cx, cy = S.cy, p = S.size;
  let ux = S.cx - R.cx, uy = S.cy - R.cy;                     // "down": from the value to the suit
  { const n = Math.hypot(ux, uy); ux /= n; uy /= n; }
  const val = new Float32Array(CW * CH), soft = new Float32Array(CW * CH), bin = new Uint8Array(CW * CH);
  let suit = null, group = null, labels = null, ids = null, q = 1, ink = 0;
  for (let pass = 0; pass < 3; pass++) {
    q = p / PIP;                                              // searched-picture pixels per close-up pixel
    const rx = uy, ry = -ux;                                  // "right"
    for (let y = 0; y < CH; y++) for (let x = 0; x < CW; x++) {
      const ax = cx + (rx * (x + 0.5 - CX) + ux * (y + 0.5 - CY)) * q, ay = cy + (ry * (x + 0.5 - CX) + uy * (y + 0.5 - CY)) * q;
      const fx = ax / s - 0.5, fy = ay / s - 0.5;
      if (fx < 0 || fy < 0 || fx > W - 1.001 || fy > H - 1.001) { val[y * CW + x] = 255; continue; }
      const x0 = fx | 0, y0 = fy | 0, tx = fx - x0, ty = fy - y0, i = y0 * W + x0;
      val[y * CW + x] = (full[i] * (1 - tx) + full[i + 1] * tx) * (1 - ty) + (full[i + W] * (1 - tx) + full[i + W + 1] * tx) * ty;
    }
    // Ink against paper, in this close-up: the paper's level is known; the ink's is the
    // darker end of what is clearly not paper.
    const tones = new Uint32Array(256);
    let n = 0;
    for (let i = 0; i < val.length; i++) if (val[i] < light * 0.6) { tones[val[i] | 0] += 1; n += 1; }
    if (n < 30) return no('no ink');
    ink = 0;
    for (let seen = tones[0]; seen < n * 0.25 && ink < 255;) seen += tones[++ink];
    const top = light * 0.94, cut = ink + (top - ink) * 0.5;
    for (let i = 0; i < val.length; i++) { soft[i] = Math.min(1, Math.max(0, (top - val[i]) / (top - ink))); bin[i] = val[i] < cut ? 1 : 0; }
    const cc = components(bin, CW, CH);
    labels = cc.labels;
    // The suit mark: whatever is at the spot it was expected.
    let sid = 0;
    for (let rr = 0; rr <= 5 && !sid; rr++) for (let dy = -rr; dy <= rr && !sid; dy++) for (let dx = -rr; dx <= rr && !sid; dx++) sid = labels[(CY + dy) * CW + CX + dx];
    if (!sid) return no('no suit mark');
    suit = cc.comps[sid - 1];
    const sw = suit.maxX - suit.minX + 1, sh = suit.maxY - suit.minY + 1;
    const edge = (c) => c.minX <= 0 || c.minY <= 0 || c.maxX >= CW - 1 || c.maxY >= CH - 1;
    if (edge(suit) || Math.max(sw, sh) < PIP * 0.55 || Math.max(sw, sh) > PIP * 1.6 || suit.area < sw * sh * 0.4) return no('suit mark shape');
    // The value: the tallest mark just above it, in line with it — and any mark beside that
    // one of the same height (the two figures of a ten).
    const scx = (suit.minX + suit.maxX + 1) / 2, scy = (suit.minY + suit.maxY + 1) / 2;
    let main = null;
    const above = [];
    for (const c of cc.comps) {
      if (c === suit || edge(c)) continue;
      const ch = c.maxY - c.minY + 1, ccx = (c.minX + c.maxX + 1) / 2;
      if (ch < PIP * 0.7 || ch > PIP * 2.9 || c.maxY > suit.minY + 1 || suit.minY - c.maxY > PIP * 0.95 || Math.abs(ccx - scx) > PIP * 1.05) continue;
      above.push(c);
      if (!main || ch > main.maxY - main.minY + 1) main = c;
    }
    if (!main) return no('no value mark');
    const mh = main.maxY - main.minY + 1;
    group = { minX: main.minX, minY: main.minY, maxX: main.maxX, maxY: main.maxY, n: 1 };
    ids = new Set([main.id]);
    for (const c of above) {
      if (c === main) continue;
      const ch = c.maxY - c.minY + 1, overlap = Math.min(c.maxY, main.maxY) - Math.max(c.minY, main.minY) + 1;
      const gap = Math.max(c.minX - group.maxX, group.minX - c.maxX);
      if (ch < mh * 0.72 || overlap < mh * 0.7 || gap > mh * 0.4) continue;
      ids.add(c.id); group.n += 1;
      group.minX = Math.min(group.minX, c.minX); group.minY = Math.min(group.minY, c.minY); group.maxX = Math.max(group.maxX, c.maxX); group.maxY = Math.max(group.maxY, c.maxY);
    }
    if (group.maxX - group.minX + 1 > mh * 1.9) return no('value too wide');
    if (pass === 2) break;
    // Look again squarely: centred on the suit mark, at its true size, with "down" running
    // from the middle of the value to the middle of the suit.
    const gx = (group.minX + group.maxX + 1) / 2 - scx, gy = scy - (group.minY + group.maxY + 1) / 2;
    const ox = (scx - CX) * q, oy = (scy - CY) * q;
    cx += rx * ox + ux * oy; cy += ry * ox + uy * oy;
    const nx = rx * -gx + ux * gy, ny = ry * -gx + uy * gy, nn = Math.hypot(nx, ny);
    const turn = Math.abs(Math.atan2(gx, gy)), grow = Math.max(sw, sh) / PIP;
    ux = nx / nn; uy = ny / nn; p *= grow;
    if (pass === 1 && turn < 0.02 && Math.abs(grow - 1) < 0.04 && Math.hypot(ox, oy) < q) break;
  }
  // Colour: of the suit mark and of the value, against the paper beside them.
  const colour = (want) => {
    let r = 0, g = 0, b = 0, n = 0, wr = 0, wg = 0, wb = 0, wn = 0;
    const rx = uy, ry = -ux;
    for (let y = 0; y < CH; y++) for (let x = 0; x < CW; x++) {
      const i = y * CW + x, isInk = want.has(labels[i]) && soft[i] > 0.75, isPaper = soft[i] < 0.06 && Math.abs(x - CX) < PIP * 1.6;
      if (!isInk && !isPaper) continue;
      const ax = cx + (rx * (x + 0.5 - CX) + ux * (y + 0.5 - CY)) * q, ay = cy + (ry * (x + 0.5 - CX) + uy * (y + 0.5 - CY)) * q;
      const fx = Math.floor(ax / s), fy = Math.floor(ay / s);
      if (fx < 0 || fy < 0 || fx >= W || fy >= H) continue;
      const j = (fy * W + fx) * 4;
      if (isInk) { r += rgba[j]; g += rgba[j + 1]; b += rgba[j + 2]; n += 1; } else { wr += rgba[j]; wg += rgba[j + 1]; wb += rgba[j + 2]; wn += 1; }
    }
    if (n < 4 || wn < 20) return null;
    const R1 = (r / n) / Math.max(1, wr / wn), G1 = (g / n) / Math.max(1, wg / wn), B1 = (b / n) / Math.max(1, wb / wn);
    const hi = Math.max(R1, G1, B1), lo = Math.min(R1, G1, B1);
    if (R1 >= 0.42 && R1 - Math.max(G1, B1) >= 0.2) return 'red';
    if (hi <= 0.62 && hi - lo <= 0.2) return 'black';
    return null;
  };
  const tone = colour(new Set([suit.id]));
  if (!tone) return no('suit colour unclear');
  if (colour(ids) !== tone) return no('value a different colour');
  // The suit's shape — which must be a suit this way up (else "down" was the wrong way), and
  // one that goes with the colour.
  const sv = stretch(soft, CW, suit.minX, suit.minY, suit.maxX - suit.minX + 1, suit.maxY - suit.minY + 1, SW, SH, labels, new Set([suit.id])), s1 = suitOf(sv);
  if (debug && debug.cands) {
    const shape = lines(labels, CW, ids, group, GW, GH), val = valueOf(shape);
    debug.cands.push({ tone, suitSays: `${s1.suit}:${s1.conf.toFixed(2)}`, value: `${val.value}:${val.conf.toFixed(2)}`, n: group.n, wide: (group.maxX - group.minX + 1) / (group.maxY - group.minY + 1), soft: debug.soft ? Float32Array.from(soft) : null, sv, rv: shape, x: cx / s, y: cy / s, ux, uy });
  }
  if (!s1.suit || s1.conf < limits.suit) return no('suit unclear');
  if (!!RED[s1.suit] !== (tone === 'red')) return no('suit the wrong colour');
  // The value's shape.
  const rv = lines(labels, CW, ids, group, GW, GH), r1 = valueOf(rv);
  if (!r1.value || r1.conf < limits.value) return no('value unclear');
  // A ten is two figures side by side, and nothing else is.
  if ((r1.value === 10) !== (group.n >= 2)) return no('ten or not');
  if (debug) debug.why.read = (debug.why.read || 0) + 1;
  return { value: r1.value, suit: s1.suit, score: Math.min(r1.conf, s1.conf), valueSure: r1.conf, suitSure: s1.conf, x: cx / s, y: cy / s, size: p / s };
}
