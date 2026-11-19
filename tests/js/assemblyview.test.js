/* The geometry behind the assembly storyboard (app/static/js/assemblyview.js). */
const assert = require('assert');
const { AssemblyView: A } = require('../../app/static/js/assemblyview.js');

const L = 600;
const near = (a, b, eps, what) => assert.ok(Math.abs(a - b) <= eps, `${what}: ${a} vs ${b}`);

// Straight at t = 0: the strip lies along y = 0, centred, and keeps its length.
const flat = [0, L / 3, L].map((s) => A.bendPoint(s, L, 0));
assert.deepStrictEqual(flat.map((p) => p.y), [0, 0, 0], 'a flat strip has no rise');
near(flat[2].x - flat[0].x, L, 1e-6, 'a flat strip is as long as the parts');
assert.deepStrictEqual(flat.map((p) => p.a), [0, 0, 0], 'nothing has turned yet');

// Closed at t = 1: the two ends meet, and every point is the same distance from the centre.
const ends = [A.bendPoint(0, L, 1), A.bendPoint(L, L, 1)];
near(Math.hypot(ends[0].x - ends[1].x, ends[0].y - ends[1].y), 0, 1e-6, 'the ring closes');
const R = L / (2 * Math.PI);
for (const s of [0, 37, L / 4, L / 2, (3 * L) / 4, L]) {
  const p = A.bendPoint(s, L, 1);
  near(Math.hypot(p.x - 0, p.y - R), R, 1e-6, `s=${s} sits on the ring`);
  near(p.a, (2 * Math.PI * s) / L, 1e-9, `s=${s} has turned the right amount`);
}

// Part way: still a circle, just a bigger one, and the strip never changes length.
const len = (t, n = 2000) => {
  let d = 0;
  for (let i = 0; i < n; i++) {
    const p = A.bendPoint((L * i) / n, L, t);
    const q = A.bendPoint((L * (i + 1)) / n, L, t);
    d += Math.hypot(q.x - p.x, q.y - p.y);
  }
  return d;
};
for (const t of [0, 0.25, 0.5, 0.9, 1]) near(len(t), L, 0.01, `the strip keeps its length at t=${t}`);

// The bend is smooth: no jump between a tiny curvature and dead straight.
near(Math.hypot(A.bendPoint(L, L, 0).x - A.bendPoint(L, L, 1e-5).x,
  A.bendPoint(L, L, 0).y - A.bendPoint(L, L, 1e-5).y), 0, 0.05, 'no jump as the bend starts');

// arc() walks from one end of a span to the other.
const pts = A.arc(100, 250, L, 0.5);
near(pts[0].x, A.bendPoint(100, L, 0.5).x, 1e-9, 'the span starts where it should');
near(pts[pts.length - 1].x, A.bendPoint(250, L, 0.5).x, 1e-9, 'and ends where it should');
assert.ok(pts.length >= 25, 'enough points to look smooth');

// fit() puts everything inside the box, with the padding kept clear, and stays centred.
for (const t of [0, 0.3, 1]) {
  const all = A.arc(0, L, L, t);
  const { scale, dx, dy } = A.fit(all, 440, 230, 20);
  const xs = all.map((p) => p.x * scale + dx);
  const ys = all.map((p) => p.y * scale + dy);
  assert.ok(Math.min(...xs) >= 19.9 && Math.max(...xs) <= 420.1, `t=${t}: inside left and right`);
  assert.ok(Math.min(...ys) >= 19.9 && Math.max(...ys) <= 210.1, `t=${t}: inside top and bottom`);
  near((Math.min(...xs) + Math.max(...xs)) / 2, 220, 0.5, `t=${t}: centred across`);
}

console.log('assemblyview.test.js: ok');

// Parts stand apart before they come together, and sit flush once they have.
const three = [{ name: 'a', length: 300 }, { name: 'b', length: 500 }, { name: 'c', length: 200 }];
const closed = A.spans(three, 0);
assert.strictEqual(closed.gap, 0, 'no gap once they have come together');
assert.strictEqual(closed.total, 1000, 'the strip is just the parts');
assert.deepStrictEqual(closed.spans.map((s) => [s.from, s.to]), [[0, 300], [300, 800], [800, 1000]], 'flush, in order');

const open = A.spans(three, 0.6);
assert.ok(open.gap > 0, 'a gap while they are apart');
// Each part keeps its own length however far apart they stand.
assert.deepStrictEqual(open.spans.map((s) => s.to - s.from), [300, 500, 200], 'lengths are unchanged');
// The gaps are equal, and one follows each part so a ring spaces them evenly.
const gaps = open.spans.slice(1).map((s, i) => s.from - open.spans[i].to);
gaps.forEach((g) => near(g, open.gap, 1e-9, 'the gaps match'));
near(open.total, 1000 + open.gap * 3, 1e-9, 'the strip makes room for a gap after each part');
// Apart, the parts take up less of the strip than when they are together.
near(open.spans.reduce((n, s) => n + (s.to - s.from), 0) / open.total, 1000 / open.total, 1e-9, 'the rest is gaps');
assert.ok(open.total > closed.total, 'standing apart makes the strip longer');

// Closing up is smooth: a hair apart is nearly flush.
const nearly = A.spans(three, 1e-6);
nearly.spans.forEach((s, i) => near(s.from, closed.spans[i].from, 0.01, 'no jump as the gaps close'));

console.log('assemblyview.test.js (coming together): ok');
