// Turns a photo of real drawings into recognition fixtures for the tests: for each figure
// (its box in the photo), a phone-like portrait frame around it, in grey, gzipped, plus the
// truth. Needs ffmpeg.
//   node tools/make-fixtures.mjs photo.jpg name x0,y0,x1,y1 [x0,y0,x1,y1 …]
import { execFileSync } from 'node:child_process';
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { gzipSync } from 'node:zlib';

const [photo, name, ...boxes] = process.argv.slice(2);
const [PW, PH] = execFileSync('ffprobe', ['-loglevel', 'error', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', photo]).toString().trim().split(',').map(Number);
const index = existsSync('tests/fixtures/real.json') ? JSON.parse(readFileSync('tests/fixtures/real.json')) : [];
boxes.forEach((b, k) => {
  const [x0, y0, x1, y1] = b.split(',').map(Number);
  // A 3:4 portrait frame with the figure about a fifth of its height, centred on it.
  const fh = y1 - y0, H = Math.round(Math.min(PH, fh * 4.5)), W = Math.round(Math.min(PW, H * 0.75));
  const cx = Math.min(PW - W / 2, Math.max(W / 2, (x0 + x1) / 2)), cy = Math.min(PH - H / 2, Math.max(H / 2, (y0 + y1) / 2));
  const fx = Math.round(cx - W / 2), fy = Math.round(cy - H / 2);
  // Store at 600×800 (a phone frame's worth of detail round a figure this size).
  const outW = 600, outH = 800, s = outW / W;
  const gray = execFileSync('ffmpeg', ['-loglevel', 'error', '-i', photo, '-vf', `crop=${W}:${H}:${fx}:${fy},scale=${outW}:${outH}:flags=area,format=gray`, '-f', 'rawvideo', '-'], { maxBuffer: 1 << 28 });
  const file = `${name}-${k + 1}.gray.gz`;
  writeFileSync(`tests/fixtures/${file}`, gzipSync(gray, { level: 9 }));
  const entry = { file, W: outW, H: outH, truth: { minX: (x0 - fx) * s, minY: (y0 - fy) * s, maxX: (x1 - fx) * s, maxY: (y1 - fy) * s } };
  const i = index.findIndex((e) => e.file === file);
  if (i >= 0) index[i] = entry; else index.push(entry);
  console.log(file, JSON.stringify(entry.truth, (kk, v) => typeof v === 'number' ? Math.round(v) : v));
});
writeFileSync('tests/fixtures/real.json', JSON.stringify(index, null, 1) + '\n');
