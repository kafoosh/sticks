// Finding a pen drawing in a camera frame and turning it back into pen strokes.
//
// The rig (src/rig) wants what a touch screen would have given it: polylines, one per pen
// stroke. A camera gives pixels. So: threshold the ink against the local paper brightness,
// group the ink into connected blobs, thin the chosen blob to one-pixel centre lines, and
// walk those lines into strokes. DOM-free, so it runs under `node --test`.

/// Height (px) a figure is resampled to before tracing. The rig's constants were tuned on
/// phone drawings of about this size, so everything downstream works in these units.
export const NORM_H = 280;

// ---------------------------------------------------------------------------------------
// Threshold

/// Ink mask: 1 where a pixel belongs to a thin dark LINE on lighter paper.
///
/// Two tests, both needed. (1) Darker than the average of its (2r+1)² surround — copes
/// with uneven light. (2) Darker than the same spot with thin dark lines filled in (a
/// greyscale closing of radius `lineR`), which is what makes it a line: a pen stroke
/// narrower than 2·lineR fills in and passes, while a big dark area — the table beyond the
/// edge of the paper, a shadow — doesn't fill in and so is never mistaken for ink.
export function inkMask(gray, w, h, r, k = 0.13, minDelta = 9, lineR = Math.max(3, Math.round(r * 0.4))) {
  const W = w + 1, integral = new Float64Array(W * (h + 1));
  for (let y = 0; y < h; y++) {
    let row = 0;
    for (let x = 0; x < w; x++) {
      row += gray[y * w + x];
      integral[(y + 1) * W + x + 1] = integral[y * W + x + 1] + row;
    }
  }
  const closed = closing(gray, w, h, lineR);
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - r), y1 = Math.min(h, y + r + 1);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - r), x1 = Math.min(w, x + r + 1);
      const sum = integral[y1 * W + x1] - integral[y0 * W + x1] - integral[y1 * W + x0] + integral[y0 * W + x0];
      const mean = sum / ((x1 - x0) * (y1 - y0));
      const i = y * w + x, g = gray[i], c = closed[i];
      if (mean - g > Math.max(minDelta, mean * k) && c - g > Math.max(minDelta, c * k)) out[i] = 1;
    }
  }
  return out;
}

/// Greyscale closing (largest value over a (2r+1)² square, then smallest): fills in dark
/// details narrower than about 2r and leaves everything else as it was.
function closing(gray, w, h, r) {
  const a = new Uint8Array(w * h), b = new Uint8Array(w * h);
  slide(gray, a, w, h, r, true, true); slide(a, b, w, h, r, false, true);      // dilate (brightest)
  slide(b, a, w, h, r, true, false); slide(a, b, w, h, r, false, false);       // erode (darkest)
  return b;
}

/// dst = the largest (or smallest) of src over the 2r+1 pixels round each one, along rows
/// (`horiz`) or columns; the window is cut short at the picture's edge. Done in three
/// sweeps of each line whatever r is (van Herk / Gil–Werman): the line is cut into blocks
/// of 2r+1, and any window is the end of one block's running maximum from its start plus
/// the beginning of the next block's running maximum from its end.
function slide(src, dst, w, h, r, horiz, useMax) {
  const n = horiz ? w : h, m = horiz ? h : w, stride = horiz ? 1 : w, k = 2 * r + 1, N = n + 2 * r;
  // (The line is padded by r each end with a value that never wins.)
  const line = new Uint8Array(N).fill(useMax ? 0 : 255), fwd = new Uint8Array(N), back = new Uint8Array(N);
  for (let j = 0; j < m; j++) {
    const off = horiz ? j * w : j;
    for (let i = 0, q = off; i < n; i++, q += stride) line[i + r] = src[q];
    if (useMax) {
      for (let i = 0, c = 0; i < N; i++) { const v = line[i]; fwd[i] = c === 0 || v > fwd[i - 1] ? v : fwd[i - 1]; if (++c === k) c = 0; }
      for (let i = N - 1, c = (N - 1) % k; i >= 0; i--) { const v = line[i]; back[i] = i === N - 1 || c === k - 1 || v > back[i + 1] ? v : back[i + 1]; if (--c < 0) c = k - 1; }
      for (let i = 0, q = off; i < n; i++, q += stride) { const x = back[i], y = fwd[i + 2 * r]; dst[q] = x > y ? x : y; }
    } else {
      for (let i = 0, c = 0; i < N; i++) { const v = line[i]; fwd[i] = c === 0 || v < fwd[i - 1] ? v : fwd[i - 1]; if (++c === k) c = 0; }
      for (let i = N - 1, c = (N - 1) % k; i >= 0; i--) { const v = line[i]; back[i] = i === N - 1 || c === k - 1 || v < back[i + 1] ? v : back[i + 1]; if (--c < 0) c = k - 1; }
      for (let i = 0, q = off; i < n; i++, q += stride) { const x = back[i], y = fwd[i + 2 * r]; dst[q] = x < y ? x : y; }
    }
  }
}

// ---------------------------------------------------------------------------------------
// Ruled lines

/// Remove long straight lines from an ink mask — the rules on lined or squared paper, a
/// margin, a printed box — keeping the pen wherever it crosses one. Lines are found with a
/// Hough transform (any angle, so a page turned on the table is fine); a line counts when it
/// has a straight run at least `minLen` px long, which no part of a stick figure has.
/// With `gray`, a stretch of a rule that is much darker than the rest of it is kept too (a
/// black pen drawn along a printed grey or blue rule). A rule must also be no thicker than
/// `maxWidth`, and run at least `span` of the way across the picture — what tells a printed
/// rule from a long straight pen line (a marker figure's body and leg in one line).
/// Returns a new mask.
export function removeRuledLines(mask, w, h, minLen, gray = null, { maxWidth = Infinity, span = 0 } = {}) {
  const out = Uint8Array.from(mask);
  let n = 0;
  for (let i = 0; i < w * h; i++) if (mask[i]) n += 1;
  if (n < minLen) return out;
  const A = 180, D = Math.ceil(Math.hypot(w, h)), cos = new Float64Array(A), sin = new Float64Array(A);
  for (let a = 0; a < A; a++) { cos[a] = Math.cos(a * Math.PI / A); sin[a] = Math.sin(a * Math.PI / A); }
  const acc = new Uint16Array(A * (2 * D + 1));
  // Vote with a sample of the ink (enough for lines hundreds of px long).
  const step = Math.max(1, Math.floor(n / 40000)), votes = Math.ceil(n / step);
  const vx = new Float64Array(votes), vy = new Float64Array(votes);
  for (let y = 0, i = 0, v = 0; y < h; y++) for (let x = 0; x < w; x++) if (mask[y * w + x]) { if (i % step === 0) { vx[v] = x; vy[v] = y; v += 1; } i += 1; }
  for (let a = 0; a < A; a++) {
    const c = cos[a], sn = sin[a], row = a * (2 * D + 1) + D;
    for (let v = 0; v < votes; v++) acc[row + Math.round(vx[v] * c + vy[v] * sn)] += 1;
  }
  const need = (minLen * 0.75) / step;
  const lines = [];
  for (let a = 0; a < A; a++) for (let r = 1; r < 2 * D; r++) {
    const v = acc[a * (2 * D + 1) + r];
    if (v < need) continue;
    let peak = true;                                     // a local maximum (wrapping in angle)
    for (let da = -2; da <= 2 && peak; da++) for (let dr = -2; dr <= 2; dr++) {
      if (!da && !dr) continue;
      let aa = a + da, rr = r + dr;
      if (aa < 0) { aa += A; rr = 2 * D - rr; } else if (aa >= A) { aa -= A; rr = 2 * D - rr; }
      if (rr < 0 || rr > 2 * D) continue;
      const u = acc[aa * (2 * D + 1) + rr];
      if (u > v || (u === v && (da < 0 || (da === 0 && dr < 0)))) { peak = false; break; }
    }
    if (peak) lines.push({ a, rho: r - D });
  }
  if (!lines.length) return out;
  const isLine = new Uint8Array(w * h), lineNormal = new Int16Array(w * h), lineId = new Int32Array(w * h);
  let id = 0;
  const found = [];                                        // confirmed long straight runs
  for (const { a, rho } of lines) {
    id += 1;
    const c = cos[a], sn = sin[a], dx = -sn, dy = c;           // along the line
    // Walk the full length of the line through the image, collecting ink runs (small gaps
    // allowed: rules are faint, and a camera breaks them up).
    const x0 = rho * c, y0 = rho * sn;
    let run = [], gap = 0, t0 = 0, t1 = 0;
    // The line's chord through the picture, for `span`.
    let tIn = Infinity, tOut = -Infinity;
    for (let t = -D; t <= D; t += 1) { const px = x0 + dx * t, py = y0 + dy * t; if (px >= 0 && py >= 0 && px <= w - 1 && py <= h - 1) { tIn = Math.min(tIn, t); tOut = Math.max(tOut, t); } }
    const chord = Math.max(0, tOut - tIn), maxGap = Math.max(3, Math.round(chord * 0.025));
    const flush = () => { if (t1 - t0 >= minLen && t1 - t0 >= span * chord) found.push({ a, rho, id, len: t1 - t0, px: run.slice() }); run = []; gap = 0; };
    for (let t = -D; t <= D; t += 1) {
      const px = x0 + dx * t, py = y0 + dy * t;
      if (px < -1 || py < -1 || px > w || py > h) { if (run.length) flush(); continue; }
      let hit = false;
      if (!run.length) t0 = t;
      for (let k = -2; k <= 2; k++) {                          // the rule's own width
        const x = Math.round(px + c * k * 0.75), y = Math.round(py + sn * k * 0.75);
        if (x < 0 || y < 0 || x >= w || y >= h || !mask[y * w + x]) continue;
        run.push(y * w + x); hit = true;
      }
      if (hit) { gap = 0; t1 = t; }
      else if (run.length && ++gap > maxGap) flush();
    }
    flush();
  }
  // Only rules that come as a family count: ruled paper has several parallel lines, well
  // apart (squared paper has a family each way). A lone straight line — or one thick pen
  // stroke seen as a few near-identical lines — may be part of a drawing; and a line merely
  // square to some family (wood grain, say) is not a rule either.
  const near = (a, b) => { const d = Math.abs(a - b) % A; return Math.min(d, A - d) <= 2; };
  const distinct = (l) => {
    const fam = found.filter((m) => near(m.a, l.a)), rhos = fam.map((m) => m.rho).sort((p, q) => p - q);
    // How thick these lines are, roughly: ink per unit length along one of them.
    const thick = Math.max(2, ...fam.map((m) => m.px.length / Math.max(1, m.len)));
    let n = 0, last = -Infinity;
    for (const r of rhos) if (r - last > Math.max(6, thick * 2.5)) { n += 1; last = r; }
    return n;
  };
  const families = found.filter((l) => distinct(l) >= 3).map((l) => l.a);
  // Which way the rules run (radians; the most common family), for the eraser.
  if (families.length) { const a = families[0]; out.ruleAngle = Math.atan2(cos[a], -sin[a]); }
  for (const l of found) {
    if (!families.some((a) => near(l.a, a))) continue;
    for (const i of l.px) { isLine[i] = 1; lineNormal[i] = l.a; lineId[i] = l.id; }
  }
  // How thick each rule is: the ink across it, at each of its pixels. A stretch where it is
  // much thicker than that rule usually is, is a pen line drawn along the rule.
  const across = (i) => {
    const x = i % w, y = (i - x) / w, a = lineNormal[i], c = cos[a], sn = sin[a];
    let n = 1;
    for (const sg of [1, -1]) for (let k = 1; k <= 12; k++) {
      const X = Math.round(x + c * k * sg), Y = Math.round(y + sn * k * sg);
      if (X < 0 || Y < 0 || X >= w || Y >= h || !mask[Y * w + X]) break;
      n += 1;
    }
    return n;
  };
  const widths = new Map();
  for (let i = 0; i < w * h; i++) if (isLine[i]) { const l = widths.get(lineId[i]) || []; if (l.length < 400) l.push(across(i)); widths.set(lineId[i], l); }
  const usual = new Map();
  for (const [k, l] of widths) { l.sort((p, q) => p - q); usual.set(k, l[l.length >> 1]); }
  // How dark each pixel is against the paper just beside it (a ratio, so a shadow across
  // the page changes nothing), and each rule's usual darkness.
  const rel = (i) => {
    const x = i % w, y = (i - x) / w, a = lineNormal[i], c = cos[a], sn = sin[a];
    let paper = 0;
    for (const sg of [1, -1]) for (let k = 3; k <= 8; k++) {
      const X = Math.round(x + c * k * sg), Y = Math.round(y + sn * k * sg);
      if (X < 0 || Y < 0 || X >= w || Y >= h) break;
      if (!mask[Y * w + X]) { paper = Math.max(paper, gray[Y * w + X]); break; }
    }
    return paper > 0 ? gray[i] / paper : 1;
  };
  const shade = new Map();
  if (gray) {
    const tones = new Map();
    for (let i = 0; i < w * h; i++) if (isLine[i]) { const l = tones.get(lineId[i]) || []; if (l.length < 400) l.push(rel(i)); tones.set(lineId[i], l); }
    for (const [k, l] of tones) { l.sort((p, q) => p - q); shade.set(k, l[l.length >> 1]); }
  }
  // Is there other ink just beyond the rule, out from (x, y) along (c, sn)?
  const other = (x, y, c, sn) => {
    for (let k = 2; k <= 5; k++) {
      const X = Math.round(x + c * k), Y = Math.round(y + sn * k);
      if (X < 0 || Y < 0 || X >= w || Y >= h) return false;
      const j = Y * w + X;
      if (mask[j] && !isLine[j]) return true;
    }
    return false;
  };
  // Take the rules out, but keep the pen where it crosses one (there is other ink just beyond
  // the rule on BOTH sides) or runs along one (it is much thicker there).
  for (let i = 0; i < w * h; i++) {
    if (!isLine[i]) continue;
    const u = usual.get(lineId[i]);
    if (u > maxWidth) continue;                            // too thick for a printed rule
    if (across(i) >= Math.max(u * 1.7, u + 2.5)) continue;
    if (gray && rel(i) < shade.get(lineId[i]) * 0.72) continue;
    const x = i % w, y = (i - x) / w, a = lineNormal[i];
    if (!(other(x, y, cos[a], sin[a]) && other(x, y, -cos[a], -sin[a]))) out[i] = 0;
  }
  return out;
}

// ---------------------------------------------------------------------------------------
// Connected blobs

/// 8-connected components. Returns { labels: Int32Array (0 = none), comps: [{id, area,
/// minX, minY, maxX, maxY}] } with comps[i].id === i + 1.
export function components(mask, w, h) {
  const labels = new Int32Array(w * h), comps = [], stack = [];
  for (let start = 0; start < w * h; start++) {
    if (!mask[start] || labels[start]) continue;
    const id = comps.length + 1;
    const c = { id, area: 0, minX: w, minY: h, maxX: 0, maxY: 0 };
    labels[start] = id; stack.push(start);
    while (stack.length) {
      const i = stack.pop(), x = i % w, y = (i - x) / w;
      c.area += 1;
      if (x < c.minX) c.minX = x; if (x > c.maxX) c.maxX = x;
      if (y < c.minY) c.minY = y; if (y > c.maxY) c.maxY = y;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= w) continue;
          const j = yy * w + xx;
          if (mask[j] && !labels[j]) { labels[j] = id; stack.push(j); }
        }
      }
    }
    comps.push(c);
  }
  return { labels, comps };
}

/// Candidate figures in a whole frame: blobs that are the right size and shape to be a
/// little standing drawing, each with the smaller blobs that belong to it (a head that
/// doesn't quite touch the neck, a face inside the head). Biggest first.
/// Returns [{ minX, minY, maxX, maxY, ids:[component ids], area }].
export function findCandidates(mask, w, h, { minH = 0.05, maxH = 0.96, gray = null, reach = 6 } = {}) {
  const { labels, comps } = components(mask, w, h);
  if (gray) markPaperEdges(comps, labels, mask, gray, w, h, reach);
  markFrames(comps, labels, w, h);
  const edge = (c) => c.paperEdge || c.minX <= 1 || c.minY <= 1 || c.maxX >= w - 2 || c.maxY >= h - 2;
  const seeds = comps.filter((c) => {
    const bw = c.maxX - c.minX + 1, bh = c.maxY - c.minY + 1;
    if (bh < h * minH * 0.6 || bh > h * maxH || edge(c)) return false;
    if (gray && c.around === undefined) return false;   // no paper round it: texture, not a drawing
    if (bh < bw * 0.35) return false;                // (a figure may be drawn at a slant)
    return c.area < bw * bh * 0.4;                    // a line drawing, not a solid patch
  }).sort((a, b) => b.area - a.area).slice(0, 12);

  const out = [], used = new Set();
  for (const s of seeds) {
    if (used.has(s.id)) continue;
    const g = { minX: s.minX, minY: s.minY, maxX: s.maxX, maxY: s.maxY, ids: [s.id], area: s.area };
    for (let round = 0; round < 3; round++) {
      const gh = g.maxY - g.minY + 1;
      const m = gh * 0.18, up = gh * 0.4;
      let grew = false;
      for (const c of comps) {
        if (g.ids.includes(c.id) || used.has(c.id) || edge(c)) continue;
        if (c.area > s.area || c.area < 2) continue;
        // A speck only belongs if it lies within the figure (an eye), not out beyond it.
        if (c.area < 6 && (c.minX < g.minX || c.maxX > g.maxX || c.minY < g.minY || c.maxY > g.maxY)) continue;
        // A thin straight sliver is a paper edge or a ruled line, not part of a figure.
        const cw = c.maxX - c.minX + 1, ch = c.maxY - c.minY + 1;
        if (Math.min(cw, ch) <= 4 && Math.max(cw, ch) >= 4 * Math.min(cw, ch)) continue;
        if (c.maxX < g.minX - m || c.minX > g.maxX + m || c.maxY < g.minY - up || c.minY > g.maxY + m) continue;
        // Never reach far above the main stroke (a separate head sits right on top of it);
        // beyond that it is texture past the edge of the page, not more of the figure.
        if (c.minY < s.minY - (s.maxY - s.minY + 1) * 1.0) continue;
        // …and it must be on the same paper: a speck on the darker table just past the edge
        // of the card is not part of the drawing.
        // (A piece buried in so much other "ink" that no paper shows round it is texture too.)
        if (s.around && (c.around === undefined || c.around < s.around * 0.88)) continue;
        // Must sit mostly within the figure's column, so a neighbouring scribble stays out.
        const cx = (c.minX + c.maxX) / 2;
        if (cx < g.minX - m || cx > g.maxX + m) continue;
        g.ids.push(c.id); g.area += c.area;
        g.minX = Math.min(g.minX, c.minX); g.minY = Math.min(g.minY, c.minY);
        g.maxX = Math.max(g.maxX, c.maxX); g.maxY = Math.max(g.maxY, c.maxY);
        grew = true;
      }
      if (!grew) break;
    }
    // If the extra pieces spoil the shape, the main stroke may still be a figure by itself.
    const fits = (b) => { const bw = b.maxX - b.minX + 1, bh = b.maxY - b.minY + 1; return !(Math.max(bw, bh) < h * minH || bh > h * maxH || bh < bw * 0.45 || bh > bw * 6); };
    const pick = fits(g) ? g : fits(s) ? { minX: s.minX, minY: s.minY, maxX: s.maxX, maxY: s.maxY, ids: [s.id], area: s.area } : null;
    if (!pick) continue;
    for (const id of pick.ids) used.add(id);
    out.push(pick);
  }
  out.labels = labels;
  return out;
}

/// Mark components that are a big empty FRAME (`c.paperEdge = true`): the outline of a card
/// or page seen as a thin line (a white card on a white table has no brightness step to
/// give it away), a box printed on the paper, a ring drawn round the figure. Nearly all of
/// such a component's ink lies along the border of its own box, and it spans most of the
/// picture; a figure's ink is in the middle of its box. Left in, it swallows the figure
/// inside it.
function markFrames(comps, labels, w, h) {
  const big = Math.min(w, h) * 0.6;                     // (far bigger than a head, which is a ring too)
  const cand = comps.filter((c) => c.maxX - c.minX >= big && c.maxY - c.minY >= big);
  if (!cand.length) return;
  const rim = new Float64Array(comps.length + 1);
  const ids = new Set(cand.map((c) => c.id));
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const id = labels[y * w + x];
    if (!id || !ids.has(id)) continue;
    const c = comps[id - 1], bx = (c.maxX - c.minX) * 0.14, by = (c.maxY - c.minY) * 0.14;
    if (x < c.minX + bx || x > c.maxX - bx || y < c.minY + by || y > c.maxY - by) rim[id] += 1;
  }
  for (const c of cand) if (rim[c.id] >= c.area * 0.9) c.paperEdge = true;
}

/// Mark components that are the EDGE OF THE PAPER rather than something drawn on it
/// (`c.paperEdge = true`). A pen line has paper on both sides. The edge of a card on a table
/// — and the thin shadow the card casts — has paper on one side and table on the other, at
/// any angle. So around each dark pixel, `reach` pixels out in eight directions, compare the
/// lightest and darkest of what isn't ink; a component that is mostly beside such a step is
/// an edge.
function markPaperEdges(comps, labels, mask, gray, w, h, reach) {
  const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1], [0.7071, 0.7071], [-0.7071, 0.7071], [0.7071, -0.7071], [-0.7071, -0.7071]];
  const stepped = new Float64Array(comps.length + 1), total = new Float64Array(comps.length + 1);
  const around = new Float64Array(comps.length + 1), aroundN = new Float64Array(comps.length + 1);
  const reaches = [reach, reach * 1.6], vals = new Uint8Array(dirs.length * reaches.length);
  for (let y = 0; y < h; y += 1) for (let x = 0; x < w; x += 1) {
    const i = y * w + x, id = labels[i];
    if (!id) continue;
    if ((x + y) & 1) continue;                         // every other pixel is plenty
    let n = 0;
    for (let d = 0; d < dirs.length; d++) {
      const dx = dirs[d][0], dy = dirs[d][1];
      for (let q = 0; q < 2; q++) {
        const k = reaches[q], X = Math.round(x + dx * k), Y = Math.round(y + dy * k);
        if (X < 0 || Y < 0 || X >= w || Y >= h) continue;
        const j = Y * w + X;
        if (mask[j]) continue;
        // (kept in order as they come: an insertion sort of at most sixteen)
        const v = gray[j];
        let at = n;
        while (at > 0 && vals[at - 1] > v) { vals[at] = vals[at - 1]; at -= 1; }
        vals[at] = v; n += 1;
      }
    }
    total[id] += 1;
    if (n < 6) continue;
    // Typical light side against typical dark side: a step has a lot of both; a pen line
    // has paper nearly all round (a stray dark pixel or two don't count).
    around[id] += vals[n >> 1]; aroundN[id] += 1;
    const lo = vals[Math.floor(n * 0.25)], hi = vals[Math.floor(n * 0.75)];
    if (hi - lo > Math.max(22, hi * 0.16)) stepped[id] += 1;
  }
  for (const c of comps) {
    if (total[c.id] >= 4 && stepped[c.id] > total[c.id] * 0.5) c.paperEdge = true;
    if (aroundN[c.id]) c.around = around[c.id] / aroundN[c.id];   // how light its surroundings are
  }
}

/// Which way is up for a traced figure: the angle (radians, clockwise from straight up on
/// the image) of the line from the body to the head — the head being the biggest closed
/// loop. 0 when it can't tell.
export function uprightTilt(strokes) {
  let head = null, best = 0;
  for (const s of strokes) {
    if (s.length < 10) continue;
    const a = s[0], b = s[s.length - 1];
    if (Math.hypot(a.x - b.x, a.y - b.y) > 4) continue;
    let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
    for (const p of s) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); }
    const area = (x1 - x0) * (y1 - y0);
    if (area > best) { best = area; head = { x: (x0 + x1) / 2, y: (y0 + y1) / 2, s }; }
  }
  if (!head) return 0;
  let sx = 0, sy = 0, n = 0;
  for (const s of strokes) { if (s === head.s) continue; for (const p of s) { sx += p.x; sy += p.y; n += 1; } }
  if (n < 10) return 0;
  return Math.atan2(head.x - sx / n, -(head.y - sy / n));
}

// ---------------------------------------------------------------------------------------
// Thinning (Zhang–Suen), then removal of the staircase corners it leaves behind

export function thin(mask, w, h) {
  // Worked on a copy with a one-pixel empty border (so no neighbour is ever out of bounds),
  // and only ever visiting the pixels still set.
  const W = w + 2, img = new Uint8Array(W * (h + 2));
  let count = 0;
  for (let i = 0; i < w * h; i++) if (mask[i]) count += 1;
  let set = new Int32Array(count);                        // where the set pixels are, in reading order
  for (let y = 0, n = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const v = mask[y * w + x];
    if (v) { const i = (y + 1) * W + x + 1; img[i] = v; set[n++] = i; }
  }
  const kill = new Int32Array(count);
  let changed = true;
  while (changed) {
    changed = false;
    for (let pass = 0; pass < 2; pass++) {
      let kills = 0;
      for (let q = 0; q < count; q++) {
        const i = set[q];
        const p2 = img[i - W], p3 = img[i - W + 1], p4 = img[i + 1], p5 = img[i + W + 1];
        const p6 = img[i + W], p7 = img[i + W - 1], p8 = img[i - 1], p9 = img[i - W - 1];
        const n = p2 + p3 + p4 + p5 + p6 + p7 + p8 + p9;
        if (n < 2 || n > 6) continue;
        const a = (!p2 && p3) + (!p3 && p4) + (!p4 && p5) + (!p5 && p6)
          + (!p6 && p7) + (!p7 && p8) + (!p8 && p9) + (!p9 && p2);
        if (a !== 1) continue;
        if (pass === 0 ? (p2 && p4 && p6) || (p4 && p6 && p8) : (p2 && p4 && p8) || (p2 && p6 && p8)) continue;
        kill[kills++] = i;
      }
      if (!kills) continue;
      changed = true;
      for (let q = 0; q < kills; q++) img[kill[q]] = 0;
      let n = 0;
      for (let q = 0; q < count; q++) if (img[set[q]]) set[n++] = set[q];
      count = n;
    }
  }
  // A corner pixel whose two straight neighbours already touch diagonally is redundant;
  // dropping it leaves every remaining pixel with a clean neighbour count.
  for (let q = 0; q < count; q++) {
    const i = set[q];
    const N = img[i - W], E = img[i + 1], S = img[i + W], W_ = img[i - 1];
    const NE = img[i - W + 1], SE = img[i + W + 1], SW = img[i + W - 1], NW = img[i - W - 1];
    if ((N && E && !SW && !S && !W_) || (E && S && !NW && !N && !W_)
      || (S && W_ && !NE && !N && !E) || (W_ && N && !SE && !S && !E)) img[i] = 0;
  }
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) out.set(img.subarray((y + 1) * W + 1, (y + 1) * W + 1 + w), y * w);
  return out;
}

// ---------------------------------------------------------------------------------------
// Centre lines → strokes

const NB = [[1, 0], [0, 1], [-1, 0], [0, -1], [1, 1], [-1, 1], [-1, -1], [1, -1]];   // straight first

/// Walk a thinned image into polylines. Lines are cut at every junction, short whiskers
/// (thinning noise) are dropped, and pieces that run straight through a junction are joined
/// back up, so two arms drawn as one line across the body come out as one stroke again.
export function traceStrokes(skel, w, h, { spur = 9, joinDeg = 38 } = {}) {
  const at = (x, y) => (x < 0 || y < 0 || x >= w || y >= h ? 0 : skel[y * w + x]);
  const degree = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (!skel[y * w + x]) continue;
    let n = 0;
    for (const [dx, dy] of NB) n += at(x + dx, y + dy);
    degree[y * w + x] = n;
  }
  // Nodes: line ends (1 neighbour), dots (0) and junctions (≥3; touching ones are one node).
  const nodeOf = new Int32Array(w * h).fill(-1), nodes = [];
  for (let i = 0; i < w * h; i++) {
    if (!skel[i] || nodeOf[i] >= 0) continue;
    const d = degree[i];
    if (d === 2) continue;
    const node = { id: nodes.length, pixels: [], x: 0, y: 0, junction: d >= 3, edges: [] };
    if (d >= 3) {
      const stack = [i]; nodeOf[i] = node.id;
      while (stack.length) {
        const j = stack.pop(), x = j % w, y = (j - x) / w;
        node.pixels.push(j);
        for (const [dx, dy] of NB) {
          const xx = x + dx, yy = y + dy;
          if (!at(xx, yy)) continue;
          const k = yy * w + xx;
          if (degree[k] >= 3 && nodeOf[k] < 0) { nodeOf[k] = node.id; stack.push(k); }
        }
      }
    } else { nodeOf[i] = node.id; node.pixels.push(i); }
    for (const j of node.pixels) { node.x += j % w; node.y += Math.floor(j / w); }
    node.x /= node.pixels.length; node.y /= node.pixels.length;
    nodes.push(node);
  }

  const visited = new Uint8Array(w * h);
  const edges = [];                                  // { a, b (node ids or -1), pts:[{x,y}] }
  const walk = (node, first) => {
    const pts = [{ x: node.x, y: node.y }];
    let cur = first, prev = -1, end = -1;
    for (;;) {
      visited[cur] = 1;
      const x = cur % w, y = (cur - x) / w;
      pts.push({ x, y });
      let next = -1, hit = -1;
      for (const [dx, dy] of NB) {
        const xx = x + dx, yy = y + dy;
        if (!at(xx, yy)) continue;
        const k = yy * w + xx;
        if (k === prev) continue;
        if (nodeOf[k] >= 0) {
          // Straight back into the node we just left only counts once we've gone somewhere.
          if (nodeOf[k] !== node.id || pts.length > 3) { if (hit < 0) hit = nodeOf[k]; }
        } else if (!visited[k] && next < 0) next = k;
      }
      if (hit >= 0 && (next < 0 || hit !== node.id || pts.length > 6)) { end = hit; break; }
      if (next < 0) break;
      prev = cur; cur = next;
    }
    if (end >= 0) pts.push({ x: nodes[end].x, y: nodes[end].y });
    return { a: node.id, b: end, pts };
  };
  for (const node of nodes) {
    for (const j of node.pixels) {
      const x = j % w, y = (j - x) / w;
      for (const [dx, dy] of NB) {
        const xx = x + dx, yy = y + dy;
        if (!at(xx, yy)) continue;
        const k = yy * w + xx;
        if (nodeOf[k] >= 0 || visited[k]) continue;
        edges.push(walk(node, k));
      }
    }
  }
  // Ends that touch a junction directly (no pixels between) are just whiskers: ignore.
  // What is left unvisited is a closed ring with no junction on it (a head on its own).
  const strokes = [];
  for (let i = 0; i < w * h; i++) {
    if (!skel[i] || visited[i] || nodeOf[i] >= 0) continue;
    const pts = [];
    let cur = i, prev = -1;
    for (;;) {
      visited[cur] = 1;
      const x = cur % w, y = (cur - x) / w;
      pts.push({ x, y });
      let next = -1;
      for (const [dx, dy] of NB) {
        const k = (y + dy) * w + x + dx;
        if (at(x + dx, y + dy) && k !== prev && !visited[k] && nodeOf[k] < 0) { next = k; break; }
      }
      if (next < 0) break;
      prev = cur; cur = next;
    }
    if (pts.length >= 6) { pts.push({ ...pts[0] }); strokes.push(pts); }
  }

  // Drop whiskers: a short line from a junction to a free end. Repeat, since removing one
  // can turn a junction into a plain pass-through.
  const len = (pts) => { let s = 0; for (let i = 1; i < pts.length; i++) s += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y); return s; };
  let live = edges.filter((e) => e.pts.length >= 2);
  const isEnd = (id) => id < 0 || !nodes[id].junction;
  live = live.filter((e) => !(len(e.pts) < spur && (isEnd(e.a) !== isEnd(e.b))));

  // Join through junctions. Each junction pairs off its most collinear arms.
  for (const n of nodes) n.edges = [];
  for (const e of live) { nodes[e.a].edges.push(e); if (e.b >= 0 && e.b !== e.a) nodes[e.b].edges.push(e); }
  const dirFrom = (e, id) => {                        // unit vector leaving node `id` along e
    const p = e.a === id ? e.pts : e.pts.slice().reverse();
    const q = p[Math.min(p.length - 1, 10)];
    const dx = q.x - p[0].x, dy = q.y - p[0].y, m = Math.hypot(dx, dy) || 1;
    return { x: dx / m, y: dy / m };
  };
  const merged = new Map();                           // edge → the chain it now belongs to
  const chainOf = (e) => { let c = e; while (merged.has(c)) c = merged.get(c); return c; };
  for (const n of nodes) {
    if (!n.junction) continue;
    const arms = n.edges.filter((e) => e.a !== e.b);  // a loop back to this node stays whole
    const pairs = [];
    for (let i = 0; i < arms.length; i++) for (let j = i + 1; j < arms.length; j++) {
      const a = dirFrom(arms[i], n.id), b = dirFrom(arms[j], n.id);
      const bend = Math.acos(Math.max(-1, Math.min(1, -(a.x * b.x + a.y * b.y)))) * 180 / Math.PI;
      pairs.push({ i, j, bend });
    }
    pairs.sort((p, q) => p.bend - q.bend);
    const taken = new Set();
    const limit = arms.length === 2 ? 181 : joinDeg;
    for (const p of pairs) {
      if (p.bend > limit || taken.has(p.i) || taken.has(p.j)) continue;
      const A = chainOf(arms[p.i]), B = chainOf(arms[p.j]);
      if (A === B) continue;
      taken.add(p.i); taken.add(p.j);
      // Orient A to end at n and B to start at n, then concatenate.
      const aPts = A.b === n.id ? A.pts : A.pts.slice().reverse();
      const aStart = A.b === n.id ? A.a : A.b;
      const bPts = B.a === n.id ? B.pts : B.pts.slice().reverse();
      const bEnd = B.a === n.id ? B.b : B.a;
      const C = { a: aStart, b: bEnd, pts: aPts.concat(bPts.slice(1)) };
      merged.set(A, C); merged.set(B, C);
    }
  }
  const seen = new Set();
  for (const e of live) {
    const c = chainOf(e);
    if (seen.has(c)) continue;
    seen.add(c);
    strokes.push(c.pts);
  }
  // Dots (an eye, a freckle): a pixel with no neighbours.
  for (const n of nodes) {
    if (!n.junction && n.pixels.length === 1 && degree[n.pixels[0]] === 0) strokes.push([{ x: n.x, y: n.y }]);
  }
  const out = strokes.map(smoothLine);
  // The lines as a graph, before joining and smoothing — what label.js reads the figure's
  // structure from: where lines end and meet (nodes), the lines between (edges, as pixel
  // paths from node a to node b; b < 0 where a line just stops), free-standing rings, dots.
  out.graph = {
    nodes: nodes.map((n) => ({ x: n.x, y: n.y })),
    edges: live.map((e) => ({ a: e.a, b: e.b, pts: e.pts })),
    rings: strokes.filter((st) => st.length >= 6 && st[0].x === st[st.length - 1].x && st[0].y === st[st.length - 1].y && !live.some((e) => e.pts === st)),
    dots: nodes.filter((n) => !n.junction && n.pixels.length === 1 && degree[n.pixels[0]] === 0).map((n) => ({ x: n.x, y: n.y })),
  };
  return out;
}

/// Take the pixel staircase out of a traced line and thin it to a point every few pixels.
export function smoothLine(pts) {
  if (pts.length < 4) return pts.map((p) => ({ x: p.x + 0.5, y: p.y + 0.5 }));
  const closed = Math.hypot(pts[0].x - pts[pts.length - 1].x, pts[0].y - pts[pts.length - 1].y) < 2.5;
  const n = pts.length, R = 3, out = [];
  for (let i = 0; i < n; i += 1) {
    let sx = 0, sy = 0, c = 0;
    const r = closed ? R : Math.min(R, i, n - 1 - i);     // open lines keep their ends
    for (let k = -r; k <= r; k++) {
      const p = pts[closed ? ((i + k) % (n - 1) + (n - 1)) % (n - 1) : i + k];
      sx += p.x; sy += p.y; c += 1;
    }
    out.push({ x: sx / c + 0.5, y: sy / c + 0.5 });
  }
  const keep = [];
  for (let i = 0; i < out.length; i++) if (i % 3 === 0 || i === out.length - 1) keep.push(out[i]);
  if (closed) keep[keep.length - 1] = { ...keep[0] };
  return keep;
}

// ---------------------------------------------------------------------------------------
// The whole thing, for one figure

/// Bilinear resample of the rectangle (sx, sy, sw, sh) of a grey image to dw×dh.
export function resample(gray, w, h, sx, sy, sw, sh, dw, dh) {
  const out = new Uint8Array(dw * dh);
  for (let y = 0; y < dh; y++) {
    const fy = Math.min(Math.max(sy + (y + 0.5) * sh / dh - 0.5, 0), h - 1);
    const y0 = Math.floor(fy), y1 = Math.min(h - 1, y0 + 1), ty = fy - y0;
    for (let x = 0; x < dw; x++) {
      const fx = Math.min(Math.max(sx + (x + 0.5) * sw / dw - 0.5, 0), w - 1);
      const x0 = Math.floor(fx), x1 = Math.min(w - 1, x0 + 1), tx = fx - x0;
      const a = gray[y0 * w + x0] * (1 - tx) + gray[y0 * w + x1] * tx;
      const b = gray[y1 * w + x0] * (1 - tx) + gray[y1 * w + x1] * tx;
      out[y * dw + x] = a * (1 - ty) + b * ty;
    }
  }
  return out;
}

/// Trace the figure in a grey crop that has already been scaled so the figure is about
/// NORM_H tall and roughly centred. Returns null if there's nothing figure-like in it, else
/// { strokes:[[{x,y}]], width (pen width, px), mask (Uint8Array, this figure's ink only),
///   box:{minX,minY,maxX,maxY} } — all in crop pixels.
export function traceFigure(gray, w, h) {
  // First pass with the usual line width; if the pen turns out to be thicker (a marker, or a
  // small drawing seen close up), look again with the line test sized to it.
  let r = Math.round(NORM_H * 0.09), lineR = Math.max(3, Math.round(r * 0.4));
  let pick = pickFigure(gray, w, h, r, lineR);
  if (!pick) return null;
  if (pick.width > lineR * 1.1) {
    lineR = Math.ceil(pick.width * 0.8) + 2; r = Math.max(r, Math.round(pick.width * 3.2));
    const again = pickFigure(gray, w, h, r, lineR);
    if (again && again.area >= pick.area * 0.9) pick = again;
  }
  const { own, fig, width } = pick;
  // The head as a shape: a round hole in the ink near the top. Its outline becomes one clean
  // closed stroke — what the rig expects a head to be — whatever hair, face or neck joins it.
  const head = findHead(own, w, h, width, fig);
  let strokes = traceStrokes(thin(own, w, h), w, h, { spur: Math.max(7, width * 2.2) });
  const graph = strokes.graph;
  if (head) {
    // Keep every traced line except the stretches running along the head's outline, which
    // the clean loop replaces. Limbs that pass close by stay whole.
    const kept = [];
    for (const st of strokes) {
      let run = [], runPart = null;
      const flush = () => { if (run.length >= 2 && runPart !== 'ring') kept.push(run); run = []; };
      for (const p of st) {
        const part = head.classify(p.x, p.y);
        if (part !== runPart) { flush(); runPart = part; }
        run.push(p);
      }
      flush();
      if (st.length === 1 && head.classify(st[0].x, st[0].y) === 'inner') kept.push(st);   // an eye
    }
    strokes = [head.loop, ...kept];
  }
  if (!strokes.length) return null;
  return { strokes, width, penWidth: pick.penWidth, mask: own, head: !!head, graph, headShape: head, ruleAngle: pick.ruleAngle, box: { minX: fig.minX, minY: fig.minY, maxX: fig.maxX, maxY: fig.maxY } };
}

/// The figure's ink in a crop (the candidate nearest the middle), and its pen width.
function pickFigure(gray, w, h, r, lineR) {
  const mask = removeRuledLines(inkMask(gray, w, h, r, 0.13, 9, lineR), w, h, Math.round(NORM_H * 0.5), gray, { span: 0.6 });
  const cands = findCandidates(mask, w, h, { minH: 0.3, maxH: 0.99, gray, reach: lineR + 4 });
  if (!cands.length) return null;
  const mid = (c) => Math.hypot((c.minX + c.maxX) / 2 - w / 2, (c.minY + c.maxY) / 2 - h / 2);
  cands.sort((a, b) => mid(a) - mid(b));
  const fig = cands[0], ids = new Set(fig.ids), labels = cands.labels;
  const own = new Uint8Array(w * h);
  let area = 0;
  for (let i = 0; i < w * h; i++) { const l = labels[i]; if (l && ids.has(l)) { own[i] = 1; area += 1; } }
  const skel = thin(own, w, h);
  let n = 0;
  for (let i = 0; i < w * h; i++) n += skel[i];
  if (n < 20) return null;
  // The pen's width as it should be DRAWN: the ink mask takes in the soft edge the camera
  // gives every line, so it is wider than the pen. Counting each pixel by how dark it is
  // (paper = 0, full ink = 1) gives the width of a solid line carrying the same ink.
  const inside = new Uint32Array(256), around = new Uint32Array(256);    // how many pixels of each tone
  let insideN = 0, aroundN = 0;
  for (let y = Math.max(0, fig.minY); y <= Math.min(h - 1, fig.maxY); y++) for (let x = Math.max(0, fig.minX); x <= Math.min(w - 1, fig.maxX); x++) {
    if (own[y * w + x]) { inside[gray[y * w + x]] += 1; insideN += 1; } else { around[gray[y * w + x]] += 1; aroundN += 1; }
  }
  // The tone at place `at` (0…) were the n pixels sorted from dark to light.
  const tone = (counts, n, at, none) => { if (at >= n) return none; let v = 0, seen = counts[0]; while (seen <= at) seen += counts[++v]; return v; };
  const inkTone = tone(inside, insideN, Math.floor(insideN * 0.1), 0), paperTone = tone(around, aroundN, Math.floor(aroundN * 0.7), 255);
  let dark = 0;
  if (paperTone - inkTone > 10) for (let i = 0; i < w * h; i++) if (own[i]) dark += Math.min(1, Math.max(0, (paperTone - gray[i]) / (paperTone - inkTone)));
  const width = Math.max(2, Math.min(area / n, 24));
  const penWidth = dark > 0 ? Math.max(1.5, Math.min(width, dark / n * 1.15)) : width;
  return { own, fig, area, width, penWidth, ruleAngle: mask.ruleAngle };
}

/// Find the head. Fill in everything the ink encloses; the head is then the thickest round
/// part of the filled figure in its upper half — whether it was drawn as an empty loop, a
/// loop with a face inside, or filled in with a marker. If the loop wasn't quite closed,
/// small gaps are bridged first. Returns { loop: closed polyline along the middle of the
/// head's line, classify(x, y) → 'ring' | 'inner' (a face drawn inside) | 'outer' } or null.
function findHead(own, w, h, width, box) {
  const figH = box.maxY - box.minY + 1, yMax = box.minY + figH * 0.6;
  const inBox = (f) => { for (let y = Math.max(0, box.minY); y < Math.min(h, yMax); y++) for (let x = Math.max(0, box.minX); x <= Math.min(w - 1, box.maxX); x++) f(x, y, y * w + x); };
  const N = 64;
  const march = (field, cx, cy, lim) => {                  // how far `field` reaches from the centre, per direction
    const rad = new Float64Array(N);
    for (let k = 0; k < N; k++) {
      const a = k / N * Math.PI * 2, dx = Math.cos(a), dy = Math.sin(a);
      let t = 0;
      for (; t < lim; t += 0.5) {
        const x = Math.round(cx + dx * t), y = Math.round(cy + dy * t);
        if (x < 0 || y < 0 || x >= w || y >= h || !field[y * w + x]) break;
      }
      rad[k] = t;
    }
    return rad;
  };

  // 1. A drawn loop: the empty inside of the head (with any face filled in). Measuring
  //    from the inside means arms raised close beside the head don't make it bigger.
  const fromInside = (m, grow) => {
    const filled = fillHoles(m, w, h), interior = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) interior[i] = filled[i] && !m[i] ? 1 : 0;
    const inside = fillHoles(interior, w, h);               // eyes and mouth filled in
    const dt = distance(inside, w, h);
    let best = 0, bi = -1;
    inBox((x, y, i) => { const v = dt[i] * (1.25 - (y - box.minY) / figH); if (v > best) { best = v; bi = i; } });
    if (bi < 0) return null;
    const r = dt[bi];
    if (r < Math.max(2, width * 0.4) || r > figH * 0.3) return null;
    const cx = bi % w, cy = Math.floor(bi / w);
    const rad = march(inside, cx, cy, r * 3);
    return { cx, cy, r, mid: Array.from(rad, (v) => v + grow + width / 2) };
  };
  // 2. A head filled in solid (a marker): the thickest part of the figure near the top.
  //    (Holes filled first: a thick pen leaves a head's inside mostly ink anyway.)
  const solid = () => {
    const filled = fillHoles(own, w, h), dt = distance(filled, w, h);
    let best = 0, bi = -1;
    inBox((x, y, i) => { const v = dt[i] * (1.25 - (y - box.minY) / figH); if (v > best) { best = v; bi = i; } });
    if (bi < 0) return null;
    best = dt[bi];
    if (best < width * 0.95 + 1.5 || best > figH * 0.3) return null;
    const cx = bi % w, cy = Math.floor(bi / w);
    const rad = march(filled, cx, cy, best * 3.2);
    return { cx, cy, r: best, mid: Array.from(rad, (v) => Math.max(1, v - width / 2)) };
  };
  const gap = Math.max(2, Math.round(Math.min(NORM_H * 0.045, width * 2)));
  const found = fromInside(own, 0) || fromInside(dilate(own, w, h, gap), gap) || solid();
  if (!found) return null;
  const { cx, cy } = found;

  // A neck or a limb leaving the head makes a spike in the radius; the median round the
  // circle ignores those.
  const med = (arr, k, span) => { const v = []; for (let d = -span; d <= span; d++) v.push(arr[(k + d + N) % N]); v.sort((p, q) => p - q); return v[span]; };
  // Settle each direction onto the actual middle of the drawn line near that radius.
  const raw = found.mid.map((R, k) => {
    const a = k / N * Math.PI * 2, dx = Math.cos(a), dy = Math.sin(a);
    let sum = 0, n = 0, started = false;
    for (let t = Math.max(0.5, R - width * 1.5); t <= R + width * 1.5; t += 0.25) {
      const x = Math.floor(cx + 0.5 + dx * t), y = Math.floor(cy + 0.5 + dy * t);
      const ink = x >= 0 && y >= 0 && x < w && y < h && own[y * w + x];
      if (ink) { sum += t; n += 1; started = true; } else if (started && Math.abs(t - R) > width * 0.5) break;
    }
    return n ? sum / n : R;
  });
  const ro = raw.map((_, k) => Math.min(raw[k], med(raw, k, 6) * 1.15)).map((_, k, arr) => med(arr, k, 2));
  const mean = ro.reduce((p, q) => p + q, 0) / N;
  if (ro.some((v) => v < mean * 0.45 || v > mean * 2.2)) return null;  // not round round its middle
  const loop = [];
  for (let k = 0; k <= N; k++) {
    const a = (k % N) / N * Math.PI * 2;
    loop.push({ x: cx + 0.5 + Math.cos(a) * ro[k % N], y: cy + 0.5 + Math.sin(a) * ro[k % N] });
  }
  return headShape({ loop, cx: cx + 0.5, cy: cy + 0.5, at: [cx, cy], ro, width });
}

/// A head's outline, from its measurements — { loop (the outline, closed), cx, cy (its
/// middle), at (the pixel its middle is in), ro (its radius in each of ro.length directions
/// round the circle), width (the pen's) } — with classify(x, y) added: is that point on the
/// head's line ('ring'), inside it ('inner': a face), or 'outer'? (The measurements are
/// plain data, so a traced head can cross from a worker and be made whole again here.)
export function headShape(d) {
  const [cx, cy] = d.at, ro = d.ro, N = ro.length, width = d.width;
  const radiusAt = (a) => { const f = ((a / (Math.PI * 2)) * N + N) % N, k0 = Math.floor(f), t = f - k0; return ro[k0] * (1 - t) + ro[(k0 + 1) % N] * t; };
  return {
    loop: d.loop, cx: d.cx, cy: d.cy, at: d.at, ro, width,
    classify(x, y) {
      // Against the middle of the head's line.
      const dist = Math.hypot(x - cx - 0.5, y - cy - 0.5), R = radiusAt(Math.atan2(y - cy - 0.5, x - cx - 0.5));
      if (Math.abs(dist - R) <= width * 0.9 + 1) return 'ring';
      return dist < R ? 'inner' : 'outer';
    },
  };
}

/// A trace (from traceFigure) as plain data, to post from a worker; and back again.
export function plainTrace(t) {
  const h = t.headShape;
  return { ...t, headShape: h && { loop: h.loop, cx: h.cx, cy: h.cy, at: h.at, ro: h.ro, width: h.width } };
}
export function reviveTrace(t) {
  return { ...t, headShape: t.headShape && headShape(t.headShape) };
}

/// The mask with every enclosed hole filled in.
function fillHoles(m, w, h) {
  const out = new Uint8Array(w * h).fill(1), stack = [];
  const push = (i) => { if (!m[i] && out[i]) { out[i] = 0; stack.push(i); } };
  for (let x = 0; x < w; x++) { push(x); push((h - 1) * w + x); }
  for (let y = 0; y < h; y++) { push(y * w); push(y * w + w - 1); }
  while (stack.length) {
    const i = stack.pop(), x = i % w, y = (i - x) / w;
    if (x > 0) push(i - 1); if (x < w - 1) push(i + 1); if (y > 0) push(i - w); if (y < h - 1) push(i + w);
  }
  return out;
}

/// Distance (px, chamfer 3-4) from each set pixel to the nearest unset one.
function distance(m, w, h) {
  const d = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) d[i] = m[i] ? 1e9 : 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x; if (!d[i]) continue;
    let v = d[i];
    if (x > 0) v = Math.min(v, d[i - 1] + 3); else v = Math.min(v, 3);
    if (y > 0) { v = Math.min(v, d[i - w] + 3); if (x > 0) v = Math.min(v, d[i - w - 1] + 4); if (x < w - 1) v = Math.min(v, d[i - w + 1] + 4); } else v = Math.min(v, 3);
    d[i] = v;
  }
  for (let y = h - 1; y >= 0; y--) for (let x = w - 1; x >= 0; x--) {
    const i = y * w + x; if (!d[i]) continue;
    let v = d[i];
    if (x < w - 1) v = Math.min(v, d[i + 1] + 3); else v = Math.min(v, 3);
    if (y < h - 1) { v = Math.min(v, d[i + w] + 3); if (x < w - 1) v = Math.min(v, d[i + w + 1] + 4); if (x > 0) v = Math.min(v, d[i + w - 1] + 4); } else v = Math.min(v, 3);
    d[i] = v;
  }
  for (let i = 0; i < w * h; i++) d[i] /= 3;
  return d;
}

/// Grow a mask by r pixels (square).
function dilate(m, w, h, r) {
  const a = new Uint8Array(w * h), b = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) { let run = -1e9; for (let x = 0; x < w; x++) { if (m[y * w + x]) run = x; a[y * w + x] = x - run <= r ? 1 : 0; } run = 1e9; for (let x = w - 1; x >= 0; x--) { if (m[y * w + x]) run = x; if (run - x <= r) a[y * w + x] = 1; } }
  for (let x = 0; x < w; x++) { let run = -1e9; for (let y = 0; y < h; y++) { if (a[y * w + x]) run = y; b[y * w + x] = y - run <= r ? 1 : 0; } run = 1e9; for (let y = h - 1; y >= 0; y--) { if (a[y * w + x]) run = y; if (run - y <= r) b[y * w + x] = 1; } }
  return b;
}

/// Where a crop for `traceFigure` should be taken from, given a candidate's box in some
/// frame: the box plus a margin, and the scale that makes the figure NORM_H tall.
export function cropFor(box, margin = 0.22) {
  const bh = box.maxY - box.minY + 1, bw = box.maxX - box.minX + 1, m = bh * margin;
  const scale = NORM_H / bh;
  const x = box.minX - m, y = box.minY - m, cw = bw + 2 * m, ch = bh + 2 * m;
  return { x, y, w: cw, h: ch, scale, outW: Math.round(cw * scale), outH: Math.round(ch * scale) };
}
