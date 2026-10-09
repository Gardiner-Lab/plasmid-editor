"""
Sequence alignment: pairwise DNA/protein alignment and mapping sequencing
reads (FASTA or ABI chromatograms) onto a reference to check a construct.
"""

from typing import Any, Dict, List, Optional

from Bio import Align
from Bio.Align import substitution_matrices

from .model import reverse_complement


def _dna_aligner(mode: str) -> Align.PairwiseAligner:
    al = Align.PairwiseAligner()
    al.mode = mode
    al.match_score = 2
    al.mismatch_score = -3
    al.open_gap_score = -5
    al.extend_gap_score = -2
    if mode == 'global':
        al.end_gap_score = 0  # free end gaps: semi-global
    return al


def _protein_aligner(mode: str) -> Align.PairwiseAligner:
    al = Align.PairwiseAligner()
    al.mode = mode
    al.substitution_matrix = substitution_matrices.load('BLOSUM62')
    al.open_gap_score = -10
    al.extend_gap_score = -0.5
    return al


def _gapped(alignment) -> List[str]:
    """Gapped strings for both rows, compatible across BioPython versions."""
    return [alignment[0], alignment[1]] if hasattr(alignment, '__getitem__') else str(alignment).split('\n')[::2]


def pairwise(a: str, b: str, mode: str = 'global', molecule: str = 'dna',
             try_reverse: bool = True) -> Dict[str, Any]:
    """Align b to a. For DNA the reverse complement of b is tried too and the better kept."""
    a, b = a.upper(), b.upper()
    aligner = _protein_aligner(mode) if molecule == 'protein' else _dna_aligner(mode)
    candidates = [(False, b)]
    if molecule == 'dna' and try_reverse:
        candidates.append((True, reverse_complement(b)))
    best = None
    for rev, seq in candidates:
        aln = aligner.align(a, seq)[0]
        if best is None or aln.score > best[1].score:
            best = (rev, aln)
    rev, aln = best
    top, bottom = _gapped(aln)
    matches = sum(x == y and x != '-' for x, y in zip(top, bottom))
    aligned_cols = sum(x != '-' and y != '-' for x, y in zip(top, bottom))
    return {
        'top': top, 'bottom': bottom, 'score': float(aln.score), 'reverse_complemented': rev,
        'identity': round(100.0 * matches / aligned_cols, 1) if aligned_cols else 0.0,
        'matches': matches, 'length': len(top),
        'a_start': int(aln.coordinates[0][0]), 'a_end': int(aln.coordinates[0][-1]),
        'b_start': int(aln.coordinates[1][0]), 'b_end': int(aln.coordinates[1][-1]),
    }


def trim_by_quality(seq: str, quality: List[int], threshold: int = 20, window: int = 10) -> (int, int):
    """Mott-style trimming: the window range whose mean quality stays above threshold."""
    if not quality or len(quality) != len(seq):
        return 0, len(seq)
    good = [i for i in range(len(quality) - window + 1)
            if sum(quality[i:i + window]) / window >= threshold]
    if not good:
        return 0, 0
    return good[0], good[-1] + window


def map_read(reference: str, read: str, circular: bool = False, quality: Optional[List[int]] = None,
             name: str = 'read', trim: bool = True) -> Dict[str, Any]:
    """
    Align one sequencing read to a reference (both strands; reads may cross
    the origin of a circular reference). Reports discrepancies in reference
    coordinates so the editor can mark them.
    """
    ref = reference.upper()
    n = len(ref)
    read = read.upper()
    t0, t1 = trim_by_quality(read, quality) if (trim and quality) else (0, len(read))
    core = read[t0:t1]
    if len(core) < 20:
        return {'name': name, 'mapped': False, 'reason': 'read too short or low quality after trimming'}
    target = ref + ref[:min(len(core) * 2, n)] if circular else ref
    aligner = _dna_aligner('local')
    best = None
    for rev in (False, True):
        q = reverse_complement(core) if rev else core
        aln = aligner.align(target, q)[0]
        if best is None or aln.score > best[1].score:
            best = (rev, aln, q)
    rev, aln, q = best
    top, bottom = _gapped(aln)
    ref_pos = int(aln.coordinates[0][0])
    start = ref_pos
    diffs = []
    matches = cols = 0
    for x, y in zip(top, bottom):
        if x != '-' and y != '-':
            cols += 1
            if x == y:
                matches += 1
            else:
                diffs.append({'position': ref_pos % n, 'type': 'mismatch', 'ref': x, 'read': y})
        elif x == '-':
            diffs.append({'position': ref_pos % n, 'type': 'insertion', 'ref': '-', 'read': y})
        else:
            diffs.append({'position': ref_pos % n, 'type': 'deletion', 'ref': x, 'read': '-'})
        if x != '-':
            ref_pos += 1
    identity = round(100.0 * matches / cols, 1) if cols else 0.0
    return {
        'name': name, 'mapped': cols >= 20 and identity >= 80.0,
        'strand': -1 if rev else 1, 'ref_start': start % n, 'ref_end': ref_pos % n or n,
        'aligned_length': cols, 'identity': identity, 'differences': diffs,
        'trim': [t0, t1], 'top': top, 'bottom': bottom, 'score': float(aln.score),
        'read_start': int(aln.coordinates[1][0]), 'read_end': int(aln.coordinates[1][-1]),
    }


def coverage(n: int, reads: List[Dict[str, Any]]) -> List[List[int]]:
    """Merged [start, end) intervals of the reference covered by mapped reads."""
    spans = []
    for r in reads:
        if not r.get('mapped'):
            continue
        s, e = r['ref_start'], r['ref_end']
        spans += [[s, e]] if e > s else [[s, n], [0, e]]
    spans.sort()
    merged = []
    for s, e in spans:
        if merged and s <= merged[-1][1]:
            merged[-1][1] = max(merged[-1][1], e)
        else:
            merged.append([s, e])
    return merged
