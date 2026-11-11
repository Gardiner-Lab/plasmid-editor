"""
In-silico cloning: restriction-ligation, Golden Gate, Gibson / In-Fusion
overlap assembly, and site-specific recombination (Gateway BP/LR, Cre/lox).

All functions take and return plain documents (see dnakit.model), carrying
features across into the products.
"""

import re
from typing import Any, Dict, List, Optional, Tuple

from .model import make_document, new_id, reverse_complement
from .primers import tm
from .restriction import digest, find_sites


# ---------------------------------------------------------------------------
# Feature transfer helpers
# ---------------------------------------------------------------------------

def _features_in(doc: Dict[str, Any], start: int, length: int) -> List[Dict[str, Any]]:
    """Features wholly inside doc[start:start+length] (wrapping), re-based to 0."""
    n = len(doc['sequence'])
    out = []
    for f in doc.get('features', []):
        if f.get('segments'):
            continue
        flen = (f['end'] - f['start']) % n or n
        rel = (f['start'] - start) % n if doc.get('circular') or f['start'] >= start else f['start'] - start
        if rel < 0 or rel + flen > length:
            continue
        g = {k: v for k, v in f.items() if k != 'segments'}
        g.update(id=new_id(), start=rel, end=rel + flen)
        out.append(g)
    return out


def _flip(features: List[Dict[str, Any]], length: int) -> List[Dict[str, Any]]:
    return [dict(f, start=length - f['end'], end=length - f['start'], strand=-f.get('strand', 1)) for f in features]


def _shift(features: List[Dict[str, Any]], by: int, total: int, circular: bool) -> List[Dict[str, Any]]:
    out = []
    for f in features:
        s, e = f['start'] + by, f['end'] + by
        if circular:
            s, e = s % total, e % total or total
            if s == total:
                s = 0
        out.append(dict(f, start=s, end=e))
    return out


def _dedupe_features(features: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    seen, out = set(), []
    for f in features:
        key = (f['name'], f['start'], f['end'], f.get('strand'))
        if key not in seen:
            seen.add(key)
            out.append(f)
    return out


# ---------------------------------------------------------------------------
# Sticky-end ligation engine
# ---------------------------------------------------------------------------

def fragments_from(doc: Dict[str, Any], enzymes: List[str]) -> List[Dict[str, Any]]:
    """Digest a document and attach source name and features to each fragment."""
    frags = digest(doc['sequence'], enzymes, doc.get('circular', False))
    for i, fr in enumerate(frags):
        fr['source'] = doc['name']
        fr['index'] = i
        fr['features'] = _features_in(doc, fr['start'], fr['length'])
    return frags


def _oriented(fr: Dict[str, Any], reverse: bool) -> Dict[str, Any]:
    if not reverse:
        return dict(fr, reversed=False)
    flip_end = lambda e: e and dict(e, overhang=reverse_complement(e['overhang']))
    return dict(fr, top=reverse_complement(fr['bottom']), bottom=reverse_complement(fr['top']),
                left=flip_end(fr['right']), right=flip_end(fr['left']),
                features=_flip(fr['features'], len(fr['top'])), reversed=True)


def _compatible(right: Optional[Dict[str, Any]], left: Optional[Dict[str, Any]]) -> bool:
    if not right or not left or right['kind'] != left['kind']:
        return False
    return right['overhang'] == left['overhang']


def ligate(fragments: List[Dict[str, Any]], name: str = 'Ligation product',
           require_all: bool = True, max_products: int = 20) -> List[Dict[str, Any]]:
    """
    Every circular product formed by joining fragments end-to-end through
    matching sticky ends. The first fragment is kept in forward orientation (it
    defines the product's origin); the others may be flipped.
    """
    if not fragments:
        return []
    products = []
    first = _oriented(fragments[0], False)
    rest = list(range(1, len(fragments)))

    def extend(path: List[Dict[str, Any]], remaining: List[int]):
        if len(products) >= max_products:
            return
        last = path[-1]
        if _compatible(last['right'], path[0]['left']) and (not require_all or not remaining):
            products.append(list(path))
        for idx in remaining:
            for rev in (False, True):
                cand = _oriented(fragments[idx], rev)
                if _compatible(last['right'], cand['left']):
                    extend(path + [cand], [r for r in remaining if r != idx])

    extend([first], rest)

    out = []
    for path in products:
        seq, feats, parts = '', [], []
        for fr in path:
            # Top strands concatenate exactly when the overhangs match (see digest()).
            feats += _shift(fr['features'], len(seq), 0, False)
            parts.append({'source': fr['source'], 'index': fr['index'], 'length': len(fr['top']),
                          'reversed': fr['reversed'], 'start': len(seq)})
            seq += fr['top']
        doc = make_document(name, seq, True, _dedupe_features(feats))
        doc['assembly'] = parts
        out.append(doc)
    return out


def restriction_ligation(vector: Dict[str, Any], vector_enzymes: List[str], vector_fragment: int,
                         insert: Dict[str, Any], insert_enzymes: List[str], insert_fragment: int,
                         name: str = 'Ligation product') -> List[Dict[str, Any]]:
    vf = fragments_from(vector, vector_enzymes)[vector_fragment]
    inf = fragments_from(insert, insert_enzymes)[insert_fragment]
    return ligate([vf, inf], name=name)


def golden_gate(parts: List[Dict[str, Any]], enzyme: str = 'BsaI',
                name: str = 'Golden Gate product') -> Dict[str, Any]:
    """
    One-pot Type IIS assembly. From each input the fragments that no longer
    carry a site for the enzyme are kept (inserts released from their donors,
    the acceptor backbone minus its dropout), then joined through their
    overhangs. Returns products plus a per-part log for troubleshooting.
    """
    pool, log = [], []
    for doc in parts:
        frags = fragments_from(doc, [enzyme])
        sites = find_sites(doc['sequence'], [enzyme], doc.get('circular', False))
        if not sites:
            log.append({'part': doc['name'], 'status': 'no site', 'kept': []})
            continue
        kept = [f for f in frags if f['left'] and f['right']
                and not find_sites(f['top'], [enzyme], False)]
        pool.extend(kept)
        log.append({'part': doc['name'], 'status': 'ok' if kept else 'no usable fragment',
                    'kept': [{'length': f['length'], 'left': f['left']['overhang'], 'right': f['right']['overhang']}
                             for f in kept]})
    # Start from the largest fragment (normally the backbone) so the product
    # origin is stable; try to use one fragment per input part.
    pool.sort(key=lambda f: -f['length'])
    products = []
    for p in ligate(pool, name=name, require_all=False, max_products=50):
        used = {a['source'] for a in p['assembly']}
        if len(used) == len({f['source'] for f in pool}):
            products.append(p)
    products.sort(key=lambda p: len(p['assembly']))
    return {'products': products[:5], 'log': log}


# ---------------------------------------------------------------------------
# Overlap assembly (Gibson, In-Fusion, HiFi)
# ---------------------------------------------------------------------------

def _overlap(a: str, b: str, min_len: int, max_len: int) -> int:
    """Longest suffix of a that equals a prefix of b."""
    for k in range(min(max_len, len(a), len(b)), min_len - 1, -1):
        if a[-k:] == b[:k]:
            return k
    return 0


def overlap_assembly(fragments: List[Dict[str, Any]], circular: bool = True, min_overlap: int = 15,
                     max_overlap: int = 200, name: str = 'Gibson product') -> Dict[str, Any]:
    """
    Join fragments in the given order through terminal homology. A fragment
    is flipped automatically when only its reverse complement overlaps.
    """
    if len(fragments) < (1 if circular else 2):
        raise ValueError('need at least two fragments' if not circular else 'need at least one fragment')
    oriented = [dict(fragments[0], sequence=fragments[0]['sequence'].upper(), _rev=False)]
    junctions = []
    for fr in fragments[1:]:
        prev = oriented[-1]['sequence']
        fwd = fr['sequence'].upper()
        k_f = _overlap(prev, fwd, min_overlap, max_overlap)
        k_r = _overlap(prev, reverse_complement(fwd), min_overlap, max_overlap)
        if not k_f and not k_r:
            raise ValueError(f'no overlap of at least {min_overlap} bp between "{oriented[-1]["name"]}" and "{fr["name"]}"')
        rev = k_r > k_f
        oriented.append(dict(fr, sequence=reverse_complement(fwd) if rev else fwd, _rev=rev))
        k = max(k_f, k_r)
        junctions.append({'left': oriented[-2]['name'], 'right': fr['name'], 'overlap': k,
                          'tm': tm(prev[-k:]), 'sequence': prev[-k:], 'flipped': rev})
    closing = 0
    if circular:
        closing = _overlap(oriented[-1]['sequence'], oriented[0]['sequence'], min_overlap, max_overlap) \
            if len(oriented) > 1 else _overlap(oriented[0]['sequence'], oriented[0]['sequence'][:max_overlap],
                                               min_overlap, max_overlap)
        if not closing:
            raise ValueError('the last fragment does not overlap the first; cannot circularise')
        cs = oriented[-1]['sequence'][-closing:]
        junctions.append({'left': oriented[-1]['name'], 'right': oriented[0]['name'], 'overlap': closing,
                          'tm': tm(cs), 'sequence': cs, 'flipped': False})

    seq, feats, parts = '', [], []
    for i, fr in enumerate(oriented):
        s = fr['sequence']
        trim = junctions[i - 1]['overlap'] if i > 0 else 0
        body = s[trim:]
        if circular and i == len(oriented) - 1:
            body = body[:len(body) - closing] if closing else body
        ff = fr.get('features') or []
        if fr['_rev']:
            ff = _flip(ff, len(s))
        ff = [f for f in ff if f['end'] > f['start'] and f['start'] >= trim]
        feats += _shift(ff, len(seq) - trim, 0, False)
        parts.append({'source': fr['name'], 'start': len(seq), 'length': len(body), 'reversed': fr['_rev']})
        seq += body
    feats = [f for f in feats if f['end'] <= len(seq)]
    doc = make_document(name, seq, circular, _dedupe_features(feats))
    doc['assembly'] = parts
    return {'product': doc, 'junctions': junctions}


# ---------------------------------------------------------------------------
# Site-specific recombination (Gateway BP / LR, Cre-lox, FLP-FRT)
# ---------------------------------------------------------------------------

def _shared_blocks(a: str, b: str, min_len: int, max_len: int, circular_b: bool,
                   circular_a: bool = False) -> List[Tuple[int, int, int]]:
    """
    Maximal exact matches (pos_a, pos_b, length) with min_len <= length <= max_len. A circular
    sequence is searched past its origin as well, so a core that spans it is found.
    """
    k = min_len
    aa = a + a[:max_len] if circular_a else a
    bb = b + b[:max_len] if circular_b else b
    index: Dict[str, List[int]] = {}
    for i in range(len(a) if circular_a else max(0, len(a) - k + 1)):
        index.setdefault(aa[i:i + k], []).append(i)
    blocks = []
    for j in range(len(b) if circular_b else max(0, len(b) - k + 1)):
        for i in index.get(bb[j:j + k], ()):
            before_a = aa[i - 1] if i else (a[-1] if circular_a else None)
            before_b = bb[j - 1] if j else (b[-1] if circular_b else None)
            if before_a is not None and before_a == before_b:
                continue  # not left-maximal
            L = k
            while i + L < len(aa) and j + L < len(bb) and aa[i + L] == bb[j + L]:
                L += 1
            if L <= max_len:
                blocks.append((i, j, L))
    return blocks


# Features that name a recombination site, to tell a real crossover from a stretch two
# plasmids merely share (a pUC origin, a resistance gene - often longer than the att core).
_SITE_LABEL = re.compile(r'\batt[BPLR]\d?\b|\blox[\w-]*|\bFRT\b|\brox\b', re.I)


def _at_site(doc: Dict[str, Any], pos: int, length: int) -> bool:
    """Whether doc[pos:pos+length] touches a feature labelled as a recombination site."""
    n = len(doc['sequence'])
    if not n:
        return False
    core = {(pos + k) % n for k in range(length)}
    for f in doc.get('features') or []:
        if not _SITE_LABEL.search(str(f.get('label') or f.get('name') or '')):
            continue
        flen = (f['end'] - f['start']) % n or n
        if core & {(f['start'] + k) % n for k in range(flen)}:
            return True
    return False


def recombine(donor: Dict[str, Any], acceptor: Dict[str, Any], min_core: int = 15,
              max_core: int = 60, name: str = 'Recombination product') -> List[Dict[str, Any]]:
    """
    Double crossover through two short shared core sequences, as in
    Gateway LR (attL x attR) and BP (attB x attP) reactions or Cre-lox
    exchange. The region of the donor between the two cores replaces the
    corresponding region of the acceptor. Long homology (shared backbone
    elements such as an origin) is ignored via max_core.

    A circular donor is read round its origin, so the piece carried over is the same wherever the
    file happens to start, and both pieces between the cores are offered: in an LR reaction that is
    the expression clone and the by-product. Each product keeps the features of whichever parent
    contributed the bases.

    ``min_core`` is the identity two partner sites must share, which is shorter than the sites
    themselves: a Gateway attL and its attR share only the att core, 15 bp at att1 and 19 bp at att2,
    though each att site is 100+ bp. loxP and FRT share all 34 bp. So the default is 15; much below
    that matches by chance. Two plasmids also share whatever backbone they have in common (a pUC
    origin, a marker), and such a stretch can be longer than an att core, so products whose both
    crossovers fall in features named as recombination sites (att, lox, FRT) are listed first and
    carry ``at_sites``.
    """
    a = donor['sequence'].upper()
    b_fwd = acceptor['sequence'].upper()
    na = len(a)
    donor_circular = bool(donor.get('circular'))
    acceptor_circular = bool(acceptor.get('circular'))
    results = []
    for flipped in (False, True):
        b = reverse_complement(b_fwd) if flipped else b_fwd
        nb = len(b)
        acc = (dict(acceptor, sequence=b, features=_flip(acceptor.get('features') or [], nb))
               if flipped else acceptor)
        blocks = _shared_blocks(a, b, min_core, max_core, acceptor_circular, donor_circular)
        for x in blocks:
            for y in blocks:
                if y[1] == x[1] or y[0] % na == x[0] % na:
                    continue
                # The donor segment carried over, from core x through core y. A circular donor has two
                # such segments for a pair of cores: the one running past its origin counts as well.
                ai0 = x[0] % na
                if donor_circular:
                    span = ((y[0] + y[2]) - x[0]) % na or na
                    if span < x[2] + y[2]:
                        continue            # the cores would overlap: not a crossover
                    insert = (a + a)[ai0:ai0 + span]
                else:
                    if y[0] <= x[0] + x[2]:
                        continue
                    span = (y[0] + y[2]) - x[0]
                    insert = a[ai0:ai0 + span]
                bj0, bj1 = x[1] % nb, (y[1] + y[2]) % nb
                feats = _features_in(donor, ai0, span)
                if acceptor_circular:
                    kept = (bj0 - bj1) % nb
                    product = insert + (b + b)[bj1:bj1 + kept]
                    feats += _shift(_features_in(acc, bj1, kept), span, span + kept, True)
                else:
                    if bj1 <= bj0:
                        continue
                    product = b[:bj0] + insert + b[bj1:]
                    feats = (_features_in(acc, 0, bj0) + _shift(feats, bj0, 0, False)
                             + _shift(_features_in(acc, bj1, nb - bj1), bj0 + span, 0, False))
                # A crossover through a named site in either parent is a real one, so a file that
                # annotates only one of the two still ranks its products first.
                at_sites = all(_at_site(donor, c[0], c[2]) or _at_site(acc, c[1], c[2]) for c in (x, y))
                results.append({
                    'core_1': a[x[0] % na:x[0] % na + x[2]] if x[0] + x[2] <= na else (a + a)[x[0]:x[0] + x[2]],
                    'core_2': a[y[0] % na:y[0] % na + y[2]] if y[0] + y[2] <= na else (a + a)[y[0]:y[0] + y[2]],
                    'at_sites': at_sites,
                    'acceptor_flipped': flipped, 'length': len(product),
                    'from_donor': span, 'from_acceptor': len(product) - span,
                    'document': make_document(name, product, acceptor_circular, _dedupe_features(feats)),
                })
    # Crossovers through named sites first (an att core is often shorter than a shared backbone
    # stretch), then the biggest cores, then the product that keeps most of the acceptor.
    results.sort(key=lambda r: (not r['at_sites'], -len(r['core_1']) - len(r['core_2']), -r['from_acceptor']))
    seen, unique = set(), []
    for r in results:
        if r['document']['sequence'] not in seen:
            seen.add(r['document']['sequence'])
            unique.append(r)
    return unique[:10]
