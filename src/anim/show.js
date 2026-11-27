// The routine: the drawing wakes up, waves, paces, thinks, has an idea, peels a piece out of
// the page beside it, turns it over, writes a playing card on its back, holds it up, turns
// it face-up again and pastes it back where it came from — so the card is now on the
// UNDERSIDE of the page — and walks home to stand exactly as it was drawn.
//
// Everything here is in STAGE coordinates (the flat page, figure ≈ 280 units tall, y down).
// `Show.draw(ctx, t, env)` paints one frame of the layer that the compositor lays onto the
// paper in the camera picture.

import { P, worldPoint, makePose } from '../rig/model.js';
import { TAU, lerp, smooth, easeOut, easeIn, pop, phase, rng, wrapNear } from './support.js';
import { drawCard } from './glyphs.js';

// The card is always written in black, whatever colour the figure was drawn in.
const CARD_INK = '#111111';

// When each beat starts (seconds). Each runs until the next.
const BEATS = [
  ['wake', 1.0], ['wave', 1.7], ['walkA', 1.0], ['walkB', 1.7], ['walkC', 1.0],
  ['think', 2.4], ['idea', 1.1], ['go', 1.3], ['reach', 0.5], ['tear', 1.7], ['pull', 0.7],
  ['flip1', 0.7], ['write', 2.6], ['present', 1.7], ['flip2', 0.7], ['paste', 0.8], ['pat', 0.9],
  ['home', 1.5], ['settle', 0.5],
];

export class Show {
  /// rig: a fitted figure in stage coordinates. stage: { w, h }. card: { value, suit }.
  /// side: +1 tears the piece from the page to the right of the figure, −1 from the left.
  /// place: where and how big — gap (from the figure's middle to the piece's near edge) and
  /// dy (up/down from shoulder height), both in figure heights, and scale (1 = full size).
  /// room: how far the figure may walk each way from where it stands ({ left, right }).
  constructor(rig, stage, { card, side = 1, ink = '#1c1b19', place = {}, room = {} }) {
    const { gap = 0.66, dy = 0, scale = 1 } = place, { left = Infinity, right = Infinity } = room;
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
    this.pw = this.Hf * 0.56 * scale; this.ph = this.Hf * 0.42 * scale;
    const margin = this.Hf * 0.08;
    let nearEdge = b.midX + side * this.Hf * gap;
    // Keep the whole piece on the stage.
    if (side > 0) nearEdge = Math.min(nearEdge, stage.w - margin - this.pw);
    else nearEdge = Math.max(nearEdge, margin + this.pw);
    const cy = Math.min(Math.max(near.S.y - this.Hf * 0.06 + dy * this.Hf, margin + this.ph / 2 + this.Hf * 0.14), stage.h - margin - this.ph / 2);
    this.slot = { x: nearEdge + side * this.pw / 2, y: cy };
    this.standDX = (nearEdge - side * reach * 0.55) - near.S.x;
    this.grab = { x: -side * this.pw * 0.40, y: -this.ph * 0.08 };   // on the piece, from its centre
    this.outline = tornOutline(this.pw, this.ph, 7);
    // To peel it out the hand takes the top corner nearest the figure, and the other hand
    // holds the page down beside the piece.
    this.gripAt = { x: -side * this.pw * 0.44, y: -this.ph * 0.44 };
    this.brace = { x: this.slot.x - side * (this.pw / 2 + this.Hf * 0.035), y: this.slot.y + this.ph * 0.4 };
    // Pacing, kept to the room there is.
    const within = (x) => Math.min(right, Math.max(-left, x));
    this.walkA = within(-side * this.Hf * 0.34);
    this.walkB = within(side * this.Hf * 0.26);
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

  /// How the piece comes out: PEELED. The paper comes up along a FOLD line that travels
  /// across the piece, slantwise from the top corner by the figure: beyond the fold it has
  /// torn free and stands up off the page, toward us, so we see it foreshortened across the
  /// fold; under it the hole is open. It goes steadily, with the slightest catch now and
  /// then, and the last corner snaps. Returns, for time t in the tear:
  ///   { px, py: a point on the fold line (from the slot's centre), nx, ny: unit normal, toward
  ///     the lifted side, k: how wide the lifted part looks across the fold (1 flat … 0 edge-on),
  ///     strain: how hard the figure is pulling (0…1), give: the recoil as the paper lets go (0…1) }
  fold(t) {
    const T = this.T, side = this.side, hw = this.pw / 2, hh = this.ph / 2, v = phase(t, T.tear[0], T.tear[1]);
    const dl = Math.hypot(0.5, 1), dx = side * 0.5 / dl, dy = 1 / dl, L = (Math.abs(dx) * this.pw + dy * this.ph) * 1.05;
    const w = v / 0.93, snap = phase(v, 0.93, 1);
    const sAt = v < 0.93 ? Math.max(0, w + 0.035 * Math.sin(w * TAU * 2.5)) * 0.86 : lerp(0.86, 1, easeIn(snap));
    const k = lerp(1, 0.42, smooth(phase(v, 0, 0.2))) + 0.04 * Math.sin(v * TAU * 2.5 + 1) * smooth(phase(v, 0.1, 0.3));
    return { px: -side * hw + dx * L * (sAt - 0.025), py: -hh + dy * L * (sAt - 0.025), nx: -dx, ny: -dy, k, strain: smooth(phase(v, 0, 0.2)) * (0.55 + 0.15 * Math.sin(w * TAU * 2.5 + 1.6)) * (1 - snap), give: Math.sin(snap * Math.PI) };
  }

  /// Where a point of the piece is seen once the paper beyond a fold has lifted.
  across(q, f) {
    const d = (q.x - f.px) * f.nx + (q.y - f.py) * f.ny;
    return d <= 0 ? { x: q.x, y: q.y } : { x: q.x - (1 - f.k) * d * f.nx, y: q.y - (1 - f.k) * d * f.ny };
  }

  /// Where the piece is and how it is turned at time t.
  /// { x, y, angle, scale, flip (−1…1, the cosine of the turn), back, state, lift,
  ///   fold (while tearing), bend (just torn, still bent), grip (where the hand has it) }
  /// state: 'page' (not torn yet) | 'tearing' | 'held' | 'pasted'
  piece(t) {
    const T = this.T, side = this.side, s = this.slot;
    const held = { x: s.x - side * this.Hf * 0.03, y: s.y - this.Hf * 0.10 };
    const o = { x: s.x, y: s.y, angle: 0, scale: 1, flip: 1, back: false, state: 'page', lift: 0 };
    // Where it first touches down when put back: a touch out of line, patted straight.
    const land = { x: s.x + side * this.pw * 0.025, y: s.y - this.ph * 0.02, angle: side * 0.03 };
    if (t < T.tear[0]) { o.grip = this.gripAt; return o; }
    if (t < T.pull[0]) {
      o.state = 'tearing';
      o.fold = this.fold(t); o.grip = this.across(this.gripAt, o.fold);
      return o;
    }
    if (t >= T.pat[0]) {
      o.state = 'pasted';
      o.settle = smooth(phase(t, T.pat[0], lerp(T.pat[0], T.pat[1], 0.55)));          // pressed into line
      o.x = lerp(land.x, s.x, o.settle); o.y = lerp(land.y, s.y, o.settle); o.angle = lerp(land.angle, 0, o.settle);
      return o;
    }
    o.state = 'held';
    const from = { x: s.x, y: s.y, angle: 0, lift: 0.45 };
    if (t < T.pull[1]) {
      // Just come away, still bent as it was torn: it springs flat, with a flutter, and the
      // hand shifts from the corner to its usual hold on the near edge.
      const end = this.fold(T.tear[1]), v = phase(t, T.pull[0], T.pull[1]), u = phase(v, 0, 0.7);
      const k = 1 - Math.abs((1 - end.k) * Math.exp(-4.5 * u) * Math.cos(u * 7.5)) * (1 - smooth(phase(u, 0.8, 1)));
      o.bend = { ...end, k };
      const g = this.across(this.gripAt, o.bend), m = smooth(phase(v, 0.15, 0.85));
      o.grip = { x: lerp(g.x, this.grab.x, m), y: lerp(g.y, this.grab.y, m) };
    }
    const out = easeOut(phase(t, T.pull[0], T.pull[1])), back = smooth(phase(t, T.paste[0], T.paste[1]));
    const up = out * (1 - back);
    const start = back > 0 ? land : from;
    o.lift = lerp(back > 0 ? 0 : from.lift, 1, up);
    o.x = lerp(start.x, held.x, up); o.y = lerp(start.y, held.y, up);
    o.angle = lerp(start.angle, -side * 0.07, up) + side * 0.08 * Math.sin(phase(t, T.pull[0], T.pull[1]) * Math.PI) * (1 - out);
    o.scale = 1 + 0.06 * up;
    // Turn over, write on the back, show it, turn face-up again (the writing now underneath).
    const turn = phase(t, T.flip1[0], T.flip1[1]) - phase(t, T.flip2[0], T.flip2[1]);   // 0 → 1 → 0
    o.flip = Math.cos(smooth(turn) * Math.PI);
    o.back = o.flip < 0;
    o.written = phase(t, T.write[0] + 0.25, T.write[1] - 0.2);
    if (t >= T.present[0] && t < T.present[1]) {       // held up to be read
      const u = phase(t, T.present[0], T.present[1]);
      const lift = smooth(phase(u, 0, 0.25)) * (1 - smooth(phase(u, 0.8, 1)));
      o.y -= this.Hf * 0.07 * lift; o.scale += 0.10 * lift; o.angle *= 1 - lift;
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
    const g0 = pc.grip || this.grab;
    const gx = g0.x * pc.scale * Math.max(Math.abs(pc.flip), 0.3), gy = g0.y * pc.scale;
    const ca = Math.cos(pc.angle), sa = Math.sin(pc.angle);
    const grab = { x: pc.x + gx * ca - gy * sa, y: pc.y + gx * sa + gy * ca };
    let hold = 1;
    if (inBeat('reach')) hold = smooth(u('reach'));
    if (inBeat('pat')) hold = 1 - smooth(phase(u('pat'), 0.75, 1));
    p.headAngle = side * 0.10 * hold;
    p.rootAngle = side * 0.04 * hold;
    if (inBeat('tear')) {
      // Leaning back into the pull as the strain builds, rocking forward when the paper gives;
      // the other hand holds the page down beside the piece.
      const v = u('tear'), f = pc.fold;
      p.rootAngle = side * 0.04 - side * 0.09 * f.strain + side * 0.05 * f.give;
      p.offset.x += -side * Hf * (0.022 * f.strain - 0.014 * f.give);
      p.scaleY *= 1 - 0.022 * f.strain; p.scaleX *= 1 + 0.012 * f.strain;
      p.headAngle = side * 0.14 - side * 0.05 * f.give;
      this.handTo(p, far, this.brace, smooth(phase(v, 0, 0.18)));
    }
    if (inBeat('pull')) {
      const v = u('pull');
      p.rootAngle = side * 0.04 - side * 0.10 * Math.sin(v * Math.PI);    // rocks back as it comes free
      p.offset.x += -side * Hf * 0.03 * Math.sin(v * Math.PI);
      this.handTo(p, far, this.brace, 1 - smooth(phase(v, 0, 0.5)));
    }
    if (inBeat('write')) {                             // the other hand writes across the back
      const v = u('write'), w = smooth(phase(v, 0, 0.1)) * (1 - smooth(phase(v, 0.92, 1)));
      const along = pc.written, jot = Math.sin(v * TAU * 11);
      this.handTo(p, far, { x: pc.x + lerp(-0.3, 0.3, along) * this.pw + jot * this.pw * 0.03, y: pc.y + (0.05 + 0.16 * Math.sin(v * TAU * 7.3)) * this.ph }, w);
      p.headAngle = side * 0.16 + 0.03 * jot;
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

  /// How fully the copy has taken over from the real ink at time t (0…1): in at the start,
  /// and back out at the end — once the figure is home it IS the drawing again, exactly.
  /// The compositor covers the real ink by this much; the copy is drawn at this opacity.
  cover(t) { return smooth(phase(t, 0, 0.22)) * (1 - smooth(phase(t, this.duration, this.duration + 0.35))); }

  /// Paint one frame. env: { eraser, swatch } (see stage/paper.js); either may be null.
  draw(ctx, t, env = {}) {
    const T = this.T;
    this.now = t;
    const fade = this.cover(t);

    const pose = this.pose(t), pc = this.piece(t);
    const paper = env.eraser?.paper || [236, 233, 226];

    if (pc.state === 'tearing') this.drawLifting(ctx, pc.fold, env, paper);
    if (pc.state === 'held') this.drawHole(ctx, paper, 1);
    if (pc.state === 'pasted') this.drawPasted(ctx, pc, env, paper);
    // Mid-turn the sheet passes in front of the figure; otherwise the hands are on top of it.
    const over = pc.state === 'held' && Math.abs(pc.flip) < 0.999;
    if (pc.state === 'held' && !over) this.drawPiece(ctx, pc, env, paper);
    ctx.save();
    ctx.globalAlpha = fade;
    this.drawFigure(ctx, pose);
    ctx.restore();
    if (over) this.drawPiece(ctx, pc, env, paper);

    this.drawThoughts(ctx, t, pose);
  }

  /// The figure in a pose. With the drawing's own ink to hand (rig.sprites: a picture per
  /// body part, see inkparts.js) that is what shows, each part's picture moved as the part
  /// moves — so the copy has every blob, stub and thick-and-thin of the real thing. The
  /// traced lines go underneath, slimmer, to keep it whole where a joint bends open or the
  /// ink had a nick in it. Without the ink, the lines alone.
  drawFigure(ctx, pose) {
    const rig = this.rig, slim = rig.sprites ? 0.4 : 1;
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    for (const stroke of rig.strokes) {
      if (stroke.points.length < 2) continue;
      ctx.beginPath();
      for (let i = 0; i < stroke.points.length; i++) {
        const w = worldPoint(rig, stroke.points[i], stroke.parts[i], pose);
        if (i === 0) ctx.moveTo(w.x, w.y); else ctx.lineTo(w.x, w.y);
      }
      ctx.strokeStyle = stroke.color;
      ctx.lineWidth = stroke.width * slim;
      ctx.stroke();
    }
    if (!rig.sprites) return;
    ctx.imageSmoothingEnabled = true;
    for (const sp of rig.sprites) {
      // (A part moves as a whole — turned, squashed, shifted — so three of its points place its picture.)
      const o = worldPoint(rig, { x: sp.x, y: sp.y }, sp.part, pose), ax = worldPoint(rig, { x: sp.x + 1, y: sp.y }, sp.part, pose), ay = worldPoint(rig, { x: sp.x, y: sp.y + 1 }, sp.part, pose);
      ctx.save();
      ctx.transform(ax.x - o.x, ax.y - o.y, ay.x - o.x, ay.y - o.y, o.x, o.y);
      ctx.drawImage(sp.canvas, 0, 0);
      ctx.restore();
    }
  }

  outlinePath(ctx) {
    ctx.beginPath();
    this.outline.forEach((q, i) => { if (i) ctx.lineTo(q.x, q.y); else ctx.moveTo(q.x, q.y); });
    ctx.closePath();
  }

  /// Stroke a run of the outline with a varying width (each point's `rim` × `scale`).
  rimStroke(ctx, idx, scale, color, inset = 0) {
    ctx.strokeStyle = color; ctx.lineCap = 'round';
    for (let k = 1; k < idx.length; k++) {
      const a = this.outline[idx[k - 1]], b = this.outline[idx[k]];
      ctx.lineWidth = (a.rim + b.rim) * 0.5 * scale;
      ctx.beginPath();
      ctx.moveTo(a.x - a.nx * inset, a.y - a.ny * inset);
      ctx.lineTo(b.x - b.nx * inset, b.y - b.ny * inset);
      ctx.stroke();
    }
  }

  rgb(c, k = 1, add = 0, a = 1) {
    const f = (v) => Math.max(0, Math.min(255, v * k + add)) | 0;
    return `rgba(${f(c[0])},${f(c[1])},${f(c[2])},${a})`;
  }

  /// Torn paper shows a fluffy white band where the surface layer came away, and a fine
  /// dark crack where the two sides part.
  tornEdge(ctx, idx, paper, strength = 1, side = 'page') {
    if (idx.length < 2) return;
    ctx.save();
    ctx.lineJoin = 'round';
    this.rimStroke(ctx, idx, side === 'page' ? 1.6 : 1.9, this.rgb(paper, 0.45, 150, 0.85 * strength), side === 'page' ? -0.4 : 0.5);
    this.rimStroke(ctx, idx, 0.6, this.rgb(paper, 0.45, 160, 0.9 * strength), side === 'page' ? -1.0 : 1.1);
    ctx.lineWidth = 0.6; ctx.strokeStyle = `rgba(30,26,20,${0.35 * strength})`;
    ctx.beginPath();
    idx.forEach((i, k) => { const q = this.outline[i]; if (k) ctx.lineTo(q.x, q.y); else ctx.moveTo(q.x, q.y); });
    ctx.stroke();
    if (side === 'piece') {                            // loose fibres standing off the edge
      ctx.lineWidth = 0.45; ctx.strokeStyle = this.rgb(paper, 0.4, 165, 0.7 * strength);
      ctx.beginPath();
      for (let k = 0; k < idx.length; k += 7) {
        const q = this.outline[idx[k]], len = 0.8 + q.rim * 1.1, tw = ((idx[k] * 37) % 7 - 3) * 0.12;
        ctx.moveTo(q.x, q.y);
        ctx.lineTo(q.x + (q.nx + q.ny * tw) * len, q.y + (q.ny - q.nx * tw) * len);
      }
      ctx.stroke();
    }
    ctx.restore();
  }

  /// What is left behind: a step down to the sheet beneath, in its own shadow along the
  /// upper edges, with the page's torn rim round it. `amount` fades it (0…1).
  drawHole(ctx, paper, amount, clip = null) {
    if (amount <= 0) return;
    ctx.save();
    ctx.translate(this.slot.x, this.slot.y);
    if (clip) { ctx.beginPath(); clip.forEach((q, k) => { if (k) ctx.lineTo(q.x, q.y); else ctx.moveTo(q.x, q.y); }); ctx.closePath(); ctx.clip(); }
    ctx.globalAlpha = amount;
    ctx.save();
    this.outlinePath(ctx);
    ctx.clip();
    ctx.fillStyle = this.rgb(paper, 0.86);
    ctx.fillRect(-this.pw, -this.ph, this.pw * 2, this.ph * 2);
    // Inner shadow: the page's cut edge shades the sheet below, most from the top-left light.
    ctx.beginPath();
    ctx.rect(-this.pw * 2, -this.ph * 2, this.pw * 4, this.ph * 4);
    this.outline.forEach((q, i) => { if (i) ctx.lineTo(q.x, q.y); else ctx.moveTo(q.x, q.y); });
    ctx.closePath();
    ctx.shadowColor = 'rgba(0,0,0,0.55)'; ctx.shadowBlur = 5; ctx.shadowOffsetX = 1.6; ctx.shadowOffsetY = 2.6;
    ctx.fillStyle = '#000';
    ctx.fill('evenodd');
    ctx.restore();
    this.tornEdge(ctx, this.outline.map((_, i) => i).concat([0]), paper, 1, 'page');
    ctx.restore();
  }

  /// The canvas transform that shows paper beyond fold `f` lifted: squeezed across the fold.
  foldTransform(ctx, f) {
    const a = 1 + (f.k - 1) * f.nx * f.nx, b = (f.k - 1) * f.nx * f.ny, d = 1 + (f.k - 1) * f.ny * f.ny;
    ctx.transform(a, b, b, d, f.px - (a * f.px + b * f.py), f.py - (b * f.px + d * f.py));
  }
  /// Light on lifted paper: in shade where it turns up out of the page, catching the light
  /// toward its free edge. (Drawn inside a clip of the lifted part, before the fold transform
  /// or within it alike: it runs from the fold outward.)
  foldShade(ctx, f) {
    const lift = 1 - Math.abs(f.k), far = this.pw + this.ph;
    if (lift < 0.02) return;
    const g = ctx.createLinearGradient(f.px, f.py, f.px + f.nx * far * 0.6, f.py + f.ny * far * 0.6);
    g.addColorStop(0, `rgba(0,0,0,${0.26 * lift})`);
    g.addColorStop(0.12, `rgba(0,0,0,${0.10 * lift})`);
    g.addColorStop(0.45, `rgba(255,255,255,${0.10 * lift})`);
    g.addColorStop(1, `rgba(255,255,255,${0.20 * lift})`);
    ctx.fillStyle = g;
    ctx.fillRect(-far, -far, far * 2, far * 2);
  }

  /// The peel in progress (see `fold`): the hole where the paper has come up, the page's torn rim
  /// round it, the lifted paper standing over it in its own shadow, and the crease.
  drawLifting(ctx, f, env, paper) {
    const o = this.outline, n = o.length, sd = (q) => (q.x - f.px) * f.nx + (q.y - f.py) * f.ny;
    if (f.k > 0.995) return;
    // The lifted part of the outline, as a shape, and where the fold crosses the outline.
    const part = [], ends = [];
    for (let i = 0; i < n; i++) {
      const a = o[i], b = o[(i + 1) % n], da = sd(a), db = sd(b);
      if (da >= 0) part.push(a);
      if ((da >= 0) !== (db >= 0)) { const t = da / (da - db), c = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }; part.push(c); ends.push(c); }
    }
    if (part.length < 3) return;
    const big = (this.pw + this.ph) * 2, tx = -f.ny * big, ty = f.nx * big;
    this.drawHole(ctx, paper, 1, [{ x: f.px + tx, y: f.py + ty }, { x: f.px - tx, y: f.py - ty }, { x: f.px - tx + f.nx * big, y: f.py - ty + f.ny * big }, { x: f.px + tx + f.nx * big, y: f.py + ty + f.ny * big }]);
    const lift = 1 - Math.abs(f.k);
    ctx.save();
    ctx.translate(this.slot.x, this.slot.y);
    ctx.save();
    this.foldTransform(ctx, f);
    const path = () => { ctx.beginPath(); part.forEach((q, i) => { if (i) ctx.lineTo(q.x, q.y); else ctx.moveTo(q.x, q.y); }); ctx.closePath(); };
    ctx.save();
    ctx.shadowColor = `rgba(0,0,0,${0.22 + 0.26 * lift})`; ctx.shadowBlur = 2 + 13 * lift; ctx.shadowOffsetX = 1 + 4 * lift; ctx.shadowOffsetY = 1.5 + 9 * lift;
    path(); ctx.fillStyle = this.rgb(paper); ctx.fill();
    ctx.restore();
    ctx.save();
    path(); ctx.clip();
    if (env.swatch) { ctx.imageSmoothingEnabled = true; ctx.drawImage(env.swatch.canvas, 0.5, 0.5, env.swatch.w - 1, env.swatch.h - 1, -this.pw / 2 - 2, -this.ph / 2 - 2, this.pw + 4, this.ph + 4); }
    this.foldShade(ctx, f);
    ctx.restore();
    // Its torn edge: only where it has actually come away from the page.
    let start = 0;
    while (start < n && sd(o[start]) > 0) start += 1;
    for (let c = 0, run = []; c <= n; c++) {
      const i = (start + c) % n;
      if (c < n && sd(o[i]) > 0) run.push(i);
      else { if (run.length > 1) this.tornEdge(ctx, run, paper, 1, 'piece'); run = []; }
    }
    ctx.restore();
    // The crease, where the paper turns up out of the page.
    if (ends.length >= 2) {
      const a = ends[0], b = ends[ends.length - 1];
      ctx.lineCap = 'round';
      ctx.strokeStyle = `rgba(0,0,0,${0.30 * lift})`; ctx.lineWidth = 1.3;
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      ctx.strokeStyle = this.rgb(paper, 0.5, 150, 0.55 * lift); ctx.lineWidth = 0.8;
      ctx.beginPath(); ctx.moveTo(a.x + f.nx * 1.3, a.y + f.ny * 1.3); ctx.lineTo(b.x + f.nx * 1.3, b.y + f.ny * 1.3); ctx.stroke();
    }
    ctx.restore();
  }

  /// The loose piece: the page's own colour (sampled live).
  drawPiece(ctx, pc, env, paper) {
    const fx = Math.max(Math.abs(pc.flip), 0.02);
    ctx.save();
    ctx.translate(pc.x, pc.y);
    ctx.rotate(pc.angle);
    ctx.scale(pc.scale * fx, pc.scale);
    if (pc.bend) this.foldTransform(ctx, pc.bend);          // still bent as it was torn (see `piece`)
    // Its shadow on the page: tight while it lies close, soft and offset when lifted.
    ctx.save();
    ctx.shadowColor = `rgba(0,0,0,${0.18 + 0.22 * pc.lift})`;
    ctx.shadowBlur = 1.5 + 13 * pc.lift; ctx.shadowOffsetX = 0.8 + 3 * pc.lift; ctx.shadowOffsetY = 1.2 + 8 * pc.lift;
    this.outlinePath(ctx);
    ctx.fillStyle = this.rgb(paper);
    ctx.fill();
    ctx.restore();
    ctx.save();
    this.outlinePath(ctx);
    ctx.clip();
    if (env.swatch) {
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(env.swatch.canvas, 0.5, 0.5, env.swatch.w - 1, env.swatch.h - 1, -this.pw / 2 - 2, -this.ph / 2 - 2, this.pw + 4, this.ph + 4);
    }
    // Held up, a sheet bows a little and catches the light unevenly.
    if (pc.lift > 0.01) {
      const g = ctx.createLinearGradient(-this.pw / 2, -this.ph / 2, this.pw / 2, this.ph / 2);
      g.addColorStop(0, `rgba(255,255,255,${0.10 * pc.lift})`);
      g.addColorStop(0.55, 'rgba(255,255,255,0)');
      g.addColorStop(1, `rgba(0,0,0,${0.10 * pc.lift})`);
      ctx.fillStyle = g;
      ctx.fillRect(-this.pw, -this.ph, this.pw * 2, this.ph * 2);
    }
    if (pc.bend) this.foldShade(ctx, pc.bend);
    if (pc.back) { ctx.fillStyle = 'rgba(90,86,78,0.08)'; ctx.fillRect(-this.pw, -this.ph, this.pw * 2, this.ph * 2); }
    // Shading across the turn, so it reads as a sheet going round.
    const edge = 1 - Math.abs(pc.flip);
    if (edge > 0.01) { ctx.fillStyle = `rgba(0,0,0,${0.30 * edge})`; ctx.fillRect(-this.pw, -this.ph, this.pw * 2, this.ph * 2); }
    // The card is on the BACK.
    if (pc.back && pc.written > 0) drawCard(ctx, this.card, 0, 0, this.ph * 0.52, CARD_INK, this.lw * 1.05, pc.written);
    ctx.restore();
    this.tornEdge(ctx, this.outline.map((_, i) => i).concat([0]), paper, 1, 'piece');
    ctx.restore();
  }

  /// Back in the page, writing side down. It lands a touch out of line and is patted
  /// straight; then the loose paper gives way to the real page, and the seam fades out
  /// while the figure walks home, so the page ends exactly as it started.
  drawPasted(ctx, pc, env, paper) {
    const settle = pc.settle ?? 1;
    const gone = smooth(phase(this.now, this.T.pat[1], this.T.pat[1] + 0.8));       // overlay paper → real page
    const all = this.outline.map((_, i) => i).concat([0]);
    if (settle < 1) this.drawHole(ctx, paper, 1 - smooth(phase(settle, 0.6, 1)));
    if (gone < 1) {
      ctx.save();
      ctx.globalAlpha = 1 - gone;
      this.drawPiece(ctx, { ...pc, scale: 1, flip: 1, back: false, lift: 0, written: 0 }, env, paper);
      ctx.restore();
    }
    // The mend: a fine crack with a little torn fibre either side.
    const fade = 1 - smooth(phase(this.now, this.T.pat[1], this.T.home[1]));
    if (fade <= 0) return;
    ctx.save();
    ctx.translate(this.slot.x, this.slot.y);
    ctx.globalAlpha = gone;
    this.tornEdge(ctx, all, paper, fade * 0.8, 'page');
    ctx.restore();
  }

  /// A thought: bubbles rising from the head to a "?" that rocks while the figure wonders;
  /// when the idea comes the "?" darts over the head and becomes a lightbulb.
  drawThoughts(ctx, t, pose) {
    const T = this.T, side = this.side, k = this.skel;
    const r = Math.min(Math.max(k.headRadius, this.Hf * 0.07), this.Hf * 0.16);
    ctx.save();
    ctx.strokeStyle = this.ink; ctx.fillStyle = this.ink;
    ctx.lineWidth = this.lw * 0.9; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    const head = this.head(pose);
    const bulbS = r * 0.62, bulb = { x: head.x, y: head.y - r - bulbS * 2.3 };
    const from = T.think[0] + 0.3;
    if (t >= from && t < T.idea[0] + 0.22) {
      const v = phase(t, from, T.think[1]);
      const gone = 1 - smooth(phase(v, 0.88, 1));
      for (let i = 0; i < 3; i++) {                    // the bubbles, small to large, up and away
        const a = pop(phase(v, i * 0.13, i * 0.13 + 0.12)) * gone;
        if (a <= 0) continue;
        const x = head.x - side * r * (0.75 + i * 0.42), y = head.y - r * (1.2 + i * 0.5);
        ctx.beginPath();
        ctx.arc(x, y + Math.sin(t * 3 + i) * 1.2, this.lw * (0.6 + i * 0.3) * a, 0, TAU);
        ctx.fill();
      }
      const a = pop(phase(v, 0.40, 0.52));             // …and the "?" they lead to
      if (a > 0) {
        const h = r * 0.8, since = t - (from + 0.40 * (T.think[1] - from));
        const at = { x: head.x - side * r * 2.2, y: head.y - r * 3.25 + Math.sin(t * 3) * 1.2 };
        const m = smooth(phase(t, T.idea[0], T.idea[0] + 0.22));       // got it: off to become the bulb
        this.question(ctx, lerp(at.x, bulb.x, m), lerp(at.y, bulb.y, m), h * a * (1 - 0.75 * m),
          0.22 * Math.sin(since * 5.2) * (1 - m) - side * m * 0.9, 1 - smooth(phase(m, 0.6, 1)));
      }
    }
    if (t >= T.idea[0] && t < T.go[0] + 0.3) {
      const a = pop(phase(t, T.idea[0] + 0.12, T.idea[0] + 0.36)) * (1 - smooth(phase(t, T.go[0], T.go[0] + 0.3)));
      if (a > 0) {
        const s = bulbS * a, cx = bulb.x, cy = head.y - r - s * 2.3;
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

  /// A pen-drawn "?" centred on (x, y), `h` from its middle to its top, leaning by `tilt`.
  question(ctx, x, y, h, tilt, alpha = 1) {
    if (h <= 0 || alpha <= 0) return;
    ctx.save();
    ctx.globalAlpha *= alpha;
    ctx.translate(x, y); ctx.rotate(tilt);
    ctx.beginPath();
    ctx.arc(0, -h * 0.45, h * 0.5, Math.PI * 1.05, Math.PI * 2.3);
    ctx.bezierCurveTo(h * 0.12, h * 0.08, 0, h * 0.12, 0, h * 0.42);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(0, h * 0.86, Math.max(this.lw * 0.6, h * 0.09), 0, TAU);
    ctx.fill();
    ctx.restore();
  }
}

/// A hand-torn, roughly four-sided outline centred on the origin: [{x, y, rim, nx, ny}],
/// closed. Corners are a little off square; each edge wanders gently (the tear drifting as
/// it goes) with finer raggedness on top. `rim` is how wide the white fibrous band along
/// the torn edge is at that point, and (nx, ny) is the outward normal.
function tornOutline(w, h, seed) {
  const rnd = rng(seed), m = Math.min(w, h), hw = w / 2, hh = h / 2;
  const j = () => (rnd() - 0.5) * m * 0.10;
  const corners = [
    { x: -hw + j(), y: -hh + j() }, { x: hw + j(), y: -hh + j() },
    { x: hw + j(), y: hh + j() }, { x: -hw + j(), y: hh + j() },
  ];
  const pts = [];
  for (let e = 0; e < 4; e++) {
    const A = corners[e], B = corners[(e + 1) % 4];
    const len = Math.hypot(B.x - A.x, B.y - A.y), n = Math.max(8, Math.round(len / 1.6));
    const nx = (B.y - A.y) / len, ny = -(B.x - A.x) / len;          // outward (clockwise order)
    const waves = [
      { a: m * 0.030, f: 0.6 + rnd() * 0.8, p: rnd() * TAU },
      { a: m * 0.012, f: 2.5 + rnd() * 2, p: rnd() * TAU },
      { a: m * 0.006, f: 7 + rnd() * 5, p: rnd() * TAU },
    ];
    const rimWaves = [{ f: 1.5 + rnd() * 2, p: rnd() * TAU }, { f: 6 + rnd() * 6, p: rnd() * TAU }];
    for (let i = 0; i < n; i++) {
      const f = i / n, taper = Math.sin(Math.PI * f);
      let d = 0;
      for (const w_ of waves) d += w_.a * Math.sin(TAU * w_.f * f + w_.p);
      d = d * taper + (rnd() - 0.5) * 0.9;                            // fibre-scale fuzz
      const rim = Math.max(0.3, 1.3 + 0.9 * Math.sin(TAU * rimWaves[0].f * f + rimWaves[0].p) + 0.5 * Math.sin(TAU * rimWaves[1].f * f + rimWaves[1].p));
      pts.push({ x: A.x + (B.x - A.x) * f + nx * d, y: A.y + (B.y - A.y) * f + ny * d, rim, nx, ny });
    }
  }
  return pts;
}
