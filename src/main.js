// The trick. The page is a plain camera view; point it at a little figure drawn on paper.
// The performer dials in a playing card with drags and taps (see "Touch"), and one more tap
// wakes the figure up: its lines are lifted off the paper as a rigged copy, the real ink is
// covered in the picture, and the copy performs on the page — which is followed as the
// camera moves.

import { fit } from './rig/fitter.js';
import { stabilizeSeams } from './rig/seams.js';
import { rigIsConfident, nonArticulated } from './rig/model.js';
import { inkMask, findCandidates, traceFigure, cropFor, NORM_H } from './vision/ink.js';
import { PlaneTracker } from './vision/tracker.js';
import { InkLock } from './vision/inklock.js';
import { apply, multiply, invert, scaleTranslate, normalised } from './vision/homography.js';
import { Compositor } from './stage/compositor.js';
import { Eraser, Swatch } from './stage/paper.js';
import { Show } from './anim/show.js';
import { SUITS, valueLabel } from './anim/glyphs.js';

const PROC_LONG = 640;            // the camera picture is analysed at this size (long side)
const params = new URLSearchParams(location.search);
const DEBUG = params.has('debug');

const video = document.getElementById('cam');
const view = document.getElementById('view');
const dot = document.getElementById('dot');
const pickEl = document.getElementById('pick'), pickValue = document.getElementById('pick-value'), pickSuit = document.getElementById('pick-suit');
const startBtn = document.getElementById('start');
const debugEl = document.getElementById('debug');
const jsfeat = window.jsfeat;

const makeCanvas = (w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; };
const proc = makeCanvas(2, 2), pctx = proc.getContext('2d', { willReadFrequently: true });
const cropCanvas = makeCanvas(2, 2), cctx = cropCanvas.getContext('2d', { willReadFrequently: true });
const layer = makeCanvas(2, 2), lctx = layer.getContext('2d');

let compositor = null;
let state = 'idle';               // 'idle' | 'armed' | 'show'
let found = null;                 // latest figure seen while idle: { box, confident, at }
let armed = null;                 // { card, until }
let live = null;                  // everything belonging to the running show
let gray = null, pw = 0, ph = 0, procScale = 1, frameNo = 0;

// ---------------------------------------------------------------------------------------
// The card

/// A card in the address (…/?7D, …/#7D or …/7D): values A 2–10 J Q K, suits C H S D.
/// Wiped from the address bar straight away.
function readForcedCard() {
  const tail = decodeURIComponent(location.pathname.split('/').pop() || '');
  for (const raw of [location.search.replace(/^\?=?/, ''), location.hash.slice(1), tail]) {
    const m = /^(10|[2-9AJQK])([CHSD])/i.exec(raw);
    if (!m) continue;
    const v = m[1].toUpperCase(), value = v === 'A' ? 1 : v === 'J' ? 11 : v === 'Q' ? 12 : v === 'K' ? 13 : Number(v);
    const keep = [...params.keys()].filter((k) => ['debug', 'nodot'].includes(k)).map((k) => k).join('&');
    try { history.replaceState(null, '', new URL('.', location.href).pathname + (keep ? `?${keep}` : '')); } catch { /* file:// */ }
    return { value, suit: SUITS['CHSD'.indexOf(m[2].toUpperCase())] };
  }
  return null;
}

/// The card being dialled in, shown small in the bottom-left corner. `stage` is what the
/// next drag turns and the next tap does: 'value' → 'suit' → 'ready' (a tap starts the show).
const SUIT_MARK = { clubs: '♣\uFE0E', hearts: '♥\uFE0E', spades: '♠\uFE0E', diamonds: '♦\uFE0E' };   // plain text, not emoji
const pick = { value: 1, suit: 0, stage: 'value' };
{
  const forced = readForcedCard();
  if (forced) { pick.value = forced.value; pick.suit = SUITS.indexOf(forced.suit); pick.stage = 'ready'; }
}
function showPick() {
  pickValue.textContent = valueLabel(pick.value);
  pickSuit.textContent = SUIT_MARK[SUITS[pick.suit]];
  pickEl.dataset.stage = pick.stage;
  pickEl.hidden = pick.stage === 'ready' || state === 'show' || state === 'armed';   // gone once both are locked in
}

// ---------------------------------------------------------------------------------------
// Looking for a figure

function rigFrom(trace, color, dx = 0, dy = 0) {
  const strokes = trace.strokes.map((pts) => ({ points: pts.map((p) => ({ x: p.x + dx, y: p.y + dy })), width: trace.width, color }));
  let rig = stabilizeSeams(fit(strokes));
  const confident = rigIsConfident(rig);
  if (!confident) rig = nonArticulated(rig);
  return { rig, confident };
}

/// The crop `c` (see cropFor) taken from the FULL-resolution camera picture, as grey and
/// RGBA. A small drawing is only a few dozen pixels tall in the analysis frame — too few
/// to read its lines from — but several times that in the camera's own picture.
function grabCrop(c) {
  cropCanvas.width = c.outW; cropCanvas.height = c.outH;
  cctx.drawImage(video, c.x / procScale, c.y / procScale, c.w / procScale, c.h / procScale, 0, 0, c.outW, c.outH);
  const rgba = cctx.getImageData(0, 0, c.outW, c.outH).data;
  const g = new Uint8Array(c.outW * c.outH);
  for (let i = 0; i < g.length; i++) g[i] = (rgba[i * 4] * 77 + rgba[i * 4 + 1] * 151 + rgba[i * 4 + 2] * 28) >> 8;
  return { g, rgba };
}

/// The most figure-like drawing in the current frame, or null. { box (frame px), confident }
/// Only a `confident` one — read as head, body, arms and legs — is ever brought to life.
function detect() {
  const mask = inkMask(gray, pw, ph, Math.max(8, Math.round(Math.max(pw, ph) * 0.022)));
  const cands = findCandidates(mask, pw, ph).slice(0, 3);
  let best = null;
  for (const box of cands) {
    const c = cropFor(box);
    const t = traceFigure(grabCrop(c).g, c.outW, c.outH);
    if (!t || t.strokes.length < 2) continue;
    const { confident } = rigFrom(t, '#000');
    if (confident) return { box, confident: true };
    if (!best) best = { box, confident: false };
  }
  return best;
}

// ---------------------------------------------------------------------------------------
// Waking it up

function begin(card, box) {
  const vw = video.videoWidth, vh = video.videoHeight;
  // Trace from the full-resolution picture: the figure's box, plus a margin, scaled so the
  // figure is NORM_H pixels tall. Those pixels are the stage's units.
  const c = cropFor(box);
  const { g, rgba } = grabCrop(c);
  const trace = traceFigure(g, c.outW, c.outH);
  if (!trace) return false;

  // The pen's colour: the darker half of the ink pixels.
  const lum = [];
  for (let i = 0; i < g.length; i++) if (trace.mask[i]) lum.push(g[i]);
  lum.sort((a, b) => a - b);
  const cut = lum[lum.length >> 1] ?? 255;
  let r = 0, gg = 0, b = 0, n = 0;
  for (let i = 0; i < g.length; i++) if (trace.mask[i] && g[i] <= cut) { r += rgba[i * 4]; gg += rgba[i * 4 + 1]; b += rgba[i * 4 + 2]; n += 1; }
  const ink = n ? `rgba(${Math.round(r / n)},${Math.round(gg / n)},${Math.round(b / n)},0.94)` : 'rgba(28,27,25,0.94)';

  // The stage: a strip of the page around the figure, with room to walk and to think.
  const fb = trace.box, figH = fb.maxY - fb.minY + 1;
  const stage = { w: Math.round(figH * 3.6), h: Math.round(figH * 2.15) };
  const ox = stage.w / 2 - (fb.minX + fb.maxX + 1) / 2, oy = figH * 0.85 - fb.minY;
  const { rig, confident } = rigFrom(trace, ink, ox, oy);
  if (!confident) return false;                          // never animate something that isn't a figure
  // Stage → the reference frame's pixels (as the tracker counts them: pixel centres on whole numbers).
  const stageToRef = scaleTranslate(1 / c.scale, c.x - ox / c.scale - 0.5, c.y - oy / c.scale - 0.5);

  // Tear the piece from whichever side has clean, in-view page.
  const seen = compositor.fit(vw, vh);
  // How bright the paper is right around the figure: the piece must come out of THAT.
  const around = [];
  for (let y = Math.max(0, box.minY); y <= Math.min(ph - 1, box.maxY); y += 2) for (let x = Math.max(0, box.minX); x <= Math.min(pw - 1, box.maxX); x += 2) around.push(gray[y * pw + x]);
  around.sort((a, b) => a - b);
  const paperLevel = around[Math.floor(around.length * 0.75)] ?? 200;
  const tryShow = (side) => {
    const show = new Show(rig, stage, { card, side, ink });
    const rect = { x: show.slot.x - show.pw / 2, y: show.slot.y - show.ph / 2, w: show.pw, h: show.ph };
    let sum = 0, sq = 0, cnt = 0, out = 0;
    for (let j = 0; j < 12; j++) for (let i = 0; i < 16; i++) {
      const p = apply(stageToRef, rect.x + (i + 0.5) * rect.w / 16, rect.y + (j + 0.5) * rect.h / 12);
      const x = Math.round(p.x), y = Math.round(p.y);
      // Off the picture, or in the part of it cropped off this screen: no good.
      if (x < 2 || y < 2 || x >= pw - 2 || y >= ph - 2 || x < seen.x0 * pw || x > seen.x1 * pw || y < seen.y0 * ph || y > seen.y1 * ph) { out += 1; continue; }
      const v = gray[y * pw + x]; sum += v; sq += v * v; cnt += 1;
    }
    const mean = cnt ? sum / cnt : 0, sd = cnt ? Math.sqrt(Math.max(0, sq / cnt - mean * mean)) : 99;
    // Lower is better: plain (low spread), in view, and as bright as the figure's paper —
    // anything much darker is probably the table past the edge of the page.
    return { show, rect, score: sd + out * 4 + Math.max(0, paperLevel - mean - 10) * 3 };
  };
  const a = tryShow(1), z = tryShow(-1);
  const pick = z.score < a.score - 1 ? z : a;

  const tracker = new PlaneTracker(jsfeat, pw, ph);
  tracker.reset(gray, box);
  const lock = new InkLock(rig.strokes.map((st) => st.points.map((p) => apply(stageToRef, p.x, p.y))));
  const view_ = compositor.fit(vw, vh);
  const layerScale = Math.min(2.5, Math.max(0.6, 1.3 * view_.scale / (procScale * c.scale)));
  layer.width = Math.round(stage.w * layerScale); layer.height = Math.round(stage.h * layerScale);

  live = {
    card, stage, show: pick.show, tracker, lock, stageToRef, layerScale, confident,
    eraser: new Eraser(trace.mask, c.outW, c.outH, { x: ox, y: oy, w: c.outW, h: c.outH }),
    swatch: new Swatch(pick.rect, makeCanvas),
    t0: performance.now(), lost: 0,
  };
  compositor.setEraser(live.eraser);
  state = 'show';
  dot.className = '';
  showPick();
  return true;
}

function reset() {
  state = 'idle'; live = null; armed = null; found = null;
  pick.stage = 'value';
  showPick();
}

// ---------------------------------------------------------------------------------------
// Every camera frame

function onFrame() {
  const vw = video.videoWidth, vh = video.videoHeight;
  if (!vw || !vh || video.readyState < 2) return;
  frameNo += 1;
  procScale = Math.min(1, PROC_LONG / Math.max(vw, vh));
  const w = Math.round(vw * procScale), h = Math.round(vh * procScale);
  if (w !== pw || h !== ph) { pw = proc.width = w; ph = proc.height = h; gray = new Uint8Array(w * h); if (live) reset(); }
  pctx.drawImage(video, 0, 0, pw, ph);
  const rgba = pctx.getImageData(0, 0, pw, ph).data;
  for (let i = 0, n = pw * ph; i < n; i++) gray[i] = (rgba[i * 4] * 77 + rgba[i * 4 + 1] * 151 + rgba[i * 4 + 2] * 28) >> 8;

  const now = performance.now();
  if (state === 'armed') {
    const hit = detect();
    if (hit && hit.confident && begin(armed.card, hit.box)) armed = null;
    else if (now > armed.until) { state = 'idle'; armed = null; showPick(); }    // nothing to wake: tap again
  } else if (state === 'idle' && frameNo % 8 === 0) {
    found = detect();
    dot.className = params.has('nodot') || !found ? '' : found.confident ? 'ready' : 'maybe';
  }

  let scene = null;
  if (state === 'show') {
    const L = live;
    const ok = L.tracker.update(gray);
    L.lost = ok ? 0 : L.lost + 1;
    const H = multiply(L.lock.refine(gray, pw, ph, L.tracker.H), L.stageToRef);   // stage → this frame (tracker px)
    const Hpx = multiply(scaleTranslate(1, 0.5, 0.5), H);  // … as picture coordinates
    L.swatch.update(rgba, pw, ph, Hpx);
    L.eraser.paper = L.swatch.mean;
    const t = (now - L.t0) / 1000;
    lctx.setTransform(1, 0, 0, 1, 0, 0);
    lctx.clearRect(0, 0, layer.width, layer.height);
    lctx.setTransform(L.layerScale, 0, 0, L.layerScale, 0, 0);
    L.show.draw(lctx, t, { eraser: L.eraser, swatch: L.swatch });
    if (params.get('debug') === '2') drawDebug(L, Hpx);
    // Stage ↔ video pixels (the analysed frame is the video scaled by procScale).
    const inv = invert(Hpx);
    if (inv) {
      scene = {
        toStage: normalised(multiply(inv, scaleTranslate(procScale, 0, 0))),
        fromStage: normalised(multiply(scaleTranslate(1 / procScale, 0, 0), Hpx)),
        stage: L.stage, erase: L.show.cover(t),
      };
    }
    L.H = Hpx; L.t = t; L.ok = ok;
  }
  compositor.draw(video, vw, vh, layer, scene);
  if (DEBUG) debugEl.textContent = `${state} ${pw}x${ph} ${cost.toFixed(1)}ms ${found ? (found.confident ? 'figure' : 'maybe') : '-'}`
    + (live ? ` t=${live.t.toFixed(1)} pts=${live.tracker.count} ink=${live.lock.held.toFixed(2)} ${live.ok ? '' : 'LOST'} ${live.confident ? 'rigged' : 'rigid'} ${live.card.value}${live.card.suit[0]}` : '');
}

function drawDebug(L, Hpx) {
  const inv = invert(Hpx);
  if (!inv) return;
  lctx.fillStyle = 'rgba(0,255,0,0.8)';
  for (let i = 0; i < L.tracker.count; i++) {
    const p = apply(inv, L.tracker.prevXY[i * 2] + 0.5, L.tracker.prevXY[i * 2 + 1] + 0.5);
    lctx.fillRect(p.x - 1.5, p.y - 1.5, 3, 3);
  }
  lctx.strokeStyle = 'rgba(0,255,0,0.5)'; lctx.lineWidth = 2;
  lctx.strokeRect(1, 1, L.stage.w - 2, L.stage.h - 2);
}

let cost = 0;
function loop() {
  const t0 = performance.now();
  try { onFrame(); cost += (performance.now() - t0 - cost) * 0.05; } catch (e) { console.error(e); if (DEBUG) debugEl.textContent = String(e.stack || e); }
  if (video.requestVideoFrameCallback) video.requestVideoFrameCallback(loop);
  else requestAnimationFrame(loop);
}

// ---------------------------------------------------------------------------------------
// Touch

// Drag up or down anywhere to roll the value round and round (A 2 … K A …); tap to lock it.
// Drag again to roll the suit (♣ ♥ ♠ ♦); tap to lock it. One more tap wakes the figure.
// Triple-tap at any time to start over.
const STEP = 26;                  // px of drag per step
let down = null, taps = [];
window.addEventListener('pointerdown', (e) => { down = { x: e.clientX, y: e.clientY, y0: e.clientY, moved: false }; });
window.addEventListener('pointermove', (e) => {
  if (!down) return;
  if (Math.hypot(e.clientX - down.x, e.clientY - down.y) > 12) down.moved = true;
  if (state !== 'idle' || !down.moved) return;
  const steps = Math.trunc((down.y0 - e.clientY) / STEP);          // dragging up counts up
  if (!steps) return;
  down.y0 -= steps * STEP;
  if (pick.stage === 'value') pick.value = ((pick.value - 1 + steps) % 13 + 13) % 13 + 1;
  else if (pick.stage === 'suit') pick.suit = ((pick.suit + steps) % 4 + 4) % 4;
  showPick();
});
window.addEventListener('pointerup', () => {
  if (!down) return;
  const wasTap = !down.moved, now = performance.now();
  down = null;
  if (!wasTap) return;
  taps = taps.filter((t) => now - t < 600);
  taps.push(now);
  if (taps.length >= 3) { taps = []; reset(); return; }
  if (state !== 'idle') return;
  if (pick.stage === 'value') pick.stage = 'suit';
  else if (pick.stage === 'suit') pick.stage = 'ready';
  else { armed = { card: { value: pick.value, suit: SUITS[pick.suit] }, until: now + 4000 }; state = 'armed'; }
  showPick();
});
window.addEventListener('pointercancel', () => { down = null; });
for (const ev of ['contextmenu', 'gesturestart', 'dblclick']) window.addEventListener(ev, (e) => e.preventDefault());

// ---------------------------------------------------------------------------------------
// Camera

async function startCamera() {
  startBtn.hidden = true;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
    });
    video.srcObject = stream;
    await video.play();
    try { await navigator.wakeLock?.request('screen'); } catch { /* not essential */ }
  } catch (e) {
    console.warn(e);
    startBtn.textContent = e && e.name === 'NotAllowedError' ? 'Camera access is needed — tap to try again' : 'Tap to start the camera';
    startBtn.hidden = false;
  }
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && video.srcObject) {
    video.play().catch(() => {});
    navigator.wakeLock?.request('screen').catch(() => {});
  }
});
startBtn.addEventListener('click', startCamera);

try {
  compositor = new Compositor(view);
  if (DEBUG) debugEl.hidden = false;
  showPick();
  startCamera();
  loop();
} catch (e) {
  startBtn.textContent = 'This browser can’t run this page';
  startBtn.hidden = false;
  console.error(e);
}

// For the automated tests.
window.__sticks = {
  get state() { return state; },
  get found() { return found; },
  get live() { return live; },
  get pick() { return { ...pick }; },
  reset,
  NORM_H,
};
