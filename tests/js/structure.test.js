/* Checks how structure.js reads primer3's drawings of dimers and hairpins (no DOM needed). */
const assert = require('assert');
const { Structure } = require('../../app/static/js/structure.js');

// A dimer as primer3 prints it: unpaired top, paired top, paired bottom (3'->5'), unpaired bottom.
const dimer = Structure.parse([
  'SEQ\tAT    G    ',
  'SEQ\t  GGCC AT  ',
  'STR\t  CCGG TA  ',
  'STR\t      T  CA',
]);
assert.strictEqual(dimer.kind, 'duplex');
assert.strictEqual(dimer.cols.map((c) => c.top || '-').join(''), 'ATGGCCGAT--', 'top strand, 5\'->3\'');
assert.strictEqual(dimer.cols.map((c) => c.bottom || '-').join(''), '--CCGGTTACA', 'bottom strand, 3\'->5\'');
assert.strictEqual(dimer.cols.filter((c) => c.paired).length, 6, 'paired where both middle lines have a base');
assert.strictEqual(Structure.parse(['SEQ\tAAA', 'SEQ\t   ', 'STR\t   ', 'STR\tTTT']), null, 'nothing paired');

// A hairpin: GGGA pairs with TCCC, round an AAAA loop, a 2-base 5' tail and 1-base 3' tail.
const seq = 'TTGGGAAAAATCCCG';
const hp = Structure.parse(['SEQ\t' + seq, 'STR\t  ////    ' + '\\'.repeat(4) + ' ']);
assert.strictEqual(hp.kind, 'hairpin');
assert.strictEqual(hp.cols.filter((c) => c.paired).map((c) => c.top + c.bottom).join(' '), 'GC GC GC AT', 'stem pairs, outer first');
assert.strictEqual(hp.loop.join(''), 'AAAA', 'loop');
assert.strictEqual(hp.cols.slice(0, 2).map((c) => `${c.top}${c.bottom || '-'}`).join(' '), 'T- TG', 'tails right-aligned against the stem');

// A bulge on the 5' arm: an extra A between the second and third pair.
const bulge = Structure.fold('GGAGAAAACCC', '// /    ' + '\\'.repeat(3));
assert.ok(bulge, 'bulge parsed');
assert.strictEqual(bulge.cols.filter((c) => c.paired).length, 3, 'three pairs either side of the bulge');
assert.ok(bulge.cols.some((c) => c.top === 'A' && !c.bottom && !c.paired), 'bulged base unpaired on top');
assert.strictEqual(Structure.parse(['SEQ\tACGT', 'STR\t    ']), null, 'no pairs');

console.log('structure.test.js: ok');

// Real primer3-py 2.4.0 output: a hairpin prints its marks first, then the sequence.
const real = Structure.parse(['SEQ\t--//////----' + '\\'.repeat(6) + '------', 'STR\tGGAGTCGGATTTCCGACTCCTTTT']);
assert.strictEqual(real.kind, 'hairpin');
assert.strictEqual(real.cols.filter((c) => c.paired).map((c) => c.top + c.bottom).join(''), 'ATGCTACGGCGC', 'six stem pairs, outer first');
assert.strictEqual(real.loop.join(''), 'ATTT');
const homo = Structure.parse(['SEQ\t        AAAAA', 'SEQ\tCCCCGGGG     CCCCGGGG', 'STR\tGGGGCCCC     GGGGCCCC', 'STR\t        AAAAA']);
assert.strictEqual(homo.cols.filter((c) => c.paired).length, 16, 'self-dimer round an internal loop');
assert.strictEqual(Structure.parse(['SEQ\t', 'SEQ\tGGTC', 'STR\tCCAG', 'STR\t']).cols.length, 4, 'empty unpaired lines');
console.log('structure.test.js (primer3 output): ok');

// The whole-structure layout: no two bases on top of each other, for hairpins, bulges and dimers.
const apart = (s, what) => {
  const L = Structure.layout(s);
  const pts = [...L.top, ...L.bot, ...L.loop];
  let near = Infinity;
  for (let i = 0; i < pts.length; i++) for (let j = i + 1; j < pts.length; j++) near = Math.min(near, Math.hypot(pts[i].x - pts[j].x, pts[i].y - pts[j].y));
  assert.ok(near >= L.step * 0.75, `${what}: bases ${near.toFixed(1)} apart, under ${L.step * 0.75}`);
  return L;
};
const L1 = apart(real, 'real hairpin');
assert.strictEqual(L1.top.length + L1.bot.length + L1.loop.length, 24, 'every base of the hairpin placed');
assert.ok(L1.loop.every((p) => p.x > Math.max(...L1.top.map((q) => q.x))), 'the loop closes the stem\'s far end');
apart(homo, 'self-dimer round an internal loop');
const big = Structure.parse(['SEQ\t--//////' + '-'.repeat(12) + '\\'.repeat(6) + '------', 'STR\tGGAGTCGG' + 'A'.repeat(12) + 'CCGACTTTTTTT']);
assert.strictEqual(big.loop.length, 12);
apart(big, 'hairpin, 12-base loop');
apart(dimer, 'dimer with a bulge and loose ends');
console.log('structure.test.js (layout): ok');
