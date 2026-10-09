"""
Oligo tools: melting temperature, primer binding sites, PCR simulation and primer design.
"""

from typing import Any, Dict, List, Optional

from Bio.SeqUtils import MeltingTemp as mt

from .model import clean_sequence, reverse_complement


def tm(oligo: str, na_mm: float = 50.0, mg_mm: float = 1.5, dntps_mm: float = 0.2,
       oligo_nm: float = 250.0, method: str = 'nn') -> Optional[float]:
    """Melting temperature. 'nn' = nearest-neighbour (SantaLucia 1998), 'wallace' = 2(A+T)+4(G+C)."""
    s = clean_sequence(oligo).upper()
    if not s:
        return None
    if method == 'wallace':
        return float(mt.Tm_Wallace(s))
    if any(c not in 'ACGT' for c in s):
        return None
    try:
        return round(float(mt.Tm_NN(s, Na=na_mm, Mg=mg_mm, dNTPs=dntps_mm, dnac1=oligo_nm, dnac2=0,
                                    nn_table=mt.DNA_NN3)), 1)
    except (ValueError, KeyError, ZeroDivisionError):
        return None


def gc_content(seq: str) -> float:
    s = seq.upper()
    return round(100.0 * sum(c in 'GCS' for c in s) / len(s), 1) if s else 0.0


def oligo_report(oligo: str, **kw) -> Dict[str, Any]:
    s = clean_sequence(oligo).upper()
    return {'sequence': s, 'length': len(s), 'gc': gc_content(s), 'tm': tm(s, **kw),
            'tm_wallace': tm(s, method='wallace'),
            'reverse_complement': reverse_complement(s)}


def find_binding_sites(template: str, primer: str, circular: bool = False,
                       min_anneal: int = 15, max_mismatches: int = 0) -> List[Dict[str, Any]]:
    """
    Places a primer anneals: its 3'-most `min_anneal` bases match the template
    (with up to max_mismatches outside the last 3 bases), extended 5' as far as
    it keeps matching. The unmatched 5' part is reported as a tail.

    Forward hits match the top strand; reverse hits match the bottom strand.
    Positions are forward-strand coordinates of the annealed region.
    """
    t = template.upper()
    p = clean_sequence(primer).upper()
    n = len(t)
    if len(p) < min_anneal or n < min_anneal:
        return []
    core = p[-min_anneal:]
    hits = []
    for strand in (1, -1):
        s = t if strand == 1 else reverse_complement(t)
        search = s + s[:len(p) - 1] if circular else s
        for i in range(0, min(n, len(search) - min_anneal + 1)):
            window = search[i:i + min_anneal]
            mism = sum(a != b for a, b in zip(window, core))
            if mism > max_mismatches or window[-3:] != core[-3:]:
                continue
            # Extend toward the primer's 5' end while it matches.
            k = 0
            while (k < len(p) - min_anneal and k < n - min_anneal
                   and (circular or i - k - 1 >= 0)
                   and s[(i - k - 1) % n] == p[-min_anneal - k - 1]):
                k += 1
            anneal_len = min_anneal + k
            start_on_s = (i - k) % n
            end_on_s = start_on_s + anneal_len
            if strand == 1:
                fstart, fend = start_on_s, end_on_s % n if circular else end_on_s
            else:
                fstart, fend = (n - end_on_s) % n, (n - start_on_s) % n or n
            hits.append({'strand': strand, 'start': fstart, 'end': fend, 'anneal_length': anneal_len,
                         'mismatches': mism, 'tail': p[:len(p) - anneal_len],
                         'anneal_tm': tm(p[-anneal_len:])})
    return hits


def pcr(template: str, forward: str, reverse: str, circular: bool = False,
        min_anneal: int = 15, max_mismatches: int = 0) -> List[Dict[str, Any]]:
    """
    Simulate PCR. Returns every product formed by a forward-primer site on the
    top strand and a reverse-primer site on the bottom strand downstream of it.
    Either primer may anneal in either orientation.
    """
    t = template.upper()
    n = len(t)
    f, r = clean_sequence(forward).upper(), clean_sequence(reverse).upper()
    sites = []
    for name, primer in (('forward', f), ('reverse', r)):
        for h in find_binding_sites(t, primer, circular, min_anneal, max_mismatches):
            sites.append(dict(h, primer=name, oligo=primer))
    tops = [s for s in sites if s['strand'] == 1]
    bottoms = [s for s in sites if s['strand'] == -1]
    products = []
    for a in tops:
        for b in bottoms:
            if circular:
                span = (b['end'] - a['start']) % n or n
                inner = (t + t)[a['start']:a['start'] + span]
            else:
                if b['end'] <= a['start']:
                    continue
                inner = t[a['start']:b['end']]
            if len(inner) < max(a['anneal_length'], b['anneal_length']):
                continue
            product = a['tail'] + inner + reverse_complement(b['tail'])
            products.append({'length': len(product), 'sequence': product,
                             'template_start': a['start'], 'template_end': b['end'],
                             'forward_primer': a['primer'], 'reverse_primer': b['primer'],
                             'forward_tail': a['tail'], 'reverse_tail': b['tail']})
    products.sort(key=lambda p: p['length'])
    return products


def _pick(candidates: List[str], target_tm: float) -> Dict[str, Any]:
    best = None
    for c in candidates:
        ctm = tm(c)
        if ctm is None:
            continue
        clamp = c[-1] in 'GC'
        score = abs(ctm - target_tm) - (1.0 if clamp else 0.0) + (1.5 if c[-5:].count('G') + c[-5:].count('C') > 3 else 0)
        if best is None or score < best[0]:
            best = (score, c, ctm)
    if best is None:
        return {}
    return {'sequence': best[1], 'tm': best[2], 'length': len(best[1]), 'gc': gc_content(best[1])}


def design_primers(template: str, start: int, end: int, target_tm: float = 60.0,
                   min_len: int = 18, max_len: int = 32, forward_tail: str = '',
                   reverse_tail: str = '', circular: bool = False) -> Dict[str, Any]:
    """Primers that amplify exactly template[start:end] (wrapping on circular), with optional 5' tails."""
    t = template.upper()
    region = t[start:end] if end > start or not circular else t[start:] + t[:end]
    if len(region) < min_len * 2:
        raise ValueError('region is too short to design a primer pair')
    fwd = _pick([region[:k] for k in range(min_len, min(max_len, len(region)) + 1)], target_tm)
    rc = reverse_complement(region)
    rev = _pick([rc[:k] for k in range(min_len, min(max_len, len(rc)) + 1)], target_tm)
    ftail, rtail = clean_sequence(forward_tail).upper(), clean_sequence(reverse_tail).upper()
    if fwd:
        fwd['full'] = ftail + fwd['sequence']
    if rev:
        rev['full'] = rtail + rev['sequence']
    return {'forward': fwd, 'reverse': rev,
            'product_length': len(ftail) + len(region) + len(rtail),
            'product': ftail + region + reverse_complement(rtail)}
