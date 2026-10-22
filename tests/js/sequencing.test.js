/* Checks the pure alignment helpers in app/static/js/sequencing.js (no DOM needed). */
const fs = require('fs');
const assert = require('assert');

const src = fs.readFileSync('app/static/js/sequencing.js', 'utf8');
// sequencing.js is a classic script that waits for the page; stub just that, and fmt from api.js.
const ctx = {};
globalThis.document = { addEventListener() {} };
globalThis.fmt = (n) => Number(n).toLocaleString('en-US');
new Function('globalThis', `${src}\nglobalThis.__x = { alignmentColumns, differenceColumns, differenceQuality, mergedCoverage, coverageGaps, rulerStep, describeDifference, LOW_QUALITY };`)(ctx);
const { alignmentColumns, differenceColumns, differenceQuality, mergedCoverage, coverageGaps, rulerStep,
  describeDifference, LOW_QUALITY } = ctx.__x;

// Reference AAAACCCCGGGG; the read has an extra T after position 7 and lacks the G at 8 (0-based).
//   column: 0 1 2 3 4 5 6
//   ref     C C C - C G G     positions 4 5 6 . 7 8 9
//   read    C C C T C - G     its bases 10..15 as uploaded
const a = {
  top: 'CCC-CGG', bottom: 'CCCTC-G', ref_start: 4, strand: 1, read_start: 10, read_end: 16,
  differences: [
    { type: 'insertion', position: 7, ref: '-', read: 'T', length: 1 },
    { type: 'deletion', position: 8, ref: 'G', read: '-', length: 1 },
  ],
};
let cols = alignmentColumns(a, 12);
assert.deepStrictEqual(cols.ref, [4, 5, 6, -1, 7, 8, 9], 'reference position per column');
assert.deepStrictEqual(cols.read, [10, 11, 12, 13, 14, -1, 15], 'read base per column, forward');

// A reverse-strand read is shown reverse-complemented: its bases count down from its end.
const rev = { ...a, strand: -1 };
assert.deepStrictEqual(alignmentColumns(rev, 12).read, [15, 14, 13, 12, 11, -1, 10], 'read base per column, reverse');

// An alignment stored before reads knew where they start cannot be placed in the read.
const old = { ...a };
delete old.read_start;
assert.strictEqual(alignmentColumns(old, 12).read, null, 'older alignment: no read positions');

// Through the origin of a circular reference.
assert.deepStrictEqual(alignmentColumns({ top: 'GAA', bottom: 'GAA', ref_start: 11, strand: 1, read_start: 0, read_end: 3 }, 12).ref,
  [11, 0, 1], 'positions wrap at the origin');

const diffCols = differenceColumns(a, 12);
assert.deepStrictEqual(diffCols, [[3], [5]], 'columns of each difference');

// A run of insertion is one difference over several columns.
assert.deepStrictEqual(differenceColumns({
  top: 'AC---GT', bottom: 'ACTTTGT', ref_start: 0,
  differences: [{ type: 'insertion', position: 2, length: 3 }],
}, 100), [[2, 3, 4]], 'a run is one difference');

// Quality at a difference: the read's own call, or for a deletion the bases either side of it.
const quality = Array(20).fill(40);
quality[13] = 8;
assert.strictEqual(differenceQuality(diffCols[0], cols.read, quality), 8, 'insertion: its own base');
assert.strictEqual(differenceQuality(diffCols[1], cols.read, quality), 40, 'deletion: its neighbours');
quality[15] = 12;
assert.strictEqual(differenceQuality(diffCols[1], cols.read, quality), 12, 'deletion: the poorer neighbour');
assert.strictEqual(differenceQuality(diffCols[0], cols.read, null), null, 'a FASTA read has no quality');
assert.ok(8 < LOW_QUALITY && 40 >= LOW_QUALITY, 'low quality threshold sits between a guess and a clean call');

// Coverage: overlapping spans merge, one through the origin splits, and the gaps are what's left.
const covered = mergedCoverage([[10, 2], [1, 4], [6, 8]], 12);
assert.deepStrictEqual(covered, [[0, 4], [6, 8], [10, 12]], 'merged coverage');
assert.deepStrictEqual(coverageGaps(covered, 12), [[4, 6], [8, 10]], 'gaps between');
assert.deepStrictEqual(coverageGaps([], 12), [[0, 12]], 'nothing covered');
assert.deepStrictEqual(coverageGaps([[0, 12]], 12), [], 'everything covered');

assert.strictEqual(rulerStep(4200), 1000);
assert.strictEqual(rulerStep(800), 100);
assert.strictEqual(rulerStep(60), 10);

assert.strictEqual(describeDifference({ type: 'mismatch', position: 510, ref: 'C', read: 'T', length: 1 }), 'C→T at 511');
assert.strictEqual(describeDifference({ type: 'insertion', position: 720, read: 'A'.repeat(60), length: 60 }), '+60 bp at 721');
assert.strictEqual(describeDifference({ type: 'deletion', position: 719, ref: 'G', length: 1 }), '−G at 720');
assert.strictEqual(describeDifference({ type: 'insertion', position: 1999, read: 'T', length: 1 }), '+T at 2,000');

console.log('sequencing helpers: all checks passed');
