/* Checks the pure sequence helpers in app/static/js/api.js (no DOM needed). */
const fs = require('fs');
const assert = require('assert');

const src = fs.readFileSync('app/static/js/api.js', 'utf8');
// api.js is a classic script; evaluate it and pull out the helpers.
const ctx = {};
new Function('globalThis', `${src}\nglobalThis.__x = { DNA, translateSeq, featureColor, FEATURE_COLORS, CODONS };`)(ctx);
const { DNA, translateSeq, featureColor } = ctx.__x;

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

console.log('all frontend helper assertions passed');
