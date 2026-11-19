/*
 * Hairpins and dimers of a primer pair, drawn: the strongest hairpin and self-dimer of each primer
 * and the dimer of the two, as primer3 finds them (POST /api/tools/primer-structures), each as a
 * small SVG with paired bases joined by a line (thicker for G–C), the way primer3 draws them in text.
 *
 * primer3 draws a dimer in four lines: the top strand's unpaired bases, its paired bases, the bottom
 * strand's paired bases (3'→5'), its unpaired bases. A hairpin is two lines: '/' at each base pairing
 * with a later '\' ('-' unpaired), then the sequence under it. Each line starts "SEQ\t" or "STR\t".
 */
const Structure = {
  COLORS: { A: '#16a34a', C: '#2563eb', G: '#ca8a04', T: '#dc2626' },
  MUTED: '#64748b',
  FAINT: '#94a3b8',
  _asked: new Map(),

  /** primer3's structures for a pair, asked once per pair however often they are shown. */
  fetch(forward, reverse, bisulfite = false) {
    const key = `${forward}|${reverse}|${bisulfite}`;
    if (!this._asked.has(key)) {
      const asked = API.post('/api/tools/primer-structures', { forward, reverse, bisulfite });
      asked.catch(() => this._asked.delete(key));
      this._asked.set(key, asked);
    }
    return this._asked.get(key);
  },

  /** The five structures of a pair, titled, in the order they are shown. */
  list(res) {
    return [
      ['Forward primer, hairpin', res.forward.hairpin], ['Forward primer, self-dimer', res.forward.homodimer],
      ['Reverse primer, hairpin', res.reverse.hairpin], ['Reverse primer, self-dimer', res.reverse.homodimer],
      ['The two primers together', res.heterodimer]];
  },

  /** What a structure is: its Tm, ΔG and the form drawn, or that none was found. */
  about(r) {
    return r ? `Tm ${r.tm} °C · ΔG ${r.dg} kcal/mol${r.form ? ` · as ${r.form}` : ''}` : 'none found';
  },

  /** Columns of a duplex: { top, bottom, paired } each, top 5'→3' and bottom 3'→5' left to right; null if unreadable. */
  parse(lines) {
    const rows = (lines || []).map((l) => String(l).replace(/^[A-Z]{3}\t/, '').replace(/\r?\n$/, ''));
    const base = (s, i) => (/[ACGTN]/i.test(s[i] || '') ? s[i].toUpperCase() : null);
    if (rows.length >= 4) {
      const width = Math.max(...rows.slice(0, 4).map((r) => r.length));
      const cols = [];
      for (let c = 0; c < width; c++) {
        const p1 = base(rows[1], c);
        const p2 = base(rows[2], c);
        const top = p1 || base(rows[0], c);
        const bottom = p2 || base(rows[3], c);
        if (top || bottom) cols.push({ top, bottom, paired: !!(p1 && p2) });
      }
      return cols.some((c) => c.paired) ? { kind: 'duplex', cols, loop: [] } : null;
    }
    if (rows.length >= 2) {
      // primer3 prints the marks first ("SEQ\t--///---\\\\\\"), then the sequence; either order is read.
      const m = /[/\\]/.test(rows[0]) ? 0 : 1;
      return this.fold(rows[1 - m].replace(/[^A-Za-z]/g, '').toUpperCase(), rows[m]);
    }
    return null;
  },

  /** A hairpin laid out as a stem: the 5' arm on top, the 3' arm folded back under it, the loop at the right. */
  fold(seq, marks) {
    // The marks line is under the sequence, as long as it, once the "STR\t" is gone.
    const open = [];
    const pairs = [];
    for (let i = 0; i < Math.min(seq.length, marks.length); i++) {
      if (marks[i] === '/') open.push(i);
      else if (marks[i] === '\\' && open.length) pairs.push([open.pop(), i]);
    }
    if (!pairs.length) return null;
    pairs.sort((a, b) => a[0] - b[0]);
    const cols = [];
    // A block of unpaired bases on each arm, top read rightwards and bottom read leftwards from the
    // 3' end, padded on the side away from the stem so both arms end against it.
    const block = (top, bottom, alignRight) => {
      const w = Math.max(top.length, bottom.length);
      const pad = (a) => (alignRight ? [...Array(w - a.length).fill(null), ...a] : [...a, ...Array(w - a.length).fill(null)]);
      const t = pad(top);
      const b = pad(bottom);
      for (let k = 0; k < w; k++) cols.push({ top: t[k], bottom: b[k], paired: false });
    };
    const range = (from, to) => { const a = []; for (let k = from; k < to; k++) a.push(seq[k]); return a; };
    const [i0, j0] = pairs[0];
    block(range(0, i0), range(j0 + 1, seq.length).reverse(), true);
    pairs.forEach(([i, j], n) => {
      cols.push({ top: seq[i], bottom: seq[j], paired: true });
      const next = pairs[n + 1];
      if (next) block(range(i + 1, next[0]), range(next[1] + 1, j).reverse(), false);
    });
    const [il, jl] = pairs[pairs.length - 1];
    return { kind: 'hairpin', cols, loop: range(il + 1, jl) };
  },

  /** The SVG of a parsed structure; ends labelled for a duplex, the loop drawn round for a hairpin. */
  draw(s) {
    const NS = 'http://www.w3.org/2000/svg';
    const node = (tag, attrs, text) => {
      const n = document.createElementNS(NS, tag);
      for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
      if (text != null) n.textContent = text;
      return n;
    };
    const cw = 11;
    const left = 24;
    // A hairpin's loop is a circle through the last bases of both arms, big enough to space its
    // bases a letter apart; a big loop pushes the stem down to make room above it.
    const ry = 14;
    const n = s.kind === 'hairpin' ? s.loop.length : 0;
    const R = n ? Math.max(ry + 2, ((n + 2) * cw * 1.15) / (2 * Math.PI)) : 0;
    const pad = Math.max(0, R - ry - 2);
    const yTop = 18 + pad;
    const yBot = yTop + 2 * ry;
    const midY = yTop + ry - 4;
    const xr = left + s.cols.length * cw;
    const d = n ? Math.sqrt(R * R - ry * ry) : 0;
    const width = xr + (n ? cw / 2 + d + R + 8 : 24);
    const height = yBot + 14 + pad;
    // Colours are given as attributes too, for a picture drawn without the page's stylesheet
    // (the notebook's); on the page the stylesheet's, which follow the theme, win.
    const svg = node('svg', { class: 'st-svg', width, height, viewBox: `0 0 ${width} ${height}`, role: 'img',
      'font-family': 'ui-monospace, Menlo, Consolas, monospace', 'font-size': 12 });
    const letter = (b, x, y, paired) => svg.append(node('text', {
      x, y, class: `st-base st-${b.toLowerCase()}${paired ? ' st-paired' : ''}`, 'text-anchor': 'middle',
      fill: paired ? (this.COLORS[b] || this.MUTED) : this.FAINT, 'font-weight': paired ? 700 : 400 }, b));
    s.cols.forEach((c, k) => {
      const x = left + k * cw + cw / 2;
      if (c.paired) {
        const gc = /[GC]/.test(c.top) && /[GC]/.test(c.bottom);
        svg.append(node('line', { x1: x, x2: x, y1: yTop + 5, y2: yBot - 13, class: gc ? 'st-bond st-gc' : 'st-bond',
          stroke: this.MUTED, 'stroke-width': gc ? 2.6 : 1.2 }));
      }
      if (c.top) letter(c.top, x, yTop, c.paired);
      if (c.bottom) letter(c.bottom, x, yBot, c.paired);
    });
    const end = (x, y, t) => svg.append(node('text', { x, y, class: 'st-end', 'text-anchor': 'middle', fill: this.MUTED, 'font-size': 10 }, t));
    end(left / 2, yTop, '5′');
    end(left / 2, yBot, '3′');
    if (n) {
      // Round the circle clockwise, from the top arm's last base to the bottom arm's.
      const cx = xr - cw / 2 + d;
      const b0 = Math.atan2(ry, d);
      s.loop.forEach((b, k) => {
        const a = -Math.PI + b0 + ((2 * Math.PI - 2 * b0) * (k + 1)) / (n + 1);
        letter(b, cx + R * Math.cos(a), midY + 4 + R * Math.sin(a), false);
      });
    } else {
      end(xr + 12, yTop, '3′');
      end(xr + 12, yBot, '5′');
    }
    return svg;
  },

  /**
   * Where each base goes in the whole molecule, drawn as a structure: the stem a ladder along x,
   * unpaired runs inside it bulging out as bubbles, loose ends fanning away from it, and a
   * hairpin's loop a circle closing the stem's end. Returns { top, bot, loop, bonds, step }:
   * points { b, x, y, paired }, top and bot left to right as the columns are, loop in strand order.
   */
  layout(s, step = 16, gap = 36) {
    const S = step;
    const fan = Math.PI / 6;
    const top = [];
    const bot = [];
    const bonds = [];
    const cols = s.cols;
    const pairs = cols.map((c, i) => (c.paired ? i : -1)).filter((i) => i >= 0);
    const first = pairs[0];
    const last = pairs[pairs.length - 1];
    const bases = (from, to, side) => cols.slice(from, to).map((c) => c[side]).filter(Boolean);
    // Loose ends: splaying away from the stem for two bases, then running level, however long.
    const tail = (list, x0, y0, dx, dy, out, nearFirst) => list.forEach((b, i) => {
      const k = nearFirst ? i + 1 : list.length - i;
      const bent = Math.min(k, 2);
      out.push({ b, x: x0 + dx * (bent * S * Math.cos(fan) + (k - bent) * S), y: y0 + dy * bent * S * Math.sin(fan), paired: false });
    });
    // An unpaired run inside the stem: round a half ellipse from one pair to the next, as long as the run.
    const bulge = (list, xa, xb, y, dir, out) => {
      const A = (xb - xa) / 2;
      const L = (list.length + 1) * S;
      const B = Math.sqrt(Math.max(0, 2 * (L / Math.PI) ** 2 - A * A));
      list.forEach((b, i) => {
        const t = Math.PI - (Math.PI * (i + 1)) / (list.length + 1);
        out.push({ b, x: xa + A + A * Math.cos(t), y: y + dir * B * Math.sin(t), paired: false });
      });
    };
    tail(bases(0, first, 'top'), 0, 0, -1, -1, top, false);
    tail(bases(0, first, 'bottom'), 0, gap, -1, 1, bot, false);
    let x = 0;
    for (let i = first; i <= last;) {
      if (cols[i].paired) {
        top.push({ b: cols[i].top, x, y: 0, paired: true });
        bot.push({ b: cols[i].bottom, x, y: gap, paired: true });
        bonds.push([top.length - 1, bot.length - 1]);
        i++;
        if (i <= last && cols[i].paired) x += S;
        continue;
      }
      let j = i;
      while (!cols[j].paired) j++;
      const t = bases(i, j, 'top');
      const u = bases(i, j, 'bottom');
      const xb = x + S * (Math.ceil(Math.max(t.length, u.length) / 2) + 1);
      bulge(t, x, xb, 0, -1, top);
      bulge(u, x, xb, gap, 1, bot);
      x = xb;
      i = j;
    }
    tail(bases(last + 1, cols.length, 'top'), x, 0, 1, -1, top, true);
    tail(bases(last + 1, cols.length, 'bottom'), x, gap, 1, 1, bot, true);
    const loop = [];
    if (s.kind === 'hairpin' && s.loop.length) {
      // A circle through the last pair, its bases a step apart round it.
      const n = s.loop.length;
      const h = gap / 2;
      const R = Math.max(h + 2, ((n + 2) * S) / (2 * Math.PI));
      const d = Math.sqrt(R * R - h * h);
      const b0 = Math.atan2(h, d);
      s.loop.forEach((b, k) => {
        const a = -Math.PI + b0 + ((2 * Math.PI - 2 * b0) * (k + 1)) / (n + 1);
        loop.push({ b, x: x + d + R * Math.cos(a), y: h + R * Math.sin(a), paired: false });
      });
    }
    return { top, bot, loop, bonds, step: S };
  },

  /** The whole molecule as a structure: backbone, base circles, pairs as rungs (see layout). */
  full(s) {
    const NS = 'http://www.w3.org/2000/svg';
    const node = (tag, attrs, text) => {
      const n = document.createElementNS(NS, tag);
      for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
      if (text != null) n.textContent = text;
      return n;
    };
    const { top, bot, loop, bonds } = this.layout(s);
    const r = 7;
    const margin = r + 18;
    const all = [...top, ...bot, ...loop];
    const minX = Math.min(...all.map((p) => p.x)) - margin;
    const minY = Math.min(...all.map((p) => p.y)) - margin;
    const width = Math.max(...all.map((p) => p.x)) - minX + margin;
    const height = Math.max(...all.map((p) => p.y)) - minY + margin;
    const svg = node('svg', { class: 'st-svg st-full', width, height, viewBox: `${minX} ${minY} ${width} ${height}`, role: 'img',
      'font-family': 'ui-monospace, Menlo, Consolas, monospace' });
    // The backbone, in strand order: a hairpin is one strand, out along the top, round, back along the bottom.
    const strands = s.kind === 'hairpin' ? [[...top, ...loop, ...[...bot].reverse()]] : [top, bot];
    for (const strand of strands) {
      svg.append(node('polyline', { points: strand.map((p) => `${p.x},${p.y}`).join(' '), fill: 'none',
        class: 'st-backbone', stroke: this.FAINT, 'stroke-width': 2, 'stroke-linejoin': 'round' }));
    }
    for (const [i, j] of bonds) {
      const gc = /[GC]/.test(top[i].b) && /[GC]/.test(bot[j].b);
      svg.append(node('line', { x1: top[i].x, x2: bot[j].x, y1: top[i].y + r, y2: bot[j].y - r,
        class: gc ? 'st-bond st-gc' : 'st-bond', stroke: this.MUTED, 'stroke-width': gc ? 2.6 : 1.2 }));
    }
    for (const p of all) {
      const color = this.COLORS[p.b] || this.MUTED;
      svg.append(node('circle', { cx: p.x, cy: p.y, r, class: `st-dot st-${p.b.toLowerCase()}${p.paired ? ' st-paired' : ''}`,
        fill: p.paired ? color : '#ffffff', stroke: color, 'stroke-width': 1.5 }));
      svg.append(node('text', { x: p.x, y: p.y + 3.5, 'text-anchor': 'middle', 'font-size': 9, 'font-weight': 700,
        class: `st-dot-label${p.paired ? ' st-paired' : ''}`, fill: p.paired ? '#ffffff' : color }, p.b));
    }
    // The ends, a little beyond the last base, along the strand.
    const label = (strand, atStart, t) => {
      if (!strand.length) return;
      const [p, q] = atStart ? [strand[0], strand[1] || strand[0]] : [strand[strand.length - 1], strand[strand.length - 2] || strand[0]];
      const len = Math.hypot(p.x - q.x, p.y - q.y) || 1;
      const dx = p === q ? -1 : (p.x - q.x) / len;
      const dy = p === q ? 0 : (p.y - q.y) / len;
      svg.append(node('text', { x: p.x + dx * 16, y: p.y + dy * 16 + 3.5, 'text-anchor': 'middle', 'font-size': 10,
        class: 'st-end', fill: this.MUTED }, t));
    };
    label(top, true, '5′');
    if (s.kind === 'hairpin') {
      label(bot, true, '3′');
    } else {
      label(top, false, '3′');
      label(bot, true, '3′');
      label(bot, false, '5′');
    }
    return svg;
  },

  /** One structure, titled, with its Tm and ΔG; "none found" when primer3 found none. */
  figure(title, r, strongest) {
    const head = el('div', { class: 'st-head' }, el('b', {}, title),
      ` · ${this.about(r)}`,
      strongest ? el('span', { class: 'st-flag' }, 'strongest') : null);
    if (!r) return el('div', { class: 'st-fig st-none' }, head);
    const parsed = this.parse(r.lines);
    // Drawn as primer3 printed it when its drawing cannot be read.
    if (!parsed) return el('div', { class: 'st-fig' }, head, el('pre', { class: 'mono st-raw' }, r.lines.join('\n')));
    return el('div', { class: 'st-fig' }, head, el('div', { class: 'st-scroll' }, this.picture(parsed)));
  },

  /** A hairpin drawn whole, folded as it is; a dimer as the close-up of its two strands. */
  picture(parsed) {
    return parsed.kind === 'hairpin' ? this.full(parsed) : this.draw(parsed);
  },

  /**
   * A closed "Hairpins and dimers, drawn" box for a pair, asking primer3 the first time it opens.
   * ``bisulfite`` primers may hold Y and R and are drawn as whichever form, converted or not, is stronger.
   */
  panel(forward, reverse, { bisulfite = false } = {}) {
    const body = el('div', { class: 'st-body' });
    let asked = false;
    const box = el('details', { class: 'st-box' },
      el('summary', {}, 'Hairpins and dimers, drawn'), body);
    box.addEventListener('toggle', async () => {
      if (!box.open || asked) return;
      asked = true;
      body.replaceChildren(el('span', { class: 'spin' }));
      try {
        const all = this.list(await this.fetch(forward, reverse, bisulfite));
        const top = Math.max(...all.map(([, r]) => (r ? r.tm : -Infinity)));
        body.replaceChildren(
          el('p', { class: 'hint' }, 'The most stable structure of each kind primer3 finds, paired bases joined '
            + '(thicker for G–C). Below about 40 °C, well under the annealing temperature, they seldom matter.'),
          ...all.map(([t, r]) => this.figure(t, r, r && r.tm === top && top > -Infinity)));
      } catch (err) {
        asked = false;
        body.replaceChildren(el('div', { class: 'alert alert-error', text: err.message }));
      }
    });
    return box;
  },

  /** All five structures of a pair in one SVG, each under its title: the picture for the notebook. */
  sheet(res) {
    const NS = 'http://www.w3.org/2000/svg';
    const node = (tag, attrs, text) => {
      const n = document.createElementNS(NS, tag);
      for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
      if (text != null) n.textContent = text;
      return n;
    };
    const svg = node('svg', { 'font-family': 'system-ui, -apple-system, "Segoe UI", Arial, sans-serif' });
    const all = this.list(res);
    const top = Math.max(...all.map(([, r]) => (r ? r.tm : -Infinity)));
    let y = 8;
    let width = 420;
    for (const [title, r] of all) {
      const head = node('text', { x: 8, y: y + 13, 'font-size': 13, fill: '#1f2937' });
      head.append(node('tspan', { 'font-weight': 700 }, title), node('tspan', { fill: this.MUTED }, `  ${this.about(r)}`));
      if (r && r.tm === top) head.append(node('tspan', { fill: '#b45309', 'font-weight': 700 }, '  strongest'));
      svg.append(head);
      y += 20;
      const parsed = r && this.parse(r.lines);
      if (parsed) {
        const pic = this.picture(parsed);
        pic.setAttribute('x', 0);
        pic.setAttribute('y', y);
        svg.append(pic);
        width = Math.max(width, Number(pic.getAttribute('width')) + 8);
        y += Number(pic.getAttribute('height')) + 10;
      } else {
        y += 6;
      }
    }
    svg.setAttribute('width', width);
    svg.setAttribute('height', y + 4);
    svg.setAttribute('viewBox', `0 0 ${width} ${y + 4}`);
    return svg;
  },

  /**
   * For a notebook section: a text block holding the pair's structures as picture ``index``, the
   * PNG for it, and a table of their Tm and ΔG.
   */
  async notebook(forward, reverse, index, { bisulfite = false } = {}) {
    const res = await this.fetch(forward, reverse, bisulfite);
    const picture = await svgToPng(this.sheet(res));
    return {
      blocks: [
        { type: 'text', html: '<p>Hairpins and dimers of the pair, the most stable of each kind primer3 finds, '
          + `paired bases joined (thicker for G–C)${bisulfite ? '; each drawn converted or unconverted, whichever is the more stable' : ''}.</p>`
          + Notebook.picture(index, 'Hairpins and dimers') },
        Notebook.table('Hairpins and dimers', [['Structure'], ['Tm', 'number', '°C'], ['ΔG', 'number', 'kcal/mol']],
          this.list(res).map(([t, r]) => [t, r ? r.tm : '', r ? r.dg : ''])),
      ],
      picture,
    };
  },
};

if (typeof module !== 'undefined') module.exports = { Structure };
