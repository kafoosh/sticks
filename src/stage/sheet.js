// Where the paper is. The figure tears its piece out of the page it is drawn on, and paces
// about on it — so both have to stay on the sheet, not wander onto the table. This finds
// the sheet round the figure in the frame the show starts from: the area of the same,
// smoothly-varying brightness as the paper under the figure, stopping at the step where a
// card or page ends (and at the edge of what the screen shows). DOM-free.

import { apply } from '../vision/homography.js';

/// gray: the analysis frame (fw×fh). stage: { w, h }. stageToRef: stage → frame pixels.
/// fig: the figure's box on the stage { minX, minY, maxX, maxY, width, height }.
/// inView(x, y): is that frame pixel on screen? Returns { covers(rect) → 0…1, cell } where
/// rect is { x, y, w, h } on the stage, or null if the paper can't be made out.
export function paperAround(gray, fw, fh, stage, stageToRef, fig, inView = () => true) {
  const cell = Math.max(4, fig.height / 14), cw = Math.ceil(stage.w / cell), ch = Math.ceil(stage.h / cell);
  // Each cell's brightness, taken from its lighter samples so pen lines and rules don't count.
  const val = new Float32Array(cw * ch).fill(-1), s = [];
  for (let cy = 0; cy < ch; cy++) for (let cx = 0; cx < cw; cx++) {
    s.length = 0;
    for (let j = 0; j < 3; j++) for (let i = 0; i < 3; i++) {
      const p = apply(stageToRef, (cx + (i + 0.5) / 3) * cell, (cy + (j + 0.5) / 3) * cell), x = Math.round(p.x), y = Math.round(p.y);
      if (x < 1 || y < 1 || x >= fw - 1 || y >= fh - 1 || !inView(x, y)) continue;
      s.push(gray[y * fw + x]);
    }
    if (s.length < 7) continue;
    s.sort((a, b) => b - a);
    val[cy * cw + cx] = s[2];
  }
  // The paper's own brightness: the cells under and beside the figure.
  const at = (x, y) => Math.min(ch - 1, Math.max(0, Math.floor(y / cell))) * cw + Math.min(cw - 1, Math.max(0, Math.floor(x / cell)));
  const near = [];
  for (let y = fig.minY; y <= fig.maxY; y += cell) for (let x = fig.minX - cell; x <= fig.maxX + cell; x += cell) { const v = val[at(x, y)]; if (v > 0) near.push(v); }
  if (near.length < 4) return null;
  near.sort((a, b) => a - b);
  const paper = near[Math.floor(near.length * 0.6)];
  const ok = (i) => val[i] > 0 && val[i] > paper * 0.55 && val[i] < paper * 1.45;
  const step = Math.max(8, paper * 0.07);
  // Grow outward from the figure while the brightness carries on smoothly.
  const mask = new Uint8Array(cw * ch), stack = [];
  for (let y = fig.minY; y <= fig.maxY; y += cell) for (let x = fig.minX; x <= fig.maxX; x += cell) { const i = at(x, y); if (ok(i) && Math.abs(val[i] - paper) < paper * 0.2 && !mask[i]) { mask[i] = 1; stack.push(i); } }
  while (stack.length) {
    const i = stack.pop(), x = i % cw, y = (i - x) / cw;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const X = x + dx, Y = y + dy;
      if (X < 0 || Y < 0 || X >= cw || Y >= ch) continue;
      const j = Y * cw + X;
      if (mask[j] || !ok(j) || Math.abs(val[j] - val[i]) > step) continue;
      mask[j] = 1; stack.push(j);
    }
  }
  // The figure is drawn on the sheet: where its own ink made a cell look dark, it is paper
  // all the same. Likewise any small hole (another doodle, a printed mark).
  for (let y = fig.minY; y <= fig.maxY; y += cell / 2) for (let x = fig.minX; x <= fig.maxX; x += cell / 2) { const i = at(x, y); if (val[i] > 0) mask[i] = 1; }
  for (let pass = 0; pass < 2; pass++) for (let y = 1; y < ch - 1; y++) for (let x = 1; x < cw - 1; x++) {
    const i = y * cw + x;
    if (!mask[i] && val[i] > 0 && mask[i - 1] + mask[i + 1] + mask[i - cw] + mask[i + cw] >= 3) mask[i] = 1;
  }
  // Keep a cell's width clear of the sheet's edge.
  const inner = new Uint8Array(cw * ch);
  for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
    const i = y * cw + x;
    inner[i] = mask[i] && x > 0 && y > 0 && x < cw - 1 && y < ch - 1 && mask[i - 1] && mask[i + 1] && mask[i - cw] && mask[i + cw] ? 1 : 0;
  }
  let total = 0;
  for (let i = 0; i < cw * ch; i++) total += inner[i];
  if (total < 6) return null;
  return {
    cell, cw, ch, mask: inner,
    /// How much of a stage rectangle lies on the sheet (0…1).
    covers(r) {
      let on = 0, n = 0;
      for (let cy = Math.floor(r.y / cell); cy <= Math.floor((r.y + r.h) / cell); cy++) for (let cx = Math.floor(r.x / cell); cx <= Math.floor((r.x + r.w) / cell); cx++) {
        n += 1;
        if (cx >= 0 && cy >= 0 && cx < cw && cy < ch && inner[cy * cw + cx]) on += 1;
      }
      return n ? on / n : 0;
    },
  };
}
