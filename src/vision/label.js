// Reading a traced figure's anatomy from how its lines join up, and building the rig from
// that directly.
//
// The general rigger (src/rig/fitter.js) was made for drawings of any kind and has to guess
// what each stroke is from where it sits. A stick figure traced by ink.js says more than
// that: it is a head with lines hanging off it, and the way those lines connect IS the
// anatomy. From the head, follow the one line down that ends in two feet: where the routes
// to the two feet part is the hip; above it is the body, below it the legs. Whatever else
// branches off the body is an arm. Elbows and knees go at a line's bend, or halfway.
//
// Returns a rig in the shape src/rig/model.js describes, or null if the figure doesn't
// read this way (then the general rigger has a go). DOM-free.

import { P, rect } from '../rig/model.js';
import { smoothLine } from './ink.js';

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const pathLen = (pts) => { let s = 0; for (let i = 1; i < pts.length; i++) s += dist(pts[i], pts[i - 1]); return s; };

/// trace: from ink.js traceFigure (needs .graph and .headShape). The rig's points are the
/// trace's, shifted by (dx, dy).
export function labelFigure(trace, color, dx = 0, dy = 0) {
  const G = trace.graph, head = trace.headShape, wd = trace.width, pen = trace.penWidth || trace.width;
  const no = (why) => { labelFigure.why = why; return null; };
  if (!G || !head) return no('no head');
  let hx0 = 1e9, hy0 = 1e9, hx1 = -1e9, hy1 = -1e9;
  for (const p of head.loop) { hx0 = Math.min(hx0, p.x); hx1 = Math.max(hx1, p.x); hy0 = Math.min(hy0, p.y); hy1 = Math.max(hy1, p.y); }
  const hc = { x: head.cx, y: head.cy }, R = Math.max(hx1 - hx0, hy1 - hy0) / 2;
  const neckPt = { x: (hx0 + hx1) / 2, y: hy1 };

  // ---- The lines outside the head, as a graph. Lines are cut where they meet the head's
  // outline; the cut ends, round the lower part of the head, all join at the neck. ----
  const nodes = [{ x: neckPt.x, y: neckPt.y, adj: [] }];            // node 0: the neck
  const NECK = 0, byOrig = new Map(), edges = [], face = [];        // face: every line of the head itself, as drawn
  const nodeFor = (id) => { if (!byOrig.has(id)) { nodes.push({ x: G.nodes[id].x, y: G.nodes[id].y, adj: [] }); byOrig.set(id, nodes.length - 1); } return byOrig.get(id); };
  const addEdge = (a, b, pts, virtual = false) => { const e = { a, b, pts, len: virtual ? dist(pts[0], pts[pts.length - 1]) : pathLen(pts), virtual }; edges.push(e); nodes[a].adj.push(e); if (b !== a) nodes[b].adj.push(e); return e; };
  const cutNodes = [];
  for (const e of G.edges) {
    const cls = e.pts.map((p) => head.classify(p.x, p.y)), n = cls.length;
    for (let i = 0; i < n;) {
      let j = i;
      while (j + 1 < n && cls[j + 1] === cls[i]) j += 1;
      const run = e.pts.slice(i, j + 1);
      // The head's own lines — its outline and anything inside — are kept exactly as drawn
      // (running one point on, so they meet whatever continues from them).
      if (cls[i] !== 'outer') { const own = e.pts.slice(i, Math.min(n, j + 2)); if (own.length >= 2) face.push(own); }
      if (cls[i] === 'outer' && run.length >= 2) {
        // An end that reaches a real join keeps it; an end cut off by the head gets a node
        // of its own on the head's outline.
        const end = (atStart) => {
          const whole = atStart ? i === 0 : j === n - 1, orig = atStart ? e.a : e.b;
          if (whole && orig >= 0) return nodeFor(orig);
          const p = atStart ? run[0] : run[run.length - 1];
          nodes.push({ x: p.x, y: p.y, adj: [], cut: !whole });
          if (!whole) cutNodes.push(nodes.length - 1);
          return nodes.length - 1;
        };
        addEdge(end(true), end(false), run);
      }
      i = j + 1;
    }
  }
  if (!edges.length) return no('nothing but a head');
  // Cut ends on the lower part of the head are joined to the neck (hair, on top, is not).
  for (const k of cutNodes) if (nodes[k].y > hc.y - R * 0.25) addEdge(NECK, k, [neckPt, nodes[k]], true);
  if (!nodes[NECK].adj.length) {
    // A head that doesn't touch the body: join the neck to the nearest line end below it.
    let best = -1, bd = R * 1.6 + wd * 3;
    for (let k = 1; k < nodes.length; k++) { const d = dist(nodes[k], neckPt); if (d < bd && nodes[k].y > hc.y) { bd = d; best = k; } }
    if (best < 0) return no('nothing joins the head');
    addEdge(NECK, best, [neckPt, nodes[best]], true);
  }

  // ---- Bridge small gaps. People lift the pen: a leg that starts a little below the
  // body, an arm that stops short of it. A loose line end close to another group of lines
  // is joined to it (to its nearest point, which becomes a join). ----
  {
    const group = nodes.map((_, i) => i);
    const find = (i) => { while (group[i] !== i) { group[i] = group[group[i]]; i = group[i]; } return i; };
    for (const e of edges) group[find(e.a)] = find(e.b);
    const figH = Math.max(1, trace.box.maxY - hy0), tol = Math.max(wd * 3, figH * 0.07);
    // Every join or line end against every other group's lines; nearest gaps closed first.
    const gaps = [];
    for (let k = 1; k < nodes.length; k++) {
      let best = null;
      for (const f of edges) {
        if (f.virtual || find(f.a) === find(k)) continue;
        for (let i = 0; i < f.pts.length; i++) { const d = dist(f.pts[i], nodes[k]); if (d < tol && (!best || d < best.d)) best = { d, f, pt: f.pts[i] }; }
      }
      if (best) gaps.push({ k, ...best });
    }
    gaps.sort((p, q) => p.d - q.d);
    for (const { k, f, pt } of gaps) {
      if (find(f.a) === find(k)) continue;                           // already joined another way
      const i = f.pts.indexOf(pt);
      if (i < 0) continue;                                           // (that line was split since; the next look will do)
      let to;
      if (i <= 2) to = f.a; else if (i >= f.pts.length - 3) to = f.b;
      else {                                                         // split the line there
        nodes.push({ x: pt.x, y: pt.y, adj: [] });
        to = nodes.length - 1; group.push(find(f.a));
        const tail = f.pts.slice(i), oldB = f.b;
        nodes[oldB].adj = nodes[oldB].adj.filter((e) => e !== f);
        f.pts = f.pts.slice(0, i + 1); f.b = to; f.len = pathLen(f.pts); nodes[to].adj.push(f);
        addEdge(to, oldB, tail);
      }
      addEdge(k, to, [nodes[k], nodes[to]], true);
      group[find(k)] = find(to);
    }
  }

  // ---- Shortest routes from the neck to everywhere it reaches. ----
  const far = new Float64Array(nodes.length).fill(Infinity), via = new Array(nodes.length).fill(null);
  far[NECK] = 0;
  const open = new Set([NECK]);
  while (open.size) {
    let u = -1;
    for (const k of open) if (u < 0 || far[k] < far[u]) u = k;
    open.delete(u);
    for (const e of nodes[u].adj) {
      const v = e.a === u ? e.b : e.a;
      if (far[u] + e.len < far[v]) { far[v] = far[u] + e.len; via[v] = e; open.add(v); }
    }
  }
  const route = (k) => { const out = []; for (let v = k; via[v]; v = via[v].a === v ? via[v].b : via[v].a) out.unshift(via[v]); return out; };
  const reached = (e) => far[e.a] < Infinity;
  let maxY = hy1;
  for (const e of edges) if (reached(e) && !e.virtual) for (const p of e.pts) maxY = Math.max(maxY, p.y);
  const bodyH = maxY - neckPt.y;
  if (bodyH < R * 1.2) return no('too short below the head');
  if (R * 2 > (maxY - hy0) * 0.55) return no('head too big for the body');

  // ---- Feet → hip. The two line ends at the bottom whose routes from the neck part
  // lowest... no: part as legs do — below the top of the body, each leg a decent length. ----
  const leaves = [];
  for (let k = 1; k < nodes.length; k++) if (far[k] < Infinity && nodes[k].adj.length === 1 && nodes[k].y > maxY - (maxY - hy0) * 0.2) leaves.push(k);
  const spread = Math.max(wd * 1.5, bodyH * 0.12);
  let legs = null;
  for (let i = 0; i < leaves.length; i++) for (let j = i + 1; j < leaves.length; j++) {
    const a = leaves[i], b = leaves[j];
    if (Math.abs(nodes[a].x - nodes[b].x) < spread) continue;
    const ra = route(a), rb = route(b);
    let c = 0;
    while (c < ra.length && c < rb.length && ra[c] === rb[c]) c += 1;
    let hip = NECK;
    for (let q = 0; q < c; q++) hip = ra[q].a === hip ? ra[q].b : ra[q].a;
    const la = far[a] - far[hip], lb = far[b] - far[hip];
    if (nodes[hip].y < neckPt.y + bodyH * 0.2 || Math.min(la, lb) < bodyH * 0.15) continue;
    // Legs go DOWN from the hip: at least one clearly so, and neither upward. (One may kick
    // out sideways; a house's floor, both ways sideways, is not a pair of legs.)
    const downA = (nodes[a].y - nodes[hip].y) / la, downB = (nodes[b].y - nodes[hip].y) / lb;
    if (Math.max(downA, downB) < 0.5 || Math.min(downA, downB) < -0.1) continue;
    const score = Math.min(la, lb);
    if (!legs || score > legs.score) legs = { score, hip, torso: ra.slice(0, c), a: ra.slice(c), b: rb.slice(c), fa: a, fb: b };
  }
  if (!legs) return no('no two legs');

  // ---- A chain of edges as one line of points, from a starting node outward. Stretches
  // that only stand for a join to the neck are left out of what is drawn. ----
  const chainPts = (list, from) => {
    const pts = [];
    let at = from;
    for (const e of list) {
      const fwd = e.a === at;
      if (!e.virtual) { const run = fwd ? e.pts : e.pts.slice().reverse(); for (const p of run) if (!pts.length || pts[pts.length - 1].x !== p.x || pts[pts.length - 1].y !== p.y) pts.push(p); }
      at = fwd ? e.b : e.a;
    }
    return pts;
  };
  /// Where a limb bends: its sharpest corner in the middle stretch, else halfway.
  const bendAt = (pts) => {
    const L = pathLen(pts);
    if (pts.length < 3 || L < 1) return Math.max(1, pts.length >> 1);
    const a = pts[0], b = pts[pts.length - 1], cl = dist(a, b) || 1;
    let run = 0, best = -1, bestDev = L * 0.1, half = -1;
    for (let i = 1; i < pts.length - 1; i++) {
      run += dist(pts[i], pts[i - 1]);
      const f = run / L;
      if (half < 0 && f >= 0.5) half = i;
      if (f < 0.3 || f > 0.7) continue;
      const dev = Math.abs((b.x - a.x) * (a.y - pts[i].y) - (a.x - pts[i].x) * (b.y - a.y)) / cl;
      if (dev > bestDev) { bestDev = dev; best = i; }
    }
    return best > 0 ? best : Math.max(1, half);
  };

  const used = new Set([...legs.torso, ...legs.a, ...legs.b]);
  const onTorso = new Set([NECK]);
  { let at = NECK; for (const e of legs.torso) { at = e.a === at ? e.b : e.a; onTorso.add(at); } }
  const onLegs = new Map();                                        // node → 'a' | 'b'
  for (const side of ['a', 'b']) { let at = legs.hip; for (const e of legs[side]) { at = e.a === at ? e.b : e.a; onLegs.set(at, side); } }

  // ---- Everything else the neck reaches hangs off the body or a leg, in branches. ----
  const branches = [], seen = new Set();
  for (const e0 of edges) {
    if (used.has(e0) || seen.has(e0) || !reached(e0)) continue;
    const br = { edges: [], anchors: new Set() }, stack = [e0];
    seen.add(e0);
    while (stack.length) {
      const e = stack.pop();
      br.edges.push(e);
      for (const k of [e.a, e.b]) {
        if (onTorso.has(k) || onLegs.has(k)) { br.anchors.add(k); continue; }       // stop at the body
        for (const f of nodes[k].adj) if (!used.has(f) && !seen.has(f)) { seen.add(f); stack.push(f); }
      }
    }
    branches.push(br);
  }
  const arms = [], rigid = [];                                     // rigid: { pts, part }
  const stop = (k) => onTorso.has(k) || onLegs.has(k);
  /// The arm(s) in a set of edges hanging from `root`: the longest line out is an arm; a
  /// long side-line leaving it near its start is another arm (two arms sharing a stem);
  /// anything else on it is part of the hand end.
  const armsIn = (root, set) => {
    const d = new Map([[root, 0]]), back = new Map(), q = [root];
    while (q.length) {
      const u = q.shift();
      for (const e of nodes[u].adj) {
        if (!set.has(e)) continue;
        const v = e.a === u ? e.b : e.a;
        if (d.has(v) || (v !== root && stop(v))) continue;
        d.set(v, d.get(u) + (e.virtual ? 0 : e.len)); back.set(v, e); q.push(v);
      }
    }
    let tip = root;
    for (const [k, v] of d) if (v > d.get(tip)) tip = k;
    const chain = [], chainNodes = new Map([[root, 0]]);
    for (let v = tip; back.has(v); v = back.get(v).a === v ? back.get(v).b : back.get(v).a) { chain.unshift(back.get(v)); chainNodes.set(v, d.get(v)); }
    const len = d.get(tip), pts = chainPts(chain, root);
    if (!chain.length) {                                           // nothing leads anywhere (a closed loop: a fist, a button)
      for (const e of set) if (!e.virtual) rigid.push({ pts: e.pts, part: e.pts.every((p) => dist(p, hc) < R * 1.5) ? P.head : P.torso });
      return;
    }
    const rest = new Set([...set].filter((e) => !chain.includes(e)));
    const twigs = [];
    // Side-lines, grouped by where they leave the chain.
    const done = new Set();
    for (const e0 of rest) {
      if (done.has(e0)) continue;
      const sub = new Set(), stack = [e0];
      let at = null;
      done.add(e0);
      while (stack.length) {
        const e = stack.pop();
        sub.add(e);
        for (const k of [e.a, e.b]) {
          if (chainNodes.has(k)) { if (at === null || chainNodes.get(k) < chainNodes.get(at)) at = k; continue; }
          if (stop(k)) continue;
          for (const f of nodes[k].adj) if (rest.has(f) && !done.has(f)) { done.add(f); stack.push(f); }
        }
      }
      let subLen = 0;
      for (const e of sub) if (!e.virtual) subLen += e.len;
      if (at !== null && chainNodes.get(at) <= Math.max(bodyH * 0.15, len * 0.3) && subLen >= bodyH * 0.12) armsIn(at, sub);
      else for (const e of sub) if (!e.virtual) twigs.push(e);
    }
    const hugsHead = pts.every((p) => dist(p, hc) < R * 1.5);
    const inFeet = nodes[tip].y > maxY - bodyH * 0.12 && root === legs.hip;
    if (len >= bodyH * 0.12 && pts.length >= 3 && !inFeet && !hugsHead) arms.push({ pts, len, root, twigs });
    else for (const e of [...chain, ...twigs]) if (!e.virtual) rigid.push({ pts: e.pts, part: e.pts.every((p) => dist(p, hc) < R * 1.5) ? P.head : P.torso });
  };
  for (const br of branches) {
    const torsoAnchors = [...br.anchors].filter((k) => onTorso.has(k)).sort((p, q) => far[p] - far[q]);
    if (!torsoAnchors.length) {                                    // a twig on a leg (a foot, a toe)
      const side = onLegs.get([...br.anchors][0]);
      for (const e of br.edges) if (!e.virtual) rigid.push({ pts: e.pts, part: side ? `shin:${side}` : P.torso });
      continue;
    }
    armsIn(torsoAnchors[0], new Set(br.edges));
  }
  arms.sort((p, q) => q.len - p.len);
  for (const extra of arms.splice(2)) { rigid.push({ pts: extra.pts, part: P.torso }); for (const e of extra.twigs) rigid.push({ pts: e.pts, part: P.torso }); }
  if (!arms.length) return no('no arm');                           // a figure has an arm, at least

  // Which arm is which: by the side of the body its hand is on; two on one side are told
  // apart left to right.
  const hipPt = nodes[legs.hip];
  const axisX = (y) => neckPt.x + (hipPt.x - neckPt.x) * Math.max(0, Math.min(1.5, (y - neckPt.y) / Math.max(1, hipPt.y - neckPt.y)));
  const sideOf = (arm) => { const t = arm.pts[arm.pts.length - 1]; return t.x - axisX(t.y); };
  let left = null, right = null;
  if (arms.length === 2) { [left, right] = sideOf(arms[0]) <= sideOf(arms[1]) ? [arms[0], arms[1]] : [arms[1], arms[0]]; }
  else if (sideOf(arms[0]) <= 0) left = arms[0]; else right = arms[0];

  // ---- Strokes, with a body part for every point. Each limb's first point is its joint,
  // so nothing pulls apart when it turns. ----
  const strokes = [];
  const put = (raw, partAt) => {
    if (raw.length < 1) return null;
    const pts = raw.length === 1 ? [{ x: raw[0].x + 0.5, y: raw[0].y + 0.5 }, { x: raw[0].x + 0.5, y: raw[0].y + 0.5 }] : smoothLine(raw);
    const st = { points: pts.map((p) => ({ x: p.x + dx, y: p.y + dy })), parts: pts.map((_, i) => partAt(i, pts)), color, width: pen, rigid: false };
    strokes.push(st);
    return st;
  };
  const off = (p) => ({ x: p.x + dx, y: p.y + dy });
  // The head is drawn from its real lines, not from the tidy outline used to find it: a
  // head that is a spiral, an open loop or a wobbly potato stays one.
  for (const run of face) put(run, () => P.head);
  // On ruled paper, taking the rules out can nick the head's outline where a rule crossed
  // it. Small breaks like that (and only on ruled paper, and only small ones — a head left
  // open on purpose stays open) are mended from the head's found outline.
  if (trace.ruleAngle !== undefined) {
    const N = head.loop.length - 1, has = new Uint8Array(N);
    for (let k = 0; k < N; k++) { const q = head.loop[k]; has[k] = face.some((run) => run.some((p) => Math.abs(p.x + 0.5 - q.x) < wd && Math.abs(p.y + 0.5 - q.y) < wd)) ? 1 : 0; }
    for (let k = 0; k < N; k++) {
      if (has[k] || !has[(k - 1 + N) % N]) continue;                 // the start of a break
      let len = 0;
      while (len < N && !has[(k + len) % N]) len += 1;
      if (len <= 4) { const mend = []; for (let i = -1; i <= len; i++) { const q = head.loop[(k + i + N) % N]; mend.push({ x: q.x - 0.5, y: q.y - 0.5 }); } put(mend, () => P.head); }
    }
  }

  const torsoSt = put(chainPts(legs.torso, NECK), () => P.torso);
  const limb = (raw, upper, lower) => {
    const st = put(raw, () => upper);
    const k = bendAt(st.points);
    for (let i = k; i < st.parts.length; i++) st.parts[i] = lower;
    return { st, joint: st.points[0], bend: st.points[k], tip: st.points[st.points.length - 1] };
  };
  const [legL, legR] = nodes[legs.fa].x <= nodes[legs.fb].x ? ['a', 'b'] : ['b', 'a'];
  const LL = limb(chainPts(legs[legL], legs.hip), P.leftLeg, P.leftShin), RL = limb(chainPts(legs[legR], legs.hip), P.rightLeg, P.rightShin);
  const LA = left && limb(left.pts, P.leftArm, P.leftForearm), RA = right && limb(right.pts, P.rightArm, P.rightForearm);
  for (const [arm, fore] of [[left, P.leftForearm], [right, P.rightForearm]]) if (arm) for (const e of arm.twigs) put(e.pts, () => fore);   // hands, fingers
  for (const r of rigid) put(r.pts, () => (r.part === `shin:${legL}` ? P.leftShin : r.part === `shin:${legR}` ? P.rightShin : r.part));

  // What the neck doesn't reach: on or over the head (hair, a hat, ears) goes with the head;
  // anything else rides the body.
  const loose = (pts) => {
    let sx = 0, sy = 0;
    for (const p of pts) { sx += p.x; sy += p.y; }
    const c = { x: sx / pts.length, y: sy / pts.length };
    return dist(c, hc) < R * 2.2 && c.y < hy1 + R * 0.3 ? P.head : P.torso;
  };
  for (const e of edges) if (!reached(e) && !e.virtual) { const part = loose(e.pts); put(e.pts, () => part); }
  for (const ring of G.rings) {
    const part = ring.filter((p) => head.classify(p.x, p.y) !== 'outer').length > ring.length * 0.5 ? P.head : loose(ring);   // (the head itself, if it stands alone)
    put(ring, () => part);
  }
  for (const d of G.dots) { const part = head.classify(d.x, d.y) !== 'outer' ? P.head : loose([d]); put([d], () => part); }

  // ---- The skeleton the routine poses. ----
  const hip = torsoSt ? torsoSt.points[torsoSt.points.length - 1] : off({ x: hipPt.x + 0.5, y: hipPt.y + 0.5 });
  const neck = torsoSt ? torsoSt.points[0] : off(neckPt);
  const noArm = { joint: neck, bend: neck, tip: neck };
  const L = LA || noArm, Rr = RA || noArm;
  let bx0 = 1e9, by0 = 1e9, bx1 = -1e9, by1 = -1e9;
  for (const st of strokes) for (const p of st.points) { bx0 = Math.min(bx0, p.x); bx1 = Math.max(bx1, p.x); by0 = Math.min(by0, p.y); by1 = Math.max(by1, p.y); }
  const skeleton = {
    bbox: rect(bx0, by0, bx1 - bx0, by1 - by0),
    headCenter: off(hc), headRadius: R, neck,
    leftShoulder: L.joint, rightShoulder: Rr.joint, leftElbow: L.bend, rightElbow: Rr.bend, leftHand: L.tip, rightHand: Rr.tip,
    hipCenter: hip, leftHip: LL.joint, rightHip: RL.joint, leftKnee: LL.bend, rightKnee: RL.bend,
    feet: { x: (LL.tip.x + RL.tip.x) / 2, y: by1 },
    leftShinStraighten: 0, rightShinStraighten: 0,
  };
  return {
    strokes, skeleton, confidence: 1, articulated: true, demotions: [], headFound: true, labelled: true,
    leftHandPart: LA ? P.leftForearm : P.torso, rightHandPart: RA ? P.rightForearm : P.torso,
  };
}
