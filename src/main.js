// The trick. The page is a plain camera view; point it at a little figure drawn on paper.
// The performer dials in a playing card with drags and taps (see "Touch"), and one more tap
// wakes the figure up: its lines are lifted off the paper as a rigged copy, the real ink is
// covered in the picture, and the copy performs on the page — which is followed as the
// camera moves.

import { reviveTrace, NORM_H } from './vision/ink.js';
import { rigFrom } from './vision/detect.js';
import { lookAt, readAt, PROC_LONG, cardAt } from './vision/frame.js';
import { PlaneTracker } from './vision/tracker.js';
import { InkLock } from './vision/inklock.js';
import { apply, multiply, invert, scaleTranslate, normalised } from './vision/homography.js';
import { Compositor } from './stage/compositor.js';
import { Eraser, Swatch } from './stage/paper.js';
import { paperAround } from './stage/sheet.js';
import { Show } from './anim/show.js';
import { SUITS, valueLabel } from './anim/glyphs.js';

const params = new URLSearchParams(location.search);
const DEBUG = params.has('debug');

const video = document.getElementById('cam');
const view = document.getElementById('view');
const statusEl = document.getElementById('status');
const pickEl = document.getElementById('pick'), pickValue = document.getElementById('pick-value'), pickSuit = document.getElementById('pick-suit');
const startBtn = document.getElementById('start');
const debugEl = document.getElementById('debug');
const jsfeat = window.jsfeat;

const makeCanvas = (w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; };
const proc = makeCanvas(2, 2), pctx = proc.getContext('2d', { willReadFrequently: true });
// One camera frame held still. Finding and reading a figure takes a while, and the live
// video moves on meanwhile; a look works from this one snapshot, and so does waking the
// figure — so the close-ups, the analysis frame and where tracking starts all agree.
const snap = makeCanvas(2, 2), sctx = snap.getContext('2d', { willReadFrequently: true });
const layer = makeCanvas(2, 2), lctx = layer.getContext('2d');

let compositor = null;
let state = 'idle';               // 'idle' | 'counting' | 'armed' | 'show'
let found = null;                 // latest figure seen while idle: { box, confident, at }
let armed = null;                 // { card, until }
let counting = null;              // { card, end } — the countdown after the last tap
let target = null;                // where the performer tapped to say "this figure" (frame px), followed as the camera moves
let notice = null;                // { text, until } — a passing message in the corner
const MAX_LAYER = 2e6;            // pixels in the show's layer, at most
const COUNT_S = Math.max(0, Math.min(10, Number(params.get('count') ?? 3)));   // ?count=N seconds
let live = null;                  // everything belonging to the running show
let gray = null, pw = 0, ph = 0, procScale = 1;

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
    const keep = [...params.keys()].filter((k) => ['debug', 'nodot', 'count', 'perf', 'noworker', 'nocard'].includes(k)).map((k) => (k === 'count' ? `count=${params.get('count')}` : k)).join('&');
    try { history.replaceState(null, '', new URL('.', location.href).pathname + (keep ? `?${keep}` : '')); } catch { /* file:// */ }
    return { value, suit: SUITS['CHSD'.indexOf(m[2].toUpperCase())] };
  }
  return null;
}

/// The card being dialled in, shown small in the bottom-left corner. `stage` is what the
/// next drag turns and the next tap does: 'value' → 'suit' → 'ready' (a tap starts the show).
const SUIT_MARK = { clubs: '♣\uFE0E', hearts: '♥\uFE0E', spades: '♠\uFE0E', diamonds: '♦\uFE0E' };   // plain text, not emoji
const pick = { value: 1, suit: 0, stage: 'value', touched: false, read: 0 };   // touched: dialled by hand; read: when the camera read it
// A card held up to the camera is read instead (vision/card.js), unless the performer has
// started dialling one in. It is believed only when the same card is read CARD_LOOKS times
// running; it is then locked in just as if dialled, shown in the corner for a moment, and
// no other card is looked for until a triple-tap starts over.
const CARD_LOOKS = 3, CARD_SHOWN_MS = 2600;
const seeing = { card: null, run: 0, blanks: 0, turn: false };
const readingCards = () => !params.has('nocard') && state === 'idle' && pick.stage === 'value' && !pick.touched;
{
  const forced = readForcedCard();
  if (forced) { pick.value = forced.value; pick.suit = SUITS.indexOf(forced.suit); pick.stage = 'ready'; }
}
function showPick() {
  pickValue.textContent = valueLabel(pick.value);
  pickSuit.textContent = SUIT_MARK[SUITS[pick.suit]];
  const justRead = pick.read && performance.now() - pick.read < CARD_SHOWN_MS;
  pickEl.dataset.stage = justRead ? 'read' : pick.stage;
  pickEl.hidden = (pick.stage === 'ready' && !justRead) || state !== 'idle';   // gone once both are locked in
  showStatus();
}

/// The performer's corner line, just above the card: whether a figure is in view, then the
/// countdown to it moving. Small, and blended against the picture like the card.
function showStatus() {
  const now = performance.now();
  let text = '', level = 'dim';
  if (params.has('nodot') || state === 'show') text = '';
  else if (notice && now < notice.until) { text = notice.text; level = 'bright'; }
  else if (state === 'counting') { text = String(Math.max(1, Math.ceil((counting.end - now) / 1000))); level = 'bright'; }
  else if (state === 'armed') { text = 'finding…'; level = 'bright'; }
  else if (found && found.confident) { text = 'figure ✓'; level = 'bright'; }
  else if (found) text = 'figure?';
  else text = 'looking…';
  if (statusEl.textContent !== text) statusEl.textContent = text;
  statusEl.dataset.level = level;
}

// ---------------------------------------------------------------------------------------
// Looking for a figure

/// Hold the camera's current frame still (see `snap`).
function freeze() {
  const vw = video.videoWidth, vh = video.videoHeight;
  if (snap.width !== vw || snap.height !== vh) { snap.width = vw; snap.height = vh; }
  sctx.drawImage(video, 0, 0);
}

// Looking for a figure, and reading its lines to wake it, each take a tenth of a second or
// more — so they are done by a worker, on a copy of the frame's pixels, while the camera
// picture carries on smoothly; the answer comes back a moment later. (Where a worker can't
// be had, they are done here instead: the same code, with the picture waiting meanwhile.)
let looker = null;                // the worker; null: do it on this thread
let asking = null;                // what the worker is busy with: { id, kind: 'look' | 'read', at, epoch, … }
let askId = 0, epoch = 0;         // (reset() starts a new epoch: answers to earlier questions are dropped)
let nextLookAt = 0, urgent = false, lookTakes = 200;   // (ms a look takes, there and back)
function dropLooker() {
  if (looker) looker.terminate();
  looker = null; asking = null;
}
try {
  looker = new Worker(new URL('./vision/look.worker.js', import.meta.url), { type: 'module' });
  looker.onmessage = (e) => {
    const job = asking;
    if (!job || e.data.id !== job.id) return;
    asking = null;
    if (e.data.error) console.warn(e.data.error);
    if (job.epoch !== epoch) return;
    try {
      if (job.kind === 'read') woken(job, e.data.result);
      else if (job.kind === 'card') sawCard(e.data.result, e.data.ms);
      else seen(e.data.result, job.at, e.data.ms);
    } catch (err) { console.error(err); }
  };
  looker.onerror = (e) => { console.warn('no worker', e && e.message); dropLooker(); };
} catch { looker = null; }
if (params.has('noworker')) dropLooker();

/// Look for a figure in the camera's current frame, unless the worker is busy or a look was
/// only just done. While a tap is being followed up, look where the performer pointed.
function look(now) {
  if (asking || now < nextLookAt) return;
  // With the countdown about to end and the tapped figure just seen, leave the worker free:
  // the figure is woken the moment the count ends, rather than after one more look.
  if (state === 'counting' && looker && found && found.confident && found.pointed && counting.end - now < lookTakes * 1.3 + 60 && counting.end - found.at < 900) return;
  freeze();
  const W = snap.width, H = snap.height, rgba = sctx.getImageData(0, 0, W, H).data;
  const near = state === 'idle' ? null : target;
  // While a card may still be shown to the camera, every other look is for one — and every
  // look, once one has been glimpsed, until it is read for sure or gone.
  const forCard = readingCards() && !urgent && (seeing.card || (seeing.turn = !seeing.turn));
  urgent = false;
  if (looker) {
    asking = { id: ++askId, kind: forCard ? 'card' : 'look', at: now, epoch };
    looker.postMessage({ id: askId, kind: asking.kind, rgba: rgba.buffer, W, H, near }, [rgba.buffer]);
  } else if (forCard) {
    let card = null;
    try { card = cardAt(rgba, W, H); } catch (e) { console.error(e); }
    sawCard(card, performance.now() - now);
  } else {
    let hit = null;
    try { hit = lookAt(rgba, W, H, near); } catch (e) { console.error(e); }
    seen(hit, now, performance.now() - now);
  }
}

/// What a look for a playing card read (null: none, or not for sure).
function sawCard(card, ms) {
  const now = performance.now();
  nextLookAt = now + (looker ? (card ? 0 : 200) : Math.max(250, ms * 4));
  if (!readingCards()) return;
  if (!card) { if (++seeing.blanks > 2) { seeing.card = null; seeing.run = 0; } return; }
  seeing.blanks = 0;
  if (seeing.card && seeing.card.value === card.value && seeing.card.suit === card.suit) seeing.run += 1; else { seeing.card = card; seeing.run = 1; }
  if (seeing.run < CARD_LOOKS) return;
  pick.value = card.value; pick.suit = SUITS.indexOf(card.suit); pick.stage = 'ready'; pick.read = now;
  seeing.card = null; seeing.run = 0;
  showPick();
}

/// What a look found (in the frame taken at `at`, after `ms` of work).
function seen(hit, at, ms) {
  const now = performance.now();
  if (state === 'show') return;
  found = hit;
  if (found) {
    found.at = at; found.got = now;
    lookTakes += (now - at - lookTakes) * 0.5;
    // Keep hold of the figure that was tapped as the camera moves.
    if (found.pointed && target && state !== 'idle') target = { x: (found.box.minX + found.box.maxX) / 2, y: (found.box.minY + found.box.maxY) / 2 };
  }
  // Then a rest: short when the worker does the looking (longer while nothing is waiting on
  // the answer); on this thread, about a fifth of the time at most goes on looking.
  const rest = looker ? (state === 'idle' ? Math.max(250, ms) : Math.max(50, ms * 0.25)) : Math.max(250, ms * 4);
  // (While a card might be shown, the worker looks for one straight after: see look.)
  nextLookAt = urgent || (looker && readingCards()) ? 0 : now + rest;
  showStatus();
}

/// Wake the figure a look found (`hit`), from the frame now held still — whose analysis
/// picture is in `gray`. Its lines are read first (by the worker); see woken().
function wake(hit, now) {
  const W = snap.width, H = snap.height, rgba = sctx.getImageData(0, 0, W, H).data;
  const job = { id: ++askId, kind: 'read', at: now, epoch, hit, card: armed.card, ref: gray.slice() };
  if (looker) {
    asking = job;
    looker.postMessage({ id: job.id, kind: 'read', rgba: rgba.buffer, W, H, crop: hit.crop }, [rgba.buffer]);
  } else {
    let read = null;
    try { read = readAt(rgba, W, H, hit.crop); } catch (e) { console.error(e); }
    woken(job, read);
  }
}

/// The figure's lines have been read (or couldn't be: `read` is null): on with the show.
function woken(job, read) {
  if (state !== 'armed' || !armed) return;
  if (read && begin(job.card, read, job.ref)) armed = null;
}

/// A point on the screen, in the analysis frame's pixels (the video fills the screen, cropped).
function screenToFrame(x, y) {
  const v = compositor.view || { x0: 0, y0: 0, x1: 1, y1: 1 };
  return { x: (v.x0 + (x / window.innerWidth) * (v.x1 - v.x0)) * pw, y: (v.y0 + (y / window.innerHeight) * (v.y1 - v.y0)) * ph };
}

// ---------------------------------------------------------------------------------------
// Waking it up

/// `read`: the figure as read from the frame held still (frame.js readAt); `ref`: that
/// frame's analysis picture, which tracking starts from.
function begin(card, read, ref) {
  const vw = video.videoWidth, vh = video.videoHeight;
  // The figure was traced from the full-resolution picture, in a (possibly turned) crop
  // where it stands upright and NORM_H pixels tall. Those pixels are the stage's units.
  const c = read.crop, trace = reviveTrace(read.trace), ink = read.ink;
  // Where it is in the frame.
  const corners = [[trace.box.minX, trace.box.minY], [trace.box.maxX, trace.box.minY], [trace.box.maxX, trace.box.maxY], [trace.box.minX, trace.box.maxY]].map(([x, y]) => apply(c.toProc, x, y));
  const box = { minX: Math.round(Math.min(...corners.map((q) => q.x))), minY: Math.round(Math.min(...corners.map((q) => q.y))), maxX: Math.round(Math.max(...corners.map((q) => q.x))), maxY: Math.round(Math.max(...corners.map((q) => q.y))) };

  // The stage: a strip of the page around the figure, with room to walk and to think.
  const fb = trace.box, figH = fb.maxY - fb.minY + 1;
  const stage = { w: Math.round(figH * 3.6), h: Math.round(figH * 2.15) };
  const ox = stage.w / 2 - (fb.minX + fb.maxX + 1) / 2, oy = figH * 0.85 - fb.minY;
  const { rig, confident } = rigFrom(trace, ink, ox, oy);
  // (The shape test in detectFigure has already ruled out things that aren't figures. A rig
  // that couldn't place every limb moves as one piece — see rigFrom.)
  // Stage → the reference frame's pixels (as the tracker counts them: pixel centres on whole numbers).
  const stageToRef = multiply(scaleTranslate(1, -0.5, -0.5), multiply(c.toProc, scaleTranslate(1, -ox, -oy)));

  // Where to tear: always to the RIGHT of the figure, level with its middle, and ON the
  // sheet it is drawn on (and on screen), with room for the figure to stand beside it. When
  // the paper's edge is near, the piece comes in closer to the figure (who steps aside to the
  // left), and then shrinks, until it fits. If even the smallest doesn't fit, the one with
  // most paper under it is used — still on the right.
  const shown = compositor.fit(vw, vh);
  const inView = (x, y) => x >= shown.x0 * pw && x <= shown.x1 * pw && y >= shown.y0 * ph && y <= shown.y1 * ph;
  const fb2 = rig.skeleton.bbox;
  const sheet = paperAround(ref, pw, ph, stage, stageToRef, fb2, inView);
  const Hf = fb2.height, minGap = (fb2.width / 2) / Hf + 0.1;
  const core = (dx) => ({ x: fb2.minX + fb2.width * 0.2 + dx, y: fb2.minY + Hf * 0.3, w: fb2.width * 0.6, h: Hf * 0.7 });   // the figure, shifted
  let pick = null;
  const side = 1, level = 0;                               // right of the figure; at its middle
  search:
  for (const scale of [1, 0.85, 0.7, 0.6, 0.5, 0.42]) {
    for (const gap of [0.66, 0.5, Math.max(minGap, 0.36), minGap]) {
      if (gap < minGap) continue;
      const show = new Show(rig, stage, { card, side, ink, place: { gap, dy: level, scale } });
      const rect = { x: show.slot.x - show.pw / 2, y: show.slot.y - show.ph / 2, w: show.pw, h: show.ph };
      const pad = Hf * 0.03, on = sheet ? sheet.covers({ x: rect.x - pad, y: rect.y - pad, w: rect.w + 2 * pad, h: rect.h + 2 * pad }) : 1;
      const stand = sheet ? sheet.covers(core(show.standDX)) : 1;
      const score = on * 10 + stand - (1 - scale) * 0.3;     // (if nothing fits: most paper under it first)
      const cand = { show, rect, side, place: { gap, dy: level, scale }, score, fits: on > 0.999 && stand > 0.85 };
      if (!pick || score > pick.score) pick = cand;
      if (cand.fits) { pick = cand; break search; }
      if (!sheet) break search;                              // can't tell: the usual place
    }
  }
  // How far the figure can pace each way and stay on the sheet.
  const room = { left: Infinity, right: Infinity };
  if (sheet) {
    for (const [key, sg] of [['left', -1], ['right', 1]]) {
      let far = 0;
      while (far < Hf * 0.5 && sheet.covers(core(sg * (far + sheet.cell))) > 0.85) far += sheet.cell;
      room[key] = far;
    }
    pick.show = new Show(rig, stage, { card, side: pick.side, ink, place: pick.place, room });
  }

  const tracker = new PlaneTracker(jsfeat, pw, ph);
  tracker.reset(ref, box);
  const lock = new InkLock(rig.strokes.map((st) => st.points.map((p) => apply(stageToRef, p.x, p.y))));
  const view_ = compositor.fit(vw, vh);
  // The layer the show is drawn on: a little finer than the screen's own pixels where it
  // lands — but no bigger than it need be, as all of it is sent to the screen every frame.
  let layerScale = Math.min(2.5, Math.max(0.6, 1.3 * view_.scale / (procScale * c.scale)));
  layerScale = Math.min(layerScale, Math.sqrt(MAX_LAYER / (stage.w * stage.h)));
  layer.width = Math.round(stage.w * layerScale); layer.height = Math.round(stage.h * layerScale);

  live = {
    card, stage, show: pick.show, tracker, lock, stageToRef, layerScale, confident,
    tear: { side: pick.side, ...pick.place, fits: pick.fits, room }, sheet,
    eraser: new Eraser(trace.mask, c.outW, c.outH, { x: ox, y: oy, w: c.outW, h: c.outH }),
    swatch: new Swatch(pick.rect, makeCanvas),
    refAt: { x: (box.minX + box.maxX) / 2, y: (box.minY + box.maxY) / 2 }, refSize: { w: box.maxX - box.minX, h: box.maxY - box.minY },
    t0: performance.now(), lost: 0, retries: armed ? armed.retries || 0 : 0,
  };
  if (trace.ruleAngle !== undefined && read.rules) live.eraser.shift = ruledShift(live.eraser, trace.ruleAngle, stageToRef, ref, read.rules);
  compositor.setEraser(live.eraser);
  state = 'show';
  showPick();
  return true;
}

/// On ruled paper, cover the figure with paper copied from beside it ALONG the rules, so the
/// rules run straight on through where the figure was. Picks the nearest spot either way
/// along that holds no other drawing and is still the same paper; null if there is none.
/// `gray`: the analysis frame; `all`, `ink`: its ink with and without the rules (so `all`
/// minus `ink` = the rules).
function ruledShift(eraser, angle, stageToRef, gray, { all, ink }) {
  const pts = eraser.coverPoints();
  if (pts.length < 10) return null;
  const dx = Math.cos(angle), dy = Math.sin(angle);
  let lo = Infinity, hi = -Infinity;
  for (const p of pts) { const t = p.x * dx + p.y * dy; lo = Math.min(lo, t); hi = Math.max(hi, t); }
  const span = hi - lo;
  // The paper's brightness by the figure.
  const at = (p) => { const q = apply(stageToRef, p.x, p.y); return { x: Math.round(q.x), y: Math.round(q.y) }; };
  let paper = 0, n = 0;
  for (const p of pts) { const q = at(p); if (q.x >= 0 && q.y >= 0 && q.x < pw && q.y < ph && !ink[q.y * pw + q.x]) { paper += gray[q.y * pw + q.x]; n += 1; } }
  paper = n ? paper / n : 200;
  for (const k of [1.15, 1.6, 2.2]) for (const sg of [1, -1]) {
    const sx = dx * span * k * sg, sy = dy * span * k * sg;
    let bad = 0, off = 0;
    for (const p of pts) {
      const q = at({ x: p.x + sx, y: p.y + sy });
      if (q.x < 0 || q.y < 0 || q.x >= pw || q.y >= ph) { off += 1; continue; }
      const i = q.y * pw + q.x;
      if (ink[i]) bad += 1;
      else if (!all[i] && Math.abs(gray[i] - paper) > paper * 0.25) off += 1;   // not paper (and not a rule)
    }
    if (bad <= pts.length * 0.02 && off <= pts.length * 0.03) return { x: sx, y: sy };
  }
  return null;
}

/// How much brighter the paper is round the figure than round the place a ruled-paper cover
/// is copied from (light falls unevenly across a page), from a ring of samples round each.
function shiftGain(L, Hpx) {
  const sh = L.eraser.shift;
  if (!sh) return 1;
  if (!L.ring) {                                       // the ring: just outside the cover's box
    const pts = L.eraser.coverPoints();
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of pts) { x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x); y0 = Math.min(y0, p.y); y1 = Math.max(y1, p.y); }
    const mx = (x1 - x0) * 0.12 + 4, my = (y1 - y0) * 0.12 + 4;
    L.ring = [];
    for (let k = 0; k < 48; k++) {
      const f = k / 48;
      L.ring.push({ x: x0 - mx + (x1 - x0 + 2 * mx) * f, y: y0 - my }, { x: x0 - mx + (x1 - x0 + 2 * mx) * f, y: y1 + my });
      L.ring.push({ x: x0 - mx, y: y0 - my + (y1 - y0 + 2 * my) * f }, { x: x1 + mx, y: y0 - my + (y1 - y0 + 2 * my) * f });
    }
  }
  const mean = (dx, dy) => {
    let s = 0, n = 0;
    for (const p of L.ring) {
      const q = apply(Hpx, p.x + dx, p.y + dy), x = Math.floor(q.x), y = Math.floor(q.y);
      if (x >= 0 && y >= 0 && x < pw && y < ph) { s += gray[y * pw + x]; n += 1; }
    }
    return n > 20 ? s / n : 0;
  };
  const here = mean(0, 0), there = mean(sh.x, sh.y);
  const g = here > 0 && there > 0 ? Math.min(1.4, Math.max(0.7, here / there)) : 1;
  L.gain = L.gain ? L.gain + (g - L.gain) * 0.3 : g;     // eased: no flicker
  return L.gain;
}

function reset() {
  epoch += 1; nextLookAt = 0;
  state = 'idle'; live = null; armed = null; counting = null; target = null; notice = null; found = null;
  pick.stage = 'value'; pick.touched = false; pick.read = 0;
  seeing.card = null; seeing.run = 0; seeing.blanks = 0;
  showPick();
}

// ---------------------------------------------------------------------------------------
// Every camera frame

function onFrame() {
  const vw = video.videoWidth, vh = video.videoHeight;
  if (!vw || !vh || video.readyState < 2) return;
  procScale = Math.min(1, PROC_LONG / Math.max(vw, vh));
  const w = Math.round(vw * procScale), h = Math.round(vh * procScale);
  if (w !== pw || h !== ph) { pw = proc.width = w; ph = proc.height = h; gray = new Uint8Array(w * h); if (live || asking) reset(); }
  const now = performance.now();
  if (asking && now - asking.at > 8000) dropLooker();     // never answered: carry on without the worker
  if (state === 'counting' && now >= counting.end) { armed = { card: counting.card, until: now + 4000 }; counting = null; state = 'armed'; }
  // Finding the figure and waking it are done on separate frames: a figure a look has just
  // found (a moment ago) is woken from THIS frame, held still, which tracking then starts from.
  let waking = null;
  if (state === 'armed' && !asking && found && found.confident && (now - found.at < 1200 || now - found.got < 300) && (!target || found.pointed)) waking = found;
  mark();
  // The frame's pixels are only needed while there is something on the page to follow.
  let rgba = null;
  if (waking || (state === 'show' && !live.over)) {
    if (waking) freeze();
    pctx.drawImage(waking ? snap : video, 0, 0, pw, ph);
    rgba = pctx.getImageData(0, 0, pw, ph).data;
    for (let i = 0, n = pw * ph; i < n; i++) gray[i] = (rgba[i * 4] * 77 + rgba[i * 4 + 1] * 151 + rgba[i * 4 + 2] * 28) >> 8;
  }
  mark('read frame');
  if (waking) {
    found = null;                                         // (one try per sighting)
    wake(waking, now);
  } else if (state !== 'show') look(now);
  if (state === 'armed' && now > armed.until && !(asking && asking.kind === 'read')) {   // nothing to wake: tap again
    state = 'idle'; armed = null; target = null; notice = { text: 'no figure', until: now + 2500 }; showPick();
  }
  if (state !== 'show') showStatus();
  if (pick.read && now - pick.read >= CARD_SHOWN_MS) { pick.read = 0; showPick(); }   // the card the camera read has had its moment in the corner

  mark('look');
  let scene = null;
  if (state === 'show' && !live.over) {
    const L = live;
    const ok = L.tracker.update(gray);
    mark('track');
    L.lost = ok ? 0 : L.lost + 1;
    let M = L.lock.refine(gray, pw, ph, L.tracker.H);     // reference frame → this frame
    // If the drawing has been found well away from where the tracker thinks it is (the
    // tracker lost its footing over a stall or a fast move), start the tracker afresh from
    // this frame, with the drawing where it really is.
    if (L.lock.held >= 0.6) {
      const a = apply(M, L.refAt.x, L.refAt.y), b = apply(L.tracker.H, L.refAt.x, L.refAt.y);
      if (Math.hypot(a.x - b.x, a.y - b.y) > 10) {
        L.stageToRef = multiply(M, L.stageToRef);
        L.lock.rebase(M);
        const hw = L.refSize.w / 2, hh = L.refSize.h / 2;
        L.tracker.reset(gray, { minX: Math.round(a.x - hw), minY: Math.round(a.y - hh), maxX: Math.round(a.x + hw), maxY: Math.round(a.y + hh) });
        L.refAt = a;
        M = [1, 0, 0, 0, 1, 0, 0, 0, 1];
      }
    }
    mark('ink lock');
    const H = multiply(M, L.stageToRef);                  // stage → this frame (tracker px)
    const Hpx = multiply(scaleTranslate(1, 0.5, 0.5), H);  // … as picture coordinates
    L.swatch.update(rgba, pw, ph, Hpx);
    L.eraser.paper = L.swatch.mean;
    mark('swatch');
    const t = (now - L.t0) / 1000;
    lctx.setTransform(1, 0, 0, 1, 0, 0);
    lctx.clearRect(0, 0, layer.width, layer.height);
    lctx.setTransform(L.layerScale, 0, 0, L.layerScale, 0, 0);
    L.show.draw(lctx, t, { eraser: L.eraser, swatch: L.swatch });
    if (params.get('debug') === '2') drawDebug(L, Hpx);
    mark('draw layer');
    // Stage ↔ video pixels (the analysed frame is the video scaled by procScale).
    const inv = invert(Hpx);
    if (inv) {
      scene = {
        toStage: normalised(multiply(inv, scaleTranslate(procScale, 0, 0))),
        fromStage: normalised(multiply(scaleTranslate(1 / procScale, 0, 0), Hpx)),
        stage: L.stage, erase: L.show.cover(t), gain: shiftGain(L, Hpx),
      };
    }
    L.H = Hpx; L.t = t; L.ok = ok;
    // A bad start (the drawing's lines not where the map says, in the first half second,
    // before anything has visibly happened): quietly find the figure and start again.
    L.slips = t < 0.5 && L.lock.held < 0.5 ? (L.slips || 0) + 1 : 0;
    if (L.slips >= 3 && (L.retries || 0) < 3) {
      const b = L.show.skel.bbox, c = apply(Hpx, b.midX, b.midY);
      armed = { card: L.card, until: now + 4000, retries: (L.retries || 0) + 1 };
      target = target || { x: c.x, y: c.y };
      live = null; state = 'armed'; scene = null; nextLookAt = 0;
    }
    // The show is over and the page is as it was: nothing more to follow or to draw.
    if (live && t > L.show.duration + 0.6) { L.over = true; scene = null; }
  }
  mark('misc');
  compositor.draw(video, vw, vh, layer, scene);
  mark('composite');
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
// ?perf keeps every frame's cost (ms) and time, for measuring smoothness (see __sticks.perf).
const PERF = params.has('perf') ? { cost: [], at: [], parts: {} } : null;
let markT = 0;
const mark = PERF ? (name) => { const t = performance.now(); if (name) PERF.parts[name] = (PERF.parts[name] || 0) + t - markT; markT = t; } : () => {};
function loop() {
  const t0 = performance.now();
  try { onFrame(); const dt = performance.now() - t0; cost += (dt - cost) * 0.05; if (PERF) { PERF.cost.push(dt); PERF.at.push(t0); } } catch (e) { console.error(e); if (DEBUG) debugEl.textContent = String(e.stack || e); }
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
  pick.touched = true;                                    // dialling by hand: the camera stops reading cards
  showPick();
});
window.addEventListener('pointerup', () => {
  if (!down) return;
  const wasTap = !down.moved, now = performance.now(), tapAt = { x: down.x, y: down.y };
  down = null;
  if (!wasTap) return;
  taps = taps.filter((t) => now - t < 600);
  taps.push(now);
  if (taps.length >= 3) { taps = []; reset(); return; }
  if (state !== 'idle') return;
  notice = null;
  if (pick.stage === 'value') { pick.stage = 'suit'; pick.touched = true; }
  else if (pick.stage === 'suit') pick.stage = 'ready';
  else {
    // The last tap — ON the figure, to say which drawing: count down in the corner, then
    // bring it to life.
    const card = { value: pick.value, suit: SUITS[pick.suit] };
    target = screenToFrame(tapAt.x, tapAt.y);
    nextLookAt = 0; urgent = true;                         // look at once, there
    if (COUNT_S > 0) { counting = { card, end: now + COUNT_S * 1000 }; state = 'counting'; }
    else { armed = { card, until: now + 4000 }; state = 'armed'; }
  }
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
  get seeing() { return { ...seeing }; },
  /// With ?perf: how the frames since the last call went — { frames, fps, median, p95, worst (ms of work per frame), longestGap (ms between frames) }.
  perf() {
    if (!PERF || PERF.cost.length < 2) return null;
    const c = PERF.cost.slice().sort((a, b) => a - b), n = c.length;
    let gap = 0;
    for (let i = 1; i < n; i++) gap = Math.max(gap, PERF.at[i] - PERF.at[i - 1]);
    const parts = {};
    for (const k in PERF.parts) { parts[k] = +(PERF.parts[k] / n).toFixed(1); PERF.parts[k] = 0; }
    const out = { parts, frames: n, fps: +((n - 1) * 1000 / (PERF.at[n - 1] - PERF.at[0])).toFixed(1), median: +c[n >> 1].toFixed(1), p95: +c[Math.floor(n * 0.95)].toFixed(1), worst: +c[n - 1].toFixed(1), longestGap: +gap.toFixed(0) };
    PERF.cost.length = 0; PERF.at.length = 0;
    return out;
  },
  /// A point in the analysis frame, on the screen (the reverse of screenToFrame).
  frameToScreen(x, y) {
    const v = compositor.view || { x0: 0, y0: 0, x1: 1, y1: 1 };
    return { x: (x / pw - v.x0) / (v.x1 - v.x0) * window.innerWidth, y: (y / ph - v.y0) / (v.y1 - v.y0) * window.innerHeight };
  },
  reset,
  NORM_H,
};
