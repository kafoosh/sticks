// How far off is the tracking? Runs the tracker and ink lock over a video from
// make-test-video.mjs and compares against the camera path that video was filmed with.
//   node tools/track-check.mjs camera.mjpeg [lock|nolock] [start-frame] [--portrait] [--step N]
// (--step N looks at every Nth frame only, like a phone too slow to keep up.)
// (--portrait for a video filmed from a photo, which make-test-video turns upright.)
// Errors are in pixels of the 640-wide analysis frame: along the drawing's own lines, at the
// corners of its box, beside it (where the paper is torn), and far out on the page.
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { traceFigure } from '../src/vision/ink.js';
import { detectFigure } from '../src/vision/detect.js';
import { shrink, grabber } from './bench/frame.mjs';
import { PlaneTracker } from '../src/vision/tracker.js';
import { InkLock } from '../src/vision/inklock.js';
import { apply, multiply, invert, fromQuad } from '../src/vision/homography.js';
const jsfeat = new Function('module', readFileSync(new URL('../vendor/jsfeat.min.js', import.meta.url), 'utf8') + '; return jsfeat;')({ exports: {} });
const portrait = process.argv.includes('--portrait');
const STEP = process.argv.includes('--step') ? Number(process.argv[process.argv.indexOf('--step') + 1]) : 1;
const W = portrait ? 360 : 640, H = portrait ? 640 : 360, file = process.argv[2], useLock = process.argv[3] !== 'nolock', start = Number(process.argv[4] || 0) || 0;
import { cameraView } from './camera-path.mjs';
// The camera path is in landscape; a portrait video is each landscape frame turned a
// quarter clockwise: (x, y) → (H − y, x).
const upright = portrait ? [0, -1, W, 1, 0, 0, 0, 0, 1] : [1, 0, 0, 0, 1, 0, 0, 0, 1];
const gt = (n) => multiply([1,0,-0.5,0,1,-0.5,0,0,1], multiply(upright, cameraView(n, portrait ? H : W, portrait ? W : H)));
// Frames are read at full size (as the camera gives them) and shrunk to the analysis size.
const FW = W * 2, FH = H * 2;
const ff = spawn('ffmpeg', ['-loglevel', 'error', '-i', file, '-vf', `scale=${FW}:${FH},format=gray`, '-f', 'rawvideo', '-']);
let buf = Buffer.alloc(0), n = 0, tracker, lock, H0inv, probes, stats = [];
const frame = (full) => {
  if (n < start || (n - start) % STEP) { n++; return; }
  const P = shrink(full, FW, FH), g = P.g;
  if (!tracker) {
    // Find the figure the way the page does (close-ups from this same frame).
    const grab = grabber(full, FW, FH, P.s);
    const hit = detectFigure(g, W, H, grab);
    if (!hit || !hit.confident) { console.log('no figure found'); process.exit(1); }
    const box = hit.box, c = hit.crop, t = traceFigure(grab(c).g, c.outW, c.outH);
    const lines = t.strokes.map((s) => s.map((p) => { const q = apply(c.toProc, p.x, p.y); return { x: q.x - 0.5, y: q.y - 0.5 }; }));
    tracker = new PlaneTracker(jsfeat, W, H); tracker.reset(g, box);
    lock = new InkLock(lines);
    H0inv = invert(gt(n));
    const bh = box.maxY - box.minY, mx = (box.minX + box.maxX) / 2, my = (box.minY + box.maxY) / 2;
    // (ink: along the drawing's own lines — what decides whether the cover laid over the real
    // ink still hides all of it; the page covers about 3.5 px beyond each line, at least.)
    probes = { ink: lines.flatMap((l) => l.filter((_, i) => i % 4 === 0).map((p) => [p.x, p.y])), fig: [[box.minX, box.minY], [box.maxX, box.minY], [box.minX, box.maxY], [box.maxX, box.maxY]], side: [[mx - bh * 1.0, my - bh * 0.2], [mx + bh * 1.0, my - bh * 0.2]], far: [[mx - bh * 1.7, my + bh * 0.6], [mx + bh * 1.7, my - bh * 0.8]] };
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
ff.stdout.on('data', (d) => { buf = Buffer.concat([buf, d]); while (buf.length >= FW * FH) { frame(new Uint8Array(buf.subarray(0, FW * FH))); buf = buf.subarray(FW * FH); } });
ff.on('close', () => {
  const col = (k) => stats.map((s) => s[k]);
  const sum = (k) => { const v = col(k).slice().sort((a, b) => a - b); return `${k}: mean ${(v.reduce((a, b) => a + b, 0) / v.length).toFixed(2)} p95 ${v[Math.floor(v.length * 0.95)].toFixed(2)} max ${v[v.length - 1].toFixed(2)}`; };
  console.log(sum('ink'), '|', sum('fig'), '|', sum('side'), '|', sum('far'));
  for (const lim of [2.3, 3.5]) console.log(`frames with some of the drawing more than ${lim} px out: ${(100 * col('ink').filter((v) => v > lim).length / stats.length).toFixed(1)}%`);
  console.log('lost frames', stats.filter((s) => !s.ok).length, 'min pts', Math.min(...col('pts')), 'min held', Math.min(...col('held')).toFixed(2));
  console.log(stats.filter((_, i) => i % 75 === 0).map((s) => `${s.n}: fig ${s.fig.toFixed(1)} side ${s.side.toFixed(1)} far ${s.far.toFixed(1)} pts ${s.pts} held ${s.held.toFixed(2)}`).join('\n'));
});
