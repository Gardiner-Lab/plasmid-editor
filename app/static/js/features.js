/* Feature library page. */

const Features = {
  builtin: [],
  custom: [],

  async init() {
    document.getElementById('fType').replaceChildren(...FEATURE_TYPES.map((t) =>
      el('option', { value: t, text: t, selected: t === 'promoter' })));
    document.getElementById('fType').addEventListener('change', (e) => {
      document.getElementById('fColor').value = FEATURE_COLORS[e.target.value] || '#94a3b8';
    });
    document.getElementById('search').addEventListener('input', () => this.render());
    document.getElementById('btnAdd').addEventListener('click', () => this.add());
    document.getElementById('btnExport').addEventListener('click', () =>
      downloadFrom('/api/library/export', 'feature_library.txt').catch((e) => toast(e.message, 'error')));
    document.getElementById('libInput').addEventListener('change', (e) => this.importFile(e.target.files[0]));
    await this.load();
  },

  async load() {
    try {
      const { builtin, custom } = await API.get('/api/library');
      this.builtin = builtin;
      this.custom = custom;
      this.render();
    } catch (err) {
      toast(err.message, 'error');
    }
  },

  render() {
    const q = document.getElementById('search').value.trim().toLowerCase();
    const items = [
      ...this.custom.map((e) => ({ ...e, source: 'lab' })),
      ...this.builtin.map((e) => ({ ...e, source: 'built-in' })),
    ].filter((e) => !q || e.name.toLowerCase().includes(q) || e.sequence.toLowerCase().includes(q));

    const rows = document.getElementById('rows');
    if (!items.length) {
      rows.replaceChildren(el('tr', {}, el('td', { colspan: '6', class: 'empty' }, 'Nothing matches.')));
      return;
    }
    rows.replaceChildren(...items.map((e) => el('tr', {},
      el('td', {},
        el('span', { style: `display:inline-block;width:.6rem;height:.6rem;border-radius:2px;margin-right:.4rem;background:${e.color || featureColor(e)}` }),
        e.name),
      el('td', { text: e.type }),
      el('td', { class: 'num', text: fmt(e.sequence.length) }),
      el('td', { class: 'mono', style: 'font-size:.7rem;max-width:18rem;overflow:hidden;text-overflow:ellipsis',
        text: e.sequence.length > 48 ? `${e.sequence.slice(0, 45)}…` : e.sequence }),
      el('td', {}, el('span', { class: `badge ${e.source === 'lab' ? 'badge-gg' : ''}`, text: e.source })),
      el('td', {}, e.source === 'lab'
        ? el('button', { class: 'tool-btn', title: 'Remove', onclick: () => this.remove(e) }, glyph('trash'))
        : null))));
  },

  async add() {
    const name = document.getElementById('fName').value.trim();
    const sequence = DNA.clean(document.getElementById('fSeq').value).toUpperCase();
    const status = document.getElementById('addStatus');
    if (!name || sequence.length < 6) {
      status.replaceChildren(el('div', { class: 'alert alert-error' },
        'A name and at least 6 bases are required.'));
      return;
    }
    try {
      await API.post('/api/library', {
        entries: [{ name, sequence, type: document.getElementById('fType').value,
                    color: document.getElementById('fColor').value }],
      });
      status.replaceChildren(el('div', { class: 'alert alert-success' }, `“${name}” added.`));
      document.getElementById('fName').value = '';
      document.getElementById('fSeq').value = '';
      this.load();
    } catch (err) {
      status.replaceChildren(el('div', { class: 'alert alert-error', text: err.message }));
    }
  },

  async remove(entry) {
    if (!await confirmDialog('Remove element', `Remove “${entry.name}” from the lab library?`, 'Remove')) return;
    try {
      await API.del(`/api/library/${entry.id}`);
      this.load();
    } catch (err) {
      toast(err.message, 'error');
    }
  },

  async importFile(file) {
    if (!file) return;
    const form = new FormData();
    form.append('file', file);
    try {
      const res = await API.post('/api/library/import', form);
      toast(`Imported ${res.added} of ${res.parsed} entries`, 'success');
      this.load();
    } catch (err) {
      toast(err.message, 'error');
    }
    document.getElementById('libInput').value = '';
  },
};

document.addEventListener('DOMContentLoaded', () => Features.init());
