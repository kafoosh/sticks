// Card faces for the card bench (cards.mjs) and for card-shapes.mjs: every card of a few
// freely available deck designs, drawn 450 px wide as raw RGBA (gzipped), with an index.json.
// The designs come from npm packages, which this does not install:
//   npm install --prefix /somewhere svg-cards cardsJS @heruka_urgyen/react-playing-cards
//   node tools/bench/card-faces.cjs /somewhere/node_modules /somewhere/faces
// (bellot = svg-cards, LGPL: used for testing only, never for training; cardsjs and knoll… are
// MIT-packaged public-domain designs.)
const { chromium } = require('playwright'); const path = require('path'); const fs = require('fs'); const zlib = require('zlib');
const N = path.resolve(process.argv[2] || 'node_modules'), OUT = path.resolve(process.argv[3] || 'faces');
const R = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'], SU = ['clubs', 'hearts', 'spades', 'diamonds'];
const decks = {
  bellot: (v, s) => `svg-cards/png/2x/${s.slice(0, -1)}_${['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'jack', 'queen', 'king'][v - 1]}.png`,
  cardsjs: (v, s) => `cardsJS/dist/cards/${R[v - 1]}${s[0].toUpperCase()}.svg`,
  knoll: (v, s) => `@heruka_urgyen/react-playing-cards/src/images/2color/${v === 10 ? 'T' : R[v - 1]}${s[0].toUpperCase()}.svg`,
  knollbig: (v, s) => `@heruka_urgyen/react-playing-cards/src/images/2color-bf/${v === 10 ? 'T' : R[v - 1]}${s[0].toUpperCase()}.svg`,
  knoll4: (v, s) => `@heruka_urgyen/react-playing-cards/src/images/4color/${v === 10 ? 'T' : R[v - 1]}${s[0].toUpperCase()}.svg`,
};
(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'blank.html'), '<canvas id=c></canvas>');
  const b = await chromium.launch({ args: ['--allow-file-access-from-files'] }); const p = await b.newPage();
  await p.goto('file://' + path.join(OUT, 'blank.html'));
  const index = {};
  for (const [deck, file] of Object.entries(decks)) {
    if (process.env.ONLY && !process.env.ONLY.split(',').includes(deck)) continue;
    let n = 0;
    for (const s of SU) for (let v = 1; v <= 13; v++) {
      const f = path.join(N, file(v, s));
      if (!fs.existsSync(f)) { console.log('missing', f); continue; }
      const mime = f.endsWith('.png') ? 'image/png' : 'image/svg+xml';
      const res = await p.evaluate(async ({ data, mime }) => {
        const img = new Image(); img.src = `data:${mime};base64,${data}`; await img.decode();
        const W = 450, H = Math.round(W * (img.naturalHeight || 350) / (img.naturalWidth || 250));
        const c = document.getElementById('c'); c.width = W; c.height = H;
        const x = c.getContext('2d'); x.clearRect(0, 0, W, H); x.drawImage(img, 0, 0, W, H);
        const d = x.getImageData(0, 0, W, H).data; let bin = ''; for (let i = 0; i < d.length; i += 8192) bin += String.fromCharCode.apply(null, d.subarray(i, i + 8192));
        return { W, H, b64: btoa(bin) };
      }, { data: fs.readFileSync(f).toString('base64'), mime });
      fs.writeFileSync(path.join(OUT, `${deck}_${v}_${s}.rgba.gz`), zlib.gzipSync(Buffer.from(res.b64, 'base64'), { level: 1 }));
      index[`${deck}_${v}_${s}`] = { W: res.W, H: res.H }; n++;
    }
    console.log(deck, n);
  }
  const old = fs.existsSync(path.join(OUT, 'index.json')) ? JSON.parse(fs.readFileSync(path.join(OUT, 'index.json'))) : {};
  fs.writeFileSync(path.join(OUT, 'index.json'), JSON.stringify({ ...old, ...index }));
  await b.close();
})();
