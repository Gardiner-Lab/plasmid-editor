/* Cloning simulation page: Golden Gate, Gibson, restriction-ligation, recombination. */

const HELP = {
  gibson: 'Pick fragments in the order they should be joined. Each neighbouring pair must share terminal homology; a fragment is flipped automatically if only its reverse complement overlaps.',
  ligate: 'Pick exactly two sequences: the vector first, then the insert. Choose the enzymes for each and which fragment to use.',
  recombine: 'Pick the donor first, then the acceptor. A double crossover through two shared core sequences (attL×attR, attB×attP, loxP, FRT) swaps the donor segment into the acceptor.',
};

const Cloning = {
  method: 'gibson',
  sources: [],
  picked: [],

  async init() {
    document.querySelectorAll('[data-method]').forEach((btn) => {
      btn.addEventListener('click', () => {
        this.method = btn.dataset.method;
        document.querySelectorAll('[data-method]').forEach((b) => b.classList.toggle('on', b === btn));
        this.picked = [];
        this.renderPicked();
        this.renderOptions();
        document.getElementById('methodHelp').textContent = HELP[this.method];
        document.getElementById('result').replaceChildren(
          el('div', { class: 'empty' }, 'Choose parts and run the reaction.'));
      });
    });
    document.getElementById('search').addEventListener('input', () => this.renderSources());
    document.getElementById('btnClear').addEventListener('click', () => {
      this.picked = [];
      this.renderPicked();
    });
    document.getElementById('btnRun').addEventListener('click', () => this.run());
    document.getElementById('methodHelp').textContent = HELP[this.method];
    this.renderPicked();
    this.renderOptions();
    await this.loadSources();
  },

  async loadSources() {
    try {
      const { sequences } = await API.get('/api/sequences');
      this.sources = sequences.map((s) => ({ ...s, origin_kind: 'editor' }));
      const status = await API.get('/api/moclo/status').catch(() => ({ available: {} }));
      if (status.available?.parts) {
        const { parts } = await API.get('/api/moclo/parts');
        this.sources.push(...parts.map((p) => ({ ...p, origin_kind: 'moclo-part' })));
      }
      this.renderSources();
    } catch (err) {
      toast(err.message, 'error');
    }
  },

  renderSources() {
    const q = document.getElementById('search').value.trim().toLowerCase();
    const list = document.getElementById('sourceList');
    const items = this.sources.filter((s) => !q || s.name.toLowerCase().includes(q));
    if (!items.length) {
      list.replaceChildren(el('li', { class: 'empty' }, 'Nothing matches.'));
      return;
    }
    list.replaceChildren(...items.slice(0, 250).map((s) => el('li', {
      class: 'item',
      onclick: () => this.pick(s),
    },
      el('span', { class: 'item-name' }, s.name,
        el('span', { class: 'item-meta' },
          s.origin_kind === 'moclo-part' ? ' · MoClo part' : (s.circular ? ' · circular' : ' · linear'),
          s.overhang_5prime ? ` · ${s.overhang_5prime}…${s.overhang_3prime}` : '')),
      el('span', { class: 'item-meta' }, `${fmt(s.length)} bp +`))));
  },

  async pick(source) {
    try {
      const doc = source.origin_kind === 'moclo-part'
        ? (await API.get(`/api/moclo/parts/${source.id}`)).document
        : (await API.get(`/api/sequences/${source.id}`)).sequence;
      this.picked.push({ ...doc, label: source.name });
      this.renderPicked();
    } catch (err) {
      toast(err.message, 'error');
    }
  },

  renderPicked() {
    const list = document.getElementById('pickedList');
    document.getElementById('pickCount').textContent = this.picked.length ? `${this.picked.length} selected` : '';
    if (!this.picked.length) {
      list.replaceChildren(el('li', { class: 'empty' }, 'No parts chosen yet.'));
      return;
    }
    const roles = { ligate: ['Vector', 'Insert'], recombine: ['Donor', 'Acceptor'] };
    list.replaceChildren(...this.picked.map((p, i) => el('li', { class: 'item' },
      el('span', { class: 'item-name' },
        roles[this.method]?.[i] ? el('span', { class: 'badge', text: roles[this.method][i] }) : null,
        ` ${i + 1}. ${p.label}`,
        el('span', { class: 'item-meta' }, ` ${fmt(p.sequence.length)} bp`)),
      el('span', { class: 'item-meta nowrap' },
        i > 0 ? el('button', { class: 'tool-btn', title: 'Move up',
          onclick: () => { [this.picked[i - 1], this.picked[i]] = [this.picked[i], this.picked[i - 1]]; this.renderPicked(); } }, '↑') : null,
        el('button', { class: 'tool-btn', title: 'Remove',
          onclick: () => { this.picked.splice(i, 1); this.renderPicked(); } }, '✕')))));
    if (this.method === 'ligate') this.renderOptions();
  },

  renderOptions() {
    const box = document.getElementById('options');
    if (this.method === 'gibson') {
      box.replaceChildren(
        el('div', { class: 'field-row' },
          el('div', { class: 'field' },
            el('label', { for: 'gbOverlap' }, 'Minimum overlap (bp)'),
            el('input', { type: 'number', id: 'gbOverlap', value: '15', min: '10' })),
          el('div', { class: 'field' },
            el('label', { class: 'checkbox', style: 'margin-top:1.3rem' },
              el('input', { type: 'checkbox', id: 'gbCircular', checked: true }),
              el('span', {}, 'Circular product')))));
    } else if (this.method === 'ligate') {
      const enzymeField = (id, label, doc) => el('div', { class: 'field' },
        el('label', { for: id }, label),
        el('input', { type: 'text', id, placeholder: 'EcoRI, BamHI' }));
      box.replaceChildren(
        el('div', { class: 'field-row' },
          enzymeField('ligVecEnz', 'Vector enzymes'),
          el('div', { class: 'field' },
            el('label', { for: 'ligVecFrag' }, 'Vector fragment #'),
            el('input', { type: 'number', id: 'ligVecFrag', value: '0', min: '0' }))),
        el('div', { class: 'field-row' },
          enzymeField('ligInsEnz', 'Insert enzymes'),
          el('div', { class: 'field' },
            el('label', { for: 'ligInsFrag' }, 'Insert fragment #'),
            el('input', { type: 'number', id: 'ligInsFrag', value: '1', min: '0' }))),
        el('p', { class: 'hint' },
          'Fragments are numbered as the digest lists them, starting at 0. Run a digest in the editor to see them.'));
    } else {
      box.replaceChildren(
        el('div', { class: 'field-row' },
          el('div', { class: 'field' },
            el('label', { for: 'recMin' }, 'Minimum core (bp)'),
            el('input', { type: 'number', id: 'recMin', value: '13', min: '8' })),
          el('div', { class: 'field' },
            el('label', { for: 'recMax' }, 'Maximum core (bp)'),
            el('input', { type: 'number', id: 'recMax', value: '60', min: '20' }))));
    }
  },

  payload(doc) {
    return { name: doc.label || doc.name, sequence: doc.sequence, circular: doc.circular,
             description: doc.description || '', features: doc.features || [] };
  },

  async run() {
    const out = document.getElementById('result');
    if (this.picked.length < 2) { toast('Choose at least two parts', 'error'); return; }
    out.replaceChildren(el('span', { class: 'spin' }));
    try {
      if (this.method === 'gibson') {
        const res = await API.post('/api/tools/gibson', {
          documents: this.picked.map((p) => this.payload(p)),
          min_overlap: Number(document.getElementById('gbOverlap').value) || 15,
          circular: document.getElementById('gbCircular').checked,
        });
        this.showProducts([res.product], res.junctions);
      } else if (this.method === 'ligate') {
        const parse = (id) => document.getElementById(id).value.split(/[,\s]+/).filter(Boolean);
        const res = await API.post('/api/tools/ligate', {
          vector: this.payload(this.picked[0]),
          insert: this.payload(this.picked[1]),
          vector_enzymes: parse('ligVecEnz'),
          insert_enzymes: parse('ligInsEnz'),
          vector_fragment: Number(document.getElementById('ligVecFrag').value) || 0,
          insert_fragment: Number(document.getElementById('ligInsFrag').value) || 0,
        });
        this.showProducts(res.products);
      } else {
        const res = await API.post('/api/tools/recombine', {
          donor: this.payload(this.picked[0]),
          acceptor: this.payload(this.picked[1]),
          min_core: Number(document.getElementById('recMin').value) || 13,
          max_core: Number(document.getElementById('recMax').value) || 60,
        });
        this.showProducts(res.products.map((r) => r.document), null,
          res.products.map((r) => `cores ${r.core_1.slice(0, 12)}… / ${r.core_2.slice(0, 12)}…`));
      }
    } catch (err) {
      out.replaceChildren(el('div', { class: 'alert alert-error', text: err.message }));
    }
  },

  showProducts(products, junctions, notes) {
    const out = document.getElementById('result');
    const nodes = [];
    if (junctions) {
      nodes.push(el('h4', { style: 'font-size:.9rem;margin-bottom:.35rem' }, 'Junctions'),
        el('table', {},
          el('thead', {}, el('tr', {},
            el('th', {}, 'Left'), el('th', {}, 'Right'), el('th', { class: 'num' }, 'Overlap'),
            el('th', { class: 'num' }, 'Tm'), el('th', {}, 'Flipped'))),
          el('tbody', {}, junctions.map((j) => el('tr', {},
            el('td', { text: j.left }), el('td', { text: j.right }),
            el('td', { class: 'num', text: `${j.overlap} bp` }),
            el('td', { class: 'num', text: j.tm ? `${j.tm} °C` : '–' }),
            el('td', { text: j.flipped ? 'yes' : 'no' }))))));
    }
    if (!products || !products.length || !products[0]) {
      nodes.push(el('div', { class: 'alert alert-warning' }, 'No product was formed.'));
      out.replaceChildren(...nodes);
      return;
    }
    products.forEach((p, i) => {
      nodes.push(el('div', { class: 'alert alert-success', style: 'margin-top:.5rem' },
        el('div', {}, el('b', {}, `${p.name} — ${fmt(p.sequence.length)} bp `),
          p.circular ? 'circular' : 'linear',
          notes?.[i] ? ` · ${notes[i]}` : ''),
        p.assembly
          ? el('div', { class: 'hint' }, p.assembly
            .map((a) => `${a.source}${a.reversed ? ' (rev)' : ''} ${fmt(a.length)} bp`).join(' → '))
          : null,
        el('div', { class: 'btn-group', style: 'margin-top:.5rem' },
          el('button', {
            class: 'btn btn-sm',
            onclick: async (ev) => {
              ev.currentTarget.disabled = true;
              try {
                const saved = await API.post('/api/sequences', { document: p });
                toast('Saved — opening in the editor', 'success');
                window.location.href = url(`/editor?open=${saved.sequence.id}`);
              } catch (err) {
                toast(err.message, 'error');
                ev.currentTarget.disabled = false;
              }
            },
          }, 'Save and open in editor'),
          el('button', {
            class: 'btn btn-sm btn-secondary',
            onclick: () => navigator.clipboard?.writeText(p.sequence)
              .then(() => toast('Sequence copied', 'success', 2000))
              .catch(() => toast('Could not access the clipboard', 'error')),
          }, 'Copy sequence'))));
    });
    out.replaceChildren(...nodes);
  },
};

document.addEventListener('DOMContentLoaded', () => Cloning.init());
