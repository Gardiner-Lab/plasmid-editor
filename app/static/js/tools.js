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

  // The digests run, kept as lanes of the gel, so banding patterns can be seen side by side: each
  // open tab's, until that tab is closed (a newer digest of a tab with the same enzymes replaces it).
  gelLanes: [],
  MAX_LANES: 16,

  /** The kept lanes of the tabs still open. */
  openLanes() {
    this.gelLanes = this.gelLanes.filter((l) => Editor.docs.includes(l.doc));
    return this.gelLanes;
  },

  /** A tab closed: its lanes go with it. */
  forgetLanes(doc) {
    this.gelLanes = this.gelLanes.filter((l) => l.doc !== doc);
  },

  /** A tab's sequence as the API takes it (any open tab, not only the active one). */
  payloadOf(d) {
    return { name: d.name, sequence: d.sequence, circular: d.circular, description: d.description || '',
             features: d.features, translations: d.translations || [] };
  },

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

        // The gel: the ladder, then the kept lanes of the open tabs, this digest among them.
        const gelBox = el('div');
        const drawGel = async () => {
          const lanes = this.openLanes();
          if (!lanes.length) { gelBox.replaceChildren(); return; }
          const res = await API.post('/api/tools/gel', {
            lanes: lanes.map((l) => ({ document: this.payloadOf(l.doc), enzymes: l.enzymes,
              label: `${l.doc.name || 'Untitled'}\n${l.enzymes.join('+')}` })),
            ladder: document.getElementById('ladder').value,
          });
          const others = lanes.filter((l) => l.doc !== doc).length;
          const ladder = document.getElementById('ladder').value;
          gelBox.replaceChildren(
            this.gelView(res),
            NOTEBOOK ? el('div', { class: 'gel-notebook' },
              el('button', {
                class: 'btn btn-sm btn-secondary', type: 'button',
                title: "Put this gel and its fragments into a day's page of your Lab Notebook",
                onclick: () => this.toNotebook(res, [...lanes], ladder),
              }, '📓 Add to notebook')) : null,
            el('div', { class: 'gel-kept' },
              el('span', { class: 'hint' }, lanes.length > 1
                ? `Lanes stay on the gel until their tab is closed${others ? ` (${others} from other open tabs)` : ''}: `
                : 'Run a digest in another open tab and it joins this gel, lane by lane, until its tab is closed. '),
              ...lanes.map((l) => el('span', { class: 'gel-kept-lane' }, `${l.doc.name || 'Untitled'}: ${l.enzymes.join('+')}`,
                el('button', { class: 'chip-x', type: 'button', title: 'Take this lane off the gel', onclick: async () => {
                  this.gelLanes = this.gelLanes.filter((x) => x !== l);
                  await drawGel();
                } }, '×'))),
              lanes.length > 1 ? el('button', { class: 'btn btn-sm btn-secondary', type: 'button', onclick: async () => {
                this.gelLanes = this.gelLanes.slice(-1);
                await drawGel();
              } }, 'Keep only the last') : null));
        };

        const run = async () => {
          const enzymes = [...document.getElementById('digestEnzymes').selectedOptions].map((o) => o.value);
          const out = document.getElementById('digestOut');
          if (!enzymes.length) { toast('Select at least one enzyme', 'error'); return; }
          out.replaceChildren(el('span', { class: 'spin' }));
          try {
            const key = enzymes.join('+');
            this.gelLanes = [...this.openLanes().filter((l) => !(l.doc === doc && l.enzymes.join('+') === key)),
              { doc, enzymes }].slice(-this.MAX_LANES);
            const [digestRes] = await Promise.all([
              API.post('/api/tools/digest', { document: Editor.payloadDoc(), enzymes }),
              drawGel(),
            ]);
            out.replaceChildren(
              gelBox,
              el('h4', { style: 'margin:.75rem 0 .35rem;font-size:.9rem' }, `Fragments: ${doc.name || 'Untitled'}, ${key}`),
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

  /**
   * The gel as a picture, drawn as gelView draws it, and where each well is
   * on it (as fractions of its width and height): the ladder's first, then
   * each lane's. Resolves to { blob, wells }.
   */
  gelPicture(gel) {
    const all = [...gel.ladder.bands, ...gel.lanes.flatMap((l) => l.bands)].map((b) => b.size);
    const max = Math.max(...all, 1000);
    const min = Math.max(50, Math.min(...all, 500));
    const scale = 2;                          // drawn at twice the size, to stay sharp when zoomed
    const laneW = 72, gap = 20, left = 64, top = 30, gelH = 320, bottom = 52;
    const lanes = [{ label: gel.ladder.label, bands: gel.ladder.bands, ladder: true },
      ...gel.lanes.map((l) => ({ label: l.label, bands: l.bands, ladder: false }))];
    const W = left + lanes.length * (laneW + gap) + 16;
    const H = top + gelH + bottom;
    const canvas = document.createElement('canvas');
    canvas.width = W * scale;
    canvas.height = H * scale;
    const ctx = canvas.getContext('2d');
    ctx.scale(scale, scale);
    ctx.fillStyle = '#111827';
    ctx.fillRect(0, 0, W, H);
    const y = (size) => {
      const t = (Math.log10(max) - Math.log10(Math.max(size, min))) / (Math.log10(max) - Math.log10(min) || 1);
      return top + (0.06 + t * 0.86) * gelH;
    };
    const wells = [];
    lanes.forEach((lane, i) => {
      const x0 = left + i * (laneW + gap);
      // The well the sample went into, and the lane it ran down.
      ctx.fillStyle = '#1f2937';
      ctx.fillRect(x0, top, laneW, gelH);
      ctx.strokeStyle = '#4b5563';
      ctx.lineWidth = 1;
      ctx.strokeRect(x0 + 6, top + 4, laneW - 12, 7);
      wells.push({ x: (x0 + laneW / 2) / W, y: (top + 8) / H });
      for (const b of lane.bands) {
        const by = y(b.size);
        ctx.shadowColor = 'rgba(255,255,255,.55)';
        ctx.shadowBlur = 5;
        ctx.fillStyle = '#e5e7eb';
        ctx.fillRect(x0 + 5, by - (b.count > 1 ? 2.5 : 1.5), laneW - 10, b.count > 1 ? 5 : 3);
        ctx.shadowBlur = 0;
        if (lane.ladder) {
          ctx.fillStyle = '#9ca3af';
          ctx.font = '10px system-ui, sans-serif';
          ctx.textAlign = 'right';
          ctx.textBaseline = 'middle';
          ctx.fillText(fmt(b.size), x0 - 6, by);
        }
      }
      ctx.fillStyle = '#d1d5db';
      ctx.font = '10px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      String(lane.label).split('\n').slice(0, 3).forEach((line, k) => {
        const text = line.length > 16 ? `${line.slice(0, 15)}…` : line;
        ctx.fillText(text, x0 + laneW / 2, top + gelH + 6 + k * 13);
      });
    });
    return new Promise((resolve) => canvas.toBlob((blob) => resolve({ blob, wells }), 'image/png'));
  },

  /**
   * Put a virtual digest into a day's page of the Lab Notebook: the gel as a
   * picture with its wells numbered and named (the ladder first), and a table
   * of every lane's fragments, with a column to tick off the bands seen on the
   * real gel. Asks which day first; today, unless another is chosen.
   */
  toNotebook(gel, lanes, ladder) {
    const pad = (n) => String(n).padStart(2, '0');
    const now = new Date();
    const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
    const fragmentCount = gel.lanes.reduce((sum, l) => sum + l.bands.reduce((s, b) => s + (b.count || 1), 0), 0);
    modal({
      title: 'Add to the Lab Notebook',
      build: (body) => body.append(
        el('p', {}, `The gel (${lanes.length} lane${lanes.length > 1 ? 's' : ''} and the ${ladder}) and its `,
          `${fmt(fragmentCount)} fragment${fragmentCount === 1 ? '' : 's'} go at the end of the day's page, `,
          'with the wells numbered and named, and a column to tick off the bands seen on the real gel.'),
        el('div', { class: 'field' },
          el('label', { for: 'nbDay' }, 'Day'),
          el('input', { type: 'date', id: 'nbDay', value: today, style: 'max-width:12rem' }),
          el('span', { class: 'hint' }, 'Started in your notebook if it is not there yet.'))),
      buttons: [
        { label: 'Cancel', kind: 'secondary' },
        {
          label: 'Add to notebook',
          onClick: async ({ body }) => {
            const day = body.querySelector('#nbDay').value || today;
            const fragments = await Promise.all(lanes.map((l) =>
              API.post('/api/tools/digest', { document: this.payloadOf(l.doc), enzymes: l.enzymes })));
            const { blob, wells } = await this.gelPicture(gel);
            const section = this.digestSection(gel, lanes, ladder, fragments.map((f) => f.fragments), wells);
            const form = new FormData();
            form.append('section', JSON.stringify(section));
            form.append('date', day);
            form.append('picture', blob, 'virtual-gel.png');
            const res = await fetch(`${NOTEBOOK}/api/days/import`, { method: 'POST', credentials: 'same-origin', body: form });
            let data = {};
            try { data = await res.json(); } catch { /* not JSON */ }
            if (!res.ok) throw new Error(data.error || `Lab Notebook: ${res.status}`);
            const where = `${NOTEBOOK}/#note=${encodeURIComponent(data.note.id)}`;
            toast(`Added to ${data.note.title} in your Lab Notebook`, 'success', 6000);
            for (const box of document.querySelectorAll('.gel-notebook')) {
              box.querySelector('.gel-notebook-done')?.remove();
              box.append(el('span', { class: 'gel-notebook-done hint' }, ' Added to ',
                el('a', { href: where, target: '_blank', rel: 'noopener' }, `${data.note.title} ↗`)));
            }
            return true;
          },
        },
      ],
    });
  },

  /** A virtual digest as a notebook section: what was cut with what, the gel, and the fragments. */
  digestSection(gel, lanes, ladder, fragmentsPerLane, wells) {
    const esc = (s) => String(s).replace(/[&<>"]/g, (ch) => `&#${ch.charCodeAt(0)};`);
    const name = (d) => d.name || 'Untitled';
    // A saved plasmid is linked, so the day shows on it in the notebook; an unsaved one is named.
    const plasmid = (d) => (d.id ? `<a data-plasmid="${esc(d.id)}">${esc(name(d))}</a>` : `<b>${esc(name(d))}</b>`);
    const cuts = lanes.map((l) => `${plasmid(l.doc)} with ${esc(l.enzymes.join(' + '))}`);
    const expected = (bands) => bands.map((b) => `${fmt(b.size)}${b.count > 1 ? ` ×${b.count}` : ''}`).join(' + ');
    const end = (e) => (e ? `${e.enzyme} ${e.overhang || 'blunt'}` : '—');
    const rows = [];
    lanes.forEach((l, i) => {
      // Largest first, as the bands run down the gel.
      for (const f of [...fragmentsPerLane[i]].sort((a, b) => b.length - a.length)) {
        rows.push({ cells: [String(i + 2), name(l.doc), l.enzymes.join('+'), String(f.length),
          String(f.start + 1), String(f.end), end(f.left), end(f.right), null] });
      }
    });
    return {
      type: 'section',
      title: lanes.length === 1 ? `Virtual digest: ${name(lanes[0].doc)} (${lanes[0].enzymes.join('+')})`
        : `Virtual digest: ${lanes.length} lanes`,
      source: { kind: 'virtual-digest', id: lanes.length === 1 && lanes[0].doc.id ? lanes[0].doc.id : '',
                name: lanes.map((l) => name(l.doc)).filter((v, i, all) => all.indexOf(v) === i).join(', ') },
      blocks: [
        { type: 'text', html: `<p>Virtual digest from the Plasmid Editor: ${cuts.join('; ')}, beside the ${esc(ladder)}.</p>` },
        { type: 'gel', title: 'Virtual gel', attachment: 'picture', order: 'rows',
          lanes: [
            { ...wells[0], label: `Ladder: ${ladder}`, note: `${expected(gel.ladder.bands)} bp` },
            ...gel.lanes.map((l, i) => ({ ...wells[i + 1], label: `${name(lanes[i].doc)} · ${lanes[i].enzymes.join('+')}`,
              note: `Expected: ${expected(l.bands)} bp` })),
          ] },
        { type: 'table', title: 'Fragments', scale: null,
          columns: [{ name: 'Lane', kind: 'text' }, { name: 'Plasmid', kind: 'text' }, { name: 'Enzymes', kind: 'text' },
            { name: 'Length', kind: 'number', unit: 'bp' }, { name: 'Start', kind: 'number' }, { name: 'End', kind: 'number' },
            { name: "5' end", kind: 'text' }, { name: "3' end", kind: 'text' }, { name: 'Seen on the gel', kind: 'check' }],
          rows },
      ],
    };
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
            // Where the pair binds; each gets its Lab Stocks code once saved.
            const sites = [
              { strand: 1, start: sel.start, end: sel.start + res.forward.length, label: 'Forward primer' },
              { strand: -1, start: sel.end - res.reverse.length, end: sel.end, label: 'Reverse primer' }];
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
                  class: 'btn btn-sm', title: 'Add both to the lab\'s primers in Lab Stocks, numbered there; their binding sites take the codes',
                  onclick: (e) => this.savePrimers(e.currentTarget, doc, res, sites),
                }, 'Save to primer stock') : null,
                el('button', {
                  class: 'btn btn-sm btn-secondary',
                  onclick: () => {
                    const doc2 = Editor.doc;
                    Editor.pushUndo();
                    // Named by their Lab Stocks codes once saved there; until then, renamed on saving.
                    doc2.features.push(...sites.map((site) => ({
                      id: `p${site.strand === 1 ? 'f' : 'r'}${Date.now().toString(36)}`, type: 'primer_bind',
                      start: site.start, end: site.end, strand: site.strand, color: FEATURE_COLORS.primer_bind,
                      ...this.primerNaming(site) })));
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

  /** A designed primer's feature name: its Lab Stocks code once saved there, else Forward / Reverse primer. */
  primerNaming(site) {
    return site.stock
      ? { name: site.stock.code, qualifiers: { note: `Lab Stocks ${site.stock.code} (${site.stock.name})` } }
      : { name: site.label, qualifiers: {} };
  },

  /**
   * Save a designed pair to Lab Stocks, named after the plasmid. Their binding
   * sites, when annotated, are renamed to the codes Lab Stocks gives them.
   */
  async savePrimers(button, doc, res, sites) {
    const base = (doc.name || 'primer').slice(0, 60);
    const target = `${doc.name || ''} ${fmt(sites[0].start + 1)}–${fmt(sites[1].end)}`;
    button.disabled = true;
    try {
      const { primers } = await Stocks.call('POST', '/primers/many', { primers: [
        { name: `${base}-F`, sequence: res.forward.full || res.forward.sequence, direction: 'forward', target, purpose: 'PCR' },
        { name: `${base}-R`, sequence: res.reverse.full || res.reverse.sequence, direction: 'reverse', target, purpose: 'PCR' }] });
      sites.forEach((site, i) => { site.stock = primers[i]; });
      // The binding sites already annotated on this sequence: named after their codes now.
      const named = Editor.doc === doc ? doc.features.filter((f) => f.type === 'primer_bind'
        && sites.some((site) => site.strand === f.strand && site.start === f.start && site.end === f.end
          && ['Forward primer', 'Reverse primer'].includes(f.name))) : [];
      if (named.length) {
        Editor.pushUndo();
        for (const f of named) {
          const site = sites.find((x) => x.strand === f.strand && x.start === f.start && x.end === f.end);
          Object.assign(f, this.primerNaming(site));
        }
        Editor.markDirty();
      }
      button.replaceWith(el('span', { class: 'hint' }, 'Saved as ',
        primers.map((p, i) => [i ? ' and ' : '', el('a', { href: Stocks.link(p.code), target: '_blank', rel: 'noopener' }, `${p.code} ${p.name}`)]),
        named.length ? '; the binding sites are named after them.' : '; annotate the binding sites to mark them with these codes.',
        ' Say where the tubes are in Lab Stocks.'));
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

  /**
   * The primers on this sequence: its primer_bind features, and the lab's primers
   * in Lab Stocks that bind it (their whole sequence, tail and all). Where both
   * mark the same primer (the same 3' end), the lab's is kept.
   */
  async primersOnSequence(doc) {
    const seq = doc.sequence || '';
    const n = seq.length;
    const region = (start, end) => (end > start ? seq.slice(start, end) : seq.slice(start) + seq.slice(0, end));
    const threePrime = (p) => `${p.strand}:${p.strand === 1 ? p.end : p.start}`;
    const found = new Map();
    if (Stocks.enabled() && n) {
      try {
        const { primers } = await Stocks.call('GET', '/primers/sequences');
        for (const s of this.bindingSites(seq, doc.circular, primers)) {
          const key = threePrime(s);
          if (found.has(key)) continue;
          found.set(key, { name: `${s.code} ${s.name}`, code: s.code, strand: s.strand, start: s.start, end: s.end,
            sequence: s.sequence.toUpperCase(), fit: s.mismatches || s.unbound ? `${s.mismatches + s.unbound} nt unmatched at the 5′ end` : 'perfect' });
        }
      } catch (err) { /* Lab Stocks unreachable: the features alone */ }
    }
    for (const f of doc.features || []) {
      if (!['primer_bind', 'primer'].includes(f.type) || !(f.strand === 1 || f.strand === -1) || !n) continue;
      const key = threePrime(f);
      if (found.has(key)) continue;
      const top = region(f.start, f.end).toUpperCase();
      found.set(key, { name: f.name || 'primer', strand: f.strand, start: f.start, end: f.end,
        sequence: f.strand === 1 ? top : DNA.revComp(top), fit: 'annotated' });
    }
    return [...found.values()].sort((a, b) => a.start - b.start);
  },

  async pcr() {
    const doc = this.doc();
    if (!doc) return;
    modal({
      title: 'Simulate PCR',
      wide: true,
      build: (body) => {
        // The primers already on the sequence: a click puts one in the forward or reverse box.
        const onSeq = el('div', { class: 'pcr-primers' }, el('span', { class: 'spin' }));
        const use = (p) => {
          const box = document.getElementById(p.strand === 1 ? 'pcrF' : 'pcrR');
          box.value = p.sequence;
          box.title = p.name;
          toast(`${p.name} as the ${p.strand === 1 ? 'forward' : 'reverse'} primer`, 'success', 1500);
        };
        this.primersOnSequence(doc).then((found) => {
          if (!found.length) {
            onSeq.replaceChildren(el('p', { class: 'hint' }, 'No primers on this sequence: annotate primer_bind features, '
              + (Stocks.enabled() ? 'or none of the lab\'s primers in Lab Stocks bind it. ' : '') + 'Or paste primers below.'));
            return;
          }
          onSeq.replaceChildren(
            el('p', { class: 'hint' }, 'Primers on this sequence', Stocks.enabled() ? ' (annotated, and the lab\'s from Lab Stocks that bind)' : ' (annotated)',
              ': click one to use it.'),
            el('div', { class: 'pcr-primer-list' }, el('table', {},
              el('thead', {}, el('tr', {}, ['', 'Primer', 'At', 'nt', 'Fit', ''].map((h) => el('th', {}, h)))),
              el('tbody', {}, found.map((p) => el('tr', { class: 'clickable', title: p.sequence, onclick: () => use(p) },
                el('td', {}, p.strand === 1 ? '→' : '←'),
                el('td', {}, p.code ? el('a', { href: Stocks.link(p.code), target: '_blank', rel: 'noopener', onclick: (e) => e.stopPropagation() }, p.code) : null,
                  p.code ? ` ${p.name.slice(p.code.length + 1)}` : p.name),
                el('td', {}, `${fmt(p.start + 1)}–${fmt(p.end)}`), el('td', {}, p.sequence.length), el('td', {}, p.fit),
                el('td', {}, el('button', { class: 'btn btn-sm btn-secondary', onclick: (e) => { e.stopPropagation(); use(p); } },
                  p.strand === 1 ? 'Use as forward' : 'Use as reverse'))))))));
        });
        body.append(
          onSeq,
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
