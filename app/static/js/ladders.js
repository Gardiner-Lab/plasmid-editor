/*
 * Ladders for the virtual gel: the standard ones, and those people make. A made
 * ladder is used by everyone in its maker's chair group (their own labs among
 * them); its maker, or an administrator, changes or removes it.
 */

const Ladders = {
  list: null,

  async load(force = false) {
    if (!this.list || force) this.list = await API.get('/api/tools/ladders');
    return this.list;
  },

  remembered() {
    try { return localStorage.getItem('gelLadder'); } catch { return null; }
  },

  remember(id) {
    try { localStorage.setItem('gelLadder', id); } catch { /* not kept: fine */ }
  },

  /** Fill a select with every ladder this person may use, keeping (or restoring) the choice. */
  async fill(select) {
    const keep = select.value || this.remembered() || 'standard:1 kb ladder';
    const { standard, made } = await this.load(true);
    select.replaceChildren(
      el('optgroup', { label: 'Standard' }, standard.map((l) => el('option', { value: l.id, text: l.name }))),
      made.length ? el('optgroup', { label: 'Made in your chair group' },
        made.map((l) => el('option', { value: l.id, text: `${l.name} · ${l.created_by || ''}` }))) : null);
    select.value = [...select.options].some((o) => o.value === keep) ? keep : 'standard:1 kb ladder';
  },

  /** A ladder's bands as they are typed: largest first, a * after a reference band. */
  bandsText: (bands) => bands.map((b) => `${b.size}${b.strong ? '*' : ''}`).join(', '),

  /** The bands typed so far, read as the server will (for the preview; the server checks them on saving). */
  parse(text) {
    const found = new Map();
    for (const token of String(text).split(/[,;\s]+(?![kK][bB])/)) {
      const m = /^(\d+(?:\.\d+)?)\s*(kb|bp)?\s*(\*)?$/i.exec(token.trim());
      if (!m) continue;
      const size = Math.round(parseFloat(m[1]) * ((m[2] || '').toLowerCase() === 'kb' ? 1000 : 1));
      if (size >= 10 && size <= 100000) found.set(size, found.get(size) || !!m[3]);
    }
    return [...found].sort((a, b) => b[0] - a[0]).map(([size, strong]) => ({ size, strong, count: 1 }));
  },

  /**
   * The chair group's ladders: each with its bands and maker, to change or remove
   * one's own; and a form for a new one, with a preview lane as it is typed.
   * onChange() is told after anything is saved or removed.
   */
  async manage(onChange) {
    let editing = null;          // the ladder being changed, or null for a new one
    modal({
      title: 'Ladders',
      wide: true,
      build: (body) => {
        const list = el('div');
        const name = el('input', { type: 'text', id: 'ladderName', maxlength: '60', placeholder: 'e.g. GeneRuler 1 kb Plus (our lot)' });
        const bands = el('textarea', { id: 'ladderBands', rows: '3', class: 'mono',
          placeholder: '20000, 10000, 7000, 5000, 4000, 3000*, 2000, 1500, 1000*, 700, 500, 400, 300, 200, 75' });
        const description = el('input', { type: 'text', id: 'ladderDescription', maxlength: '300', placeholder: 'Where it is from, its lot… (optional)' });
        const preview = el('div', { class: 'ladder-preview' });
        const heading = el('h4', { class: 'ladder-form-title' }, 'New ladder');
        const save = el('button', { class: 'btn btn-sm', type: 'button' }, 'Save ladder');
        const cancel = el('button', { class: 'btn btn-sm btn-secondary', type: 'button', hidden: true }, 'Cancel changes');

        const showPreview = () => {
          const parsed = this.parse(bands.value);
          preview.replaceChildren(parsed.length >= 2
            ? Tools.gelView({ ladder: { label: name.value || 'New ladder', bands: parsed }, lanes: [] })
            : el('p', { class: 'hint' }, 'Type at least two band sizes to see the ladder.'));
        };
        const startNew = () => {
          editing = null;
          heading.textContent = 'New ladder';
          save.textContent = 'Save ladder';
          cancel.hidden = true;
          name.value = '';
          bands.value = '';
          description.value = '';
          showPreview();
        };
        const draw = async () => {
          const { made } = await this.load(true);
          list.replaceChildren(made.length
            ? el('div', { class: 'table-scroll' }, el('table', {},
              el('thead', {}, el('tr', {}, ['Ladder', 'Bands (bp)', 'Made by', ''].map((h) => el('th', {}, h)))),
              el('tbody', {}, made.map((l) => el('tr', {},
                el('td', {}, el('b', { text: l.name }), l.description ? el('div', { class: 'hint', text: l.description }) : null),
                el('td', { class: 'mono ladder-bands', text: this.bandsText(l.bands) }),
                el('td', { class: 'nowrap', text: l.created_by || '' }),
                el('td', { class: 'nowrap' }, l.can_change ? [
                  el('button', { class: 'btn btn-sm btn-secondary', type: 'button', onclick: () => {
                    editing = l;
                    heading.textContent = `Change “${l.name}”`;
                    save.textContent = 'Save changes';
                    cancel.hidden = false;
                    name.value = l.name;
                    bands.value = this.bandsText(l.bands);
                    description.value = l.description || '';
                    showPreview();
                    name.focus();
                  } }, 'Change'),
                  ' ',
                  el('button', { class: 'btn btn-sm btn-secondary', type: 'button', onclick: async () => {
                    if (!await confirmDialog('Remove ladder', `Remove “${l.name}” for everyone in your chair group?`, 'Remove')) return;
                    try {
                      await API.del(`/api/tools/ladders/${l.id}`);
                      if (editing?.id === l.id) startNew();
                      await draw();
                      onChange?.();
                      toast(`${l.name} removed`, 'success');
                    } catch (err) { toast(err.message, 'error'); }
                  } }, 'Remove')] : el('span', { class: 'hint' }, 'theirs to change')))))))
            : el('p', { class: 'hint' }, 'No ladders made in your chair group yet.'));
        };

        save.addEventListener('click', async () => {
          const payload = { name: name.value, bands: bands.value, description: description.value };
          try {
            const { ladder } = editing
              ? await API.put(`/api/tools/ladders/${editing.id}`, payload)
              : await API.post('/api/tools/ladders', payload);
            toast(`${ladder.name} saved: everyone in your chair group can use it`, 'success', 5000);
            this.remember(ladder.id);
            startNew();
            await draw();
            onChange?.(ladder);
          } catch (err) { toast(err.message, 'error'); }
        });
        cancel.addEventListener('click', startNew);
        for (const field of [name, bands]) field.addEventListener('input', showPreview);

        body.append(
          el('p', { class: 'hint' }, 'Ladders made here are used by everyone in your chair group, beside the standard ones. ',
            'Only whoever made one (or an administrator) changes or removes it.'),
          list,
          el('div', { class: 'ladder-form' },
            el('div', {},
              heading,
              el('div', { class: 'field' }, el('label', { for: 'ladderName' }, 'Name'), name),
              el('div', { class: 'field' }, el('label', { for: 'ladderBands' }, 'Band sizes (bp)'), bands,
                el('span', { class: 'hint' }, 'Separated by commas or spaces; "1.5 kb" works too. A * after a size marks a brighter reference band.')),
              el('div', { class: 'field' }, el('label', { for: 'ladderDescription' }, 'Note'), description),
              el('div', { class: 'btn-group' }, save, cancel)),
            preview));
        startNew();
        draw();
      },
      buttons: [{ label: 'Close', kind: 'secondary' }],
    });
  },
};
