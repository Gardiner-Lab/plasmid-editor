/*
 * Editor page controller: open documents, edit the sequence and its features,
 * run analyses, and contribute Golden Gate ready plasmids to the MoClo library.
 */

const Editor = {
  docs: [],            // open documents
  index: -1,           // active document
  view: null,
  map: null,
  sites: [],
  enzymeSets: {},
  activeSet: 'Default',
  findHits: [],
  findAt: -1,
  dirty: false,

  get doc() { return this.index >= 0 ? this.docs[this.index] : null; },

  async init() {
    this.view = new SeqView(document.getElementById('sequencePane'));
    this.map = new PlasmidMap(document.getElementById('mapPane'));
    this.view.onSelect = () => this.refreshStats();
    this.view.onCaret = () => this.refreshStats();
    this.view.onFeatureClick = (f) => this.editFeature(f);
    this.map.onFeatureClick = (f) => this.editFeature(f);

    this.bindToolbar();
    this.bindPanels();

    try {
      const { sets } = await API.get('/api/tools/enzymes');
      this.enzymeSets = sets;
      const sel = document.getElementById('enzymeSet');
      sel.replaceChildren(...Object.keys(sets).map((name) =>
        el('option', { value: name, text: `${name} (${sets[name].length})` })));
      sel.value = this.activeSet;
      sel.addEventListener('change', () => { this.activeSet = sel.value; this.refreshSites(); });
    } catch (err) {
      toast(err.message, 'error');
    }

    // Reopen a sequence passed as ?open=<id>, else load the most recent one.
    const open = new URLSearchParams(location.search).get('open');
    if (open) {
      await this.openStored(open);
    } else {
      this.addDocument({ name: 'Untitled', sequence: '', circular: true, features: [] });
    }

    window.addEventListener('beforeunload', (e) => {
      if (this.dirty) { e.preventDefault(); e.returnValue = ''; }
    });
  },

  /* --- document handling ------------------------------------------------ */

  addDocument(doc, { activate = true } = {}) {
    doc.features = doc.features || [];
    this.docs.push(doc);
    if (activate) this.setActive(this.docs.length - 1);
    else this.renderDocList();
    return doc;
  },

  setActive(i) {
    this.index = i;
    const doc = this.doc;
    document.getElementById('docName').value = doc?.name || '';
    document.getElementById('chkGoldenGate').checked = !!doc?.golden_gate;
    this.view.setDocument(doc || { sequence: '', features: [] });
    this.renderDocList();
    this.renderFeatures();
    this.refreshSites();
    this.updateBadges();
    this.renderGoldenGate();
    document.getElementById('ggPanel').hidden = !doc?.golden_gate;
  },

  renderDocList() {
    const list = document.getElementById('docList');
    document.getElementById('docCount').textContent = this.docs.length ? `${this.docs.length}` : '';
    if (!this.docs.length) {
      list.replaceChildren(el('li', { class: 'empty' }, 'Nothing open.'));
      return;
    }
    list.replaceChildren(...this.docs.map((d, i) => el('li', {
      class: `item ${i === this.index ? 'active' : ''}`,
      onclick: () => this.setActive(i),
    },
      el('span', { class: 'item-name', text: d.name || 'Untitled' }),
      el('span', { class: 'item-meta' },
        `${fmt(d.sequence.length)} bp${d.circular ? ' ○' : ''}`),
    )));
  },

  async openStored(id) {
    try {
      const { sequence } = await API.get(`/api/sequences/${id}`);
      this.addDocument(sequence);
      this.dirty = false;
    } catch (err) {
      toast(err.message, 'error');
      this.addDocument({ name: 'Untitled', sequence: '', circular: true, features: [] });
    }
  },

  markDirty() {
    this.dirty = true;
    const doc = this.doc;
    if (!doc) return;
    this.view.setDocument(doc);
    this.renderFeatures();
    this.refreshSites();
    this.renderDocList();
    this.updateBadges();
    if (!document.getElementById('mapPane').hidden) this.map.render(doc, this.sites, this.view.selection);
  },

  updateBadges() {
    const doc = this.doc;
    document.getElementById('badgeTopology').textContent = doc?.circular ? 'circular' : 'linear';
    document.getElementById('badgeTopology').className = `badge ${doc?.circular ? 'badge-circular' : ''}`;
    document.getElementById('badgeGG').hidden = !doc?.golden_gate;
    document.getElementById('badgeMoclo').hidden = !doc?.moclo_part_id;
    this.refreshStats();
  },

  refreshStats() {
    const doc = this.doc;
    const stats = document.getElementById('seqStats');
    if (!doc || !doc.sequence) { stats.replaceChildren(); return; }
    const sel = this.view.selection;
    const selLen = this.view.selectionLength();
    const parts = [
      el('span', {}, 'Length ', el('b', { text: fmt(doc.sequence.length) }), ' bp'),
      el('span', {}, 'GC ', el('b', { text: `${DNA.gc(doc.sequence).toFixed(1)}%` })),
      el('span', {}, 'Features ', el('b', { text: String(doc.features.length) })),
    ];
    if (sel && selLen > 0) {
      const sub = this.view.selectedSequence();
      parts.push(el('span', {}, 'Selection ',
        el('b', { text: `${fmt(sel.start + 1)}–${fmt(sel.end)}` }),
        ` (${fmt(selLen)} bp, GC ${DNA.gc(sub).toFixed(1)}%)`));
    } else if (sel) {
      parts.push(el('span', {}, 'Position ', el('b', { text: fmt(sel.start + 1) })));
    }
    stats.replaceChildren(...parts);
  },

  /* --- toolbar ---------------------------------------------------------- */

  bindToolbar() {
    const on = (id, fn) => document.getElementById(id).addEventListener('click', fn);

    on('btnNew', () => this.addDocument({ name: 'Untitled', sequence: '', circular: true, features: [] }));
    document.getElementById('fileInput').addEventListener('change', (e) => this.openFiles(e.target.files));
    on('btnSave', () => this.save());

    on('btnCopy', () => this.copy(this.view.selectedSequence()));
    on('btnCopyRC', () => this.copy(DNA.revComp(this.view.selectedSequence())));
    on('btnCopyProtein', () => this.copy(translateSeq(this.view.selectedSequence())));
    on('btnPaste', () => this.paste());
    on('btnDelete', () => this.deleteSelection());

    on('btnRevComp', () => this.reverseComplement());
    on('btnTopology', () => this.toggleTopology());
    on('btnOrigin', () => this.setOrigin());
    on('btnFeature', () => this.newFeature());

    const toggle = (id, key) => {
      const btn = document.getElementById(id);
      btn.addEventListener('click', () => {
        const next = !this.view.opts[key];
        btn.classList.toggle('on', next);
        this.view.setOption(key, next);
      });
    };
    toggle('tglComplement', 'showComplement');
    toggle('tglTranslation', 'showTranslation');
    toggle('tglFeatures', 'showFeatures');
    toggle('tglEnzymes', 'showEnzymes');
    document.getElementById('frameSelect').addEventListener('change', (e) => {
      this.view.setOption('translationFrame', Number(e.target.value));
      if (!this.view.opts.showTranslation) document.getElementById('tglTranslation').click();
    });

    on('tabSequence', () => this.showPane('sequence'));
    on('tabMap', () => this.showPane('map'));

    document.getElementById('docName').addEventListener('change', (e) => {
      if (this.doc) { this.doc.name = e.target.value.trim() || 'Untitled'; this.markDirty(); }
    });
    document.getElementById('chkGoldenGate').addEventListener('change', (e) => {
      if (!this.doc) return;
      this.doc.golden_gate = e.target.checked;
      document.getElementById('ggPanel').hidden = !e.target.checked;
      this.markDirty();
      if (e.target.checked) this.renderGoldenGate();
    });

    document.addEventListener('keydown', (e) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      const key = e.key.toLowerCase();
      if (key === 's') { e.preventDefault(); this.save(); }
      if (key === 'c' && this.view.selectionLength()) { e.preventDefault(); this.copy(this.view.selectedSequence()); }
      if (key === 'f') { e.preventDefault(); document.getElementById('findQuery').focus(); }
      if (key === 'a' && this.doc) {
        e.preventDefault();
        this.view.setSelection({ start: 0, end: this.doc.sequence.length });
      }
    });
  },

  showPane(which) {
    const seq = which === 'sequence';
    document.getElementById('sequencePane').hidden = !seq;
    document.getElementById('mapPane').hidden = seq;
    document.getElementById('tabSequence').classList.toggle('on', seq);
    document.getElementById('tabMap').classList.toggle('on', !seq);
    if (!seq) this.map.render(this.doc, this.sites, this.view.selection);
  },

  async openFiles(files) {
    if (!files || !files.length) return;
    const form = new FormData();
    for (const f of files) form.append('file', f);
    try {
      const { documents, errors } = await API.post('/api/sequences/parse', form);
      for (const e of errors || []) toast(`${e.filename}: ${e.error}`, 'error', 7000);
      documents.forEach((d, i) => this.addDocument(d, { activate: i === documents.length - 1 }));
      if (documents.length) toast(`Opened ${documents.length} sequence${documents.length > 1 ? 's' : ''}`, 'success');
    } catch (err) {
      toast(err.message, 'error');
    }
    document.getElementById('fileInput').value = '';
  },

  async save() {
    const doc = this.doc;
    if (!doc || !doc.sequence) { toast('Nothing to save', 'error'); return; }
    const payload = {
      document: { name: doc.name, sequence: doc.sequence, circular: doc.circular,
                  description: doc.description || '', features: doc.features },
      golden_gate: !!doc.golden_gate,
    };
    try {
      const saved = doc.id
        ? await API.put(`/api/sequences/${doc.id}`, payload)
        : await API.post('/api/sequences', payload);
      doc.id = saved.sequence.id;
      this.dirty = false;
      toast('Saved to the lab library', 'success');
      this.updateBadges();
    } catch (err) {
      toast(err.message, 'error');
    }
  },

  async copy(text) {
    if (!text) { toast('Nothing selected', 'error'); return; }
    try {
      await navigator.clipboard.writeText(text);
      toast(`Copied ${fmt(text.length)} character${text.length > 1 ? 's' : ''}`, 'success', 2000);
    } catch {
      // Clipboard needs a secure context; show the text so it can be copied by hand.
      modal({
        title: 'Copy',
        build: (body) => {
          const ta = el('textarea', { class: 'mono', rows: 8, readonly: true });
          ta.value = text;
          body.append(el('p', { class: 'hint' }, 'Select and copy:'), ta);
          ta.select();
        },
        buttons: [{ label: 'Close', kind: 'secondary' }],
      });
    }
  },

  paste() {
    const doc = this.doc;
    if (!doc) return;
    modal({
      title: 'Paste sequence',
      build: (body) => {
        body.append(
          el('p', { class: 'hint' },
            'Non-base characters and digits are ignored, so GenBank or FASTA blocks can be pasted directly.'),
          el('textarea', { id: 'pasteBox', class: 'mono', rows: 8, placeholder: 'ACGT…' }));
      },
      buttons: [
        { label: 'Cancel', kind: 'secondary' },
        {
          label: 'Insert',
          onClick: () => {
            const raw = document.getElementById('pasteBox').value;
            const seq = DNA.clean(raw);
            if (!seq) { toast('No sequence found in the pasted text', 'error'); return false; }
            this.replaceRange(this.view.selection, seq);
            toast(`Inserted ${fmt(seq.length)} bp`, 'success');
            return true;
          },
        },
      ],
    });
  },

  /* --- editing ---------------------------------------------------------- */

  /**
   * Replace a range with new text and move every feature accordingly.
   * Features inside the removed range are dropped; features spanning it are
   * shortened. A null range inserts at the caret.
   */
  replaceRange(range, text) {
    const doc = this.doc;
    if (!doc) return;
    const n = doc.sequence.length;
    const start = range ? range.start : n;
    const end = range ? (range.end > range.start ? range.end : range.start) : start;
    const removed = end - start;
    const delta = text.length - removed;

    doc.sequence = doc.sequence.slice(0, start) + text + doc.sequence.slice(end);

    const shift = (p) => {
      if (p <= start) return p;
      if (p >= end) return p + delta;
      return start + text.length;   // inside the replaced range
    };
    doc.features = doc.features
      .map((f) => {
        const g = { ...f };
        if (f.end > f.start) {
          g.start = shift(f.start);
          g.end = shift(f.end);
        } else {
          // A feature wrapping the origin: shift each half independently.
          g.start = shift(f.start);
          g.end = shift(f.end);
        }
        if (g.segments) g.segments = g.segments.map(([s, e]) => [shift(s), shift(e)]);
        return g;
      })
      .filter((f) => f.end !== f.start);

    this.view.selection = { start, end: start + text.length };
    this.markDirty();
  },

  deleteSelection() {
    const len = this.view.selectionLength();
    if (!len) { toast('Nothing selected', 'error'); return; }
    this.replaceRange(this.view.selection, '');
    this.view.selection = null;
    this.markDirty();
    toast(`Deleted ${fmt(len)} bp`, 'success', 2000);
  },

  reverseComplement() {
    const doc = this.doc;
    if (!doc || !doc.sequence) return;
    const n = doc.sequence.length;
    doc.sequence = DNA.revComp(doc.sequence);
    doc.features = doc.features.map((f) => ({
      ...f,
      start: doc.circular ? (n - f.end + n) % n : n - f.end,
      end: n - f.start,
      strand: f.strand === -1 ? 1 : -1,
      segments: f.segments ? f.segments.map(([s, e]) => [n - e, n - s]).reverse() : undefined,
    }));
    this.view.selection = null;
    this.markDirty();
    toast('Sequence reverse complemented', 'success', 2000);
  },

  toggleTopology() {
    const doc = this.doc;
    if (!doc) return;
    if (doc.circular && doc.features.some((f) => f.end <= f.start)) {
      toast('Linearise at a point outside the features that cross the origin first', 'error', 6000);
      return;
    }
    doc.circular = !doc.circular;
    this.markDirty();
    toast(doc.circular ? 'Now circular' : 'Now linear', 'success', 2000);
  },

  setOrigin() {
    const doc = this.doc;
    const sel = this.view.selection;
    if (!doc || !doc.circular) { toast('Only a circular sequence has a movable origin', 'error'); return; }
    if (!sel) { toast('Click the base that should become position 1', 'error'); return; }
    const k = sel.start;
    const n = doc.sequence.length;
    doc.sequence = doc.sequence.slice(k) + doc.sequence.slice(0, k);
    doc.features = doc.features.map((f) => ({
      ...f,
      start: (f.start - k + n) % n,
      end: ((f.end - k + n) % n) || n,
      segments: f.segments ? f.segments.map(([s, e]) => [(s - k + n) % n, ((e - k + n) % n) || n]) : undefined,
    }));
    this.view.selection = null;
    this.markDirty();
    toast(`Origin moved to ${fmt(k + 1)}`, 'success');
  },

  /* --- features --------------------------------------------------------- */

  renderFeatures() {
    const doc = this.doc;
    const list = document.getElementById('featureList');
    document.getElementById('featureCount').textContent = doc?.features.length || '';
    if (!doc || !doc.features.length) {
      list.replaceChildren(el('li', { class: 'empty' }, 'No features. Select bases and choose “Add feature”.'));
      return;
    }
    const n = doc.sequence.length;
    const sorted = [...doc.features].sort((a, b) => a.start - b.start);
    list.replaceChildren(...sorted.map((f) => el('li', {
      class: 'item',
      onclick: (ev) => {
        if (ev.target.closest('button')) return;
        this.view.setSelection({ start: f.start, end: f.end });
        this.scrollToPosition(f.start);
      },
    },
      el('span', { class: 'item-name' },
        el('span', { style: `display:inline-block;width:.6rem;height:.6rem;border-radius:2px;margin-right:.4rem;background:${featureColor(f)}` }),
        `${f.name} `,
        el('span', { class: 'item-meta' }, f.type)),
      el('span', { class: 'item-meta' },
        `${fmt(DNA.featLength(f, n))} bp ${f.strand === -1 ? '←' : '→'} `,
        el('button', { class: 'tool-btn', title: 'Edit feature', onclick: () => this.editFeature(f) }, '✎')),
    )));
  },

  newFeature() {
    const sel = this.view.selection;
    if (!this.view.selectionLength()) { toast('Select the bases for the feature first', 'error'); return; }
    this.editFeature({ id: null, name: '', type: 'misc_feature', start: sel.start, end: sel.end, strand: 1 });
  },

  editFeature(feature) {
    const doc = this.doc;
    if (!doc) return;
    const isNew = !feature.id;
    modal({
      title: isNew ? 'Add feature' : `Edit “${feature.name}”`,
      build: (body) => {
        body.append(
          el('div', { class: 'field' },
            el('label', { for: 'fName' }, 'Name'),
            el('input', { type: 'text', id: 'fName', value: feature.name || '' })),
          el('div', { class: 'field-row' },
            el('div', { class: 'field' },
              el('label', { for: 'fType' }, 'Type'),
              el('select', { id: 'fType' }, FEATURE_TYPES.map((t) =>
                el('option', { value: t, text: t, selected: t === feature.type })))),
            el('div', { class: 'field' },
              el('label', { for: 'fStrand' }, 'Strand'),
              el('select', { id: 'fStrand' },
                el('option', { value: '1', text: 'Forward →', selected: feature.strand !== -1 }),
                el('option', { value: '-1', text: 'Reverse ←', selected: feature.strand === -1 })))),
          el('div', { class: 'field-row' },
            el('div', { class: 'field' },
              el('label', { for: 'fStart' }, 'Start (1-based)'),
              el('input', { type: 'number', id: 'fStart', value: String(feature.start + 1), min: '1' })),
            el('div', { class: 'field' },
              el('label', { for: 'fEnd' }, 'End'),
              el('input', { type: 'number', id: 'fEnd', value: String(feature.end), min: '1' })),
            el('div', { class: 'field' },
              el('label', { for: 'fColor' }, 'Colour'),
              el('input', { type: 'color', id: 'fColor', value: featureColor(feature) }))),
          el('p', { class: 'hint' },
            doc.circular
              ? 'On a circular sequence a feature may wrap: give a start larger than its end.'
              : ''),
        );
      },
      buttons: [
        !isNew && {
          label: 'Add to library',
          kind: 'secondary',
          onClick: async () => {
            await API.post('/api/library', { document: this.payloadDoc(), feature_id: feature.id });
            toast(`“${feature.name}” added to the feature library`, 'success');
          },
        },
        !isNew && {
          label: 'Delete',
          kind: 'danger',
          onClick: () => {
            doc.features = doc.features.filter((f) => f.id !== feature.id);
            this.markDirty();
          },
        },
        { label: 'Cancel', kind: 'secondary' },
        {
          label: isNew ? 'Add' : 'Save',
          onClick: () => {
            const name = document.getElementById('fName').value.trim();
            const start = Number(document.getElementById('fStart').value) - 1;
            const end = Number(document.getElementById('fEnd').value);
            const n = doc.sequence.length;
            if (!name) { toast('A feature needs a name', 'error'); return false; }
            if (!(start >= 0 && start < n && end > 0 && end <= n) || start === end) {
              toast(`Positions must lie within 1–${n}`, 'error');
              return false;
            }
            if (end < start && !doc.circular) {
              toast('Only a circular sequence can have a feature that wraps', 'error');
              return false;
            }
            const next = {
              id: feature.id || `f${Date.now().toString(36)}`,
              name,
              type: document.getElementById('fType').value,
              strand: Number(document.getElementById('fStrand').value),
              start,
              end,
              color: document.getElementById('fColor').value,
              qualifiers: feature.qualifiers || {},
            };
            doc.features = isNew
              ? [...doc.features, next]
              : doc.features.map((f) => (f.id === feature.id ? next : f));
            this.markDirty();
            return true;
          },
        },
      ].filter(Boolean),
    });
  },

  scrollToPosition(pos) {
    const width = this.view.opts.width;
    const blocks = document.querySelectorAll('.seqmap-block');
    const target = blocks[Math.floor(pos / width)];
    target?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  },

  payloadDoc() {
    const d = this.doc;
    return { name: d.name, sequence: d.sequence, circular: d.circular,
             description: d.description || '', features: d.features };
  },

  /* --- enzymes ---------------------------------------------------------- */

  async refreshSites() {
    const doc = this.doc;
    if (!doc || !doc.sequence) { this.sites = []; this.view.setSites([]); this.renderEnzymeTable({}, []); return; }
    const enzymes = this.enzymeSets[this.activeSet] || [];
    if (!enzymes.length) return;
    try {
      const body = await API.post('/api/tools/sites', {
        document: this.payloadDoc(),
        enzymes,
        unique_only: document.getElementById('chkUniqueOnly').checked,
      });
      this.sites = body.sites;
      this.view.setSites(body.sites);
      this.renderEnzymeTable(body.counts, body.non_cutters);
      if (!document.getElementById('mapPane').hidden) this.map.render(doc, this.sites, this.view.selection);
    } catch (err) {
      toast(err.message, 'error');
    }
  },

  renderEnzymeTable(counts, nonCutters) {
    const filter = document.getElementById('enzymeFilter').value.trim().toLowerCase();
    const showNon = document.getElementById('chkNonCutters').checked;
    const byEnzyme = new Map();
    for (const s of this.sites) {
      byEnzyme.set(s.enzyme, (byEnzyme.get(s.enzyme) || []).concat(s.cut_top ?? s.start));
    }
    const rows = [];
    for (const [enzyme, positions] of [...byEnzyme].sort((a, b) => a[0].localeCompare(b[0]))) {
      if (filter && !enzyme.toLowerCase().includes(filter)) continue;
      rows.push(el('tr', {
        style: 'cursor:pointer',
        onclick: () => {
          this.view.setHighlights(positions.map((p) => ({ start: p, end: p + 1, class: 'hit' })));
          this.scrollToPosition(positions[0]);
        },
      },
        el('td', { text: enzyme }),
        el('td', { class: 'num', text: String(positions.length) }),
        el('td', { class: 'mono', style: 'font-size:.75rem',
          text: positions.slice(0, 6).map((p) => p + 1).join(', ') + (positions.length > 6 ? '…' : '') })));
    }
    if (showNon) {
      for (const enzyme of nonCutters || []) {
        if (filter && !enzyme.toLowerCase().includes(filter)) continue;
        rows.push(el('tr', { class: 'muted' },
          el('td', { text: enzyme }), el('td', { class: 'num', text: '0' }), el('td', { text: '—' })));
      }
    }
    document.getElementById('enzymeRows').replaceChildren(
      ...(rows.length ? rows : [el('tr', {}, el('td', { colspan: '3', class: 'empty' }, 'No sites found.'))]));
  },

  /* --- find ------------------------------------------------------------- */

  bindPanels() {
    document.getElementById('btnFind').addEventListener('click', () => this.runFind());
    document.getElementById('findQuery').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.runFind();
    });
    document.getElementById('btnFindNext').addEventListener('click', () => this.findNext());
    document.getElementById('btnFindClear').addEventListener('click', () => {
      this.findHits = [];
      this.findAt = -1;
      this.view.setHighlights([]);
      document.getElementById('findStatus').textContent = '';
      document.getElementById('findQuery').value = '';
    });
    document.getElementById('enzymeFilter').addEventListener('input',
      () => this.renderEnzymeTable({}, this.lastNonCutters || []));
    document.getElementById('chkNonCutters').addEventListener('change', () => this.refreshSites());
    document.getElementById('chkUniqueOnly').addEventListener('change', () => this.refreshSites());

    document.getElementById('btnOrfs').addEventListener('click', () => Tools.orfs());
    document.getElementById('btnAnnotate').addEventListener('click', () => Tools.annotate());
    document.getElementById('btnDigest').addEventListener('click', () => Tools.digest());
    document.getElementById('btnSilent').addEventListener('click', () => Tools.silentSites());
    document.getElementById('btnPrimer').addEventListener('click', () => Tools.designPrimers());
    document.getElementById('btnPcr').addEventListener('click', () => Tools.pcr());
  },

  async runFind() {
    const query = document.getElementById('findQuery').value.trim();
    const mode = document.getElementById('findMode').value;
    if (!query || !this.doc) return;
    try {
      const { hits } = await API.post('/api/tools/find', { document: this.payloadDoc(), query, mode });
      this.findHits = hits;
      this.findAt = -1;
      this.view.setHighlights(hits.map((h) => ({ start: h.start, end: h.end, class: 'hit' })));
      document.getElementById('findStatus').textContent =
        hits.length ? `${hits.length} match${hits.length > 1 ? 'es' : ''}` : 'No matches';
      if (hits.length) this.findNext();
    } catch (err) {
      toast(err.message, 'error');
    }
  },

  findNext() {
    if (!this.findHits.length) return;
    this.findAt = (this.findAt + 1) % this.findHits.length;
    const hit = this.findHits[this.findAt];
    this.view.setSelection({ start: hit.start, end: hit.end });
    this.scrollToPosition(hit.start);
    document.getElementById('findStatus').textContent =
      `Match ${this.findAt + 1} of ${this.findHits.length} at ${fmt(hit.start + 1)}${hit.strand === -1 ? ' (reverse)' : ''}`;
  },

  /* --- Golden Gate / MoClo --------------------------------------------- */

  async renderGoldenGate() {
    const doc = this.doc;
    const panel = document.getElementById('ggPanel');
    if (!doc || !doc.golden_gate || !doc.sequence) { panel.replaceChildren(); return; }
    panel.replaceChildren(el('div', { class: 'hint' }, el('span', { class: 'spin' }), ' Checking for a releasable part…'));
    try {
      const result = await API.post('/api/sequences/golden-gate/analyze', { document: this.payloadDoc() });
      this.ggResult = result;
      panel.replaceChildren(this.goldenGateSummary(result));
    } catch (err) {
      panel.replaceChildren(el('div', { class: 'alert alert-error', text: err.message }));
    }
  },

  goldenGateSummary(result) {
    if (!result.ready) {
      const reasons = (result.candidates || []).filter((c) => c.reason);
      return el('div', { class: 'alert alert-warning' },
        el('div', {}, 'No single clean Golden Gate insert was found, so this cannot be added to the MoClo parts library yet.'),
        reasons.length
          ? el('ul', { style: 'margin:.35rem 0 0 1.1rem;font-size:.8125rem' },
            reasons.map((c) => el('li', { text: `${c.enzyme}: ${c.reason}` })))
          : el('div', { class: 'hint' }, 'No Type IIS sites were found at all.'));
    }
    const best = result.best;
    const ins = best.insert;
    const canContribute = result.moclo_available?.parts;
    return el('div', { class: 'alert alert-success' },
      el('div', {},
        el('b', {}, `${best.enzyme} releases a ${fmt(ins.part_length)} bp part`),
        ` — overhangs `,
        el('span', { class: 'mono' }, ins.overhang_5prime), ' … ',
        el('span', { class: 'mono' }, ins.overhang_3prime),
        best.standard_moclo ? ' (standard MoClo fusion sites)' : ' (non-standard fusion sites)'),
      el('div', { class: 'hint' },
        `Suggested part type: ${result.suggested_part_type}. `,
        `${(result.suggested_features || []).length} feature(s) would travel with the part.`),
      el('div', { class: 'btn-group', style: 'margin-top:.5rem' },
        el('button', {
          class: 'btn btn-sm',
          disabled: !canContribute || !this.doc.id,
          title: !this.doc.id ? 'Save the sequence first'
            : !canContribute ? 'The shared MoClo parts database is not mounted on this server' : '',
          onclick: () => this.contribute(result),
        }, '➕ Add to MoClo parts library'),
        this.doc.moclo_part_id
          ? el('span', { class: 'hint' }, 'Already contributed.')
          : !this.doc.id ? el('span', { class: 'hint' }, 'Save this sequence to enable contributing.')
            : !canContribute ? el('span', { class: 'hint' }, 'Shared MoClo database not available here.') : null));
  },

  contribute(result) {
    const doc = this.doc;
    const best = result.best;
    modal({
      title: 'Add to the MoClo parts library',
      wide: true,
      build: (body) => {
        body.append(
          el('p', { class: 'hint' },
            'The part is written to the MoClo Library Tool’s shared parts database, ',
            'with both fusion sites included, so it can be used in assemblies there straight away.'),
          el('div', { class: 'field' },
            el('label', { for: 'cName' }, 'Part name'),
            el('input', { type: 'text', id: 'cName', value: doc.name })),
          el('div', { class: 'field-row' },
            el('div', { class: 'field' },
              el('label', { for: 'cType' }, 'Part type'),
              el('select', { id: 'cType' }, ['Coding', 'NonCodingPromoter', 'NonCodingTerminator',
                'NonCodingIntron', 'NonCodingOther', 'ExpressionCassette'].map((t) =>
                el('option', { value: t, text: t, selected: t === result.suggested_part_type })))),
            el('div', { class: 'field' },
              el('label', { for: 'cLab' }, 'Lab source'),
              el('input', { type: 'text', id: 'cLab', placeholder: 'Gardiner Lab' }))),
          el('div', { class: 'field' },
            el('label', { for: 'cDesc' }, 'Description'),
            el('input', { type: 'text', id: 'cDesc', value: doc.description || '' })),
          el('div', { class: 'field-row' },
            el('div', { class: 'field' },
              el('label', { for: 'cPlasmid' }, 'Plasmid ID'),
              el('input', { type: 'text', id: 'cPlasmid', placeholder: 'pICH41373' })),
            el('div', { class: 'field' },
              el('label', { for: 'cAntibiotic' }, 'Antibiotic'),
              el('input', { type: 'text', id: 'cAntibiotic', placeholder: 'Carbenicillin' })),
            el('div', { class: 'field' },
              el('label', { for: 'cLevel' }, 'MoClo level'),
              el('input', { type: 'text', id: 'cLevel', placeholder: '0' }))),
          el('div', { class: 'field-row' },
            el('div', { class: 'field' },
              el('label', { for: 'cLoc80' }, '−80 location'),
              el('input', { type: 'text', id: 'cLoc80' })),
            el('div', { class: 'field' },
              el('label', { for: 'cPlate' }, '96-well location'),
              el('input', { type: 'text', id: 'cPlate' }))),
          el('div', { class: 'alert alert-info' },
            el('span', { class: 'mono' },
              `${best.insert.overhang_5prime} … ${best.insert.overhang_3prime}`),
            ` · ${fmt(best.insert.part_length)} bp · released by ${best.enzyme}`));
      },
      buttons: [
        { label: 'Cancel', kind: 'secondary' },
        {
          label: 'Add part',
          onClick: async () => {
            const name = document.getElementById('cName').value.trim();
            const lab = document.getElementById('cLab').value.trim();
            if (!name) { toast('A part name is required', 'error'); return false; }
            const payload = {
              name,
              part_type: document.getElementById('cType').value,
              lab_source: lab,
              description: document.getElementById('cDesc').value.trim(),
              enzyme: best.enzyme,
              metadata: {
                plasmid_id: document.getElementById('cPlasmid').value.trim(),
                antibiotic: document.getElementById('cAntibiotic').value.trim(),
                level: document.getElementById('cLevel').value.trim(),
                location_80: document.getElementById('cLoc80').value.trim(),
                location_96_plate: document.getElementById('cPlate').value.trim(),
              },
            };
            const res = await API.post(`/api/sequences/${doc.id}/contribute`, payload);
            doc.moclo_part_id = res.contributed.part_id;
            this.updateBadges();
            this.renderGoldenGate();
            toast(`“${res.contributed.name}” added to the MoClo parts library`, 'success', 6000);
            return true;
          },
        },
      ],
    });
  },
};

document.addEventListener('DOMContentLoaded', () => Editor.init());
