/* Sequencing page: attach reads to a saved sequence, align them, view chromatograms. */

const Sequencing = {
  sequences: [],
  reference: null,
  reads: [],
  activeRead: null,
  traceScale: 2,

  /** Plasmids open in the editor's tabs (this sign-in's), by id: their place, the active tab first. */
  open: new Map(),

  async init() {
    document.getElementById('readInput').addEventListener('change', (e) => this.upload(e.target.files));
    document.getElementById('btnRealign').addEventListener('click', () => this.realign());
    document.getElementById('traceZoomIn').addEventListener('click', () => { this.traceScale *= 1.5; this.drawTrace(); });
    document.getElementById('traceZoomOut').addEventListener('click', () => { this.traceScale /= 1.5; this.drawTrace(); });

    // A lab can hold hundreds of plasmids, so the reference is searched rather
    // than scrolled: best matches first, then the most recently created.
    this.combo = new Combobox(document.getElementById('refCombo'), {
      placeholder: 'Search plasmids by name or description…',
      fields: ['name', 'description'],
      dateField: 'created_at',
      emptyText: 'No plasmid matches. Save one in the editor first.',
      // The plasmids open in the editor come first: most often the one to check.
      pinned: (s) => (this.open.has(s.id) ? this.open.get(s.id) : -1),
      label: (s) => s.name,
      render: (s, query) => el('div', {},
        el('div', { class: 'combo-name' }, highlight(s.name, query),
          s.confirmed ? el('span', { class: 'confirmed-tick', title: 'Confirmed and sequenced' }, ' ✓') : null,
          this.open.has(s.id) ? el('span', { class: 'combo-open', title: 'Open in a tab of the editor' }, 'open in the editor') : null),
        el('div', { class: 'combo-meta' },
          el('span', {}, `${fmt(s.length)} bp`),
          el('span', {}, s.circular ? 'circular' : 'linear'),
          s.read_count ? el('span', {}, `${s.read_count} read${s.read_count === 1 ? '' : 's'}`) : null,
          s.reads_bad ? el('span', { class: 'verdict-bad', text: `${s.reads_bad} not sufficient` }) : null,
          s.created_at ? el('span', {}, `added ${String(s.created_at).slice(0, 10)}`) : null,
          s.description ? el('span', {}, '· ', highlight(s.description.slice(0, 60), query)) : null)),
      onSelect: (s) => this.selectReference(s.id),
    });

    try {
      const [{ sequences }, open] = await Promise.all([API.get('/api/sequences?sequencing=true'), this.openInEditor()]);
      this.open = open;
      this.sequences = sequences;
      this.combo.setItems(sequences);
      const preset = new URLSearchParams(location.search).get('sequence');
      const chosen = preset && sequences.find((s) => s.id === preset);
      if (chosen) {
        this.combo.setSelected(chosen);
        this.selectReference(preset);
      }
    } catch (err) {
      toast(err.message, 'error');
    }
  },

  /** The saved plasmids open in the editor's tabs: id -> place, the active tab first, then the tabs in order. */
  async openInEditor() {
    const places = new Map();
    try {
      const { workspace } = await API.get('/api/workspace');
      const docs = workspace?.docs || [];
      const active = docs[workspace?.active || 0];
      for (const doc of [active, ...docs]) {
        if (doc?.id && !places.has(doc.id)) places.set(doc.id, places.size);
      }
    } catch { /* nothing open, or not remembered: no plasmid comes first */ }
    return places;
  },

  /** Keep the picker's metadata (read counts, green check) current. */
  async refreshList() {
    try {
      const { sequences } = await API.get('/api/sequences?sequencing=true');
      this.sequences = sequences;
      this.combo.setItems(sequences);
      const current = sequences.find((s) => s.id === this.reference?.id);
      if (current) this.combo.setSelected(current);
    } catch {
      /* the picker keeps the list it already has */
    }
  },

  async selectReference(id) {
    if (!id) {
      this.reference = null;
      this.reads = [];
      document.getElementById('refInfo').textContent = '';
      this.renderReads();
      this.renderVerification();
      return;
    }
    try {
      // Alignments are open to everyone, so this goes through the sequencing
      // view rather than the plasmid itself, which may be private.
      const { sequence, reads } = await API.get(`/api/sequences/${id}/sequencing`);
      const changed = this.reference?.id !== sequence.id;
      this.reference = sequence;
      this.reads = reads || [];
      // Re-point at the refreshed copy of the same read, or drop the selection
      // when a different plasmid is chosen.
      this.activeRead = changed ? null
        : this.reads.find((r) => r.id === this.activeRead?.id) || null;
      document.getElementById('refInfo').textContent =
        `${fmt(sequence.sequence.length)} bp, ${sequence.circular ? 'circular' : 'linear'}, ${sequence.feature_count} features`
        + (sequence.can_change ? '' : ' · view only: the owner uploads, judges and confirms');
      this.applyPermissions();
      this.renderReads();
      this.renderVerification();
    } catch (err) {
      toast(err.message, 'error');
    }
  },

  /** Hide what only the owner (or an admin) may do; viewing stays open to all. */
  applyPermissions() {
    const seq = this.reference;
    const canAdd = !seq || seq.can_add_reads;
    for (const id of ['cloneNumber', 'readLabel']) {
      document.getElementById(id).closest('.field, label').hidden = !canAdd;
    }
    document.getElementById('btnRealign').hidden = !!seq && !seq.can_change;
  },

  async upload(files) {
    if (!files?.length) return;
    if (!this.reference) { toast('Choose a reference sequence first', 'error'); return; }
    const status = document.getElementById('uploadStatus');
    status.replaceChildren(el('span', { class: 'spin' }));
    const form = new FormData();
    for (const f of files) form.append('file', f);
    const clone = document.getElementById('cloneNumber').value.trim();
    if (clone) form.append('clone_number', clone);
    try {
      const { reads, errors } = await API.post(`/api/sequences/${this.reference.id}/reads`, form);
      for (const e of errors || []) toast(`${e.filename}: ${e.error}`, 'error', 7000);
      status.replaceChildren(el('div', { class: 'alert alert-success' },
        `Added ${reads.length} read${reads.length === 1 ? '' : 's'}.`));
      await this.selectReference(this.reference.id);
      this.refreshList();
      if (reads.length) this.showRead(this.reads.find((r) => r.name === reads[0].name) || this.reads[0]);
    } catch (err) {
      status.replaceChildren(el('div', { class: 'alert alert-error', text: err.message }));
    }
    document.getElementById('readInput').value = '';
  },

  async realign() {
    if (!this.reference) return;
    try {
      await API.post(`/api/sequences/${this.reference.id}/reads/realign`, {});
      toast('Reads re-aligned', 'success');
      await this.selectReference(this.reference.id);
      this.refreshList();
    } catch (err) {
      toast(err.message, 'error');
    }
  },

  renderReads() {
    const list = document.getElementById('readList');
    if (!this.reads.length) {
      list.replaceChildren(el('li', { class: 'empty' },
        this.reference ? 'No reads attached yet.' : 'Choose a reference sequence.'));
      this.renderCoverage();
      return;
    }
    list.replaceChildren(...this.reads.map((r) => {
      const a = r.alignment || {};
      const bad = !a.mapped;
      const diffs = (a.differences || []).length;
      return el('li', {
        class: `item ${this.activeRead?.id === r.id ? 'active' : ''}`,
        onclick: (ev) => { if (!ev.target.closest('button')) this.showRead(r); },
      },
        el('span', { class: 'item-name' },
          r.clone_number ? el('span', { class: 'badge', text: `clone ${r.clone_number}` }) : null,
          ` ${r.name}`,
          el('span', {
            class: 'item-meta',
            title: !bad && a.aligned_fraction !== undefined
              ? `${a.aligned_fraction}% of the ${fmt(a.read_length)} bp read aligned` : null,
          }, bad ? ' · not mapped'
            : ` · ${fmt(a.ref_start + 1)}–${fmt(a.ref_end)} ${a.strand === -1 ? '←' : '→'} ${a.identity}%`),
          r.verdict ? el('span', {
            class: r.verdict === 'sufficient' ? 'verdict-ok' : 'verdict-bad',
            text: r.verdict === 'sufficient' ? ' ✓ sufficient' : ' ✗ not sufficient',
            style: 'font-size:.75rem',
          }) : null),
        el('span', { class: 'item-meta nowrap' },
          bad ? el('span', { class: 'badge', text: 'unmapped' })
            : diffs ? el('span', { class: 'badge', style: 'background:#fef2f2;color:#991b1b;border-color:#fecaca',
              text: `${diffs} diff${diffs === 1 ? '' : 's'}` })
              : el('span', { class: 'badge badge-gg', text: 'clean' }),
          r.has_trace ? el('span', { class: 'badge', text: 'trace' }) : null,
          this.reference?.can_change
            ? el('button', { class: 'tool-btn', title: 'Remove read', onclick: () => this.remove(r) }, '🗑')
            : null));
    }));
    this.renderCoverage();
  },

  /**
   * Coverage of the selected read only. Merging every read into one bar hides
   * which read reached where, which is the thing you need when deciding
   * whether a clone was read well enough.
   */
  renderCoverage() {
    const bar = document.getElementById('coverage');
    const text = document.getElementById('coverageText');
    const title = document.getElementById('coverageTitle');
    if (title) title.textContent = 'Coverage';
    if (!this.reference) {
      bar.replaceChildren();
      text.textContent = '';
      this.renderReadExtent(null);
      return;
    }
    const read = this.activeRead;
    if (!read) {
      bar.replaceChildren();
      text.textContent = this.reads.length
        ? 'Select a read to see what it covers.'
        : 'No reads to show coverage for.';
      this.renderReadExtent(null);
      return;
    }
    const a = read.alignment;
    if (!a?.mapped) {
      bar.replaceChildren();
      text.textContent = `${read.name} did not align, so it covers nothing.`;
      this.renderReadExtent(null);
      return;
    }
    const n = this.reference.sequence.length;
    // The read's own segments are what it actually covers (more than one when
    // a deletion splits it, or it runs through the origin); older stored
    // alignments have none, so fall back to its overall span.
    const spans = (a.segments || [{ ref_start: a.ref_start, ref_end: a.ref_end }])
      .flatMap(({ ref_start, ref_end }) => (ref_end > ref_start ? [[ref_start, ref_end]] : [[ref_start, n], [0, ref_end]]));
    bar.replaceChildren(...spans.map(([from, to]) => el('div', {
      class: 'coverage-seg',
      style: `left:${(from / n) * 100}%;width:${((to - from) / n) * 100}%`,
      title: `${fmt(from + 1)}–${fmt(to)}`,
    })));
    const covered = spans.reduce((sum, [from, to]) => sum + (to - from), 0);
    if (title) {
      title.textContent = `Coverage — ${read.clone_number ? `clone ${read.clone_number}, ` : ''}${read.name}`;
    }
    text.textContent = `${fmt(a.ref_start + 1)}–${fmt(a.ref_end)} on the `
      + `${a.strand === -1 ? 'reverse' : 'forward'} strand — ${fmt(covered)} bp, `
      + `${((covered / n) * 100).toFixed(1)}% of the plasmid`
      + (a.ref_end > a.ref_start ? '' : ', across the origin');
    this.renderReadExtent(a);
  },

  /**
   * The read itself, full length, left to right as it was sequenced: which
   * stretches made it into the alignment (green), which were cut for low
   * quality (hatched), and - the thing a merged-into-reference coverage bar
   * can't show - which stretches the reference simply doesn't have (red): a
   * large insertion, contamination, or a reference that's wrong there.
   */
  renderReadExtent(a) {
    const block = document.getElementById('readExtentBlock');
    const bar = document.getElementById('readExtent');
    const text = document.getElementById('readExtentText');
    // Segments carry their own read_start/read_end only once a read has been
    // aligned since this was added; an older stored alignment has none, and
    // there is nothing useful to draw until it is re-aligned.
    const segs = a?.segments?.filter((s) => s.read_start !== undefined);
    if (!a || !segs?.length) {
      block.hidden = true;
      return;
    }
    block.hidden = false;
    const total = a.read_length;
    const [t0, t1] = a.trim || [0, total];
    const blocks = [];
    if (t0 > 0) blocks.push([0, t0, 'read-trimmed', `${fmt(t0)} bp trimmed for low quality`]);
    let cursor = t0;
    for (const s of segs) {
      if (s.read_start > cursor) {
        blocks.push([cursor, s.read_start, 'read-unaligned', `${fmt(s.read_start - cursor)} bp not found in the reference`]);
      }
      blocks.push([s.read_start, s.read_end, '', `${fmt(s.read_end - s.read_start)} bp aligned to ${fmt(s.ref_start + 1)}–${fmt(s.ref_end)}`]);
      cursor = Math.max(cursor, s.read_end);
    }
    if (cursor < t1) blocks.push([cursor, t1, 'read-unaligned', `${fmt(t1 - cursor)} bp not found in the reference`]);
    if (t1 < total) blocks.push([t1, total, 'read-trimmed', `${fmt(total - t1)} bp trimmed for low quality`]);
    bar.replaceChildren(...blocks.map(([from, to, cls, title]) => el('div', {
      class: `coverage-seg ${cls}`,
      style: `left:${(from / total) * 100}%;width:${((to - from) / total) * 100}%`,
      title,
    })));
    const unaligned = blocks.filter(([, , cls]) => cls === 'read-unaligned').reduce((sum, [from, to]) => sum + (to - from), 0);
    text.textContent = unaligned
      ? `${fmt(unaligned)} bp of this ${fmt(total)} bp read (${((unaligned / total) * 100).toFixed(1)}%) `
        + `did not match the reference anywhere.`
      : `The whole ${fmt(total)} bp read matched the reference` + (t0 > 0 || t1 < total ? ', aside from the trimmed ends.' : '.');
  },

  /** Say so when the last sufficient verdict went and took the confirmation with it. */
  noteWithdrawn(res) {
    if (res?.confirmation_withdrawn) {
      toast('No read is judged sufficient any more, so the plasmid is no longer confirmed as sequenced',
            'info', 6000);
    }
    if (res?.moclo_note) toast(res.moclo_note, 'error', 8000);
  },

  async remove(read) {
    if (!await confirmDialog('Remove read', `Remove “${read.name}”?`, 'Remove')) return;
    try {
      const res = await API.del(`/api/sequences/reads/${read.id}`);
      this.noteWithdrawn(res);
      if (this.activeRead?.id === read.id) {
        this.activeRead = null;
        document.getElementById('traceCard').hidden = true;
        document.getElementById('alignment').replaceChildren(
          el('div', { class: 'empty' }, 'Select a read to see its alignment.'));
      }
      await this.selectReference(this.reference.id);
    } catch (err) {
      toast(err.message, 'error');
    }
  },

  async showRead(read) {
    this.activeRead = read;
    this.renderReads();
    this.renderCoverage();
    const box = document.getElementById('alignment');
    const a = read.alignment;
    if (!a) { box.replaceChildren(el('div', { class: 'empty' }, 'No alignment stored for this read.')); return; }
    const nodes = [];
    if (!a.mapped) {
      nodes.push(el('div', { class: 'alert alert-warning' },
        `This read did not align to the reference${a.reason ? `: ${a.reason}` : ` (best identity ${a.identity ?? 0}%)`}.`));
    } else {
      nodes.push(el('div', { class: `alert ${a.differences.length ? 'alert-warning' : 'alert-success'}` },
        el('div', {}, el('b', {}, `${a.identity}% identity over ${fmt(a.aligned_length)} bp`),
          a.aligned_fraction !== undefined ? ` (${a.aligned_fraction}% of the ${fmt(a.read_length)} bp read)` : '',
          ` — reference ${fmt(a.ref_start + 1)}–${fmt(a.ref_end)}, `,
          a.strand === -1 ? 'reverse strand' : 'forward strand'),
        a.differences.length
          ? this.differenceList(a, (k) => nav.go(k))
          : el('div', { class: 'hint' }, 'No differences from the reference.')));
      nodes.push(this.verdictBar(read));
      const view = this.alignmentView(a, (k) => nav.go(k));
      const nav = this.differenceNav(a, view, read);
      if (a.differences.length) nodes.push(nav.bar);
      nodes.push(view);
    }
    box.replaceChildren(...nodes);

    const card = document.getElementById('traceCard');
    if (read.has_trace) {
      try {
        const full = await API.get(`/api/sequences/reads/${read.id}?trace=true`);
        this.trace = full.read.trace;
        card.hidden = !this.trace;
        if (this.trace) this.drawTrace();
      } catch {
        card.hidden = true;
      }
    } else {
      card.hidden = true;
      this.trace = null;
    }
  },

  /** Judge this alignment, and record the clone it came from. */
  verdictBar(read) {
    if (!this.reference?.can_change) {
      return el('div', { class: 'hint', style: 'margin:.5rem 0 .75rem' },
        read.clone_number ? `Clone ${read.clone_number} · ` : '',
        read.verdict
          ? `${read.verdict === 'sufficient' ? '✓ sufficient' : '✗ not sufficient'}`
            + (read.verdict_by ? ` (judged by ${read.verdict_by})` : '')
          : 'Not judged yet');
    }
    const clone = el('input', {
      type: 'text', value: read.clone_number || '', placeholder: 'clone',
      style: 'width:6rem', title: 'Which colony this read came from',
    });
    const judge = async (verdict, extra = {}) => {
      const res = await API.post(`/api/sequences/reads/${read.id}/verdict`, {
        verdict, clone_number: clone.value, ...extra,
      });
      await this.selectReference(this.reference.id);
      const updated = this.reads.find((r) => r.id === read.id);
      if (updated) await this.showRead(updated);
      if (res.confirmation_withdrawn) this.noteWithdrawn(res);
      else if (verdict === 'sufficient') {
        toast(res.synced_to_moclo ? 'Sufficient: plasmid confirmed, and recorded as sequenced in MoClo'
                                  : 'Sufficient: plasmid confirmed as sequenced', 'success', 5000);
        if (res.moclo_note) toast(res.moclo_note, 'error', 9000);
        this.refreshList();
      } else toast('Marked not sufficient', 'success', 2500);
    };
    const tryJudge = (verdict) => judge(verdict).catch((err) => toast(err.message, 'error'));
    return el('div', { class: 'btn-group', style: 'margin:.5rem 0 .75rem;align-items:center' },
      el('span', { class: 'hint' }, 'Clone'),
      clone,
      el('button', {
        class: `btn btn-sm ${read.verdict === 'sufficient' ? '' : 'btn-secondary'}`,
        'aria-pressed': read.verdict === 'sufficient' ? 'true' : 'false',
        // Sufficient confirms the plasmid, so it needs its glycerol stock first.
        onclick: () => this.askGlycerolStock(clone.value || read.clone_number,
          (stock, cloneNumber) => {
            clone.value = cloneNumber;
            return judge('sufficient', { glycerol_stock: stock, clone_number: cloneNumber });
          }),
      }, '✓ Alignment is sufficient'),
      el('button', {
        class: `btn btn-sm ${read.verdict === 'insufficient' ? '' : 'btn-secondary'}`,
        'aria-pressed': read.verdict === 'insufficient' ? 'true' : 'false',
        onclick: () => tryJudge('insufficient'),
      }, '✗ Not sufficient'),
      read.verdict
        ? el('button', {
            class: 'tool-btn', title: 'Clear this judgement',
            onclick: async () => {
              const res = await API.post(`/api/sequences/reads/${read.id}/verdict`, { verdict: null });
              this.noteWithdrawn(res);
              await this.selectReference(this.reference.id);
            },
          }, 'clear')
        : null,
      read.verdict_by
        ? el('span', { class: 'hint' }, `${read.verdict} by ${read.verdict_by}`)
        : null);
  },

  /**
   * Ask for the glycerol stock a confirmed plasmid is kept as. Judging an
   * alignment sufficient confirms the plasmid, so it waits for this: with
   * `onConfirm(stock, clone)` that judgement is what the button sends, and
   * nothing is recorded unless a stock is given.
   */
  askGlycerolStock(clone, onConfirm) {
    const seq = this.reference;
    // With Lab Stocks, a new glycerol stock gets the lab's next number there;
    // a number from before (or another scheme) can still be typed.
    const stocks = Stocks.enabled();
    modal({
      title: onConfirm ? 'Alignment sufficient: confirm the plasmid' : 'Confirm this plasmid as sequenced',
      build: (body) => {
        const choice = (value, label, checked) => el('label', { class: 'checkbox' },
          el('input', { type: 'radio', name: 'glyHow', value, checked }), el('span', {}, label));
        body.append(
          el('p', {}, onConfirm ? 'Judging this alignment sufficient confirms ' : 'The alignment is good, so ',
            el('b', { text: seq.name }),
            onConfirm ? ' as sequenced. Record the glycerol stock the clone is kept as.'
                      : ' can be marked as confirmed and sequenced.'),
          el('div', { class: 'field' },
            el('label', { for: 'glyClone' }, 'Confirmed clone'),
            el('input', { type: 'text', id: 'glyClone', value: clone || seq.confirmed_clone || '' })),
          stocks ? el('div', { class: 'field' },
            choice('new', 'A new glycerol stock in Lab Stocks, with the lab\'s next number', !seq.glycerol_stock),
            el('div', { class: 'field-row', id: 'glyNew', style: 'margin:.3rem 0 .3rem 1.6rem' },
              el('div', { class: 'field' }, el('label', { for: 'glyHost' }, 'Strain'),
                el('input', { type: 'text', id: 'glyHost', placeholder: 'e.g. DH5α, GV3101' })),
              el('div', { class: 'field' }, el('label', { for: 'glyPlace' }, 'Kept in'),
                el('input', { type: 'text', id: 'glyPlace', placeholder: 'e.g. −80 °C / box 3 / B4' }))),
            choice('existing', 'A glycerol stock that already has a number', !!seq.glycerol_stock)) : null,
          el('div', { class: 'field', id: 'glyExisting' },
            el('label', { for: 'glyStock' }, 'Glycerol stock number'),
            el('input', { type: 'text', id: 'glyStock', placeholder: 'e.g. GL-G-0012, or GS-2026-041',
              value: seq.glycerol_stock || '' }),
            el('span', { class: 'hint' }, 'Recorded with the plasmid so the stock can be found later.')));
        const sync = () => {
          const fresh = stocks && body.querySelector('input[name=glyHow]:checked')?.value === 'new';
          body.querySelector('#glyExisting').hidden = fresh;
          if (body.querySelector('#glyNew')) body.querySelector('#glyNew').hidden = !fresh;
        };
        for (const r of body.querySelectorAll('input[name=glyHow]')) r.addEventListener('change', sync);
        sync();
        setTimeout(() => body.querySelector('#glyHost:not([hidden]), #glyStock')?.focus(), 0);
      },
      buttons: [
        { label: onConfirm ? 'Cancel' : 'Not yet', kind: 'secondary' },
        {
          label: onConfirm ? 'Mark sufficient and confirm' : 'Confirm plasmid',
          onClick: async ({ body }) => {
            let stock = body.querySelector('#glyStock').value.trim();
            if (stocks && body.querySelector('input[name=glyHow]:checked')?.value === 'new') {
              const { record } = await Stocks.call('POST', '/glycerol', {
                plasmid_id: seq.id, plasmid_name: seq.name, source: 'sequencing',
                clone: body.querySelector('#glyClone').value.trim(),
                host: body.querySelector('#glyHost').value.trim(),
                location: body.querySelector('#glyPlace').value.trim(),
              });
              stock = record.code;
              toast(`Glycerol stock ${stock} made in Lab Stocks`, 'success', 6000);
            }
            if (!stock) {
              toast('A glycerol stock number is required', 'error');
              body.querySelector('#glyStock').focus();
              return false;
            }
            if (onConfirm) {
              await onConfirm(stock, body.querySelector('#glyClone').value.trim());
              return true;
            }
            const res = await API.post(`/api/sequences/${seq.id}/confirm`, {
              glycerol_stock: stock,
              clone_number: body.querySelector('#glyClone').value.trim(),
            });
            toast(res.synced_to_moclo
              ? 'Confirmed, and recorded as sequenced in MoClo'
              : 'Plasmid confirmed as sequenced', 'success', 5000);
            await this.selectReference(seq.id);
            this.refreshList();
            return true;
          },
        },
      ],
    });
  },

  renderVerification() {
    const seq = this.reference;
    const badge = document.getElementById('confirmBadge');
    const summary = document.getElementById('verificationSummary');
    if (!seq) {
      badge.replaceChildren();
      summary.textContent = 'Choose a reference sequence.';
      return;
    }
    const ok = this.reads.filter((r) => r.verdict === 'sufficient').length;
    const bad = this.reads.filter((r) => r.verdict === 'insufficient').length;
    const diffs = this.reads.filter((r) => (r.alignment?.differences || []).length).length;

    badge.replaceChildren(
      el('button', {
        class: 'btn btn-sm btn-secondary', type: 'button', style: 'margin-right:.4rem',
        title: 'Every saved version of this plasmid, and rolling back to one',
        onclick: () => showHistory(seq.id, {
          onRestored: async () => {
            const shown = this.activeRead;
            await this.selectReference(seq.id);
            this.refreshList();
            const again = shown && this.reads.find((r) => r.name === shown.name);
            if (again) await this.showRead(again);
          },
        }),
      }, 'History'),
      seq.confirmed
        ? el('span', { class: 'badge badge-confirmed' }, '✓ Confirmed and sequenced')
        : el('span', { class: 'badge' }, 'Not yet confirmed'));

    const parts = [];
    if (seq.confirmed) {
      parts.push(el('div', {},
        el('b', {}, 'Glycerol stock: '), Stocks.render(seq.glycerol_stock),
        seq.confirmed_clone ? ` · clone ${seq.confirmed_clone}` : '',
        seq.confirmed_by ? ` · confirmed by ${seq.confirmed_by}` : '',
        seq.confirmed_at ? ` on ${String(seq.confirmed_at).slice(0, 16)}` : ''));
      if (seq.can_change) parts.push(el('div', { class: 'btn-group', style: 'margin-top:.4rem' },
        el('button', {
          class: 'btn btn-sm btn-secondary',
          onclick: async () => {
            if (!await confirmDialog('Withdraw confirmation',
              `Mark ${seq.name} as no longer confirmed? The reads and their judgements stay.`,
              'Withdraw')) return;
            const res = await API.del(`/api/sequences/${seq.id}/confirm`);
            await this.selectReference(seq.id);
            this.refreshList();
            toast('Confirmation withdrawn', 'success');
            if (res.moclo_note) toast(res.moclo_note, 'error', 8000);
          },
        }, 'Withdraw confirmation')));
    } else {
      parts.push(el('div', {}, !this.reads.length
        ? 'No reads yet.'
        : seq.can_change
          ? 'Judge an alignment sufficient to confirm this plasmid.'
          : 'Not confirmed yet; the owner judges the alignments.'));
    }
    parts.push(el('div', { class: 'hint', style: 'margin-top:.35rem' },
      `${this.reads.length} read(s) · ${ok} sufficient · ${bad} not sufficient · `
      + `${diffs} with differences`));
    summary.replaceChildren(...parts);
  },

  /**
   * The columns of the alignment each of its differences covers (a run of
   * insertion or deletion is one difference but several columns, one per
   * base), in the order the server lists them.
   */
  differenceColumns(a) {
    const n = this.reference.sequence.length;
    const found = new Map();          // "type:position" -> runs of columns, in order
    let pos = a.ref_start;
    let c = 0;
    while (c < a.top.length) {
      const t = a.top[c];
      const b = a.bottom[c];
      if (t === b) { if (t !== '-') pos += 1; c += 1; continue; }
      const type = t === '-' ? 'insertion' : b === '-' ? 'deletion' : 'mismatch';
      const key = `${type}:${pos % n}`;
      if (!found.has(key)) found.set(key, []);
      if (type === 'mismatch') { found.get(key).push([c]); pos += 1; c += 1; continue; }
      const runStart = c;
      if (type === 'insertion') { while (c < a.top.length && a.top[c] === '-') c += 1; } else { while (c < a.top.length && a.bottom[c] === '-') c += 1; }
      found.get(key).push(Array.from({ length: c - runStart }, (_, j) => runStart + j));
      if (type === 'deletion') pos += c - runStart;
    }
    return a.differences.map((d) => found.get(`${d.type}:${d.position}`)?.shift() ?? null);
  },

  /** Each difference as a button that goes to it in the alignment. */
  differenceList(a, go) {
    const label = (d) => `${d.type === 'mismatch' ? `${d.ref}→${d.read}`
      : d.length > 1 ? `${d.type} of ${fmt(d.length)} bp` : d.type} @ ${fmt(d.position + 1)}`;
    const shown = a.differences.slice(0, 60);
    return el('div', { class: 'diff-list' },
      ...shown.map((d, k) => el('button', {
        class: `diff-chip diff-${d.type}`, type: 'button', 'data-diff': String(k),
        title: 'Go to this difference in the alignment', onclick: () => go(k),
      }, label(d))),
      a.differences.length > shown.length
        ? el('span', { class: 'hint' }, ` and ${fmt(a.differences.length - shown.length)} more: use Next`) : null);
  },

  /** Previous / Next through the differences, and which one is shown. */
  differenceNav(a, view, read) {
    const status = el('span', { class: 'hint' }, `${fmt(a.differences.length)} difference${a.differences.length > 1 ? 's' : ''}`);
    const nav = {
      at: -1,
      go(k) {
        const count = a.differences.length;
        if (!count) return;
        nav.at = ((k % count) + count) % count;
        view.goTo(nav.at);
        status.textContent = `Difference ${fmt(nav.at + 1)} of ${fmt(count)}`;
        // The matching button in the list above, marked as the one shown.
        for (const chip of document.querySelectorAll('#alignment .diff-chip')) {
          chip.classList.toggle('active', Number(chip.dataset.diff) === nav.at);
        }
      },
    };
    nav.bar = el('div', { class: 'diff-nav' },
      el('button', { class: 'btn btn-sm btn-secondary', type: 'button', title: 'Previous difference',
                     onclick: () => nav.go(nav.at - 1) }, '◀ Previous'),
      el('button', { class: 'btn btn-sm btn-secondary', type: 'button', title: 'Next difference',
                     onclick: () => nav.go(nav.at + 1) }, 'Next ▶'),
      status,
      // Whoever may change the plasmid may correct it to what was sequenced.
      this.reference?.can_change ? el('span', { class: 'diff-nav-fix' },
        el('button', {
          class: 'btn btn-sm btn-secondary', type: 'button',
          title: 'Change the plasmid at the difference shown to what this read has',
          onclick: () => (nav.at < 0
            ? toast('Choose a difference first: click it, or use Next', 'error')
            : this.correctFromRead(read, [nav.at])),
        }, 'Correct this one'),
        el('button', {
          class: 'btn btn-sm btn-secondary', type: 'button',
          title: 'Change the plasmid to what this read has at every difference',
          onclick: () => this.correctFromRead(read, a.differences.map((_, k) => k)),
        }, 'Correct all to this read')) : null);
    return nav;
  },

  /**
   * The plasmid with the chosen differences of an alignment changed to what
   * the read has. The bases change as they would typed in the editor, so
   * features and translations move, stretch or shrink with them and keep
   * marking the same parts of the plasmid. Worked from the last position back,
   * so each change leaves the positions of the ones still to do as they were.
   */
  correctedDocument(doc, differences) {
    const ordered = [...differences].sort((x, y) => y.position - x.position || y.k - x.k);
    let d = { ...doc };
    for (const c of ordered) {
      const p = c.position;
      const [start, end, text] = c.type === 'mismatch' ? [p, p + 1, c.read]
        : c.type === 'deletion' ? [p, p + (c.length || 1), ''] : [p, p, c.read];   // an insertion goes before p
      d = { ...d, ...applyEdit(d, start, end, text) };
    }
    return d;
  },

  /** Ask, then correct the plasmid to what a read has at the chosen differences. */
  correctFromRead(read, indexes) {
    const a = read.alignment;
    const chosen = indexes.map((k) => ({ ...a.differences[k], k }));
    if (!chosen.length) return;
    const describe = (d) => (d.type === 'mismatch' ? `${d.ref} → ${d.read} at ${fmt(d.position + 1)}`
      : d.type === 'deletion' ? `remove ${d.length > 1 ? `${fmt(d.length)} bp` : d.ref} at ${fmt(d.position + 1)}`
      : `insert ${d.length > 1 ? `${fmt(d.length)} bp` : d.read} before ${fmt(d.position + 1)}`);
    const seq = this.reference;
    modal({
      title: chosen.length === 1 ? 'Correct the plasmid to this read' : `Correct ${fmt(chosen.length)} differences to this read`,
      build: (body) => body.append(
        el('p', {}, 'Changes ', el('b', { text: seq.name }), ` to what ${read.name} has:`),
        el('ul', { class: 'fix-list' },
          ...chosen.slice(0, 12).map((d) => el('li', { class: 'mono' }, describe(d))),
          chosen.length > 12 ? el('li', { class: 'hint' }, `and ${fmt(chosen.length - 12)} more`) : null),
        el('p', { class: 'hint' },
          'Features and translations move with the changed bases, so they keep marking the same parts. '
          + 'Every read is then aligned again. Check the trace first: an error in the read would be written into the plasmid.'),
        ...(seq.confirmed ? [el('p', { class: 'hint' }, 'The plasmid stays confirmed: its reads keep their verdicts.')] : [])),
      buttons: [
        { label: 'Cancel', kind: 'secondary' },
        {
          label: chosen.length === 1 ? 'Correct' : `Correct ${fmt(chosen.length)}`,
          onClick: async () => { await this.applyCorrections(seq.id, read, chosen); return true; },
        },
      ],
    });
  },

  /** Save the corrected plasmid, align its reads again, and show the same read. */
  async applyCorrections(sequenceId, read, chosen) {
    const { sequence: doc } = await API.get(`/api/sequences/${sequenceId}`);
    const fixed = this.correctedDocument(doc, chosen);
    let mocloNote = null;
    let synced = null;
    try {
      const saved = await API.put(`/api/sequences/${sequenceId}`, {
        document: { name: doc.name, sequence: fixed.sequence, circular: doc.circular,
                    description: doc.description || '', features: fixed.features,
                    translations: fixed.translations || [] },
        // Kept in its history as a correction, with the read it came from.
        base_revision: doc.revision,
        revision: { kind: 'corrected',
                    note: `${chosen.length} difference${chosen.length > 1 ? 's' : ''} to read ${read.name}`
                          + (read.clone_number ? ` (clone ${read.clone_number})` : '') },
      });
      synced = saved.synced_to_moclo;
    } catch (err) {
      // Saved here, but MoClo was changed meanwhile or could not be written:
      // the plasmid is corrected, and the editor's Save resolves MoClo.
      if (!err.payload?.sequence) throw err;
      mocloNote = err.message;
    }
    await API.post(`/api/sequences/${sequenceId}/reads/realign`, {});
    await this.selectReference(sequenceId);
    this.refreshList();
    // Re-aligning stores each read again, under a new id.
    const again = this.reads.find((r) => r.name === read.name && r.clone_number === read.clone_number)
      || this.reads.find((r) => r.name === read.name);
    if (again) await this.showRead(again);
    const what = `${fmt(chosen.length)} difference${chosen.length > 1 ? 's' : ''}`;
    toast(`Corrected ${what}; features moved with them and the reads were aligned again`
          + (synced ? ', and MoClo updated' : ''), 'success', 6000);
    if (mocloNote) toast(`MoClo was not updated: ${mocloNote} Open the plasmid in the editor and save it to resolve this.`, 'error', 12000);
  },

  /** One row of bases, with the bases that differ marked (and the ones shown outlined). */
  alignedRow(text, offset, diffAt, focusColumns) {
    const row = el('div', { class: 'seqmap-row' });
    let plain = '';
    for (let j = 0; j < text.length; j++) {
      const diff = diffAt.get(offset + j);
      if (!diff) { plain += text[j]; continue; }
      if (plain) { row.append(plain); plain = ''; }
      row.append(el('span', {
        class: `aln-diff aln-${diff.type}${focusColumns?.has(offset + j) ? ' aln-focus' : ''}`,
        'data-diff': String(diff.index), title: diff.label,
      }, text[j]));
    }
    if (plain) row.append(plain);
    return row;
  },

  /**
   * Reference over read, in blocks, with mismatches marked, and the
   * reference's features above it, so you see which of them the read covers.
   * Every difference is coloured, and `goTo(k)` brings the k-th into view.
   * Lines are as long as the box allows, and re-flow when it is resized.
   */
  alignmentView(a, onPick) {
    const lanes = this.alignedFeatures(a);
    const wrap = el('div', { class: 'seqmap', style: 'max-height:24rem;overflow:auto' });
    let width = 60;          // until the box is on the page and can be measured
    const columns = this.differenceColumns(a);
    const diffAt = new Map();         // column -> the difference covering it
    columns.forEach((cols, k) => {
      if (!cols) return;
      const d = a.differences[k];
      const label = `${d.type === 'mismatch' ? `${d.ref}→${d.read}`
        : d.length > 1 ? `${d.type} of ${fmt(d.length)} bp` : d.type} at ${fmt(d.position + 1)}`;
      for (const c of cols) {
        if (!diffAt.has(c)) diffAt.set(c, { index: k, type: d.type, label });
      }
    });
    let focus = null;                 // the columns of the difference shown
    const draw = () => {
      const blocks = [];
      for (let i = 0; i < a.top.length; i += width) {
        const top = a.top.slice(i, i + width);
        const bottom = a.bottom.slice(i, i + width);
        const marks = [...top].map((c, j) => (c === bottom[j] ? '|' : ' ')).join('');
        const refStart = (a.ref_start + [...a.top.slice(0, i)].filter((c) => c !== '-').length)
          % this.reference.sequence.length;
        blocks.push(el('div', { class: 'seqmap-block' },
          el('div', { class: 'seqmap-num', text: String(refStart + 1) }),
          el('div', { class: 'seqmap-rows' },
            ...this.featureLanes(lanes, i, Math.min(i + width, a.top.length)),
            this.alignedRow(top, i, diffAt, focus),
            el('div', { class: 'seqmap-row', style: 'color:var(--text-secondary)', text: marks }),
            this.alignedRow(bottom, i, diffAt, focus))));
      }
      wrap.replaceChildren(...blocks);
    };
    draw();
    // Clicking a coloured base picks that difference.
    wrap.addEventListener('click', (e) => {
      const base = e.target.closest('.aln-diff');
      if (base) onPick?.(Number(base.dataset.diff));
    });
    /** Outline the k-th difference and scroll it into the middle of the box. */
    wrap.goTo = (k) => {
      focus = columns[k] ? new Set(columns[k]) : null;
      if (!focus) return;
      draw();
      const target = wrap.querySelector('.aln-focus');
      if (!target) return;
      wrap.scrollTop += target.getBoundingClientRect().top - wrap.getBoundingClientRect().top
        - wrap.clientHeight / 3;
      wrap.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    };
    if ('ResizeObserver' in window) {
      let shownOnce = false;
      const observer = new ResizeObserver(() => {
        // Not on the page yet (it is about to be), or replaced by another read's.
        if (!wrap.isConnected) {
          if (shownOnce) observer.disconnect();
          return;
        }
        shownOnce = true;
        const fits = basesPerLine(wrap);
        if (!fits || fits === width) return;
        // Keep the line at the top of the box's own scroll in view.
        const viewTop = () => wrap.getBoundingClientRect().top + parseFloat(getComputedStyle(wrap).paddingTop);
        const top = viewTop();
        const shown = [...wrap.children].findIndex((b) => b.getBoundingClientRect().bottom > top);
        const column = Math.max(shown, 0) * width;
        width = fits;
        draw();
        const line = wrap.children[Math.floor(column / width)];
        if (line) wrap.scrollTop += line.getBoundingClientRect().top - viewTop();
      });
      observer.observe(wrap);
    }
    return wrap;
  },

  /**
   * The reference's features in alignment columns: for each, the runs of
   * columns it covers, stacked in lanes so overlapping features do not hide
   * each other. A gap in the reference (bases the read has extra) counts as
   * inside a feature when the base before it is.
   */
  alignedFeatures(a) {
    const features = this.reference?.features || [];
    const n = this.reference?.sequence.length || 0;
    if (!features.length || !n) return [];
    // The reference position each column belongs to.
    const refAt = [];
    let pos = a.ref_start;
    for (const c of a.top) {
      refAt.push((c === '-' ? Math.max(pos - 1, a.ref_start) : pos) % n);
      if (c !== '-') pos += 1;
    }
    const spans = (f) => (f.segments?.length ? f.segments
      : f.end > f.start ? [[f.start, f.end]] : [[f.start, n], [0, f.end]]);
    const placed = [];
    for (const f of features) {
      const inside = spans(f);
      const runs = [];
      refAt.forEach((p, col) => {
        if (!inside.some(([s, e]) => p >= s && p < e)) return;
        const last = runs[runs.length - 1];
        if (last && last[1] === col) last[1] = col + 1;
        else runs.push([col, col + 1]);
      });
      if (runs.length) placed.push({ f, runs, from: runs[0][0], to: runs[runs.length - 1][1] });
    }
    // Stack: each feature goes in the first lane it does not overlap.
    const lanes = [];
    for (const item of placed.sort((x, y) => x.from - y.from || y.to - x.to)) {
      const lane = lanes.find((l) => l.every((o) => o.to <= item.from || item.to <= o.from));
      if (lane) lane.push(item); else lanes.push([item]);
    }
    return lanes;
  },

  /** Feature bars for alignment columns [from, to), one row per lane in use. */
  featureLanes(lanes, from, to) {
    const rows = [];
    for (const lane of lanes) {
      const bars = [];
      for (const { f, runs } of lane) {
        for (const [s, e] of runs) {
          const a = Math.max(s, from);
          const b = Math.min(e, to);
          if (b <= a) continue;
          const label = f.strand === -1 ? `◀ ${f.name}` : `${f.name} ▶`;
          bars.push(el('div', {
            class: 'aln-feat',
            style: `left:${a - from}ch;width:${b - a}ch;background:${featureColor(f)}`,
            title: `${f.name} (${f.type}) ${f.start + 1}..${f.end}${f.strand === -1 ? ' complement' : ''}`,
          }, b - a > 4 ? el('span', {}, label) : null));
        }
      }
      if (bars.length) rows.push(el('div', { class: 'seqmap-row feature-lane' }, ...bars));
    }
    return rows;
  },

  drawTrace() {
    const trace = this.trace;
    const canvas = document.getElementById('traceCanvas');
    if (!trace || !canvas) return;
    const channels = trace.channels || {};
    const peaks = trace.peaks || [];
    const bases = trace.sequence || '';
    const quality = trace.quality || [];
    const points = Math.max(...Object.values(channels).map((c) => c.length), 1);
    const scale = this.traceScale;
    canvas.width = Math.max(600, Math.min(60000, Math.round(points * scale * 0.5)));
    const h = canvas.height;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, h);
    const maxY = Math.max(1, ...Object.values(channels).flatMap((c) => c));
    const traceH = h - 42;
    const x = (i) => (i / points) * canvas.width;

    // Quality bars
    ctx.fillStyle = '#e5e7eb';
    peaks.forEach((p, i) => {
      const q = quality[i] ?? 0;
      const bh = Math.min(1, q / 60) * 18;
      ctx.fillRect(x(p) - 1.5, traceH + 2, 3, bh);
    });

    const colors = { A: '#16a34a', C: '#2563eb', G: '#ca8a04', T: '#dc2626' };
    for (const [base, data] of Object.entries(channels)) {
      ctx.beginPath();
      ctx.strokeStyle = colors[base] || '#6b7280';
      ctx.lineWidth = 1;
      data.forEach((v, i) => {
        const px = x(i);
        const py = traceH - (v / maxY) * traceH;
        i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
      });
      ctx.stroke();
    }

    // Base calls
    ctx.font = '10px ui-monospace, monospace';
    ctx.textAlign = 'center';
    peaks.forEach((p, i) => {
      const b = bases[i];
      if (!b) return;
      ctx.fillStyle = colors[b.toUpperCase()] || '#6b7280';
      ctx.fillText(b, x(p), h - 4);
    });
  },
};

document.addEventListener('DOMContentLoaded', () => Sequencing.init());
