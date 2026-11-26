// How well is a stick figure recognised, and where does it fail?
//   node tools/bench/run.mjs [count] [first-seed] [--show N] [--tap]
// --tap: as when the performer's last tap is on the figure (a touch somewhere on it, up to a
// quarter of its size off-centre), which tells the detector which drawing is meant.
// Runs the page's own detector (src/vision/detect.js) over made-up frames (scenes.mjs):
// `count` with a figure and a quarter as many without one. For each condition it reports
// how often the figure was found (and in the right place), and how often something that is
// not a figure was taken for one. --show N writes the first N failures as PNGs to
// /tmp/sticks-bench for a look.

import { makeScene } from './scenes.mjs';
import { detectFigure } from '../../src/vision/detect.js';
import { shrink, grabber } from './frame.mjs';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const count = Number(args[0] || 300), first = Number(args[1] || 1);
const show = args.includes('--show') ? Number(args[args.indexOf('--show') + 1]) : 0;
const TAP = args.includes('--tap');
const PROC_LONG = 640;              // (as on the page; see frame.mjs)

function iou(a, b) {
  const ix = Math.max(0, Math.min(a.maxX, b.maxX) - Math.max(a.minX, b.minX)), iy = Math.max(0, Math.min(a.maxY, b.maxY) - Math.max(a.minY, b.minY));
  const ua = (a.maxX - a.minX) * (a.maxY - a.minY) + (b.maxX - b.minX) * (b.maxY - b.minY) - ix * iy;
  return ua > 0 ? ix * iy / ua : 0;
}

const rows = [], fails = [];
const t0 = Date.now();
const negatives = Math.round(count / 4);
for (let n = 0; n < count + negatives; n++) {
  const seed = first + n, figure = n < count;
  const sc = makeScene(seed, figure ? {} : { figure: false, clutter: 1 + (seed % 4) });
  const P = shrink(sc.gray, sc.W, sc.H);
  const t1 = Date.now();
  let near = null;
  if (TAP && figure) {
    const t = sc.truth, j = (k) => (((seed * 2654435761 * k) >>> 0) / 4294967296 - 0.5) * 0.5;
    near = { x: ((t.minX + t.maxX) / 2 + (t.maxX - t.minX) * j(1)) * P.s, y: ((t.minY + t.maxY) / 2 + (t.maxY - t.minY) * j(3)) * P.s };
  }
  const hit = detectFigure(P.g, P.w, P.h, grabber(sc.gray, sc.W, sc.H, P.s), { near });
  const ms = Date.now() - t1;
  const found = hit && hit.confident ? hit : null;
  let result;
  if (figure) {
    const tb = { minX: sc.truth.minX * P.s, minY: sc.truth.minY * P.s, maxX: sc.truth.maxX * P.s, maxY: sc.truth.maxY * P.s };
    // Right place: overlaps the truth well (the box can be a little loose or tight).
    result = !found ? 'missed' : iou(found.box, tb) > 0.45 ? 'found' : 'wrong';
  } else result = found ? 'false' : 'clear';
  rows.push({ seed, figure, result, ms, o: sc.opts, sure: !!(found && found.sure), jointed: !!(found && found.jointed) });
  if (show && (result === 'missed' || result === 'wrong' || result === 'false') && fails.length < show) fails.push({ seed, sc, result, hit });
}

// ---- report ----
const pct = (a, b) => (b ? `${(100 * a / b).toFixed(0)}%` : '-').padStart(5);
const pos = rows.filter((r) => r.figure), neg = rows.filter((r) => !r.figure);
const sum = (rs) => {
  const f = rs.filter((r) => r.result === 'found').length, w = rs.filter((r) => r.result === 'wrong').length;
  return `${pct(f, rs.length)} found  ${pct(w, rs.length)} wrong place   (${rs.length})`;
};
console.log(`\nWITH A FIGURE  ${sum(pos)}${TAP ? '   [tapped]' : ''}`);
{ const f = pos.filter((r) => r.result === 'found'); console.log(`   of those found: ${pct(f.filter((r) => r.jointed).length, f.length)} fully jointed, ${pct(f.filter((r) => r.sure).length, f.length)} passed the shape test`); }
console.log(`NO FIGURE      ${pct(neg.filter((r) => r.result === 'false').length, neg.length)} mistaken for one   (${neg.length})`);
const bins = {
  table: (o) => o.table, paper: (o) => o.paper, sheet: (o) => o.sheet, pen: (o) => o.pen,
  'figure size': (o) => (o.figH < 0.1 ? '<10%' : o.figH < 0.16 ? '10-16%' : o.figH < 0.24 ? '16-24%' : '>24%'),
  turn: (o) => (Math.abs(o.turn) < 10 ? '<10°' : Math.abs(o.turn) < 25 ? '10-25°' : '25-40°'),
  tilt: (o) => (o.tilt < 0.12 ? 'low' : o.tilt < 0.24 ? 'mid' : 'high'),
  'near card edge': (o) => String(o.nearEdge), clutter: (o) => String(o.clutter), shadow: (o) => String(o.shadow),
  light: (o) => (o.light < 0.15 ? 'even' : 'uneven'), blur: (o) => String(o.blur),
};
for (const [name, f] of Object.entries(bins)) {
  const groups = {};
  for (const r of pos) (groups[f(r.o)] ||= []).push(r);
  console.log(`\n${name}`);
  for (const [k, rs] of Object.entries(groups).sort()) console.log(`  ${k.padEnd(10)} ${sum(rs)}`);
}
const ms = rows.map((r) => r.ms).sort((a, b) => a - b);
console.log(`\ndetector time per frame: median ${ms[ms.length >> 1]} ms, 95th ${ms[Math.floor(ms.length * 0.95)]} ms   (total ${((Date.now() - t0) / 1000).toFixed(0)} s)`);
console.log(`missed seeds: ${pos.filter((r) => r.result === 'missed').map((r) => r.seed).join(' ')}`);
console.log(`wrong seeds: ${pos.filter((r) => r.result === 'wrong').map((r) => r.seed).join(' ')}`);
console.log(`false seeds: ${neg.filter((r) => r.result === 'false').map((r) => r.seed).join(' ')}`);

if (fails.length) {
  mkdirSync('/tmp/sticks-bench', { recursive: true });
  for (const f of fails) {
    const { W, H } = f.sc, rgb = Buffer.alloc(W * H * 3);
    for (let i = 0; i < W * H; i++) rgb[i * 3] = rgb[i * 3 + 1] = rgb[i * 3 + 2] = f.sc.gray[i];
    const mark = (b, c) => { if (!b) return; for (let x = Math.max(0, b.minX | 0); x <= Math.min(W - 1, b.maxX | 0); x++) for (const y of [b.minY | 0, b.maxY | 0]) if (y >= 0 && y < H) rgb.set(c, (y * W + x) * 3); for (let y = Math.max(0, b.minY | 0); y <= Math.min(H - 1, b.maxY | 0); y++) for (const x of [b.minX | 0, b.maxX | 0]) if (x >= 0 && x < W) rgb.set(c, (y * W + x) * 3); };
    mark(f.sc.truth, [0, 200, 0]);
    if (f.hit) { const s = W / Math.round(W * Math.min(1, PROC_LONG / Math.max(W, H))); mark({ minX: f.hit.box.minX * s, minY: f.hit.box.minY * s, maxX: f.hit.box.maxX * s, maxY: f.hit.box.maxY * s }, f.hit.confident ? [230, 0, 0] : [230, 160, 0]); }
    const file = `/tmp/sticks-bench/${f.result}-${f.seed}.png`;
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${W}x${H}`, '-i', '-', file], { input: rgb });
  }
  console.log(`wrote ${fails.length} failures to /tmp/sticks-bench (green = truth, red = taken for a figure, orange = candidate not believed)`);
}
