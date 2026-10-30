/* Which strand a Find hit is marked on (app/static/js/seqview.js). Run with: node tests/js/seqview.test.js */
const assert = require('assert');
const fs = require('fs');

const src = fs.readFileSync('app/static/js/seqview.js', 'utf8');
const body = src.match(/_styledBases\(text, start, end, sel, selLen, strand = 1\) \{[\s\S]*?\n {2}\}/);
assert.ok(body, '_styledBases(…, strand) found in seqview.js');

// Bases with no highlight are plain text nodes; stub just that.
globalThis.document = { createTextNode: (text) => ({ text }) };

// A stand-in for the view holding only what _styledBases touches, and an el() that records what it draws.
function marked(highlights, showComplement, strand, text = 'AAGGTCTCAA') {
  const el = (tag, attrs) => ({ class: attrs.class, text: attrs.text });
  const fn = new Function('el', `return function ${body[0]}`)(el);
  const view = { highlights, opts: { showComplement }, _inSelection: () => false };
  return fn.call(view, text, 0, text.length, null, 0, strand)
    .map((part) => (part.class ? `${part.text}:${part.class}` : part.text)).join('|');
}

// GGTCTC found on the sequence: marked there, not on the complement.
const forward = [{ start: 2, end: 8, class: 'hit', strand: 1 }];
assert.ok(marked(forward, true, 1).includes('GGTCTC:hit'), 'a forward hit is marked on the sequence');
assert.ok(!marked(forward, true, -1).includes('hit'), 'and not on the complement');

// GAGACC typed in: read on the reverse strand, so marked on the complement in its own colour.
const reverse = [{ start: 2, end: 8, class: 'hit hit-rev', strand: -1 }];
assert.ok(marked(reverse, true, -1).includes('hit hit-rev'), 'a reverse hit is marked on the complement');
assert.ok(!marked(reverse, true, 1).includes('hit'), 'and not on the sequence while the complement shows');

// With the complement hidden it goes on the sequence instead, rather than being invisible.
assert.ok(marked(reverse, false, 1).includes('hit hit-rev'), 'marked on the sequence when the complement is off');

// A highlight naming no strand is marked on both rows.
const either = [{ start: 2, end: 8, class: 'hit' }];
assert.ok(marked(either, true, 1).includes('hit') && marked(either, true, -1).includes('hit'),
  'a highlight with no strand is on both rows');

console.log('seqview: all passed');
