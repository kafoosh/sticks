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
  const pass = (src, dst, horiz, useMax) => {
    const n = horiz ? w : h, m = horiz ? h : w;
    for (let j = 0; j < m; j++) {
      for (let i = 0; i < n; i++) {
        let v = useMax ? 0 : 255;
        const lo = Math.max(0, i - r), hi = Math.min(n - 1, i + r);
        for (let k = lo; k <= hi; k++) {
          const s = src[horiz ? j * w + k : k * w + j];
          if (useMax ? s > v : s < v) v = s;
        }
        dst[horiz ? j * w + i : i * w + j] = v;
      }
    }
  };
  pass(gray, a, true, true); pass(a, b, false, true);      // dilate (brightest)
  pass(b, a, true, false); pass(a, b, false, false);       // erode (darkest)
  return b;
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
      const m = gh * 0.10, up = gh * 0.25;
      let grew = false;
      for (const c of comps) {
        if (g.ids.includes(c.id) || used.has(c.id) || edge(c)) continue;
        if (c.area > s.area || c.area < 2) continue;
        // A thin straight sliver is a paper edge or a ruled line, not part of a figure.
        const cw = c.maxX - c.minX + 1, ch = c.maxY - c.minY + 1;
        if (Math.min(cw, ch) <= 4 && Math.max(cw, ch) >= 4 * Math.min(cw, ch)) continue;
        if (c.maxX < g.minX - m || c.minX > g.maxX + m || c.maxY < g.minY - up || c.minY > g.maxY + m) continue;
        // Never reach far above the main stroke (a separate head sits right on top of it);
        // beyond that it is texture past the edge of the page, not more of the figure.
        if (c.minY < s.minY - (s.maxY - s.minY + 1) * 0.4) continue;
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
  for (let y = 0; y < h; y += 1) for (let x = 0; x < w; x += 1) {
    const i = y * w + x, id = labels[i];
    if (!id) continue;
    if ((x + y) & 1) continue;                         // every other pixel is plenty
    const vals = [];
    for (const [dx, dy] of dirs) {
      for (const k of [reach, reach * 1.6]) {
        const X = Math.round(x + dx * k), Y = Math.round(y + dy * k);
        if (X < 0 || Y < 0 || X >= w || Y >= h) continue;
        const j = Y * w + X;
        if (!mask[j]) vals.push(gray[j]);
      }
    }
    total[id] += 1;
    if (vals.length < 6) continue;
    // Typical light side against typical dark side: a step has a lot of both; a pen line
    // has paper nearly all round (a stray dark pixel or two don't count).
    vals.sort((a, b) => a - b);
    around[id] += vals[vals.length >> 1]; aroundN[id] += 1;
    const lo = vals[Math.floor(vals.length * 0.25)], hi = vals[Math.floor(vals.length * 0.75)];
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
  const img = Uint8Array.from(mask);
  const kill = [];
  const at = (x, y) => (x < 0 || y < 0 || x >= w || y >= h ? 0 : img[y * w + x]);
  let changed = true;
  while (changed) {
    changed = false;
    for (let pass = 0; pass < 2; pass++) {
      kill.length = 0;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          if (!img[y * w + x]) continue;
          const p2 = at(x, y - 1), p3 = at(x + 1, y - 1), p4 = at(x + 1, y), p5 = at(x + 1, y + 1);
          const p6 = at(x, y + 1), p7 = at(x - 1, y + 1), p8 = at(x - 1, y), p9 = at(x - 1, y - 1);
          const n = p2 + p3 + p4 + p5 + p6 + p7 + p8 + p9;
          if (n < 2 || n > 6) continue;
          const a = (!p2 && p3) + (!p3 && p4) + (!p4 && p5) + (!p5 && p6)
            + (!p6 && p7) + (!p7 && p8) + (!p8 && p9) + (!p9 && p2);
          if (a !== 1) continue;
          if (pass === 0 ? (p2 && p4 && p6) || (p4 && p6 && p8) : (p2 && p4 && p8) || (p2 && p6 && p8)) continue;
          kill.push(y * w + x);
        }
      }
      for (const i of kill) img[i] = 0;
      if (kill.length) changed = true;
    }
  }
  // A corner pixel whose two straight neighbours already touch diagonally is redundant;
  // dropping it leaves every remaining pixel with a clean neighbour count.
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!img[y * w + x]) continue;
      const N = at(x, y - 1), E = at(x + 1, y), S = at(x, y + 1), W_ = at(x - 1, y);
      const NE = at(x + 1, y - 1), SE = at(x + 1, y + 1), SW = at(x - 1, y + 1), NW = at(x - 1, y - 1);
      if ((N && E && !SW && !S && !W_) || (E && S && !NW && !N && !W_)
        || (S && W_ && !NE && !N && !E) || (W_ && N && !SE && !S && !E)) img[y * w + x] = 0;
    }
  }
  return img;
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
  return strokes.map(smoothLine);
}

/// Take the pixel staircase out of a traced line and thin it to a point every few pixels.
function smoothLine(pts) {
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
  const r = Math.round(NORM_H * 0.09), lineR = Math.max(3, Math.round(r * 0.4));
  const mask = inkMask(gray, w, h, r, 0.13, 9, lineR);
  const cands = findCandidates(mask, w, h, { minH: 0.3, maxH: 0.99, gray, reach: lineR + 4 });
  if (!cands.length) return null;
  // The one nearest the middle of the crop is the one we were pointed at.
  const mid = (c) => Math.hypot((c.minX + c.maxX) / 2 - w / 2, (c.minY + c.maxY) / 2 - h / 2);
  cands.sort((a, b) => mid(a) - mid(b));
  const fig = cands[0], ids = new Set(fig.ids), labels = cands.labels;
  const own = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) if (ids.has(labels[i])) own[i] = 1;
  const skel = thin(own, w, h);
  let skelCount = 0;
  for (let i = 0; i < w * h; i++) skelCount += skel[i];
  if (skelCount < 20) return null;
  const width = Math.max(2, Math.min(fig.area / skelCount, 16));
  const strokes = traceStrokes(skel, w, h, { spur: Math.max(7, width * 2.2) });
  if (!strokes.length) return null;
  return { strokes, width, mask: own, box: { minX: fig.minX, minY: fig.minY, maxX: fig.maxX, maxY: fig.maxY } };
}

/// Where a crop for `traceFigure` should be taken from, given a candidate's box in some
/// frame: the box plus a margin, and the scale that makes the figure NORM_H tall.
export function cropFor(box, margin = 0.22) {
  const bh = box.maxY - box.minY + 1, bw = box.maxX - box.minX + 1, m = bh * margin;
  const scale = NORM_H / bh;
  const x = box.minX - m, y = box.minY - m, cw = bw + 2 * m, ch = bh + 2 * m;
  return { x, y, w: cw, h: ch, scale, outW: Math.round(cw * scale), outH: Math.round(ch * scale) };
}
