// The test camera's motion, shared by the video maker and the tracking check so the check
// knows exactly where the page really is in every frame.
import { fromQuad } from '../src/vision/homography.js';

/// Scene pixels → picture pixels (w×h) for frame n at 30 fps. Still for a second and a half,
/// then drifting, turning, zooming and tilting like a hand-held phone.
export function cameraView(n, w, h) {
  const t = n / 30, m = Math.min(1, Math.max(0, (t - 1.5) / 1.5));
  const cx = 900 + m * (70 * Math.sin(t * 0.9) + 30 * Math.sin(t * 2.3)), cy = 540 + m * (40 * Math.sin(t * 0.7 + 1) + 20 * Math.sin(t * 1.9));
  const z = 1 + m * 0.10 * Math.sin(t * 0.5), a = m * 0.07 * Math.sin(t * 0.6 + 0.5), k = m * 0.06 * Math.sin(t * 0.8);
  const c = (sx, sy) => {
    const px = sx * 560 * z * (1 + sy * k), py = sy * 315 * z;       // tilt: top and bottom differ in width
    return { x: cx + px * Math.cos(a) - py * Math.sin(a), y: cy + px * Math.sin(a) + py * Math.cos(a) };
  };
  return fromQuad([c(-1, -1), c(1, -1), c(-1, 1), c(1, 1)], [{ x: 0, y: 0 }, { x: w, y: 0 }, { x: 0, y: h }, { x: w, y: h }]);
}
