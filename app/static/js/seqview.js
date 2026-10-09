/*
 * SeqView - the scrolling sequence text map.
 *
 * Renders the sequence in wrapped blocks with, optionally, the complement
 * strand, a reading-frame translation, feature bars, restriction cut marks
 * and search highlights. Supports click and drag selection in sequence
 * coordinates, which the editor uses for every operation.
 */

class SeqView {
  constructor(container, opts = {}) {
    this.container = container;
    this.doc = { name: '', sequence: '', circular: false, features: [] };
    this.opts = {
      width: 60,
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
    this.onSelect = null;
    this.onFeatureClick = null;
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
    window.addEventListener('mouseup', () => { this._drag = null; });
    container.addEventListener('mousemove', (e) => this._mousemove(e));
    container.addEventListener('keydown', (e) => this._keydown(e));
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
    this.selection = sel;
    this.caret = sel ? sel.end : null;
    this._anchor = sel ? sel.start : null;
    this.render();
    if (notify) this.onSelect?.(sel);
  }

  /** Put the insertion point at `pos`, optionally extending from the anchor. */
  setCaret(pos, extend = false) {
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
        this.onFeatureClick?.(f);
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
    if (this._drag === null || this._drag === undefined) return;
    const pos = this._posFromEvent(e);
    if (pos === null) return;
    const sel = { start: Math.min(this._drag, pos), end: Math.max(this._drag, pos) };
    if (sel.start === sel.end) return;
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

    // Cut marks by position.
    const cuts = new Map();
    if (this.opts.showEnzymes) {
      for (const s of this.sites) {
        if (s.cut_top === null || s.cut_top === undefined) continue;
        const list = cuts.get(s.cut_top) || [];
        list.push(s.enzyme);
        cuts.set(s.cut_top, list);
      }
    }

    const sel = this.selection;
    const selLen = this.selectionLength();

    for (let start = 0; start < n; start += width) {
      const end = Math.min(start + width, n);
      const len = end - start;
      const block = el('div', { class: 'seqmap-block' });
      const rows = el('div', { class: 'seqmap-rows' });

      // Enzyme row
      if (this.opts.showEnzymes) {
        const labels = [];
        for (let i = start; i < end; i++) {
          const names = cuts.get(i);
          if (names) labels.push({ col: i - start, text: names.join(',') });
        }
        if (labels.length) {
          let line = ' '.repeat(len);
          for (const l of labels) {
            const t = l.text;
            const at = Math.max(0, Math.min(len - 1, l.col));
            line = line.slice(0, at) + t + line.slice(at + t.length);
          }
          const row = el('div', { class: 'seqmap-row enzyme', text: line.slice(0, Math.max(len, 1) + 20) });
          for (const l of labels) {
            row.appendChild(el('span', {
              class: 'cut-mark',
              style: `left:${l.col * this._charWidth()}px`,
            }));
          }
          rows.appendChild(row);
        }
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

      if (comp) {
        rows.appendChild(el('div', { class: 'seqmap-row complement', text: comp.slice(start, end) }));
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
