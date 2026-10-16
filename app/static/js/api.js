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
  /** A stock's number as a link to it in Lab Stocks when it is one of its codes; else just the text. */
  render(code) {
    if (!code) return '—';
    if (!STOCKS || !this.kind(code)) return String(code);
    return el('a', { href: this.link(code), target: '_blank', rel: 'noopener', title: 'Open in Lab Stocks' }, `🧫 ${code}`);
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
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
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
