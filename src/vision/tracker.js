// Following the page as the camera moves.
//
// At the moment the figure wakes up we remember where a few hundred distinctive spots were
// (corners of the drawing, paper edges, table grain). Every frame each spot is followed to
// its new position (pyramidal Lucas–Kanade, from the vendored jsfeat), and the single flat-
// surface map that best explains where they all went is the camera's motion. Spots that
// disagree (something not on the table, a spot that slipped) are dropped, and fresh ones
// are picked up to replace them.
//
// `H` maps REFERENCE-frame pixels to CURRENT-frame pixels.

import { IDENTITY, apply, invert, sane } from './homography.js';

const MAX = 420;
const LEVELS = 3;

export class PlaneTracker {
  constructor(jsfeat, w, h) {
    this.jf = jsfeat; this.w = w; this.h = h;
    const mk = () => { const p = new jsfeat.pyramid_t(LEVELS); p.allocate(w, h, jsfeat.U8_t | jsfeat.C1_t); return p; };
    this.prev = mk(); this.cur = mk();
    this.prevXY = new Float32Array(MAX * 2);
    this.curXY = new Float32Array(MAX * 2);
    this.refXY = new Float32Array(MAX * 2);
    this.status = new Uint8Array(MAX);
    this.count = 0;
    this.H = IDENTITY.slice();
    this.inliers = 0;
    this.frame = 0;
    this.focus = null;
    this.kernelH = new jsfeat.motion_model.homography2d();
    this.kernelA = new jsfeat.motion_model.affine2d();
    this.model = new jsfeat.matrix_t(3, 3, jsfeat.F32_t | jsfeat.C1_t);
    this.mask = new jsfeat.matrix_t(MAX, 1, jsfeat.U8_t | jsfeat.C1_t);
    this.from = []; this.to = [];
    for (let i = 0; i < MAX; i++) { this.from.push({ x: 0, y: 0 }); this.to.push({ x: 0, y: 0 }); }
  }

  /// Make `gray` the reference frame. `focus` {minX,minY,maxX,maxY} is where the drawing
  /// is; spots are picked more densely there, since that's where the map has to be right.
  reset(gray, focus) {
    this.cur.data[0].data.set(gray);
    this.cur.build(this.cur.data[0], true);
    this.count = 0; this.frame = 0; this.focus = focus;
    this.H = IDENTITY.slice();
    this.addSpots(gray, IDENTITY);
    this.swap();
    this.inliers = this.count;
  }

  swap() {
    const p = this.prev; this.prev = this.cur; this.cur = p;
    const xy = this.prevXY; this.prevXY = this.curXY; this.curXY = xy;
  }

  /// Follow into the next frame. Returns true while the page is still being tracked.
  update(gray) {
    const jf = this.jf;
    this.frame += 1;
    this.cur.data[0].data.set(gray);
    this.cur.build(this.cur.data[0], true);
    let ok = false;
    if (this.count >= 4) {
      // (A 17-pixel window: as accurate here as a bigger one, at two thirds of the work.)
      jf.optical_flow_lk.track(this.prev, this.cur, this.prevXY, this.curXY, this.count, 17, 30, this.status, 0.01, 0.0005);
      // Keep what was followed and is still in view.
      let n = 0;
      for (let i = 0; i < this.count; i++) {
        const x = this.curXY[i * 2], y = this.curXY[i * 2 + 1];
        if (!this.status[i] || x < 4 || y < 4 || x > this.w - 5 || y > this.h - 5) continue;
        this.curXY[n * 2] = x; this.curXY[n * 2 + 1] = y;
        this.refXY[n * 2] = this.refXY[i * 2]; this.refXY[n * 2 + 1] = this.refXY[i * 2 + 1];
        n += 1;
      }
      this.count = n;
      ok = this.solve();
    }
    // Top up now and then — sooner when few are held (though not every frame: a plain page
    // may simply have no more to offer).
    if (this.count < MAX * 0.6 && this.frame % (this.count < 60 ? 2 : 6) === 0 && ok) this.addSpots(gray, this.H);
    this.swap();
    return ok;
  }

  solve() {
    const jf = this.jf, n = this.count;
    if (n < 6) { this.inliers = 0; return false; }
    for (let i = 0; i < n; i++) {
      this.from[i].x = this.refXY[i * 2]; this.from[i].y = this.refXY[i * 2 + 1];
      this.to[i].x = this.curXY[i * 2]; this.to[i].y = this.curXY[i * 2 + 1];
    }
    // A full perspective fit is only believed when plenty of spots, spread well across the
    // picture, agree on it; otherwise it chases noise, and the steadier affine fit is used.
    let H = null;
    if (n >= 40) H = this.fitModel(this.kernelH, 4, n, true);
    if (!H) H = this.fitModel(this.kernelA, 3, n, false);
    if (!H) { this.inliers = 0; return false; }
    // Drop the spots that disagreed.
    let m = 0;
    for (let i = 0; i < n; i++) {
      if (!this.mask.data[i]) continue;
      this.curXY[m * 2] = this.curXY[i * 2]; this.curXY[m * 2 + 1] = this.curXY[i * 2 + 1];
      this.refXY[m * 2] = this.refXY[i * 2]; this.refXY[m * 2 + 1] = this.refXY[i * 2 + 1];
      m += 1;
    }
    this.count = m; this.inliers = m;
    this.H = H;
    return true;
  }

  fitModel(kernel, size, n, needSpread) {
    const jf = this.jf;
    const params = new jf.ransac_params_t(size, 2.0, 0.5, 0.995);
    if (!jf.motion_estimator.ransac(params, kernel, this.from, this.to, n, this.model, this.mask, 600)) return null;
    const H = Array.from(this.model.data).slice(0, 9).map((v) => v / this.model.data[8]);
    let keep = 0, sx = 0, sy = 0, sxx = 0, syy = 0;
    for (let i = 0; i < n; i++) {
      if (!this.mask.data[i]) continue;
      const x = this.to[i].x, y = this.to[i].y;
      keep += 1; sx += x; sy += y; sxx += x * x; syy += y * y;
    }
    if (keep < 6 || !sane(H, this.w, this.h)) return null;
    if (needSpread) {
      const sdx = Math.sqrt(Math.max(0, sxx / keep - (sx / keep) ** 2)), sdy = Math.sqrt(Math.max(0, syy / keep - (sy / keep) ** 2));
      if (keep < 36 || keep < n * 0.5 || sdx < this.w * 0.17 || sdy < this.h * 0.17) return null;
    }
    return H;
  }

  /// Pick up new distinctive spots in the current frame, away from the ones already held.
  addSpots(gray, H) {
    const inv = invert(H);
    if (!inv) return;
    const { w, h } = this, hw = w >> 1, hh = h >> 1;
    // Corner strength (smaller eigenvalue of the gradient covariance) at half resolution.
    const half = this.half || (this.half = new Float32Array(hw * hh));
    for (let y = 0; y < hh; y++) for (let x = 0; x < hw; x++) {
      const i = (y * 2) * w + x * 2;
      half[y * hw + x] = (gray[i] + gray[i + 1] + gray[i + w] + gray[i + w + 1]) * 0.25;
    }
    const xx = this.gxx || (this.gxx = new Float32Array(hw * hh));
    const yy = this.gyy || (this.gyy = new Float32Array(hw * hh));
    const xy = this.gxy || (this.gxy = new Float32Array(hw * hh));
    for (let y = 1; y < hh - 1; y++) for (let x = 1; x < hw - 1; x++) {
      const i = y * hw + x;
      const gx = half[i + 1] - half[i - 1], gy = half[i + hw] - half[i - hw];
      xx[i] = gx * gx; yy[i] = gy * gy; xy[i] = gx * gy;
    }
    // … summed over a 7×7 window round each pixel (running sums: the same work whatever the
    // window's size).
    const R = 3;
    const sum = this.sums || (this.sums = [0, 1, 2, 3].map(() => new Float32Array(hw * hh)));
    boxSum(xx, sum[3], sum[0], hw, hh, R); boxSum(xy, sum[3], sum[1], hw, hh, R); boxSum(yy, sum[3], sum[2], hw, hh, R);
    const sa = sum[0], sb = sum[1], sc = sum[2];
    const strength = (x, y) => {
      const i = y * hw + x, a = sa[i], b = sb[i], c = sc[i];
      return (a + c - Math.sqrt((a - c) * (a - c) + 4 * b * b)) / 2;
    };
    // One spot per grid cell, finer cells over the drawing. Cells that already hold a spot
    // are skipped.
    const focus = this.focus && { ...this.focus };
    if (focus) {                                       // the drawing, as seen in THIS frame
      const c = [apply(H, focus.minX, focus.minY), apply(H, focus.maxX, focus.minY), apply(H, focus.maxX, focus.maxY), apply(H, focus.minX, focus.maxY)];
      focus.minX = Math.min(...c.map((p) => p.x)) / 2 - 6; focus.maxX = Math.max(...c.map((p) => p.x)) / 2 + 6;
      focus.minY = Math.min(...c.map((p) => p.y)) / 2 - 6; focus.maxY = Math.max(...c.map((p) => p.y)) / 2 + 6;
    }
    const CELL = 5, cw = Math.ceil(hw / CELL), ch = Math.ceil(hh / CELL);
    const taken = new Uint8Array(cw * ch);
    for (let i = 0; i < this.count; i++) {
      const cx = Math.floor(this.curXY[i * 2] / 2 / CELL), cy = Math.floor(this.curXY[i * 2 + 1] / 2 / CELL);
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const X = cx + dx, Y = cy + dy;
        if (X >= 0 && Y >= 0 && X < cw && Y < ch) taken[Y * cw + X] = 1;
      }
    }
    // What counts as distinctive is judged against the best the picture has to offer, so
    // sensor grain on blank paper never qualifies.
    let top = 0;
    for (let y = R + 5; y < hh - R - 5; y += 3) for (let x = R + 5; x < hw - R - 5; x += 3) { const v = strength(x, y); if (v > top) top = v; }
    const floor = Math.max(150, top * 0.02);
    const found = [];
    const scan = (x0, y0, x1, y1, step, least) => {
      for (let by = y0; by < y1; by += step) for (let bx = x0; bx < x1; bx += step) {
        let best = least, bxp = -1, byp = -1;
        for (let y = by; y < Math.min(by + step, y1); y += 1) for (let x = bx; x < Math.min(bx + step, x1); x += 1) {
          if (x < R + 5 || y < R + 5 || x >= hw - R - 5 || y >= hh - R - 5) continue;
          if (taken[Math.floor(y / CELL) * cw + Math.floor(x / CELL)]) continue;
          const s = strength(x, y);
          if (s > best) { best = s; bxp = x; byp = y; }
        }
        if (bxp >= 0) {
          found.push({ x: bxp * 2 + 1, y: byp * 2 + 1, s: best });
          taken[Math.floor(byp / CELL) * cw + Math.floor(bxp / CELL)] = 1;
        }
      }
    };
    if (focus) scan(Math.max(0, Math.floor(focus.minX)), Math.max(0, Math.floor(focus.minY)), Math.min(hw, Math.ceil(focus.maxX)), Math.min(hh, Math.ceil(focus.maxY)), 8, floor * 0.5);
    scan(0, 0, hw, hh, 16, floor);
    found.sort((a, b) => b.s - a.s);
    for (const f of found) {
      if (this.count >= MAX) break;
      const r = apply(inv, f.x, f.y);
      const i = this.count;
      this.curXY[i * 2] = f.x; this.curXY[i * 2 + 1] = f.y;
      this.refXY[i * 2] = r.x; this.refXY[i * 2 + 1] = r.y;
      this.count += 1;
    }
  }
}

/// dst = src summed over the (2R+1)² window round each pixel (`tmp` is scratch). Pixels
/// within R of the border are left alone.
function boxSum(src, tmp, dst, w, h, R) {
  const n = 2 * R + 1;
  for (let y = 0; y < h; y++) {
    const o = y * w;
    let s = 0;
    for (let x = 0; x < n; x++) s += src[o + x];
    tmp[o + R] = s;
    for (let x = R + 1; x < w - R; x++) { s += src[o + x + R] - src[o + x - R - 1]; tmp[o + x] = s; }
  }
  const col = new Float64Array(w);
  for (let y = 0; y < n; y++) for (let x = R; x < w - R; x++) col[x] += tmp[y * w + x];
  for (let x = R; x < w - R; x++) dst[R * w + x] = col[x];
  for (let y = R + 1; y < h - R; y++) {
    const add = (y + R) * w, sub = (y - R - 1) * w, o = y * w;
    for (let x = R; x < w - R; x++) { col[x] += tmp[add + x] - tmp[sub + x]; dst[o + x] = col[x]; }
  }
}
