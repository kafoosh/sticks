// The copy that comes to life is made of the drawing's own ink.
//
// Redrawn from its traced centre lines alone, a figure comes out tidier than it was drawn:
// every line the same width, and whatever wasn't part of a clean line — the blob where the
// pen started, a stub of neck between head and body, a hook where two strokes meet — gone.
// So the lines are only the puppet's bones. What is SHOWN is the ink itself: how dark the
// page was at each pixel of the drawing (frame.js `inkAlpha`), cut into one picture per body
// part, each pixel going with the part whose traced line runs nearest it. Standing as drawn,
// the parts fit back together into exactly the drawing.

/// Which body part each pixel of the ink goes with — and, where two parts meet, which other
/// parts' lines pass within a pen's half-width of it: those take the pixel too, so each part
/// ends in a rounded cap that reaches into the joint, and no notch opens when the joint bends. `alpha`: the ink (w×h, 0 = none), whose
/// pixel (u, v) covers the stage's square at (ox + u, oy + v); `rig.strokes` are in stage
/// units. Returns { parts: [part names], label: Uint8Array (0 = no ink, k = parts[k − 1]),
/// also: Uint16Array (bit k − 1 set: parts[k − 1] takes this pixel as well) }.
export function partOfInk(rig, alpha, w, h, ox, oy) {
  const parts = [], index = new Map();
  const id = (name) => { if (!index.has(name)) { parts.push(name); index.set(name, parts.length); } return index.get(name); };
  const label = new Uint8Array(w * h), near = new Float32Array(w * h).fill(Infinity), also = new Uint16Array(w * h);
  const pen = rig.strokes.length ? rig.strokes[0].width : 8, cap = (pen * 0.6 + 1) * (pen * 0.6 + 1);
  // Walk every traced line a pixel at a time, claiming the ink within reach for its part
  // wherever this line is the nearest so far.
  const R = 14, marks = [];
  for (const st of rig.strokes) {
    for (let i = 0; i < st.points.length; i++) {
      const a = st.points[i], b = st.points[Math.min(i + 1, st.points.length - 1)], pa = id(st.parts[i]), pb = id(st.parts[Math.min(i + 1, st.parts.length - 1)]);
      const len = Math.hypot(b.x - a.x, b.y - a.y), n = Math.max(1, Math.ceil(len));
      for (let k = 0; k < n; k++) {
        const t = k / n, x = a.x + (b.x - a.x) * t - ox, y = a.y + (b.y - a.y) * t - oy, part = t < 0.5 ? pa : pb;
        marks.push(x, y, part);
        const x0 = Math.max(0, Math.floor(x - R)), x1 = Math.min(w - 1, Math.ceil(x + R)), y0 = Math.max(0, Math.floor(y - R)), y1 = Math.min(h - 1, Math.ceil(y + R));
        for (let v = y0; v <= y1; v++) for (let u = x0; u <= x1; u++) {
          const j = v * w + u;
          if (!alpha[j]) continue;
          const d = (u + 0.5 - x) * (u + 0.5 - x) + (v + 0.5 - y) * (v + 0.5 - y);
          if (d < near[j]) { near[j] = d; label[j] = part; }
          if (d <= cap) also[j] |= 1 << (part - 1);
        }
      }
    }
  }
  // Ink further than that from any line (a big blob, a filled-in head) goes with the nearest all the same.
  for (let j = 0; j < label.length; j++) {
    if (!alpha[j] || label[j]) continue;
    const u = (j % w) + 0.5, v = Math.floor(j / w) + 0.5;
    let best = Infinity;
    for (let m = 0; m < marks.length; m += 3) { const d = (u - marks[m]) * (u - marks[m]) + (v - marks[m + 1]) * (v - marks[m + 1]); if (d < best) { best = d; label[j] = marks[m + 2]; } }
  }
  return { parts, label, also };
}

/// The ink as one picture per body part: [{ part, canvas, x, y (the stage point of the
/// picture's top-left corner) }]. `color`: the pen's colour ("rgb(…)" or "rgba(…)").
export function inkSprites(rig, alpha, w, h, ox, oy, color, makeCanvas) {
  const { parts, label, also } = partOfInk(rig, alpha, w, h, ox, oy);
  const [r, g, b] = (color.match(/[\d.]+/g) || [28, 27, 25]).map(Number);
  const out = [];
  parts.forEach((part, k) => {
    let minX = w, minY = h, maxX = -1, maxY = -1;
    const mine = (j) => label[j] === k + 1 || (also[j] >> k) & 1;
    for (let v = 0; v < h; v++) for (let u = 0; u < w; u++) if (mine(v * w + u)) { if (u < minX) minX = u; if (u > maxX) maxX = u; if (v < minY) minY = v; if (v > maxY) maxY = v; }
    if (maxX < 0) return;
    const cw = maxX - minX + 1, ch = maxY - minY + 1, canvas = makeCanvas(cw, ch), ctx = canvas.getContext('2d'), img = ctx.createImageData(cw, ch);
    for (let v = 0; v < ch; v++) for (let u = 0; u < cw; u++) {
      const j = (minY + v) * w + minX + u, o = (v * cw + u) * 4;
      if (!mine(j)) continue;
      img.data[o] = r; img.data[o + 1] = g; img.data[o + 2] = b; img.data[o + 3] = alpha[j];
    }
    ctx.putImageData(img, 0, 0);
    out.push({ part, canvas, x: ox + minX, y: oy + minY });
  });
  return out;
}
