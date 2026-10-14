/*
 * SeqView - the scrolling sequence text map.
 *
 * Renders the sequence in wrapped blocks with, optionally, the complement
 * strand, a reading-frame translation, feature bars, restriction cuts (drawn
 * as a step across both strands, so the overhang shows) and search
 * highlights. Supports click and drag selection in sequence coordinates,
 * which the editor uses for every operation.
 *
 * Features and enzyme names answer one click (onFeatureClick, onSiteClick)
 * and a double click (onFeatureDblClick, onSiteDblClick).
 */

class SeqView {
  constructor(container, opts = {}) {
    this.container = container;
    this.doc = { name: '', sequence: '', circular: false, features: [] };
    this.opts = {
      width: 60,               // bases per line; set to what fits while autoWidth is on
      autoWidth: true,         // follow the pane's width, in tens of bases
      showComplement: true,
      showTranslation: false,
      translationFrame: 1,     // 1,2,3 forward; -1,-2,-3 reverse
      showFeatures: true,
      showEnzymes: true,
      uppercase: true,
      editable: true,
      ...opts,
    };
    this.selection = null;       // {start, end} half-open, start may exceed end only via wrap
    this.caret = null;           // insertion point; equals selection.start when collapsed
    this.sites = [];
    this.highlights = [];        // [{start, end, class}]
    // Codons of one translation chosen on its row ({id, from, to}, inclusive),
    // so a copy can give their amino acids; any other selection clears it.
    this.aaSelection = null;
    this._codonDrag = null;
    this.onSelect = null;
    this.onFeatureClick = null;
    this.onFeatureDblClick = null;
    this.onSiteClick = null;
    this.onSiteDblClick = null;
    this.onCaret = null;
    this.onEdit = null;          // ({start, end, text}) => void, applied by the owner
    this._drag = null;
    this._anchor = null;         // fixed end of a shift-extended selection
    container.classList.add('seqmap');
    container.setAttribute('tabindex', '0');
    container.setAttribute('role', 'textbox');
    container.setAttribute('aria-multiline', 'true');
    container.setAttribute('aria-label', 'DNA sequence, editable');
    container.addEventListener('mousedown', (e) => this._mousedown(e));
    window.addEventListener('mouseup', () => { this._drag = null; this._codonDrag = null; });
    container.addEventListener('mousemove', (e) => this._mousemove(e));
    container.addEventListener('keydown', (e) => this._keydown(e));
    // Lines as long as the pane allows, re-flowed when the window is resized.
    if (this.opts.autoWidth && 'ResizeObserver' in window) {
      new ResizeObserver(() => this._refit()).observe(container);
    }
  }

  setDocument(doc, { keepSelection = false } = {}) {
    this.doc = doc;
    if (!keepSelection) {
      this.selection = null;
      this.caret = null;
      this._anchor = null;
    } else if (this.caret !== null) {
      this.caret = Math.min(this.caret, doc.sequence.length);
    }
    this.render();
  }

  setOption(key, value) {
    this.opts[key] = value;
    this.render();
  }

  setSites(sites) {
    this.sites = sites || [];
    this.render();
  }

  setHighlights(highlights) {
    this.highlights = highlights || [];
    this.render();
  }

  setSelection(sel, notify = true) {
    this.aaSelection = null;
    this.selection = sel;
    this.caret = sel ? sel.end : null;
    this._anchor = sel ? sel.start : null;
    this.render();
    if (notify) this.onSelect?.(sel);
  }

  /** Put the insertion point at `pos`, optionally extending from the anchor. */
  setCaret(pos, extend = false) {
    this.aaSelection = null;
    const n = this.doc.sequence.length;
    pos = Math.max(0, Math.min(n, pos));
    if (extend && this._anchor !== null) {
      this.selection = { start: Math.min(this._anchor, pos), end: Math.max(this._anchor, pos) };
    } else {
      this._anchor = pos;
      this.selection = { start: pos, end: pos };
    }
    this.caret = pos;
    this.render();
    this.onSelect?.(this.selection);
    this.scrollCaretIntoView();
  }

  /**
   * Select codons `from` to `to` (in either order, inclusive) of a translation:
   * their bases, as any selection, and the amino acids themselves, for copying.
   */
  selectCodons(t, from, to) {
    const codons = translationCodons(this.doc.sequence, t);
    if (!codons.length) return;
    const n = this.doc.sequence.length;
    const lo = Math.max(0, Math.min(from, to));
    const hi = Math.min(codons.length - 1, Math.max(from, to));
    // The bases from the first to the last, in the forward direction; a reverse
    // translation reads its codons from right to left.
    const [first, last] = t.strand === -1
      ? [codons[hi].positions[2], codons[lo].positions[0]]
      : [codons[lo].positions[0], codons[hi].positions[2]];
    this.selection = { start: first, end: (last + 1) % n || n };
    this.caret = this.selection.end;
    this._anchor = this.selection.start;
    this.aaSelection = { id: t.id, from: lo, to: hi };
    this.render();
    this.onSelect?.(this.selection);
  }

  /** The amino acids chosen on a translation's row, or null when the selection is plain bases. */
  selectedProtein() {
    const chosen = this.aaSelection;
    const t = chosen && (this.doc.translations || []).find((x) => x.id === chosen.id);
    if (!t) return null;
    return translationCodons(this.doc.sequence, t).slice(chosen.from, chosen.to + 1).map((c) => c.aa).join('');
  }

  isCollapsed() {
    const s = this.selection;
    return !s || s.start === s.end;
  }

  scrollCaretIntoView() {
    if (this.caret === null) return;
    const block = this.container.querySelectorAll('.seqmap-block')[Math.floor(this.caret / this.opts.width)];
    block?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  /** The selected sequence, following the wrap on a circular molecule. */
  selectedSequence() {
    const sel = this.selection;
    if (!sel || sel.start === sel.end) return '';   // a bare caret selects nothing
    const s = this.doc.sequence;
    return sel.end > sel.start ? s.slice(sel.start, sel.end) : s.slice(sel.start) + s.slice(0, sel.end);
  }

  selectionLength() {
    const sel = this.selection;
    if (!sel || sel.start === sel.end) return 0;
    return sel.end > sel.start ? sel.end - sel.start : this.doc.sequence.length - sel.start + sel.end;
  }

  /* --- geometry ---------------------------------------------------------- */

  _charWidth() {
    if (this._cw) return this._cw;
    const probe = el('span', { class: 'mono', style: 'position:absolute;visibility:hidden;font-size:.8125rem' },
      'M'.repeat(50));
    this.container.appendChild(probe);
    this._cw = probe.getBoundingClientRect().width / 50;
    probe.remove();
    return this._cw;
  }

  /** Bases per line that fit the pane, with one to spare for the caret after the last. */
  _widthThatFits() {
    return basesPerLine(this.container, 1);
  }

  /** Re-flow to the pane's new width, keeping the same bases at the top of the view. */
  _refit() {
    if (this._refitFrame) return;
    this._refitFrame = requestAnimationFrame(() => {
      this._refitFrame = null;
      const width = this._widthThatFits();
      if (!width || width === this.opts.width || !this.doc.sequence.length) return;
      const top = this._topVisibleBlock();
      this.render();
      if (top) this._restoreTop(top);
    });
  }

  _scrollParent() {
    for (let node = this.container; node; node = node.parentElement) {
      const overflow = getComputedStyle(node).overflowY;
      if ((overflow === 'auto' || overflow === 'scroll') && node.scrollHeight > node.clientHeight) return node;
    }
    return document.scrollingElement;
  }

  /** The first line in view: the base it starts at, and where it is on screen. */
  _topVisibleBlock() {
    const scroller = this._scrollParent();
    const viewTop = Math.max(this.container.getBoundingClientRect().top,
      scroller === document.scrollingElement ? 0 : scroller.getBoundingClientRect().top);
    const blocks = this.container.querySelectorAll('.seqmap-block');
    for (let i = 0; i < blocks.length; i++) {
      const rect = blocks[i].getBoundingClientRect();
      if (rect.bottom > viewTop) return { base: i * this.opts.width, top: rect.top, scroller };
    }
    return null;
  }

  _restoreTop({ base, top, scroller }) {
    const block = this.container.querySelectorAll('.seqmap-block')[Math.floor(base / this.opts.width)];
    if (!block) return;
    const shift = block.getBoundingClientRect().top - top;
    if (Math.abs(shift) >= 1) scroller.scrollTop += shift;
  }

  _posFromEvent(e) {
    const row = e.target.closest('.seqmap-row.bases');
    if (!row) return null;
    const blockStart = Number(row.dataset.start);
    const rect = row.getBoundingClientRect();
    const col = Math.round((e.clientX - rect.left) / this._charWidth());
    const len = Number(row.dataset.len);
    return blockStart + Math.max(0, Math.min(len, col));
  }

  _mousedown(e) {
    const bar = e.target.closest('.feat-bar');
    if (bar) {
      const f = this.doc.features.find((x) => x.id === bar.dataset.id);
      if (f) {
        e.preventDefault();
        // The view re-renders between the two clicks, so a double click is
        // read from the click count rather than a dblclick event.
        if (e.detail >= 2) this.onFeatureDblClick?.(f);
        else this.onFeatureClick?.(f);
        return;
      }
    }
    const codon = e.target.closest('.aa-codon');
    if (codon) {
      const t = (this.doc.translations || []).find((x) => x.id === codon.dataset.translation);
      if (t) {
        e.preventDefault();
        this.container.focus({ preventScroll: true });
        // One click selects the codon, dragging across the row more of them,
        // and a double click the whole translation.
        const index = Number(codon.dataset.codon);
        if (e.detail >= 2) {
          this.selectCodons(t, 0, Infinity);
        } else {
          this.selectCodons(t, index, index);
          this._codonDrag = { t, from: index };
        }
        return;
      }
    }
    const label = e.target.closest('.site-label');
    if (label) {
      const site = this.sites[Number(label.dataset.site)];
      if (site) {
        e.preventDefault();
        if (e.detail >= 2) this.onSiteDblClick?.(site);
        else this.onSiteClick?.(site);
        return;
      }
    }
    const pos = this._posFromEvent(e);
    if (pos === null) return;
    this.container.focus({ preventScroll: true });
    this._drag = pos;
    if (e.shiftKey && this._anchor !== null) {
      this.setCaret(pos, true);
    } else {
      this.setCaret(pos, false);
      this.onCaret?.(pos);
    }
  }

  /**
   * Edit and navigation keys. Typing a base, Backspace and Delete all go
   * through onEdit so the owner can apply them (and record undo) in one place.
   */
  _keydown(e) {
    if (!this.opts.editable || !this.doc) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;   // shortcuts belong to the page

    const n = this.doc.sequence.length;
    const w = this.opts.width;
    const sel = this.selection;
    const caret = this.caret ?? (sel ? sel.start : 0);

    const nav = (pos) => { e.preventDefault(); this.setCaret(pos, e.shiftKey); };
    switch (e.key) {
      case 'ArrowLeft':  return nav(caret - 1);
      case 'ArrowRight': return nav(caret + 1);
      case 'ArrowUp':    return nav(caret - w);
      case 'ArrowDown':  return nav(caret + w);
      case 'Home':       return nav(caret - (caret % w));
      case 'End':        return nav(Math.min(n, caret - (caret % w) + w));
      case 'PageUp':     return nav(caret - w * 10);
      case 'PageDown':   return nav(caret + w * 10);
      case 'Escape':     e.preventDefault(); this.setCaret(caret, false); return;
      default: break;
    }

    // A selection that wraps the origin has no single linear range to replace,
    // so collapse to its start and carry on from there.
    const range = (sel && sel.end < sel.start) ? { start: sel.start, end: sel.start } : sel;
    const hasSelection = range && range.end > range.start;

    if (e.key === 'Backspace') {
      e.preventDefault();
      if (hasSelection) this._edit(range.start, range.end, '');
      else if (caret > 0) this._edit(caret - 1, caret, '');
      return;
    }
    if (e.key === 'Delete') {
      e.preventDefault();
      if (hasSelection) this._edit(range.start, range.end, '');
      else if (caret < n) this._edit(caret, caret + 1, '');
      return;
    }

    // A single IUPAC base (or a run pasted by the OS as keystrokes).
    if (e.key.length === 1 && /^[acgturykmswbdhvn]$/i.test(e.key)) {
      e.preventDefault();
      const base = this.opts.uppercase ? e.key.toUpperCase() : e.key;
      if (hasSelection) this._edit(range.start, range.end, base);
      else this._edit(caret, caret, base);
    }
  }

  _edit(start, end, text) {
    this.onEdit?.({ start, end, text });
  }

  _mousemove(e) {
    if (this._codonDrag) {
      const codon = e.target.closest('.aa-codon');
      if (codon && codon.dataset.translation === this._codonDrag.t.id) {
        const to = Number(codon.dataset.codon);
        const chosen = this.aaSelection;
        if (!chosen || chosen.to !== Math.max(to, this._codonDrag.from) || chosen.from !== Math.min(to, this._codonDrag.from)) {
          this.selectCodons(this._codonDrag.t, this._codonDrag.from, to);
        }
      }
      return;
    }
    if (this._drag === null || this._drag === undefined) return;
    const pos = this._posFromEvent(e);
    if (pos === null) return;
    const sel = { start: Math.min(this._drag, pos), end: Math.max(this._drag, pos) };
    if (sel.start === sel.end) return;
    this.aaSelection = null;
    this.selection = sel;
    this._anchor = this._drag;
    this.caret = pos;
    this.render();
    this.onSelect?.(sel);
  }

  /* --- rendering -------------------------------------------------------- */

  /** Feature lanes: features that overlap in display order are stacked. */
  _laneAssign(features, n) {
    const sorted = [...features].sort((a, b) => a.start - b.start || b.end - a.end);
    const lanes = [];
    const result = new Map();
    for (const f of sorted) {
      const spans = this._spans(f, n);
      let lane = 0;
      for (;; lane++) {
        const used = lanes[lane] || [];
        if (!used.some(([s, e]) => spans.some(([fs, fe]) => fs < e && s < fe))) break;
      }
      lanes[lane] = (lanes[lane] || []).concat(spans);
      result.set(f.id, lane);
    }
    return { laneOf: result, laneCount: lanes.length };
  }

  /** Linear spans of a feature, splitting one that wraps the origin. */
  _spans(f, n) {
    if (f.segments && f.segments.length) return f.segments.map(([s, e]) => [s, e]);
    if (f.end > f.start) return [[f.start, f.end]];
    return [[f.start, n], [0, f.end]];
  }

  render() {
    const { sequence, circular } = this.doc;
    const n = sequence.length;
    if (this.opts.autoWidth) this.opts.width = this._widthThatFits() || this.opts.width;
    const width = this.opts.width;
    const frag = document.createDocumentFragment();
    if (!n) {
      this.container.replaceChildren(el('div', { class: 'empty' }, 'No sequence open.'));
      return;
    }

    const text = this.opts.uppercase ? sequence.toUpperCase() : sequence;
    const comp = this.opts.showComplement ? DNA.complement(text) : null;

    // Pre-compute per-feature lanes once for the whole document.
    const features = this.opts.showFeatures ? this.doc.features : [];
    const { laneOf, laneCount } = this._laneAssign(features, n);

    const sel = this.selection;
    const selLen = this.selectionLength();
    const translated = this._translationsByBlock(n, width);

    for (let start = 0; start < n; start += width) {
      const end = Math.min(start + width, n);
      const len = end - start;
      const block = el('div', { class: 'seqmap-block' });
      const rows = el('div', { class: 'seqmap-rows' });

      if (this.opts.showEnzymes) {
        const row = this._enzymeRow(start, end, n);
        if (row) rows.appendChild(row);
      }

      // Bases with selection and highlight spans
      const basesRow = el('div', { class: 'seqmap-row bases' });
      basesRow.dataset.start = String(start);
      basesRow.dataset.len = String(len);
      basesRow.append(...this._styledBases(text, start, end, sel, selLen));
      // The caret belongs to the block it starts in; at the very end of the
      // sequence it sits just past the last base of the final block.
      if (this.opts.editable && this.caret !== null
          && this.caret >= start && (this.caret < end || (this.caret === n && end === n))) {
        basesRow.appendChild(el('span', {
          class: 'seq-caret',
          style: `left:${(this.caret - start) * this._charWidth()}px`,
        }));
      }
      rows.appendChild(basesRow);

      const compRow = comp
        ? el('div', { class: 'seqmap-row complement', text: comp.slice(start, end) })
        : null;
      if (compRow) rows.appendChild(compRow);
      if (this.opts.showEnzymes) this._drawCuts(basesRow, compRow, start, end, n, circular);

      // The user's translations, each amino acid under the codon that encodes it.
      for (const lane of translated.lanes) {
        const row = this._translationLane(lane, translated.byBlock.get(start / width) || [], start, end);
        if (row) rows.appendChild(row);
      }

      if (this.opts.showTranslation) {
        rows.appendChild(this._translationRow(text, start, end, n));
      }

      // Feature lanes
      if (features.length) {
        const lanes = Array.from({ length: laneCount }, () => el('div', { class: 'seqmap-row feature-lane' }));
        const cw = this._charWidth();
        for (const f of features) {
          for (const [fs, fe] of this._spans(f, n)) {
            const s = Math.max(fs, start);
            const e2 = Math.min(fe, end);
            if (e2 <= s) continue;
            const lane = lanes[laneOf.get(f.id) || 0];
            const arrow = f.strand === -1 ? '◀ ' : '';
            const tail = f.strand === -1 ? '' : ' ▶';
            lane.appendChild(el('div', {
              class: 'feat-bar',
              style: `left:${(s - start) * cw}px;width:${(e2 - s) * cw}px;background:${featureColor(f)}`,
              title: `${f.name} (${f.type}) ${fs + 1}..${fe}${f.strand === -1 ? ' complement' : ''}`,
              'data-id': f.id,
            }, (e2 - s) > 4 ? `${arrow}${f.name}${tail}` : ''));
          }
        }
        for (const lane of lanes) if (lane.childElementCount) rows.appendChild(lane);
      }

      block.appendChild(el('div', { class: 'seqmap-num', text: String(start + 1) }));
      block.appendChild(rows);
      frag.appendChild(block);
    }

    if (circular) {
      frag.appendChild(el('div', { class: 'seqmap-num', style: 'padding:.25rem 0 0 .5rem;text-align:left' },
        '↻ circular'));
    }
    this.container.replaceChildren(frag);
  }

  /** Whether cut position c (the gap before base c) is drawn in this block. */
  _cutInBlock(c, start, end, n) {
    return c >= start && (c < end || (c === n && end === n));
  }

  /**
   * Enzyme names over the block, each at its cut. Names that would collide
   * step down onto another line rather than overwriting each other.
   */
  _enzymeRow(start, end, n) {
    const labels = [];
    this.sites.forEach((s, i) => {
      const at = s.cut_top ?? s.start;
      if (this._cutInBlock(at, start, end, n)) labels.push({ i, col: at - start, text: s.enzyme });
    });
    if (!labels.length) return null;
    labels.sort((a, b) => a.col - b.col);
    const cw = this._charWidth();
    const lineEnds = [];
    const row = el('div', { class: 'seqmap-row enzyme' });
    for (const l of labels) {
      let line = lineEnds.findIndex((used) => used <= l.col);
      if (line === -1) { line = lineEnds.length; lineEnds.push(0); }
      // Names are set smaller than the bases; measure them in base columns.
      lineEnds[line] = l.col + Math.ceil(l.text.length * 0.87) + 1;
      const s = this.sites[l.i];
      row.appendChild(el('span', {
        class: 'site-label',
        style: `left:${l.col * cw}px;top:${line * 1.1}em`,
        title: `${s.enzyme} site ${s.start + 1}..${s.end || n}. Click to highlight it, double-click for details.`,
        'data-site': String(l.i),
      }, l.text));
    }
    row.style.height = `${lineEnds.length * 1.1}em`;
    return row;
  }

  /** The stretch between the two strands' cuts, split where it wraps the origin. */
  _overhangSpans(ct, cb, n, circular) {
    if (ct === cb) return [];
    const lo = Math.min(ct, cb);
    const hi = Math.max(ct, cb);
    if (circular && hi - lo > n / 2) return [[hi, n], [0, lo]];
    return [[lo, hi]];
  }

  /**
   * Each cut as a step: down through the top strand at cut_top, along the
   * overhang between the strands, and down through the bottom strand at
   * cut_bottom. A blunt cut is a straight line through both.
   */
  _drawCuts(basesRow, compRow, start, end, n, circular) {
    const cw = this._charWidth();
    const lower = compRow || basesRow;
    const lowerClass = compRow ? '' : ' no-comp';
    for (const s of this.sites) {
      const ct = s.cut_top;
      const cb = s.cut_bottom;
      if (ct === null || ct === undefined) continue;
      if (this._cutInBlock(ct, start, end, n)) {
        basesRow.appendChild(el('span', { class: 'cut-top', style: `left:${(ct - start) * cw}px` }));
      }
      if (cb === null || cb === undefined) continue;
      if (this._cutInBlock(cb, start, end, n)) {
        lower.appendChild(el('span', { class: `cut-bottom${lowerClass}`, style: `left:${(cb - start) * cw}px` }));
      }
      for (const [lo, hi] of this._overhangSpans(ct, cb, n, circular)) {
        const a = Math.max(lo, start);
        const b = Math.min(hi, end);
        if (b <= a) continue;
        lower.appendChild(el('span', {
          class: `cut-overhang${lowerClass}`,
          style: `left:${(a - start) * cw}px;width:${(b - a) * cw}px`,
        }));
      }
    }
  }

  _inSelection(i, sel, selLen) {
    if (!sel || selLen === 0) return false;
    if (sel.end > sel.start) return i >= sel.start && i < sel.end;
    return i >= sel.start || i < sel.end;   // wraps the origin
  }

  _styledBases(text, start, end, sel, selLen) {
    const out = [];
    const hlAt = (i) => this.highlights.find((h) => (h.end > h.start
      ? i >= h.start && i < h.end
      : i >= h.start || i < h.end));
    let buf = '';
    let cls = null;
    const flush = () => {
      if (!buf) return;
      out.push(cls ? el('span', { class: cls, text: buf }) : document.createTextNode(buf));
      buf = '';
    };
    for (let i = start; i < end; i++) {
      const h = hlAt(i);
      const classes = [];
      if (this._inSelection(i, sel, selLen)) classes.push('sel');
      if (h) classes.push(h.class || 'hit');
      const c = classes.join(' ') || null;
      if (c !== cls) { flush(); cls = c; }
      buf += text[i];
    }
    flush();
    return out;
  }

  /**
   * The document's translations, worked out once per render: their lanes
   * (overlapping translations get a row each) and, for each line of the view,
   * the codons with a base on it.
   */
  _translationsByBlock(n, width) {
    const translations = this.doc.translations || [];
    const byBlock = new Map();
    if (!translations.length) return { lanes: [], byBlock };
    const { laneOf, laneCount } = this._laneAssign(translations, n);
    const lanes = Array.from({ length: laneCount }, (_, i) => i);
    for (const t of translations) {
      translationCodons(this.doc.sequence, t).forEach((c, index) => {
        const item = { t, lane: laneOf.get(t.id) || 0, index, ...c };
        for (const block of new Set(c.positions.map((p) => Math.floor(p / width)))) {
          if (!byBlock.has(block)) byBlock.set(block, []);
          byBlock.get(block).push(item);
        }
      });
    }
    return { lanes, byBlock };
  }

  /**
   * One lane of translations on the line [start, end): a band under each codon,
   * alternating in shade so the triplets read apart, and the amino acid under
   * the codon's middle base. Stop codons are marked.
   */
  _translationLane(lane, codons, start, end) {
    const cw = this._charWidth();
    const row = el('div', { class: 'seqmap-row aa-lane' });
    const chosen = this.aaSelection;
    for (const c of codons) {
      if (c.lane !== lane) continue;
      const picked = chosen && chosen.id === c.t.id && c.index >= chosen.from && c.index <= chosen.to;
      const kind = `${c.index % 2 ? ' alt' : ''}${c.aa === '*' ? ' stop' : ''}${picked ? ' chosen' : ''}`;
      const title = `${c.t.name}: ${c.aa === '*' ? 'stop' : c.aa}${c.index + 1} (${c.codon})`;
      // A band per run of this codon's bases on the line (two only when the
      // codon crosses the origin).
      const here = c.positions.filter((p) => p >= start && p < end).sort((a, b) => a - b);
      for (let i = 0; i < here.length;) {
        let j = i;
        while (j + 1 < here.length && here[j + 1] === here[j] + 1) j++;
        row.appendChild(el('span', {
          class: `aa-codon${kind}`, title,
          style: `left:${(here[i] - start) * cw}px;width:${(here[j] - here[i] + 1) * cw}px`,
          'data-translation': c.t.id, 'data-codon': String(c.index),
        }));
        i = j + 1;
      }
      const middle = c.positions[1];
      if (middle >= start && middle < end) {
        row.appendChild(el('span', {
          class: `aa-letter${c.aa === '*' ? ' stop' : ''}`,
          style: `left:${(middle - start) * cw}px;width:${cw}px`,
        }, c.aa));
      }
    }
    return row.childElementCount ? row : null;
  }

  _translationRow(text, start, end, n) {
    const frame = this.opts.translationFrame;
    const reverse = frame < 0;
    const offset = Math.abs(frame) - 1;
    // Codon boundaries are fixed by the frame across the whole sequence, so a
    // block shows the residues whose codons start inside it.
    let line = ' '.repeat(end - start);
    const src = reverse ? DNA.revComp(text) : text;
    const mapIndex = (i) => (reverse ? n - 1 - i : i);
    for (let i = offset; i + 3 <= n; i += 3) {
      const aa = CODONS[src.slice(i, i + 3).toUpperCase()] ?? 'X';
      const centre = reverse ? mapIndex(i + 1) : i + 1;
      if (centre < start || centre >= end) continue;
      const col = centre - start;
      line = line.slice(0, col) + aa + line.slice(col + 1);
    }
    return el('div', { class: 'seqmap-row aa', text: line });
  }
}
