// 3×3 plane-to-plane maps, row-major in a plain array of 9.

export const IDENTITY = [1, 0, 0, 0, 1, 0, 0, 0, 1];

export function apply(H, x, y) {
  const w = H[6] * x + H[7] * y + H[8];
  return { x: (H[0] * x + H[1] * y + H[2]) / w, y: (H[3] * x + H[4] * y + H[5]) / w };
}

export function multiply(A, B) {
  const C = new Array(9);
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) {
    C[r * 3 + c] = A[r * 3] * B[c] + A[r * 3 + 1] * B[3 + c] + A[r * 3 + 2] * B[6 + c];
  }
  return C;
}

export function invert(H) {
  const [a, b, c, d, e, f, g, h, i] = H;
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-12) return null;
  return [A / det, (c * h - b * i) / det, (b * f - c * e) / det,
    B / det, (a * i - c * g) / det, (c * d - a * f) / det,
    C / det, (b * g - a * h) / det, (a * e - b * d) / det];
}

/// x' = x·s + tx, y' = y·s + ty
export function scaleTranslate(s, tx, ty) { return [s, 0, tx, 0, s, ty, 0, 0, 1]; }

/// Scale so the largest entry is 1 (the map is unchanged; float32 shaders like it better).
export function normalised(H) {
  let m = 0;
  for (const v of H) m = Math.max(m, Math.abs(v));
  return H.map((v) => v / (m || 1));
}

/// Is this a believable view of a flat page — not folded through itself or blown up?
export function sane(H, w, h) {
  const c = [apply(H, 0, 0), apply(H, w, 0), apply(H, w, h), apply(H, 0, h)];
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const p = c[i], q = c[(i + 1) % 4], r = c[(i + 2) % 4];
    if (![p.x, p.y].every(Number.isFinite)) return false;
    const z = (q.x - p.x) * (r.y - q.y) - (q.y - p.y) * (r.x - q.x);
    if (z === 0) return false;
    if (sign === 0) sign = Math.sign(z); else if (Math.sign(z) !== sign) return false;
  }
  for (const [x, y] of [[0, 0], [w, 0], [w, h], [0, h], [w / 2, h / 2]]) {
    if (H[6] * x + H[7] * y + H[8] <= 0) return false;
  }
  const area = Math.abs((c[2].x - c[0].x) * (c[3].y - c[1].y) - (c[3].x - c[1].x) * (c[2].y - c[0].y)) / 2;
  return area > w * h * 0.02 && area < w * h * 60;
}

/// The map taking four points to four points: src, dst = [{x,y} ×4].
export function fromQuad(src, dst) {
  const A = [];
  for (let i = 0; i < 4; i++) {
    const { x, y } = src[i], { x: u, y: v } = dst[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y, u]);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y, v]);
  }
  for (let c = 0; c < 8; c++) {
    let p = c;
    for (let r = c + 1; r < 8; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    if (Math.abs(A[p][c]) < 1e-12) return null;
    [A[c], A[p]] = [A[p], A[c]];
    for (let r = 0; r < 8; r++) {
      if (r === c) continue;
      const f = A[r][c] / A[c][c];
      for (let k = c; k <= 8; k++) A[r][k] -= f * A[c][k];
    }
  }
  return [...A.map((r, i) => r[8] / r[i]), 1];
}
