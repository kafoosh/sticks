// Test helper: paint pen strokes into a grey image the way a camera might see them.
export function rasterise(strokes, w, h, { pen = 5, paper = 205, ink = 45, noise = 6, shade = 30, seed = 1 } = {}) {
  let s = seed >>> 0;
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  const cover = new Float32Array(w * h);
  const r = pen / 2;
  const dab = (cx, cy) => {
    for (let y = Math.max(0, Math.floor(cy - r - 1)); y <= Math.min(h - 1, Math.ceil(cy + r + 1)); y++) {
      for (let x = Math.max(0, Math.floor(cx - r - 1)); x <= Math.min(w - 1, Math.ceil(cx + r + 1)); x++) {
        const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
        const a = Math.min(1, Math.max(0, r + 0.5 - d));
        if (a > cover[y * w + x]) cover[y * w + x] = a;
      }
    }
  };
  for (const st of strokes) {
    const p = st.points || st;
    if (p.length === 1) dab(p[0].x, p[0].y);
    for (let i = 1; i < p.length; i++) {
      const n = Math.max(1, Math.ceil(Math.hypot(p[i].x - p[i - 1].x, p[i].y - p[i - 1].y) / 0.5));
      for (let k = 0; k <= n; k++) dab(p[i - 1].x + (p[i].x - p[i - 1].x) * k / n, p[i - 1].y + (p[i].y - p[i - 1].y) * k / n);
    }
  }
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const light = paper - shade * (x / w) - shade * 0.5 * (y / h);      // uneven lighting
    const v = light + (ink - light) * cover[y * w + x] + (rnd() - 0.5) * 2 * noise;
    out[y * w + x] = Math.max(0, Math.min(255, v));
  }
  return out;
}

/// Scale + shift strokes so their bounding box is `tall` high with `margin` around it.
export function normalise(strokes, tall, margin) {
  let minX = 1e9, minY = 1e9, maxX = -1e9, maxY = -1e9;
  for (const s of strokes) for (const p of s.points) { minX = Math.min(minX, p.x); minY = Math.min(minY, p.y); maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y); }
  const k = tall / (maxY - minY);
  const out = strokes.map((s) => ({ ...s, points: s.points.map((p) => ({ x: (p.x - minX) * k + margin, y: (p.y - minY) * k + margin })) }));
  return { strokes: out, w: Math.ceil((maxX - minX) * k + 2 * margin), h: Math.ceil(tall + 2 * margin), k };
}
