/* Sequence library page: the lab's saved sequences and the shared MoClo library. */

const Library = {
  sequences: [],
  selected: new Set(),

  async init() {
    document.getElementById('search').addEventListener('input', () => this.debouncedLoad());
    document.getElementById('chkMine').addEventListener('change', () => this.load());
    document.getElementById('chkGG').addEventListener('change', () => this.load());
    document.getElementById('mocloSearch').addEventListener('input', () => this.debouncedMoclo());
    document.getElementById('uploadInput').addEventListener('change', (e) => this.upload(e.target.files));
    document.getElementById('btnBundle').addEventListener('click', () => this.downloadSelected());
    await Promise.all([this.load(), this.loadMoclo()]);
  },

  debounce(fn, ms = 250) {
    let t;
    return (...args) => { clearTimeout(t); t = setTimeout(() => fn.apply(this, args), ms); };
  },

  async load() {
    const params = new URLSearchParams();
    const search = document.getElementById('search').value.trim();
    if (search) params.set('search', search);
    if (document.getElementById('chkMine').checked) params.set('mine', 'true');
    if (document.getElementById('chkGG').checked) params.set('golden_gate', 'true');
    try {
      const { sequences } = await API.get(`/api/sequences?${params}`);
      this.sequences = sequences;
      this.render();
    } catch (err) {
      toast(err.message, 'error');
    }
  },

  render() {
    const rows = document.getElementById('rows');
    if (!this.sequences.length) {
      rows.replaceChildren(el('tr', {}, el('td', { colspan: '8', class: 'empty' },
        'No sequences yet. Import a file, or open the editor and save one.')));
      return;
    }
    rows.replaceChildren(...this.sequences.map((s) => el('tr', {},
      el('td', {}, el('input', {
        type: 'checkbox',
        checked: this.selected.has(s.id),
        onchange: (e) => { e.target.checked ? this.selected.add(s.id) : this.selected.delete(s.id); },
      })),
      el('td', {}, el('a', { href: `/editor?open=${s.id}`, text: s.name }),
        s.description ? el('div', { class: 'item-meta', text: s.description }) : null),
      el('td', { class: 'num', text: fmt(s.length) }),
      el('td', {}, el('span', { class: `badge ${s.circular ? 'badge-circular' : ''}`,
        text: s.circular ? 'circular' : 'linear' })),
      el('td', { class: 'num', text: s.read_count ? String(s.read_count) : '—' }),
      el('td', {},
        s.golden_gate ? el('span', { class: 'badge badge-gg', text: 'Golden Gate' }) : null,
        s.moclo_part_id ? el('span', { class: 'badge badge-moclo', text: 'in MoClo' }) : null,
        !s.shared ? el('span', { class: 'badge', text: 'private' }) : null),
      el('td', { class: 'item-meta nowrap', text: (s.updated_at || '').slice(0, 16) }),
      el('td', { class: 'nowrap' },
        el('button', { class: 'tool-btn', title: 'Download GenBank',
          onclick: () => downloadFrom(`/api/sequences/${s.id}/export/genbank`, `${s.name}.gb`).catch((e) => toast(e.message, 'error')) }, '⤓'),
        el('button', { class: 'tool-btn', title: 'Delete', onclick: () => this.remove(s) }, '🗑')))));
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

  async loadMoclo() {
    const badge = document.getElementById('mocloStatus');
    const list = document.getElementById('mocloList');
    try {
      const status = await API.get('/api/moclo/status');
      const have = status.available.parts || status.available.plasmids;
      badge.textContent = have ? 'connected' : 'not mounted';
      badge.className = `badge ${have ? 'badge-gg' : ''}`;
      if (!have) {
        list.replaceChildren(el('li', { class: 'empty' },
          'The shared MoClo databases are not mounted on this server. Mount the MoClo data volume to browse its parts here.'));
        return;
      }
      const search = document.getElementById('mocloSearch').value.trim();
      const [{ parts }, plasmidsRes] = await Promise.all([
        API.get(`/api/moclo/parts?search=${encodeURIComponent(search)}`),
        status.available.plasmids ? API.get('/api/moclo/plasmids') : Promise.resolve({ plasmids: [] }),
      ]);
      const items = [
        ...parts.map((p) => ({ ...p, kind: 'part' })),
        ...plasmidsRes.plasmids,
      ];
      if (!items.length) {
        list.replaceChildren(el('li', { class: 'empty' }, 'Nothing found in the MoClo databases.'));
        return;
      }
      list.replaceChildren(...items.slice(0, 300).map((item) => el('li', { class: 'item' },
        el('span', { class: 'item-name' },
          item.name,
          el('span', { class: 'item-meta' },
            ` ${item.kind}${item.part_type ? ` · ${item.part_type}` : ''}`,
            item.overhang_5prime ? ` · ${item.overhang_5prime}…${item.overhang_3prime}` : '')),
        el('span', { class: 'item-meta nowrap' },
          `${fmt(item.length)} bp `,
          el('button', {
            class: 'tool-btn', title: 'Copy into the editor library',
            onclick: () => this.importMoclo(item),
          }, '→ import')))));
    } catch (err) {
      // Report in the panel when it exists, but never let the error handler
      // itself throw and hide the original failure.
      if (badge) badge.textContent = 'error';
      if (list) list.replaceChildren(el('li', { class: 'empty', text: err.message }));
      else console.error('MoClo panel failed to load:', err);
      toast(`MoClo library: ${err.message}`, 'error');
    }
  },

  async importMoclo(item) {
    try {
      const res = await API.post('/api/moclo/import', { kind: item.kind, id: item.id });
      toast(`“${item.name}” imported`, 'success');
      this.load();
      window.open(`/editor?open=${res.sequence.id}`, '_self');
    } catch (err) {
      toast(err.message, 'error');
    }
  },
};

Library.debouncedLoad = Library.debounce(Library.load);
Library.debouncedMoclo = Library.debounce(Library.loadMoclo);
document.addEventListener('DOMContentLoaded', () => Library.init());
