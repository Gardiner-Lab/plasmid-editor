/* Shared helpers: API calls, toasts, modals, small DOM utilities. */

/*
 * The app may be mounted under a prefix (e.g. /editor behind the suite proxy).
 * `BASE` comes from the server via <body data-base>, and url() turns an
 * app-absolute path into one that works wherever the app is mounted.
 */
const BASE = (document.body?.dataset.base || '').replace(/\/$/, '');
const url = (path) => (path.startsWith('/') ? BASE + path : path);

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
      window.location.href = url('/login');
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
  for (const c of children.flat()) {
    if (c === undefined || c === null || c === false) continue;
    node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
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

/**
 * Replace doc.sequence[start:end] with `text`, moving every feature to match.
 *
 * Features are shifted when the edit falls before them, stretched or shortened
 * when it falls inside them, and dropped when the edit removes them entirely.
 * Pure: returns {sequence, features} and does not touch `doc`.
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
  const features = [];
  for (const f of doc.features || []) {
    const g = { ...f, start: shift(f.start, true), end: shift(f.end, false) };
    if (f.segments) g.segments = f.segments.map(([s, e]) => [shift(s, true), shift(e, false)]);
    if (g.start === g.end) continue;   // the edit removed the whole feature
    features.push(g);
  }
  return { sequence: seq.slice(0, start) + text + seq.slice(end), features };
}

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

const FEATURE_TYPES = ['CDS', 'gene', 'promoter', 'terminator', 'RBS', 'rep_origin', 'primer_bind',
  'protein_bind', 'regulatory', 'enhancer', 'intron', "5'UTR", "3'UTR", 'polyA_signal',
  'misc_feature', 'source'];
