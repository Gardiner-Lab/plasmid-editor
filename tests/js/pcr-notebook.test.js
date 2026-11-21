/* What a simulated PCR puts into the Lab Notebook (app/static/js/tools.js pcrSection).
   Run with: node tests/js/pcr-notebook.test.js */
const fs = require('fs');
const assert = require('assert');

// tools.js is a classic script built on the editor's globals; stub the few pcrSection uses.
const boxes = {
  pcrF: { value: ' acgtacgtacgtacgtaa ', dataset: {} },
  pcrR: { value: 'TTGCATGCATGCATGCAT', dataset: {} },
  pcrAnneal: { value: '15', dataset: {} },
  pcrMis: { value: '0', dataset: {} },
};
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (ch) => `&#${ch.charCodeAt(0)};`);
const stubs = {
  document: { getElementById: (id) => boxes[id], body: { dataset: {} } },
  fmt: (n) => String(n),
  Notebook: {
    esc,
    plasmid: (d) => (d.id ? `<a data-plasmid="${esc(d.id)}">${esc(d.name)}</a>` : `<b>${esc(d.name)}</b>`),
    picture: () => '<p><img data-attachment="picture" alt=""></p>',
    table: (title, columns, rows) => ({
      type: 'table', title,
      columns: columns.map(([name, kind = 'text', unit = '']) => ({ name, kind, unit })),
      rows: rows.map((cells) => ({ cells: cells.map((c) => (c === null || c === undefined ? null : String(c))) })),
    }),
  },
  PlasmidMap: { picture: async () => 'picture-blob' },
};
const src = fs.readFileSync('app/static/js/tools.js', 'utf8');
const names = Object.keys(stubs);
// eslint-disable-next-line no-new-func
const Tools = new Function(...names, `${src}\nreturn Tools;`)(...names.map((n) => stubs[n]));

const doc = { id: 'seq-1', name: 'pGFP', sequence: 'A'.repeat(2000), features: [] };
const res = {
  forward: { length: 18, tm: 61.2 },
  reverse: { length: 18, tm: 59.4 },
  products: [{ length: 622, template_start: 100, template_end: 722, sequence: 'A'.repeat(622) }],
};
const primersOf = (section) => section.blocks.find((b) => b.title === 'Primers');

(async () => {
  // A primer picked from the sequence or from Lab Stocks is named, and the name goes to the notebook:
  // a day's page is read by name, and a sequence on its own says nothing about which primer it was.
  boxes.pcrF.dataset = { primerName: 'M13 fwd' };
  boxes.pcrR.dataset = { primerName: 'GARD-O-0007 M13 rev', primerCode: 'GARD-O-0007' };
  const { section } = await Tools.pcrSection(doc, res);
  const primers = primersOf(section);
  assert.deepStrictEqual(primers.columns.map((c) => c.name),
    ['Primer', 'Name', "Sequence 5'→3'", 'Length', 'Tm']);
  assert.deepStrictEqual(primers.rows[0].cells,
    ['Forward', 'M13 fwd', 'ACGTACGTACGTACGTAA', '18', '61.2'], 'the forward primer, named');
  // One of the lab's primers is linked, so the day shows on it in Lab Stocks.
  assert.strictEqual(primers.rows[1].cells[1], '[GARD-O-0007 M13 rev](stock:GARD-O-0007)');
  assert.strictEqual(primers.rows[1].cells[2], 'TTGCATGCATGCATGCAT', 'the sequence is still there');
  // The names are in the opening line too, where the day is read.
  assert.ok(section.blocks[0].html.includes('with M13 fwd and GARD-O-0007 M13 rev'),
    section.blocks[0].html);

  // A primer typed in by hand that matches nothing has no name to give: the row still holds
  // its sequence, and the opening line does not claim a name.
  boxes.pcrF.dataset = {};
  boxes.pcrR.dataset = {};
  const plain = (await Tools.pcrSection(doc, res)).section;
  assert.deepStrictEqual(primersOf(plain).rows.map((r) => r.cells[1]), ['', '']);
  assert.ok(!plain.blocks[0].html.includes(' with '), plain.blocks[0].html);

  // One named and one not: only the one that has a name is mentioned.
  boxes.pcrF.dataset = { primerName: 'M13 fwd' };
  const half = (await Tools.pcrSection(doc, res)).section;
  assert.ok(half.blocks[0].html.includes('with M13 fwd,'), half.blocks[0].html);

  // A name with brackets in it cannot break the link it is written into.
  boxes.pcrR.dataset = { primerName: 'odd [name] here', primerCode: 'GARD-O-0008' };
  const odd = (await Tools.pcrSection(doc, res)).section;
  assert.strictEqual(primersOf(odd).rows[1].cells[1], '[odd  name  here](stock:GARD-O-0008)');

  console.log('pcr-notebook: all passed');
})();
