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
  enzymeSets: {},        // built-in sets, by name
  enzymeLists: [],       // the person's own lists, saved to their account
  selection: null,       // enzymes chosen to show without saving them as a list
  catalog: null,         // every enzyme, loaded when the chooser first opens
  activeSet: 'Default',  // a set's name, "list:<id>", or "selection"
  findHits: [],
  findAt: -1,
  // Whether the open sequence has unsaved changes: each tab keeps its own.
  get dirty() { return !!this.doc?.dirty; },
  set dirty(value) { if (this.doc) this.doc.dirty = !!value; },

  get doc() { return this.index >= 0 ? this.docs[this.index] : null; },

  async init() {
    this.view = new SeqView(document.getElementById('sequencePane'));
    this.map = new PlasmidMap(document.getElementById('mapPane'));
    this.view.onSelect = () => this.refreshStats();
    this.view.onCaret = () => this.refreshStats();
    // One click on a feature or an enzyme name highlights its bases; a double
    // click opens the feature's settings or the enzyme's details.
    for (const pane of [this.view, this.map]) {
      pane.onFeatureClick = (f) => this.selectRange({ start: f.start, end: f.end });
      pane.onFeatureDblClick = (f) => this.editFeature(f);
      pane.onSiteClick = (site) => this.selectRange({ start: site.start, end: site.end });
      pane.onSiteDblClick = (site) => this.showSite(site);
    }
    // Typing, Backspace and Delete in the sequence view land here.
    this.view.onEdit = ({ start, end, text }) => {
      this.replaceRange({ start, end }, text, { collapse: true });
    };

    this.bindToolbar();
    this.keepSidePanelsUnderToolbar();
    this.bindPanels();

    try {
      const { sets, lists, choice } = await API.get('/api/tools/enzymes');
      this.enzymeSets = sets;
      this.enzymeLists = lists || [];
      if (choice && (sets[choice] || this.enzymeLists.some((l) => `list:${l.id}` === choice))) this.activeSet = choice;
      this.renderEnzymeChoices();
      document.getElementById('enzymeSet').addEventListener('change', (e) => this.useEnzymes(e.target.value));
      document.getElementById('btnEnzymeLists').addEventListener('click', () => this.chooseEnzymes());
    } catch (err) {
      toast(err.message, 'error');
    }

    // The tabs open before (this sign-in's, until signing out), then a
    // sequence passed as ?open=<id>, switching to it if it is already open.
    await this.restoreWorkspace();
    const open = new URLSearchParams(location.search).get('open');
    const already = open ? this.docs.findIndex((d) => d.id === open) : -1;
    if (already >= 0) {
      this.setActive(already);
    } else if (open) {
      await this.openStored(open);
    } else if (!this.docs.length) {
      this.addDocument({ name: 'Untitled', sequence: '', circular: true, features: [] });
    }
    this._workspaceReady = true;
    this.saveWorkspace();

    // Leaving the page sends the tabs one last time; only if that cannot work
    // (they were too large to keep) is there anything to warn about.
    window.addEventListener('pagehide', () => this.saveWorkspace({ now: true }));
    window.addEventListener('beforeunload', (e) => {
      if (this._workspaceFailed && this.docs.some((d) => d.dirty)) { e.preventDefault(); e.returnValue = ''; }
    });
  },

  /**
   * The side columns stick just under the toolbar (see .editor-side), whose
   * height changes as it wraps onto more lines; follow it.
   */
  keepSidePanelsUnderToolbar() {
    const toolbar = document.getElementById('toolbar');
    if (!toolbar) return;
    const place = () => {
      const top = parseFloat(getComputedStyle(toolbar).top) || 0;
      const gap = parseFloat(getComputedStyle(toolbar).marginBottom) || 12;
      document.documentElement.style.setProperty('--side-top', `${top + toolbar.offsetHeight + gap}px`);
    };
    place();
    if ('ResizeObserver' in window) new ResizeObserver(place).observe(toolbar);
    window.addEventListener('resize', place);
  },

  /* --- open tabs, kept until signing out ------------------------------- */
  //
  // Every open sequence, unsaved edits included, is saved for this sign-in
  // (app/api/workspace.py) and reopened when the editor next loads.

  async restoreWorkspace() {
    try {
      const { workspace } = await API.get('/api/workspace');
      if (!workspace?.docs?.length) return;
      for (const doc of workspace.docs) this.addDocument(doc, { activate: false });
      this.setActive(Math.min(workspace.active || 0, this.docs.length - 1));
    } catch { /* nothing remembered: start afresh */ }
  },

  /** Save the open tabs, shortly after the last change, or at once as the page closes. */
  saveWorkspace({ now = false } = {}) {
    if (!this._workspaceReady) return;
    clearTimeout(this._workspaceTimer);
    const send = () => {
      const body = JSON.stringify({ docs: this.docs, active: Math.max(this.index, 0) });
      if (now && navigator.sendBeacon) {
        navigator.sendBeacon(url('/api/workspace'), new Blob([body], { type: 'text/plain' }));
        return;
      }
      fetch(url('/api/workspace'), { method: 'PUT', credentials: 'same-origin',
                                     headers: { 'Content-Type': 'application/json' }, body })
        .then((res) => {
          const failed = res.status === 413;
          if (failed && !this._workspaceFailed) {
            toast('Too much is open to remember after a reload; save or close some sequences.', 'error', 8000);
          }
          this._workspaceFailed = failed;
        })
        .catch(() => {});
    };
    if (now) send(); else this._workspaceTimer = setTimeout(send, 800);
  },

  /** Close a tab, asking first if it has changes not saved to the library. */
  async closeDocument(i) {
    const doc = this.docs[i];
    if (!doc) return;
    if (doc.dirty && !(await confirmDialog(`Close “${doc.name || 'Untitled'}”?`,
      'It has changes not saved to the lab library, which will be lost.', 'Close without saving'))) {
      return;
    }
    this.docs.splice(i, 1);
    // Undo history follows its own tab; the tabs after this one move up a place.
    for (const stack of [this.undoStack, this.redoStack]) {
      for (let k = stack.length - 1; k >= 0; k--) {
        if (stack[k].index === i) stack.splice(k, 1);
        else if (stack[k].index > i) stack[k].index -= 1;
      }
    }
    this.updateUndoButtons();
    if (!this.docs.length) {
      this.index = -1;
      this.addDocument({ name: 'Untitled', sequence: '', circular: true, features: [] });
      return;
    }
    const next = i < this.index ? this.index - 1 : Math.min(this.index, this.docs.length - 1);
    this.setActive(next);
  },

  /* --- document handling ------------------------------------------------ */

  addDocument(doc, { activate = true } = {}) {
    doc.features = doc.features || [];
    doc.translations = doc.translations || [];
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
    this.showPublic(doc);
    this.view.setDocument(doc || { sequence: '', features: [] });
    this.renderDocList();
    this.renderFeatures();
    this.renderTranslations();
    this.refreshSites();
    this.updateBadges();
    this.renderGoldenGate();
    this.refreshMocloLink();
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
      class: `item doc-tab ${i === this.index ? 'active' : ''}`,
      title: d.dirty ? 'Unsaved changes' : (d.id ? 'Saved in the lab library' : 'Not saved yet'),
      onclick: (ev) => { if (!ev.target.closest('.doc-close') && i !== this.index) this.setActive(i); },
    },
      el('span', { class: 'item-name' },
        d.dirty ? el('span', { class: 'doc-unsaved', 'aria-label': 'unsaved' }, '●') : null,
        d.name || 'Untitled'),
      el('span', { class: 'item-meta' },
        `${fmt(d.sequence.length)} bp${d.circular ? ' ○' : ''}`,
        el('button', { class: 'doc-close', type: 'button', title: 'Close', 'aria-label': `Close ${d.name || 'Untitled'}`,
                       onclick: () => this.closeDocument(i) }, '×')),
    )));
    this.saveWorkspace();
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
    this.view.setDocument(doc, { keepSelection: true });
    this.renderFeatures();
    this.renderTranslations();
    // Re-scanning for restriction sites costs ~120 ms on a 150 kb sequence with
    // the default enzymes, and seconds with the full REBASE set, so it waits
    // until typing pauses rather than running on every keystroke.
    this.scheduleSiteRefresh();
    this.renderDocList();
    this.updateBadges();
    if (!document.getElementById('mapPane').hidden) this.map.render(doc, this.sites, this.view.selection);
  },

  scheduleSiteRefresh(delay = 350) {
    clearTimeout(this._sitesTimer);
    this._sitesTimer = setTimeout(() => this.refreshSites(), delay);
  },

  updateBadges() {
    const doc = this.doc;
    document.getElementById('badgeTopology').textContent = doc?.circular ? 'circular' : 'linear';
    document.getElementById('badgeTopology').className = `badge ${doc?.circular ? 'badge-circular' : ''}`;
    document.getElementById('badgeGG').hidden = !doc?.golden_gate;
    const moclo = document.getElementById('badgeMoclo');
    moclo.hidden = !(doc?.moclo_part_id || doc?.moclo_link);
    moclo.textContent = doc?.moclo_link ? 'Linked to MoClo' : 'In MoClo library';
    this.showStocks(doc);
    const confirmed = document.getElementById('badgeConfirmed');
    const unsequenced = document.getElementById('badgeUnsequenced');
    if (unsequenced) unsequenced.hidden = !doc?.sequence || !!doc?.confirmed;
    if (confirmed) {
      confirmed.hidden = !doc?.confirmed;
      if (doc?.confirmed) {
        confirmed.title = [
          doc.glycerol_stock ? `Glycerol stock ${doc.glycerol_stock}` : null,
          doc.confirmed_clone ? `clone ${doc.confirmed_clone}` : null,
          doc.confirmed_by ? `confirmed by ${doc.confirmed_by}` : null,
          'click to see the sequencing reads',
        ].filter(Boolean).join(' · ');
      }
    }
    const unsaved = document.getElementById('badgeUnsaved');
    if (unsaved) unsaved.hidden = !this.dirty;
    // The tab's unsaved mark follows too (and the open tabs are saved).
    this.renderDocList();
    this.updateUndoButtons();
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
    on('badgeConfirmed', () => this.openSequencing());
    on('badgeUnsequenced', () => this.openSequencing());
    on('btnSaveAs', () => this.saveAs());
    on('btnHistory', () => {
      const doc = this.doc;
      if (!doc?.id) { toast('Save it to the lab library first: the history starts there', 'error'); return; }
      showHistory(doc.id, { unsaved: this.dirty, onRestored: (sequence) => this.replaceWithStored(doc, sequence) });
    });
    on('btnUndo', () => this.undo());
    on('btnRedo', () => this.redo());

    on('btnCopy', () => this.copy(this.view.selectedSequence()));
    on('btnCopyRC', () => this.copy(DNA.revComp(this.view.selectedSequence())));
    // The amino acids chosen on a translation's row, read on its own strand;
    // otherwise the selected bases translated forward.
    on('btnCopyProtein', () => {
      const protein = this.view.selectedProtein();
      this.copy(protein ?? translateSeq(this.view.selectedSequence()), 'amino acid');
    });
    on('btnPaste', () => this.paste());
    on('btnDelete', () => this.deleteSelection());

    on('btnRevComp', () => this.reverseComplement());
    on('btnTopology', () => this.toggleTopology());
    on('btnOrigin', () => this.setOrigin());
    on('btnFeature', () => this.newFeature());
    on('btnTranslateSel', () => this.translateSelection());

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
    document.getElementById('chkPublic').addEventListener('change', async (e) => {
      if (!this.doc) return;
      const checked = e.target.checked;
      this.doc.public = checked;
      // Like Golden Gate: a property of the plasmid, saved at once once it is saved.
      if (this.doc.id) {
        try {
          await API.patch(`/api/sequences/${this.doc.id}`, { public: checked, sync: false });
          toast(checked ? 'Public: every lab can open it' : 'Seen by your labs only', 'success', 2500);
        } catch (err) {
          toast(`Could not change who sees it: ${err.message}`, 'error');
          this.doc.public = !checked;
          e.target.checked = !checked;
        }
      } else {
        this.markDirty();
      }
      this.showPublic(this.doc);
    });
    document.getElementById('chkGoldenGate').addEventListener('change', async (e) => {
      if (!this.doc) return;
      const checked = e.target.checked;
      this.doc.golden_gate = checked;
      document.getElementById('ggPanel').hidden = !checked;
      if (checked) this.renderGoldenGate();
      // Persist the flag straight away. It is a property of the sequence
      // rather than an edit to it, and contributing reads it from the server.
      if (this.doc.id) {
        try {
          await API.patch(`/api/sequences/${this.doc.id}`, { golden_gate: checked, sync: false });
        } catch (err) {
          toast(`Could not save the Golden Gate setting: ${err.message}`, 'error');
          this.doc.golden_gate = !checked;
          e.target.checked = !checked;
          document.getElementById('ggPanel').hidden = checked;
          return;
        }
      } else {
        this.markDirty();
      }
      this.updateBadges();
    });

    document.addEventListener('keydown', (e) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      // Leave the browser's own editing shortcuts alone inside form fields.
      const tag = (e.target.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select' || e.target.isContentEditable) return;
      const key = e.key.toLowerCase();
      if (key === 's') {
        e.preventDefault();
        e.shiftKey ? this.saveAs() : this.save();
      }
      if (key === 'z' && !e.shiftKey) { e.preventDefault(); this.undo(); }
      if ((key === 'z' && e.shiftKey) || key === 'y') { e.preventDefault(); this.redo(); }
      if (key === 'c' && this.view.selectionLength()) {
        e.preventDefault();
        // Amino acids when they were chosen on a translation's row, else bases.
        const protein = this.view.selectedProtein();
        if (protein) this.copy(protein, 'amino acid'); else this.copy(this.view.selectedSequence(), 'base');
      }
      if (key === 'v') { e.preventDefault(); this.paste(); }
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

  /** The "Public" tick: this plasmid's setting, and whether this person may change it. */
  showPublic(doc) {
    const box = document.getElementById('chkPublic');
    if (!box) return;
    box.checked = !!doc?.public;
    const locked = !!(doc?.id && doc.can_change === false);
    box.disabled = locked;
    document.getElementById('publicHint').textContent = locked
      ? 'Only its owner, their lab leads and administrators change who sees it.'
      : 'Unticked, it is seen by your labs only (everyone in them).';
  },

  async save({ force = false, overwrite = false } = {}) {
    const doc = this.doc;
    if (!doc || !doc.sequence) { toast('Nothing to save', 'error'); return; }
    const payload = {
      document: this.payloadDoc(),
      golden_gate: !!doc.golden_gate,
      public: !!doc.public,
      ...(force ? { force: true } : {}),
      // The version this was opened at, so a newer one saved meanwhile (by
      // someone else, or a correction to a read) is not overwritten unseen.
      ...(doc.id && doc.revision !== undefined && !overwrite ? { base_revision: doc.revision } : {}),
    };
    try {
      const saved = doc.id
        ? await API.put(`/api/sequences/${doc.id}`, payload)
        : await API.post('/api/sequences', payload);
      doc.id = saved.sequence.id;
      doc.moclo_link = saved.sequence.moclo_link;
      doc.revision = saved.sequence.revision;
      this.dirty = false;
      if (saved.synced_to_moclo) {
        toast(`Saved, and the MoClo ${saved.synced_to_moclo.kind} updated to match`, 'success', 5000);
      } else {
        toast('Saved to the lab library', 'success');
      }
      this.updateBadges();
      this.refreshMocloLink();
      return true;
    } catch (err) {
      if (err.payload?.stale) { this.resolveStale(doc, err.payload); return false; }
      // A 409 means the local save worked but MoClo was not updated.
      if (err.payload?.conflict) {
        doc.revision = err.payload.sequence?.revision ?? doc.revision;
        this.dirty = false;
        this.updateBadges();
        this.resolveConflict(err.payload);
        return false;
      }
      if (err.payload?.sync_failed) {
        doc.revision = err.payload.sequence?.revision ?? doc.revision;
        this.dirty = false;
        this.updateBadges();
        this.refreshMocloLink();
        toast(`Saved here, but MoClo was not updated: ${err.message}`, 'error', 9000);
        return false;
      }
      toast(err.message, 'error');
      return false;
    }
  },

  /**
   * The sequence was saved by someone else (or corrected to a read) since it
   * was opened here: keep this version over it, or take the saved one. Either
   * way nothing is lost, since the history keeps every version.
   */
  resolveStale(doc, payload) {
    const latest = payload.latest || {};
    modal({
      title: 'Changed since you opened it',
      build: (body) => body.append(
        el('div', { class: 'alert alert-warning' },
          el('b', { text: doc.name }), ' was saved again after you opened it: ',
          `${REVISION_KINDS[latest.kind] || latest.kind || 'a change'}`,
          latest.note ? ` (${latest.note})` : '',
          latest.changed_by ? ` by ${latest.changed_by}` : '',
          latest.created_at ? `, ${localTime(latest.created_at)}` : '', '.'),
        el('p', { class: 'hint' },
          'Save yours over it, or open the saved version instead of your changes. '
          + 'Either way the other stays in the history, and can be rolled back to.')),
      buttons: [
        { label: 'Cancel', kind: 'secondary' },
        {
          label: 'Open the saved version', kind: 'secondary',
          onClick: async () => {
            const { sequence } = await API.get(`/api/sequences/${doc.id}`);
            this.replaceWithStored(doc, sequence);
            toast('Opened the saved version', 'success');
            return true;
          },
        },
        { label: 'Save mine over it', onClick: async () => { await this.save({ overwrite: true }); return true; } },
      ],
    });
  },

  /** Show the stored version of a sequence in its tab, in place of what was there. */
  replaceWithStored(doc, sequence) {
    // Ctrl+Z still brings back what the tab held, unsaved edits included.
    const i = this.docs.indexOf(doc);
    if (i >= 0 && i !== this.index) this.setActive(i);
    if (i >= 0) this.pushUndo();
    for (const key of ['name', 'sequence', 'circular', 'description', 'features', 'translations',
                       'revision', 'moclo_link', 'golden_gate', 'public', 'can_change']) {
      if (sequence[key] !== undefined) doc[key] = sequence[key];
    }
    doc.features = doc.features || [];
    doc.translations = doc.translations || [];
    if (i >= 0) this.setActive(i);
    this.dirty = false;
    this.markDirty();
    this.dirty = false;
    this.updateBadges();
    this.refreshSites?.();
  },

  /**
   * Open this plasmid on the Sequencing page. Reads are aligned to the saved
   * plasmid, so one never saved has to be saved first, and unsaved changes are
   * offered a save. The open tabs, unsaved changes included, are kept, so
   * coming back to the editor finds them as they were.
   */
  async openSequencing() {
    const doc = this.doc;
    if (!doc?.sequence) return;
    const go = () => { this.saveWorkspace?.({ now: true }); location.href = url(`/sequencing?sequence=${encodeURIComponent(doc.id)}`); };
    if (!doc.id) {
      modal({
        title: 'Save it first',
        build: (body) => body.append(el('p', {}, 'Sequencing reads are kept with plasmids in the lab library. ',
          'Save this one there first, then add its reads on the Sequencing page.')),
        buttons: [{ label: 'Cancel', kind: 'secondary' },
          { label: 'Save and open sequencing', onClick: async () => { if (await this.save()) go(); } }],
      });
      return;
    }
    if (!this.dirty) { go(); return; }
    modal({
      title: 'Save your changes first?',
      build: (body) => body.append(el('p', {}, 'Reads are aligned to the saved plasmid. ',
        'Save your changes so they are aligned to it as it is now, or open the version saved before them. ',
        'Your unsaved changes stay in this tab either way.')),
      buttons: [{ label: 'Cancel', kind: 'secondary' },
        { label: 'Open the saved version', kind: 'secondary', onClick: go },
        { label: 'Save and open', onClick: async () => { if (await this.save()) go(); } }],
    });
  },

  /** The plasmid's glycerol stocks in Lab Stocks, as links beside its badges. */
  async showStocks(doc) {
    const box = document.getElementById('stockChips');
    if (!box || !Stocks.enabled()) return;
    if (!doc?.id) { box.replaceChildren(); return; }
    if (this._stocksFor === doc.id) return;          // already shown for this plasmid
    this._stocksFor = doc.id;
    try {
      const { glycerol } = await Stocks.call('GET', `/glycerol?plasmid=${encodeURIComponent(doc.id)}`);
      if (this._stocksFor !== doc.id) return;
      box.replaceChildren(...glycerol.map((g) => el('a', {
        class: `badge badge-stock ${g.status !== 'in stock' ? 'faded' : ''}`, href: Stocks.link(g.code), target: '_blank', rel: 'noopener',
        title: `Glycerol stock${g.clone ? `, clone ${g.clone}` : ''}${g.host ? ` in ${g.host}` : ''}${g.location ? `, kept in ${g.location}` : ''} · ${g.status}`,
      }, `🧫 ${g.code}`)));
    } catch (err) {
      box.replaceChildren();          // Lab Stocks not reachable: nothing to show
    }
  },

  /** Offer a way out when the same record was edited in both tools. */
  resolveConflict(payload) {
    const doc = this.doc;
    modal({
      title: 'Also changed in the MoClo tool',
      build: (body) => {
        body.append(
          el('div', { class: 'alert alert-warning' }, payload.error),
          el('p', { class: 'hint' },
            'Your edit is saved here. The MoClo record was left as it is, so nothing has been lost ',
            'on either side. Choose which version should win.'),
          el('table', {},
            el('tbody', {},
              el('tr', {}, el('th', {}, 'This editor'),
                el('td', {}, `${doc.name} — ${fmt(doc.sequence.length)} bp`)),
              el('tr', {}, el('th', {}, 'MoClo'),
                el('td', {}, `${payload.moclo.name} — ${fmt(payload.moclo.length)} bp`)))));
      },
      buttons: [
        { label: 'Leave both for now', kind: 'secondary' },
        {
          label: 'Take the MoClo version',
          kind: 'secondary',
          onClick: async () => {
            const r = await API.post(`/api/sequences/${doc.id}/moclo/pull`, {});
            Object.assign(doc, r.sequence);
            this.dirty = false;
            this.setActive(this.index);
            toast('Replaced with the MoClo version', 'success');
          },
        },
        {
          label: 'Overwrite MoClo',
          onClick: async () => {
            await this.save({ force: true });
          },
        },
      ],
    });
  },

  /** Show whether the open sequence is linked to MoClo, and whether it differs. */
  async refreshMocloLink() {
    const doc = this.doc;
    const box = document.getElementById('mocloLink');
    if (!box) return;
    if (!doc?.id || !doc.moclo_link) { box.replaceChildren(); box.hidden = true; return; }
    try {
      const s = await API.get(`/api/sequences/${doc.id}/moclo`);
      if (!s.linked) { box.replaceChildren(); box.hidden = true; return; }
      box.hidden = false;
      const label = `MoClo ${s.kind}`;
      if (!s.exists) {
        box.replaceChildren(el('div', { class: 'alert alert-error' },
          `Linked to a ${label} that no longer exists there. Saving will not update MoClo.`,
          el('div', { class: 'btn-group', style: 'margin-top:.4rem' },
            el('button', { class: 'btn btn-sm btn-secondary', onclick: () => this.unlinkMoclo() }, 'Unlink'))));
        return;
      }
      const kind = s.moclo_changed ? 'alert-warning' : 'alert-info';
      box.replaceChildren(el('div', { class: `alert ${kind}` },
        el('div', {},
          el('b', {}, `Linked to ${label} “${s.name}”. `),
          s.moclo_changed
            ? 'It has also changed in MoClo since this sequence last synced.'
            : 'Saving here updates it there too.'),
        el('div', { class: 'btn-group', style: 'margin-top:.4rem' },
          el('button', { class: 'btn btn-sm btn-secondary', onclick: () => this.pullMoclo() },
            'Take the MoClo version'),
          el('button', { class: 'btn btn-sm btn-secondary', onclick: () => this.unlinkMoclo() },
            'Unlink'))));
    } catch {
      box.hidden = true;
    }
  },

  async pullMoclo() {
    const doc = this.doc;
    if (!await confirmDialog('Take the MoClo version',
      'Replace this sequence with the version held in the MoClo tool? Unsaved changes here are lost.',
      'Replace')) return;
    try {
      const r = await API.post(`/api/sequences/${doc.id}/moclo/pull`, {});
      Object.assign(doc, r.sequence);
      this.dirty = false;
      this.setActive(this.index);
      toast('Replaced with the MoClo version', 'success');
    } catch (err) {
      toast(err.message, 'error');
    }
  },

  async unlinkMoclo() {
    const doc = this.doc;
    if (!await confirmDialog('Unlink from MoClo',
      'Stop syncing this sequence with MoClo? The MoClo record stays exactly as it is, and future edits here will no longer reach it.',
      'Unlink')) return;
    try {
      await API.post(`/api/sequences/${doc.id}/moclo/unlink`, {});
      doc.moclo_link = null;
      this.refreshMocloLink();
      this.updateBadges();
      toast('Unlinked', 'success');
    } catch (err) {
      toast(err.message, 'error');
    }
  },

  /** Save a copy under a new name, or write the sequence out as a file. */
  saveAs() {
    const doc = this.doc;
    if (!doc || !doc.sequence) { toast('Nothing to save', 'error'); return; }
    modal({
      title: 'Save as',
      build: (body) => {
        body.append(
          el('div', { class: 'field' },
            el('label', { for: 'saName' }, 'Name'),
            el('input', { type: 'text', id: 'saName', value: doc.id ? `${doc.name} copy` : doc.name })),
          el('div', { class: 'field' },
            el('label', { for: 'saWhere' }, 'Save to'),
            el('select', { id: 'saWhere' },
              el('option', { value: 'library', text: 'Lab library (a new, separate entry)' }),
              el('option', { value: 'genbank', text: 'Download as GenBank (.gb)' }),
              el('option', { value: 'snapgene', text: 'Download as SnapGene (.dna)' }),
              el('option', { value: 'fasta', text: 'Download as FASTA (.fasta)' }),
              el('option', { value: 'json', text: 'Download as JSON (.json)' }))),
          el('p', { class: 'hint', id: 'saHint' },
            'The open sequence keeps its own entry; this creates a second one and switches to it.'));
        const where = body.querySelector('#saWhere');
        where.addEventListener('change', () => {
          body.querySelector('#saHint').textContent = where.value === 'library'
            ? 'The open sequence keeps its own entry; this creates a second one and switches to it.'
            : 'Downloads a file. Nothing is added to the lab library.';
        });
        setTimeout(() => body.querySelector('#saName')?.select(), 0);
      },
      buttons: [
        { label: 'Cancel', kind: 'secondary' },
        {
          label: 'Save',
          onClick: async ({ body }) => {
            const name = body.querySelector('#saName').value.trim();
            const where = body.querySelector('#saWhere').value;
            if (!name) { toast('A name is required', 'error'); return false; }
            const payload = { ...this.payloadDoc(), name };

            if (where !== 'library') {
              const ext = { genbank: 'gb', snapgene: 'dna', fasta: 'fasta' }[where] || 'json';
              await downloadFrom('/api/sequences/convert', `${name}.${ext}`,
                                 { document: payload, format: where });
              toast(`Downloaded ${name}.${ext}`, 'success');
              return true;
            }

            const saved = await API.post('/api/sequences', {
              document: payload,
              golden_gate: !!doc.golden_gate,
              golden_gate_enzyme: doc.golden_gate_enzyme,
              public: !!doc.public,
            });
            // Work on the copy from here, leaving the original entry untouched.
            doc.id = saved.sequence.id;
            doc.revision = saved.sequence.revision;
            doc.name = name;
            doc.moclo_part_id = null;
            this.dirty = false;
            document.getElementById('docName').value = name;
            this.renderDocList();
            this.updateBadges();
            toast(`Saved as “${name}”`, 'success');
            return true;
          },
        },
      ],
    });
  },

  /**
   * Open NCBI BLAST in a new tab with the selection, or the whole sequence when
   * nothing is selected, filled in as the query. The search form is posted
   * rather than linked so that long sequences fit; BLAST itself is started
   * from NCBI's page, where the database can be chosen.
   */
  blast() {
    if (!this.doc || !this.doc.sequence) { toast('No sequence to BLAST', 'error'); return; }
    const selected = this.view.selectedSequence();
    const sel = this.view.selection;
    const query = selected || this.doc.sequence;
    const name = this.doc.name || 'Untitled';
    const title = selected ? `${name} ${sel.start + 1}-${sel.end}` : name;

    const form = el('form', { method: 'POST', action: 'https://blast.ncbi.nlm.nih.gov/Blast.cgi',
                              target: '_blank', hidden: true });
    const fields = { PAGE_TYPE: 'BlastSearch', PROGRAM: 'blastn', BLAST_PROGRAMS: 'megaBlast',
                     LINK_LOC: 'blasthome', JOB_TITLE: title, QUERY: `>${title}\n${query}` };
    for (const [k, v] of Object.entries(fields)) {
      const input = el('input', { type: 'hidden', name: k });
      input.value = v;
      form.appendChild(input);
    }
    document.body.appendChild(form);
    form.submit();
    form.remove();
    toast(`Sent ${selected ? 'the selection' : 'the whole sequence'} (${fmt(query.length)} bp) to NCBI BLAST`,
          'success', 3000);
  },

  async copy(text, unit = 'character') {
    if (!text) { toast('Nothing selected', 'error'); return; }
    if (await copyText(text)) {
      toast(`Copied ${fmt(text.length)} ${unit}${text.length > 1 ? 's' : ''}`, 'success', 2000);
    } else {
      // Copying is blocked here; show the text so it can be copied by hand.
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
   * Replace a range with new text, moving every feature to match (see
   * applyEdit). A null range inserts at the end. With `collapse` the caret is
   * left after the inserted text, as when typing; otherwise the inserted text
   * is selected, as when pasting.
   */
  replaceRange(range, text, { collapse = false, undoable = true } = {}) {
    const doc = this.doc;
    if (!doc) return;
    const n = doc.sequence.length;
    const start = range ? range.start : n;
    const end = range ? (range.end > range.start ? range.end : range.start) : start;
    if (undoable) this.pushUndo();

    const next = applyEdit(doc, start, end, text);
    doc.sequence = next.sequence;
    doc.features = next.features;
    doc.translations = next.translations;

    if (collapse) {
      this.view.caret = start + text.length;
      this.view._anchor = this.view.caret;
      this.view.selection = { start: this.view.caret, end: this.view.caret };
    } else {
      this.view.selection = { start, end: start + text.length };
      this.view.caret = start + text.length;
      this.view._anchor = start;
    }
    this.markDirty();
    this.view.scrollCaretIntoView();
  },

  /* --- undo / redo ------------------------------------------------------ */

  undoStack: [],
  redoStack: [],
  MAX_UNDO: 200,

  snapshot() {
    const d = this.doc;
    return JSON.stringify({ name: d.name, sequence: d.sequence, circular: d.circular,
                            description: d.description || '', features: d.features,
                            translations: d.translations || [] });
  },

  pushUndo() {
    if (!this.doc) return;
    this.undoStack.push({ index: this.index, state: this.snapshot() });
    if (this.undoStack.length > this.MAX_UNDO) this.undoStack.shift();
    this.redoStack.length = 0;
    this.updateUndoButtons();
  },

  restore(entry) {
    const target = this.docs[entry.index];
    if (!target) return false;
    const state = JSON.parse(entry.state);
    Object.assign(target, state);
    if (this.index !== entry.index) this.setActive(entry.index);
    return true;
  },

  undo() {
    if (!this.undoStack.length) return;
    const entry = this.undoStack.pop();
    this.redoStack.push({ index: this.index, state: this.snapshot() });
    if (this.restore(entry)) {
      this.dirty = true;
      this.view.setDocument(this.doc, { keepSelection: true });
      this.renderFeatures();
      this.renderTranslations();
      this.refreshSites();
      this.updateBadges();
    }
    this.updateUndoButtons();
  },

  redo() {
    if (!this.redoStack.length) return;
    const entry = this.redoStack.pop();
    this.undoStack.push({ index: this.index, state: this.snapshot() });
    if (this.restore(entry)) {
      this.dirty = true;
      this.view.setDocument(this.doc, { keepSelection: true });
      this.renderFeatures();
      this.renderTranslations();
      this.refreshSites();
      this.updateBadges();
    }
    this.updateUndoButtons();
  },

  updateUndoButtons() {
    const u = document.getElementById('btnUndo');
    const r = document.getElementById('btnRedo');
    if (u) u.disabled = !this.undoStack.length;
    if (r) r.disabled = !this.redoStack.length;
  },

  deleteSelection() {
    const len = this.view.selectionLength();
    if (!len) { toast('Nothing selected', 'error'); return; }
    this.replaceRange(this.view.selection, '', { collapse: true });
    toast(`Deleted ${fmt(len)} bp`, 'success', 2000);
  },

  reverseComplement() {
    const doc = this.doc;
    if (!doc || !doc.sequence) return;
    this.pushUndo();
    const n = doc.sequence.length;
    doc.sequence = DNA.revComp(doc.sequence);
    doc.features = doc.features.map((f) => ({
      ...f,
      start: doc.circular ? (n - f.end + n) % n : n - f.end,
      end: n - f.start,
      strand: f.strand === -1 ? 1 : -1,
      segments: f.segments ? f.segments.map(([s, e]) => [n - e, n - s]).reverse() : undefined,
    }));
    doc.translations = (doc.translations || []).map((t) => ({
      ...t,
      start: doc.circular ? (n - t.end + n) % n : n - t.end,
      end: n - t.start,
      strand: t.strand === -1 ? 1 : -1,
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
    this.pushUndo();
    doc.circular = !doc.circular;
    this.markDirty();
    toast(doc.circular ? 'Now circular' : 'Now linear', 'success', 2000);
  },

  setOrigin() {
    const doc = this.doc;
    const sel = this.view.selection;
    if (!doc || !doc.circular) { toast('Only a circular sequence has a movable origin', 'error'); return; }
    if (!sel) { toast('Click the base that should become position 1', 'error'); return; }
    this.pushUndo();
    const k = sel.start;
    const n = doc.sequence.length;
    doc.sequence = doc.sequence.slice(k) + doc.sequence.slice(0, k);
    doc.features = doc.features.map((f) => ({
      ...f,
      start: (f.start - k + n) % n,
      end: ((f.end - k + n) % n) || n,
      segments: f.segments ? f.segments.map(([s, e]) => [(s - k + n) % n, ((e - k + n) % n) || n]) : undefined,
    }));
    doc.translations = (doc.translations || []).map((t) => ({
      ...t, start: (t.start - k + n) % n, end: ((t.end - k + n) % n) || n,
    }));
    this.view.selection = null;
    this.markDirty();
    toast(`Origin moved to ${fmt(k + 1)}`, 'success');
  },

  /* --- translations ----------------------------------------------------- */
  //
  // Translations of a stretch of the sequence, kept apart from the features:
  // the sequence view shows each amino acid under the codon that encodes it.

  renderTranslations() {
    const doc = this.doc;
    const list = document.getElementById('translationList');
    if (!list) return;
    const items = doc?.translations || [];
    document.getElementById('translationCount').textContent = items.length || '';
    if (!items.length) {
      list.replaceChildren(el('li', { class: 'empty' }, 'No translations. Select bases and choose “Translate”.'));
      return;
    }
    const sorted = [...items].sort((a, b) => a.start - b.start);
    list.replaceChildren(...sorted.map((t) => {
      const protein = translationProtein(doc.sequence, t);
      return el('li', {
        class: 'item',
        title: protein.length > 60 ? `${protein.slice(0, 60)}…` : protein,
        onclick: (ev) => {
          if (ev.target.closest('button')) return;
          if (ev.detail >= 2) { this.editTranslation(t); return; }
          // Select it as amino acids, so Copy AA and Ctrl+C give its protein.
          this.view.selectCodons(t, 0, Infinity);
          this.scrollToPosition(t.start);
        },
      },
        el('span', { class: 'item-name' }, `${t.name} `,
          el('span', { class: 'item-meta' }, `${fmt(protein.length)} aa`)),
        el('span', { class: 'item-meta' },
          `${fmt(t.start + 1)}–${fmt(t.end)} ${t.strand === -1 ? '←' : '→'} `,
          el('button', { class: 'tool-btn', title: 'Copy the protein', onclick: () => this.copy(protein, 'amino acid') }, '⧉'),
          el('button', { class: 'tool-btn', title: 'Rename or change strand', onclick: () => this.editTranslation(t) }, '✎'),
          el('button', { class: 'tool-btn', title: 'Remove this translation', onclick: () => this.removeTranslation(t) }, '✕')));
    }));
  },

  translateSelection() {
    const sel = this.view.selection;
    if (this.view.selectionLength() < 3) { toast('Select at least one codon (3 bases) to translate', 'error'); return; }
    const count = (this.doc.translations || []).length;
    this.editTranslation({ id: null, name: `Translation ${count + 1}`, start: sel.start, end: sel.end, strand: 1 });
  },

  /** Add a translation, or rename one or change the strand it reads. */
  editTranslation(translation) {
    const doc = this.doc;
    if (!doc) return;
    const isNew = !translation.id;
    const length = DNA.featLength(translation, doc.sequence.length);
    const preview = el('div', { class: 'mono', style: 'word-break:break-all;font-size:.8rem;max-height:8rem;overflow:auto' });
    const showPreview = () => {
      const strand = Number(document.querySelector('input[name="tStrand"]:checked')?.value || 1);
      const protein = translationProtein(doc.sequence, { ...translation, strand });
      preview.textContent = protein || '—';
    };
    modal({
      title: isNew ? 'Translate the selection' : `Edit “${translation.name}”`,
      build: (body) => {
        body.append(
          el('div', { class: 'field' },
            el('label', { for: 'tName' }, 'Name'),
            el('input', { type: 'text', id: 'tName', value: translation.name, maxlength: 100 })),
          el('div', { class: 'field' },
            el('div', { class: 'field-label' }, 'Strand'),
            el('label', { class: 'choice' },
              el('input', { type: 'radio', name: 'tStrand', value: '1', checked: translation.strand !== -1,
                            onchange: showPreview }), ' Forward →'),
            el('label', { class: 'choice' },
              el('input', { type: 'radio', name: 'tStrand', value: '-1', checked: translation.strand === -1,
                            onchange: showPreview }), ' Reverse ←')),
          el('div', { class: 'field' },
            el('div', { class: 'field-label' }, `Protein (${fmt(Math.floor(length / 3))} aa from ${fmt(length)} bp)`),
            preview,
            length % 3 ? el('span', { class: 'hint' },
              `The last ${length % 3} base${length % 3 > 1 ? 's are' : ' is'} not a whole codon and stay${length % 3 > 1 ? '' : 's'} untranslated.`) : null));
        showPreview();
        setTimeout(() => document.getElementById('tName')?.select(), 0);
      },
      buttons: [
        { label: 'Cancel', kind: 'secondary' },
        { label: isNew ? 'Add translation' : 'Save', onClick: () => {
          const name = document.getElementById('tName').value.trim() || 'Translation';
          const strand = Number(document.querySelector('input[name="tStrand"]:checked').value);
          this.pushUndo();
          doc.translations = doc.translations || [];
          if (isNew) {
            doc.translations.push({ id: `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
                                    name, start: translation.start, end: translation.end, strand });
          } else {
            Object.assign(doc.translations.find((t) => t.id === translation.id), { name, strand });
          }
          this.markDirty();
        } },
      ],
    });
  },

  removeTranslation(translation) {
    const doc = this.doc;
    this.pushUndo();
    doc.translations = doc.translations.filter((t) => t.id !== translation.id);
    this.markDirty();
    toast(`Removed “${translation.name}”. Undo brings it back.`, 'success', 3000);
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
        if (ev.detail >= 2) this.editFeature(f);
        else this.selectRange({ start: f.start, end: f.end });
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
            this.pushUndo();
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
            this.pushUndo();
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

  /** Select a range and bring it into view in whichever pane is showing. */
  selectRange(range) {
    this.view.setSelection(range);
    if (!document.getElementById('mapPane').hidden) this.map.render(this.doc, this.sites, range);
    else this.scrollToPosition(range.start);
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
             description: d.description || '', features: d.features,
             translations: d.translations || [] };
  },

  /* --- enzymes ---------------------------------------------------------- */

  async refreshSites() {
    const doc = this.doc;
    if (!doc || !doc.sequence) { this.sites = []; this.view.setSites([]); this.renderEnzymeTable({}, []); return; }
    const enzymes = this.currentEnzymes();
    if (!enzymes.length) return;
    // Searches can overlap (opening a sequence, then switching lists); only the
    // latest one's answer is shown, whichever order the answers arrive in.
    const ticket = (this._sitesTicket = (this._sitesTicket || 0) + 1);
    try {
      const body = await API.post('/api/tools/sites', {
        document: this.payloadDoc(),
        enzymes,
        unique_only: document.getElementById('chkUniqueOnly').checked,
      });
      if (ticket !== this._sitesTicket) return;
      this.sites = body.sites;
      this.view.setSites(body.sites);
      this.renderEnzymeTable(body.counts, body.non_cutters);
      if (!document.getElementById('mapPane').hidden) this.map.render(doc, this.sites, this.view.selection);
    } catch (err) {
      toast(err.message, 'error');
    }
  },

  /* --- which enzymes to show ------------------------------------------ */
  //
  // The built-in sets, the person's own lists (saved to their account, so
  // they follow them to any computer), or a selection shown without saving.

  currentEnzymes() {
    if (this.activeSet === 'selection') return this.selection || [];
    if (this.activeSet.startsWith('list:')) {
      return this.enzymeLists.find((l) => `list:${l.id}` === this.activeSet)?.enzymes || [];
    }
    return this.enzymeSets[this.activeSet] || [];
  },

  renderEnzymeChoices() {
    const sel = document.getElementById('enzymeSet');
    const option = (value, label, count) => el('option', { value, text: `${label} (${count})` });
    sel.replaceChildren(
      el('optgroup', { label: 'Sets' },
        ...Object.entries(this.enzymeSets).map(([name, list]) => option(name, name, list.length))),
      this.enzymeLists.length ? el('optgroup', { label: 'My lists' },
        ...this.enzymeLists.map((l) => option(`list:${l.id}`, l.name, l.enzymes.length))) : null,
      this.selection ? option('selection', 'Chosen, not saved', this.selection.length) : null);
    sel.value = this.activeSet;
    if (sel.value !== this.activeSet) { this.activeSet = 'Default'; sel.value = 'Default'; }
  },

  /** Show these enzymes, and remember the choice on the account (not an unsaved selection). */
  useEnzymes(value) {
    this.activeSet = value;
    this.renderEnzymeChoices();
    this.refreshSites();
    if (value !== 'selection') API.put('/api/tools/enzyme-choice', { choice: value }).catch(() => {});
  },

  /**
   * Choose enzymes from every one REBASE knows: show them as they are, save
   * them as a new list, or change or remove one of your lists.
   */
  async chooseEnzymes() {
    if (!this.catalog) {
      try {
        this.catalog = (await API.get('/api/tools/enzymes?catalog=1')).catalog;
      } catch (err) { toast(err.message, 'error'); return; }
    }
    const editing = this.activeSet.startsWith('list:')
      ? this.enzymeLists.find((l) => `list:${l.id}` === this.activeSet) : null;
    const chosen = new Set(this.currentEnzymes());
    const rows = new Map();          // name -> { row, box, entry }
    const count = el('span', { class: 'hint' });
    const showCount = () => { count.textContent = `${chosen.size} chosen`; };

    const search = el('input', { type: 'search', placeholder: 'Find an enzyme or a site, e.g. EcoRI or GAATTC',
                                 'aria-label': 'Find enzymes' });
    const onlyCommercial = el('input', { type: 'checkbox' });
    const onlyChosen = el('input', { type: 'checkbox' });
    const visible = () => [...rows.values()].filter((r) => r.row.style.display !== 'none');
    const applyFilter = () => {
      const q = search.value.trim().toUpperCase();
      for (const { row, entry } of rows.values()) {
        const match = (!q || entry.name.toUpperCase().includes(q) || entry.site.toUpperCase().includes(q))
          && (!onlyCommercial.checked || entry.commercial)
          && (!onlyChosen.checked || chosen.has(entry.name));
        row.style.display = match ? '' : 'none';
      }
    };
    for (const input of [search, onlyCommercial, onlyChosen]) input.addEventListener('input', applyFilter);

    const tbody = el('tbody');
    for (const entry of this.catalog) {
      const box = el('input', { type: 'checkbox', checked: chosen.has(entry.name),
                                'aria-label': `Show ${entry.name}` });
      box.addEventListener('change', () => {
        if (box.checked) chosen.add(entry.name); else chosen.delete(entry.name);
        showCount();
      });
      const row = el('tr', { onclick: (ev) => { if (ev.target !== box) { box.checked = !box.checked; box.dispatchEvent(new Event('change')); } } },
        el('td', {}, box), el('td', {}, entry.name), el('td', { class: 'mono' }, entry.site),
        el('td', {}, entry.ends), el('td', {}, entry.commercial ? 'yes' : '—'));
      rows.set(entry.name, { row, box, entry });
      tbody.append(row);
    }
    const setAll = (on) => {
      for (const { box, entry } of visible()) { box.checked = on; if (on) chosen.add(entry.name); else chosen.delete(entry.name); }
      showCount();
    };
    const addFrom = el('select', { 'aria-label': 'Add the enzymes of a set or list' },
      el('option', { value: '' }, 'Add a set…'),
      ...Object.keys(this.enzymeSets).filter((n) => n !== 'All REBASE').map((n) => el('option', { value: `set:${n}` }, n)),
      ...this.enzymeLists.map((l) => el('option', { value: `list:${l.id}` }, l.name)));
    addFrom.addEventListener('change', () => {
      const [kind, key] = [addFrom.value.split(':')[0], addFrom.value.slice(addFrom.value.indexOf(':') + 1)];
      const names = kind === 'set' ? this.enzymeSets[key] : this.enzymeLists.find((l) => l.id === key)?.enzymes;
      for (const name of names || []) { chosen.add(name); const r = rows.get(name); if (r) r.box.checked = true; }
      addFrom.value = '';
      showCount();
    });
    const nameInput = el('input', { type: 'text', id: 'enzListName', maxlength: 60,
                                    value: editing ? editing.name : '', placeholder: 'e.g. My cloning enzymes' });

    const save = async (asNew) => {
      const name = nameInput.value.trim();
      if (!chosen.size) { toast('Choose at least one enzyme', 'error'); return false; }
      if (!name) { toast('Give the list a name', 'error'); nameInput.focus(); return false; }
      const body = { name, enzymes: [...chosen] };
      const { list } = editing && !asNew
        ? await API.put(`/api/tools/enzyme-lists/${editing.id}`, body)
        : await API.post('/api/tools/enzyme-lists', body);
      this.enzymeLists = [...this.enzymeLists.filter((l) => l.id !== list.id), list]
        .sort((a, b) => a.name.localeCompare(b.name));
      this.useEnzymes(`list:${list.id}`);
      toast(`Saved “${list.name}” to your account (${list.enzymes.length} enzymes).`, 'success');
      return true;
    };

    const buttons = [{ label: 'Cancel', kind: 'secondary' }];
    if (editing) {
      buttons.push({ label: 'Remove list', kind: 'danger', onClick: async () => {
        await API.del(`/api/tools/enzyme-lists/${editing.id}`);
        this.enzymeLists = this.enzymeLists.filter((l) => l.id !== editing.id);
        this.useEnzymes('Default');
        toast(`Removed “${editing.name}”.`, 'success');
      } });
    }
    buttons.push({ label: 'Show without saving', kind: 'secondary', onClick: () => {
      if (!chosen.size) { toast('Choose at least one enzyme', 'error'); return false; }
      this.selection = [...chosen].sort((a, b) => a.localeCompare(b));
      this.useEnzymes('selection');
      return true;
    } });
    if (editing) buttons.push({ label: 'Save as a new list', kind: 'secondary', onClick: () => save(true) });
    buttons.push({ label: editing ? 'Save changes' : 'Save as a list', onClick: () => save(false) });

    modal({
      title: editing ? `Edit “${editing.name}”` : 'Choose enzymes',
      wide: true,
      build: (body) => {
        body.append(
          el('p', { class: 'hint' }, editing
            ? 'Tick the enzymes this list should show. Your lists are saved to your account.'
            : 'Tick the enzymes to show. Show them now, or save them as a list on your account to use again.'),
          el('div', { class: 'enz-choose-bar' }, search,
            el('label', { class: 'choice' }, onlyCommercial, 'Sold commercially'),
            el('label', { class: 'choice' }, onlyChosen, 'Chosen only')),
          el('div', { class: 'enz-choose-bar' },
            el('button', { class: 'tool-btn', type: 'button', onclick: () => setAll(true) }, 'Tick all shown'),
            el('button', { class: 'tool-btn', type: 'button', onclick: () => setAll(false) }, 'Untick all shown'),
            addFrom, count),
          el('div', { class: 'table-scroll enz-choose-list' }, el('table', {},
            el('thead', {}, el('tr', {}, el('th', {}), el('th', {}, 'Enzyme'), el('th', {}, 'Site'),
              el('th', {}, 'Ends'), el('th', {}, 'Sold'))),
            tbody)),
          el('div', { class: 'field', style: 'margin-top:.75rem' },
            el('label', { for: 'enzListName' }, 'List name (to save it)'), nameInput));
        showCount();
        setTimeout(() => search.focus(), 0);
      },
      buttons,
    });
  },

  renderEnzymeTable(counts, nonCutters) {
    const filter = document.getElementById('enzymeFilter').value.trim().toLowerCase();
    const showNon = document.getElementById('chkNonCutters').checked;
    const byEnzyme = new Map();
    for (const s of this.sites) byEnzyme.set(s.enzyme, (byEnzyme.get(s.enzyme) || []).concat(s));
    const rows = [];
    for (const [enzyme, sites] of [...byEnzyme].sort((a, b) => a[0].localeCompare(b[0]))) {
      if (filter && !enzyme.toLowerCase().includes(filter)) continue;
      const positions = sites.map((s) => s.cut_top ?? s.start);
      rows.push(el('tr', {
        style: 'cursor:pointer',
        title: 'Click to highlight the recognition sites, double-click for details',
        onclick: (ev) => {
          if (ev.detail >= 2) { this.showSite(sites[0]); return; }
          this.view.setHighlights(sites.map((s) => ({ start: s.start, end: s.end, class: 'site-hit' })));
          this.scrollToPosition(sites[0].start);
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

  /** The overhang a site leaves: its kind and the top-strand bases between the cuts. */
  siteOverhang(site) {
    const seq = this.doc.sequence;
    const n = seq.length;
    const ct = site.cut_top;
    const cb = site.cut_bottom;
    if (ct === null || ct === undefined || cb === null || cb === undefined) return null;
    if (ct === cb) return { kind: 'blunt', bases: '' };
    // Distance from the top-strand cut forward to the bottom-strand cut; on a
    // circle the shorter way round is the overhang.
    const ahead = this.doc.circular ? (cb - ct + n) % n : cb - ct;
    const fivePrime = this.doc.circular ? ahead < n / 2 : ahead > 0;
    const [a, b] = fivePrime ? [ct, cb] : [cb, ct];
    const bases = a <= b ? seq.slice(a, b) : seq.slice(a) + seq.slice(0, b);
    return { kind: fivePrime ? "5′ overhang" : "3′ overhang", bases: bases.toUpperCase() };
  },

  /** Details of one restriction site and its enzyme. */
  async showSite(site) {
    const doc = this.doc;
    if (!doc) return;
    const n = doc.sequence.length;
    let info = null;
    try {
      info = await API.get(`/api/tools/enzymes/${encodeURIComponent(site.enzyme)}`);
    } catch (err) {
      // The site itself is still worth showing without the REBASE details.
    }
    const end = site.end || n;
    const recognition = site.end > site.start || !doc.circular
      ? doc.sequence.slice(site.start, end)
      : doc.sequence.slice(site.start) + doc.sequence.slice(0, site.end);
    const overhang = this.siteOverhang(site);
    const count = this.sites.filter((s) => s.enzyme === site.enzyme).length;
    const row = (label, value) => el('tr', {}, el('th', { text: label }), el('td', {}, value));
    modal({
      title: site.enzyme,
      build: (body) => body.append(el('table', {},
        row('Recognition site', el('span', { class: 'mono', text: info ? info.elucidate : recognition.toUpperCase() })),
        row('This site', `${fmt(site.start + 1)}–${fmt(end)}, ${site.strand === -1 ? 'reverse' : 'forward'} strand`),
        row('Bound sequence', el('span', { class: 'mono', text: recognition.toUpperCase() })),
        row('Cuts', site.cut_top === null || site.cut_top === undefined
          ? 'Outside the sequence'
          : `top strand after ${fmt(site.cut_top)}, bottom strand after ${fmt(site.cut_bottom ?? site.cut_top)}`),
        row('Ends', overhang
          ? (overhang.bases ? overhang.kind : 'Blunt')
          : (info ? info.ends : '—')),
        overhang && overhang.bases
          ? row('Overhang', el('span', { class: 'mono', text: overhang.bases }))
          : null,
        row('Sites in this sequence', String(count)),
        info && info.suppliers.length ? row('Suppliers', info.suppliers.join(', ')) : null,
      )),
      buttons: [
        { label: 'Highlight site', kind: 'secondary',
          onClick: () => this.selectRange({ start: site.start, end: site.end }) },
        { label: 'Close' },
      ],
    });
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
    document.getElementById('btnBlast').addEventListener('click', () => this.blast());
    if (Stocks.enabled()) {
      document.getElementById('btnLabPrimers').hidden = false;
      document.getElementById('btnLabPrimers').addEventListener('click', () => Tools.labPrimers());
    }
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
          disabled: !canContribute,
          title: canContribute ? '' : 'The shared MoClo parts database is not mounted on this server',
          onclick: () => this.contribute(result),
        }, '➕ Add to MoClo parts library'),
        this.doc.moclo_part_id
          ? el('span', { class: 'hint' }, 'Already contributed.')
          : !canContribute
            ? el('span', { class: 'hint' }, 'Shared MoClo database not available here.')
            : !this.doc.id
              ? el('span', { class: 'hint' }, 'It will be saved to the lab library first.')
              : null));
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
            if ((!doc.id || this.dirty) && !(await this.save())) {
              toast('The sequence could not be saved, so it was not contributed', 'error');
              return false;
            }
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
