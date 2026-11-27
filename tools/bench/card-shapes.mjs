// Every card of every deck design, as the card reader sees its index: the value's shape (rv)
// and the suit's (sv), labelled, plus some marks that are not an index (value 0). This is
// what make-card-glyphs.cjs trains on (SHAPES=…) and is tested against (HOLD=…).
//   FACES=/somewhere/faces node tools/bench/card-shapes.mjs shapes.json
import { cardScene } from './cards.mjs';
import { findIndexes, SUIT_NAMES } from '../../src/vision/card.js';
import { apply } from '../../src/vision/homography.js';
import { writeFileSync } from 'node:fs';
const decks = (process.env.DECKS || 'bellot,cardsjs,knoll,knollbig').split(','), out = [];
let seed = 100000, missed = 0;
for (const deck of decks) for (const suit of SUIT_NAMES) for (let value = 1; value <= 13; value++) for (const [size, blur] of [[0.3, 0], [0.3, 1], [0.45, 1], [0.45, 2], [0.7, 0], [0.7, 2]]) {
  const sc = cardScene(++seed, [`${deck}_${value}_${suit}`], { size, blur, off: false, thumb: false, table: ['dark', 'white', 'felt'][seed % 3] }), debug = { cands: [] };
  findIndexes(sc.rgba, sc.W, sc.H, { debug });
  const c = sc.cards[0];
  const at = { bellot: [0.09, 0.21], cardsjs: [0.08, 0.2], knoll: [0.09, 0.19], knollbig: [0.14, 0.35], knoll4: [0.09, 0.19] }[deck];
  const top = apply(c.toFrame, 0.5, 0), bot = apply(c.toFrame, 0.5, 1), dn = Math.hypot(bot.x - top.x, bot.y - top.y), dx = (bot.x - top.x) / dn, dy = (bot.y - top.y) / dn;
  let bestC = null, bestA = 0.26;
  for (const cand of debug.cands) for (const sgn of [1, -1]) {
    const p = sgn > 0 ? apply(c.toFrame, at[0], at[1]) : apply(c.toFrame, 1 - at[0], 1 - at[1]);
    if (Math.hypot(p.x - cand.x, p.y - cand.y) > c.ch * 0.035) continue;
    const ang = Math.acos(Math.max(-1, Math.min(1, sgn * (cand.ux * dx + cand.uy * dy))));
    if (ang < bestA) { bestA = ang; bestC = cand; }
  }
  {
    const pA = apply(c.toFrame, at[0], at[1]), pB = apply(c.toFrame, 1 - at[0], 1 - at[1]);
    const others = debug.cands.filter((cand) => Math.hypot(pA.x - cand.x, pA.y - cand.y) > c.ch * 0.1 && Math.hypot(pB.x - cand.x, pB.y - cand.y) > c.ch * 0.1);
    for (let j = 0; j < Math.min(5, others.length); j++) { const o = others[(j * 7 + seed) % others.length]; out.push({ deck, value: 0, suit, size, blur, n: o.n, wide: +o.wide.toFixed(3), rv: Array.from(o.rv, (x) => +x.toFixed(4)) }); }
  }
  if (!bestC) { missed += 1; continue; }
  out.push({ deck, value, suit, size, blur, tone: bestC.tone, n: bestC.n, wide: +bestC.wide.toFixed(3), rv: Array.from(bestC.rv, (x) => +x.toFixed(4)), sv: Array.from(bestC.sv, (x) => +x.toFixed(4)) });
}
writeFileSync(process.argv[2] || 'shapes.json', JSON.stringify(out));
console.log('samples', out.length, 'missed', missed);
const by = {}; for (const o of out) { const k = o.deck + (o.value ? '' : ' other'); by[k] = (by[k] || 0) + 1; } console.log(by);
