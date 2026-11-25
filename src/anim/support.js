// Easing and small helpers shared by the routine (from kafoosh/tiny's RoutineSupport port).

import { makePose } from '../rig/model.js';

export const TAU = Math.PI * 2;
export const lerp = (a, b, t) => a + (b - a) * t;
export const clamp01 = (x) => Math.min(Math.max(x, 0), 1);
/// Smoothstep on [0,1] — the default ease in and out.
export function smooth(x) { const t = clamp01(x); return t * t * (3 - 2 * t); }
/// Decelerating ease (fast → slow).
export function easeOut(x) { const t = clamp01(x); return 1 - (1 - t) * (1 - t); }
/// Accelerating ease (slow → fast).
export function easeIn(x) { const t = clamp01(x); return t * t; }
/// Overshoots a little past 1 and comes back: things popping into existence.
export function pop(x) { const t = clamp01(x); const s = 1.70158; const u = t - 1; return 1 + u * u * ((s + 1) * u + s); }

/// Normalised progress through a [start, end] window, clamped to 0…1.
export function phase(t, start, end) {
  if (!(end > start)) return t >= end ? 1 : 0;
  return clamp01((t - start) / (end - start));
}

/// The pose the figure was drawn in. (The rig's leg-straightening is deliberately not
/// applied here: this figure has to end exactly where the real drawing is.)
export function restPose() { return makePose(); }

/// Small repeatable random numbers.
export function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

/// `a` wrapped into (centre − π, centre + π].
export function wrapNear(a, centre = 0) {
  let d = (a - centre) % TAU;
  if (d > Math.PI) d -= TAU; else if (d <= -Math.PI) d += TAU;
  return centre + d;
}
