/* Checks the pure sequence helpers in app/static/js/api.js (no DOM needed). */
const fs = require('fs');
const assert = require('assert');

const src = fs.readFileSync('app/static/js/api.js', 'utf8');
// api.js is a classic script; evaluate it and pull out the helpers.
const ctx = {};
new Function('globalThis', `${src}\nglobalThis.__x = { DNA, translateSeq, featureColor, FEATURE_COLORS, CODONS, applyEdit };`)(ctx);
const { DNA, translateSeq, featureColor, applyEdit } = ctx.__x;

assert.strictEqual(DNA.revComp('AACGTRY'), 'RYACGTT', 'IUPAC reverse complement');
assert.strictEqual(DNA.revComp('acgt'), 'acgt', 'case preserved');
assert.strictEqual(DNA.complement('GAATTC'), 'CTTAAG');
assert.strictEqual(DNA.clean('1 acgt 20 GGcc\nnn'), 'acgtGGccnn', 'digits and whitespace stripped');
assert.strictEqual(DNA.gc('GGCC'), 100);
assert.strictEqual(DNA.gc('ATAT'), 0);
assert.strictEqual(DNA.featLength({ start: 10, end: 20 }, 100), 10, 'plain feature');
assert.strictEqual(DNA.featLength({ start: 90, end: 10 }, 100), 20, 'feature across the origin');
assert.strictEqual(translateSeq('ATGGCTTAA'), 'MA*');
assert.strictEqual(translateSeq('ATGNNN'), 'MX', 'ambiguous codon');
assert.strictEqual(featureColor({ type: 'CDS' }), '#60a5fa');
assert.strictEqual(featureColor({ type: 'CDS', color: '#123456' }), '#123456', 'explicit colour wins');
assert.strictEqual(featureColor({ type: 'nonsense' }), '#94a3b8', 'unknown type falls back');

// Round trip: revComp twice is the identity, for every IUPAC code.
const all = 'ACGTURYKMSWBDHVN';
// U complements to A, and A back to T, so a round trip maps U onto T.
assert.strictEqual(DNA.revComp(DNA.revComp(all)), all.replace('U', 'T'), 'double revcomp round trip');

// --- applyEdit: the sequence edit that typing, Backspace and paste all use ---
const doc = () => ({
  sequence: 'AAAACCCCGGGGTTTT',               //  0123456789...
  features: [
    { id: 'early', name: 'early', start: 0,  end: 4,  strand: 1 },   // AAAA
    { id: 'mid',   name: 'mid',   start: 4,  end: 8,  strand: 1 },   // CCCC
    { id: 'late',  name: 'late',  start: 12, end: 16, strand: 1 },   // TTTT
  ],
});
const byId = (r, id) => r.features.find((f) => f.id === id);

// Typing one base at the caret, before every feature.
let r = applyEdit(doc(), 0, 0, 'G');
assert.strictEqual(r.sequence, 'GAAAACCCCGGGGTTTT');
assert.deepStrictEqual([byId(r,'early').start, byId(r,'early').end], [1, 5], 'feature shifts right');
assert.deepStrictEqual([byId(r,'late').start, byId(r,'late').end], [13, 17]);

// Typing inside a feature stretches it, and leaves earlier ones alone.
r = applyEdit(doc(), 6, 6, 'TT');
assert.strictEqual(r.sequence, 'AAAACCTTCCGGGGTTTT');
assert.deepStrictEqual([byId(r,'mid').start, byId(r,'mid').end], [4, 10], 'feature grows');
assert.deepStrictEqual([byId(r,'early').start, byId(r,'early').end], [0, 4], 'earlier feature untouched');

// Backspace just after a feature shortens it.
r = applyEdit(doc(), 7, 8, '');
assert.strictEqual(r.sequence, 'AAAACCCGGGGTTTT');
assert.deepStrictEqual([byId(r,'mid').start, byId(r,'mid').end], [4, 7], 'feature shrinks');
assert.deepStrictEqual([byId(r,'late').start, byId(r,'late').end], [11, 15], 'later feature shifts left');

// Deleting a whole feature removes it rather than leaving a zero-length one.
r = applyEdit(doc(), 4, 8, '');
assert.strictEqual(r.sequence, 'AAAAGGGGTTTT');
assert.strictEqual(byId(r, 'mid'), undefined, 'fully deleted feature is dropped');
assert.strictEqual(r.features.length, 2);

// Editing after every feature leaves them all alone.
r = applyEdit(doc(), 16, 16, 'AAA');
assert.deepStrictEqual(r.features.map((f) => [f.start, f.end]), [[0,4],[4,8],[12,16]]);

// Typing over a selection that covers a feature keeps the (now shorter)
// feature rather than silently losing the annotation; only a real deletion
// drops it.
r = applyEdit(doc(), 4, 8, 'A');
assert.strictEqual(r.sequence, 'AAAAAGGGGTTTT');
assert.deepStrictEqual([byId(r,'mid').start, byId(r,'mid').end], [4, 5], 'overwritten feature survives, resized');
assert.deepStrictEqual([byId(r,'late').start, byId(r,'late').end], [9, 13]);

// Typing at the boundary between two features joins neither of them.
r = applyEdit(doc(), 4, 4, 'G');
assert.strictEqual(r.sequence, 'AAAAGCCCCGGGGTTTT');
assert.deepStrictEqual([byId(r,'early').start, byId(r,'early').end], [0, 4], 'left feature does not absorb it');
assert.deepStrictEqual([byId(r,'mid').start, byId(r,'mid').end], [5, 9], 'right feature does not absorb it');

// Typing just inside a feature's first base does extend it.
r = applyEdit(doc(), 5, 5, 'G');
assert.deepStrictEqual([byId(r,'mid').start, byId(r,'mid').end], [4, 9], 'interior insertion grows the feature');

// The input document is never mutated.
const original = doc();
applyEdit(original, 0, 4, 'X');
assert.strictEqual(original.sequence, 'AAAACCCCGGGGTTTT', 'applyEdit is pure');
assert.deepStrictEqual(original.features.map((f) => f.start), [0, 4, 12]);

// Multi-segment features keep their pieces aligned.
r = applyEdit({ sequence: 'AAAACCCCGGGG',
                features: [{ id: 'j', name: 'joined', start: 0, end: 12, strand: 1,
                             segments: [[0, 4], [8, 12]] }] }, 0, 0, 'TT');
assert.deepStrictEqual(byId(r, 'j').segments, [[2, 6], [10, 14]], 'segments shift too');

console.log('all frontend helper assertions passed');
