/* Shared helpers: API calls, toasts, modals, small DOM utilities. */

/*
 * The app may be mounted under a prefix (e.g. /editor behind the suite proxy).
 * `BASE` comes from the server via <body data-base>, and url() turns an
 * app-absolute path into one that works wherever the app is mounted.
 */
const BASE = (document.body?.dataset.base || '').replace(/\/$/, '');
const url = (path) => (path.startsWith('/') ? BASE + path : path);

/*
 * Lab Stocks, the suite's glycerol stocks and primers, when it is part of the
 * suite (STOCKS_URL); otherwise the features that use it are hidden.
 */
const STOCKS = (document.body?.dataset.stocks || '').replace(/\/$/, '');
// The Lab Notebook, beside the editor in the suite (NOTEBOOK_URL): a virtual digest can go into a
// day's page there. Unset, that button is hidden.
const NOTEBOOK = (document.body?.dataset.notebook || '').replace(/\/$/, '');
const Stocks = {
  enabled: () => !!STOCKS,
  async call(method, path, body) {
    const res = await fetch(`${STOCKS}/api${path}`, {
      method, credentials: 'same-origin',
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let data = {};
    try { data = await res.json(); } catch (e) { /* not JSON */ }
    if (!res.ok) throw new Error(data.error || `Lab Stocks: ${res.status}`);
    return data;
  },
  /** A glycerol stock or primer code (GL-G-0042, GL-O-0007), or null for a number typed by hand. */
  kind(code) {
    const m = /^[A-Z][A-Z0-9]{0,5}-([GO])-\d+$/.exec(String(code || '').trim().toUpperCase());
    return m ? (m[1] === 'G' ? 'glycerol' : 'primer') : null;
  },
  link(code) { return `${STOCKS}/#${this.kind(code)}=${encodeURIComponent(String(code).trim().toUpperCase())}`; },
    /**
     * Another glycerol stock of this plasmid. Either a new one, which Lab Stocks numbers, or one that
     * already has a number - a tube from before the suite, or brought over from eLab - which is then
     * linked to this plasmid so it is listed with the others. Nothing is renumbered either way.
     */
    addDialog(plasmid, onDone) {
      const stocks = this.enabled();
      modal({
        title: 'Add a glycerol stock',
        build: (body) => {
          const choice = (value, label, checked) => el('label', { class: 'checkbox' },
            el('input', { type: 'radio', name: 'addHow', value, checked }), el('span', {}, label));
          body.append(
            el('p', {}, 'A plasmid is usually kept as more than one stock — the cloning strain and the '
              + 'one it was moved into. Record another for ', el('b', { text: plasmid.name }), '.'),
            stocks ? choice('new', "A new glycerol stock in Lab Stocks, with the lab's next number", true) : null,
            stocks ? el('div', { class: 'field-row', id: 'addNew', style: 'margin:.3rem 0 .3rem 1.6rem' },
              el('div', { class: 'field' }, el('label', { for: 'addHost' }, 'Strain'),
                el('input', { type: 'text', id: 'addHost', placeholder: 'e.g. GV3101, DH5α' })),
              el('div', { class: 'field' }, el('label', { for: 'addPlace' }, 'Kept in'),
                el('input', { type: 'text', id: 'addPlace', placeholder: 'e.g. −80 °C / box 7 / A2' }))) : null,
            stocks ? choice('existing', 'A glycerol stock that already has a number', false) : null,
            el('div', { class: 'field', id: 'addExisting', style: stocks ? 'margin-left:1.6rem' : '' },
              el('label', { for: 'addCode' }, 'Glycerol stock number'),
              el('input', { type: 'text', id: 'addCode', placeholder: 'e.g. GL-G-0178, or gGL000179' }),
              el('span', { class: 'hint' },
                'A number Lab Stocks issued is linked to this plasmid. A number from the lab\'s older '
                + 'list, or from a tube, is made into a stock of its own with the next number and that '
                + 'label kept on it.'),
              el('div', { class: 'field-row', style: 'margin-top:.4rem' },
                el('div', { class: 'field' }, el('label', { for: 'addCodeHost' }, 'Strain'),
                  el('input', { type: 'text', id: 'addCodeHost', placeholder: 'e.g. Agrobacterium (GV3101)' })),
                el('div', { class: 'field' }, el('label', { for: 'addCodePlace' }, 'Kept in'),
                  el('input', { type: 'text', id: 'addCodePlace', placeholder: 'e.g. −80 °C / box 7 / A2' }))),
              el('span', { class: 'hint' }, 'Used only if a stock has to be made for that number.')));
          const sync = () => {
            const fresh = !stocks || body.querySelector('input[name=addHow]:checked')?.value === 'new';
            body.querySelector('#addExisting').hidden = fresh;
            if (body.querySelector('#addNew')) body.querySelector('#addNew').hidden = !fresh;
          };
          for (const r of body.querySelectorAll('input[name=addHow]')) r.addEventListener('change', sync);
          sync();
          setTimeout(() => body.querySelector('#addHost:not([hidden]), #addCode')?.focus(), 0);
        },
        buttons: [
          { label: 'Cancel', kind: 'secondary' },
          {
            label: 'Add the stock',
            onClick: async ({ body }) => {
              const fresh = this.enabled()
                && body.querySelector('input[name=addHow]:checked')?.value === 'new';
              if (fresh) {
                const { record } = await this.call('POST', '/glycerol', {
                  plasmid_id: plasmid.id, plasmid_name: plasmid.name, source: 'sequencing',
                  clone: plasmid.confirmed_clone || '',
                  host: body.querySelector('#addHost').value.trim(),
                  location: body.querySelector('#addPlace').value.trim(),
                });
                toast(`Added ${record.code}`, 'success', 4000);
              } else {
                const code = body.querySelector('#addCode').value.trim();
                if (!code) throw new Error('Give the number of the stock to add');
                await this.linkExisting(plasmid, code, {
                  host: body.querySelector('#addCodeHost').value.trim(),
                  location: body.querySelector('#addCodePlace').value.trim(),
                });
              }
              if (onDone) await onDone();
            },
          },
        ],
      });
    },

    /**
     * Link a stock that already has a number to this plasmid, so it is listed with the others. The
     * number named when the plasmid was confirmed is left alone: this adds a stock, it does not
     * replace that one, and nothing is renumbered.
     */
    /**
     * The spellings of a number worth trying: as typed, and with a Lab Stocks code's own padding.
     * The lab's older lists write GL-G-00178 where the code here is GL-G-0178, and a number copied
     * from a tube is as likely to carry a space or lower case.
     */
    spellings(code) {
      const typed = String(code || '').trim().toUpperCase().replace(/\s+/g, '');
      const out = [typed];
      const m = /^([A-Z][A-Z0-9]{0,5})-([GOCAM])-0*(\d+)$/.exec(typed);
      if (m) {
        const padded = `${m[1]}-${m[2]}-${m[3].padStart(4, '0')}`;
        if (!out.includes(padded)) out.push(padded);
      }
      return out;
    },

    /** The stock with this number, whichever way it is spelled, or null if Lab Stocks has none. */
    async find(code) {
      for (const spelling of this.spellings(code)) {
        try {
          const { record } = await this.call('GET', `/glycerol/${encodeURIComponent(spelling)}`);
          if (record) return record;
        } catch (err) { /* not this spelling */ }
      }
      return null;
    },

    async linkExisting(plasmid, code, made = {}) {
      if (!this.enabled()) throw new Error('Lab Stocks is not available here');
      const typed = String(code || '').trim();
      const record = await this.find(typed);
      if (!record) {
        // Not a number Lab Stocks issued: a tube from before the suite, or from the lab's old list.
        // It is made as a stock of its own with the next number, and what was typed is kept as the
        // tube's label - which is how the rest of the lab's old list was brought over.
        const { record: fresh } = await this.call('POST', '/glycerol', {
          plasmid_id: plasmid.id, plasmid_name: plasmid.name,
          host: made.host || '', location: made.location || '',
          notes: `Tube label: ${typed}`,
        });
        toast(`Lab Stocks had no ${typed}, so it is now ${fresh.code}, labelled ${typed}`, 'success', 7000);
        return;
      }
      if (record.plasmid_id && record.plasmid_id !== plasmid.id) {
        throw new Error(`${code} is already the stock of ${record.plasmid_name || 'another plasmid'}`);
      }
      if (record.plasmid_id === plasmid.id) {
        throw new Error(`${code} is already a stock of this plasmid`);
      }
      await this.call('PUT', `/glycerol/${encodeURIComponent(record.code)}`,
        { plasmid_id: plasmid.id, plasmid_name: plasmid.name });
      toast(record.code === typed.toUpperCase()
        ? `${record.code} linked to this plasmid`
        : `${typed} is ${record.code} here; linked to this plasmid`, 'success', 5000);
    },

  /** A stock's number as a link to it in Lab Stocks when it is one of its codes; else just the text. */
  render(code) {
    if (!code) return '—';
    if (!STOCKS || !this.kind(code)) return String(code);
    return el('a', { href: this.link(code), target: '_blank', rel: 'noopener', title: 'Open in Lab Stocks' }, glyph('stocks'), ` ${code}`);
  },
};

const API = {
  async request(method, path, body, opts = {}) {
    path = url(path);
    const init = { method, credentials: 'same-origin', headers: {} };
    if (body instanceof FormData) {
      init.body = body;
    } else if (body !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    const res = await fetch(path, init);
    if (res.status === 401 && !opts.allowAnonymous) {
      // Back to this page once signed in again.
      window.location.href = url('/login') + '?next=' + encodeURIComponent(window.location.pathname);
      throw new Error('Not signed in');
    }
    const type = res.headers.get('content-type') || '';
    if (!type.includes('application/json')) {
      if (!res.ok) throw new Error(`Request failed (${res.status})`);
      return res;
    }
    const data = await res.json();
    if (!res.ok) {
      const err = new Error(data.error || `Request failed (${res.status})`);
      err.status = res.status;
      err.payload = data;        // callers inspect this, e.g. for sync conflicts
      throw err;
    }
    return data;
  },
  get(p, o) { return API.request('GET', p, undefined, o); },
  post(p, b, o) { return API.request('POST', p, b, o); },
  put(p, b, o) { return API.request('PUT', p, b, o); },
  patch(p, b, o) { return API.request('PATCH', p, b, o); },
  del(p, o) { return API.request('DELETE', p, undefined, o); },
};

function toast(message, kind = 'info', ms = 4000) {
  const stack = document.getElementById('toasts');
  if (!stack) return;
  const el = document.createElement('div');
  el.className = `toast toast-${kind}`;
  el.textContent = message;
  stack.appendChild(el);
  setTimeout(() => el.remove(), ms);
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const el = (tag, attrs = {}, ...children) => {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? '' : v);
  }
  // Children may be nested lists (from .map) and numbers as well as nodes and text.
  for (const c of children.flat(Infinity)) {
    if (c === undefined || c === null || c === false) continue;
    node.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
};

/** One of Trellis Tools' small icons (static/trellis/glyphs/), in place of an emoji. */
const glyph = (name) => el('img', { class: 'tt-glyph', alt: '',
  src: `${document.body.dataset.base || ''}/static/trellis/glyphs/${name}.svg` });

/**
 * Copy text to the clipboard; resolves true when it was copied. Browsers give
 * pages the clipboard API only over https (or on localhost), so elsewhere, a
 * suite reached over plain http say, it copies a selected text field with the
 * copy command instead, which still works while handling a click.
 */
async function copyText(text) {
  if (window.isSecureContext && navigator.clipboard) {
    try { await navigator.clipboard.writeText(text); return true; } catch (e) { /* refused: try the other way */ }
  }
  const field = document.createElement('textarea');
  field.value = text;
  field.setAttribute('readonly', '');
  field.style.position = 'fixed';
  field.style.opacity = '0';
  document.body.append(field);
  field.select();
  let copied = false;
  try { copied = document.execCommand('copy'); } catch (e) { copied = false; }
  field.remove();
  return copied;
}

const fmt = (n) => Number(n).toLocaleString('en-US');

/**
 * Show a modal. `build(body, close)` fills the body; buttons is an array of
 * { label, kind, onClick } — onClick may return false to keep the modal open,
 * or a promise.
 */
function modal({ title, build, buttons = [], wide = false }) {
  const body = el('div', { class: 'modal-body' });
  const backdrop = el('div', { class: 'modal-backdrop' });
  const close = () => backdrop.remove();
  const foot = el('div', { class: 'modal-foot' });
  for (const b of buttons) {
    foot.appendChild(el('button', {
      class: `btn ${b.kind === 'secondary' ? 'btn-secondary' : b.kind === 'danger' ? 'btn-danger' : ''}`,
      type: 'button',
      onclick: async (ev) => {
        const btn = ev.currentTarget;
        btn.disabled = true;
        try {
          const keep = await b.onClick?.({ close, body });
          if (keep !== false) close();
        } catch (err) {
          toast(err.message, 'error');
        } finally {
          btn.disabled = false;
        }
      },
    }, b.label));
  }
  const box = el('div', { class: `modal ${wide ? 'modal-wide' : ''}` },
    el('div', { class: 'modal-head' },
      el('div', { class: 'modal-title', text: title }),
      el('button', { class: 'modal-close', type: 'button', onclick: close, title: 'Close' }, '×')),
    body, buttons.length ? foot : null);
  backdrop.appendChild(box);
  backdrop.addEventListener('mousedown', (e) => { if (e.target === backdrop) close(); });
  document.addEventListener('keydown', function onKey(e) {
    if (e.key === 'Escape') { close(); document.removeEventListener('keydown', onKey); }
  });
  document.body.appendChild(backdrop);
  build?.(body, close);
  return { close, body };
}

function confirmDialog(title, message, confirmLabel = 'Delete') {
  return new Promise((resolve) => {
    modal({
      title,
      build: (body) => body.appendChild(el('p', { text: message })),
      buttons: [
        { label: 'Cancel', kind: 'secondary', onClick: () => resolve(false) },
        { label: confirmLabel, kind: 'danger', onClick: () => resolve(true) },
      ],
    });
  });
}

/**
 * The Lab Notebook beside the editor in the suite: a figure made here - a map, a gel, a
 * chromatogram - and what it shows, put into a day's page there (its /api/days/import).
 */
const Notebook = {
  enabled: () => !!NOTEBOOK,

  today() {
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  },

  /**
   * "Add to notebook": asks which day (today unless another is chosen), then puts what
   * make() builds - { section, pictures: [Blob] } - at the end of that day's page. `what`
   * says in the dialog what goes in; onAdded(note) hears which day page it went to. Null when
   * there is no notebook to add to.
   */
  button(what, make, { label = [glyph('notebook'), ' Add to notebook'], className = 'btn btn-sm btn-secondary', onAdded = null } = {}) {
    if (!NOTEBOOK) return null;
    return el('button', {
      class: className, type: 'button', title: "Put this into a day's page of your Lab Notebook",
      onclick: () => this.add(what, make, onAdded),
    }, label);
  },

  add(what, make, onAdded = null) {
    const today = this.today();
    modal({
      title: 'Add to the Lab Notebook',
      build: (body) => body.append(
        el('p', {}, typeof what === 'function' ? what() : what, ' It goes at the end of the day\'s page.'),
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
            const { section, pictures = [] } = await make();
            const note = await this.send(section, pictures, day);
            toast(`Added to ${note.title} in your Lab Notebook`, 'success', 6000);
            onAdded?.(note);
            return true;
          },
        },
      ],
    });
  },

  async send(section, pictures, day) {
    const form = new FormData();
    form.append('section', JSON.stringify(section));
    if (day) form.append('date', day);
    pictures.filter(Boolean).forEach((blob, i) => form.append('picture', blob, `figure-${i + 1}.png`));
    const res = await fetch(`${NOTEBOOK}/api/days/import`, { method: 'POST', credentials: 'same-origin', body: form });
    let data = {};
    try { data = await res.json(); } catch { /* not JSON */ }
    if (!res.ok) throw new Error(data.error || `Lab Notebook: ${res.status}`);
    return data.note;
  },

  /** Where a note is in the notebook. */
  link: (note) => `${NOTEBOOK}/#note=${encodeURIComponent(note.id)}`,

  /** Text made safe to put into a section's HTML. */
  esc: (s) => String(s ?? '').replace(/[&<>"]/g, (ch) => `&#${ch.charCodeAt(0)};`),

  /** A plasmid by name: linked when it is saved, so the day shows on it in the notebook. */
  plasmid(doc) {
    const name = this.esc(doc.name || 'Untitled');
    return doc.id ? `<a data-plasmid="${this.esc(doc.id)}">${name}</a>` : `<b>${name}</b>`;
  },

  /** A section's n-th picture (from 0), as the notebook names it until it is attached. */
  picture: (n, alt) => `<p><img data-attachment="${n === 0 ? 'picture' : `picture-${n + 1}`}" alt="${Notebook.esc(alt)}"></p>`,

  /** A table for a section: columns as [name, kind?, unit?], rows as lists of cells. */
  table(title, columns, rows) {
    return { type: 'table', title, scale: null,
             columns: columns.map(([name, kind = 'text', unit = '']) => ({ name, kind, unit })),
             rows: rows.map((cells) => ({ cells: cells.map((c) => (c === null || c === undefined ? null : String(c))) })) };
  },

  /** A sequence's features as a table: name, type, where, strand and length. */
  features(doc) {
    const n = doc.sequence.length;
    return this.table('Features', [['Name'], ['Type'], ['Start', 'number'], ['End', 'number'], ['Strand'], ['Length', 'number', 'bp']],
      [...(doc.features || [])].sort((a, b) => a.start - b.start).map((f) => [f.name, f.type, f.start + 1, f.end,
        f.strand === -1 ? 'reverse' : f.strand === 1 ? 'forward' : '', f.end > f.start ? f.end - f.start : n - f.start + f.end]));
  },
};

/**
 * An SVG (element or markup) as a PNG Blob, drawn at `scale` times its size so it stays
 * sharp, on a white ground (a picture in a notebook page or a PDF has no page behind it).
 */
function svgToPng(svg, scale = 2) {
  const node = typeof svg === 'string'
    ? new DOMParser().parseFromString(svg, 'image/svg+xml').documentElement : svg.cloneNode(true);
  node.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  if (!node.getAttribute('font-family')) node.setAttribute('font-family', 'system-ui, -apple-system, "Segoe UI", Arial, sans-serif');
  const box = node.viewBox?.baseVal;
  const width = Number.parseFloat(node.getAttribute('width')) || box?.width || 800;
  const height = Number.parseFloat(node.getAttribute('height')) || box?.height || 600;
  node.setAttribute('width', width);
  node.setAttribute('height', height);
  const source = URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(node)], { type: 'image/svg+xml' }));
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(width * scale);
      canvas.height = Math.round(height * scale);
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(source);
      canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('Could not draw the picture'))), 'image/png');
    };
    img.onerror = () => { URL.revokeObjectURL(source); reject(new Error('Could not draw the picture')); };
    img.src = source;
  });
}

/** Trigger a download from an API path (handles the Content-Disposition name). */
async function downloadFrom(path, fallbackName, body) {
  const res = await fetch(url(path), {
    method: body ? 'POST' : 'GET',
    credentials: 'same-origin',
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    let msg = `Download failed (${res.status})`;
    try { msg = (await res.json()).error || msg; } catch { /* not json */ }
    throw new Error(msg);
  }
  const blob = await res.blob();
  const disp = res.headers.get('content-disposition') || '';
  const match = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(disp);
  // Not called "url": that would shadow url() above for the whole function, and
  // its use in the fetch would then throw "Cannot access 'url' before initialization".
  const objectUrl = URL.createObjectURL(blob);
  const a = el('a', { href: objectUrl, download: match ? decodeURIComponent(match[1]) : fallbackName });
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(objectUrl);
}

/* Sequence helpers shared by the pages ----------------------------------- */
const DNA = {
  COMP: { A: 'T', C: 'G', G: 'C', T: 'A', U: 'A', R: 'Y', Y: 'R', K: 'M', M: 'K', S: 'S', W: 'W',
          B: 'V', D: 'H', H: 'D', V: 'B', N: 'N' },
  revComp(seq) {
    let out = '';
    for (let i = seq.length - 1; i >= 0; i--) {
      const c = seq[i];
      const up = c.toUpperCase();
      const comp = DNA.COMP[up] || up;
      out += c === up ? comp : comp.toLowerCase();
    }
    return out;
  },
  complement(seq) {
    return [...seq].map((c) => DNA.COMP[c.toUpperCase()] || c).join('');
  },
  clean(text) {
    return (text || '').replace(/[^ACGTURYKMSWBDHVNacgturykmswbdhvn]/g, '');
  },
  gc(seq) {
    if (!seq) return 0;
    const g = (seq.toUpperCase().match(/[GCS]/g) || []).length;
    return (100 * g) / seq.length;
  },
  /** Length of a feature, handling the wrap through the origin. */
  featLength(f, n) { return f.end > f.start ? f.end - f.start : n - f.start + f.end; },
};

/** A time the server stored (SQLite's UTC "YYYY-MM-DD HH:MM:SS"), in local time. */
function localTime(stamp) {
  if (!stamp) return '';
  const d = new Date(String(stamp).replace(' ', 'T') + (/[zZ]|[+-]\d\d:?\d\d$/.test(stamp) ? '' : 'Z'));
  if (Number.isNaN(d.getTime())) return String(stamp).slice(0, 16);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getDate())}-${pad(d.getMonth() + 1)}-${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const REVISION_KINDS = {
  created: 'Created', imported: 'Imported from MoClo', saved: 'Saved', corrected: 'Corrected to a read',
  restored: 'Rolled back', moclo: 'From MoClo', baseline: 'Earlier version',
};

/**
 * A sequence's history: every saved version, who saved it, how and what
 * changed, newest first, with a way back to any of them for whoever may
 * change the sequence. `onRestored(sequence)` runs after a rollback;
 * `unsaved` warns that edits not yet saved would be replaced.
 */
async function showHistory(sequenceId, { onRestored, unsaved = false } = {}) {
  let data;
  try {
    data = await API.get(`/api/sequences/${sequenceId}/history`);
  } catch (err) {
    toast(err.message, 'error');
    return;
  }
  const { revisions, current, can_restore: canRestore } = data;
  const restore = (r) => modal({
    title: `Roll back to version ${r.number}?`,
    build: (body) => body.append(
      el('p', {}, `The sequence becomes version ${r.number} again: `,
        el('b', { text: r.name }), `, ${fmt(r.length)} bp, ${r.feature_count} features, `
        + `${r.translation_count} translations, as saved${r.changed_by ? ` by ${r.changed_by}` : ''} `
        + `on ${localTime(r.created_at)}.`),
      el('p', { class: 'hint' },
        'The rollback is kept as a new version, so it can be undone here as well. '
        + 'Sequencing reads are aligned again, keeping their verdicts.'),
      ...(unsaved ? [el('div', { class: 'alert alert-warning' },
        'Your unsaved changes to this sequence will be replaced.')] : [])),
    buttons: [
      { label: 'Cancel', kind: 'secondary' },
      {
        label: `Roll back to version ${r.number}`,
        onClick: async () => {
          const res = await API.post(`/api/sequences/${sequenceId}/history/${r.number}/restore`, {});
          toast(`Rolled back to version ${r.number}${res.synced_to_moclo ? ', and MoClo updated' : ''}`,
                'success', 5000);
          if (res.moclo_note) toast(`MoClo was not updated: ${res.moclo_note}`, 'error', 10000);
          document.querySelector('.modal-backdrop')?.remove();   // the history, now out of date
          await onRestored?.(res.sequence);
          return true;
        },
      },
    ],
  });
  modal({
    title: 'History',
    wide: true,
    build: (body) => {
      if (!revisions.length) {
        body.append(el('p', { class: 'hint' }, 'No versions kept yet: the history starts with the next change saved.'));
        return;
      }
      body.append(
        el('p', { class: 'hint' }, 'Every saved version, newest first.'
          + (canRestore ? ' Roll back to any of them; that is kept as a version too.' : '')),
        el('div', { class: 'history-scroll' }, el('table', { class: 'history-table' },
          el('thead', {}, el('tr', {},
            el('th', {}, '#'), el('th', {}, 'When'), el('th', {}, 'Who'),
            el('th', {}, 'Change'), el('th', { class: 'num' }, 'Length'), el('th', {}))),
          el('tbody', {}, ...revisions.map((r) => el('tr', { class: r.number === current ? 'current' : '' },
            el('td', {}, String(r.number)),
            el('td', { class: 'nowrap' }, localTime(r.created_at)),
            el('td', {}, r.changed_by || '—'),
            el('td', {},
              el('div', {}, el('b', {}, REVISION_KINDS[r.kind] || r.kind), r.note ? ` · ${r.note}` : ''),
              r.summary ? el('div', { class: 'hint' }, r.summary) : null),
            el('td', { class: 'num nowrap' }, `${fmt(r.length)} bp`),
            el('td', { class: 'nowrap' }, r.number === current
              ? el('span', { class: 'badge' }, 'current')
              : canRestore
                ? el('button', { class: 'btn btn-sm btn-secondary', type: 'button',
                                 onclick: () => restore(r) }, 'Roll back')
                : null)))))));
    },
    buttons: [{ label: 'Close', kind: 'secondary' }],
  });
}

/**
 * Replace doc.sequence[start:end] with `text`, moving every feature, and every
 * translation, to match.
 *
 * Features are shifted when the edit falls before them, stretched or shortened
 * when it falls inside them, and dropped when the edit removes them entirely.
 * Pure: returns {sequence, features, translations} and does not touch `doc`.
 */
function applyEdit(doc, start, end, text) {
  const seq = doc.sequence;
  const delta = text.length - (end - start);
  // Typing exactly at a feature's edge puts the base outside that feature:
  // a feature's start is pushed right by an insertion at its first base, while
  // its end stays put for an insertion just after its last base. Only text
  // typed strictly inside a feature extends it.
  const shift = (p, isStart) => {
    if (p < start) return p;
    if (p > end) return p + delta;
    if (start === end) return isStart ? p + delta : p;   // caret sits exactly here
    if (p === start) return p;                           // left edge of a replaced range
    if (p === end) return p + delta;                     // right edge
    return start + text.length;                          // strictly inside it
  };
  const move = (items) => {
    const moved = [];
    for (const f of items || []) {
      const g = { ...f, start: shift(f.start, true), end: shift(f.end, false) };
      if (f.segments) g.segments = f.segments.map(([s, e]) => [shift(s, true), shift(e, false)]);
      if (g.start === g.end) continue;   // the edit removed it entirely
      moved.push(g);
    }
    return moved;
  };
  return { sequence: seq.slice(0, start) + text + seq.slice(end),
           features: move(doc.features), translations: move(doc.translations) };
}

/**
 * The codons of a translation: for each, the three positions of its bases in
 * reading order and the amino acid they encode. A reverse-strand translation
 * reads the complement from its end back to its start. A stretch that is not
 * a whole number of codons leaves its last one or two bases untranslated.
 */
function translationCodons(sequence, t) {
  const n = sequence.length;
  const length = t.end > t.start ? t.end - t.start : n - t.start + t.end;
  const at = (p) => ((p % n) + n) % n;
  const codons = [];
  for (let k = 0; k + 3 <= length; k += 3) {
    const positions = t.strand === -1
      ? [at(t.start + length - k - 1), at(t.start + length - k - 2), at(t.start + length - k - 3)]
      : [at(t.start + k), at(t.start + k + 1), at(t.start + k + 2)];
    let codon = positions.map((p) => sequence[p]).join('').toUpperCase();
    if (t.strand === -1) codon = DNA.complement(codon);
    codons.push({ positions, codon, aa: CODONS[codon] ?? 'X' });
  }
  return codons;
}

/** The protein a translation encodes, one letter per amino acid. */
const translationProtein = (sequence, t) => translationCodons(sequence, t).map((c) => c.aa).join('');

/**
 * How well `text` matches `query`, higher being better and 0 meaning no match.
 *
 * The bands are coarse on purpose: an exact name beats a name that starts with
 * the query, which beats a match at the start of a word (so "gfp" finds
 * "p35S-GFP"), which beats a match anywhere, which beats the words of the query
 * appearing separately. Within a band the caller breaks ties, by date.
 */
function matchScore(text, query) {
  if (!query) return 1;
  const t = String(text ?? '').toLowerCase();
  const q = query.toLowerCase().trim();
  if (!t) return 0;
  const at = t.indexOf(q);
  if (t === q) return 100;
  if (at === 0) return 80;
  // Plasmid names conventionally begin with "p", so a match straight after it
  // is effectively at the start: searching "GFP" should find "pGFP" before
  // "p35S-GFP", where GFP is only one element among several.
  if (at === 1 && t.startsWith('p')) return 70;
  // Start of any word, including after the separators plasmid names use.
  if (new RegExp(`[\\s_\\-.:/()\\[\\]]${q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(t)) return 60;
  if (at > 0) return 40;
  const tokens = q.split(/\s+/).filter(Boolean);
  if (tokens.length > 1 && tokens.every((tok) => t.includes(tok))) return 20;
  return 0;
}

/**
 * Rank items by relevance to `query`, then by date (newest first), then name.
 * `fields` names the properties to search, most important first; a later field
 * scores lower so a name match always beats a description match.
 */
function rankByRelevance(items, query, { fields = ['name'], dateField = 'created_at' } = {}) {
  const scored = items.map((item) => {
    let score = 0;
    fields.forEach((field, i) => {
      const s = matchScore(item[field], query);
      if (s) score = Math.max(score, s - i * 10);
    });
    return { item, score };
  });
  const matching = query ? scored.filter((s) => s.score > 0) : scored;
  matching.sort((a, b) => (
    b.score - a.score
    || String(b.item[dateField] ?? '').localeCompare(String(a.item[dateField] ?? ''))
    || String(a.item.name ?? '').localeCompare(String(b.item.name ?? ''))
  ));
  return matching.map((s) => s.item);
}

const CODONS = {
  TTT: 'F', TTC: 'F', TTA: 'L', TTG: 'L', CTT: 'L', CTC: 'L', CTA: 'L', CTG: 'L',
  ATT: 'I', ATC: 'I', ATA: 'I', ATG: 'M', GTT: 'V', GTC: 'V', GTA: 'V', GTG: 'V',
  TCT: 'S', TCC: 'S', TCA: 'S', TCG: 'S', CCT: 'P', CCC: 'P', CCA: 'P', CCG: 'P',
  ACT: 'T', ACC: 'T', ACA: 'T', ACG: 'T', GCT: 'A', GCC: 'A', GCA: 'A', GCG: 'A',
  TAT: 'Y', TAC: 'Y', TAA: '*', TAG: '*', CAT: 'H', CAC: 'H', CAA: 'Q', CAG: 'Q',
  AAT: 'N', AAC: 'N', AAA: 'K', AAG: 'K', GAT: 'D', GAC: 'D', GAA: 'E', GAG: 'E',
  TGT: 'C', TGC: 'C', TGA: '*', TGG: 'W', CGT: 'R', CGC: 'R', CGA: 'R', CGG: 'R',
  AGT: 'S', AGC: 'S', AGA: 'R', AGG: 'R', GGT: 'G', GGC: 'G', GGA: 'G', GGG: 'G',
};

function translateSeq(seq) {
  let out = '';
  const s = seq.toUpperCase().replace(/U/g, 'T');
  for (let i = 0; i + 3 <= s.length; i += 3) out += CODONS[s.slice(i, i + 3)] ?? 'X';
  return out;
}

const FEATURE_COLORS = {
  CDS: '#60a5fa', promoter: '#34d399', terminator: '#f87171', rep_origin: '#fbbf24',
  primer_bind: '#a78bfa', misc_feature: '#94a3b8', protein_bind: '#f472b6', RBS: '#2dd4bf',
  regulatory: '#4ade80', intron: '#d1d5db', gene: '#93c5fd', enhancer: '#86efac',
  polyA_signal: '#fca5a5', "5'UTR": '#a3e635', "3'UTR": '#fb923c',
};
const featureColor = (f) => f.color || FEATURE_COLORS[f.type] || FEATURE_COLORS.misc_feature;

/**
 * How many bases fit on one line of a .seqmap box beside its position
 * numbers, in whole tens so the numbers stay round; null while it is hidden.
 * `spare` leaves room after the last base (the editor's caret).
 */
function basesPerLine(box, spare = 0) {
  if (!box.clientWidth) return null;
  const probe = el('span', { class: 'mono', style: 'position:absolute;visibility:hidden' }, 'M'.repeat(50));
  box.appendChild(probe);
  const charWidth = probe.getBoundingClientRect().width / 50;
  probe.remove();
  const style = getComputedStyle(box);
  const num = box.querySelector('.seqmap-num');
  const numWidth = num ? num.getBoundingClientRect().width
    : 5.5 * (parseFloat(getComputedStyle(document.documentElement).fontSize) || 16);
  const usable = box.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight) - numWidth;
  const bases = Math.floor(usable / charWidth) - spare;
  return Math.max(10, Math.floor(bases / 10) * 10);
}

const FEATURE_TYPES = ['CDS', 'gene', 'promoter', 'terminator', 'RBS', 'rep_origin', 'primer_bind',
  'protein_bind', 'regulatory', 'enhancer', 'intron', "5'UTR", "3'UTR", 'polyA_signal',
  'misc_feature', 'source'];
