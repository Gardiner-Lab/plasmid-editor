/*
 * Circular and linear plasmid maps as inline SVG.
 *
 * Features become arcs (or arrows, when linear) with leader-line labels;
 * restriction sites become tick marks. One click on a feature or an enzyme
 * name calls onFeatureClick / onSiteClick; a double click calls
 * onFeatureDblClick / onSiteDblClick.
 */

const SVGNS = 'http://www.w3.org/2000/svg';

function svgEl(tag, attrs = {}, text) {
  const node = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null) continue;
    node.setAttribute(k, v);
  }
  if (text !== undefined) node.textContent = text;
  return node;
}

class PlasmidMap {
  constructor(container) {
    this.container = container;
    this.onFeatureClick = null;
    this.onFeatureDblClick = null;
    this.onSiteClick = null;
    this.onSiteDblClick = null;
    this.doc = null;
    this.sites = [];
    this.selection = null;
    // A map labelled with every site of every enzyme is unreadable, so by
    // convention only unique cutters are drawn (as in ApE's graphic map).
    this.uniqueCuttersOnly = true;
    this.maxSiteLabels = 26;
  }

  /** Sites worth labelling: unique cutters first, then the rarest, capped. */
  _labelSites(sites) {
    const counts = new Map();
    for (const s of sites) {
      if (s.cut_top === null || s.cut_top === undefined) continue;
      counts.set(s.enzyme, (counts.get(s.enzyme) || 0) + 1);
    }
    let usable = sites.filter((s) => s.cut_top !== null && s.cut_top !== undefined);
    if (this.uniqueCuttersOnly) {
      const unique = usable.filter((s) => counts.get(s.enzyme) === 1);
      if (unique.length) usable = unique;
    }
    return usable
      .sort((a, b) => counts.get(a.enzyme) - counts.get(b.enzyme) || a.cut_top - b.cut_top)
      .slice(0, this.maxSiteLabels)
      .sort((a, b) => a.cut_top - b.cut_top);
  }

  render(doc, sites = [], selection = null) {
    this.doc = doc;
    this.sites = sites;
    this.selection = selection;
    if (!doc || !doc.sequence) {
      this.container.replaceChildren(el('div', { class: 'empty' }, 'No sequence open.'));
      return;
    }
    const svg = doc.circular ? this._circular(doc, sites, selection) : this._linear(doc, sites, selection);
    this.container.replaceChildren(svg);
  }

  _featureSpans(f, n) {
    if (f.segments && f.segments.length) return f.segments.map(([s, e]) => [s, e]);
    if (f.end > f.start) return [[f.start, f.end]];
    return [[f.start, n], [0, f.end]];
  }

  _attach(node, f) {
    node.classList.add('map-feature');
    // The map re-renders after the first click, so a double click is read
    // from the click count rather than a dblclick event.
    node.addEventListener('click', (e) => {
      if (e.detail >= 2) this.onFeatureDblClick?.(f);
      else this.onFeatureClick?.(f);
    });
    node.appendChild(svgEl('title', {},
      `${f.name} (${f.type}) ${f.start + 1}..${f.end}${f.strand === -1 ? ' complement' : ''}`));
    return node;
  }

  _attachSite(node, site) {
    node.classList.add('map-site');
    node.addEventListener('click', (e) => {
      if (e.detail >= 2) this.onSiteDblClick?.(site);
      else this.onSiteClick?.(site);
    });
    node.appendChild(svgEl('title', {},
      `${site.enzyme} site ${site.start + 1}. Click to highlight it, double-click for details.`));
    return node;
  }

  /* --- circular --------------------------------------------------------- */

  _circular(doc, sites, selection) {
    const size = 560;
    const cx = size / 2;
    const cy = size / 2;
    const r = 170;           // backbone radius
    const n = doc.sequence.length;
    const svg = svgEl('svg', { viewBox: `0 0 ${size} ${size}`, width: size, height: size,
      role: 'img', 'aria-label': `Circular map of ${doc.name}` });

    const angle = (pos) => (pos / n) * 2 * Math.PI - Math.PI / 2;
    const point = (pos, radius) => [cx + radius * Math.cos(angle(pos)), cy + radius * Math.sin(angle(pos))];

    const arcPath = (from, to, radius) => {
      const [x1, y1] = point(from, radius);
      const [x2, y2] = point(to, radius);
      const span = ((to - from + n) % n) / n;
      const large = span > 0.5 ? 1 : 0;
      return `M ${x1} ${y1} A ${radius} ${radius} 0 ${large} 1 ${x2} ${y2}`;
    };

    // Selection wedge
    if (selection && selection.start !== selection.end) {
      const [x1, y1] = point(selection.start, r + 16);
      const [x2, y2] = point(selection.end, r + 16);
      const span = ((selection.end - selection.start + n) % n) / n;
      svg.appendChild(svgEl('path', {
        d: `M ${cx} ${cy} L ${x1} ${y1} A ${r + 16} ${r + 16} 0 ${span > 0.5 ? 1 : 0} 1 ${x2} ${y2} Z`,
        fill: '#bfdbfe', opacity: '.55',
      }));
    }

    svg.appendChild(svgEl('circle', { cx, cy, r, fill: 'none', stroke: '#d1d5db', 'stroke-width': 8 }));

    // Tick marks every ~10% of the plasmid, rounded to something readable.
    // A tick number is dropped when an enzyme label would sit on top of it:
    // the enzyme name is the more useful of the two.
    const labelledSites = this._labelSites(sites);
    const tickClearance = (n / 360) * 9;
    const step = Math.max(100, Math.round(n / 10 / 100) * 100);
    for (let pos = 0; pos < n; pos += step) {
      const [x1, y1] = point(pos, r - 7);
      const [x2, y2] = point(pos, r + 7);
      svg.appendChild(svgEl('line', { x1, y1, x2, y2, stroke: '#9ca3af', 'stroke-width': 1 }));
      const clash = labelledSites.some((site) => {
        const d = Math.abs(site.cut_top - pos);
        return Math.min(d, n - d) < tickClearance;
      });
      if (clash) continue;
      const [lx, ly] = point(pos, r - 15);
      svg.appendChild(svgEl('text', {
        x: lx, y: ly, 'text-anchor': 'middle', 'dominant-baseline': 'middle',
        'font-size': 9, fill: '#6b7280',
      }, String(pos)));
    }

    // Feature arcs, stacked outwards when they overlap.
    const placed = [];
    const sorted = [...doc.features].sort((a, b) =>
      DNA.featLength(b, n) - DNA.featLength(a, n));
    for (const f of sorted) {
      for (const [fs, fe] of this._featureSpans(f, n)) {
        let ring = 0;
        while (placed.some((p) => p.ring === ring && p.start < fe && fs < p.end)) ring++;
        placed.push({ ring, start: fs, end: fe });
        const radius = r + 14 + ring * 13;
        const path = svgEl('path', {
          d: arcPath(fs, fe % n, radius),
          fill: 'none', stroke: featureColor(f), 'stroke-width': 9,
          'stroke-linecap': f.strand === -1 ? 'butt' : 'round',
        });
        svg.appendChild(this._attach(path, f));

        // Direction marker at the feature's 3' end.
        const tipPos = f.strand === -1 ? fs : fe % n;
        const [tx, ty] = point(tipPos, radius);
        const a = angle(tipPos) + (f.strand === -1 ? Math.PI : 0);
        const marker = svgEl('polygon', {
          points: '0,-6 11,0 0,6',
          fill: featureColor(f),
          transform: `translate(${tx} ${ty}) rotate(${(a * 180) / Math.PI + 90})`,
        });
        svg.appendChild(this._attach(marker, f));
      }
    }

    // Labels with leader lines, alternating radius to limit collisions.
    const labelled = [...doc.features]
      .filter((f) => DNA.featLength(f, n) / n > 0.012 || doc.features.length < 24)
      .slice(0, 40);
    labelled.forEach((f, i) => {
      const flen = DNA.featLength(f, n);
      const mid = (f.start + flen / 2) % n;
      const outer = r + 20 + (placed.find((p) => p.start === f.start)?.ring || 0) * 13;
      const [x1, y1] = point(mid, outer + 6);
      const labelR = outer + 24 + (i % 2) * 16;
      const [x2, y2] = point(mid, labelR);
      const right = Math.cos(angle(mid)) >= 0;
      svg.appendChild(svgEl('line', { x1, y1, x2, y2, stroke: '#cbd5e1', 'stroke-width': 1 }));
      const text = svgEl('text', {
        x: x2 + (right ? 4 : -4), y: y2,
        'text-anchor': right ? 'start' : 'end', 'dominant-baseline': 'middle',
        'font-size': 10, fill: '#1f2937',
      }, f.name.length > 22 ? `${f.name.slice(0, 21)}…` : f.name);
      svg.appendChild(this._attach(text, f));
    });

    // Restriction sites inside the circle. Labels sit on alternating radii and
    // are pushed apart when neighbours would otherwise overlap.
    const siteByPos = new Map();
    for (const s of labelledSites) {
      siteByPos.set(s.cut_top, (siteByPos.get(s.cut_top) || []).concat(s));
    }
    const positions = [...siteByPos.keys()].sort((a, b) => a - b);
    const minGap = (n / 360) * 14;     // ~14 degrees between labels
    let lastLabelled = -Infinity;
    let tier = 0;
    positions.forEach((pos) => {
      const [x1, y1] = point(pos, r - 4);
      const [x2, y2] = point(pos, r - 11);
      svg.appendChild(svgEl('line', { x1, y1, x2, y2, stroke: '#b45309', 'stroke-width': 1.5 }));
      // Each label that is still too close to the previous one steps to the
      // next ring inwards, so a run of nearby sites fans out instead of
      // stacking on one radius.
      tier = pos - lastLabelled < minGap ? (tier + 1) % 3 : 0;
      const labelR = r - (36 + tier * 16);
      const [lx, ly] = point(pos, labelR);
      const right = Math.cos(angle(pos)) >= 0;
      const here = siteByPos.get(pos);
      svg.appendChild(this._attachSite(svgEl('text', {
        x: lx, y: ly, 'text-anchor': right ? 'start' : 'end', 'dominant-baseline': 'middle',
        'font-size': 9, fill: '#b45309',
      }, `${here.slice(0, 2).map((s) => s.enzyme).join(',')} ${pos + 1}`), here[0]));
      lastLabelled = pos;
    });

    svg.appendChild(svgEl('text', {
      x: cx, y: cy - 8, 'text-anchor': 'middle', 'font-size': 15, 'font-weight': 600, fill: '#1f2937',
    }, doc.name.length > 26 ? `${doc.name.slice(0, 25)}…` : doc.name));
    svg.appendChild(svgEl('text', {
      x: cx, y: cy + 12, 'text-anchor': 'middle', 'font-size': 12, fill: '#6b7280',
    }, `${fmt(n)} bp`));
    return svg;
  }

  /* --- linear ----------------------------------------------------------- */

  _linear(doc, sites, selection) {
    const n = doc.sequence.length;
    const width = 760;
    const padX = 40;
    const usable = width - padX * 2;
    const x = (pos) => padX + (pos / n) * usable;

    const lanes = [];
    const placed = new Map();
    for (const f of [...doc.features].sort((a, b) => a.start - b.start)) {
      let lane = 0;
      while ((lanes[lane] || []).some(([s, e]) => s < f.end && f.start < e)) lane++;
      lanes[lane] = (lanes[lane] || []).concat([[f.start, f.end]]);
      placed.set(f.id, lane);
    }
    const laneCount = Math.max(1, lanes.length);
    const height = 110 + laneCount * 26;
    const axisY = 70;

    const svg = svgEl('svg', { viewBox: `0 0 ${width} ${height}`, width, height,
      role: 'img', 'aria-label': `Linear map of ${doc.name}` });

    if (selection && selection.end > selection.start) {
      svg.appendChild(svgEl('rect', {
        x: x(selection.start), y: axisY - 14, width: Math.max(1, x(selection.end) - x(selection.start)),
        height: 28, fill: '#bfdbfe', opacity: '.6',
      }));
    }

    svg.appendChild(svgEl('line', { x1: padX, y1: axisY, x2: width - padX, y2: axisY,
      stroke: '#9ca3af', 'stroke-width': 3 }));

    const step = Math.max(100, Math.round(n / 10 / 100) * 100);
    for (let pos = 0; pos <= n; pos += step) {
      svg.appendChild(svgEl('line', { x1: x(pos), y1: axisY + 4, x2: x(pos), y2: axisY + 10,
        stroke: '#9ca3af', 'stroke-width': 1 }));
      svg.appendChild(svgEl('text', { x: x(pos), y: axisY + 22, 'text-anchor': 'middle',
        'font-size': 9, fill: '#6b7280' }, String(pos)));
    }

    for (const f of doc.features) {
      const lane = placed.get(f.id) || 0;
      const y = axisY + 36 + lane * 26;
      const x1 = x(f.start);
      const x2 = Math.max(x1 + 3, x(f.end > f.start ? f.end : n));
      const h = 14;
      const tip = Math.min(9, Math.max(0, (x2 - x1) / 2));
      const points = f.strand === -1
        ? `${x1 + tip},${y} ${x2},${y} ${x2},${y + h} ${x1 + tip},${y + h} ${x1},${y + h / 2}`
        : `${x1},${y} ${x2 - tip},${y} ${x2},${y + h / 2} ${x2 - tip},${y + h} ${x1},${y + h}`;
      svg.appendChild(this._attach(svgEl('polygon', {
        points, fill: featureColor(f), stroke: '#ffffff', 'stroke-width': .5,
      }), f));
      if (x2 - x1 > 34) {
        svg.appendChild(this._attach(svgEl('text', {
          x: (x1 + x2) / 2, y: y + h / 2 + 1, 'text-anchor': 'middle', 'dominant-baseline': 'middle',
          'font-size': 9, fill: '#111827',
        }, f.name.length > 24 ? `${f.name.slice(0, 23)}…` : f.name), f));
      }
    }

    const byPos = new Map();
    for (const s of this._labelSites(sites)) {
      byPos.set(s.cut_top, (byPos.get(s.cut_top) || []).concat(s));
    }
    let flip = 0;
    for (const [pos, here] of byPos) {
      const y = 20 + (flip++ % 2) * 16;
      svg.appendChild(svgEl('line', { x1: x(pos), y1: y + 8, x2: x(pos), y2: axisY - 8,
        stroke: '#b45309', 'stroke-width': 1 }));
      svg.appendChild(this._attachSite(svgEl('text', { x: x(pos), y, 'text-anchor': 'middle',
        'font-size': 9, fill: '#b45309' }, `${here[0].enzyme} ${pos + 1}`), here[0]));
    }

    svg.appendChild(svgEl('text', { x: padX, y: height - 8, 'font-size': 11, fill: '#6b7280' },
      `${doc.name} — ${fmt(n)} bp, linear`));
    return svg;
  }

  /** The current map as a standalone SVG file. */
  toSVGString() {
    const svg = this.container.querySelector('svg');
    if (!svg) return null;
    const clone = svg.cloneNode(true);
    clone.setAttribute('xmlns', SVGNS);
    return `<?xml version="1.0" encoding="UTF-8"?>\n${clone.outerHTML}`;
  }
}
