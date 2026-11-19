/*
 * Cloning seen rather than read: the parts of an assembly sliding together and, for a circular
 * product, the strip bending round into a ring; and a close-up of each junction, the overlap of a
 * Gibson join or the sticky end of a ligation, with its Tm.
 *
 * The strip bends by curvature: at t = 0 it is straight, at t = 1 it is a closed circle of
 * circumference L. A point at arc length s is on a circle of radius 1/k, k = 2*PI*t/L, which is
 * why the same formula draws every frame and the ends meet exactly when t reaches 1.
 */
const AssemblyView = {
  // Enough colours that neighbouring parts never share one; an assembly of more wraps round.
  PALETTE: ['#2563eb', '#16a34a', '#ea580c', '#7c3aed', '#0891b2', '#ca8a04', '#db2777', '#4d7c0f'],
  MUTED: '#64748b',
  FAINT: '#94a3b8',
  BASES: { A: '#16a34a', C: '#2563eb', G: '#ca8a04', T: '#dc2626' },

  /** Whether to go straight to the finished picture instead of animating. */
  still: () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches,

  svg(tag, attrs = {}, text) {
    const n = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
    if (text != null) n.textContent = text;
    return n;
  },

  /**
   * Where arc length ``s`` of a strip of length ``L`` lies when bent by ``t`` (0 straight, 1 a
   * closed ring): { x, y, a }, ``a`` the angle turned so far, so a tick can stand across the strip.
   */
  bendPoint(s, L, t) {
    if (t < 1e-4) return { x: s - L / 2, y: 0, a: 0 };
    const k = (2 * Math.PI * t) / L;
    const R = 1 / k;
    const a = s * k;
    // Bending downwards about a centre below the strip's start keeps the strip in view throughout.
    return { x: R * Math.sin(a), y: R * (1 - Math.cos(a)), a };
  },

  /** Points along ``from``..``to`` of the strip, close enough together to look smooth. */
  arc(from, to, L, t, step = 6) {
    const n = Math.max(2, Math.ceil((to - from) / step));
    const out = [];
    for (let i = 0; i <= n; i++) out.push(this.bendPoint(from + ((to - from) * i) / n, L, t));
    return out;
  },

  /** The transform that fits ``pts`` into ``w`` x ``h`` with ``pad`` to spare, as a scale and shift. */
  fit(pts, w, h, pad) {
    const xs = pts.map((p) => p.x);
    const ys = pts.map((p) => p.y);
    const x0 = Math.min(...xs);
    const y0 = Math.min(...ys);
    const bw = Math.max(1e-6, Math.max(...xs) - x0);
    const bh = Math.max(1e-6, Math.max(...ys) - y0);
    const scale = Math.min((w - 2 * pad) / bw, (h - 2 * pad) / bh);
    return { scale, dx: (w - scale * bw) / 2 - scale * x0, dy: (h - scale * bh) / 2 - scale * y0 };
  },

  /**
   * Where each part lies along the strip when the parts stand ``apart`` of their own total length
   * away from each other (0 once they have come together): { spans, total }, ``total`` the strip's
   * whole length, gaps included, which is what the bend closes into a ring.
   */
  spans(parts, apart = 0) {
    const bp = parts.reduce((n, p) => n + p.length, 0) || 1;
    const gap = (bp * apart) / Math.max(1, parts.length);
    let at = 0;
    const spans = parts.map((p) => {
      const span = { part: p, from: at, to: at + p.length };
      at += p.length + gap;
      return span;
    });
    // One gap after each part, the last closing back to the first, so a ring spaces them evenly.
    return { spans, total: bp + gap * parts.length, gap };
  },

  /**
   * The parts of a product as a strip, each ``{ name, length, reversed }`` in order, bent by ``t``
   * and standing ``apart`` from each other. Returns the <g> to put in an SVG of ``w`` x ``h``.
   */
  frame(parts, t, w, h, { thickness = 18, apart = 0 } = {}) {
    const { spans, total: L } = this.spans(parts, apart);
    const g = this.svg('g');
    // Every point of every segment, so the whole strip is fitted, not each piece on its own.
    const bounds = [];
    for (const s of spans) bounds.push(...this.arc(s.from, s.to, L, t));
    // The strip has width, so allow for half its thickness all round when fitting.
    const { scale, dx, dy } = this.fit(bounds, w, h, 10 + thickness / 2);
    const place = (p) => ({ x: p.x * scale + dx, y: p.y * scale + dy, a: p.a });
    spans.forEach((s, i) => {
      const pts = this.arc(s.from, s.to, L, t).map(place);
      const color = this.PALETTE[i % this.PALETTE.length];
      g.append(this.svg('path', {
        d: pts.map((p, k) => `${k ? 'L' : 'M'}${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(' '),
        fill: 'none', stroke: color, 'stroke-width': thickness, 'stroke-linecap': 'butt',
        class: 'av-part', 'data-part': i,
      }));
      // Named on hover; the legend under the picture names them all, however long.
      g.lastChild.append(this.svg('title', {}, `${s.part.name}${s.part.reversed ? ' (flipped)' : ''}, ${s.part.length} bp`));
    });
    // A tick across each join, drawn last so it sits over the parts; while they stand apart
    // there is no join to mark.
    if (apart > 0.002) return g;
    spans.forEach((s) => {
      const p = place(this.bendPoint(s.to % L, L, t));
      const nx = Math.sin(p.a);
      const ny = -Math.cos(p.a);
      const r = thickness / 2 + 2;
      g.append(this.svg('line', {
        x1: p.x + nx * r, y1: p.y + ny * r, x2: p.x - nx * r, y2: p.y - ny * r,
        stroke: '#ffffff', 'stroke-width': 2.5, class: 'av-join',
      }));
    });
    return g;
  },

  /**
   * The storyboard: the parts in a row, then bent into a ring when the product is circular, with a
   * Replay. ``parts`` are { name, length, reversed }; a still picture when motion is turned down.
   */
  storyboard(parts, circular, { w = 440, h = 230 } = {}) {
    const svg = this.svg('svg', { class: 'av-svg', viewBox: `0 0 ${w} ${h}`, width: w, height: h, role: 'img' });
    const caption = el('div', { class: 'av-caption' });
    const legend = el('ul', { class: 'av-legend' }, parts.map((p, i) => el('li', {},
      el('span', { class: 'av-chip', style: `background:${this.PALETTE[i % this.PALETTE.length]}` }),
      p.name, p.reversed ? el('span', { class: 'av-rev' }, ' flipped') : null,
      el('span', { class: 'av-len' }, ` ${fmt(p.length)} bp`))));
    const draw = (t, apart) => {
      svg.replaceChildren(this.frame(parts, t, w, h, { apart }));
      caption.textContent = apart > 0.002
        ? 'The parts, coming together'
        : (!circular ? 'Joined, end to end' : t > 0.98 ? 'Joined and circular' : 'Closing the circle…');
    };
    // The parts start this far apart, as a share of the whole, then close up.
    const APART = 0.5;
    const ease = (x) => 1 - (1 - x) ** 3;
    const run = () => {
      if (this.still()) { draw(circular ? 1 : 0, 0); return; }
      const started = performance.now();
      // First they come together, then the strip bends round; the bend starts just before they
      // have finished closing, so the two run into each other instead of stopping between.
      const gather = 900;
      const bend = 1100;
      const overlap = 180;
      const span = circular ? gather + bend - overlap : gather;
      const step = (now) => {
        const ms = Math.min(span, now - started);
        const apart = APART * (1 - ease(Math.min(1, ms / gather)));
        const t = circular ? ease(Math.max(0, ms - (gather - overlap)) / bend) : 0;
        draw(t, apart);
        if (ms < span) requestAnimationFrame(step);
      };
      draw(0, APART);
      requestAnimationFrame(step);
    };
    run();
    return el('div', { class: 'av-board' }, svg, caption, legend,
      circular && !this.still()
        ? el('button', { class: 'btn btn-sm btn-secondary av-replay', type: 'button', onclick: run }, 'Replay')
        : null);
  },

  /** A row of bases, coloured, from x0; returns the width used. */
  bases(g, seq, x0, y, { cw = 9, dim = false, mark = null } = {}) {
    [...seq].forEach((b, i) => {
      const inMark = mark && i >= mark[0] && i < mark[1];
      g.append(this.svg('text', {
        x: x0 + i * cw + cw / 2, y, 'text-anchor': 'middle', 'font-size': 11,
        'font-family': 'ui-monospace, Menlo, Consolas, monospace',
        'font-weight': inMark ? 700 : 400, fill: inMark ? (this.BASES[b] || this.MUTED) : (dim ? this.FAINT : this.MUTED),
        class: `av-base${inMark ? ' av-in' : ''}`,
      }, b));
    });
    return seq.length * cw;
  },

  /**
   * A Gibson junction: the two fragments' ends, the homology they share shaded and paired, and the
   * Tm of that overlap on a scale. ``j`` is a junction from the assembly.
   */
  gibsonJunction(j, flank = 6) {
    const cw = 9;
    const ov = (j.sequence || '').toUpperCase();
    const left = '·'.repeat(flank);
    const w = (flank + ov.length + flank) * cw + 24;
    const h = 76;
    const svg = this.svg('svg', { class: 'av-svg av-junction', viewBox: `0 0 ${w} ${h}`, width: w, height: h, role: 'img' });
    const g = this.svg('g');
    svg.append(g);
    const x0 = 12;
    const xo = x0 + flank * cw;
    // The shared stretch, which both fragments carry and which is kept once.
    g.append(this.svg('rect', { x: xo - 1, y: 8, width: ov.length * cw + 2, height: h - 28, rx: 3,
      fill: 'currentColor', opacity: 0.08, class: 'av-ovl' }));
    this.bases(g, left, x0, 24, { cw, dim: true });
    this.bases(g, ov, xo, 24, { cw, mark: [0, ov.length] });
    this.bases(g, ov, xo, 52, { cw, mark: [0, ov.length] });
    this.bases(g, left, xo + ov.length * cw, 52, { cw, dim: true });
    for (let i = 0; i < ov.length; i++) {
      g.append(this.svg('line', { x1: xo + i * cw + cw / 2, x2: xo + i * cw + cw / 2, y1: 29, y2: 43,
        stroke: this.FAINT, 'stroke-width': 1.2 }));
    }
    g.append(this.svg('text', { x: x0, y: 14, 'font-size': 10, fill: this.MUTED }, j.left));
    g.append(this.svg('text', { x: xo + ov.length * cw, y: h - 4, 'font-size': 10, fill: this.MUTED }, j.right));
    return el('div', { class: 'av-jwrap' }, svg,
      el('div', { class: 'av-jmeta' }, `${j.overlap} bp overlap`, j.flipped ? ' · the right part is flipped' : '',
        j.tm ? this.thermometer(j.tm) : null));
  },

  /**
   * A ligation junction: both strands through the join, the sticky end shaded and the two nicks
   * marked, which is where each strand's two fragments were sealed.
   */
  stickyJunction(j, flank = 6) {
    const cw = 9;
    const oh = (j.overhang || '').toUpperCase();
    const comp = { A: 'T', C: 'G', G: 'C', T: 'A' };
    const bottom = [...oh].map((b) => comp[b] || b).join('');
    const w = (flank + oh.length + flank) * cw + 24;
    const h = 76;
    const svg = this.svg('svg', { class: 'av-svg av-junction', viewBox: `0 0 ${w} ${h}`, width: w, height: h, role: 'img' });
    const g = this.svg('g');
    svg.append(g);
    const x0 = 12;
    const xo = x0 + flank * cw;
    const dots = '·'.repeat(flank);
    g.append(this.svg('rect', { x: xo - 1, y: 8, width: Math.max(cw, oh.length * cw) + 2, height: h - 28, rx: 3,
      fill: 'currentColor', opacity: 0.08, class: 'av-ovl' }));
    this.bases(g, dots, x0, 24, { cw, dim: true });
    this.bases(g, oh, xo, 24, { cw, mark: [0, oh.length] });
    this.bases(g, dots, xo + oh.length * cw, 24, { cw, dim: true });
    this.bases(g, dots, x0, 52, { cw, dim: true });
    this.bases(g, bottom, xo, 52, { cw, mark: [0, bottom.length] });
    this.bases(g, dots, xo + oh.length * cw, 52, { cw, dim: true });
    // The two nicks: a 5' overhang is sealed on the top strand where the overhang starts and on
    // the bottom where it ends, which is what makes the join staggered.
    const five = j.kind !== "3'";
    const nick = (x, y) => g.append(this.svg('path', { d: `M${x},${y - 9} L${x},${y + 3}`, stroke: '#dc2626',
      'stroke-width': 2, 'stroke-linecap': 'round', class: 'av-nick' }));
    nick(five ? xo : xo + oh.length * cw, 24);
    nick(five ? xo + oh.length * cw : xo, 52);
    g.append(this.svg('text', { x: x0, y: 14, 'font-size': 10, fill: this.MUTED }, j.left));
    g.append(this.svg('text', { x: xo + oh.length * cw, y: h - 4, 'font-size': 10, fill: this.MUTED }, j.right));
    return el('div', { class: 'av-jwrap' }, svg,
      el('div', { class: 'av-jmeta' }, oh ? `${oh.length} nt ${j.kind} overhang` : 'blunt',
        j.enzymes?.length ? ` · ${j.enzymes.join(' + ')}` : '',
        el('div', { class: 'hint' }, 'The red marks are the two nicks the ligase seals.')));
  },

  /** A Tm against the range that matters for a Gibson join: a bar with the reading on it. */
  thermometer(tm, { low = 40, high = 80, w = 120 } = {}) {
    const at = Math.max(0, Math.min(1, (tm - low) / (high - low)));
    const svg = this.svg('svg', { class: 'av-therm', viewBox: `0 0 ${w} 26`, width: w, height: 26, role: 'img' });
    svg.append(this.svg('rect', { x: 0, y: 12, width: w, height: 6, rx: 3, fill: 'currentColor', opacity: 0.12 }));
    // Above about 48 °C a Gibson junction anneals readily; the warm part of the bar says so.
    const warm = ((48 - low) / (high - low)) * w;
    svg.append(this.svg('rect', { x: warm, y: 12, width: w - warm, height: 6, rx: 3, fill: '#16a34a', opacity: 0.35 }));
    svg.append(this.svg('circle', { cx: at * w, cy: 15, r: 5, fill: tm >= 48 ? '#16a34a' : '#ea580c' }));
    svg.append(this.svg('text', { x: Math.min(w, Math.max(0, at * w)), y: 9, 'text-anchor': 'middle',
      'font-size': 10, fill: 'currentColor' }, `${tm} °C`));
    return el('span', { class: 'av-thermwrap', title: `Overlap Tm ${tm} °C` }, svg);
  },

  /**
   * A double crossover, as Gateway and Cre-lox do it: the donor over the acceptor, the two cores
   * they share marked, strands crossing at each, and the product built from the pieces below.
   * ``plan`` is { donor, acceptor, product } of { name, length, at: [core1, core2] }, ``at`` in bp.
   */
  crossover(plan, { w = 460, h = 190 } = {}) {
    const DON = this.PALETTE[0];
    const ACC = this.PALETTE[1];
    const pad = 22;
    const span = w - 2 * pad;
    const rows = { donor: 30, acceptor: 100, product: 168 };
    const svg = this.svg('svg', { class: 'av-svg av-cross', viewBox: `0 0 ${w} ${h}`, width: w, height: h, role: 'img' });
    // Each molecule on its own scale, so both fill the width whatever their lengths.
    const at = (m, bp) => pad + (bp / Math.max(1, m.length)) * span;
    const line = (y, x1, x2, color, thick) => this.svg('line', { x1, x2, y1: y, y2: y, stroke: color,
      'stroke-width': thick, 'stroke-linecap': 'round' });
    // The donor is labelled above its line and the acceptor below, clear of the crossings between them.
    const label = (y, t, color, below) => this.svg('text', { x: pad, y: below ? y + 17 : y - 11, 'font-size': 11,
      fill: color, 'font-weight': 600 }, t);
    const draw = (key, m, color, below) => {
      const y = rows[key];
      const [c1, c2] = m.at.map((bp) => at(m, bp));
      svg.append(line(y, pad, w - pad, this.FAINT, 4));
      // The stretch between the two cores: on the donor what moves, on the acceptor what goes.
      svg.append(line(y, Math.min(c1, c2), Math.max(c1, c2), color, 8));
      svg.append(label(y, m.name, color, below));
      return [c1, c2];
    };
    const d = draw('donor', plan.donor, DON);
    const a = draw('acceptor', plan.acceptor, ACC, true);
    // The product: the acceptor's flanks with the donor's stretch dropped in between.
    const py = rows.product;
    const p1 = at(plan.product, plan.product.at[0]);
    const p2 = at(plan.product, plan.product.at[1]);
    svg.append(line(py, pad, p1, ACC, 8), line(py, p1, p2, DON, 8), line(py, p2, w - pad, ACC, 8),
      label(py, plan.product.name, this.MUTED, false));
    // At each core the two strands change partners: each leaves its own molecule on one side of
    // the core and joins the other on the far side, so the two paths cross in the middle.
    const cross = [];
    const reach = 15;
    for (const [xd, xa] of [[d[0], a[0]], [d[1], a[1]]]) {
      const y1 = rows.donor;
      const y2 = rows.acceptor;
      const mid = (y1 + y2) / 2;
      for (const [x1, x2, color] of [[xd - reach, xa + reach, DON], [xa - reach, xd + reach, ACC]]) {
        const [from, to] = color === DON ? [y1, y2] : [y2, y1];
        const path = this.svg('path', { d: `M${x1},${from} C${x1},${mid} ${x2},${mid} ${x2},${to}`,
          fill: 'none', stroke: color, 'stroke-width': 2, class: 'av-x' });
        cross.push(path);
        svg.append(path);
      }
      svg.append(this.svg('circle', { cx: xd, cy: y1, r: 4, fill: '#ffffff', stroke: this.MUTED, 'stroke-width': 1.5 }),
        this.svg('circle', { cx: xa, cy: y2, r: 4, fill: '#ffffff', stroke: this.MUTED, 'stroke-width': 1.5 }));
    }
    // The core names, over the crossings.
    (plan.sites || []).forEach((name, i) => {
      if (!name) return;
      // Just under the core on the donor, over a halo so a crossing behind it does not blur it.
      svg.append(this.svg('text', { x: d[i], y: rows.donor + 16, 'text-anchor': 'middle', 'font-size': 10,
        fill: this.MUTED, stroke: 'var(--card-bg, #fff)', 'stroke-width': 3, 'paint-order': 'stroke',
        class: 'av-site' }, name));
    });
    // The crossings draw themselves in, then the product appears under them.
    const product = [...svg.querySelectorAll('line')].slice(-3);
    const run = () => {
      if (this.still()) { cross.forEach((c) => c.removeAttribute('stroke-dasharray')); return; }
      cross.forEach((c) => {
        const len = c.getTotalLength();
        c.setAttribute('stroke-dasharray', len);
        c.setAttribute('stroke-dashoffset', len);
        c.animate([{ strokeDashoffset: len }, { strokeDashoffset: 0 }], { duration: 650, fill: 'forwards', easing: 'ease-out' });
      });
      product.forEach((l) => l.animate([{ opacity: 0 }, { opacity: 0 }, { opacity: 1 }],
        { duration: 1100, fill: 'forwards', easing: 'ease-out' }));
    };
    run();
    return el('div', { class: 'av-board' }, svg,
      el('div', { class: 'av-caption' }, "The donor's stretch between the two shared cores changes places with the acceptor's."),
      this.still() ? null : el('button', { class: 'btn btn-sm btn-secondary av-replay', type: 'button', onclick: run }, 'Replay'));
  },

  /** Every junction of a product, each as a close-up; null when there are none to draw. */
  junctions(list, kind) {
    if (!list?.length) return null;
    const one = (j) => (kind === 'sticky' ? this.stickyJunction(j) : this.gibsonJunction(j));
    return el('details', { class: 'av-box' },
      el('summary', {}, `Junctions, close up (${list.length})`),
      el('p', { class: 'hint' }, kind === 'sticky'
        ? 'Each join as the two fragments meet: the sticky end they share, and where the ligase seals each strand.'
        : 'Each join as the two fragments meet: the homology they share, kept once in the product, and how warm it anneals.'),
      el('div', { class: 'av-jlist' }, list.map(one)));
  },
};

if (typeof module !== 'undefined') module.exports = { AssemblyView };
