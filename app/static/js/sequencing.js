/* Sequencing page: attach reads to a saved sequence, align them, view chromatograms. */

const Sequencing = {
  sequences: [],
  reference: null,
  reads: [],
  activeRead: null,
  traceScale: 2,

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
      label: (s) => s.name,
      render: (s, query) => el('div', {},
        el('div', { class: 'combo-name' }, highlight(s.name, query),
          s.confirmed ? el('span', { class: 'confirmed-tick', title: 'Confirmed and sequenced' }, ' ✓') : null),
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
      const { sequences } = await API.get('/api/sequences');
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

  /** Keep the picker's metadata (read counts, green check) current. */
  async refreshList() {
    try {
      const { sequences } = await API.get('/api/sequences');
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
      const { sequence } = await API.get(`/api/sequences/${id}`);
      this.reference = sequence;
      this.reads = sequence.reads || [];
      document.getElementById('refInfo').textContent =
        `${fmt(sequence.sequence.length)} bp, ${sequence.circular ? 'circular' : 'linear'}, ${sequence.features.length} features`;
      this.renderReads();
      this.renderVerification();
    } catch (err) {
      toast(err.message, 'error');
    }
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
          el('span', { class: 'item-meta' },
            bad ? ' · not mapped'
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
          el('button', { class: 'tool-btn', title: 'Remove read', onclick: () => this.remove(r) }, '🗑')));
    }));
    this.renderCoverage();
  },

  renderCoverage() {
    const bar = document.getElementById('coverage');
    const text = document.getElementById('coverageText');
    if (!this.reference || !this.reads.length) {
      bar.replaceChildren();
      text.textContent = this.reference ? 'No reads to show coverage for.' : '';
      return;
    }
    const n = this.reference.sequence.length;
    const spans = [];
    for (const r of this.reads) {
      const a = r.alignment;
      if (!a?.mapped) continue;
      if (a.ref_end > a.ref_start) spans.push([a.ref_start, a.ref_end]);
      else spans.push([a.ref_start, n], [0, a.ref_end]);
    }
    spans.sort((x, y) => x[0] - y[0]);
    const merged = [];
    for (const [s, e] of spans) {
      if (merged.length && s <= merged[merged.length - 1][1]) {
        merged[merged.length - 1][1] = Math.max(merged[merged.length - 1][1], e);
      } else merged.push([s, e]);
    }
    bar.replaceChildren(...merged.map(([s, e]) => el('div', {
      class: 'coverage-seg',
      style: `left:${(s / n) * 100}%;width:${((e - s) / n) * 100}%`,
      title: `${fmt(s + 1)}–${fmt(e)}`,
    })));
    const covered = merged.reduce((sum, [s, e]) => sum + (e - s), 0);
    const mapped = this.reads.filter((r) => r.alignment?.mapped).length;
    text.textContent = `${mapped} of ${this.reads.length} read(s) mapped — ${((covered / n) * 100).toFixed(1)}% of the sequence covered.`;
  },

  async remove(read) {
    if (!await confirmDialog('Remove read', `Remove “${read.name}”?`, 'Remove')) return;
    try {
      await API.del(`/api/sequences/reads/${read.id}`);
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
          ` — reference ${fmt(a.ref_start + 1)}–${fmt(a.ref_end)}, `,
          a.strand === -1 ? 'reverse strand' : 'forward strand'),
        a.differences.length
          ? el('div', { class: 'hint' },
            a.differences.slice(0, 40).map((d) =>
              `${d.type === 'mismatch' ? `${d.ref}→${d.read}` : d.type} @ ${fmt(d.position + 1)}`).join(', ')
            + (a.differences.length > 40 ? ' …' : ''))
          : el('div', { class: 'hint' }, 'No differences from the reference.')));
      nodes.push(this.verdictBar(read));
      nodes.push(this.alignmentView(a));
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
    const clone = el('input', {
      type: 'text', value: read.clone_number || '', placeholder: 'clone',
      style: 'width:6rem', title: 'Which colony this read came from',
    });
    const judge = async (verdict) => {
      try {
        const res = await API.post(`/api/sequences/reads/${read.id}/verdict`, {
          verdict, clone_number: clone.value,
        });
        await this.selectReference(this.reference.id);
        const updated = this.reads.find((r) => r.id === read.id);
        if (updated) await this.showRead(updated);
        if (res.needs_confirmation) this.askGlycerolStock(clone.value || read.clone_number);
        else toast(verdict === 'sufficient' ? 'Marked sufficient' : 'Marked not sufficient',
                   'success', 2500);
      } catch (err) {
        toast(err.message, 'error');
      }
    };
    return el('div', { class: 'btn-group', style: 'margin:.5rem 0 .75rem;align-items:center' },
      el('span', { class: 'hint' }, 'Clone'),
      clone,
      el('button', { class: 'btn btn-sm', onclick: () => judge('sufficient') },
        '✓ Alignment is sufficient'),
      el('button', { class: 'btn btn-sm btn-secondary', onclick: () => judge('insufficient') },
        '✗ Not sufficient'),
      read.verdict
        ? el('button', {
            class: 'tool-btn', title: 'Clear this judgement',
            onclick: async () => {
              await API.post(`/api/sequences/reads/${read.id}/verdict`, { verdict: null });
              await this.selectReference(this.reference.id);
            },
          }, 'clear')
        : null,
      read.verdict_by
        ? el('span', { class: 'hint' }, `${read.verdict} by ${read.verdict_by}`)
        : null);
  },

  /** Confirming a plasmid records which glycerol stock it is kept as. */
  askGlycerolStock(clone) {
    const seq = this.reference;
    modal({
      title: 'Confirm this plasmid as sequenced',
      build: (body) => {
        body.append(
          el('p', {}, 'The alignment is good, so ',
            el('b', { text: seq.name }),
            ' can be marked as confirmed and sequenced.'),
          el('div', { class: 'field' },
            el('label', { for: 'glyStock' }, 'Glycerol stock number'),
            el('input', { type: 'text', id: 'glyStock', placeholder: 'e.g. GS-2026-041' }),
            el('span', { class: 'hint' }, 'Recorded with the plasmid so the stock can be found later.')),
          el('div', { class: 'field' },
            el('label', { for: 'glyClone' }, 'Confirmed clone'),
            el('input', { type: 'text', id: 'glyClone', value: clone || '' })));
        setTimeout(() => body.querySelector('#glyStock')?.focus(), 0);
      },
      buttons: [
        { label: 'Not yet', kind: 'secondary' },
        {
          label: 'Confirm plasmid',
          onClick: async ({ body }) => {
            const stock = body.querySelector('#glyStock').value.trim();
            if (!stock) { toast('A glycerol stock number is required', 'error'); return false; }
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

    badge.replaceChildren(seq.confirmed
      ? el('span', { class: 'badge badge-confirmed' }, '✓ Confirmed and sequenced')
      : el('span', { class: 'badge' }, 'Not yet confirmed'));

    const parts = [];
    if (seq.confirmed) {
      parts.push(el('div', {},
        el('b', {}, 'Glycerol stock: '), seq.glycerol_stock || '—',
        seq.confirmed_clone ? ` · clone ${seq.confirmed_clone}` : '',
        seq.confirmed_by ? ` · confirmed by ${seq.confirmed_by}` : '',
        seq.confirmed_at ? ` on ${String(seq.confirmed_at).slice(0, 16)}` : ''));
      parts.push(el('div', { class: 'btn-group', style: 'margin-top:.4rem' },
        el('button', {
          class: 'btn btn-sm btn-secondary',
          onclick: async () => {
            if (!await confirmDialog('Withdraw confirmation',
              `Mark ${seq.name} as no longer confirmed? The reads and their judgements stay.`,
              'Withdraw')) return;
            await API.del(`/api/sequences/${seq.id}/confirm`);
            await this.selectReference(seq.id);
            toast('Confirmation withdrawn', 'success');
          },
        }, 'Withdraw confirmation')));
    } else {
      parts.push(el('div', {}, this.reads.length
        ? 'Judge an alignment sufficient to confirm this plasmid.'
        : 'No reads yet.'));
    }
    parts.push(el('div', { class: 'hint', style: 'margin-top:.35rem' },
      `${this.reads.length} read(s) · ${ok} sufficient · ${bad} not sufficient · `
      + `${diffs} with differences`));
    summary.replaceChildren(...parts);
  },

  /** Reference over read, in blocks, with mismatches marked. */
  alignmentView(a) {
    const width = 60;
    const wrap = el('div', { class: 'seqmap', style: 'max-height:24rem;overflow:auto' });
    for (let i = 0; i < a.top.length; i += width) {
      const top = a.top.slice(i, i + width);
      const bottom = a.bottom.slice(i, i + width);
      const marks = [...top].map((c, j) => (c === bottom[j] ? '|' : ' ')).join('');
      const refStart = a.ref_start + [...a.top.slice(0, i)].filter((c) => c !== '-').length;
      wrap.appendChild(el('div', { class: 'seqmap-block' },
        el('div', { class: 'seqmap-num', text: String(refStart + 1) }),
        el('div', { class: 'seqmap-rows' },
          el('div', { class: 'seqmap-row', text: top }),
          el('div', { class: 'seqmap-row', style: 'color:var(--text-secondary)', text: marks }),
          el('div', { class: 'seqmap-row', text: bottom }))));
    }
    return wrap;
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
