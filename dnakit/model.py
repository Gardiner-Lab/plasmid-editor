"""
Core sequence document model shared by every dnakit module.

A document is a plain dict so it can travel as JSON between the browser and
the server unchanged:

    {
        "name": "pUC19",
        "sequence": "ACGT...",
        "circular": true,
        "description": "",
        "features": [
            {"id": "f1", "name": "AmpR", "type": "CDS", "start": 0, "end": 861,
             "strand": -1, "color": "#f59e0b", "qualifiers": {}}
        ]
    }

Coordinates are 0-based, end-exclusive. On a circular sequence a feature that
spans the origin has start > end (e.g. start=2600, end=120).
"""

import uuid
from typing import Any, Dict, List, Optional

COMPLEMENT = str.maketrans(
    'ACGTURYKMSWBDHVNacgturykmswbdhvn',
    'TGCAAYRMKSWVHDBNtgcaayrmkswvhdbn',
)

IUPAC_DNA = set('ACGTURYKMSWBDHVN')

# Regex character class for each IUPAC code, used by the find tools.
IUPAC_REGEX = {
    'A': 'A', 'C': 'C', 'G': 'G', 'T': 'T', 'U': 'T',
    'R': '[AG]', 'Y': '[CT]', 'K': '[GT]', 'M': '[AC]', 'S': '[CG]', 'W': '[AT]',
    'B': '[CGT]', 'D': '[AGT]', 'H': '[ACT]', 'V': '[ACG]', 'N': '[ACGT]',
}


def reverse_complement(seq: str) -> str:
    return seq.translate(COMPLEMENT)[::-1]


def clean_sequence(seq: str) -> str:
    """Strip whitespace, digits and anything that is not an IUPAC base, keep case."""
    return ''.join(c for c in seq if c.upper() in IUPAC_DNA)


def new_id() -> str:
    return uuid.uuid4().hex[:10]


def feature_length(feature: Dict[str, Any], seq_len: int) -> int:
    start, end = feature['start'], feature['end']
    return end - start if end > start else seq_len - start + end


def feature_sequence(doc: Dict[str, Any], feature: Dict[str, Any]) -> str:
    """Sequence of a feature, read on its own strand."""
    seq = doc['sequence']
    start, end = feature['start'], feature['end']
    sub = seq[start:end] if end > start else seq[start:] + seq[:end]
    return reverse_complement(sub) if feature.get('strand', 1) == -1 else sub


def subsequence(seq: str, start: int, end: int, circular: bool) -> str:
    """Slice that wraps through the origin when start > end on a circular sequence."""
    if end > start or not circular:
        return seq[start:end]
    return seq[start:] + seq[:end]


def make_feature(name: str, start: int, end: int, strand: int = 1, ftype: str = 'misc_feature',
                 color: Optional[str] = None, qualifiers: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    f = {'id': new_id(), 'name': name, 'type': ftype, 'start': start, 'end': end,
         'strand': strand, 'qualifiers': qualifiers or {}}
    if color:
        f['color'] = color
    return f


def make_document(name: str, sequence: str, circular: bool = False,
                  features: Optional[List[Dict[str, Any]]] = None, description: str = '') -> Dict[str, Any]:
    return {'name': name, 'sequence': sequence, 'circular': circular,
            'description': description, 'features': features or []}


def normalize_document(doc: Dict[str, Any]) -> Dict[str, Any]:
    """Validate and fill defaults on a document received from a client."""
    if not isinstance(doc, dict) or not isinstance(doc.get('sequence'), str):
        raise ValueError('document must be an object with a "sequence" string')
    seq = clean_sequence(doc['sequence'])
    n = len(seq)
    feats = []
    for f in doc.get('features') or []:
        try:
            start, end = int(f['start']), int(f['end'])
        except (KeyError, TypeError, ValueError):
            continue
        if not (0 <= start <= n and 0 <= end <= n) or start == end:
            continue
        if end < start and not doc.get('circular'):
            continue
        feats.append({
            'id': f.get('id') or new_id(),
            'name': str(f.get('name') or f.get('type') or 'feature'),
            'type': str(f.get('type') or 'misc_feature'),
            'start': start, 'end': end,
            'strand': -1 if f.get('strand') == -1 else 1,
            'color': f.get('color'),
            'qualifiers': f.get('qualifiers') or {},
            **({'segments': f['segments']} if f.get('segments') else {}),
        })
    return {
        'id': doc.get('id'),
        'name': str(doc.get('name') or 'Untitled'),
        'sequence': seq,
        'circular': bool(doc.get('circular')),
        'description': str(doc.get('description') or ''),
        'features': feats,
    }


def rotate(doc: Dict[str, Any], new_origin: int) -> Dict[str, Any]:
    """Return a circular document re-indexed so new_origin becomes position 0."""
    seq = doc['sequence']
    n = len(seq)
    k = new_origin % n
    out = dict(doc, sequence=seq[k:] + seq[:k], features=[])
    for f in doc['features']:
        g = dict(f, start=(f['start'] - k) % n, end=(f['end'] - k) % n or n)
        if g['start'] == n:
            g['start'] = 0
        g.pop('segments', None)
        out['features'].append(g)
    return out


def reverse_complement_document(doc: Dict[str, Any]) -> Dict[str, Any]:
    seq = doc['sequence']
    n = len(seq)
    out = dict(doc, sequence=reverse_complement(seq), features=[])
    for f in doc['features']:
        g = dict(f, start=(n - f['end']) % n if doc['circular'] else n - f['end'],
                 end=n - f['start'], strand=-f.get('strand', 1))
        g.pop('segments', None)
        out['features'].append(g)
    return out
