"""
Feature libraries and automatic annotation.

Library files use the same tab-separated layout as ApE feature libraries
(name, sequence, type, forward colour, reverse colour, ...), so existing ApE
libraries can be imported directly and exported back.
"""

import re
from typing import Any, Dict, Iterable, List

from .model import IUPAC_REGEX, clean_sequence, make_feature, reverse_complement

DEFAULT_COLORS = {
    'CDS': '#60a5fa', 'promoter': '#34d399', 'terminator': '#f87171', 'rep_origin': '#fbbf24',
    'primer_bind': '#a78bfa', 'misc_feature': '#94a3b8', 'protein_bind': '#f472b6',
    'RBS': '#2dd4bf', 'regulatory': '#4ade80', '5\'UTR': '#a3e635', '3\'UTR': '#fb923c',
    'intron': '#d1d5db', 'gene': '#93c5fd', 'enhancer': '#86efac', 'polyA_signal': '#fca5a5',
}


def color_for(feature_type: str) -> str:
    return DEFAULT_COLORS.get(feature_type, '#94a3b8')


def parse_library(text: str) -> List[Dict[str, Any]]:
    """Parse an ApE-style tab-separated feature library."""
    entries = []
    for line in text.splitlines():
        if not line.strip() or line.lstrip().startswith('#'):
            continue
        cols = line.rstrip('\r\n').split('\t')
        if len(cols) < 2:
            continue
        name, seq = cols[0].strip(), clean_sequence(cols[1]).upper()
        if not name or len(seq) < 6:
            continue
        ftype = cols[2].strip() if len(cols) > 2 and cols[2].strip() else 'misc_feature'
        fwd = cols[3].strip() if len(cols) > 3 and cols[3].strip() else color_for(ftype)
        rev = cols[4].strip() if len(cols) > 4 and cols[4].strip() else fwd
        entries.append({'name': name, 'sequence': seq, 'type': ftype, 'color': fwd, 'reverse_color': rev})
    return entries


def write_library(entries: Iterable[Dict[str, Any]]) -> str:
    lines = []
    for e in entries:
        color = e.get('color') or color_for(e.get('type', 'misc_feature'))
        lines.append('\t'.join([e['name'], e['sequence'], e.get('type') or 'misc_feature',
                                color, e.get('reverse_color') or color, '0']))
    return '\n'.join(lines) + '\n'


def _regex(seq: str) -> str:
    return ''.join(IUPAC_REGEX.get(c, c) for c in seq.upper())


def find_pattern(seq: str, pattern: str, circular: bool = False, both_strands: bool = True) -> List[Dict[str, Any]]:
    """Find an IUPAC DNA pattern. Hits are forward-strand coordinates (end may wrap)."""
    s = seq.upper()
    n = len(s)
    pat = clean_sequence(pattern).upper()
    if not pat or len(pat) > n:
        return []
    search = s + s[:len(pat) - 1] if circular else s
    hits = []
    strands = [(1, pat)]
    rc = reverse_complement(pat)
    if both_strands and rc != pat:
        strands.append((-1, rc))
    for strand, p in strands:
        for m in re.finditer(f'(?={_regex(p)})', search):
            i = m.start()
            if i < n:
                hits.append({'start': i, 'end': (i + len(p)) % n if circular and i + len(p) > n else i + len(p),
                             'strand': strand})
    hits.sort(key=lambda h: (h['start'], -h['strand']))
    return hits


def find_protein(seq: str, peptide: str, circular: bool = False) -> List[Dict[str, Any]]:
    """Find a peptide (X = any residue) in all six frames."""
    from .translate import translate
    s = seq.upper()
    n = len(s)
    pep = re.sub(r'[^A-Z*]', '', peptide.upper())
    if not pep:
        return []
    rx = re.compile('(?=' + pep.replace('*', r'\*').replace('X', '.') + ')')
    hits = []
    for strand in (1, -1):
        base = s if strand == 1 else reverse_complement(s)
        search = base + base[:len(pep) * 3] if circular else base
        for frame in range(3):
            prot = translate(search[frame:])
            for m in rx.finditer(prot):
                i = frame + m.start() * 3
                if i >= n:
                    continue
                L = len(pep) * 3
                if strand == 1:
                    st, en = i, (i + L) % n if circular and i + L > n else i + L
                else:
                    st, en = (n - i - L) % n, n - i
                hits.append({'start': st, 'end': en, 'strand': strand})
    return sorted(hits, key=lambda h: h['start'])


def auto_annotate(doc: Dict[str, Any], library: List[Dict[str, Any]], skip_existing: bool = True) -> List[Dict[str, Any]]:
    """Features for every exact (IUPAC) library match, excluding ones already annotated."""
    existing = {(f['start'], f['end'], f.get('strand', 1)) for f in doc.get('features', [])}
    existing_named = {(f['name'].lower(), f['start'], f['end']) for f in doc.get('features', [])}
    new = []
    for entry in library:
        for h in find_pattern(doc['sequence'], entry['sequence'], doc.get('circular', False)):
            key = (h['start'], h['end'], h['strand'])
            if skip_existing and (key in existing or (entry['name'].lower(), h['start'], h['end']) in existing_named):
                continue
            existing.add(key)
            color = entry.get('reverse_color') if h['strand'] == -1 and entry.get('reverse_color') else entry.get('color')
            new.append(make_feature(entry['name'], h['start'], h['end'], h['strand'],
                                    entry.get('type') or 'misc_feature', color or color_for(entry.get('type', ''))))
    return new


def library_entry_from_feature(doc: Dict[str, Any], feature: Dict[str, Any]) -> Dict[str, Any]:
    from .model import feature_sequence
    return {'name': feature['name'], 'sequence': feature_sequence(doc, feature).upper(),
            'type': feature.get('type') or 'misc_feature',
            'color': feature.get('color') or color_for(feature.get('type', ''))}
