/*
 * My sequences: one list of the lab's saved sequences (and, read-only, the
 * rest of the chair group's) together with the shared MoClo library, filtered
 * and sorted here. A MoClo record already opened in the editor shows once, as
 * the lab's linked copy.
 */

// MoClo's part types (dnakit/goldengate.py PART_TYPES), as people say them,
// in the order a transcription unit reads; then whole records.
const TYPE_NAMES = {
  NonCodingPromoter: 'Promoter',
  Coding: 'CDS',
  NonCodingTerminator: 'Terminator',
  NonCodingIntron: 'Intron',
  NonCodingOther: 'Other part',
  ExpressionCassette: 'Expression cassette',
  backbone: 'Backbone',
  plasmid: 'Assembled plasmid',
};
const TYPE_ORDER = Object.keys(TYPE_NAMES);
const PAGE = 100;

const Library = {
  ours: [],          // the editor's saved sequences
  moclo: [],         // MoClo parts, backbones and assembled plasmids
  mocloOn: false,
  selected: new Set(),
  shown: PAGE,

  async init() {
    const $ = (id) => document.getElementById(id);
    $('search').addEventListener('input', () => this.debouncedLoad());
    for (const id of ['source', 'partType', 'sort', 'chkMine', 'chkLab', 'chkGG']) {
      $(id).addEventListener('change', () => { this.shown = PAGE; this.render(); });
    }
    $('uploadInput').addEventListener('change', (e) => this.upload(e.target.files));
    $('btnBundle').addEventListener('click', () => this.downloadSelected());
    $('btnMore').addEventListener('click', () => { this.shown += PAGE; this.render(); });
    await this.load();
  },

  debounce(fn, ms = 250) {
    let t;
    return (...args) => { clearTimeout(t); t = setTimeout(() => fn.apply(this, args), ms); };
  },

  async load() {
    const search = document.getElementById('search').value.trim();
    this.shown = PAGE;
    await Promise.all([this.loadOurs(search), this.loadMoclo(search)]);
    this.render();
  },

  async loadOurs(search) {
    try {
      this.ours = (await API.get(`/api/sequences${search ? `?search=${encodeURIComponent(search)}` : ''}`)).sequences;
    } catch (err) {
      this.ours = [];
      toast(err.message, 'error');
    }
  },

  async loadMoclo(search) {
    const badge = document.getElementById('mocloStatus');
    try {
      const status = await API.get('/api/moclo/status');
      this.mocloOn = !!(status.available.parts || status.available.plasmids);
      badge.textContent = this.mocloOn ? 'MoClo: connected' : 'MoClo: not mounted';
      badge.className = `badge ${this.mocloOn ? 'badge-gg' : ''}`;
      badge.title = this.mocloOn ? 'The shared MoClo Library Tool database is listed here too'
        : 'The shared MoClo databases are not mounted on this server, so only the lab’s sequences are listed';
      if (!this.mocloOn) { this.moclo = []; return; }
      const [{ parts }, { plasmids }] = await Promise.all([
        status.available.parts ? API.get(`/api/moclo/parts?search=${encodeURIComponent(search)}`)
          : Promise.resolve({ parts: [] }),
        status.available.plasmids ? API.get('/api/moclo/plasmids') : Promise.resolve({ plasmids: [] }),
      ]);
      // Plasmids are not searched on the server; the same words narrow them here.
      const words = search.toLowerCase();
      this.moclo = [
        ...parts.map((p) => ({ ...p, kind: 'part' })),
        ...plasmids.filter((p) => !words || p.name.toLowerCase().includes(words)),
      ];
    } catch (err) {
      this.moclo = [];
      badge.textContent = 'MoClo: error';
      toast(`MoClo library: ${err.message}`, 'error');
    }
  },

  /** Both lists as one, each row knowing its part type; a MoClo record with a linked copy here shows once. */
  rows() {
    const byLink = new Map(this.moclo.map((m) => [`${m.kind}:${m.id}`, m]));
    const linked = new Set();
    const ours = this.ours.map((s) => {
      const m = s.moclo_link && byLink.get(s.moclo_link);
      if (m) linked.add(s.moclo_link);
      return { ...s, source: 'ours', type: m ? (m.kind === 'part' ? m.part_type : m.kind) : null };
    });
    const moclo = this.moclo.filter((m) => !linked.has(`${m.kind}:${m.id}`)).map((m) => ({
      ...m, source: 'moclo', type: m.kind === 'part' ? m.part_type : m.kind,
      updated_at: m.added || null, golden_gate: m.kind === 'part',
    }));
    return [...ours, ...moclo];
  },

  filtered() {
    const $ = (id) => document.getElementById(id);
    const source = $('source').value;
    const type = $('partType').value;
    const mine = $('chkMine').checked;
    const lab = $('chkLab').checked;
    const gg = $('chkGG').checked;
    const list = this.rows().filter((r) => (!source || r.source === source)
      && (!type || (type === 'none' ? !r.type : r.type === type))
      && (!mine || r.mine) && (!lab || r.my_lab)
      && (!gg || r.golden_gate));
    const rank = (r) => (r.type ? TYPE_ORDER.indexOf(r.type) : TYPE_ORDER.length);
    const byName = (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
    const compare = {
      name: byName,
      type: (a, b) => rank(a) - rank(b) || byName(a, b),
      length: (a, b) => (b.length || 0) - (a.length || 0) || byName(a, b),
      updated: (a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')) || byName(a, b),
    }[$('sort').value];
    return list.sort(compare);
  },

  render() {
    const rows = document.getElementById('rows');
    const all = this.rows().length;
    const list = this.filtered();
    document.getElementById('libraryCount').textContent = all
      ? `${fmt(list.length)} of ${fmt(all)} shown` + (list.length > this.shown ? `, the first ${fmt(this.shown)} listed` : '')
      : '';
    const more = document.getElementById('btnMore');
    more.hidden = list.length <= this.shown;
    more.textContent = `Show ${fmt(Math.min(PAGE, list.length - this.shown))} more`;
    if (!list.length) {
      rows.replaceChildren(el('tr', {}, el('td', { colspan: '8', class: 'empty' }, all
        ? 'Nothing matches these filters.'
        : 'No sequences yet. Import a file above, or open the editor and save one.')));
      return;
    }
    rows.replaceChildren(...list.slice(0, this.shown).map((r) => (r.source === 'ours' ? this.ourRow(r) : this.mocloRow(r))));
  },

  typeCell(r) {
    return el('td', {},
      r.type ? el('span', { class: 'badge badge-moclo', text: TYPE_NAMES[r.type] || r.type,
                            title: r.source === 'moclo' ? 'In the MoClo library' : 'Linked to its MoClo record' }) : null,
      r.source === 'ours' && r.golden_gate ? el('span', { class: 'badge badge-gg', text: 'Golden Gate' }) : null,
      r.source === 'ours' && r.moclo_part_id && !r.type ? el('span', { class: 'badge badge-moclo', text: 'in MoClo' }) : null,
      r.source === 'moclo' && r.overhang_5prime
        ? el('div', { class: 'item-meta mono', text: `${r.overhang_5prime}…${r.overhang_3prime}` }) : null);
  },

  ourRow(s) {
    return el('tr', {},
      el('td', {}, el('input', {
        type: 'checkbox', checked: this.selected.has(s.id), 'aria-label': `Select ${s.name}`,
        onchange: (e) => { e.target.checked ? this.selected.add(s.id) : this.selected.delete(s.id); },
      })),
      el('td', {}, el('a', { href: url(`/editor?open=${s.id}`), text: s.name }),
        s.description ? el('div', { class: 'item-meta', text: s.description }) : null),
      this.typeCell(s),
      // Length and topology in one column, so the table fits without scrolling sideways.
      el('td', { class: 'num nowrap' }, `${fmt(s.length)} bp `,
        el('span', { class: `badge ${s.circular ? 'badge-circular' : ''}`, text: s.circular ? 'circular' : 'linear' })),
      el('td', {},
        // Either opens the plasmid's reads and alignments.
        s.confirmed
          ? el('a', {
              class: 'badge badge-confirmed badge-link', href: url(`/sequencing?sequence=${s.id}`),
              title: `Confirmed and sequenced${s.glycerol_stock ? ` · glycerol stock ${s.glycerol_stock}` : ''}`
                + `${s.confirmed_clone ? ` · clone ${s.confirmed_clone}` : ''} · click to see the reads`,
            }, '✓ sequenced')
          : el('a', {
              class: 'badge badge-unsequenced badge-link', href: url(`/sequencing?sequence=${s.id}`),
              title: 'Not confirmed by sequencing yet: open the Sequencing page to add or judge reads',
            }, 'not sequenced'),
        s.read_count
          ? el('a', { class: 'item-meta', href: url(`/sequencing?sequence=${s.id}`), title: 'View the sequencing alignments' },
              ` ${s.read_count} read${s.read_count === 1 ? '' : 's'}`,
              s.reads_bad ? el('span', { class: 'verdict-bad', text: ` ✗${s.reads_bad}` }) : null,
              s.reads_ok ? el('span', { class: 'verdict-ok', text: ` ✓${s.reads_ok}` }) : null)
          : null),
      el('td', { class: 'item-meta', text: s.owner || '' }),
      el('td', { class: 'item-meta nowrap', text: localTime(s.updated_at) }),
      el('td', { class: 'nowrap row-actions' },
        el('button', { class: 'tool-btn', title: 'Download GenBank (.gb)',
          onclick: () => downloadFrom(`/api/sequences/${s.id}/export/genbank`, `${s.name}.gb`).catch((e) => toast(e.message, 'error')) }, '⤓ gb'),
        el('button', { class: 'tool-btn', title: 'Download SnapGene (.dna)',
          onclick: () => downloadFrom(`/api/sequences/${s.id}/export/snapgene`, `${s.name}.dna`).catch((e) => toast(e.message, 'error')) }, '⤓ dna'),
        // Its uploader, their lab lead or lab admin, and administrators delete it.
        s.can_delete
          ? el('button', { class: 'tool-btn', title: 'Delete', onclick: () => this.remove(s) }, glyph('trash'))
          : null));
  },

  mocloRow(m) {
    const open = 'Open in the editor: a linked copy is saved with the lab’s sequences';
    return el('tr', { class: 'moclo-row' },
      el('td', {}),
      el('td', {}, el('a', { href: '#', text: m.name, title: open,
                             onclick: (e) => { e.preventDefault(); this.importMoclo(m); } }),
        m.description ? el('div', { class: 'item-meta', text: m.description }) : null),
      this.typeCell(m),
      el('td', { class: 'num nowrap', text: `${fmt(m.length)} bp` }),
      el('td', { class: 'item-meta', text: 'MoClo library' }),
      el('td', { class: 'item-meta', text: m.owner === 'system' ? 'toolkit' : (m.owner || m.lab_source || '') }),
      el('td', { class: 'item-meta nowrap', text: m.added ? localTime(m.added) : '' }),
      el('td', { class: 'nowrap row-actions' },
        el('button', { class: 'tool-btn', title: open, onclick: () => this.importMoclo(m) }, '→ open')));
  },

  async remove(s) {
    if (!await confirmDialog('Delete sequence',
      `Delete “${s.name}”? Its sequencing reads are deleted too. Parts already contributed to the MoClo library are not affected.`)) return;
    try {
      await API.del(`/api/sequences/${s.id}`);
      toast('Deleted', 'success');
      this.selected.delete(s.id);
      this.load();
    } catch (err) {
      toast(err.message, 'error');
    }
  },

  async downloadSelected() {
    if (!this.selected.size) { toast('Tick the sequences to download', 'error'); return; }
    try {
      await downloadFrom('/api/sequences/export/bundle', 'sequences.zip', { ids: [...this.selected] });
    } catch (err) {
      toast(err.message, 'error');
    }
  },

  async upload(files) {
    if (!files?.length) return;
    const status = document.getElementById('uploadStatus');
    status.replaceChildren(el('span', { class: 'spin' }));
    const form = new FormData();
    for (const f of files) form.append('file', f);
    try {
      const { documents, errors } = await API.post('/api/sequences/parse', form);
      let saved = 0;
      for (const doc of documents) {
        await API.post('/api/sequences', { document: doc, origin: doc.origin });
        saved++;
      }
      status.replaceChildren(el('div', { class: 'alert alert-success' },
        `Imported ${saved} sequence${saved === 1 ? '' : 's'}.`));
      for (const e of errors || []) toast(`${e.filename}: ${e.error}`, 'error', 7000);
      this.load();
    } catch (err) {
      status.replaceChildren(el('div', { class: 'alert alert-error', text: err.message }));
    }
    document.getElementById('uploadInput').value = '';
  },

  async importMoclo(item) {
    try {
      const res = await API.post('/api/moclo/import', { kind: item.kind, id: item.id });
      toast(`“${item.name}” opened; a linked copy is saved with the lab’s sequences`, 'success');
      window.open(url(`/editor?open=${res.sequence.id}`), '_self');
    } catch (err) {
      toast(err.message, 'error');
    }
  },
};

Library.debouncedLoad = Library.debounce(Library.load);
document.addEventListener('DOMContentLoaded', () => Library.init());
