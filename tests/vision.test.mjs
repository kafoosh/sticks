import test from 'node:test';
import assert from 'node:assert/strict';
import { traceFigure, inkMask, findCandidates, uprightTilt, cropFor, resample, NORM_H } from '../src/vision/ink.js';
import { fit } from '../src/rig/fitter.js';
import { stabilizeSeams } from '../src/rig/seams.js';
import { rigIsConfident, makePose, worldPoint } from '../src/rig/model.js';
import { apply, multiply, invert, fromQuad } from '../src/vision/homography.js';
import { InkLock } from '../src/vision/inklock.js';
import { Show } from '../src/anim/show.js';
import { rasterise, normalise } from './raster.mjs';

const line = (a, b, n = 12) => Array.from({ length: n + 1 }, (_, i) => ({ x: a[0] + (b[0] - a[0]) * i / n, y: a[1] + (b[1] - a[1]) * i / n }));
function stickman(lean = 0) {
  const head = Array.from({ length: 33 }, (_, i) => { const a = i / 32 * Math.PI * 2; return { x: 100 + 22 * Math.cos(a), y: 40 + 24 * Math.sin(a) }; });
  return [head, line([100, 64], [100 + lean, 150]), [...line([55, 120], [100, 88]), ...line([100, 88], [146, 116])],
    line([100 + lean, 150], [72, 230]), line([100 + lean, 150], [130, 232])].map((points) => ({ points }));
}
function traced(pen, lean = 0) {
  const N = normalise(stickman(lean), NORM_H, 60);
  const img = rasterise(N.strokes, N.w, N.h, { pen });
  return { N, img, t: traceFigure(img, N.w, N.h) };
}

test('a drawn stickman is found in a frame', () => {
  const N = normalise(stickman(), 120, 100);
  const img = rasterise(N.strokes, N.w, N.h, { pen: 3 });
  const c = findCandidates(inkMask(img, N.w, N.h, 12), N.w, N.h);
  assert.equal(c.length, 1);
  assert.ok(Math.abs((c[0].maxY - c[0].minY) - 120) < 8);
});

for (const pen of [3, 5, 8]) {
  test(`pixels → strokes → an articulated rig (pen ${pen})`, () => {
    const { t } = traced(pen, 4);
    assert.ok(t, 'traced');
    assert.ok(Math.abs(t.width - pen) < 2.5, `pen width ${t.width}`);
    const rig = stabilizeSeams(fit(t.strokes.map((points) => ({ points, width: t.width, color: '#000' }))));
    assert.ok(rigIsConfident(rig), 'reads as a figure');
    assert.ok(rig.strokes.some((s) => s.parts.includes('leftForearm')) && rig.strokes.some((s) => s.parts.includes('rightForearm')), 'both arms bend');
  });
}

test('homography helpers agree with each other', () => {
  const H = fromQuad([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }], [{ x: 3, y: 4 }, { x: 14, y: 5 }, { x: 13, y: 17 }, { x: 2, y: 15 }]);
  const p = apply(H, 10, 10);
  assert.ok(Math.abs(p.x - 13) < 1e-9 && Math.abs(p.y - 17) < 1e-9);
  const q = apply(multiply(invert(H), H), 3.3, 7.7);
  assert.ok(Math.abs(q.x - 3.3) < 1e-9 && Math.abs(q.y - 7.7) < 1e-9);
});

test('the ink lock pulls a wrong map back onto the lines', () => {
  const { N, img, t } = traced(4);
  const lock = new InkLock(t.strokes);
  const wrong = [1.004, 0.004, 1.5, -0.004, 0.996, -1.5, 0, 0, 1];     // the "tracker" is a few pixels out
  const M = lock.refine(img, N.w, N.h, wrong);
  assert.ok(lock.held > 0.8);
  for (const [x, y] of [[t.box.minX, t.box.minY], [t.box.maxX, t.box.maxY], [(t.box.minX + t.box.maxX) / 2, (t.box.minY + t.box.maxY) / 2]]) {
    const p = apply(M, x, y);
    assert.ok(Math.hypot(p.x - x, p.y - y) < 1.2, `(${x},${y}) → (${p.x.toFixed(2)},${p.y.toFixed(2)})`);
  }
});

test('the routine: poses stay finite, hands reach the paper, and it ends as drawn', () => {
  const { t } = traced(4);
  const stage = { w: 1000, h: 600 };
  const strokes = t.strokes.map((pts) => ({ points: pts.map((p) => ({ x: p.x + 330, y: p.y + 180 })), width: t.width, color: '#000' }));
  const rig = stabilizeSeams(fit(strokes));
  for (const side of [1, -1]) {
    const show = new Show(rig, stage, { card: { value: 7, suit: 'hearts' }, side });
    assert.ok(show.slot.x - show.pw / 2 > 0 && show.slot.x + show.pw / 2 < stage.w);
    for (let time = 0; time < show.duration + 1; time += 1 / 30) {
      const pose = show.pose(time);
      for (const s of rig.strokes) for (let i = 0; i < s.points.length; i += 5) {
        const w = worldPoint(rig, s.points[i], s.parts[i], pose);
        assert.ok(Number.isFinite(w.x) && Number.isFinite(w.y) && w.x > -200 && w.x < stage.w + 200 && w.y > -200 && w.y < stage.h + 200, `t=${time.toFixed(2)}`);
      }
    }
    // Mid-tear, the near hand is on the piece.
    const tm = (show.T.tear[0] + show.T.tear[1]) / 2, hand = show.hand(show.pose(tm), side < 0), pc = show.piece(tm);
    assert.ok(Math.abs(hand.x - pc.x) < show.pw * 0.6 && Math.abs(hand.y - pc.y) < show.ph * 0.6, 'hand on the paper');
    assert.deepEqual(show.pose(show.duration + 0.1), makePose());
  }
});

test('a figure drawn close to the edge of the paper is still read on its own', () => {
  // Like a small card on a stone table: the head nearly touches the card's top edge, and
  // the table beyond is much darker than the paper.
  const N = normalise(stickman(), 90, 80);
  const img = rasterise(N.strokes, N.w, N.h, { pen: 2.5 });
  const edgeY = 80 - 6;                                    // just above the head
  for (let y = 0; y < edgeY; y++) for (let x = 0; x < N.w; x++) img[y * N.w + x] = 95 + ((x * 7 + y * 13) % 23);
  for (let y = edgeY; y < N.h; y++) for (let x = 0; x < 12; x++) img[y * N.w + x] = 100;   // and the left edge
  const cands = findCandidates(inkMask(img, N.w, N.h, 12, 0.13, 9, 5), N.w, N.h, { gray: img, reach: 7 });
  assert.equal(cands.length, 1, 'just the figure');
  const box = cands[0];
  assert.ok(box.minY >= edgeY, `the figure's box (top ${box.minY}) stays below the paper edge (${edgeY})`);
  assert.ok(box.minX > 12, 'and clear of the left edge');
});

test('a card at a slant: its edges are left out, and the figure is turned upright', () => {
  // A card turned 30° on a darker table, the figure drawn on it turned with it.
  const W = 420, H = 420, a = 30 * Math.PI / 180, cx = 210, cy = 210;
  const rot = (p) => ({ x: cx + (p.x - cx) * Math.cos(a) - (p.y - cy) * Math.sin(a), y: cy + (p.x - cx) * Math.sin(a) + (p.y - cy) * Math.cos(a) });
  const N = normalise(stickman(), 110, 0);
  const fig = N.strokes.map((s) => ({ points: s.points.map((p) => rot({ x: p.x + cx - N.w / 2, y: p.y + cy - 55 })) }));
  const img = rasterise(fig, W, H, { pen: 2.5, shade: 0 });
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const u = (x - cx) * Math.cos(-a) - (y - cy) * Math.sin(-a), v = (x - cx) * Math.sin(-a) + (y - cy) * Math.cos(-a);
    const off = Math.max(Math.abs(u) - 150, Math.abs(v) - 95);          // outside the card
    if (off > 0) img[y * W + x] = 120 + ((x * 7 + y * 13) % 17);
    else if (off > -1.5) img[y * W + x] = 70;                           // the card's thin edge shadow
  }
  const cands = findCandidates(inkMask(img, W, H, 12, 0.13, 9, 5), W, H, { gray: img, reach: 7 });
  assert.equal(cands.length, 1, 'just the figure, not the card edges');
  const b = cands[0];
  const k = cropFor(b);
  const t = traceFigure(resample(img, W, H, k.x, k.y, k.w, k.h, k.outW, k.outH), k.outW, k.outH);
  assert.ok(t, 'traced');
  const tilt = uprightTilt(t.strokes) * 180 / Math.PI;
  assert.ok(Math.abs(tilt - 30) < 8, `tilt ${tilt.toFixed(1)}° ≈ 30°`);
  assert.ok(b.maxX - b.minX < 140 && b.maxY - b.minY < 140, 'box hugs the figure');
});

test('recognition on made-up camera frames (a quick slice of tools/bench)', async () => {
  const { makeScene } = await import('../tools/bench/scenes.mjs');
  const { shrink, grabber } = await import('../tools/bench/frame.mjs');
  const { detectFigure } = await import('../src/vision/detect.js');
  let found = 0, falses = 0;
  const N = 24, NEG = 8;
  for (let seed = 1; seed <= N + NEG; seed++) {
    const figure = seed <= N;
    const sc = makeScene(seed, figure ? {} : { figure: false, clutter: 1 + (seed % 4) });
    const P = shrink(sc.gray, sc.W, sc.H);
    const hit = detectFigure(P.g, P.w, P.h, grabber(sc.gray, sc.W, sc.H, P.s));
    if (!hit || !hit.confident) continue;
    if (!figure) { falses += 1; continue; }
    const t = sc.truth, b = hit.box;
    const cx = (b.minX + b.maxX) / 2 / P.s, cy = (b.minY + b.maxY) / 2 / P.s;
    if (cx > t.minX && cx < t.maxX && cy > t.minY && cy < t.maxY) found += 1;
  }
  assert.ok(found >= N * 0.5, `found ${found} of ${N}`);
  assert.equal(falses, 0, 'nothing taken for a figure in frames without one');
});
