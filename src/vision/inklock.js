// Holding on to the drawing itself.
//
// Following surface texture frame to frame (tracker.js) slowly slips, and a blank sheet of
// paper has little texture to follow in the first place. But the one thing guaranteed to be
// in view is the drawing — and the camera always sees the real ink, even after the copy has
// walked away. So each frame, at points along the drawing's lines, we look a few pixels
// either side of where the line is predicted to be, find where it actually is, and nudge the
// whole map so the prediction lands on the ink. The nudge is carried to the next frame, so
// slip never builds up.

import { IDENTITY, apply, multiply, invert } from './homography.js';

const REACH = 6;          // how far either side of the prediction to look (frame px)

export class InkLock {
  /// lines: the drawing's strokes as polylines in REFERENCE-frame pixels.
  constructor(lines, maxPoints = 220) {
    const pts = [];
    for (const line of lines) {
      for (let i = 0; i < line.length; i++) {
        const a = line[Math.max(0, i - 1)], b = line[Math.min(line.length - 1, i + 1)];
        const tx = b.x - a.x, ty = b.y - a.y, m = Math.hypot(tx, ty);
        if (m < 1e-6) continue;
        pts.push({ x: line[i].x, y: line[i].y, nx: -ty / m, ny: tx / m });
      }
    }
    const step = Math.max(1, Math.ceil(pts.length / maxPoints));
    this.pts = pts.filter((_, i) => i % step === 0);
    this.C = IDENTITY.slice();      // correction on top of the tracker's map
    this.last = IDENTITY.slice();   // the last map that had the drawing firmly
    this.held = 0;                  // share of points that found their line last frame
  }

  /// tracker map H (reference → current) in, corrected map out. If the drawing has slipped
  /// out of reach (a jump: the phone stalled for a moment and the camera moved on; on ruled
  /// paper the tracker can then settle a rule out), look further afield first.
  refine(gray, w, h, H) {
    let best = this.solve(gray, w, h, multiply(this.C, H), REACH);
    if (best.held < 0.6) {
      for (const start of [multiply(this.C, H), H]) {
        const wide = this.solve(gray, w, h, start, REACH * 2.5);
        if (wide.held > best.held + 0.15) best = wide;
      }
    }
    if (best.held < 0.6) {
      // Still lost: slide the drawing's outline about to where its lines best land on ink,
      // then fit from there. (Ruled lines can't fake this: they only ever line up with a
      // few of the figure's points at once.) Tried from where the tracker says the drawing
      // is, and from where it last really was — the tracker itself may be what's wrong.
      for (const from of [multiply(this.C, H), this.last]) {
        const shift = this.relocate(gray, w, h, from, Math.max(w, h) * 0.14);
        if (!shift) continue;
        const again = this.solve(gray, w, h, multiply([1, 0, shift.x, 0, 1, shift.y, 0, 0, 1], from), REACH * 2.5);
        if (again.held > best.held + 0.15) best = again;
        if (best.held >= 0.6) break;
      }
    }
    const { M, held } = best;
    this.held = held;
    if (held >= 0.6) this.last = M;
    const inv = invert(H);
    if (inv && held >= 0.25) { this.C = multiply(M, inv); return M; }
    return multiply(this.C, H);
  }

  /// Start afresh from map M (reference → now): the drawing's lines are moved to where they
  /// are now, which becomes the new reference frame. For when the tracker is re-anchored.
  rebase(M) {
    this.pts = this.pts.map((p) => {
      const q = apply(M, p.x, p.y), q2 = apply(M, p.x + p.nx * 2, p.y + p.ny * 2);
      const m = Math.hypot(q2.x - q.x, q2.y - q.y) || 1;
      return { x: q.x, y: q.y, nx: (q2.x - q.x) / m, ny: (q2.y - q.y) / m };
    });
    this.C = IDENTITY.slice(); this.last = IDENTITY.slice();
  }

  /// The shift (within ±range px) that puts the most of the drawing's points on ink.
  relocate(gray, w, h, M, range) {
    const q = this.pts.map((p) => apply(M, p.x, p.y)).filter((p) => p.x > 0 && p.y > 0 && p.x < w - 1 && p.y < h - 1);
    if (q.length < 20) return null;
    // What counts as ink here: clearly darker than the picture round the drawing.
    const vals = q.map((p) => gray[Math.round(p.y) * w + Math.round(p.x)]).sort((a, b) => a - b);
    let sum = 0, n = 0;
    for (let i = 0; i < q.length; i += 2) for (const [dx, dy] of [[-12, 0], [12, 0], [0, -12], [0, 12]]) {
      const x = Math.round(q[i].x + dx), y = Math.round(q[i].y + dy);
      if (x >= 0 && y >= 0 && x < w && y < h) { sum += gray[y * w + x]; n += 1; }
    }
    const paper = n ? sum / n : 200, cut = paper * 0.8;
    const score = (dx, dy) => {
      let k = 0;
      for (const p of q) { const x = Math.round(p.x + dx), y = Math.round(p.y + dy); if (x >= 0 && y >= 0 && x < w && y < h && gray[y * w + x] < cut) k += 1; }
      return k;
    };
    let best = { x: 0, y: 0, k: score(0, 0) };
    for (const step of [4, 1]) {
      const cx = best.x, cy = best.y, r = step === 4 ? range : 4;
      for (let dy = -r; dy <= r; dy += step) for (let dx = -r; dx <= r; dx += step) {
        const k = score(cx + dx, cy + dy);
        if (k > best.k) best = { x: cx + dx, y: cy + dy, k };
      }
    }
    return best.k >= q.length * 0.5 ? best : null;
  }

  /// Fit the map to the drawing's lines, starting from M0, the first look reaching `reach`
  /// px either side (then the usual reach). { M, held }
  solve(gray, w, h, M0, reach) {
    let M = M0;
    let held = 0;
    for (let iter = 0; iter < 5; iter++) {
      const R = iter === 0 ? reach : REACH;
      const obs = [];
      let cx = 0, cy = 0;
      for (const p of this.pts) {
        const q = apply(M, p.x, p.y), q2 = apply(M, p.x + p.nx * 2, p.y + p.ny * 2);
        let nx = q2.x - q.x, ny = q2.y - q.y;
        const m = Math.hypot(nx, ny);
        if (!(m > 1e-6)) continue;
        nx /= m; ny /= m;
        const d = valley(gray, w, h, q.x, q.y, nx, ny, R);
        if (d === null) continue;
        obs.push({ x: q.x, y: q.y, nx, ny, d });
        cx += q.x; cy += q.y;
      }
      held = obs.length / Math.max(1, this.pts.length);
      if (obs.length < 14 || held < 0.25) break;
      cx /= obs.length; cy /= obs.length;
      // Least squares for a small move of the whole map, about the centre c of the finds:
      //   T(p) = (p + A·p′ + t) / (1 + g·p′),  p′ = p − c,   asking  n·(T(p) − p) = d.
      // Six numbers slide, turn, scale and shear; the two in g tilt (perspective). The shape
      // and tilt terms are damped, so thin evidence mostly slides, and tilt is taken up
      // gradually over a few frames rather than chased.
      const K = 8, N = new Float64Array(K * K), rhs = new Float64Array(K), row = new Float64Array(K);
      for (const o of obs) {
        const wgt = 1 / (1 + (o.d * o.d) / 9);          // far-off finds count for less
        const x = o.x - cx, y = o.y - cy, np = o.nx * x + o.ny * y;
        row[0] = o.nx * x; row[1] = o.nx * y; row[2] = o.nx;
        row[3] = o.ny * x; row[4] = o.ny * y; row[5] = o.ny;
        row[6] = -np * x; row[7] = -np * y;
        for (let i = 0; i < K; i++) { rhs[i] += wgt * row[i] * o.d; for (let j = 0; j < K; j++) N[i * K + j] += wgt * row[i] * row[j]; }
      }
      for (const i of [0, 1, 3, 4]) N[i * K + i] *= 1.02;
      for (const i of [6, 7]) N[i * K + i] = N[i * K + i] * 2 + 1e-9;
      const s = solve(N, rhs, K);
      if (!s) break;
      const Tc = [1 + s[0], s[1], s[2], s[3], 1 + s[4], s[5], s[6], s[7], 1];
      const T = multiply(multiply([1, 0, cx, 0, 1, cy, 0, 0, 1], Tc), [1, 0, -cx, 0, 1, -cy, 0, 0, 1]);
      M = multiply(T, M);
      if (Math.abs(s[2]) + Math.abs(s[5]) + (Math.abs(s[0]) + Math.abs(s[1]) + Math.abs(s[3]) + Math.abs(s[4])) * 60 < 0.05) break;
    }
    return { M, held };
  }
}

/// Along the line through (x, y) with direction (nx, ny): how far from (x, y) is the middle
/// of the dark line? null if there's no clear line within reach.
function valley(gray, w, h, x, y, nx, ny, reach = REACH) {
  const R = Math.round(reach), n = 2 * R * 2 + 1;
  let hi = 0, lo = 255;
  const v = valley.buf && valley.buf.length >= n ? valley.buf : (valley.buf = new Float32Array(Math.max(64, n)));
  for (let i = 0; i < n; i++) {
    const s = (i - 2 * R) * 0.5, px = x + nx * s, py = y + ny * s;
    if (px < 1 || py < 1 || px >= w - 2 || py >= h - 2) return null;
    const x0 = px | 0, y0 = py | 0, tx = px - x0, ty = py - y0, k = y0 * w + x0;
    const g = (gray[k] * (1 - tx) + gray[k + 1] * tx) * (1 - ty) + (gray[k + w] * (1 - tx) + gray[k + w + 1] * tx) * ty;
    v[i] = g;
    if (g > hi) hi = g; if (g < lo) lo = g;
  }
  if (hi - lo < 18) return null;
  // The darkest sample, then the centre of mass of the dip around it (so a second line
  // elsewhere in reach doesn't drag the answer).
  let best = 0;
  for (let i = 1; i < n; i++) if (v[i] < v[best]) best = i;
  const cut = lo + (hi - lo) * 0.5;
  let a = best, b = best;
  while (a > 0 && v[a - 1] < cut) a -= 1;
  while (b < n - 1 && v[b + 1] < cut) b += 1;
  if (a === 0 || b === n - 1) return null;           // the dip runs off the end: not sure
  let sw = 0, ss = 0;
  for (let i = a; i <= b; i++) { const wgt = cut - v[i]; sw += wgt; ss += wgt * (i - 2 * R) * 0.5; }
  return sw > 0 ? ss / sw : null;
}

/// Solve the n×n system N·s = rhs (Gaussian elimination with pivoting). null if singular.
function solve(N, rhs, n) {
  const A = Array.from({ length: n }, (_, i) => [...N.slice(i * n, i * n + n), rhs[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    if (Math.abs(A[p][c]) < 1e-12) return null;
    [A[c], A[p]] = [A[p], A[c]];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = A[r][c] / A[c][c];
      for (let k = c; k <= n; k++) A[r][k] -= f * A[c][k];
    }
  }
  return A.map((r, i) => r[n] / r[i]);
}
