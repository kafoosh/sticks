// The card, as the figure would write it: a value and a suit in a few pen strokes.

const D = Math.PI / 180;
function arc(cx, cy, rx, ry, a0, a1, n = 18) {
  const out = [];
  for (let i = 0; i <= n; i++) { const a = (a0 + (a1 - a0) * i / n) * D; out.push([cx + rx * Math.cos(a), cy + ry * Math.sin(a)]); }
  return out;
}

// Each value: { w (width, with the height as 1), strokes: [[[x, y], …], …] }, y down.
const VALUES = {
  A: { w: 0.6, strokes: [[[0.02, 1], [0.3, 0], [0.58, 1]], [[0.13, 0.62], [0.47, 0.62]]] },
  2: { w: 0.6, strokes: [[...arc(0.3, 0.27, 0.26, 0.27, 190, 400), [0.03, 1], [0.6, 1]]] },
  3: { w: 0.56, strokes: [[...arc(0.28, 0.25, 0.25, 0.25, 200, 450), ...arc(0.28, 0.74, 0.28, 0.26, 270, 520)]] },
  4: { w: 0.62, strokes: [[[0.45, 1], [0.45, 0], [0.02, 0.68], [0.62, 0.68]]] },
  5: { w: 0.6, strokes: [[[0.55, 0], [0.12, 0], [0.087, 0.45], ...arc(0.28, 0.68, 0.3, 0.3, 230, 500)]] },
  6: { w: 0.56, strokes: [[[0.48, 0.02], [0.2, 0.3], [0.06, 0.72], ...arc(0.3, 0.72, 0.24, 0.27, 180, -180, 24)]] },
  7: { w: 0.6, strokes: [[[0.03, 0], [0.58, 0], [0.22, 1]]] },
  8: { w: 0.58, strokes: [[...arc(0.29, 0.25, 0.22, 0.24, 90, 450, 24), ...arc(0.29, 0.75, 0.27, 0.26, 270, -90, 24)]] },
  9: { w: 0.56, strokes: [[...arc(0.3, 0.28, 0.24, 0.27, 0, -360, 24), [0.5, 0.7], [0.3, 1]]] },
  10: { w: 0.78, strokes: [[[0, 0.2], [0.14, 0], [0.14, 1]], arc(0.54, 0.5, 0.22, 0.5, -90, 270, 28)] },
  J: { w: 0.6, strokes: [[[0.15, 0], [0.6, 0]], [[0.42, 0], [0.42, 0.75], ...arc(0.22, 0.75, 0.2, 0.24, 0, 180, 12)]] },
  Q: { w: 0.64, strokes: [arc(0.3, 0.48, 0.28, 0.48, -90, 270, 28), [[0.36, 0.72], [0.62, 1.02]]] },
  K: { w: 0.6, strokes: [[[0.05, 0], [0.05, 1]], [[0.55, 0], [0.05, 0.58]], [[0.22, 0.44], [0.58, 1]]] },
};

export const SUITS = ['clubs', 'hearts', 'spades', 'diamonds'];   // CHaSeD
export function valueLabel(v) { return v === 1 ? 'A' : v === 11 ? 'J' : v === 12 ? 'Q' : v === 13 ? 'K' : String(v); }

function heartPath(ctx, flip) {
  const s = flip ? -0.86 : 1, o = flip ? -0.07 : 0;
  ctx.moveTo(0, 0.42 * s + o);
  ctx.bezierCurveTo(-0.56, 0.05 * s + o, -0.5, -0.42 * s + o, -0.22, -0.42 * s + o);
  ctx.bezierCurveTo(-0.08, -0.42 * s + o, 0, -0.3 * s + o, 0, -0.2 * s + o);
  ctx.bezierCurveTo(0, -0.3 * s + o, 0.08, -0.42 * s + o, 0.22, -0.42 * s + o);
  ctx.bezierCurveTo(0.5, -0.42 * s + o, 0.56, 0.05 * s + o, 0, 0.42 * s + o);
  ctx.closePath();
}
function stemPath(ctx, top) { ctx.moveTo(0, top); ctx.lineTo(0.15, 0.46); ctx.lineTo(-0.15, 0.46); ctx.closePath(); }

/// One suit, `size` tall, centred on (cx, cy). Spades and clubs are inked in solid; hearts
/// and diamonds are left as outlines — how a one-colour pen tells black from red.
/// `done` (0…1) is how much of it has been drawn so far.
function drawSuit(ctx, suit, cx, cy, size, color, lw, done = 1) {
  if (done <= 0) return;
  ctx.save();
  ctx.translate(cx, cy);
  ctx.scale(size, size);
  ctx.beginPath();
  if (suit === 'hearts') heartPath(ctx, false);
  else if (suit === 'diamonds') { ctx.moveTo(0, -0.48); ctx.lineTo(0.35, 0); ctx.lineTo(0, 0.48); ctx.lineTo(-0.35, 0); ctx.closePath(); }
  else if (suit === 'spades') { heartPath(ctx, true); stemPath(ctx, 0.05); }
  else {
    for (const [x, y] of [[0, -0.25], [-0.23, 0.07], [0.23, 0.07]]) { ctx.moveTo(x + 0.21, y); ctx.arc(x, y, 0.21, 0, Math.PI * 2); }
    stemPath(ctx, -0.02);
  }
  ctx.lineWidth = lw / size;
  ctx.lineJoin = 'round'; ctx.lineCap = 'round';
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  const outline = Math.min(1, done / 0.7);
  if (outline < 1) ctx.setLineDash([outline * 7, 100]);     // every sub-path is well under 7 long
  if ((suit === 'spades' || suit === 'clubs') && done > 0.7) { ctx.globalAlpha *= (done - 0.7) / 0.3; ctx.fill(); ctx.globalAlpha /= (done - 0.7) / 0.3; }
  ctx.stroke();
  ctx.restore();
}

/// Write `card` ({ value 1…13, suit }) centred on (cx, cy), `size` tall. `done` (0…1) is
/// how far the writing has got: the value first, stroke by stroke, then the suit.
export function drawCard(ctx, card, cx, cy, size, color, lw, done = 1) {
  const g = VALUES[valueLabel(card.value)];
  const suitSize = size * 0.92, gap = size * 0.2;
  const total = g.w * size + gap + suitSize * 0.8;
  const x0 = cx - total / 2, y0 = cy - size / 2;
  const lengths = g.strokes.map((s) => s.reduce((a, p, i) => a + (i ? Math.hypot(p[0] - s[i - 1][0], p[1] - s[i - 1][1]) : 0), 0));
  let budget = Math.min(1, done / 0.55) * lengths.reduce((a, b) => a + b, 0);
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = lw;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  g.strokes.forEach((s, k) => {
    if (budget <= 0) return;
    let left = Math.min(budget, lengths[k]);
    budget -= lengths[k];
    ctx.beginPath();
    ctx.moveTo(x0 + s[0][0] * size, y0 + s[0][1] * size);
    for (let i = 1; i < s.length && left > 0; i++) {
      const d = Math.hypot(s[i][0] - s[i - 1][0], s[i][1] - s[i - 1][1]), f = d > 0 ? Math.min(1, left / d) : 1;
      ctx.lineTo(x0 + (s[i - 1][0] + (s[i][0] - s[i - 1][0]) * f) * size, y0 + (s[i - 1][1] + (s[i][1] - s[i - 1][1]) * f) * size);
      left -= d;
    }
    ctx.stroke();
  });
  ctx.restore();
  drawSuit(ctx, card.suit, x0 + g.w * size + gap + suitSize * 0.4, cy + size * 0.02, suitSize, color, lw, (done - 0.55) / 0.45);
}
