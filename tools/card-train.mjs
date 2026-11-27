// The small networks that tell a card's value, and its suit, from a mark's shape (see
// make-card-glyphs.cjs, which trains them, and src/vision/card.js, which runs them). Input: a
// small picture of the mark (gw×gh), zero-mean, unit length, times SCALE. Output: a share
// for each answer, the last being "none of these". One hidden layer; weights stored as
// bytes, each matrix with its own scale.
export const SCALE = 6;

export function prepare(v) {
  let m = 0;
  for (const x of v) m += x;
  m /= v.length;
  const o = Float32Array.from(v, (x) => x - m);
  let n = 0;
  for (const x of o) n += x * x;
  n = Math.sqrt(n) || 1;
  for (let i = 0; i < o.length; i++) o[i] = o[i] / n * SCALE;
  return o;
}

/// samples: [{ u: prepare(shape), k: which answer (0 … out − 1) }]; shapes are gw×gh.
export function train(samples, { gw, gh, out: OUT, hidden = 48, epochs = 22, lr = 0.02, seed = 1 }) {
  const IN = gw * gh;
  let s = seed >>> 0 || 1;
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296), gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-9)) * Math.cos(6.283 * rnd());
  const W1 = new Float32Array(hidden * IN), b1 = new Float32Array(hidden), W2 = new Float32Array(OUT * hidden), b2 = new Float32Array(OUT);
  for (let i = 0; i < W1.length; i++) W1[i] = gauss() * Math.sqrt(2 / IN);
  for (let i = 0; i < W2.length; i++) W2[i] = gauss() * Math.sqrt(2 / hidden);
  const h = new Float32Array(hidden), o = new Float32Array(OUT), dh = new Float32Array(hidden), x = new Float32Array(IN);
  for (let ep = 0; ep < epochs; ep++) {
    const rate = lr * (1 - ep / epochs * 0.9);
    for (let it = 0; it < samples.length; it++) {
      const smp = samples[Math.floor(rnd() * samples.length)];
      // (seen a cell to one side now and then, with a little noise, so it doesn't lean on exact placement)
      const sx = rnd() < 0.3 ? (rnd() < 0.5 ? -1 : 1) : 0, sy = rnd() < 0.3 ? (rnd() < 0.5 ? -1 : 1) : 0;
      for (let yy = 0; yy < gh; yy++) for (let xx = 0; xx < gw; xx++) { const u = xx + sx, v = yy + sy; x[yy * gw + xx] = (u >= 0 && v >= 0 && u < gw && v < gh ? smp.u[v * gw + u] : 0) + gauss() * 0.01; }
      for (let j = 0; j < hidden; j++) { let a = b1[j]; const off = j * IN; for (let i = 0; i < IN; i++) a += W1[off + i] * x[i]; h[j] = a > 0 ? a : 0; }
      let mx = -1e9;
      for (let k = 0; k < OUT; k++) { let a = b2[k]; const off = k * hidden; for (let j = 0; j < hidden; j++) a += W2[off + j] * h[j]; o[k] = a; if (a > mx) mx = a; }
      let sum = 0;
      for (let k = 0; k < OUT; k++) { o[k] = Math.exp(o[k] - mx); sum += o[k]; }
      dh.fill(0);
      for (let k = 0; k < OUT; k++) { const g = o[k] / sum - (k === smp.k ? 0.95 : 0.05 / (OUT - 1)), off = k * hidden; for (let j = 0; j < hidden; j++) { dh[j] += g * W2[off + j]; W2[off + j] -= rate * g * h[j]; } b2[k] -= rate * g; }
      for (let j = 0; j < hidden; j++) { if (h[j] <= 0) continue; const g = dh[j], off = j * IN; for (let i = 0; i < IN; i++) W1[off + i] -= rate * g * x[i]; b1[j] -= rate * g; }
    }
  }
  const q = (a) => { let m = 0; for (const v of a) m = Math.max(m, Math.abs(v)); const scale = m / 127; return { scale, q: Int8Array.from(a, (v) => Math.round(v / scale)) }; };
  return { hidden, in: IN, out: OUT, W1: q(W1), b1: q(b1), W2: q(W2), b2: q(b2) };
}

/// What one network makes of a shape: shares adding to 1.
export function run(net, u) {
  const { hidden, in: IN, out: OUT } = net, h = new Float32Array(hidden), z = new Float32Array(OUT);
  for (let j = 0; j < hidden; j++) { let a = 0; const off = j * IN; for (let i = 0; i < IN; i++) a += net.W1.q[off + i] * u[i]; a = a * net.W1.scale + net.b1.q[j] * net.b1.scale; h[j] = a > 0 ? a : 0; }
  let mx = -1e9;
  for (let k = 0; k < OUT; k++) { let a = 0; const off = k * hidden; for (let j = 0; j < hidden; j++) a += net.W2.q[off + j] * h[j]; z[k] = a * net.W2.scale + net.b2.q[k] * net.b2.scale; if (z[k] > mx) mx = z[k]; }
  let sum = 0;
  for (let k = 0; k < OUT; k++) { z[k] = Math.exp(z[k] - mx); sum += z[k]; }
  for (let k = 0; k < OUT; k++) z[k] /= sum;
  return z;
}

/// Several networks' shared opinion: { k (which answer), conf }.
export function vote(nets, u) {
  const OUT = nets[0].out, p = new Float32Array(OUT);
  for (const n of nets) { const z = run(n, u); for (let k = 0; k < OUT; k++) p[k] += z[k] / nets.length; }
  let b = 0;
  for (let k = 1; k < OUT; k++) if (p[k] > p[b]) b = k;
  return { k: b, conf: p[b] };
}
