/*
 * Analysis dialogs used from the editor toolbar: ORFs, auto-annotation,
 * digests with a virtual gel, silent sites, primer design and PCR.
 */

const Tools = {
  doc() {
    const d = Editor.doc;
    if (!d || !d.sequence) { toast('Open a sequence first', 'error'); return null; }
    return d;
  },

  resultTable(headers, rows, { onRowClick } = {}) {
    return el('div', { class: 'table-scroll' },
      el('table', {},
        el('thead', {}, el('tr', {}, headers.map((h) =>
          el('th', { class: h.num ? 'num' : '', text: h.label || h })))),
        el('tbody', {}, rows.map((cells, i) => el('tr', {
          style: onRowClick ? 'cursor:pointer' : '',
          onclick: onRowClick ? () => onRowClick(i) : undefined,
        }, cells.map((c) => el('td', {
          class: typeof c === 'object' && c.num ? 'num' : (typeof c === 'object' && c.mono ? 'mono' : ''),
          text: typeof c === 'object' ? String(c.text ?? c.value ?? '') : String(c),
        })))))));
  },

  /* --- ORFs ------------------------------------------------------------- */

  async orfs() {
    const doc = this.doc();
    if (!doc) return;
    modal({
      title: 'Open reading frames',
      wide: true,
      build: async (body) => {
        body.append(
          el('div', { class: 'field-row' },
            el('div', { class: 'field' },
              el('label', { for: 'orfMin' }, 'Minimum length (codons)'),
              el('input', { type: 'number', id: 'orfMin', value: '75', min: '10' })),
            el('div', { class: 'field', style: 'display:flex;align-items:flex-end' },
              el('button', { class: 'btn btn-sm', onclick: () => run() }, 'Find'))),
          el('div', { id: 'orfResults' }));
        const run = async () => {
          const target = document.getElementById('orfResults');
          target.replaceChildren(el('span', { class: 'spin' }));
          try {
            const { orfs } = await API.post('/api/tools/orfs', {
              document: Editor.payloadDoc(),
              min_aa: Number(document.getElementById('orfMin').value) || 75,
            });
            if (!orfs.length) { target.replaceChildren(el('div', { class: 'empty' }, 'No ORFs found.')); return; }
            target.replaceChildren(
              el('p', { class: 'hint' }, `${orfs.length} ORF(s). Click one to select it; “Annotate all” adds them as CDS features.`),
              el('div', { class: 'btn-group', style: 'margin-bottom:.5rem' },
                el('button', { class: 'btn btn-sm btn-secondary', onclick: () => this.annotateOrfs(orfs) },
                  'Annotate all as CDS')),
              this.resultTable(
                ['Start', 'End', 'Strand', { label: 'Length (aa)', num: true }, { label: 'bp', num: true }],
                orfs.map((o) => [o.start + 1, o.end, o.strand === -1 ? 'reverse' : 'forward',
                  { text: o.length_aa, num: true }, { text: o.length_bp, num: true }]),
                { onRowClick: (i) => {
                  const o = orfs[i];
                  Editor.view.setSelection({ start: o.start, end: o.end });
                  Editor.scrollToPosition(o.start);
                } }));
          } catch (err) {
            target.replaceChildren(el('div', { class: 'alert alert-error', text: err.message }));
          }
        };
        run();
      },
      buttons: [{ label: 'Close', kind: 'secondary' }],
    });
  },

  annotateOrfs(orfs) {
    const doc = Editor.doc;
    Editor.pushUndo();
    let i = 1;
    for (const o of orfs) {
      doc.features.push({
        id: `orf${Date.now().toString(36)}${i}`,
        name: `ORF ${i++}`,
        type: 'CDS',
        start: o.start,
        end: o.end,
        strand: o.strand,
        color: FEATURE_COLORS.CDS,
        qualifiers: {},
      });
    }
    Editor.markDirty();
    toast(`Added ${orfs.length} CDS feature(s)`, 'success');
  },

  /* --- auto-annotation -------------------------------------------------- */

  async annotate() {
    const doc = this.doc();
    if (!doc) return;
    try {
      const { features: found } = await API.post('/api/tools/annotate', { document: Editor.payloadDoc() });
      if (!found.length) { toast('No library features matched this sequence', 'info'); return; }
      modal({
        title: `Auto-annotate — ${found.length} match${found.length > 1 ? 'es' : ''}`,
        wide: true,
        build: (body) => {
          const checks = found.map((f, i) => el('label', { class: 'checkbox' },
            el('input', { type: 'checkbox', checked: true, 'data-i': String(i) }),
            el('span', {},
              el('b', { text: f.name }), ` ${f.type} `,
              el('span', { class: 'item-meta' },
                `${fmt(f.start + 1)}..${fmt(f.end)} ${f.strand === -1 ? '←' : '→'}`))));
          body.append(
            el('p', { class: 'hint' }, 'Choose which matches to add as features.'),
            el('div', { class: 'table-scroll' }, ...checks));
        },
        buttons: [
          { label: 'Cancel', kind: 'secondary' },
          {
            label: 'Add selected',
            onClick: ({ body }) => {
              const picked = [...body.querySelectorAll('input[type=checkbox]')]
                .filter((c) => c.checked)
                .map((c) => found[Number(c.dataset.i)]);
              Editor.pushUndo();
              doc.features.push(...picked);
              Editor.markDirty();
              toast(`Added ${picked.length} feature(s)`, 'success');
            },
          },
        ],
      });
    } catch (err) {
      toast(err.message, 'error');
    }
  },

  /* --- digest and gel --------------------------------------------------- */

  async digest() {
    const doc = this.doc();
    if (!doc) return;
    const cutters = [...new Set(Editor.sites.map((s) => s.enzyme))].sort();
    modal({
      title: 'Digest and virtual gel',
      wide: true,
      build: (body) => {
        body.append(
          el('p', { class: 'hint' },
            cutters.length
              ? 'Pick enzymes that cut this sequence (from the current enzyme set).'
              : 'No enzyme in the current set cuts this sequence.'),
          el('div', { class: 'field' },
            el('label', { for: 'digestEnzymes' }, 'Enzymes'),
            el('select', { id: 'digestEnzymes', multiple: true, size: String(Math.min(8, Math.max(3, cutters.length))) },
              cutters.map((c) => el('option', { value: c, text: c })))),
          el('div', { class: 'field' },
            el('label', { for: 'ladder' }, 'Ladder'),
            el('select', { id: 'ladder' },
              ['1 kb ladder', '1 kb Plus ladder', '100 bp ladder', 'Lambda HindIII'].map((l) =>
                el('option', { value: l, text: l })))),
          el('div', { class: 'btn-group' },
            el('button', { class: 'btn btn-sm', onclick: () => run() }, 'Run digest')),
          el('div', { id: 'digestOut', style: 'margin-top:.75rem' }));

        const run = async () => {
          const enzymes = [...document.getElementById('digestEnzymes').selectedOptions].map((o) => o.value);
          const out = document.getElementById('digestOut');
          if (!enzymes.length) { toast('Select at least one enzyme', 'error'); return; }
          out.replaceChildren(el('span', { class: 'spin' }));
          try {
            const [digestRes, gelRes] = await Promise.all([
              API.post('/api/tools/digest', { document: Editor.payloadDoc(), enzymes }),
              API.post('/api/tools/gel', {
                lanes: [{ document: Editor.payloadDoc(), enzymes, label: enzymes.join('+') }],
                ladder: document.getElementById('ladder').value,
              }),
            ]);
            out.replaceChildren(
              this.gelView(gelRes),
              el('h4', { style: 'margin:.75rem 0 .35rem;font-size:.9rem' }, 'Fragments'),
              this.resultTable(
                [{ label: 'Length', num: true }, 'Start', 'End', "5' end", "3' end"],
                digestRes.fragments.map((f) => [
                  { text: fmt(f.length), num: true }, f.start + 1, f.end,
                  f.left ? `${f.left.enzyme} ${f.left.overhang || 'blunt'}` : '—',
                  f.right ? `${f.right.enzyme} ${f.right.overhang || 'blunt'}` : '—'])));
          } catch (err) {
            out.replaceChildren(el('div', { class: 'alert alert-error', text: err.message }));
          }
        };
      },
      buttons: [{ label: 'Close', kind: 'secondary' }],
    });
  },

  /** A simple log-scale gel picture. */
  gelView(gel) {
    const all = [...gel.ladder.bands, ...gel.lanes.flatMap((l) => l.bands)].map((b) => b.size);
    const max = Math.max(...all, 1000);
    const min = Math.max(50, Math.min(...all, 500));
    const y = (size) => {
      const t = (Math.log10(max) - Math.log10(Math.max(size, min))) / (Math.log10(max) - Math.log10(min) || 1);
      return 6 + t * 86;   // percent from the top
    };
    const lane = (label, bands, isLadder) => el('div', { class: 'gel-lane' },
      el('div', { class: 'gel-lane-label', text: label }),
      ...bands.map((b) => el('div', {
        class: 'gel-band',
        style: `top:${y(b.size)}%;${b.count > 1 ? 'height:5px;' : ''}`,
        title: `${fmt(b.size)} bp${b.count > 1 ? ` ×${b.count}` : ''}`,
      }, isLadder ? el('span', { class: 'gel-band-label', text: fmt(b.size) }) : null)));
    return el('div', { class: 'gel' },
      el('div', { class: 'gel-lanes' },
        lane(gel.ladder.label, gel.ladder.bands, true),
        ...gel.lanes.map((l) => lane(l.label, l.bands, false))));
  },

  /* --- silent sites ----------------------------------------------------- */

  async silentSites() {
    const doc = this.doc();
    if (!doc) return;
    const sel = Editor.view.selection;
    const cds = doc.features.filter((f) => f.type === 'CDS');
    modal({
      title: 'Silent restriction sites',
      wide: true,
      build: (body) => {
        body.append(
          el('p', { class: 'hint' },
            'Finds enzyme sites that can be introduced into a reading frame without changing the protein.'),
          el('div', { class: 'field' },
            el('label', { for: 'ssRegion' }, 'Coding region'),
            el('select', { id: 'ssRegion' },
              sel && Editor.view.selectionLength() >= 6
                ? el('option', { value: `${sel.start}:${sel.end}`, text: `Selection ${sel.start + 1}–${sel.end}` })
                : null,
              cds.map((f) => el('option', { value: `${f.start}:${f.end}`, text: `${f.name} (${f.start + 1}–${f.end})` })))),
          el('div', { class: 'field' },
            el('label', { for: 'ssChanges' }, 'Maximum base changes'),
            el('input', { type: 'number', id: 'ssChanges', value: '2', min: '1', max: '4' })),
          el('div', { class: 'btn-group' }, el('button', { class: 'btn btn-sm', onclick: () => run() }, 'Search')),
          el('div', { id: 'ssOut', style: 'margin-top:.75rem' }));

        const run = async () => {
          const choice = document.getElementById('ssRegion').value;
          const out = document.getElementById('ssOut');
          if (!choice) { toast('Select a coding region or a CDS feature first', 'error'); return; }
          const [start, end] = choice.split(':').map(Number);
          out.replaceChildren(el('span', { class: 'spin' }));
          try {
            const { sites } = await API.post('/api/tools/silent-sites', {
              document: Editor.payloadDoc(),
              cds_start: start, cds_end: end,
              max_changes: Number(document.getElementById('ssChanges').value) || 2,
              enzymes: Editor.currentEnzymes(),
            });
            if (!sites.length) { out.replaceChildren(el('div', { class: 'empty' }, 'No silent sites found.')); return; }
            out.replaceChildren(
              el('p', { class: 'hint' }, `${sites.length} option(s). Click a row to apply the change.`),
              this.resultTable(
                ['Enzyme', 'Site', 'Position', { label: 'Changes', num: true }, 'Replace', 'Unique after'],
                sites.slice(0, 200).map((s) => [s.enzyme, { text: s.site, mono: true }, s.position + 1,
                  { text: s.changes, num: true },
                  { text: `${s.old} → ${s.new}`, mono: true }, s.unique_after ? 'yes' : 'no']),
                { onRowClick: (i) => this.applySilent(sites[i]) }));
          } catch (err) {
            out.replaceChildren(el('div', { class: 'alert alert-error', text: err.message }));
          }
        };
      },
      buttons: [{ label: 'Close', kind: 'secondary' }],
    });
  },

  async applySilent(site) {
    const ok = await confirmDialog('Apply silent mutation',
      `Replace ${site.old} with ${site.new} at ${site.replace_start + 1}, creating a ${site.enzyme} site? The protein sequence does not change.`,
      'Apply');
    if (!ok) return;
    Editor.replaceRange({ start: site.replace_start, end: site.replace_end }, site.new);
    toast(`${site.enzyme} site introduced`, 'success');
  },

  /* --- primers ---------------------------------------------------------- */

  async designPrimers() {
    const doc = this.doc();
    if (!doc) return;
    const sel = Editor.view.selection;
    if (!sel || Editor.view.selectionLength() < 50) {
      toast('Select the region to amplify (at least 50 bp)', 'error');
      return;
    }
    modal({
      title: 'Design primers',
      wide: true,
      build: (body) => {
        body.append(
          el('p', { class: 'hint' }, `Amplifying ${fmt(sel.start + 1)}–${fmt(sel.end)} (${fmt(Editor.view.selectionLength())} bp).`),
          el('div', { class: 'field-row' },
            el('div', { class: 'field' },
              el('label', { for: 'pTm' }, 'Target Tm (°C)'),
              el('input', { type: 'number', id: 'pTm', value: '60', step: '0.5' })),
            el('div', { class: 'field' },
              el('label', { for: 'pMin' }, 'Min length'),
              el('input', { type: 'number', id: 'pMin', value: '18' })),
            el('div', { class: 'field' },
              el('label', { for: 'pMax' }, 'Max length'),
              el('input', { type: 'number', id: 'pMax', value: '32' }))),
          el('div', { class: 'field-row' },
            el('div', { class: 'field' },
              el('label', { for: 'pFTail' }, "Forward 5' tail"),
              el('input', { type: 'text', id: 'pFTail', class: 'mono', placeholder: 'GGTCTCAAATG' })),
            el('div', { class: 'field' },
              el('label', { for: 'pRTail' }, "Reverse 5' tail"),
              el('input', { type: 'text', id: 'pRTail', class: 'mono', placeholder: 'GGTCTCAAGCTT' }))),
          el('div', { class: 'hint' }, 'Tails are added unchanged, so Type IIS sites and overhangs can be built in.'),
          el('div', { class: 'btn-group', style: 'margin-top:.5rem' },
            el('button', { class: 'btn btn-sm', onclick: () => run() }, 'Design')),
          el('div', { id: 'pOut', style: 'margin-top:.75rem' }));

        const run = async () => {
          const out = document.getElementById('pOut');
          out.replaceChildren(el('span', { class: 'spin' }));
          try {
            const res = await API.post('/api/tools/design-primers', {
              document: Editor.payloadDoc(),
              start: sel.start, end: sel.end,
              target_tm: Number(document.getElementById('pTm').value) || 60,
              min_len: Number(document.getElementById('pMin').value) || 18,
              max_len: Number(document.getElementById('pMax').value) || 32,
              forward_tail: document.getElementById('pFTail').value,
              reverse_tail: document.getElementById('pRTail').value,
            });
            const row = (label, p) => !p || !p.sequence ? null : el('div', { class: 'field' },
              el('label', {}, `${label} — ${p.length} nt, Tm ${p.tm} °C, GC ${p.gc}%`),
              el('input', { type: 'text', class: 'mono', readonly: true, value: p.full || p.sequence }));
            out.replaceChildren(
              row('Forward', res.forward),
              row('Reverse', res.reverse),
              el('p', { class: 'hint' }, `Product: ${fmt(res.product_length)} bp`),
              el('div', { class: 'btn-group' },
                el('button', {
                  class: 'btn btn-sm btn-secondary',
                  onclick: () => Editor.copy(`${res.forward.full || res.forward.sequence}\n${res.reverse.full || res.reverse.sequence}`),
                }, 'Copy both'),
                Stocks.enabled() ? el('button', {
                  class: 'btn btn-sm', title: 'Add both to the lab\'s primers in Lab Stocks, numbered there',
                  onclick: (e) => this.savePrimers(e.currentTarget, doc, res),
                }, 'Save to primer stock') : null,
                el('button', {
                  class: 'btn btn-sm btn-secondary',
                  onclick: () => {
                    const doc2 = Editor.doc;
                    Editor.pushUndo();
                    doc2.features.push(
                      { id: `pf${Date.now().toString(36)}`, name: 'Forward primer', type: 'primer_bind',
                        start: sel.start, end: sel.start + res.forward.length, strand: 1,
                        color: FEATURE_COLORS.primer_bind, qualifiers: {} },
                      { id: `pr${Date.now().toString(36)}`, name: 'Reverse primer', type: 'primer_bind',
                        start: sel.end - res.reverse.length, end: sel.end, strand: -1,
                        color: FEATURE_COLORS.primer_bind, qualifiers: {} });
                    Editor.markDirty();
                    toast('Primer binding sites annotated', 'success');
                  },
                }, 'Annotate binding sites')));
          } catch (err) {
            out.replaceChildren(el('div', { class: 'alert alert-error', text: err.message }));
          }
        };
      },
      buttons: [{ label: 'Close', kind: 'secondary' }],
    });
  },

  /** Save a designed pair to Lab Stocks, named after the plasmid. */
  async savePrimers(button, doc, res) {
    const base = (doc.name || 'primer').slice(0, 60);
    const target = `${doc.name || ''} ${fmt(Editor.view.selection.start + 1)}–${fmt(Editor.view.selection.end)}`;
    button.disabled = true;
    try {
      const { primers } = await Stocks.call('POST', '/primers/many', { primers: [
        { name: `${base}-F`, sequence: res.forward.full || res.forward.sequence, direction: 'forward', target, purpose: 'PCR' },
        { name: `${base}-R`, sequence: res.reverse.full || res.reverse.sequence, direction: 'reverse', target, purpose: 'PCR' }] });
      button.replaceWith(el('span', { class: 'hint' }, 'Saved as ',
        primers.map((p, i) => [i ? ' and ' : '', el('a', { href: Stocks.link(p.code), target: '_blank', rel: 'noopener' }, `${p.code} ${p.name}`)]),
        ' — rename them, and say where the tubes are, in Lab Stocks.'));
    } catch (err) {
      button.disabled = false;
      toast(err.message, 'error', 6000);
    }
  },

  /**
   * The lab's primers (from Lab Stocks) that bind this sequence: the 3' end of
   * each (its last 15 nt) must match exactly, on either strand; the rest may
   * differ (a tail), and the mismatches there are counted.
   */
  bindingSites(sequence, circular, primers) {
    const IUPAC = { A: 'A', C: 'C', G: 'G', T: 'T', R: '[AG]', Y: '[CT]', S: '[CG]', W: '[AT]', K: '[GT]', M: '[AC]',
      B: '[CGT]', D: '[AGT]', H: '[ACT]', V: '[ACG]', N: '[ACGT]' };
    const matches = (p, s) => p === 'N' || p === s || (IUPAC[p] || '').includes(s);
    const seq = sequence.toUpperCase();
    const n = seq.length;
    const CORE = 15;
    const sites = [];
    for (const p of primers) {
      const primer = p.sequence.toUpperCase();
      if (primer.length < 12) continue;
      const core = primer.slice(-Math.min(CORE, primer.length));
      const coreRe = new RegExp([...core].map((c) => IUPAC[c] || c).join(''), 'g');
      for (const strand of [1, -1]) {
        // The strand the primer anneals to: forward primers read along the top strand.
        const target = strand === 1 ? seq : DNA.revComp(seq);
        const hay = circular ? target + target.slice(0, primer.length) : target;
        coreRe.lastIndex = 0;
        let m;
        while ((m = coreRe.exec(hay)) !== null) {
          coreRe.lastIndex = m.index + 1;
          const end = m.index + core.length;                 // just past the 3' end, on this strand
          if (end > (circular ? n + core.length : n)) continue;
          if (circular && m.index >= n) continue;          // already found in the first copy
          let mismatches = 0;
          let unbound = 0;
          for (let k = primer.length - core.length - 1, j = m.index - 1; k >= 0; k--, j--) {
            const s = j >= 0 ? hay[j] : (circular ? hay[n + j] : undefined);
            if (s === undefined) { unbound++; continue; }
            if (!matches(primer[k], s)) mismatches++;
          }
          const startOnStrand = m.index - (primer.length - core.length);
          // Positions on the top strand, 0-based [start, end).
          let start;
          let stop;
          if (strand === 1) { start = ((startOnStrand % n) + n) % n; stop = end % n || n; } else {
            start = ((n - end) % n + n) % n; stop = ((n - startOnStrand) % n) || n;
          }
          sites.push({ ...p, strand, start, end: stop, mismatches, unbound });
        }
      }
    }
    return sites.sort((a, b) => a.mismatches + a.unbound - (b.mismatches + b.unbound) || a.start - b.start);
  },

  async labPrimers() {
    const doc = this.doc();
    if (!doc?.sequence) return;
    let primers;
    try {
      ({ primers } = await Stocks.call('GET', '/primers/sequences'));
    } catch (err) { toast(err.message, 'error'); return; }
    const sites = this.bindingSites(doc.sequence, doc.circular, primers);
    modal({
      title: `The lab's primers on ${doc.name || 'this sequence'}`, wide: true,
      build: (body) => {
        body.append(el('p', { class: 'hint' },
          `${primers.length} primer${primers.length === 1 ? '' : 's'} in stock in Lab Stocks; `,
          'a primer binds where its last 15 nt match exactly. Mismatches further from the 3′ end (a tail, a site added) are counted. ',
          'Click a row to select where it binds.'));
        if (!sites.length) { body.append(el('p', { class: 'empty' }, 'None of the lab\'s primers bind this sequence.')); return; }
        body.append(el('table', {},
          el('thead', {}, el('tr', {}, ['Primer', 'Name', 'Strand', 'Binds', 'Fit', 'Tm', 'Kept in', ''].map((h) => el('th', {}, h)))),
          el('tbody', {}, sites.map((s) => el('tr', {
            class: 'clickable',
            onclick: () => { Editor.selectRange({ start: s.start, end: s.end }); Editor.scrollToPosition(s.start); },
          },
          el('td', {}, el('a', { href: Stocks.link(s.code), target: '_blank', rel: 'noopener', onclick: (e) => e.stopPropagation() }, s.code)),
          el('td', {}, s.name), el('td', {}, s.strand === 1 ? '→ forward' : '← reverse'),
          el('td', {}, `${fmt(s.start + 1)}–${fmt(s.end)}`),
          el('td', {}, s.mismatches || s.unbound ? `${s.mismatches} mismatch${s.mismatches === 1 ? '' : 'es'}${s.unbound ? `, ${s.unbound} nt overhang` : ''} at the 5′ end` : 'perfect'),
          el('td', {}, s.tm !== null && s.tm !== undefined ? `${s.tm} °C` : ''), el('td', {}, s.location || ''),
          el('td', {}, el('button', { class: 'btn btn-sm btn-secondary', title: 'Add it as a primer_bind feature', onclick: (e) => {
            e.stopPropagation();
            Editor.pushUndo();
            Editor.doc.features.push({ id: `lp${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`, name: `${s.code} ${s.name}`,
              type: 'primer_bind', start: s.start, end: s.end, strand: s.strand, color: FEATURE_COLORS.primer_bind,
              qualifiers: { note: `Lab Stocks ${s.code}` } });
            Editor.markDirty();
            toast(`${s.code} annotated`, 'success');
          } }, 'Annotate')))))));
      },
    });
  },

  async pcr() {
    const doc = this.doc();
    if (!doc) return;
    modal({
      title: 'Simulate PCR',
      wide: true,
      build: (body) => {
        body.append(
          el('div', { class: 'field' },
            el('label', { for: 'pcrF' }, 'Forward primer'),
            el('input', { type: 'text', id: 'pcrF', class: 'mono', placeholder: 'ACGT…' })),
          el('div', { class: 'field' },
            el('label', { for: 'pcrR' }, 'Reverse primer'),
            el('input', { type: 'text', id: 'pcrR', class: 'mono', placeholder: 'ACGT…' })),
          el('div', { class: 'field-row' },
            el('div', { class: 'field' },
              el('label', { for: 'pcrAnneal' }, "3' match required (nt)"),
              el('input', { type: 'number', id: 'pcrAnneal', value: '15', min: '10' })),
            el('div', { class: 'field' },
              el('label', { for: 'pcrMis' }, 'Mismatches allowed'),
              el('input', { type: 'number', id: 'pcrMis', value: '0', min: '0', max: '3' }))),
          el('div', { class: 'btn-group' }, el('button', { class: 'btn btn-sm', onclick: () => run() }, 'Amplify')),
          el('div', { id: 'pcrOut', style: 'margin-top:.75rem' }));

        const run = async () => {
          const out = document.getElementById('pcrOut');
          out.replaceChildren(el('span', { class: 'spin' }));
          try {
            const res = await API.post('/api/tools/pcr', {
              document: Editor.payloadDoc(),
              forward: document.getElementById('pcrF').value,
              reverse: document.getElementById('pcrR').value,
              min_anneal: Number(document.getElementById('pcrAnneal').value) || 15,
              max_mismatches: Number(document.getElementById('pcrMis').value) || 0,
            });
            const info = el('p', { class: 'hint' },
              `Forward: ${res.forward.length} nt, Tm ${res.forward.tm ?? '–'} °C · `,
              `Reverse: ${res.reverse.length} nt, Tm ${res.reverse.tm ?? '–'} °C`);
            if (!res.products.length) {
              out.replaceChildren(info, el('div', { class: 'empty' }, 'No product. Check the primer orientation and 3′ match.'));
              return;
            }
            out.replaceChildren(info,
              this.resultTable(
                [{ label: 'Product', num: true }, 'From', 'To', 'Open'],
                res.products.map((p) => [{ text: `${fmt(p.length)} bp`, num: true },
                  p.template_start + 1, p.template_end, 'click row']),
                { onRowClick: (i) => {
                  const p = res.products[i];
                  Editor.addDocument({ name: `${doc.name} PCR ${fmt(p.length)} bp`, sequence: p.sequence,
                                       circular: false, features: [] });
                  toast('PCR product opened as a new sequence', 'success');
                } }));
          } catch (err) {
            out.replaceChildren(el('div', { class: 'alert alert-error', text: err.message }));
          }
        };
      },
      buttons: [{ label: 'Close', kind: 'secondary' }],
    });
  },
};
