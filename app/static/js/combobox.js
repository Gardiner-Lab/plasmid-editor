/*
 * Combobox - a searchable picker for lists too long to scroll.
 *
 * Results are ranked by relevance to what is typed and then by date, newest
 * first (see rankByRelevance). Works from the keyboard: type to filter, arrows
 * to move, Enter to choose, Escape to close.
 */

class Combobox {
  /**
   * @param {HTMLElement} container empty element to build into
   * @param {object} opts
   *   items        array of objects to choose from
   *   placeholder  input placeholder
   *   fields       properties to search, most important first
   *   render       (item, query) => Node for one row
   *   label        (item) => string shown in the input once chosen
   *   onSelect     (item) => void
   *   emptyText    shown when nothing matches
   *   limit        most rows to draw at once
   *   pinned       (item) => a place (0, 1, ...) for items that come first, in
   *                that order, before the ranked rest; -1 for any other item
   */
  constructor(container, opts = {}) {
    this.opts = {
      placeholder: 'Search…', fields: ['name'], dateField: 'created_at',
      emptyText: 'Nothing matches.', limit: 60,
      label: (item) => item.name,
      render: (item) => el('div', { class: 'combo-name', text: item.name }),
      ...opts,
    };
    this.items = opts.items || [];
    this.filtered = [];
    this.active = -1;
    this.selected = null;

    this.input = el('input', {
      type: 'search', class: 'combo-input', placeholder: this.opts.placeholder,
      autocomplete: 'off', role: 'combobox', 'aria-expanded': 'false', 'aria-autocomplete': 'list',
    });
    this.list = el('div', { class: 'combo-list', role: 'listbox', hidden: true });
    this.count = el('div', { class: 'combo-count' });

    container.classList.add('combo');
    container.replaceChildren(this.input, this.count, this.list);

    this.input.addEventListener('input', () => this.refresh());
    this.input.addEventListener('focus', () => this.refresh());
    this.input.addEventListener('keydown', (e) => this.onKey(e));
    document.addEventListener('mousedown', (e) => {
      if (!container.contains(e.target)) this.close();
    });
  }

  setItems(items) {
    this.items = items || [];
    if (!this.list.hidden) this.refresh();
  }

  get query() { return this.input.value.trim(); }

  refresh() {
    this.filtered = rankByRelevance(this.items, this.query, {
      fields: this.opts.fields, dateField: this.opts.dateField,
    });
    const place = this.opts.pinned;
    if (place) {
      // Pinned items that match come first, in their own order; the rest keep their ranking.
      const first = this.filtered.filter((item) => place(item) >= 0).sort((a, b) => place(a) - place(b));
      this.pinnedCount = first.length;
      this.filtered = [...first, ...this.filtered.filter((item) => place(item) < 0)];
    } else this.pinnedCount = 0;
    this.active = this.filtered.length ? 0 : -1;
    this.draw();
    this.open();
  }

  draw() {
    const shown = this.filtered.slice(0, this.opts.limit);
    if (!shown.length) {
      this.list.replaceChildren(el('div', { class: 'combo-empty', text: this.opts.emptyText }));
    } else {
      this.list.replaceChildren(...shown.map((item, i) => el('div', {
        class: `combo-item ${i === this.active ? 'active' : ''}${i === this.pinnedCount - 1 && shown.length > this.pinnedCount ? ' combo-pinned-last' : ''}`,
        role: 'option',
        'aria-selected': i === this.active ? 'true' : 'false',
        onmouseenter: () => { this.active = i; this.markActive(); },
        onmousedown: (e) => { e.preventDefault(); this.choose(item); },
      }, this.opts.render(item, this.query))));
    }
    const total = this.filtered.length;
    this.count.textContent = this.query || total > shown.length
      ? `${total} match${total === 1 ? '' : 'es'}${total > shown.length ? `, showing ${shown.length}` : ''}`
      : '';
  }

  markActive() {
    [...this.list.children].forEach((node, i) => {
      node.classList.toggle('active', i === this.active);
      node.setAttribute('aria-selected', i === this.active ? 'true' : 'false');
    });
    this.list.children[this.active]?.scrollIntoView({ block: 'nearest' });
  }

  move(delta) {
    const shown = Math.min(this.filtered.length, this.opts.limit);
    if (!shown) return;
    this.active = (this.active + delta + shown) % shown;
    this.markActive();
  }

  onKey(e) {
    switch (e.key) {
      case 'ArrowDown': e.preventDefault(); this.list.hidden ? this.refresh() : this.move(1); break;
      case 'ArrowUp': e.preventDefault(); this.move(-1); break;
      case 'Enter':
        if (!this.list.hidden && this.filtered[this.active]) {
          e.preventDefault();
          this.choose(this.filtered[this.active]);
        }
        break;
      case 'Escape':
        if (!this.list.hidden) { e.preventDefault(); this.close(); }
        break;
      default: break;
    }
  }

  choose(item) {
    this.selected = item;
    this.input.value = this.opts.label(item);
    this.close();
    this.opts.onSelect?.(item);
  }

  /** Show a chosen item without firing onSelect, e.g. when restoring state. */
  setSelected(item) {
    this.selected = item;
    this.input.value = item ? this.opts.label(item) : '';
  }

  open() {
    this.list.hidden = false;
    this.input.setAttribute('aria-expanded', 'true');
  }

  close() {
    this.list.hidden = true;
    this.count.textContent = '';
    this.input.setAttribute('aria-expanded', 'false');
  }
}

/** Wrap the matched part of `text` so it stands out in a result row. */
function highlight(text, query) {
  const s = String(text ?? '');
  if (!query) return document.createTextNode(s);
  const at = s.toLowerCase().indexOf(query.toLowerCase().trim());
  if (at < 0) return document.createTextNode(s);
  const end = at + query.trim().length;
  return el('span', {}, s.slice(0, at), el('mark', { text: s.slice(at, end) }), s.slice(end));
}
