// How well the card reader (src/vision/card.js) reads playing cards it has never seen.
//
// It makes camera frames of a card lying on a table — from real deck designs (rendered by
// tools/bench/card-faces.cjs into a directory given as FACES=…), small to large, turned any
// way up, tilted, partly out of the picture or under a thumb, in warm or cool, even or
// uneven light, sharp or blurred — and frames with no card at all. For each it reports
// whether the reader was RIGHT, said NOTHING, or was WRONG; wrong is the one that matters.
//   FACES=/path/to/faces node tools/bench/cards.mjs 400
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { execSync } from 'node:child_process';
import { fromQuad, invert, apply } from '../../src/vision/homography.js';
import { readCard, findIndexes, SUIT_NAMES } from '../../src/vision/card.js';
import { makeScene, rng } from './scenes.mjs';

const FACES = process.env.FACES;
const index = FACES && existsSync(`${FACES}/index.json`) ? JSON.parse(readFileSync(`${FACES}/index.json`)) : null;
const cache = new Map();
function face(name) {
  if (!cache.has(name)) { if (cache.size > 40) cache.clear(); cache.set(name, { ...index[name], rgba: new Uint8Array(gunzipSync(readFileSync(`${FACES}/${name}.rgba.gz`))) }); }
  return cache.get(name);
}

const W = 720, H = 1280;
const TABLES = { white: [232, 230, 224], wood: [150, 112, 74], dark: [44, 42, 46], felt: [38, 104, 62], grey: [128, 128, 132] };

/// A frame: { rgba, W, H, opts }. `cards`: [{ name }] (the first is the one to read).
export function cardScene(seed, names, opts = {}) {
  const r = rng(seed);
  const o = { table: r.pick(Object.keys(TABLES)), size: r.range(0.2, 0.78), turn: r.pick(['up', 'up', 'up', 'down', 'any']), tilt: r.range(0, 0.22), blur: r.pick([0, 0, 1, 1, 2]), thumb: r.bool(0.2), off: r.bool(0.2), light: r.pick(['even', 'uneven']), warm: r.range(-0.08, 0.08), dim: r.range(0.62, 1), ...opts };
  const out = new Float32Array(W * H * 3), base = TABLES[o.table];
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const grain = o.table === 'wood' ? 10 * Math.sin(y * 0.11 + 3 * Math.sin(x * 0.013)) : 0, i = (y * W + x) * 3;
    out[i] = base[0] + grain; out[i + 1] = base[1] + grain * 0.8; out[i + 2] = base[2] + grain * 0.6;
  }
  const quads = [];
  names.forEach((name, k) => {
    const f = face(name), ch = H * (k ? o.size * r.range(0.7, 1.1) : o.size), cw = ch * f.W / f.H;
    const ang = (o.turn === 'any' ? r.range(-Math.PI, Math.PI) : r.range(-0.6, 0.6) + (o.turn === 'down' ? Math.PI : 0)) + (k ? r.range(-0.8, 0.8) : 0);
    const kx = r.range(-o.tilt, o.tilt), ky = 1 - Math.abs(r.range(0, o.tilt)) * 0.8;
    let cx = W * r.range(0.3, 0.7), cy = H * r.range(0.3, 0.7);
    if (k) { cx = W * r.range(0.15, 0.85); cy = quads[0].cy + (r.bool() ? 1 : -1) * ch * r.range(0.75, 1.0); }
    else if (o.at) { cx = W * o.at[0]; cy = H * o.at[1]; }
    else if (o.off) { if (r.bool()) cx = r.bool() ? cw * 0.15 : W - cw * 0.15; else cy = r.bool() ? ch * 0.2 : H - ch * 0.2; }
    const q = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([sx, sy]) => {
      const x = sx * cw / 2 * (1 + kx * sy), y = sy * ch / 2 * ky;
      return { x: cx + x * Math.cos(ang) - y * Math.sin(ang), y: cy + x * Math.sin(ang) + y * Math.cos(ang) };
    });
    const back = invert(fromQuad([{ x: 0, y: 0 }, { x: f.W, y: 0 }, { x: f.W, y: f.H }, { x: 0, y: f.H }], q));
    const x0 = Math.max(0, Math.floor(Math.min(...q.map((p) => p.x)))), x1 = Math.min(W - 1, Math.ceil(Math.max(...q.map((p) => p.x)))), y0 = Math.max(0, Math.floor(Math.min(...q.map((p) => p.y)))), y1 = Math.min(H - 1, Math.ceil(Math.max(...q.map((p) => p.y))));
    const n = Math.max(1, Math.min(3, Math.round(f.H / ch)));
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      let R = 0, G = 0, B = 0, A = 0;
      for (let b = 0; b < n; b++) for (let a = 0; a < n; a++) {
        const p = apply(back, x + (a + 0.5) / n, y + (b + 0.5) / n), fx = p.x - 0.5, fy = p.y - 0.5;
        if (fx < 0 || fy < 0 || fx > f.W - 1.001 || fy > f.H - 1.001) continue;
        const u = fx | 0, v = fy | 0, tx = fx - u, ty = fy - v, i = (v * f.W + u) * 4, j = i + 4, kk = i + f.W * 4, l = kk + 4;
        const w00 = (1 - tx) * (1 - ty), w10 = tx * (1 - ty), w01 = (1 - tx) * ty, w11 = tx * ty;
        const al = (f.rgba[i + 3] * w00 + f.rgba[j + 3] * w10 + f.rgba[kk + 3] * w01 + f.rgba[l + 3] * w11) / 255;
        // (faces are white where they are see-through, so a plain blend would be wrong: weight by alpha)
        R += (f.rgba[i] * f.rgba[i + 3] * w00 + f.rgba[j] * f.rgba[j + 3] * w10 + f.rgba[kk] * f.rgba[kk + 3] * w01 + f.rgba[l] * f.rgba[l + 3] * w11) / 255;
        G += (f.rgba[i + 1] * f.rgba[i + 3] * w00 + f.rgba[j + 1] * f.rgba[j + 3] * w10 + f.rgba[kk + 1] * f.rgba[kk + 3] * w01 + f.rgba[l + 1] * f.rgba[l + 3] * w11) / 255;
        B += (f.rgba[i + 2] * f.rgba[i + 3] * w00 + f.rgba[j + 2] * f.rgba[j + 3] * w10 + f.rgba[kk + 2] * f.rgba[kk + 3] * w01 + f.rgba[l + 2] * f.rgba[l + 3] * w11) / 255;
        A += al;
      }
      const nn = n * n, a = A / nn, i = (y * W + x) * 3;
      // The card's own paper is a touch off-white.
      out[i] = out[i] * (1 - a) + R / nn * 0.97; out[i + 1] = out[i + 1] * (1 - a) + G / nn * 0.97; out[i + 2] = out[i + 2] * (1 - a) + B / nn * 0.95;
    }
    quads.push({ cx, cy, ch, cw, ang, toFrame: fromQuad([{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }], q) });
  });
  if (o.thumb && quads.length) {
    // A thumb over the lower part of the card.
    const c = quads[0], tx = c.cx + c.cw * r.range(-0.2, 0.5), ty = c.cy + c.ch * r.range(0.15, 0.5), rx = c.cw * 0.22, ry = c.ch * 0.3, ta = r.range(-0.6, 0.6);
    for (let y = Math.max(0, Math.floor(ty - ry - rx)); y < Math.min(H, ty + ry + rx); y++) for (let x = Math.max(0, Math.floor(tx - ry - rx)); x < Math.min(W, tx + ry + rx); x++) {
      const dx = x - tx, dy = y - ty, u = (dx * Math.cos(ta) + dy * Math.sin(ta)) / rx, v = (-dx * Math.sin(ta) + dy * Math.cos(ta)) / ry;
      if (u * u + v * v < 1) { const i = (y * W + x) * 3, sh = 1 - 0.25 * (u * u + v * v); out[i] = 214 * sh; out[i + 1] = 168 * sh; out[i + 2] = 140 * sh; }
    }
  }
  // Light, colour cast, blur, noise.
  const gx = r.range(-1, 1), gy = r.range(-1, 1), depth = o.light === 'uneven' ? r.range(0.15, 0.35) : 0.04;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const l = o.dim * (1 - depth * (0.5 + 0.5 * (gx * (x / W - 0.5) + gy * (y / H - 0.5)) * 2)), i = (y * W + x) * 3;
    out[i] *= l * (1 + o.warm); out[i + 1] *= l; out[i + 2] *= l * (1 - o.warm);
  }
  let img = out;
  for (let pass = 0; pass < o.blur; pass++) {
    const t = new Float32Array(img.length);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) for (let c = 0; c < 3; c++) {
      const i = (y * W + x) * 3 + c;
      t[i] = (img[i] * 2 + img[x > 0 ? i - 3 : i] + img[x < W - 1 ? i + 3 : i] + img[y > 0 ? i - W * 3 : i] + img[y < H - 1 ? i + W * 3 : i]) / 6;
    }
    img = t;
  }
  const rgba = new Uint8ClampedArray(W * H * 4);
  for (let i = 0, j = 0; i < W * H; i++, j += 4) { const nz = (r() - 0.5) * 8; rgba[j] = img[i * 3] + nz; rgba[j + 1] = img[i * 3 + 1] + nz; rgba[j + 2] = img[i * 3 + 2] + nz; rgba[j + 3] = 255; }
  return { rgba, W, H, opts: o, cards: quads };
}

export function savePng(file, rgba, w, h) {
  writeFileSync(file + '.raw', Buffer.from(rgba.buffer, rgba.byteOffset, rgba.length));
  execSync(`ffmpeg -loglevel error -y -f rawvideo -pix_fmt rgba -s ${w}x${h} -i ${file}.raw ${file}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (!index) { console.error('Set FACES to a directory made by tools/bench/card-faces.cjs'); process.exit(1); }
  const N = Number(process.argv[2] || 300), decks = (process.env.DECKS || 'bellot,cardsjs,knoll,knollbig').split(','), show = Number(process.env.SHOW || 0);
  const tally = {}, add = (group, key, what) => { const t = ((tally[group] ||= {})[key] ||= { right: 0, nothing: 0, wrong: 0, n: 0 }); t[what] += 1; t.n += 1; };
  let ms = [], shown = 0;
  const wrongs = [];
  for (let k = 0; k < N; k++) {
    const r = rng(k + 1), deck = decks[k % decks.length], value = 1 + Math.floor(r() * 13), suit = SUIT_NAMES[Math.floor(r() * 4)];
    const sc = cardScene(k + 1, [`${deck}_${value}_${suit}`]);
    const t0 = performance.now(), got = readCard(sc.rgba, W, H); ms.push(performance.now() - t0);
    const what = !got ? 'nothing' : got.value === value && got.suit === suit ? 'right' : 'wrong';
    add('ALL', 'cards', what); add('deck', deck, what); add('value', value <= 10 ? (value === 1 ? 'ace' : value === 10 ? 'ten' : '2-9') : 'court', what); add('suit', suit, what);
    add('size', sc.opts.size < 0.35 ? 'small' : sc.opts.size < 0.55 ? 'medium' : 'large', what); add('blur', sc.opts.blur, what); add('turn', sc.opts.turn, what); add('thumb', sc.opts.thumb, what); add('off the edge', sc.opts.off, what); add('table', sc.opts.table, what);
    if (what === 'wrong') wrongs.push(`${k + 1}: ${deck} ${value} ${suit} read as ${got.value} ${got.suit} (${got.score.toFixed(2)})`);
    if (show && what !== 'right' && shown < show && (process.env.SHOWWHAT || 'nothing,wrong').includes(what)) { savePng(`${process.env.OUT || '.'}/card-${what}-${k + 1}.png`, sc.rgba, W, H); shown += 1; }
  }
  // No card: the stick-figure bench's scenes, with and without a figure.
  let none = 0, noneWrong = 0;
  for (let k = 0; k < Math.round(N / 4); k++) {
    const s = makeScene(5000 + k, k % 3 === 0 ? { figure: false } : {}), rgba = new Uint8ClampedArray(s.W * s.H * 4);
    for (let i = 0; i < s.W * s.H; i++) { rgba[i * 4] = rgba[i * 4 + 1] = rgba[i * 4 + 2] = s.gray[i]; rgba[i * 4 + 3] = 255; }
    none += 1; if (readCard(rgba, s.W, s.H)) noneWrong += 1;
  }
  // Two different cards in view: nothing should be read (or, at worst, one of them).
  let two = { nothing: 0, one: 0, other: 0 };
  for (let k = 0; k < Math.round(N / 6); k++) {
    const r = rng(9000 + k), deck = decks[k % decks.length], a = `${deck}_${1 + Math.floor(r() * 13)}_${SUIT_NAMES[Math.floor(r() * 4)]}`; let b = a; while (b === a) b = `${deck}_${1 + Math.floor(r() * 13)}_${SUIT_NAMES[Math.floor(r() * 4)]}`;
    const sc = cardScene(9000 + k, [a, b], { size: r.range(0.25, 0.4), off: false, thumb: false }), got = readCard(sc.rgba, W, H), name = got && `${deck}_${got.value}_${got.suit}`;
    two[!got ? 'nothing' : name === a || name === b ? 'one' : 'other'] += 1;
  }
  const pct = (a, b) => `${Math.round(100 * a / Math.max(1, b))}%`.padStart(4);
  for (const [group, rows] of Object.entries(tally)) {
    console.log(group === 'ALL' ? '' : `\n${group}`);
    for (const [key, t] of Object.entries(rows)) console.log(`  ${String(key).padEnd(10)} ${pct(t.right, t.n)} right  ${pct(t.nothing, t.n)} nothing  ${pct(t.wrong, t.n)} wrong   (${t.n})`);
  }
  console.log(`\nno card in view: ${noneWrong} of ${none} read as a card`);
  console.log(`two different cards in view: nothing ${two.nothing}, one of them ${two.one}, something else ${two.other}`);
  ms.sort((a, b) => a - b);
  console.log(`time per frame: median ${Math.round(ms[ms.length >> 1])} ms, 95th ${Math.round(ms[Math.floor(ms.length * 0.95)])} ms`);
  if (wrongs.length) console.log('WRONG:\n  ' + wrongs.join('\n  '));
}
