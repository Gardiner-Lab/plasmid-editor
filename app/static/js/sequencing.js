/* Sequencing page: attach reads to a saved sequence, align them, view chromatograms. */

/** Phred quality below which a base call is a guess worth checking on the trace. */
const LOW_QUALITY = 20;

/**
 * Where each column of an alignment falls: its reference position (-1 in a
 * column of bases only the read has) and its base in the read as uploaded
 * (-1 where the read lacks the reference's bases). A reverse-strand read is
 * shown reverse-complemented, so its bases count down from its end. An older
 * stored alignment does not say where in the read it starts: `read` is null.
 */
function alignmentColumns(a, n) {
  const ref = new Array(a.top.length);
  const read = a.read_start === undefined ? null : new Array(a.top.length);
  let pos = a.ref_start;
  let k = 0;
  for (let c = 0; c < a.top.length; c++) {
    if (a.top[c] === '-') ref[c] = -1;
    else { ref[c] = pos % n; pos += 1; }
    if (a.bottom[c] === '-') { if (read) read[c] = -1; continue; }
    if (read) read[c] = a.strand === -1 ? a.read_end - 1 - k : a.read_start + k;
    k += 1;
  }
  return { ref, read };
}

/**
 * The columns of the alignment each of its differences covers (a run of
 * insertion or deletion is one difference but several columns, one per
 * base), in the order the server lists them; null for one not found.
 */
function differenceColumns(a, n) {
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
}

/**
 * How sure the read is at a difference: the lowest quality of its own calls
 * there. A deletion has no base of its own, so the bases either side of it
 * are what the call rests on. Null without qualities (a FASTA read).
 */
function differenceQuality(cols, read, quality) {
  if (!cols?.length || !read || !quality?.length) return null;
  let at = cols.map((c) => read[c]).filter((i) => i >= 0);
  if (!at.length) at = [read[cols[0] - 1], read[cols[cols.length - 1] + 1]].filter((i) => i >= 0);
  const qs = at.map((i) => quality[i]).filter((q) => q !== undefined);
  return qs.length ? Math.min(...qs) : null;
}

/**
 * Reference spans [start, end) merged into the stretches they cover between
 * them, in order. A span with end <= start runs through the origin.
 */
function mergedCoverage(spans, n) {
  const flat = spans.flatMap(([s, e]) => (e > s ? [[s, e]] : [[s, n], [0, e]]))
    .sort((x, y) => x[0] - y[0]);
  const merged = [];
  for (const [s, e] of flat) {
    const last = merged[merged.length - 1];
    if (last && s <= last[1]) last[1] = Math.max(last[1], e);
    else merged.push([s, e]);
  }
  return merged;
}

/** The stretches of [0, n) that `covered` (merged, in order) leaves out. */
function coverageGaps(covered, n) {
  const gaps = [];
  let at = 0;
  for (const [s, e] of covered) {
    if (s > at) gaps.push([at, s]);
    at = Math.max(at, e);
  }
  if (at < n) gaps.push([at, n]);
  return gaps;
}

/**
 * The stretches of a read that are not in its alignment, in the order they
 * lie along the reference: the ends trimmed for low quality, and what of the
 * rest did not align - before the aligned part, between its pieces, or after
 * it. Each has where it is in the read as uploaded ([from, to)), and `at`, the
 * reference position it adjoins: the bases would go in before `at`. A reverse
 * read lies along the reference back to front, so its first bases come last.
 * An alignment stored before reads knew where they start has none to give.
 */
function unalignedStretches(a) {
  const segs = a.segments?.filter((s) => s.read_start !== undefined);
  if (!segs?.length) return [];
  const total = a.read_length;
  const [t0, t1] = a.trim || [0, total];
  const rev = a.strand === -1;
  const out = [];
  const add = (from, to, kind, at, side) => { if (to > from) out.push({ from, to, kind, at, side }); };
  const [headAt, headSide] = rev ? [a.ref_end, 'after'] : [a.ref_start, 'before'];
  const [tailAt, tailSide] = rev ? [a.ref_start, 'before'] : [a.ref_end, 'after'];
  add(0, t0, 'trimmed', headAt, headSide);
  add(t0, segs[0].read_start, 'unaligned', headAt, headSide);
  for (let i = 0; i + 1 < segs.length; i++) {
    add(segs[i].read_end, segs[i + 1].read_start, 'unaligned', rev ? segs[i].ref_start : segs[i].ref_end, 'between');
  }
  add(segs[segs.length - 1].read_end, t1, 'unaligned', tailAt, tailSide);
  add(t1, total, 'trimmed', tailAt, tailSide);
  return rev ? out.reverse() : out;
}

/** A stretch's bases as the plasmid reads them: reverse-complemented for a reverse read. */
function stretchSequence(bases, s, strand) {
  const piece = bases.slice(s.from, s.to).toUpperCase();
  return strand === -1 ? DNA.revComp(piece) : piece;
}

/** A round step for ruler ticks: about `count` of them along n bases. */
function rulerStep(n, count = 8) {
  const raw = n / count;
  const power = 10 ** Math.floor(Math.log10(raw));
  return [1, 2, 5, 10].map((m) => m * power).find((s) => s >= raw) || power * 10;
}

/** A difference in a few characters: "C→T at 511", "+60 bp at 721", "−G at 720". */
function describeDifference(d) {
  const at = ` at ${fmt(d.position + 1)}`;
  if (d.type === 'mismatch') return `${d.ref}→${d.read}${at}`;
  const what = d.length > 1 ? `${fmt(d.length)} bp` : (d.type === 'insertion' ? d.read : d.ref);
  return `${d.type === 'insertion' ? '+' : '−'}${what}${at}`;
}

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
      this.activeRead = null;
      this.hideRead();
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
      if (!this.activeRead) this.hideRead();
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
    this.renderMap();
  },

  /**
   * What the views need about a read's alignment, worked out once per read:
   * where each column falls in the reference and the read, and for each
   * difference its columns, how sure the read is there, and the features it
   * falls in.
   */
  details(read) {
    if (read._details) return read._details;
    const a = read.alignment;
    if (!a?.mapped || !a.top) {
      read._details = { diffs: [], cols: null, quality: null };
      return read._details;
    }
    const n = this.reference.sequence.length;
    const cols = alignmentColumns(a, n);
    const quality = cols.read && read.quality?.length ? read.quality : null;
    const diffCols = differenceColumns(a, n);
    const diffs = a.differences.map((d, k) => {
      const q = differenceQuality(diffCols[k], cols.read, quality);
      return { ...d, k, cols: diffCols[k], q, low: q !== null && q < LOW_QUALITY,
               features: this.featuresAt(d.position) };
    });
    read._details = { diffs, cols, quality, ...this.unalignedParts(a) };
    return read._details;
  },

  /**
   * How much of the read, quality-trimmed ends aside, is not in the
   * reference at all: before its first aligned piece and after its last (as
   * the read lies along the reference, so `before` reaches out from
   * ref_start and `after` from ref_end), and in total, gaps between pieces
   * included. Only alignments that say where in the read they lie can tell.
   */
  unalignedParts(a) {
    const segs = a.segments?.filter((s) => s.read_start !== undefined);
    if (!segs?.length) return { unaligned: 0, before: 0, after: 0 };
    const [t0, t1] = a.trim || [0, a.read_length];
    let unaligned = 0;
    let cursor = t0;
    for (const s of segs) {
      if (s.read_start > cursor) unaligned += s.read_start - cursor;
      cursor = Math.max(cursor, s.read_end);
    }
    unaligned += Math.max(0, t1 - cursor);
    const head = Math.max(0, segs[0].read_start - t0);         // in the read as uploaded
    const tail = Math.max(0, t1 - segs[segs.length - 1].read_end);
    // A reverse read lies along the reference back to front.
    return { unaligned, before: a.strand === -1 ? tail : head, after: a.strand === -1 ? head : tail };
  },

  /** A quarter or more of the read is not in the reference: that, not its differences, is the news. */
  mostlyElsewhere(read) {
    const { unaligned } = this.details(read);
    return read.alignment?.read_length ? unaligned / read.alignment.read_length >= 0.25 : false;
  },

  /** The names of the reference's features at a position, coding sequences first. */
  featuresAt(position) {
    const n = this.reference.sequence.length;
    const inside = (f) => (f.segments?.length ? f.segments
      : f.end > f.start ? [[f.start, f.end]] : [[f.start, n], [0, f.end]])
      .some(([s, e]) => position >= s && position < e);
    return (this.reference.features || []).filter(inside)
      .sort((x, y) => (y.type === 'CDS') - (x.type === 'CDS'))
      .map((f) => f.name);
  },

  /** One word on how a read compares with the reference, as a badge. */
  statusBadge(read) {
    const a = read.alignment || {};
    if (!a.mapped) return el('span', { class: 'badge badge-unmapped', text: 'not mapped' });
    const { diffs, unaligned } = this.details(read);
    if (this.mostlyElsewhere(read)) {
      return el('span', {
        class: 'badge badge-diff',
        title: `${fmt(unaligned)} bp of the ${fmt(a.read_length)} bp read is not in the reference`
          + (diffs.length ? `; ${fmt(diffs.length)} difference${diffs.length === 1 ? '' : 's'} where it aligns` : ''),
        text: `${Math.round((unaligned / a.read_length) * 100)}% not in reference`,
      });
    }
    if (!diffs.length) return el('span', { class: 'badge badge-gg', text: 'matches' });
    const low = diffs.filter((d) => d.low).length;
    const sure = diffs.length - low;
    return el('span', {
      class: `badge ${sure ? 'badge-diff' : 'badge-lowq'}`,
      title: low ? `${fmt(low)} of them on low-quality bases: check the trace` : null,
      text: sure ? `${fmt(diffs.length)} diff${diffs.length === 1 ? '' : 's'}`
        : `${fmt(low)} low-quality diff${low === 1 ? '' : 's'}`,
    });
  },

  /**
   * Every read on one map of the plasmid: where each landed, which way it
   * reads, and where it differs from the reference, so which reads agree,
   * which don't, and what no read has covered yet are seen at once. Below
   * them, what the mapped reads cover together. A read, or one of its marks,
   * opens its alignment.
   */
  renderMap() {
    const box = document.getElementById('readMap');
    document.getElementById('readsTitle').textContent =
      this.reads.length ? `Reads (${fmt(this.reads.length)})` : 'Reads';
    if (!this.reference) {
      box.replaceChildren(el('div', { class: 'empty' }, 'Choose a reference sequence.'));
      return;
    }
    if (!this.reads.length) {
      box.replaceChildren(el('div', { class: 'empty' }, 'No reads attached yet: add .ab1 or FASTA reads above.'));
      return;
    }
    const n = this.reference.sequence.length;
    const at = (p) => `${(p / n) * 100}%`;
    const place = (s, e) => `left:${at(s)};width:${at(e - s)}`;
    const pieces = (s, e) => (e > s ? [[s, e]] : [[s, n], [0, e]]);
    const cells = [];

    const ticks = [];
    for (let p = 0; p < n; p += rulerStep(n)) {
      ticks.push(el('span', { class: 'rmap-tick', style: `left:${at(p)}` }, fmt(p + 1)));
    }
    cells.push(el('div', { class: 'rmap-label rmap-axis' },
      `${this.reference.name} · ${fmt(n)} bp${this.reference.circular ? ', circular' : ''}`),
    el('div', { class: 'rmap-track rmap-ruler' }, ...ticks));

    for (const lane of this.mapFeatureLanes()) {
      cells.push(el('div', { class: 'rmap-label' }), el('div', { class: 'rmap-track rmap-features' },
        ...lane.flatMap((f) => pieces(f.start, f.end).map(([s, e]) => el('div', {
          class: 'rmap-feat', style: `${place(s, e)};background:${featureColor(f)}`,
          title: `${f.name} (${f.type}) ${fmt(f.start + 1)}..${fmt(f.end)}${f.strand === -1 ? ' complement' : ''}`,
        }, f.strand === -1 ? `◀ ${f.name}` : `${f.name} ▶`)))));
    }

    // Clone by clone, and within a clone along the plasmid; reads that did
    // not align at the end of their clone.
    const clone = (r) => r.clone_number || '￿';
    const sorted = [...this.reads].sort((x, y) => clone(x).localeCompare(clone(y), undefined, { numeric: true })
      || (!!y.alignment?.mapped - !!x.alignment?.mapped)
      || ((x.alignment?.ref_start ?? 0) - (y.alignment?.ref_start ?? 0)));
    for (const r of sorted) {
      const a = r.alignment || {};
      const active = this.activeRead?.id === r.id;
      const open = () => this.showRead(r);
      cells.push(el('div', { class: `rmap-label rmap-read${active ? ' active' : ''}`, onclick: (ev) => {
        if (!ev.target.closest('button')) open();
      }, title: `${r.name}${r.clone_number ? `, clone ${r.clone_number}` : ''}` },
      r.clone_number ? el('span', { class: 'badge', text: `clone ${r.clone_number}` }) : null,
      el('span', { class: 'rmap-name', text: r.name }),
      r.verdict ? el('span', {
        class: r.verdict === 'sufficient' ? 'verdict-ok' : 'verdict-bad',
        title: r.verdict === 'sufficient' ? 'Judged sufficient' : 'Judged not sufficient',
      }, r.verdict === 'sufficient' ? '✓' : '✗') : null,
      this.statusBadge(r),
      this.reference.can_change
        ? el('button', { class: 'tool-btn rmap-remove', title: 'Remove read', onclick: () => this.remove(r) }, glyph('trash'))
        : null));

      if (!a.mapped) {
        cells.push(el('div', { class: `rmap-track rmap-none${active ? ' active' : ''}`, onclick: open },
          `did not align to the reference${a.reason ? `: ${a.reason}` : ''}`));
        continue;
      }
      const spans = (a.segments || [{ ref_start: a.ref_start, ref_end: a.ref_end }])
        .flatMap((s) => pieces(s.ref_start, s.ref_end));
      // The arrowhead at the end the read runs towards.
      const tip = a.strand === -1 ? spans.find(([s]) => s === a.ref_start) : spans.find(([, e]) => e === a.ref_end);
      const bars = spans.map((sp) => el('div', {
        class: `rmap-bar${sp === tip ? (a.strand === -1 ? ' tip-l' : ' tip-r') : ''}`,
        style: place(sp[0], sp[1]),
        title: `${r.name}: ${fmt(a.ref_start + 1)}–${fmt(a.ref_end)}, ${a.strand === -1 ? 'reverse' : 'forward'} strand, ${a.identity}% identity`,
      }));
      // What of the read did not align, reaching out from either end of it,
      // so a read mostly elsewhere does not pass for a neat fit. Cut short at
      // the ends of a linear reference, which the read runs past.
      const { before, after } = this.details(r);
      const overhangs = [];
      const overhang = (s, e, bp, side) => {
        const from = this.reference.circular ? s : Math.max(0, s);
        const to = this.reference.circular ? e : Math.min(n, e);
        const past = !this.reference.circular && (s < 0 || e > n);
        const title = `${fmt(bp)} bp of the read ${side} this is not in the reference`
          + (past ? ', and runs past its end' : '');
        for (const [ps, pe] of (from < 0 ? [[from + n, n], [0, to]] : to > n ? [[from, n], [0, to - n]] : [[from, to]])) {
          if (pe > ps) overhangs.push(el('div', { class: `rmap-overhang${past ? ' past' : ''}`, style: place(ps, pe), title }));
        }
      };
      if (before) overhang(a.ref_start - before, a.ref_start, before, 'before');
      if (after) overhang(a.ref_end, a.ref_end + after, after, 'after');
      const marks = this.details(r).diffs.map((d) => el('button', {
        type: 'button',
        class: `rmap-mark mark-${d.type}${d.low ? ' lowq' : ''}`,
        style: `left:${at(d.position)}`,
        title: `${describeDifference(d)}${d.features.length ? ` in ${d.features[0]}` : ''}`
          + `${d.q !== null ? ` · quality ${d.q}${d.low ? ', low: check the trace' : ''}` : ''}`,
        onclick: (ev) => { ev.stopPropagation(); this.showRead(r, d.k); },
      }));
      cells.push(el('div', { class: `rmap-track rmap-lane${active ? ' active' : ''}`, onclick: open },
        ...overhangs, ...bars, ...marks));
    }

    // What the mapped reads cover between them, and what none of them does.
    const mapped = this.reads.filter((r) => r.alignment?.mapped);
    const covered = mergedCoverage(mapped.flatMap((r) => (r.alignment.segments
      || [{ ref_start: r.alignment.ref_start, ref_end: r.alignment.ref_end }]).map((s) => [s.ref_start, s.ref_end])), n);
    let gaps = coverageGaps(covered, n);
    // On a circular plasmid a gap through the origin is one gap, not two.
    if (this.reference.circular && gaps.length > 1 && gaps[0][0] === 0 && gaps[gaps.length - 1][1] === n) {
      gaps = [[gaps[gaps.length - 1][0], gaps[0][1]], ...gaps.slice(1, -1)];
    }
    const total = covered.reduce((sum, [s, e]) => sum + (e - s), 0);
    cells.push(el('div', { class: 'rmap-sep' }));
    cells.push(el('div', { class: 'rmap-label rmap-axis' }, 'All reads together'),
      el('div', { class: 'rmap-track rmap-total' },
        ...covered.map(([s, e]) => el('div', { class: 'rmap-covered', style: place(s, e), title: `covered: ${fmt(s + 1)}–${fmt(e)}` })),
        ...gaps.flatMap(([s, e]) => pieces(s, e).map(([ps, pe]) => el('div', {
          class: 'rmap-gap', style: place(ps, pe), title: `not covered by any read: ${fmt(s + 1)}–${fmt(e)}`,
        })))));

    const uncovered = (this.reference.features || []).filter((f) => {
      const parts = f.segments?.length ? f.segments : pieces(f.start, f.end);
      return parts.flatMap(([s, e]) => pieces(s, e))
        .some(([s, e]) => !covered.some(([cs, ce]) => cs <= s && e <= ce));
    });
    const gapText = gaps.slice(0, 4).map(([s, e]) => `${fmt(s + 1)}–${fmt(e)}`).join(', ')
      + (gaps.length > 4 ? ` and ${fmt(gaps.length - 4)} more` : '');
    cells.push(el('div', { class: 'rmap-summary' },
      el('div', {},
        el('b', {}, `${((total / n) * 100).toFixed(1)}% of the plasmid`),
        ` is covered by ${fmt(mapped.length)} mapped read${mapped.length === 1 ? '' : 's'}`,
        gaps.length ? `; not covered: ${gapText}.` : ': every base.'),
      uncovered.length ? el('div', {}, 'Features no read covers completely: ',
        el('b', {}, uncovered.map((f) => f.name).join(', ')), '.') : null,
      this.activeRead ? null : el('div', {}, 'Click a read, or one of its marks, to see its alignment.')));
    box.replaceChildren(el('div', { class: 'rmap' }, ...cells));
  },

  /** The reference's features in lanes, so overlapping ones are not drawn over each other. */
  mapFeatureLanes() {
    const n = this.reference.sequence.length;
    const pieces = (f) => (f.end > f.start ? [[f.start, f.end]] : [[f.start, n], [0, f.end]]);
    const lanes = [];
    const features = [...(this.reference.features || [])].sort((x, y) => x.start - y.start || y.end - x.end);
    for (const f of features) {
      const mine = pieces(f);
      const clear = (lane) => lane.every((o) => pieces(o).every(([os, oe]) => mine.every(([s, e]) => oe <= s || e <= os)));
      const lane = lanes.find(clear);
      if (lane) lane.push(f); else lanes.push([f]);
    }
    return lanes;
  },

  /** No read chosen: put away its alignment and trace. */
  hideRead() {
    document.getElementById('readCard').hidden = true;
    document.getElementById('traceCard').hidden = true;
    this.trace = null;
    this.traceFocus = null;
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
    // A stretch not in the alignment opens its sequence, below.
    const reveal = (from) => {
      const item = document.getElementById(`unaligned-${from}`);
      if (!item) return;
      const fold = item.closest('details');
      if (fold) fold.open = true;
      item.scrollIntoView({ behavior: 'smooth', block: 'center' });
      item.classList.add('flash');
      setTimeout(() => item.classList.remove('flash'), 1200);
    };
    bar.replaceChildren(...blocks.map(([from, to, cls, title]) => el('div', {
      class: `coverage-seg ${cls}`,
      style: `left:${(from / total) * 100}%;width:${((to - from) / total) * 100}%`,
      title: cls ? `${title}: click to see its sequence` : title,
      onclick: cls ? () => reveal(from) : null,
    })));
    const unaligned = blocks.filter(([, , cls]) => cls === 'read-unaligned').reduce((sum, [from, to]) => sum + (to - from), 0);
    text.textContent = unaligned
      ? `${fmt(unaligned)} bp of this ${fmt(total)} bp read (${((unaligned / total) * 100).toFixed(1)}%) `
        + `did not match the reference anywhere.`
      : `The whole ${fmt(total)} bp read matched the reference` + (t0 > 0 || t1 < total ? ', aside from the trimmed ends.' : '.');
  },

  /**
   * The read's own bases that are not in the reference, a stretch at a
   * time, to copy, BLAST, or - when they belong in the plasmid - insert into
   * the reference where the read leaves it. Shown as the plasmid would read
   * them (reverse-complemented for a reverse read). A read that did not align
   * at all is one stretch, as it was read. `go(k)` shows difference k: a
   * stretch between two aligned pieces is also an insertion in the alignment.
   */
  renderUnaligned(read, go) {
    const box = document.getElementById('readUnaligned');
    const a = read.alignment;
    const bases = read.bases || '';
    if (!a || !bases) {
      box.replaceChildren();
      return;
    }
    let stretches;
    if (!a.mapped) {
      const [t0, t1] = a.trim || [0, bases.length];
      stretches = [{ from: t0, to: t1, kind: 'unaligned', side: 'whole', seq: bases.slice(t0, t1).toUpperCase() }];
    } else {
      stretches = unalignedStretches(a).map((s) => ({ ...s, seq: stretchSequence(bases, s, a.strand) }));
    }
    const unaligned = stretches.filter((s) => s.kind === 'unaligned');
    const trimmed = stretches.filter((s) => s.kind === 'trimmed');
    if (!stretches.length) {
      box.replaceChildren();
      return;
    }
    const total = unaligned.reduce((sum, s) => sum + s.seq.length, 0);
    box.replaceChildren(el('div', { class: 'unaligned' },
      el('div', { class: 'unaligned-head' },
        el('b', {}, 'Sequence not in the reference'),
        el('span', { class: 'hint' }, unaligned.length
          ? ` · ${fmt(total)} bp in ${fmt(unaligned.length)} stretch${unaligned.length === 1 ? '' : 'es'}`
            + (a.mapped && a.strand === -1 ? ' · reverse-complemented, as the plasmid reads it' : '')
          : ' · every base the read kept aligned; only its low-quality ends were trimmed')),
      ...unaligned.map((s) => this.stretchItem(read, s, go)),
      trimmed.length ? el('details', { class: 'unaligned-trimmed' },
        el('summary', {}, `Ends trimmed for low quality (${fmt(trimmed.reduce((sum, s) => sum + s.seq.length, 0))} bp)`),
        ...trimmed.map((s) => this.stretchItem(read, s, go))) : null));
  },

  /** One stretch of a read not in the reference: where it is, its bases, and what can be done with them. */
  stretchItem(read, s, go) {
    const a = read.alignment;
    const n = this.reference.sequence.length;
    const len = s.seq.length;
    const where = {
      whole: 'the whole read, which did not align',
      before: `before reference ${fmt(s.at + 1)}`,
      after: `after reference ${fmt(s.at)}`,
      between: `between two aligned parts, at reference ${fmt(s.at)}|${fmt(s.at + 1)}`,
    }[s.side];
    const name = `${read.name}_${s.from + 1}-${s.to}${a.mapped && a.strand === -1 ? '_revcomp' : ''}`;
    const fasta = `>${name} not in ${this.reference.name}\n${s.seq.match(/.{1,70}/g).join('\n')}\n`;
    const copy = (text, what) => navigator.clipboard.writeText(text)
      .then(() => toast(`${what} copied`, 'success', 2500))
      .catch(() => toast('Could not copy: select the bases and copy them', 'error'));
    // NCBI takes the query in the address; a very long one is copied to paste instead.
    const blastUrl = 'https://blast.ncbi.nlm.nih.gov/Blast.cgi?PROGRAM=blastn&PAGE_TYPE=BlastSearch&LINK_LOC=blasthome'
      + (len <= 6000 ? `&QUERY=${s.seq}` : '');
    const insertion = s.side === 'between'
      ? this.details(read).diffs.find((d) => d.type === 'insertion' && d.position === s.at % n) : null;
    const actions = [
      el('button', { class: 'btn btn-sm btn-secondary', type: 'button', onclick: () => copy(s.seq, 'Sequence') }, 'Copy'),
      el('button', { class: 'btn btn-sm btn-secondary', type: 'button', onclick: () => copy(fasta, 'FASTA') }, 'Copy FASTA'),
      el('a', {
        class: 'btn btn-sm btn-secondary', href: blastUrl, target: '_blank', rel: 'noopener',
        title: len < 20 ? 'Very short: BLAST may find nothing meaningful' : 'Search NCBI nucleotide BLAST with these bases',
        onclick: () => { if (len > 6000) copy(s.seq, 'Sequence (too long for the link: paste it into BLAST)'); },
      }, 'BLAST ↗'),
    ];
    if (s.kind === 'unaligned' && a.mapped && (s.side === 'before' || s.side === 'after') && this.reference.can_change) {
      actions.push(el('button', {
        class: 'btn btn-sm', type: 'button',
        title: 'Add these bases to the plasmid where the read leaves it',
        onclick: () => this.insertStretch(read, s),
      }, `Insert into reference ${s.side === 'before' ? `before ${fmt(s.at + 1)}` : `after ${fmt(s.at)}`}`));
    }
    if (insertion && go) {
      actions.push(el('button', { class: 'btn btn-sm btn-secondary', type: 'button', onclick: () => go(insertion.k) },
        'Go to it in the alignment'));
    }
    return el('div', { class: `unaligned-item${s.kind === 'trimmed' ? ' trimmed' : ''}`, id: `unaligned-${s.from}` },
      el('div', { class: 'unaligned-meta' },
        el('b', {}, `${fmt(len)} bp`), ` ${where}`,
        el('span', { class: 'hint' }, ` · read bases ${fmt(s.from + 1)}–${fmt(s.to)}`)),
      el('pre', { class: 'unaligned-seq mono' }, s.seq),
      el('div', { class: 'btn-group' }, ...actions));
  },

  /**
   * Ask, then insert a stretch of a read into the reference where the read
   * leaves it, through the same correction as a difference: features move
   * with it, it is kept in the plasmid's history, and every read is aligned
   * again - so the stretch then aligns, or shows how it still differs.
   */
  insertStretch(read, s) {
    const seq = this.reference;
    const len = s.seq.length;
    const place = s.side === 'before' ? `before position ${fmt(s.at + 1)}` : `after position ${fmt(s.at)}`;
    modal({
      title: `Insert ${fmt(len)} bp into the reference`,
      build: (body) => body.append(
        el('p', {}, 'Inserts these bases from ', el('b', { text: read.name }), ' into ', el('b', { text: seq.name }),
          ` ${place}, where the read leaves the reference:`),
        el('pre', { class: 'unaligned-seq mono' }, s.seq),
        el('p', { class: 'hint' },
          'Nothing is removed. If the read has these bases in place of some of the reference\'s own (another '
          + 'backbone, say), remove those in the editor afterwards. Features and translations move with the change, '
          + 'it is kept in the plasmid\'s history, and every read is aligned again. Check the trace first: an error '
          + 'in the read would be written into the plasmid.'),
        ...(seq.confirmed ? [el('p', { class: 'hint' }, 'The plasmid stays confirmed: its reads keep their verdicts.')] : [])),
      buttons: [
        { label: 'Cancel', kind: 'secondary' },
        {
          label: `Insert ${fmt(len)} bp`,
          onClick: async () => {
            await this.applyCorrections(seq.id, read,
              [{ type: 'insertion', position: s.at, ref: '-', read: s.seq, length: len, k: 0 }],
              `${fmt(len)} bp inserted ${place}`);
            return true;
          },
        },
      ],
    });
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
        this.hideRead();
      }
      await this.selectReference(this.reference.id);
    } catch (err) {
      toast(err.message, 'error');
    }
  },

  /**
   * One read in full: what it says about the plasmid in a sentence, its
   * differences, how to judge it, its alignment, and its chromatogram -
   * scrolled to the difference `pick` (its index) when one is given.
   */
  async showRead(read, pick = null) {
    const fresh = this.activeRead?.id !== read.id;
    this.activeRead = read;
    // The last read's trace must not stand in for this one's while it loads:
    // a difference picked meanwhile would be drawn on the wrong chromatogram.
    if (fresh) {
      this.trace = null;
      document.getElementById('traceCard').hidden = true;
    }
    this.renderMap();
    const card = document.getElementById('readCard');
    const wasHidden = card.hidden;
    card.hidden = false;
    document.getElementById('readTitle').textContent =
      `${read.clone_number ? `Clone ${read.clone_number} · ` : ''}${read.name}`;
    const a = read.alignment;
    document.getElementById('readBadges').replaceChildren(...[
      Notebook.button(`${read.name}: what it says about ${this.reference.name}, its differences, `
        + 'and its chromatogram as shown here.', () => this.readSection(read)),
      a?.mapped ? el('span', { class: 'badge' }, a.strand === -1 ? '← reverse read' : 'forward read →') : null,
      read.has_trace ? el('span', { class: 'badge', text: 'chromatogram' }) : el('span', { class: 'badge', text: 'sequence only' }),
      this.statusBadge(read)].filter(Boolean));
    const summary = document.getElementById('readSummary');
    const box = document.getElementById('alignment');
    this.renderReadExtent(a?.mapped ? a : null);
    this.traceFocus = null;
    if (!a) {
      summary.replaceChildren(el('div', { class: 'empty' }, 'No alignment stored for this read.'));
      box.replaceChildren();
      document.getElementById('readUnaligned').replaceChildren();
    } else if (!a.mapped) {
      summary.replaceChildren(el('div', { class: 'alert alert-warning' },
        el('div', { class: 'aln-headline' }, 'This read did not align to the reference'),
        el('div', {}, a.reason ? `${a.reason[0].toUpperCase()}${a.reason.slice(1)}.`
          : `At best ${fmt(a.aligned_length ?? 0)} bp of the ${fmt(a.read_length ?? 0)} bp read matched anywhere on the plasmid: `
            + 'a different plasmid, a mixed colony, or a failed reaction.')));
      box.replaceChildren();
      this.renderUnaligned(read, null);
    } else {
      const view = this.alignmentView(read, (k) => nav.go(k), (col) => this.focusTrace(col));
      const nav = this.differenceNav(read, view);
      summary.replaceChildren(this.headline(read, (k) => nav.go(k)), this.verdictBar(read));
      box.replaceChildren(...(a.differences.length ? [nav.bar] : []), view);
      this.renderUnaligned(read, (k) => nav.go(k));
      if (pick !== null) nav.go(pick);
    }
    if (wasHidden || pick === null) {
      const top = card.getBoundingClientRect().top;
      if (top > window.innerHeight * 0.6 || top < 0) card.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }

    const traceCard = document.getElementById('traceCard');
    if (!read.has_trace) {
      traceCard.hidden = true;
      this.trace = null;
      return;
    }
    if (fresh || !this.trace) {
      try {
        const full = await API.get(`/api/sequences/reads/${read.id}?trace=true`);
        if (this.activeRead?.id !== read.id) return;      // another read was chosen meanwhile
        this.trace = full.read.trace;
      } catch {
        this.trace = null;
      }
    }
    traceCard.hidden = !this.trace;
    if (this.trace) this.drawTrace();
  },

  /**
   * A read that is mostly not the reference: how much of it, and what that
   * can mean - expected when it runs past the ends of a reference that is
   * only part of what was sequenced. Then, for the part that does align, its
   * differences, as for any read.
   */
  elsewhereHeadline(read, span, facts, go) {
    const a = read.alignment;
    const { diffs, unaligned, before, after } = this.details(read);
    const n = this.reference.sequence.length;
    const pastEnds = !this.reference.circular && (a.ref_start - before < 0 || a.ref_end + after > n);
    const pct = Math.round((unaligned / a.read_length) * 100);
    return el('div', { class: 'alert alert-warning' },
      el('div', { class: 'aln-headline' },
        `Most of this read is not in the reference: ${fmt(unaligned)} of its ${fmt(a.read_length)} bp (${pct}%)`),
      el('div', {}, pastEnds
        ? `It runs past the end${a.ref_start - before < 0 && a.ref_end + after > n ? 's' : ''} of this ${fmt(n)} bp reference. `
          + 'If the reference is only part of what was sequenced (an insert or a PCR product, say), that is expected; '
          + 'otherwise it is a bigger insert, another backbone, or another plasmid.'
        : `Only ${span} of the reference is in it. The rest may be a bigger insert than planned, `
          + 'another backbone, or another plasmid.'),
      el('div', {}, 'Its sequence is below, to BLAST, or to insert into the reference if it belongs there.'),
      el('div', { style: 'margin-top:.3rem' }, diffs.length
        ? `Where it does align (${span}): ${fmt(diffs.length)} difference${diffs.length === 1 ? '' : 's'}`
          + `${diffs.some((d) => d.low) ? ', some on low-quality bases' : ''}.`
        : `Where it does align (${span}), it matches exactly.`),
      facts,
      diffs.length ? this.differenceList(diffs, go) : null);
  },

  /**
   * A read as a section for the Lab Notebook: what it says about the plasmid (the headline
   * as shown), its verdict, the part of its chromatogram on screen, and its differences.
   */
  async readSection(read) {
    const a = read.alignment || {};
    const ref = this.reference;
    const headline = document.querySelector('#readSummary .alert');
    const said = headline ? [...headline.querySelectorAll('.aln-headline, .aln-headline ~ div:not(.diff-list)')]
      .map((d) => `<p>${Notebook.esc(d.textContent)}</p>`).join('') : '';
    const verdict = read.verdict ? `Judged ${read.verdict === 'sufficient' ? 'sufficient' : 'not sufficient'}`
      + `${read.verdict_by ? ` by ${read.verdict_by}` : ''}.` : 'Not judged yet.';
    const pictures = [];
    let shown = '';
    const canvas = document.getElementById('traceCanvas');
    const wrap = document.getElementById('traceWrap');
    if (this.trace && canvas && !document.getElementById('traceCard').hidden) {
      // What is on screen of the trace: the stretch around the chosen base, at its zoom.
      const left = wrap.scrollLeft;
      const width = Math.min(wrap.clientWidth, canvas.width - left);
      const crop = document.createElement('canvas');
      crop.width = width;
      crop.height = canvas.height;
      const ctx = crop.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, width, canvas.height);
      ctx.drawImage(canvas, left, 0, width, canvas.height, 0, 0, width, canvas.height);
      pictures.push(await new Promise((resolve) => crop.toBlob(resolve, 'image/png')));
      const where = document.getElementById('traceWhere').textContent.replace(/^\s*·\s*/, '');
      shown = `<p>Chromatogram${where ? `, at ${Notebook.esc(where)}` : ''}:</p>${Notebook.picture(0, `Chromatogram of ${read.name}`)}`;
    }
    const { diffs } = a.mapped ? this.details(read) : { diffs: [] };
    return {
      section: {
        type: 'section', title: `Sequencing: ${read.clone_number ? `clone ${read.clone_number}, ` : ''}${read.name} on ${ref.name}`,
        source: { kind: 'sequencing-read', id: ref.id || '', name: read.name },
        blocks: [
          { type: 'text', html: `<p>Read <b>${Notebook.esc(read.name)}</b>${read.clone_number ? ` (clone ${Notebook.esc(read.clone_number)})` : ''}`
            + ` against <a data-plasmid="${Notebook.esc(ref.id)}">${Notebook.esc(ref.name)}</a>. ${Notebook.esc(verdict)}</p>${said}${shown}` },
          ...(diffs.length ? [Notebook.table('Differences', [['#', 'number'], ['Type'], ['Position', 'number'], ['Reference'], ['Read'],
            ['Feature'], ['Quality', 'number'], ['Checked on the trace', 'check']],
          diffs.map((d, k) => [k + 1, d.type, d.position + 1, d.ref, d.read, d.features[0] || '', d.q ?? '', null]))] : []),
        ],
      },
      pictures,
    };
  },

  /**
   * The read's verdict on the plasmid in a sentence: matches, or how many
   * differences of which kind, and whether any rest on bases too poor to
   * trust; then the numbers behind it, and each difference as a chip.
   */
  headline(read, go) {
    const a = read.alignment;
    const { diffs } = this.details(read);
    const span = `${fmt(a.ref_start + 1)}–${fmt(a.ref_end)}`;
    // Identity counts inserted and deleted bases against the read; where it
    // has any, say how the bases that do pair up compare, and how many there
    // are. An alignment stored before this has only the paired figure.
    const facts = el('div', { class: 'hint aln-facts' },
      a.indel_bases
        ? `${a.identity}% identity (${a.base_identity}% where the bases pair up, `
          + `${fmt(a.indel_bases)} bp inserted or deleted)`
        : `${a.identity}% identity over ${fmt(a.aligned_length)} bp`,
      a.aligned_fraction !== undefined ? ` · ${a.aligned_fraction}% of the ${fmt(a.read_length)} bp read aligned` : '',
      ` · ${a.strand === -1 ? 'reverse' : 'forward'} strand`);
    if (this.mostlyElsewhere(read)) return this.elsewhereHeadline(read, span, facts, go);
    if (!diffs.length) {
      return el('div', { class: 'alert alert-success' },
        el('div', { class: 'aln-headline' }, `Matches the reference exactly from ${span}`), facts);
    }
    const count = (type, word) => {
      const k = diffs.filter((d) => d.type === type).length;
      return k ? `${fmt(k)} ${word}${k === 1 ? '' : 's'}` : null;
    };
    const kinds = [count('mismatch', 'mismatch'), count('insertion', 'insertion'), count('deletion', 'deletion')]
      .filter(Boolean).join(', ');
    const low = diffs.filter((d) => d.low).length;
    const allLow = low === diffs.length;
    return el('div', { class: `alert ${allLow ? 'alert-info' : 'alert-error'}` },
      el('div', { class: 'aln-headline' },
        `${fmt(diffs.length)} difference${diffs.length === 1 ? '' : 's'} from the reference in ${span}: ${kinds}`),
      low ? el('div', {}, allLow
        ? `${diffs.length === 1 ? 'It is' : 'All are'} on low-quality bases, so likely sequencing errors: check the chromatogram before trusting ${diffs.length === 1 ? 'it' : 'them'}.`
        : `${fmt(low)} of them ${low === 1 ? 'is' : 'are'} on low-quality bases (dashed): check those on the chromatogram.`) : null,
      facts,
      this.differenceList(diffs, go));
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
   * Each difference as a button that goes to it in the alignment: what
   * changed, the feature it is in, and how sure the read is there.
   */
  differenceList(diffs, go) {
    const shown = diffs.slice(0, 60);
    return el('div', { class: 'diff-list' },
      ...shown.map((d) => el('button', {
        class: `diff-chip diff-${d.type}${d.low ? ' lowq' : ''}`, type: 'button', 'data-diff': String(d.k),
        title: `${d.type[0].toUpperCase()}${d.type.slice(1)}`
          + `${d.features.length ? ` in ${d.features.join(', ')}` : ', outside any feature'}`
          + `${d.q !== null ? `; read quality ${d.q}${d.low ? ' (low: may be a sequencing error)' : ''}` : ''}`
          + '. Click to go to it.',
        onclick: () => go(d.k),
      },
      el('span', { class: 'mono' }, describeDifference(d)),
      d.features.length ? el('span', { class: 'diff-where' }, ` · ${d.features[0]}`) : null,
      d.q !== null ? el('span', { class: 'diff-q' }, ` · Q${d.q}`) : null)),
      diffs.length > shown.length
        ? el('span', { class: 'hint' }, ` and ${fmt(diffs.length - shown.length)} more: use Next`) : null);
  },

  /** Previous / Next through the differences, which one is shown, and the corrections. */
  differenceNav(read, view) {
    const a = read.alignment;
    const count = a.differences.length;
    const status = el('span', { class: 'hint' }, `${fmt(count)} difference${count > 1 ? 's' : ''}`);
    const nav = {
      at: -1,
      go: (k) => {
        if (!count) return;
        nav.at = ((k % count) + count) % count;
        view.goTo(nav.at);
        const d = this.details(read).diffs[nav.at];
        status.textContent = `Difference ${fmt(nav.at + 1)} of ${fmt(count)}`;
        // The matching chip in the list above, marked as the one shown.
        for (const chip of document.querySelectorAll('#readSummary .diff-chip')) {
          chip.classList.toggle('active', Number(chip.dataset.diff) === nav.at);
        }
        if (d?.cols) this.focusTrace(d.cols[0], d);
      },
    };
    const only = el('input', { type: 'checkbox', onchange: () => view.showOnlyDifferences(only.checked) });
    nav.bar = el('div', { class: 'diff-nav' },
      el('button', { class: 'btn btn-sm btn-secondary', type: 'button', title: 'Previous difference',
                     onclick: () => nav.go(nav.at - 1) }, '◀ Previous'),
      el('button', { class: 'btn btn-sm btn-secondary', type: 'button', title: 'Next difference',
                     onclick: () => nav.go(nav.at + 1) }, 'Next ▶'),
      status,
      el('label', { class: 'choice diff-only', title: 'Hide the lines where the read matches the reference' },
        only, 'Only lines with differences'),
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

  /**
   * Save the corrected plasmid, align its reads again, and show the same
   * read. `label` says what was done, for its history and the message, when
   * it is not simply some differences corrected.
   */
  async applyCorrections(sequenceId, read, chosen, label = null) {
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
                    note: (label ? `${label} from read ${read.name}`
                      : `${chosen.length} difference${chosen.length > 1 ? 's' : ''} to read ${read.name}`)
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
    toast(`${label ? `${label[0].toUpperCase()}${label.slice(1)}` : `Corrected ${what}`}; `
          + 'features moved with the change and the reads were aligned again'
          + (synced ? ', and MoClo updated' : ''), 'success', 6000);
    if (mocloNote) toast(`MoClo was not updated: ${mocloNote} Open the plasmid in the editor and save it to resolve this.`, 'error', 12000);
  },

  /** One row of bases, with the bases that differ marked (and the ones shown outlined). */
  alignedRow(text, offset, diffAt, focusColumns, kind) {
    const row = el('div', { class: `seqmap-row ${kind}`, 'data-offset': String(offset) });
    let plain = '';
    for (let j = 0; j < text.length; j++) {
      const diff = diffAt.get(offset + j);
      if (!diff) { plain += text[j]; continue; }
      if (plain) { row.append(plain); plain = ''; }
      row.append(el('span', {
        class: `aln-diff aln-${diff.type}${diff.low ? ' lowq' : ''}${focusColumns?.has(offset + j) ? ' aln-focus' : ''}`,
        'data-diff': String(diff.k),
        title: `${describeDifference(diff)}${diff.q !== null ? ` · quality ${diff.q}` : ''}`,
      }, text[j]));
    }
    if (plain) row.append(plain);
    return row;
  },

  /**
   * A thin bar under the reference, one colour per column: green where the
   * read agrees, paler and hatched where it agrees on a low-quality call, and
   * the difference's own colour where it does not. Runs of one colour are one
   * piece, placed in ch so they sit under their bases.
   */
  agreementStrip(from, to, kindAt) {
    const row = el('div', { class: 'seqmap-row aln-strip-row' });
    let start = from;
    let kind = kindAt(from);
    for (let c = from + 1; c <= to; c++) {
      const next = c < to ? kindAt(c) : null;
      if (next === kind) continue;
      row.append(el('div', { class: `aln-strip s-${kind}`, style: `left:${start - from}ch;width:${c - start}ch` }));
      start = c;
      kind = next;
    }
    return row;
  },

  /**
   * Reference over read, in lines, each labelled with where it starts in
   * both; between them a strip that is green where they agree and coloured
   * where they don't, and the reference's features above. Every difference
   * is coloured, `goTo(k)` brings the k-th into view, and the lines without
   * one can be folded away. Clicking a base calls `onBase` with its column.
   * Lines are as long as the box allows, and re-flow when it is resized.
   */
  alignmentView(read, onPick, onBase) {
    const a = read.alignment;
    const { diffs, cols, quality } = this.details(read);
    const lanes = this.alignedFeatures(a);
    const wrap = el('div', { class: 'seqmap aln-view', style: 'max-height:30rem;overflow:auto' });
    let width = 60;          // until the box is on the page and can be measured
    let onlyDifferences = false;
    const diffAt = new Map();         // column -> the difference covering it
    for (const d of diffs) {
      for (const c of d.cols || []) if (!diffAt.has(c)) diffAt.set(c, d);
    }
    const kindAt = (c) => {
      const d = diffAt.get(c);
      if (d) return d.type;
      const i = cols.read?.[c];
      return quality && i >= 0 && quality[i] < LOW_QUALITY ? 'low' : 'ok';
    };
    const hasDifference = (from, to) => {
      for (let c = from; c < to; c++) if (diffAt.has(c)) return true;
      return false;
    };
    // The first position in [from, to) of the reference, and of the read.
    const firstOf = (positions, from, to) => {
      if (!positions) return '';
      for (let c = from; c < to; c++) if (positions[c] >= 0) return fmt(positions[c] + 1);
      return '';
    };
    let focus = null;                 // the columns of the difference shown
    const draw = () => {
      const blocks = [];
      let skipped = 0;
      const fold = () => {
        if (skipped) {
          blocks.push(el('div', { class: 'aln-skip' },
            `⋯ ${fmt(skipped)} bp where the read matches the reference ⋯`));
        }
        skipped = 0;
      };
      for (let i = 0; i < a.top.length; i += width) {
        const end = Math.min(i + width, a.top.length);
        if (onlyDifferences && !hasDifference(i, end)) {
          skipped += end - i;
          continue;
        }
        fold();
        const features = this.featureLanes(lanes, i, end);
        blocks.push(el('div', { class: 'seqmap-block aln-block' },
          el('div', { class: 'seqmap-num aln-labels' },
            ...features.map(() => el('div', { class: 'seqmap-row feature-lane' })),
            el('div', { class: 'seqmap-row', title: this.reference.name },
              el('span', { class: 'aln-who' }, 'Ref'), firstOf(cols.ref, i, end)),
            el('div', { class: 'seqmap-row aln-strip-row' }),
            el('div', { class: 'seqmap-row', title: read.name },
              el('span', { class: 'aln-who' }, 'Read'), firstOf(cols.read, i, end))),
          el('div', { class: 'seqmap-rows' },
            ...features,
            this.alignedRow(a.top.slice(i, end), i, diffAt, focus, 'aln-ref'),
            this.agreementStrip(i, end, kindAt),
            this.alignedRow(a.bottom.slice(i, end), i, diffAt, focus, 'aln-read'))));
      }
      fold();
      wrap.replaceChildren(...blocks);
    };
    draw();
    // Clicking a coloured base picks that difference; any other base shows
    // its place on the chromatogram.
    let charWidth = 0;
    wrap.addEventListener('click', (e) => {
      const base = e.target.closest('.aln-diff');
      if (base) { onPick?.(Number(base.dataset.diff)); return; }
      const row = e.target.closest('.aln-ref, .aln-read');
      if (!row || !onBase) return;
      if (!charWidth) {
        const probe = el('span', { style: 'position:absolute;visibility:hidden' }, 'M'.repeat(20));
        row.append(probe);
        charWidth = probe.getBoundingClientRect().width / 20;
        probe.remove();
      }
      const col = Number(row.dataset.offset) + Math.floor((e.clientX - row.getBoundingClientRect().left) / charWidth);
      if (col >= 0 && col < a.top.length) onBase(col);
    });
    /** Outline the k-th difference and scroll it into the middle of the box. */
    wrap.goTo = (k) => {
      focus = diffs[k]?.cols ? new Set(diffs[k].cols) : null;
      if (!focus) return;
      draw();
      const target = wrap.querySelector('.aln-focus');
      if (!target) return;
      wrap.scrollTop += target.getBoundingClientRect().top - wrap.getBoundingClientRect().top
        - wrap.clientHeight / 3;
      wrap.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    };
    wrap.showOnlyDifferences = (on) => {
      onlyDifferences = on;
      draw();
      wrap.querySelector('.aln-focus')?.scrollIntoView({ block: 'center' });
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
        const lines = () => [...wrap.querySelectorAll('.aln-block')];
        const shown = lines().find((b) => b.getBoundingClientRect().bottom > top);
        const column = shown ? Number(shown.querySelector('.aln-ref').dataset.offset) : 0;
        width = fits;
        charWidth = 0;
        draw();
        const line = lines().find((b) => Number(b.querySelector('.aln-ref').dataset.offset) + width > column);
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

  /**
   * Show alignment column `col` on the chromatogram: the read's own base
   * there, or for bases the read lacks (a deletion) the one just before.
   * `d` is the difference it belongs to, if any.
   */
  focusTrace(col, d = null) {
    const { cols } = this.details(this.activeRead);
    if (!cols?.read) return;
    let c = col;
    while (c > 0 && cols.read[c] < 0) c -= 1;
    while (c < cols.read.length - 1 && cols.read[c] < 0) c += 1;
    if (!(cols.read[c] >= 0)) return;
    this.traceFocus = { index: cols.read[c], col, d, ref: cols.ref[col] };
    if (this.trace) this.drawTrace();
  },

  drawTrace() {
    const trace = this.trace;
    const canvas = document.getElementById('traceCanvas');
    if (!trace || !canvas) return;
    const read = this.activeRead;
    const a = read?.alignment;
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
    const marksH = 10;                  // along the top: where the differences are
    const traceBottom = h - 42;
    const x = (i) => (i / points) * canvas.width;
    const y = (v) => traceBottom - (v / maxY) * (traceBottom - marksH - 2);
    const at = (i) => x(peaks[i] ?? 0);
    // Half the room one base has, so a band covers its peak.
    const half = (i) => Math.max(2, (at(Math.min(i + 1, peaks.length - 1)) - at(Math.max(i - 1, 0))) / 4);

    // The ends trimmed for low quality, shaded: they took no part in the alignment.
    const [t0, t1] = a?.trim || [0, peaks.length];
    ctx.fillStyle = 'rgba(107,114,128,.13)';
    if (t0 > 0 && peaks.length) ctx.fillRect(0, 0, at(t0) - half(t0), h);
    if (t1 < peaks.length) ctx.fillRect(at(t1 - 1) + half(t1 - 1), 0, canvas.width, h);

    // Every difference from the reference: a band over its bases, and a mark
    // along the top - hollow when the read's call there is low quality.
    const { diffs, cols } = read && a?.mapped ? this.details(read) : { diffs: [], cols: null };
    const colours = { mismatch: '#dc2626', insertion: '#7c3aed', deletion: '#ea580c' };
    const spanOf = (d) => {
      const own = (d.cols || []).map((c) => cols.read[c]).filter((i) => i >= 0);
      if (own.length) return [Math.min(...own), Math.max(...own)];
      // A deletion: the junction between the bases either side of it.
      const before = cols.read[d.cols[0] - 1];
      const after = cols.read[d.cols[d.cols.length - 1] + 1];
      return before >= 0 && after >= 0 ? [Math.min(before, after), Math.max(before, after)] : null;
    };
    if (cols?.read) {
      for (const d of diffs) {
        const span = d.cols && spanOf(d);
        if (!span) continue;
        const [i, j] = span;
        const left = d.type === 'deletion' ? (at(i) + at(j)) / 2 - 1.5 : at(i) - half(i);
        const width = d.type === 'deletion' ? 3 : at(j) + half(j) - left;
        ctx.fillStyle = `${colours[d.type]}22`;
        ctx.fillRect(left, marksH, width, traceBottom - marksH);
        ctx.fillStyle = colours[d.type];
        ctx.strokeStyle = colours[d.type];
        ctx.lineWidth = 2;
        if (d.low) ctx.strokeRect(left + 1, 1, Math.max(width - 2, 2), marksH - 2);
        else ctx.fillRect(left, 0, Math.max(width, 3), marksH);
      }
    }

    // Quality bars
    ctx.fillStyle = '#e5e7eb';
    peaks.forEach((p, i) => {
      const q = quality[i] ?? 0;
      const bh = Math.min(1, q / 60) * 18;
      ctx.fillRect(x(p) - 1.5, traceBottom + 2, 3, bh);
    });

    const colors = { A: '#16a34a', C: '#2563eb', G: '#ca8a04', T: '#dc2626' };
    for (const [base, data] of Object.entries(channels)) {
      ctx.beginPath();
      ctx.strokeStyle = colors[base] || '#6b7280';
      ctx.lineWidth = 1;
      data.forEach((v, i) => {
        const px = x(i);
        const py = y(v);
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

    // The base chosen in the alignment, outlined, and scrolled into the middle.
    const wrap = document.getElementById('traceWrap');
    const focus = this.traceFocus;
    const where = document.getElementById('traceWhere');
    if (focus && peaks[focus.index] !== undefined) {
      const i = focus.index;
      ctx.strokeStyle = '#111827';
      ctx.lineWidth = 2;
      ctx.strokeRect(at(i) - half(i) - 1, 1, 2 * half(i) + 2, h - 2);
      wrap.scrollLeft = at(i) - wrap.clientWidth / 2;
      const q = quality[i];
      where.textContent = ` · read base ${fmt(i + 1)} (${bases[i] || '?'}${q !== undefined ? `, quality ${q}` : ''})`
        + (focus.ref >= 0 ? ` · reference ${fmt(focus.ref + 1)}` : '')
        + (a?.strand === -1 ? ' · a reverse read: the trace shows the other strand, so its bases are the complement' : '');
    } else {
      where.textContent = a?.strand === -1 ? ' · a reverse read: the trace shows the other strand' : '';
      if (this.traceShownFor !== read?.id) wrap.scrollLeft = Math.max(0, at(t0) - 40);
    }
    this.traceShownFor = read?.id;
  },
};

document.addEventListener('DOMContentLoaded', () => Sequencing.init());
