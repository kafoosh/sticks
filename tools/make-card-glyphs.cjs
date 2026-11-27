// Makes src/vision/cardglyphs.js: what card.js knows about how cards are printed.
//
// VALUES (A 2…10 J Q K): each is drawn in several dozen typefaces — serif, slab, sans,
// condensed, light to black — many times over, squeezed, slanted, turned a little, blurred,
// and reduced to its centre lines exactly as card.js reduces what it reads. Together with
// things that are NOT a value (suit marks, bits of values, other letters, scribbles) these
// train three small networks (card-train.mjs), whose weights go in the file.
// SHAPES=file.json adds indexes read from real deck designs (tools/bench/card-shapes.mjs);
// HOLD=deck leaves one of those designs out, to be tested on afterwards.
// SUITS: the four marks, from the typefaces that have them plus a few drawn here, likewise;
// "not a suit" is a suit upside down, a value, a scribble.
//
// Needs Playwright's Chromium and the system's fonts; FONTS=…/node_modules adds the
// @fontsource packages named below, if installed there.
//   FONTS=… SHAPES=… HOLD=bellot node tools/make-card-glyphs.cjs
const { chromium } = require('playwright'); const path = require('path'); const fs = require('fs');

const SYSTEM = [['DejaVu Serif', 700], ['DejaVu Serif', 400], ['DejaVu Sans', 700], ['DejaVu Sans', 400], ['Liberation Serif', 400], ['Liberation Serif', 700], ['Liberation Sans', 400], ['Liberation Sans', 700],
  ['FreeSerif', 400], ['FreeSerif', 700], ['FreeSans', 400], ['FreeSans', 700], ['Caladea', 400], ['Caladea', 700], ['Carlito', 700], ['Inter', 400], ['Inter', 800], ['Bitstream Charter', 400], ['Bitstream Charter', 700]];
const PACKAGED = { 'playfair-display': [400, 700, 900], 'roboto-slab': [300, 400, 700], oswald: [300, 400, 600], 'libre-baskerville': [400, 700], 'bodoni-moda': [400, 700], 'roboto-condensed': [300, 400, 700],
  merriweather: [400, 700], 'alfa-slab-one': [400], 'old-standard-tt': [400, 700], 'crimson-text': [400, 700], 'archivo-narrow': [400, 700], rokkitt: [400, 700] };
const SUIT_FONTS = ['DejaVu Sans', 'DejaVu Serif', 'FreeSans', 'FreeSerif', 'FreeMono', 'Unifont', 'IPAGothic', 'WenQuanYi Zen Hei'];
const VALUES = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
const SUITS = { clubs: '♣', hearts: '♥', spades: '♠', diamonds: '♦' };
const EACH = Number(process.env.EACH || 20);       // distorted copies of each value in each typeface

(async () => {
  const { stretch, lines } = await import('../src/vision/card.js');
  const { components } = await import('../src/vision/ink.js');
  const { train, vote, prepare } = await import('./card-train.mjs');
  const GW = 12, GH = 18, SW = 16, SH = 16, CW = 200, CH = 130;
  const browser = await chromium.launch(), page = await browser.newPage();
  fs.writeFileSync('/tmp/card-glyphs.html', `<canvas id=c width=${CW} height=${CH}></canvas>`);
  await page.goto('file:///tmp/card-glyphs.html');
  const fonts = SYSTEM.map(([family, weight]) => ({ family, weight }));
  if (process.env.FONTS) for (const [name, weights] of Object.entries(PACKAGED)) for (const weight of weights) {
    const f = path.join(process.env.FONTS, '@fontsource', name, 'files', `${name}-latin-${weight}-normal.woff2`);
    if (!fs.existsSync(f)) { console.log('no', f); continue; }
    const family = `pkg-${name}-${weight}`;
    await page.evaluate(async ({ family, data }) => { const ff = new FontFace(family, `url(data:font/woff2;base64,${data})`); await ff.load(); document.fonts.add(ff); }, { family, data: fs.readFileSync(f).toString('base64') });
    fonts.push({ family, weight: 400 });
  }
  // Draw one thing several times over (seed < 0: once, plainly). Returns, for each, the
  // picture's darkness as bytes (CW×CH), or null where it came out coloured (an emoji).
  const draw = (spec, seeds) => page.evaluate(({ spec, seeds, CW, CH }) => {
    const x = document.getElementById('c').getContext('2d'), outs = [];
    for (const seed of seeds) {
      let s = (seed * 2654435761) >>> 0 || 1;
      const r = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296), rr = (a, b) => a + (b - a) * r();
      x.setTransform(1, 0, 0, 1, 0, 0); x.filter = 'none'; x.fillStyle = '#fff'; x.fillRect(0, 0, CW, CH); x.fillStyle = '#000';
      const plain = seed < 0, px = plain ? spec.px || 52 : rr(30, 62), sx = plain ? 1 : rr(0.5, 1.05), sh = plain ? 0 : rr(-0.12, 0.12), rot = plain ? 0 : rr(-0.07, 0.07), bl = plain ? 0 : rr(0, 1.3);
      if (spec.shape) {
        // A suit drawn from circles and corners, about 60 across, centred on (100, 65).
        const k = spec.k; x.translate(100, 65);
        if (!plain) { if (bl > 0.3) x.filter = `blur(${bl * 1.5}px)`; x.rotate(rot * 1.5); x.transform(rr(0.8, 1.15), 0, sh, 1, 0, 0); }
        x.beginPath();
        if (spec.shape === 'diamonds') { const b = 30 * k.w, c = k.curve * 8; x.moveTo(0, -34); x.quadraticCurveTo(b / 2 - c, -17 + c, b, 0); x.quadraticCurveTo(b / 2 - c, 17 - c, 0, 34); x.quadraticCurveTo(-b / 2 + c, 17 - c, -b, 0); x.quadraticCurveTo(-b / 2 + c, -17 + c, 0, -34); }
        const heart = (flip) => { const sgn = flip ? -1 : 1, rad = 15.5; x.moveTo(0, sgn * 30); x.bezierCurveTo(-10, sgn * 16, -31 * k.w, sgn * 4, -31 * k.w, sgn * -10); x.arc(-rad * k.w, sgn * -11, rad * k.w, Math.PI, 0, flip); x.arc(rad * k.w, sgn * -11, rad * k.w, Math.PI, 0, flip); x.bezierCurveTo(31 * k.w, sgn * 4, 10, sgn * 16, 0, sgn * 30); };
        if (spec.shape === 'hearts') heart(false);
        if (spec.shape === 'spades') { x.translate(0, -5); heart(true); x.fill(); x.beginPath(); x.moveTo(0, 2); x.quadraticCurveTo(-2, 30, -12 * k.stem, 38); x.lineTo(12 * k.stem, 38); x.quadraticCurveTo(2, 30, 0, 2); }
        if (spec.shape === 'clubs') { const rad = 13.5 * k.w; x.arc(0, -18, rad, 0, 7); x.fill(); x.beginPath(); x.arc(-15, 5, rad, 0, 7); x.fill(); x.beginPath(); x.arc(15, 5, rad, 0, 7); x.fill(); x.beginPath(); x.rect(-5, -8, 10, 14); x.fill(); x.beginPath(); x.moveTo(0, 0); x.quadraticCurveTo(-2, 26, -12 * k.stem, 33); x.lineTo(12 * k.stem, 33); x.quadraticCurveTo(2, 26, 0, 0); }
        x.fill();
      } else {
        x.font = `${spec.weight} ${px}px "${spec.family}"`;
        if (!document.fonts.check(x.font)) return null;
        x.letterSpacing = `${spec.text === '10' && !plain ? rr(-3, 4) : 0}px`;
        if (bl > 0.3) x.filter = `blur(${bl}px)`;
        x.translate(60, 95); x.rotate(rot + (spec.turn ? Math.PI * Math.round(rr(0, 3)) / 2 : 0)); x.transform(sx, 0, sh, 1, 0, 0);
        if (spec.scribble) {
          x.lineWidth = rr(2, 6); x.lineCap = 'round'; x.strokeStyle = '#000';
          for (let k = 0, n = 1 + Math.floor(r() * 3); k < n; k++) { x.beginPath(); x.moveTo(rr(-10, 40), rr(-45, 5)); x.bezierCurveTo(rr(-10, 40), rr(-45, 5), rr(-10, 40), rr(-45, 5), rr(-10, 40), rr(-45, 5)); x.stroke(); }
        } else x.fillText(spec.text, 0, 0);
        // (a bit of a value: half of it wiped away)
        if (spec.part) { x.setTransform(1, 0, 0, 1, 0, 0); x.filter = 'none'; x.fillStyle = '#fff'; const w = r(); if (w < 0.25) x.fillRect(0, 0, CW, 78); else if (w < 0.5) x.fillRect(0, 78, CW, CH); else if (w < 0.75) x.fillRect(0, 0, 60 + px * sx * 0.3, CH); else x.fillRect(60 + px * sx * 0.3, 0, CW, CH); }
      }
      // (as one character a pixel: sent back as lists of numbers this takes minutes)
      const d = x.getImageData(0, 0, CW, CH).data, cut = plain ? 127 : rr(95, 165), out = new Array(CW * CH);
      let tint = 0;
      for (let i = 0, j = 0; i < d.length; i += 4, j++) { const v = 255 - Math.round((d[i] + d[i + 1] + d[i + 2]) / 3); out[j] = String.fromCharCode(spec.soft ? v : v > cut ? 255 : 0); tint = Math.max(tint, Math.abs(d[i] - d[i + 1]), Math.abs(d[i + 1] - d[i + 2])); }
      outs.push(tint > 40 ? null : btoa(out.join('')));
    }
    return outs;
  }, { spec, seeds, CW, CH });
  const measure = (b64) => {
    if (!b64) return null;
    const bytes = Buffer.from(b64, 'base64');
    const soft = Float32Array.from(bytes, (b) => b / 255), bin = Uint8Array.from(bytes, (b) => (b > 127 ? 1 : 0));
    const { labels, comps } = components(bin, CW, CH), big = comps.filter((c) => c.area >= 10);
    if (!big.length) return null;
    const box = { minX: Math.min(...big.map((c) => c.minX)), minY: Math.min(...big.map((c) => c.minY)), maxX: Math.max(...big.map((c) => c.maxX)), maxY: Math.max(...big.map((c) => c.maxY)) };
    return { soft, labels, ids: new Set(big.map((c) => c.id)), box, n: big.length, w: box.maxX - box.minX + 1, h: box.maxY - box.minY + 1 };
  };
  const centre = (m) => lines(m.labels, CW, m.ids, m.box, GW, GH);

  // ---- Values, and what is not one.
  const samples = [];
  let seed = 1, used = 0;
  const many = async (spec, count, k, minH = 0) => { const seeds = Array.from({ length: count }, () => seed++); for (const bytes of (await draw(spec, seeds)) || []) { const m = measure(bytes); if (m && m.h >= minH) samples.push({ u: prepare(centre(m)), k }); } };
  for (const f of fonts) {
    const cap = await draw({ ...f, text: 'H' }, [-1]), capM = cap && measure(cap[0]);
    if (!capM) { console.log('skip', f.family); continue; }
    used += 1;
    for (let i = 0; i < VALUES.length; i++) {
      const m = measure((await draw({ ...f, text: VALUES[i] }, [-1]))[0]);
      if (!m) continue;
      // Old-style figures (a 3 or a 9 that hangs below the line) are not what cards print.
      if (/\d/.test(VALUES[i]) && (Math.abs(m.h / capM.h - 1) > 0.16 || Math.abs(m.box.maxY - capM.box.maxY) > capM.h * 0.12)) continue;
      if (VALUES[i] === '10' ? m.n < 2 : m.n > 1) continue;
      samples.push({ u: prepare(centre(m)), k: i });
      await many({ ...f, text: VALUES[i] }, EACH, i);
    }
  }
  for (const family of ['DejaVu Sans', 'DejaVu Serif', 'FreeSans', 'FreeSerif']) for (const ch of Object.values(SUITS)) await many({ family, weight: 400, text: ch + '\uFE0E', turn: true }, 30, 13, 12);
  for (const f of fonts.filter((_, i) => i % 3 === 0)) for (const text of VALUES) await many({ ...f, text, part: true }, 6, 13, 12);
  for (const f of fonts.filter((_, i) => i % 6 === 0)) for (const text of 'TESMWXYZBPRUNLFHV') await many({ ...f, text }, 4, 13, 12);
  await many({ family: 'DejaVu Sans', weight: 400, scribble: true }, 900, 13, 12);
  const fromFonts = samples.length;
  // Indexes read from real deck designs, if given.
  const hold = (process.env.HOLD || '').split(',').filter(Boolean), held = [];
  if (process.env.SHAPES) for (const d of JSON.parse(fs.readFileSync(process.env.SHAPES))) {
    const smp = { u: prepare(d.rv), k: d.value ? d.value - 1 : 13, deck: d.deck };
    if (hold.includes(d.deck)) held.push(smp); else for (let rep = 0; rep < 3; rep++) samples.push(smp);
  }
  console.log(`training on ${fromFonts} shapes from ${used} typefaces + ${samples.length - fromFonts} from deck designs…`);
  const nets = [0, 1, 2].map((i) => train(samples, { gw: GW, gh: GH, out: 14, seed: 11 + i * 7 }));
  if (held.length) {
    let right = 0, none = 0, wrong = 0, n = 0, otherRead = 0, others = 0;
    for (const smp of held) { const v = vote(nets, smp.u), says = v.k < 13 && v.conf >= 0.8; if (smp.k === 13) { others += 1; if (says) otherRead += 1; } else { n += 1; if (!says) none += 1; else if (v.k === smp.k) right += 1; else wrong += 1; } }
    console.log(`held out (${hold}): ${n} values — ${right} right, ${none} nothing, ${wrong} wrong; ${otherRead} of ${others} other marks read as a value`);
  }

  // ---- Suits: the four marks (from the typefaces that have them, and drawn), squeezed,
  // slanted and blurred; and what is not one — a suit upside down (but for the diamond), a
  // value, a scribble.
  const SUIT_NAMES = Object.keys(SUITS), suitSamples = [];
  const small = (m) => stretch(m.soft, CW, m.box.minX, m.box.minY, m.w, m.h, SW, SH, m.labels, m.ids);
  const suitMany = async (spec, count, k) => {
    const seeds = Array.from({ length: count }, () => seed++);
    for (const b of (await draw({ ...spec, soft: true }, seeds)) || []) {
      const m = measure(b); if (!m || m.n !== 1 || m.w < 14) continue;
      const v = small(m); suitSamples.push({ u: prepare(v), k });
      if (k < 4 && SUIT_NAMES[k] !== 'diamonds') suitSamples.push({ u: prepare(Float32Array.from(v).reverse()), k: 4 });
    }
  };
  for (const family of SUIT_FONTS) for (const weight of [400, 700]) for (let k = 0; k < 4; k++) { await suitMany({ family, weight, text: SUITS[SUIT_NAMES[k]] + '\uFE0E' }, 1, k); await suitMany({ family, weight, text: SUITS[SUIT_NAMES[k]] + '\uFE0E' }, 14, k); }
  for (let k = 0; k < 4; k++) for (const kk of [{ w: 1, stem: 1, curve: 0 }, { w: 0.9, stem: 0.7, curve: 1 }, { w: 1.08, stem: 1.3, curve: 2 }, { w: 0.8, stem: 1, curve: 0.5 }, { w: 1, stem: 0.5, curve: 1.5 }]) await suitMany({ shape: SUIT_NAMES[k], k: kk }, 30, k);
  for (const f of fonts.filter((_, i) => i % 4 === 0)) for (const text of VALUES) if (text !== '10') await suitMany({ ...f, text }, 4, 4);
  await suitMany({ family: 'DejaVu Sans', weight: 400, scribble: true }, 400, 4);
  const drawnSuits = suitSamples.length, heldSuits = [];
  if (process.env.SHAPES) for (const d of JSON.parse(fs.readFileSync(process.env.SHAPES))) {
    if (!d.value || !d.sv) continue;
    const k = SUIT_NAMES.indexOf(d.suit), up = { u: prepare(d.sv), k }, down = k === 3 ? null : { u: prepare(Float32Array.from(d.sv).reverse()), k: 4 };
    if (hold.includes(d.deck)) { heldSuits.push(up); if (down) heldSuits.push(down); } else for (let rep = 0; rep < 3; rep++) { suitSamples.push(up); if (down) suitSamples.push(down); }
  }
  console.log(`training on ${drawnSuits} suit shapes drawn + ${suitSamples.length - drawnSuits} from deck designs…`);
  const suitNets = [0, 1, 2].map((i) => train(suitSamples, { gw: SW, gh: SH, out: 5, hidden: 32, seed: 5 + i * 13 }));
  if (heldSuits.length) {
    let right = 0, none = 0, wrong = 0, n = 0, otherRead = 0, others = 0;
    for (const smp of heldSuits) { const v = vote(suitNets, smp.u), says = v.k < 4 && v.conf >= 0.8; if (smp.k === 4) { others += 1; if (says) otherRead += 1; } else { n += 1; if (!says) none += 1; else if (v.k === smp.k) right += 1; else wrong += 1; } }
    console.log(`held out (${hold}): ${n} suits — ${right} right, ${none} nothing, ${wrong} wrong; ${otherRead} of ${others} upside-down ones read as a suit`);
  }
  await browser.close();

  const b64 = (a) => Buffer.from(a.buffer, a.byteOffset, a.byteLength).toString('base64');
  const net = (n) => `  { hidden: ${n.hidden}, ${['W1', 'b1', 'W2', 'b2'].map((k) => `${k}: { scale: ${n[k].scale}, q: '${b64(n[k].q)}' }`).join(', ')} },`;
  const text = [
    '// GENERATED by tools/make-card-glyphs.cjs — do not edit. What card.js knows about how cards',
    '// are printed: small networks (one hidden layer; weights as bytes in base64, each matrix',
    '// times its scale) that tell what a mark is from a small picture of it.',
    `// VALUE_NETS: A 2…10 J Q K, or "not a value", from a mark's centre lines at GW×GH. Trained on`,
    `//   ${fromFonts} shapes drawn from ${used} typefaces${samples.length > fromFonts ? ' and on indexes read from open-licensed deck designs' : ''}.`,
    `// SUIT_NETS: clubs, hearts, spades, diamonds, or "not a suit (this way up)", from the mark`,
    `//   itself at SW×SH. Trained on ${drawnSuits} drawn shapes${suitSamples.length > drawnSuits ? ' and on the same deck designs' : ''}.`,
    `export const GW = ${GW}, GH = ${GH}, SW = ${SW}, SH = ${SH};`,
    'export const VALUE_NETS = [', ...nets.map(net), '];',
    'export const SUIT_NETS = [', ...suitNets.map(net), '];', '',
  ];
  fs.writeFileSync(path.join(__dirname, '../src/vision/cardglyphs.js'), text.join('\n'));
})();
