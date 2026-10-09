"""
Golden Gate / MoClo readiness analysis.

A plasmid is "Golden Gate ready" when a single Type IIS enzyme releases
exactly one insert flanked by two 4 bp overhangs, and the released insert
carries no further site for that enzyme. That insert, with its two overhangs,
is what the MoClo Library Tool stores as a part.
"""

from typing import Any, Dict, List, Optional

from .model import reverse_complement
from .restriction import TYPE_IIS_GOLDEN_GATE, digest, find_sites

# MoClo part types used by the MoClo Library Tool.
PART_TYPES = ['Coding', 'NonCodingPromoter', 'NonCodingTerminator',
              'NonCodingIntron', 'NonCodingOther', 'ExpressionCassette']

# Standard MoClo (Weber et al. 2011) Level 0 fusion sites, for reporting the
# likely part position when the overhangs are the canonical ones.
MOCLO_FUSION_SITES = {
    'GGAG': 'standard Level 0 5\' end (A)', 'TACT': 'promoter / 5U junction (B)',
    'AATG': 'start codon fusion site (C)', 'AGGT': 'CDS internal / C-terminal (D)',
    'GCTT': 'standard Level 0 3\' end (E)', 'CGCT': '3\' UTR / terminator (F)',
    'TTCG': 'terminator junction', 'GGTA': 'Level 1 position 1 start',
}

_TYPE_KEYWORDS = [
    ('NonCodingPromoter', ('promoter', 'prom', '35s', 'ubq', 'pro')),
    ('NonCodingTerminator', ('terminator', 'term', 'nos-t', 'ocs')),
    ('NonCodingIntron', ('intron',)),
    ('Coding', ('cds', 'coding', 'orf', 'gene', 'protein', 'gfp', 'yfp', 'cas9')),
]


def analyze(doc: Dict[str, Any], enzymes: Optional[List[str]] = None) -> Dict[str, Any]:
    """
    Report, for each candidate Type IIS enzyme, whether the plasmid releases a
    single clean insert, and describe that insert.

    Returns {'ready': bool, 'best': <result or None>, 'candidates': [...]}.
    """
    enzymes = enzymes or TYPE_IIS_GOLDEN_GATE
    seq = doc['sequence'].upper()
    circular = bool(doc.get('circular'))
    candidates = []
    for enzyme in enzymes:
        sites = find_sites(seq, [enzyme], circular)
        if not sites:
            continue
        result = {'enzyme': enzyme, 'site_count': len(sites), 'ready': False, 'reason': ''}
        if len(sites) != 2:
            result['reason'] = f'{len(sites)} sites found; a part needs exactly 2'
            candidates.append(result)
            continue
        if not circular:
            result['reason'] = 'sequence is linear; a MoClo part is a circular plasmid'
            candidates.append(result)
            continue
        frags = digest(seq, [enzyme], True)
        inserts = [f for f in frags if f['left'] and f['right']
                   and not find_sites(f['top'], [enzyme], False)]
        if len(frags) != 2 or not inserts:
            result['reason'] = 'the two sites do not release a clean insert'
            candidates.append(result)
            continue
        # Of the two fragments the insert is the one whose overhangs point
        # inwards; both qualify geometrically, so prefer the smaller one.
        insert = min(inserts, key=lambda f: f['length'])
        oh5 = insert['left']['overhang']
        oh3 = insert['right']['overhang']
        if len(oh5) != 4 or len(oh3) != 4:
            result['reason'] = f'overhangs are {len(oh5)} and {len(oh3)} bp; MoClo parts use 4 bp'
            candidates.append(result)
            continue
        other = [f for f in frags if f is not insert]
        result.update({
            'alternative': ({'length': other[0]['length'], 'start': other[0]['start'],
                             'overhang_5prime': other[0]['left']['overhang'],
                             'overhang_3prime': other[0]['right']['overhang']}
                            if other and other[0]['left'] and other[0]['right'] else None),
            'ready': True,
            'insert': {
                # The top strand of the released fragment: it carries the 5'
                # overhang at its start, the 3' overhang being on the bottom
                # strand of this end (see dnakit.restriction.digest).
                'sequence': insert['top'],
                'length': insert['length'],
                'start': insert['start'],
                'end': insert['end'],
                'overhang_5prime': oh5,
                'overhang_3prime': oh3,
                # How the MoClo Library Tool stores a part: double-stranded
                # body with both fusion sites included, 5' first and 3' last.
                'part_sequence': insert['top'] + oh3,
                'part_length': insert['length'] + len(oh3),
            },
            'backbone_length': len(seq) - insert['length'],
            'fusion_sites': {
                "5'": MOCLO_FUSION_SITES.get(oh5, 'non-standard'),
                "3'": MOCLO_FUSION_SITES.get(oh3, 'non-standard'),
            },
            'standard_moclo': oh5 in MOCLO_FUSION_SITES and oh3 in MOCLO_FUSION_SITES,
        })
        candidates.append(result)

    ready = [c for c in candidates if c['ready']]
    # Prefer a canonical MoClo enzyme and standard fusion sites.
    ready.sort(key=lambda c: (not c['standard_moclo'], TYPE_IIS_GOLDEN_GATE.index(c['enzyme'])
                              if c['enzyme'] in TYPE_IIS_GOLDEN_GATE else 99))
    return {'ready': bool(ready), 'best': ready[0] if ready else None, 'candidates': candidates}


def suggest_part_type(doc: Dict[str, Any], insert_start: int, insert_length: int) -> str:
    """Guess a MoClo part type from the features inside the released insert."""
    n = len(doc['sequence'])
    inside = []
    for f in doc.get('features', []):
        rel = (f['start'] - insert_start) % n
        flen = (f['end'] - f['start']) % n or n
        if rel + flen <= insert_length:
            inside.append(f)
    types = {f.get('type', '').lower() for f in inside}
    if 'cds' in types:
        has_promoter = 'promoter' in types
        has_terminator = 'terminator' in types
        if has_promoter and has_terminator:
            return 'ExpressionCassette'
        return 'Coding'
    if 'promoter' in types:
        return 'NonCodingPromoter'
    if 'terminator' in types:
        return 'NonCodingTerminator'
    if 'intron' in types:
        return 'NonCodingIntron'
    text = ' '.join([doc.get('name', ''), doc.get('description', '')]
                    + [f.get('name', '') for f in inside]).lower()
    for part_type, keywords in _TYPE_KEYWORDS:
        if any(k in text for k in keywords):
            return part_type
    return 'NonCodingOther'


def moclo_features(doc: Dict[str, Any], insert_start: int, insert_length: int) -> List[Dict[str, Any]]:
    """
    Features inside the insert, re-based to the insert and in the shape the
    MoClo Library Tool stores in its parts.features column.
    """
    n = len(doc['sequence'])
    out = []
    for f in doc.get('features', []):
        rel = (f['start'] - insert_start) % n
        flen = (f['end'] - f['start']) % n or n
        if rel + flen > insert_length:
            continue
        out.append({'type': f.get('type') or 'misc_feature', 'label': f.get('name') or 'feature',
                    'start': rel, 'end': rel + flen, 'strand': f.get('strand', 1)})
    return sorted(out, key=lambda f: f['start'])
