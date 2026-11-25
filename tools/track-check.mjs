// How far off is the tracking? Runs the tracker and ink lock over a video from
// make-test-video.mjs and compares against the camera path that video was filmed with.
//   node tools/track-check.mjs camera.mjpeg [lock|nolock]
// Errors are in pixels of the 640-wide analysis frame: at the figure, beside it (where the
// paper is torn), and far out on the page.
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { inkMask, findCandidates, cropFor, resample, traceFigure } from '../src/vision/ink.js';
import { PlaneTracker } from '../src/vision/tracker.js';
import { InkLock } from '../src/vision/inklock.js';
import { apply, multiply, invert, fromQuad } from '../src/vision/homography.js';
const jsfeat = new Function(readFileSync(new URL('../vendor/jsfeat.min.js', import.meta.url), 'utf8') + '; return jsfeat;')();
const W = 640, H = 360, file = process.argv[2], useLock = process.argv[3] !== 'nolock', start = Number(process.argv[4] || 0);
import { cameraView } from './camera-path.mjs';
const gt = (n) => multiply([1,0,-0.5,0,1,-0.5,0,0,1], cameraView(n, W, H));
const ff = spawn('ffmpeg', ['-loglevel', 'error', '-i', file, '-vf', `scale=${W}:${H},format=gray`, '-f', 'rawvideo', '-']);
let buf = Buffer.alloc(0), n = 0, tracker, lock, H0inv, probes, stats = [];
const frame = (g) => {
  if (n < start) { n++; return; }
  if (!tracker) {
    const mask = inkMask(g, W, H, 14), box = findCandidates(mask, W, H)[0], c = cropFor(box);
    const t = traceFigure(resample(g, W, H, c.x, c.y, c.w, c.h, c.outW, c.outH), c.outW, c.outH);
    const lines = t.strokes.map((s) => s.map((p) => ({ x: c.x + p.x / c.scale - 0.5, y: c.y + p.y / c.scale - 0.5 })));
    tracker = new PlaneTracker(jsfeat, W, H); tracker.reset(g, box);
    lock = new InkLock(lines);
    H0inv = invert(gt(n));
    const bh = box.maxY - box.minY, mx = (box.minX + box.maxX) / 2, my = (box.minY + box.maxY) / 2;
    probes = { fig: [[box.minX, box.minY], [box.maxX, box.minY], [box.minX, box.maxY], [box.maxX, box.maxY]], side: [[mx - bh * 1.0, my - bh * 0.2], [mx + bh * 1.0, my - bh * 0.2]], far: [[mx - bh * 1.7, my + bh * 0.6], [mx + bh * 1.7, my - bh * 0.8]] };
    console.log('start', n, 'spots', tracker.count, 'lockpts', lock.pts.length);
  } else {
    const ok = tracker.update(g);
    const M = useLock ? lock.refine(g, W, H, tracker.H) : tracker.H;
    const G = multiply(gt(n), H0inv);
    const e = {};
    for (const k in probes) e[k] = Math.max(...probes[k].map(([x, y]) => { const a = apply(M, x, y), b = apply(G, x, y); return Math.hypot(a.x - b.x, a.y - b.y); }));
    stats.push({ n, ok, pts: tracker.count, held: lock.held, ...e });
  }
  n++;
};
ff.stdout.on('data', (d) => { buf = Buffer.concat([buf, d]); while (buf.length >= W * H) { frame(new Uint8Array(buf.subarray(0, W * H))); buf = buf.subarray(W * H); } });
ff.on('close', () => {
  const col = (k) => stats.map((s) => s[k]);
  const sum = (k) => { const v = col(k).slice().sort((a, b) => a - b); return `${k}: mean ${(v.reduce((a, b) => a + b, 0) / v.length).toFixed(2)} p95 ${v[Math.floor(v.length * 0.95)].toFixed(2)} max ${v[v.length - 1].toFixed(2)}`; };
  console.log(sum('fig'), '|', sum('side'), '|', sum('far'));
  console.log('lost frames', stats.filter((s) => !s.ok).length, 'min pts', Math.min(...col('pts')), 'min held', Math.min(...col('held')).toFixed(2));
  console.log(stats.filter((_, i) => i % 75 === 0).map((s) => `${s.n}: fig ${s.fig.toFixed(1)} side ${s.side.toFixed(1)} far ${s.far.toFixed(1)} pts ${s.pts} held ${s.held.toFixed(2)}`).join('\n'));
});
