"""
Restriction enzymes: site finding, digests, silent-site and diagnostic-digest search.

Enzyme data (recognition sites, cut offsets, suppliers) comes from REBASE via
Bio.Restriction. Cut positions use the REBASE convention: for a site matched
on the top strand at index p, the top strand is cut at p + fst5 and the
bottom strand at p + size + fst3.
"""

import itertools
import re
from typing import Any, Dict, Iterable, List, Optional, Tuple

from Bio import Restriction as R

from .model import IUPAC_REGEX, reverse_complement
from .translate import CODON_TABLE, SYNONYMOUS

# A practical everyday set, in the spirit of ApE's Default_Enzymes list.
DEFAULT_ENZYMES = [
    'AatII', 'AflII', 'AgeI', 'ApaI', 'AscI', 'AvrII', 'BamHI', 'BbsI', 'BglII', 'BsaI', 'BsmBI',
    'BspHI', 'BsrGI', 'BstBI', 'ClaI', 'DraI', 'EcoRI', 'EcoRV', 'FseI', 'HindIII', 'HpaI', 'KpnI',
    'MfeI', 'MluI', 'NcoI', 'NdeI', 'NheI', 'NotI', 'NruI', 'NsiI', 'PacI', 'PmeI', 'PstI', 'PvuI',
    'PvuII', 'SacI', 'SacII', 'SalI', 'SapI', 'ScaI', 'SbfI', 'SmaI', 'SpeI', 'SphI', 'StuI',
    'SwaI', 'XbaI', 'XhoI', 'XmaI', 'BspQI', 'PaqCI', 'BpiI', 'Esp3I',
]

TYPE_IIS_GOLDEN_GATE = ['BsaI', 'BsmBI', 'Esp3I', 'BbsI', 'BpiI', 'SapI', 'BspQI', 'PaqCI', 'AarI']

LADDERS = {
    '1 kb ladder': [10000, 8000, 6000, 5000, 4000, 3000, 2000, 1500, 1000, 500],
    '1 kb Plus ladder': [15000, 10000, 8000, 7000, 6000, 5000, 4000, 3000, 2000, 1500, 1000, 700, 500, 400, 300, 200, 75],
    '100 bp ladder': [1517, 1200, 1000, 900, 800, 700, 600, 500, 400, 300, 200, 100],
    'Lambda HindIII': [23130, 9416, 6557, 4361, 2322, 2027, 564],
}


def _all_enzymes() -> Dict[str, Any]:
    return {str(e): e for e in R.AllEnzymes}


_ENZYMES = _all_enzymes()


def enzyme_sets() -> Dict[str, List[str]]:
    return {
        'Default': [e for e in DEFAULT_ENZYMES if e in _ENZYMES],
        'Golden Gate (Type IIS)': [e for e in TYPE_IIS_GOLDEN_GATE if e in _ENZYMES],
        'Commercially available': sorted(str(e) for e in R.CommOnly),
        'All REBASE': sorted(_ENZYMES),
    }


def enzyme_names() -> set:
    """Every enzyme name known, from REBASE."""
    return set(_ENZYMES)


_CATALOG: Optional[List[Dict[str, Any]]] = None


def enzyme_catalog() -> List[Dict[str, Any]]:
    """
    Every enzyme, for choosing from: its recognition site, the ends it leaves,
    and whether a supplier sells it. Worked out once; REBASE does not change
    while the program runs.
    """
    global _CATALOG
    if _CATALOG is None:
        commercial = {str(e) for e in R.CommOnly}
        catalog = []
        for name in sorted(_ENZYMES, key=str.casefold):
            e = _ENZYMES[name]
            ends = 'blunt' if e.is_blunt() else "5'" if e.is_5overhang() else "3'" if e.is_3overhang() else '?'
            catalog.append({'name': name, 'site': e.site, 'ends': ends,
                            'commercial': name in commercial})
        _CATALOG = catalog
    return _CATALOG


def get_enzyme(name: str):
    enz = _ENZYMES.get(name)
    if enz is None:
        raise ValueError(f'unknown enzyme: {name}')
    return enz


def enzyme_info(name: str) -> Dict[str, Any]:
    e = get_enzyme(name)
    return {
        'name': name, 'site': e.site, 'size': e.size,
        'fst5': e.fst5, 'fst3': e.fst3, 'overhang': e.ovhg,
        'ends': 'blunt' if e.is_blunt() else ("5'" if e.is_5overhang() else ("3'" if e.is_3overhang() else 'unknown')),
        'suppliers': sorted(e.supplier_list()) if hasattr(e, 'supplier_list') else [],
        'elucidate': e.elucidate(),
    }


def _site_regex(site: str) -> str:
    return ''.join(IUPAC_REGEX.get(c, c) for c in site.upper())


def _cuts_for_match(e, p: int, reverse: bool) -> Optional[Tuple[int, int]]:
    """(top, bottom) cut indices on the forward strand for a site starting at p."""
    if e.fst5 is None or e.fst3 is None or e.is_unknown():
        return None
    t, b = e.fst5, e.size + e.fst3
    if not reverse:
        return p + t, p + b
    return p + e.size - b, p + e.size - t


def find_sites(seq: str, enzymes: Iterable[str], circular: bool = False) -> List[Dict[str, Any]]:
    """
    Every recognition site of the given enzymes.

    Each hit: enzyme, start (0-based, may wrap on circular), end, strand,
    cut_top, cut_bottom (forward-strand indices, None when off the end of a
    linear sequence or unknown).
    """
    seq = seq.upper()
    n = len(seq)
    hits = []
    for name in enzymes:
        e = get_enzyme(name)
        size = e.size
        if size > n:
            continue
        search = seq + seq[:size - 1] if circular else seq
        site_rc = reverse_complement(e.site)
        patterns = [(False, _site_regex(e.site))]
        if site_rc != e.site:
            patterns.append((True, _site_regex(site_rc)))
        for reverse, pat in patterns:
            for m in re.finditer(f'(?={pat})', search):
                p = m.start()
                if p >= n:
                    continue
                cuts = _cuts_for_match(e, p, reverse)
                ct = cb = None
                if cuts:
                    ct, cb = cuts
                    if circular:
                        ct, cb = ct % n, cb % n
                    elif not (0 < ct < n and 0 < cb < n):
                        ct = cb = None
                hits.append({'enzyme': name, 'start': p, 'end': (p + size) % n if circular else p + size,
                             'strand': -1 if reverse else 1, 'cut_top': ct, 'cut_bottom': cb})
    hits.sort(key=lambda h: (h['start'], h['enzyme']))
    return hits


def site_counts(seq: str, enzymes: Iterable[str], circular: bool = False) -> Dict[str, int]:
    counts = {e: 0 for e in enzymes}
    for h in find_sites(seq, counts.keys(), circular):
        counts[h['enzyme']] += 1
    return counts


# ---------------------------------------------------------------------------
# Digests
# ---------------------------------------------------------------------------

def _end(seq2: str, t: int, b: int, enzyme: str) -> Dict[str, Any]:
    """Describe a cut end. seq2 is the (possibly doubled) sequence t/b index into."""
    if t == b:
        return {'enzyme': enzyme, 'kind': 'blunt', 'overhang': ''}
    lo, hi = min(t, b), max(t, b)
    return {'enzyme': enzyme, 'kind': "5'" if b > t else "3'", 'overhang': seq2[lo:hi]}


def digest(seq: str, enzymes: Iterable[str], circular: bool = False) -> List[Dict[str, Any]]:
    """
    Cut a sequence with one or more enzymes.

    Each fragment carries its top strand (`top`), the forward reading of its
    bottom strand (`bottom`), start/end on the top strand, length and the two
    sticky ends, so fragments can be re-ligated by the assembly tools.
    """
    seq = seq.upper()
    n = len(seq)
    cuts = {}
    for h in find_sites(seq, enzymes, circular):
        if h['cut_top'] is not None:
            cuts.setdefault(h['cut_top'], (h['cut_top'], h['cut_bottom'], h['enzyme']))
    if not cuts:
        whole = {'start': 0, 'end': n, 'length': n, 'top': seq, 'bottom': seq,
                 'left': None, 'right': None, 'circular': circular}
        return [whole]

    ordered = [cuts[k] for k in sorted(cuts)]
    frags = []
    if circular:
        seq2 = seq * 3
        def offset(t, b):
            # Signed bottom-minus-top cut distance; the two cuts are always close.
            return (b - t + n // 2) % n - n // 2

        for i, (t0, b0, e0) in enumerate(ordered):
            t1, b1, e1 = ordered[(i + 1) % len(ordered)]
            # Lift into the middle copy of seq2 so every index is positive.
            T0 = t0 + n
            T1 = t1 + n if t1 > t0 else t1 + 2 * n
            B0, B1 = T0 + offset(t0, b0), T1 + offset(t1, b1)
            frags.append({'start': t0, 'end': t1, 'length': T1 - T0,
                          'top': seq2[T0:T1], 'bottom': seq2[B0:B1],
                          'left': _end(seq2, T0, B0, e0), 'right': _end(seq2, T1, B1, e1), 'circular': False})
    else:
        bounds = [(0, 0, None)] + ordered + [(n, n, None)]
        for (t0, b0, e0), (t1, b1, e1) in zip(bounds, bounds[1:]):
            frags.append({'start': t0, 'end': t1, 'length': t1 - t0,
                          'top': seq[t0:t1], 'bottom': seq[b0:b1],
                          'left': _end(seq, t0, b0, e0) if e0 else None,
                          'right': _end(seq, t1, b1, e1) if e1 else None, 'circular': False})
    return frags


def gel_lanes(lanes: List[Dict[str, Any]], ladder: str = '1 kb ladder') -> Dict[str, Any]:
    """Band sizes for a virtual gel; bands of near-identical size are merged and counted."""
    out = []
    for lane in lanes:
        sizes = sorted((f['length'] for f in lane['fragments']), reverse=True)
        bands = []
        for s in sizes:
            if bands and abs(bands[-1]['size'] - s) / max(s, 1) < 0.02:
                bands[-1]['count'] += 1
            else:
                bands.append({'size': s, 'count': 1})
        out.append({'label': lane['label'], 'bands': bands})
    return {'ladder': {'label': ladder, 'bands': [{'size': s, 'count': 1} for s in LADDERS[ladder]]},
            'lanes': out}


# ---------------------------------------------------------------------------
# Silent sites (introduce a site without changing the protein)
# ---------------------------------------------------------------------------

def silent_sites(seq: str, cds_start: int, cds_end: int, enzymes: Iterable[str],
                 max_changes: int = 2, circular: bool = False) -> List[Dict[str, Any]]:
    """
    Recognition sites that can be created inside a reading frame with at most
    `max_changes` synonymous base changes. cds_start/cds_end bound the coding
    region on the top strand (in frame from cds_start).
    """
    seq = seq.upper()
    region = seq[cds_start:cds_end]
    codons = [region[i:i + 3] for i in range(0, len(region) - len(region) % 3, 3)]
    if not codons:
        return []
    coding_len = len(codons) * 3
    existing = site_counts(seq, enzymes, circular)
    results = []
    for name in enzymes:
        e = get_enzyme(name)
        sites = {e.site.upper(), reverse_complement(e.site.upper())}
        for site in sites:
            allowed = [set(re.sub(r'[\[\]]', '', IUPAC_REGEX[c])) for c in site]
            for p in range(0, coding_len - len(site) + 1):
                first_codon, last_codon = p // 3, (p + len(site) - 1) // 3
                new_codons, changes, ok = [], 0, True
                for ci in range(first_codon, last_codon + 1):
                    orig = codons[ci]
                    aa = CODON_TABLE.get(orig)
                    if aa is None:
                        ok = False
                        break
                    best = None
                    for cand in SYNONYMOUS[aa]:
                        if all(cand[k] in allowed[ci * 3 + k - p] for k in range(3) if 0 <= ci * 3 + k - p < len(site)):
                            d = sum(a != b for a, b in zip(cand, orig))
                            if best is None or d < best[0]:
                                best = (d, cand)
                    if best is None:
                        ok = False
                        break
                    changes += best[0]
                    new_codons.append(best[1])
                if not ok or changes == 0 or changes > max_changes:
                    continue
                cstart = first_codon * 3
                old = ''.join(codons[first_codon:last_codon + 1])
                new = ''.join(new_codons)
                results.append({
                    'enzyme': name, 'site': e.site, 'position': cds_start + p, 'changes': changes,
                    'replace_start': cds_start + cstart, 'replace_end': cds_start + cstart + len(old),
                    'old': old, 'new': new, 'existing_sites': existing[name],
                    'unique_after': existing[name] == 0,
                })
    seen, unique = set(), []
    for r in sorted(results, key=lambda r: (not r['unique_after'], r['changes'], r['position'])):
        key = (r['enzyme'], r['replace_start'], r['new'])
        if key not in seen:
            seen.add(key)
            unique.append(r)
    return unique


# ---------------------------------------------------------------------------
# Diagnostic digests
# ---------------------------------------------------------------------------

def _pattern(doc: Dict[str, Any], enzymes) -> List[int]:
    return sorted((f['length'] for f in digest(doc['sequence'], enzymes, doc.get('circular', False))), reverse=True)


def _resolvable(sizes: List[int], min_size: int) -> bool:
    if any(s < min_size for s in sizes):
        return False
    return all(abs(a - b) / a > 0.1 for a, b in zip(sizes, sizes[1:]))


def _distinct(p1: List[int], p2: List[int]) -> bool:
    if len(p1) != len(p2):
        return True
    return any(abs(a - b) / max(a, b) > 0.1 for a, b in zip(p1, p2))


def diagnostic_digests(docs: List[Dict[str, Any]], enzymes: List[str], max_enzymes: int = 2,
                       min_bands: int = 2, max_bands: int = 5, min_size: int = 250,
                       limit: int = 30) -> List[Dict[str, Any]]:
    """
    Enzyme combinations whose band patterns are easy to read on a gel and,
    with more than one sequence, tell the sequences apart.
    """
    cutters = [e for e in enzymes if any(site_counts(d['sequence'], [e], d.get('circular')).get(e) for d in docs)]
    out = []
    for k in range(1, max_enzymes + 1):
        for combo in itertools.combinations(cutters, k):
            patterns = [_pattern(d, combo) for d in docs]
            if not all(min_bands <= len(p) <= max_bands and _resolvable(p, min_size) for p in patterns):
                continue
            if len(docs) > 1 and not all(_distinct(a, b) for a, b in itertools.combinations(patterns, 2)):
                continue
            score = sum(len(p) for p in patterns) + 2 * (k - 1)
            out.append({'enzymes': list(combo), 'patterns': [{'name': d['name'], 'bands': p} for d, p in zip(docs, patterns)],
                        'score': score})
    out.sort(key=lambda r: (r['score'], r['enzymes']))
    return out[:limit]
