// The routine: the drawing wakes up, waves, paces, thinks, has an idea, tears a piece out of
// the page beside it, turns it over, writes on it, turns it back to show a playing card,
// pastes it back where it came from, and walks home to stand exactly as it was drawn.
//
// Everything here is in STAGE coordinates (the flat page, figure ≈ 280 units tall, y down).
// `Show.draw(ctx, t, env)` paints one frame of the layer that the compositor lays onto the
// paper in the camera picture.

import { P, worldPoint, makePose } from '../rig/model.js';
import { TAU, lerp, smooth, easeOut, easeIn, pop, phase, rng, wrapNear } from './support.js';
import { drawCard } from './glyphs.js';

// When each beat starts (seconds). Each runs until the next.
const BEATS = [
  ['wake', 1.0], ['wave', 1.7], ['walkA', 1.0], ['walkB', 1.7], ['walkC', 1.0],
  ['think', 2.4], ['idea', 1.1], ['go', 1.3], ['reach', 0.5], ['tear', 1.7], ['pull', 0.7],
  ['flip1', 0.7], ['write', 2.4], ['flip2', 0.7], ['present', 1.6], ['paste', 0.8], ['pat', 0.9],
  ['home', 1.5], ['settle', 0.5],
];

export class Show {
  /// rig: a fitted figure in stage coordinates. stage: { w, h }. card: { value, suit }.
  /// side: +1 tears the piece from the page to the right of the figure, −1 from the left.
  constructor(rig, stage, { card, side = 1, ink = '#1c1b19' }) {
    this.rig = rig; this.stage = stage; this.card = card; this.side = side; this.ink = ink;
    const k = this.skel = rig.skeleton, b = k.bbox;
    this.Hf = b.height;
    this.lw = Math.max(2, rig.strokes.reduce((a, s) => a + s.width, 0) / Math.max(1, rig.strokes.length));

    this.T = {};
    let t = 0;
    for (const [name, len] of BEATS) { this.T[name] = [t, t + len]; t += len; }
    this.duration = t;

    // Arms. `near` is the one on the piece's side. An arm the rig could not articulate
    // (hand riding the torso) is left alone and the props simply follow its hand.
    this.arms = { left: this.armInfo(true), right: this.armInfo(false) };
    this.nearLeft = side < 0;
    const near = this.arms[this.nearLeft ? 'left' : 'right'];

    // The piece of paper: where it is torn from, and where the figure stands to do it.
    const reach = near.ok ? near.L1 + near.L2 : this.Hf * 0.3;
    this.pw = this.Hf * 0.56; this.ph = this.Hf * 0.42;
    const margin = this.Hf * 0.08;
    let nearEdge = b.midX + side * this.Hf * 0.66;
    // Keep the whole piece on the stage.
    if (side > 0) nearEdge = Math.min(nearEdge, stage.w - margin - this.pw);
    else nearEdge = Math.max(nearEdge, margin + this.pw);
    const cy = Math.min(Math.max(near.S.y - this.Hf * 0.06, margin + this.ph / 2 + this.Hf * 0.14), stage.h - margin - this.ph / 2);
    this.slot = { x: nearEdge + side * this.pw / 2, y: cy };
    this.standDX = (nearEdge - side * reach * 0.55) - near.S.x;
    this.grab = { x: -side * this.pw * 0.40, y: -this.ph * 0.08 };   // on the piece, from its centre
    this.outline = tornOutline(this.pw, this.ph, 7);
    this.walkA = -side * this.Hf * 0.34;
    this.walkB = side * this.Hf * 0.26;
  }

  armInfo(left) {
    const k = this.skel;
    const S = left ? k.leftShoulder : k.rightShoulder, E = left ? k.leftElbow : k.rightElbow, Hd = left ? k.leftHand : k.rightHand;
    const L1 = Math.hypot(E.x - S.x, E.y - S.y), L2 = Math.hypot(Hd.x - E.x, Hd.y - E.y);
    const part = left ? this.rig.leftHandPart : this.rig.rightHandPart;
    return {
      left, S, E, Hd, L1, L2,
      a1: Math.atan2(E.y - S.y, E.x - S.x), a2: Math.atan2(Hd.y - E.y, Hd.x - E.x),
      rest: Math.atan2(Hd.y - S.y, Hd.x - S.x),
      ok: this.rig.articulated && part !== P.torso && L1 > 4 && L2 > 4,
    };
  }

  /// Swing a whole arm to point along screen angle `abs` (0 = right, π/2 = down), with the
  /// forearm curled by `bend`; `w` blends from the drawn pose.
  armTo(p, left, abs, bend = 0, w = 1) {
    const a = this.arms[left ? 'left' : 'right'];
    const d = wrapNear(abs - a.rest, left ? -0.6 : 0.6) * w;
    if (left) { p.leftArmAngle = d; p.leftForearmAngle = bend * w; }
    else { p.rightArmAngle = d; p.rightForearmAngle = bend * w; }
  }

  /// Put a hand ON a stage point (two-bone reach; the elbow droops). `w` blends.
  handTo(p, left, target, w = 1) {
    const a = this.arms[left ? 'left' : 'right'];
    if (!a.ok || w <= 0) return;
    // Undo the body's own move so the target is in the coordinates the arm was drawn in.
    const k = this.skel;
    let x = target.x - p.offset.x, y = target.y - p.offset.y;
    if (p.rootAngle) {
      const c = Math.cos(-p.rootAngle), s = Math.sin(-p.rootAngle), dx = x - k.hipCenter.x, dy = y - k.hipCenter.y;
      x = k.hipCenter.x + dx * c - dy * s; y = k.hipCenter.y + dx * s + dy * c;
    }
    x = k.feet.x + (x - k.feet.x) / p.scaleX; y = k.feet.y + (y - k.feet.y) / p.scaleY;
    const dx = x - a.S.x, dy = y - a.S.y;
    const d = Math.min(Math.max(Math.hypot(dx, dy), Math.abs(a.L1 - a.L2) + 1), a.L1 + a.L2 - 0.5);
    const base = Math.atan2(dy, dx);
    const cos = (a.L1 * a.L1 + d * d - a.L2 * a.L2) / (2 * a.L1 * d);
    const phi = Math.acos(Math.min(1, Math.max(-1, cos)));
    const upper = base + (Math.cos(base) >= 0 ? 1 : -1) * phi;
    const ex = a.S.x + a.L1 * Math.cos(upper), ey = a.S.y + a.L1 * Math.sin(upper);
    const tx = a.S.x + d * Math.cos(base), ty = a.S.y + d * Math.sin(base);
    const fore = Math.atan2(ty - ey, tx - ex);
    const bias = left ? -0.6 : 0.6;
    const arm = wrapNear(upper - a.a1, bias);
    const forearm = wrapNear(fore - a.a2 - arm, 0);
    if (left) { p.leftArmAngle = lerp(p.leftArmAngle, arm, w); p.leftForearmAngle = lerp(p.leftForearmAngle, forearm, w); }
    else { p.rightArmAngle = lerp(p.rightArmAngle, arm, w); p.rightForearmAngle = lerp(p.rightForearmAngle, forearm, w); }
  }

  hand(pose, left) {
    const k = this.skel;
    return worldPoint(this.rig, left ? k.leftHand : k.rightHand, left ? this.rig.leftHandPart : this.rig.rightHandPart, pose);
  }
  head(pose) { return worldPoint(this.rig, this.skel.headCenter, P.head, pose); }

  /// Walk from offset x0 to x1 over [t0, t1].
  walk(p, t, t0, t1, x0, x1) {
    const u = phase(t, t0, t1), dist = Math.abs(x1 - x0);
    const steps = Math.max(1, Math.round(dist / (this.Hf * 0.17)));
    const ramp = smooth(phase(u, 0, 0.15)) * (1 - smooth(phase(u, 0.85, 1)));
    const s = Math.sin(Math.PI * steps * u);
    p.offset.x = lerp(x0, x1, smooth(u));
    p.offset.y -= this.Hf * 0.022 * Math.abs(s) * ramp;
    p.leftLegAngle = 0.36 * ramp * s; p.rightLegAngle = -0.36 * ramp * s;
    p.leftShinAngle = 0.25 * ramp * Math.max(0, -s); p.rightShinAngle = 0.25 * ramp * Math.max(0, s);
    p.leftArmAngle = -0.3 * ramp * s; p.rightArmAngle = 0.3 * ramp * s;
    p.rootAngle = Math.sign(x1 - x0) * 0.05 * ramp;
  }

  /// Where the piece is and how it is turned at time t.
  /// { x, y, angle, scale, flip (−1…1, the cosine of the turn), back, state }
  /// state: 'page' (not torn yet) | 'tearing' | 'held' | 'pasted'
  piece(t) {
    const T = this.T, side = this.side, s = this.slot;
    const held = { x: s.x - side * this.Hf * 0.03, y: s.y - this.Hf * 0.10 };
    const o = { x: s.x, y: s.y, angle: 0, scale: 1, flip: 1, back: false, state: 'page', tear: 0, lift: 0 };
    if (t < T.tear[0]) return o;
    if (t < T.pull[0]) {
      o.state = 'tearing'; o.tear = smooth(phase(t, T.tear[0], T.tear[1] - 0.15));
      const tug = Math.sin(phase(t, T.tear[0], T.tear[1]) * TAU * 4);
      o.x += -side * 1.2 * tug * o.tear; o.angle = -side * 0.012 * tug * o.tear;
      return o;
    }
    if (t >= T.pat[0]) { o.state = 'pasted'; o.settle = phase(t, T.pat[0], T.pat[0] + 0.5); return o; }
    o.state = 'held'; o.tear = 1;
    const out = easeOut(phase(t, T.pull[0], T.pull[1])), back = smooth(phase(t, T.paste[0], T.paste[1]));
    const m = out * (1 - back);
    o.lift = m;
    o.x = lerp(s.x, held.x, m); o.y = lerp(s.y, held.y, m);
    o.angle = -side * 0.07 * m + side * 0.10 * Math.sin(phase(t, T.pull[0], T.pull[1]) * Math.PI) * (1 - out);
    o.scale = 1 + 0.06 * m;
    // Turn over, write on the far side, turn back.
    const turn = phase(t, T.flip1[0], T.flip1[1]) - phase(t, T.flip2[0], T.flip2[1]);   // 0 → 1 → 0
    o.flip = Math.cos(smooth(turn) * Math.PI);
    o.back = o.flip < 0;
    if (t >= T.write[0] && t < T.write[1]) {
      const w = phase(t, T.write[0], T.write[1]);
      o.x += Math.sin(w * TAU * 9) * 0.9; o.y += Math.cos(w * TAU * 7) * 0.7;
    }
    if (t >= T.present[0] && t < T.paste[0]) {         // held up to be read
      const u = phase(t, T.present[0], T.present[1]);
      const up = smooth(phase(u, 0, 0.25)) * (1 - smooth(phase(u, 0.8, 1)));
      o.y -= this.Hf * 0.07 * up; o.scale += 0.10 * up; o.angle *= 1 - up;
    }
    return o;
  }

  /// The figure's pose at time t (and, via `piece`, the hands on the paper).
  pose(t) {
    const T = this.T, side = this.side, Hf = this.Hf, near = this.nearLeft, far = !this.nearLeft;
    const p = makePose();
    const breathe = (amt = 1) => {
      const b = Math.sin(TAU * t / 2.2);
      p.scaleY *= 1 + 0.012 * b * amt; p.scaleX *= 1 - 0.006 * b * amt;
    };
    if (t >= this.duration) return p;                  // back as drawn
    const inBeat = (n) => t >= T[n][0] && t < T[n][1];
    const u = (n) => phase(t, T[n][0], T[n][1]);

    if (inBeat('wake')) {                              // a stretch and a look around
      const v = u('wake');
      const st = Math.sin(smooth(phase(v, 0.1, 0.7)) * Math.PI);
      p.scaleY = 1 + 0.07 * st; p.scaleX = 1 - 0.04 * st;
      p.leftArmAngle = 0.5 * st; p.rightArmAngle = -0.5 * st;
      p.headAngle = 0.22 * Math.sin(phase(v, 0.45, 1) * TAU);
      return p;
    }
    if (inBeat('wave')) {
      const v = u('wave');
      const w = easeOut(phase(v, 0, 0.2)) * (1 - easeIn(phase(v, 0.85, 1)));
      const left = !near;                              // wave with the arm away from the piece
      const out = left ? -1 : 1;                       // turning this way swings the arm away from the head
      const up = left ? Math.PI + 0.5 : -0.5;          // up and out
      const flap = Math.sin(TAU * 3.2 * v);
      this.armTo(p, left, up + out * 0.18 * flap, out * (-0.55 + 0.45 * flap), w);
      p.offset.y -= Hf * 0.035 * Math.sin(phase(v, 0.05, 0.3) * Math.PI);
      p.headAngle = (left ? -1 : 1) * 0.12 * w;
      breathe();
      return p;
    }
    if (inBeat('walkA')) { this.walk(p, t, ...T.walkA, 0, this.walkA); return p; }
    if (inBeat('walkB')) { this.walk(p, t, ...T.walkB, this.walkA, this.walkB); return p; }
    if (inBeat('walkC')) { this.walk(p, t, ...T.walkC, this.walkB, 0); return p; }
    if (inBeat('think')) {                             // hand to chin, tapping a foot
      const v = u('think');
      const w = smooth(phase(v, 0, 0.18)) * (1 - smooth(phase(v, 0.9, 1)));
      const chin = { x: this.skel.headCenter.x + side * this.skel.headRadius * 0.5, y: this.skel.headCenter.y + this.skel.headRadius * 1.05 };
      this.handTo(p, near, chin, w);
      p.headAngle = -side * 0.16 * w + 0.03 * Math.sin(TAU * 1.2 * v * 2.4);
      const tap = Math.max(0, Math.sin(TAU * 3 * v));
      if (near) p.rightLegAngle = -0.10 * tap * w; else p.leftLegAngle = 0.10 * tap * w;
      p.rootAngle = -side * 0.03 * w;
      breathe();
      return p;
    }
    if (inBeat('idea')) {                              // jump, finger in the air
      const v = u('idea');
      const j = Math.sin(phase(v, 0.05, 0.5) * Math.PI);
      const crouch = Math.sin(phase(v, 0, 0.12) * Math.PI) + Math.sin(phase(v, 0.5, 0.65) * Math.PI);
      p.offset.y -= Hf * 0.10 * j;
      p.scaleY = 1 + 0.05 * j - 0.07 * crouch; p.scaleX = 1 - 0.03 * j + 0.05 * crouch;
      const w = easeOut(phase(v, 0, 0.2)) * (1 - smooth(phase(v, 0.8, 1)));
      this.armTo(p, near, near ? Math.PI + 1.35 : -1.35, 0, w);
      p.headAngle = side * 0.08 * w;
      return p;
    }
    if (inBeat('go')) { this.walk(p, t, ...T.go, 0, this.standDX); return p; }
    if (inBeat('home')) {
      this.walk(p, t, ...T.home, this.standDX, 0);
      return p;
    }
    if (inBeat('settle')) return p;

    // ---- At the paper: reach … pat. The near hand stays on the piece throughout. ----
    p.offset.x = this.standDX;
    const pc = this.piece(t);
    // The hand keeps hold of the near edge, which swings in toward the middle as the piece turns.
    const gx = this.grab.x * pc.scale * Math.max(Math.abs(pc.flip), 0.3), gy = this.grab.y * pc.scale;
    const ca = Math.cos(pc.angle), sa = Math.sin(pc.angle);
    const grab = { x: pc.x + gx * ca - gy * sa, y: pc.y + gx * sa + gy * ca };
    let hold = 1;
    if (inBeat('reach')) hold = smooth(u('reach'));
    if (inBeat('pat')) hold = 1 - smooth(phase(u('pat'), 0.75, 1));
    p.headAngle = side * 0.10 * hold;
    p.rootAngle = side * 0.04 * hold;
    if (inBeat('tear')) {
      const v = u('tear'), tug = Math.sin(v * TAU * 4);
      p.rootAngle = side * 0.04 - side * 0.05 * tug * smooth(phase(v, 0, 0.2));
      p.offset.x += -side * Hf * 0.012 * tug;
      this.handTo(p, far, { x: grab.x + side * this.pw * 0.05, y: grab.y + this.ph * 0.3 }, smooth(phase(v, 0, 0.25)));
    }
    if (inBeat('pull')) {
      const v = u('pull');
      p.rootAngle = side * 0.04 - side * 0.10 * Math.sin(v * Math.PI);    // rocks back as it comes free
      p.offset.x += -side * Hf * 0.03 * Math.sin(v * Math.PI);
      this.handTo(p, far, { x: grab.x + side * this.pw * 0.05, y: grab.y + this.ph * 0.3 }, 1 - smooth(v));
    }
    if (inBeat('write')) {                             // the other hand scribbles behind it
      const v = u('write'), w = smooth(phase(v, 0, 0.12)) * (1 - smooth(phase(v, 0.9, 1)));
      const sx = Math.sin(v * TAU * 6.5) * this.pw * 0.16 + (v - 0.5) * this.pw * 0.2;
      const sy = Math.sin(v * TAU * 9 + 1) * this.ph * 0.13;
      this.handTo(p, far, { x: pc.x - side * this.pw * 0.12 + sx, y: pc.y + sy }, w);
      p.headAngle = side * 0.16 + 0.04 * Math.sin(v * TAU * 6.5);
    }
    if (inBeat('present')) {
      const v = u('present');
      const up = smooth(phase(v, 0, 0.25)) * (1 - smooth(phase(v, 0.8, 1)));
      p.headAngle = side * 0.10 - side * 0.2 * up;       // looks out at us
      p.offset.y -= Hf * 0.03 * Math.abs(Math.sin(phase(v, 0.15, 0.6) * TAU)) * up;
      this.armTo(p, far, far ? Math.PI + 0.9 : -0.9, 0, up * 0.8);
    }
    if (inBeat('pat')) {                               // two pats to stick it down
      const v = u('pat');
      const down = Math.abs(Math.sin(phase(v, 0, 0.7) * TAU));
      const w = 1 - smooth(phase(v, 0.75, 1));
      this.handTo(p, far, { x: pc.x - side * this.pw * 0.05, y: pc.y + this.ph * 0.1 - this.Hf * 0.03 * (1 - down) }, w * smooth(phase(v, 0, 0.15)));
    }
    this.handTo(p, near, grab, hold);
    return p;
  }

  // -------------------------------------------------------------------------------------

  /// Paint one frame. env: { eraser, swatch } (see stage/paper.js); either may be null.
  draw(ctx, t, env = {}) {
    const T = this.T;
    this.now = t;
    // The copy takes over from the real ink at the start, and hands back to it at the end:
    // once the figure is home it IS the drawing again, exactly, with nothing to drift.
    const fade = smooth(phase(t, 0, 0.22)) * (1 - smooth(phase(t, this.duration, this.duration + 0.35)));
    env.eraser?.draw(ctx, fade);

    const pose = this.pose(t), pc = this.piece(t);
    const paper = env.eraser ? env.eraser.paper : [236, 233, 226];

    if (pc.state === 'tearing') this.drawTear(ctx, pc);
    if (pc.state === 'held') this.drawHole(ctx, paper);
    if (pc.state === 'pasted') this.drawPasted(ctx, pc, env, paper);
    const over = pc.state === 'held' && (pc.back || Math.abs(pc.flip) < 0.999);
    if (pc.state === 'held' && !over) this.drawPiece(ctx, pc, env, paper);
    ctx.save();
    ctx.globalAlpha = fade;
    this.drawFigure(ctx, pose);
    ctx.restore();
    if (over) this.drawPiece(ctx, pc, env, paper);

    this.drawThoughts(ctx, t, pose);
    if (t >= T.write[0] && t < T.write[1]) this.drawScribbling(ctx, t, pc);
  }

  drawFigure(ctx, pose) {
    const rig = this.rig;
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    for (const stroke of rig.strokes) {
      if (stroke.points.length < 2) continue;
      ctx.beginPath();
      for (let i = 0; i < stroke.points.length; i++) {
        const w = worldPoint(rig, stroke.points[i], stroke.parts[i], pose);
        if (i === 0) ctx.moveTo(w.x, w.y); else ctx.lineTo(w.x, w.y);
      }
      ctx.strokeStyle = stroke.color;
      ctx.lineWidth = stroke.width;
      ctx.stroke();
    }
  }

  outlinePath(ctx) {
    ctx.beginPath();
    this.outline.forEach((q, i) => { if (i) ctx.lineTo(q.x, q.y); else ctx.moveTo(q.x, q.y); });
    ctx.closePath();
  }

  /// The rip working its way round the piece, starting at the corner being held.
  drawTear(ctx, pc) {
    const n = this.outline.length, upto = Math.floor(pc.tear * n);
    if (upto < 2) return;
    // Start at the point nearest the grab corner, and run both ways round from it.
    let start = 0, best = 1e9;
    this.outline.forEach((q, i) => { const d = Math.hypot(q.x - this.grab.x * 1.25, q.y + this.ph / 2); if (d < best) { best = d; start = i; } });
    ctx.save();
    ctx.translate(this.slot.x, this.slot.y);
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    for (const [color, width, dx] of [['rgba(0,0,0,0.5)', 1.6, 0], ['rgba(255,255,255,0.55)', 1.1, 1.1]]) {
      ctx.strokeStyle = color; ctx.lineWidth = width;
      for (const dir of [1, -1]) {
        ctx.beginPath();
        for (let i = 0; i <= upto / 2; i++) {
          const q = this.outline[((start + dir * i) % n + n) % n];
          if (i) ctx.lineTo(q.x + dx, q.y + dx); else ctx.moveTo(q.x + dx, q.y + dx);
        }
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  /// What is left behind: the page is one layer thinner there, in shadow at the top edge.
  drawHole(ctx, paper) {
    ctx.save();
    ctx.translate(this.slot.x, this.slot.y);
    this.outlinePath(ctx);
    const [r, g, b] = paper;
    ctx.fillStyle = `rgb(${r * 0.42 | 0},${g * 0.41 | 0},${b * 0.40 | 0})`;
    ctx.fill();
    ctx.clip();
    const grad = ctx.createLinearGradient(0, -this.ph / 2, 0, -this.ph / 2 + this.ph * 0.35);
    grad.addColorStop(0, 'rgba(0,0,0,0.5)'); grad.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = grad;
    ctx.fillRect(-this.pw, -this.ph, this.pw * 2, this.ph * 2);
    const g2 = ctx.createLinearGradient(-this.pw / 2, 0, -this.pw / 2 + this.pw * 0.2, 0);
    g2.addColorStop(0, 'rgba(0,0,0,0.35)'); g2.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g2;
    ctx.fillRect(-this.pw, -this.ph, this.pw * 2, this.ph * 2);
    ctx.restore();
    ctx.save();
    ctx.translate(this.slot.x, this.slot.y);
    this.outlinePath(ctx);
    ctx.strokeStyle = 'rgba(255,255,255,0.5)'; ctx.lineWidth = 1.4; ctx.lineJoin = 'round';
    ctx.stroke();
    ctx.restore();
  }

  /// The loose piece: the page's own colour (sampled live), its back a shade greyer.
  drawPiece(ctx, pc, env, paper) {
    const fx = Math.max(Math.abs(pc.flip), 0.02);
    ctx.save();
    ctx.translate(pc.x, pc.y);
    ctx.rotate(pc.angle);
    ctx.scale(pc.scale * fx, pc.scale);
    // Shadow on the page beneath it.
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.38)';
    ctx.shadowBlur = 5 + 12 * pc.lift; ctx.shadowOffsetX = 3 * pc.lift; ctx.shadowOffsetY = 3 + 7 * pc.lift;
    this.outlinePath(ctx);
    ctx.fillStyle = `rgb(${paper[0] | 0},${paper[1] | 0},${paper[2] | 0})`;
    ctx.fill();
    ctx.restore();
    ctx.save();
    this.outlinePath(ctx);
    ctx.clip();
    if (env.swatch) {
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(env.swatch.canvas, 0.5, 0.5, env.swatch.w - 1, env.swatch.h - 1, -this.pw / 2 - 2, -this.ph / 2 - 2, this.pw + 4, this.ph + 4);
    }
    // Lit a little brighter for being lifted off the page; the back is duller.
    ctx.fillStyle = pc.back ? 'rgba(96,92,84,0.20)' : `rgba(255,255,255,${0.10 * pc.lift})`;
    ctx.fillRect(-this.pw, -this.ph, this.pw * 2, this.ph * 2);
    // Shading across the turn, so it reads as a sheet going round.
    const edge = 1 - Math.abs(pc.flip);
    if (edge > 0.01) { ctx.fillStyle = `rgba(0,0,0,${0.28 * edge})`; ctx.fillRect(-this.pw, -this.ph, this.pw * 2, this.ph * 2); }
    ctx.restore();
    this.outlinePath(ctx);
    ctx.strokeStyle = 'rgba(60,56,50,0.35)'; ctx.lineWidth = 1; ctx.lineJoin = 'round';
    ctx.stroke();
    const written = pc.state === 'held' && !pc.back && this.written;
    if (written) drawCard(ctx, this.card, 0, 0, this.ph * 0.52, this.ink, this.lw * 1.05);
    ctx.restore();
  }

  /// Back in the page: the writing stays, the seam heals to a faint line.
  drawPasted(ctx, pc, env, paper) {
    const u = pc.settle ?? 1;
    ctx.save();
    ctx.translate(this.slot.x, this.slot.y);
    if (u < 1) {                                       // the piece's own paper fades into the page
      ctx.save();
      ctx.globalAlpha = 1 - smooth(u);
      this.outlinePath(ctx);
      ctx.clip();
      if (env.swatch) ctx.drawImage(env.swatch.canvas, 0.5, 0.5, env.swatch.w - 1, env.swatch.h - 1, -this.pw / 2 - 2, -this.ph / 2 - 2, this.pw + 4, this.ph + 4);
      else { ctx.fillStyle = `rgb(${paper[0] | 0},${paper[1] | 0},${paper[2] | 0})`; ctx.fillRect(-this.pw, -this.ph, this.pw * 2, this.ph * 2); }
      ctx.restore();
    }
    this.outlinePath(ctx);
    ctx.strokeStyle = `rgba(40,36,30,${lerp(0.45, 0.13, smooth(u))})`; ctx.lineWidth = 1.1; ctx.lineJoin = 'round';
    ctx.stroke();
    drawCard(ctx, this.card, 0, 0, this.ph * 0.52, this.ink, this.lw * 1.05);
    ctx.restore();
  }

  /// "…" while thinking, then a lightbulb.
  drawThoughts(ctx, t, pose) {
    const T = this.T, side = this.side, k = this.skel, r = Math.max(k.headRadius, this.Hf * 0.07);
    ctx.save();
    ctx.strokeStyle = this.ink; ctx.fillStyle = this.ink;
    ctx.lineWidth = this.lw * 0.9; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    const head = this.head(pose);
    if (t >= T.think[0] + 0.3 && t < T.think[1]) {
      const v = phase(t, T.think[0] + 0.3, T.think[1]);
      const gone = 1 - smooth(phase(v, 0.9, 1));
      for (let i = 0; i < 3; i++) {
        const a = pop(phase(v, i * 0.2, i * 0.2 + 0.14)) * gone;
        if (a <= 0) continue;
        const x = head.x - side * (r * 0.9 + i * r * 0.62), y = head.y - r * 1.25 - i * r * 0.5;
        ctx.beginPath();
        ctx.arc(x, y + Math.sin(t * 3 + i) * 1.2, this.lw * (0.7 + i * 0.35) * a, 0, TAU);
        ctx.fill();
      }
    }
    if (t >= T.idea[0] && t < T.go[0] + 0.3) {
      const a = pop(phase(t, T.idea[0] + 0.08, T.idea[0] + 0.32)) * (1 - smooth(phase(t, T.go[0], T.go[0] + 0.3)));
      if (a > 0) {
        const s = r * 0.62 * a, cx = head.x, cy = head.y - r - s * 2.3;
        ctx.beginPath();                               // the bulb
        ctx.arc(cx, cy, s, Math.PI * 0.72, Math.PI * 2.28);
        ctx.lineTo(cx + s * 0.38, cy + s * 1.25); ctx.lineTo(cx - s * 0.38, cy + s * 1.25);
        ctx.closePath();
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(cx - s * 0.3, cy + s * 1.55); ctx.lineTo(cx + s * 0.3, cy + s * 1.55);
        ctx.stroke();
        const flick = 0.75 + 0.25 * Math.sin(t * 18);
        for (let i = 0; i < 7; i++) {                  // rays
          const ang = Math.PI * (1 + i / 6);
          ctx.beginPath();
          ctx.moveTo(cx + Math.cos(ang) * s * 1.45, cy + Math.sin(ang) * s * 1.45);
          ctx.lineTo(cx + Math.cos(ang) * s * (1.45 + 0.6 * flick), cy + Math.sin(ang) * s * (1.45 + 0.6 * flick));
          ctx.stroke();
        }
      }
    }
    ctx.restore();
  }

  /// Little marks flying off the paper while it's written on.
  drawScribbling(ctx, t, pc) {
    const v = phase(t, this.T.write[0], this.T.write[1]);
    const w = smooth(phase(v, 0.08, 0.2)) * (1 - smooth(phase(v, 0.85, 1)));
    if (w <= 0) return;
    ctx.save();
    ctx.strokeStyle = this.ink; ctx.lineWidth = this.lw * 0.7; ctx.lineCap = 'round';
    ctx.globalAlpha = 0.8 * w;
    const beat = Math.floor(t * 7);
    const rnd = rng(beat * 977 + 13);
    for (let i = 0; i < 3; i++) {
      const a = -Math.PI * (0.2 + 0.6 * rnd()), r0 = Math.max(this.pw, this.ph) * 0.55, r1 = r0 + this.Hf * (0.03 + 0.03 * rnd());
      ctx.beginPath();
      ctx.moveTo(pc.x + Math.cos(a) * r0, pc.y + Math.sin(a) * r0 * 0.8);
      ctx.lineTo(pc.x + Math.cos(a) * r1, pc.y + Math.sin(a) * r1 * 0.8);
      ctx.stroke();
    }
    ctx.restore();
  }

  /// Has the card been written yet (so the front of the piece shows it)?
  get written() { return this.now >= this.T.write[1] - 0.01; }
}

/// A ragged, roughly rectangular outline centred on the origin: [{x, y}], closed.
function tornOutline(w, h, seed) {
  const rnd = rng(seed), pts = [];
  const r = Math.min(w, h) * 0.07, hw = w / 2, hh = h / 2;
  const side = (x0, y0, x1, y1) => {
    const len = Math.hypot(x1 - x0, y1 - y0), n = Math.max(4, Math.round(len / 5));
    const nx = (y1 - y0) / len, ny = -(x1 - x0) / len;
    for (let i = 0; i < n; i++) {
      const f = i / n, j = (rnd() - 0.5) * 3.2 + (rnd() < 0.12 ? (rnd() - 0.5) * 6 : 0);
      pts.push({ x: x0 + (x1 - x0) * f + nx * j, y: y0 + (y1 - y0) * f + ny * j });
    }
  };
  const corner = (cx, cy, a0) => {
    for (let i = 0; i < 4; i++) { const a = a0 + (Math.PI / 2) * (i / 4); pts.push({ x: cx + Math.cos(a) * r + (rnd() - 0.5) * 1.5, y: cy + Math.sin(a) * r + (rnd() - 0.5) * 1.5 }); }
  };
  side(-hw + r, -hh, hw - r, -hh); corner(hw - r, -hh + r, -Math.PI / 2);
  side(hw, -hh + r, hw, hh - r); corner(hw - r, hh - r, 0);
  side(hw - r, hh, -hw + r, hh); corner(-hw + r, hh - r, Math.PI / 2);
  side(-hw, hh - r, -hw, -hh + r); corner(-hw + r, -hh + r, Math.PI);
  return pts;
}
