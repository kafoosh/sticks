// Makes a stand-in camera feed for testing without a phone: a sheet of paper on a table
// with a pen-drawn figure, filmed by a hand-held camera that drifts, turns, tilts and zooms.
//   node tools/make-test-video.mjs out.mjpeg [seconds] [photo]
// With a photo (say, a frame from a screen recording of the real thing), that photo is the
// scene instead, filmed upright in portrait as a phone would.
// Needs Playwright (to paint the scene) and ffmpeg (to film it).
import { createRequire } from 'node:module';
import { execFileSync, spawn } from 'node:child_process';
import { invert } from '../src/vision/homography.js';
import { cameraView } from './camera-path.mjs';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const out = process.argv[2] || 'camera.mjpeg', seconds = Number(process.argv[3] || 30);
const dir = mkdtempSync(join(tmpdir(), 'sticks-'));
const photo = process.argv[4];
if (photo) {
  // Lay the photo on its side in the middle of the landscape scene, so that filming it and
  // turning each frame upright again gives a portrait phone picture of it.
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', photo, '-f', 'lavfi', '-i', 'color=c=0x8a8780:s=1920x1080',
    '-filter_complex', '[0]transpose=2,scale=1180:-2[p];[1][p]overlay=900-overlay_w/2:540-overlay_h/2', '-frames:v', '1', join(dir, 'scene.png')]);
} else {
const { chromium } = createRequire(import.meta.url)('playwright');
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
await page.setContent('<canvas id=c width=1920 height=1080></canvas>');
const png = await page.evaluate(() => {
  const c = document.getElementById('c'), x = c.getContext('2d');
  let s = 7; const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  // Table: wood, with grain and specks.
  x.fillStyle = '#8a6a48'; x.fillRect(0, 0, 1920, 1080);
  for (let i = 0; i < 900; i++) {
    x.strokeStyle = `rgba(${40 + rnd() * 60},${25 + rnd() * 40},${10 + rnd() * 30},${0.08 + rnd() * 0.2})`;
    x.lineWidth = 1 + rnd() * 3;
    const y = rnd() * 1080; x.beginPath(); x.moveTo(0, y);
    for (let k = 1; k <= 8; k++) x.lineTo(k * 240, y + (rnd() - 0.5) * 14);
    x.stroke();
  }
  for (let i = 0; i < 500; i++) { x.fillStyle = `rgba(30,20,10,${rnd() * 0.5})`; x.fillRect(rnd() * 1920, rnd() * 1080, 1 + rnd() * 4, 1 + rnd() * 3); }
  // Paper, slightly askew, with a soft shadow and uneven light.
  x.save(); x.translate(960, 540); x.rotate(-0.04);
  x.shadowColor = 'rgba(0,0,0,0.45)'; x.shadowBlur = 24; x.shadowOffsetY = 8;
  const g = x.createLinearGradient(-560, -400, 560, 400);
  g.addColorStop(0, '#f6f3ea'); g.addColorStop(1, '#dedad0');
  x.fillStyle = g; x.fillRect(-560, -400, 1120, 800);
  x.shadowColor = 'transparent';
  // The figure, in blue-black biro, drawn a bit wobbly.
  x.strokeStyle = 'rgba(24,28,58,0.93)'; x.lineWidth = 4.2; x.lineCap = 'round'; x.lineJoin = 'round';
  const wob = (pts) => { x.beginPath(); pts.forEach(([px, py], i) => { const qx = px + (rnd() - 0.5) * 2.2, qy = py + (rnd() - 0.5) * 2.2; if (i) x.lineTo(qx, qy); else x.moveTo(qx, qy); }); x.stroke(); };
  const seg = (a, b, n = 10) => Array.from({ length: n + 1 }, (_, i) => [a[0] + (b[0] - a[0]) * i / n, a[1] + (b[1] - a[1]) * i / n]);
  const ox = -150, oy = -20;
  wob(Array.from({ length: 33 }, (_, i) => { const a = -Math.PI / 2 + i / 31 * Math.PI * 2.04; return [ox + Math.cos(a) * 33, oy - 95 + Math.sin(a) * 36]; }));
  wob(seg([ox + 1, oy - 59], [ox - 2, oy + 45]));
  wob([...seg([ox - 62, oy + 12], [ox - 1, oy - 30]), ...seg([ox - 1, oy - 30], [ox + 58, oy + 6])]);
  wob(seg([ox - 2, oy + 45], [ox - 40, oy + 130]));
  wob(seg([ox - 2, oy + 45], [ox + 36, oy + 132]));
  // Something else on the page and the table, as there would be.
  x.font = 'italic 30px Georgia'; x.fillStyle = 'rgba(24,28,58,0.8)'; x.fillText('hello!', 330, -300);
  x.restore();
  x.fillStyle = '#b3272d'; x.save(); x.translate(1650, 250); x.rotate(0.5); x.fillRect(-120, -9, 240, 18); x.restore();
  x.strokeStyle = 'rgba(60,30,10,0.5)'; x.lineWidth = 9; x.beginPath(); x.arc(250, 850, 70, 0, 7); x.stroke();
  return c.toDataURL('image/png');
});
await browser.close();
writeFileSync(join(dir, 'scene.png'), Buffer.from(png.split(',')[1], 'base64'));
}

// Film it: every frame is the scene seen through `cameraView(n)`, plus fresh sensor grain.
const W = 1280, H = 720, FPS = 30;
const scene = execFileSync('ffmpeg', ['-loglevel', 'error', '-i', join(dir, 'scene.png'), '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 1 << 30 });
const SW = 1920;
const enc = spawn('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${W}x${H}`, '-r', String(FPS), '-i', '-',
  ...(photo ? ['-vf', 'transpose=1'] : []), '-c:v', 'mjpeg', '-pix_fmt', 'yuvj420p', '-q:v', '3', '-f', 'mjpeg', out], { stdio: ['pipe', 'inherit', 'inherit'] });
let seed = 99;
const frame = Buffer.alloc(W * H * 3);
for (let n = 0; n < seconds * FPS; n++) {
  const M = invert(cameraView(n, W, H));               // picture px → scene px
  for (let y = 0; y < H; y++) {
    let o = y * W * 3;
    for (let x = 0; x < W; x++) {
      const w = M[6] * x + M[7] * y + M[8];
      const sx = (M[0] * x + M[1] * y + M[2]) / w, sy = (M[3] * x + M[4] * y + M[5]) / w;
      const x0 = sx | 0, y0 = sy | 0, tx = sx - x0, ty = sy - y0, i = (y0 * SW + x0) * 3, j = i + SW * 3;
      seed = (seed * 1664525 + 1013904223) >>> 0;
      const grain = ((seed >>> 16) & 255) / 255 * 10 - 5;
      for (let c = 0; c < 3; c++) {
        const a = scene[i + c] + (scene[i + 3 + c] - scene[i + c]) * tx, b = scene[j + c] + (scene[j + 3 + c] - scene[j + c]) * tx;
        const v = a + (b - a) * ty + grain;
        frame[o++] = v < 0 ? 0 : v > 255 ? 255 : v;
      }
    }
  }
  if (!enc.stdin.write(frame)) await new Promise((r) => enc.stdin.once('drain', r));
}
enc.stdin.end();
await new Promise((r) => enc.on('close', r));
console.log('wrote', out);
