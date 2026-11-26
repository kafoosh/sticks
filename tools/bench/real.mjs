// The real-drawing fixtures (tests/fixtures/real.json, made by tools/make-fixtures.mjs):
// for each, whether the page's detector finds the figure, and if not, where it got lost.
//   node tools/bench/real.mjs
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { shrink, grabber } from './frame.mjs';
import { detectFigure, readFigure, rigFrom, looksLikeStickFigure } from '../../src/vision/detect.js';
import { inkMask, findCandidates, removeRuledLines } from '../../src/vision/ink.js';

const index = JSON.parse(readFileSync(new URL('../../tests/fixtures/real.json', import.meta.url)));
export function loadFixture(e) { return new Uint8Array(gunzipSync(readFileSync(new URL(`../../tests/fixtures/${e.file}`, import.meta.url)))); }

export function check(e, tap = false) {
  const gray = loadFixture(e), P = shrink(gray, e.W, e.H), grab = grabber(gray, e.W, e.H, P.s);
  const t = e.truth, tb = { minX: t.minX * P.s, minY: t.minY * P.s, maxX: t.maxX * P.s, maxY: t.maxY * P.s };
  const hit = detectFigure(P.g, P.w, P.h, grab, { near: tap ? { x: (tb.minX * 0.6 + tb.maxX * 0.4), y: (tb.minY * 0.45 + tb.maxY * 0.55) } : null });
  const inside = (b) => { const cx = (b.minX + b.maxX) / 2, cy = (b.minY + b.maxY) / 2; return cx > tb.minX && cx < tb.maxX && cy > tb.minY && cy < tb.maxY; };
  if (hit && hit.confident && inside(hit.box)) return { ok: true, why: hit.jointed ? 'found, jointed' : 'found, moves as one piece' };
  if (hit && hit.confident) return { ok: false, why: 'took something else for the figure' };
  // Diagnose.
  const r = Math.max(8, Math.round(Math.max(P.w, P.h) * 0.022)), lineR = Math.max(3, Math.round(r * 0.4));
  const cands = findCandidates(removeRuledLines(inkMask(P.g, P.w, P.h, r, 0.13, 9, lineR), P.w, P.h, Math.round(Math.max(P.w, P.h) * 0.3), P.g), P.w, P.h, { gray: P.g, reach: lineR + 2 });
  const ci = cands.findIndex((b) => inside(b) || (b.minX < tb.minX + 4 && b.maxX > tb.maxX - 4 && b.minY < tb.minY + 4 && b.maxY > tb.maxY - 4));
  if (ci < 0) return { ok: false, why: `no candidate on the figure (${cands.length} others)` };
  const b = cands[ci], size = ((b.maxX - b.minX) * (b.maxY - b.minY)) / ((tb.maxX - tb.minX) * (tb.maxY - tb.minY));
  const f = readFigure(b, grab);
  if (!f) return { ok: false, why: `candidate #${ci + 1} (box ×${size.toFixed(1)}) didn't trace` };
  const shape = looksLikeStickFigure(f.trace), jointed = rigFrom(f.trace, '#000').confident;
  return { ok: false, why: `candidate #${ci + 1} (box ×${size.toFixed(1)}): shape ${shape.ok ? 'ok' : shape.why}, rig ${jointed ? 'ok' : 'no'}, head ${f.trace.head}` };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  let ok = 0;
  for (const e of index) { const r = check(e, process.argv.includes('--tap')); if (r.ok) ok += 1; console.log(`${r.ok ? 'ok  ' : 'FAIL'} ${e.file.padEnd(18)} ${r.why}`); }
  console.log(`${ok} / ${index.length}`);
}
