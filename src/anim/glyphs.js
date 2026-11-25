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
function drawSuit(ctx, suit, cx, cy, size, color, lw) {
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
  ctx.lineJoin = 'round';
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  if (suit === 'spades' || suit === 'clubs') ctx.fill();
  ctx.stroke();
  ctx.restore();
}

/// Write `card` ({ value 1…13, suit }) centred on (cx, cy), `size` tall.
export function drawCard(ctx, card, cx, cy, size, color, lw) {
  const g = VALUES[valueLabel(card.value)];
  const suitSize = size * 0.92, gap = size * 0.2;
  const total = g.w * size + gap + suitSize * 0.8;
  const x0 = cx - total / 2, y0 = cy - size / 2;
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = lw;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const s of g.strokes) {
    ctx.beginPath();
    s.forEach(([x, y], i) => { if (i) ctx.lineTo(x0 + x * size, y0 + y * size); else ctx.moveTo(x0 + x * size, y0 + y * size); });
    ctx.stroke();
  }
  ctx.restore();
  drawSuit(ctx, card.suit, x0 + g.w * size + gap + suitSize * 0.4, cy + size * 0.02, suitSize, color, lw);
}
