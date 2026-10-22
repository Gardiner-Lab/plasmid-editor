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


# A flank found either side of the read's best hit needs at least this much of
# itself aligned, at this identity, to count as a second genuine piece of the
# read rather than noise: lower than what makes a whole read "mapped" (below),
# since a short, choppy flank is still good evidence the rest is a real
# insertion, not junk to ignore. Below ~25 bp / 80%, an unrelated stretch of
# the read (contamination, adapter readthrough) starts to clear the bar by
# chance often enough to be reported as a genuine second piece of the read.
MIN_FLANK_LENGTH = 25
MIN_FLANK_IDENTITY = 80.0


def _hit(aligner, target: str, query: str) -> Dict[str, Any]:
    """One local alignment of query against target, with its own span and quality."""
    aln = aligner.align(target, query)[0]
    top, bottom = _gapped(aln)
    cols = sum(x != '-' and y != '-' for x, y in zip(top, bottom))
    matches = sum(x == y and x != '-' for x, y in zip(top, bottom))
    return {'top': top, 'bottom': bottom, 'score': float(aln.score), 'cols': cols,
            'identity': 100.0 * matches / cols if cols else 0.0,
            'target_start': int(aln.coordinates[0][0]), 'target_end': int(aln.coordinates[0][-1]),
            'read_start': int(aln.coordinates[1][0]), 'read_end': int(aln.coordinates[1][-1])}


def _flank(aligner, target: str, piece: str, offset: int) -> Optional[Dict[str, Any]]:
    """A piece of the read left over on one side of the main hit, if it also aligns well."""
    if len(piece) < MIN_FLANK_LENGTH:
        return None
    hit = _hit(aligner, target, piece)
    if hit['cols'] < MIN_FLANK_LENGTH or hit['identity'] < MIN_FLANK_IDENTITY:
        return None
    hit['read_start'] += offset
    hit['read_end'] += offset
    return hit


def _recols(seg: Dict[str, Any]) -> Dict[str, Any]:
    seg['cols'] = sum(x != '-' and y != '-' for x, y in zip(seg['top'], seg['bottom']))
    return seg


def _trim_tail(seg: Dict[str, Any], limit: int) -> Dict[str, Any]:
    """Drop columns off the end of a hit until its target_end is at most `limit`."""
    top, bottom, target_end, read_end = seg['top'], seg['bottom'], seg['target_end'], seg['read_end']
    i = len(top)
    while target_end > limit and i > 0:
        i -= 1
        target_end -= top[i] != '-'
        read_end -= bottom[i] != '-'
    return _recols({**seg, 'top': top[:i], 'bottom': bottom[:i], 'target_end': target_end, 'read_end': read_end})


def _trim_head(seg: Dict[str, Any], limit: int) -> Dict[str, Any]:
    """Drop columns off the start of a hit until its target_start is at least `limit`."""
    top, bottom, target_start, read_start = seg['top'], seg['bottom'], seg['target_start'], seg['read_start']
    i = 0
    while target_start < limit and i < len(top):
        target_start += top[i] != '-'
        read_start += bottom[i] != '-'
        i += 1
    return _recols({**seg, 'top': top[i:], 'bottom': bottom[i:], 'target_start': target_start, 'read_start': read_start})


def _segments(aligner, target: str, q: str, main: Dict[str, Any]) -> List[Dict[str, Any]]:
    """
    The main hit, plus a flank either side of it that also aligns - found
    separately because one local alignment stops at the first large gap it
    would otherwise have to pay for, silently dropping whichever side of an
    insertion scores less. A flank is kept only if it reaches reference
    territory the main hit does not already cover (trimming off whatever of
    it overlaps, since a base right at the junction can go either way by
    chance); a flank fully inside the main hit's own span, or on the wrong
    side of it, is the start of a rearrangement, not a plain insertion, and is
    left for the main hit alone.
    """
    segments = [main]
    before = _flank(aligner, target, q[:main['read_start']], 0)
    if before and before['target_start'] < main['target_start']:
        if before['target_end'] > main['target_start']:
            before = _trim_tail(before, main['target_start'])
        if before['cols'] >= MIN_FLANK_LENGTH and before['target_end'] > before['target_start']:
            segments.insert(0, before)
    after = _flank(aligner, target, q[main['read_end']:], main['read_end'])
    if after and after['target_end'] > main['target_end']:
        if after['target_start'] < main['target_end']:
            after = _trim_head(after, main['target_end'])
        if after['cols'] >= MIN_FLANK_LENGTH and after['target_end'] > after['target_start']:
            segments.append(after)
    return segments


def _read_span(read_start: int, read_end: int, rev: bool, qlen: int, t0: int) -> (int, int):
    """A hit's span in q (the core, reverse-complemented for a reverse-strand
    read) back to the physical read as uploaded: left-to-right in the order
    its bases were actually sequenced, undoing both that and the quality
    trim, so the UI can show which stretch of the read file itself this is."""
    if rev:
        core_start, core_end = qlen - read_end, qlen - read_start
    else:
        core_start, core_end = read_start, read_end
    return t0 + core_start, t0 + core_end


def _stitch(target: str, q: str, segments: List[Dict[str, Any]]) -> (str, str, int):
    """One top/bottom alignment spanning every segment, with the read's own bases
    filling an insertion between them and the reference's filling a deletion."""
    top, bottom = [], []
    for i, seg in enumerate(segments):
        if i > 0:
            prev = segments[i - 1]
            gap_read = q[prev['read_end']:seg['read_start']]
            if gap_read:
                top.append('-' * len(gap_read))
                bottom.append(gap_read)
            gap_ref = target[prev['target_end']:seg['target_start']]
            if gap_ref:
                top.append(gap_ref)
                bottom.append('-' * len(gap_ref))
        top.append(seg['top'])
        bottom.append(seg['bottom'])
    return ''.join(top), ''.join(bottom), segments[0]['target_start']


def map_read(reference: str, read: str, circular: bool = False, quality: Optional[List[int]] = None,
             name: str = 'read', trim: bool = True) -> Dict[str, Any]:
    """
    Align one sequencing read to a reference (both strands; reads may cross
    the origin of a circular reference). Reports discrepancies in reference
    coordinates so the editor can mark them. A large insertion the read has
    that the reference does not - more than a local alignment's gap penalty
    would otherwise bridge - still shows: the flank on each side of it is
    found and stitched in, with the insertion itself held in `differences` as
    one entry - the whole run of read bases the reference does not have, not
    one entry per base (likewise a run of deleted reference bases).
    """
    ref = reference.upper()
    n = len(ref)
    read = read.upper()
    t0, t1 = trim_by_quality(read, quality) if (trim and quality) else (0, len(read))
    core = read[t0:t1]
    if len(core) < 20:
        return {'name': name, 'mapped': False, 'reason': 'read too short or low quality after trimming',
               'read_length': len(read), 'aligned_fraction': 0.0}
    target = ref + ref[:min(len(core) * 2, n)] if circular else ref
    aligner = _dna_aligner('local')
    best = None
    for rev in (False, True):
        q = reverse_complement(core) if rev else core
        hit = _hit(aligner, target, q)
        if best is None or hit['score'] > best[1]['score']:
            best = (rev, hit, q)
    rev, main, q = best
    segments = _segments(aligner, target, q, main)
    top, bottom, start = _stitch(target, q, segments)
    ref_pos = start
    diffs = []
    matches = cols = 0
    i, length = 0, len(top)
    while i < length:
        x, y = top[i], bottom[i]
        if x != '-' and y != '-':
            cols += 1
            if x == y:
                matches += 1
            else:
                diffs.append({'position': ref_pos % n, 'type': 'mismatch', 'ref': x, 'read': y, 'length': 1})
            ref_pos += 1
            i += 1
            continue
        # A run of the reference's gap (insertion) or the read's (deletion),
        # held as one entry with how long it runs, not one entry per base.
        run_start = i
        if x == '-':
            while i < length and top[i] == '-':
                i += 1
            diffs.append({'position': ref_pos % n, 'type': 'insertion', 'ref': '-',
                         'read': bottom[run_start:i], 'length': i - run_start})
        else:
            while i < length and bottom[i] == '-':
                i += 1
            diffs.append({'position': ref_pos % n, 'type': 'deletion', 'ref': top[run_start:i],
                         'read': '-', 'length': i - run_start})
            ref_pos += i - run_start
    # Two measures of agreement. Where bases pair up, how many match: what
    # decides whether the read is this plasmid at all, so a read with a large
    # insertion still maps. And over every column, each inserted or deleted
    # base counting against it: the identity reported, so a 60 bp insertion
    # does not read as "100% identity".
    base_identity = round(100.0 * matches / cols, 1) if cols else 0.0
    identity = round(100.0 * matches / length, 1) if length else 0.0
    # The reference spans the read actually covers, for an accurate coverage bar
    # (one span, unless a deletion between flanks splits it into several), each
    # with where in the physical read - as uploaded, not the quality-trimmed,
    # possibly reverse-complemented core used for alignment - it came from, so
    # the UI can show which part of the read itself did and did not make it in.
    out_segments = []
    for s in segments:
        read_start, read_end = _read_span(s['read_start'], s['read_end'], rev, len(q), t0)
        out_segments.append({'ref_start': s['target_start'] % n, 'ref_end': s['target_end'] % n or n,
                              'read_start': read_start, 'read_end': read_end})
    out_segments.sort(key=lambda s: s['read_start'])
    return {
        'name': name, 'mapped': cols >= 20 and base_identity >= 80.0,
        'strand': -1 if rev else 1, 'ref_start': start % n, 'ref_end': ref_pos % n or n,
        'aligned_length': cols, 'identity': identity, 'base_identity': base_identity,
        'indel_bases': length - cols, 'differences': diffs,
        # How much of the uploaded read this is: the whole file, not just the
        # part kept after quality-trimming, so a read mostly trimmed away or
        # mostly unaligned still shows as such.
        'read_length': len(read), 'aligned_fraction': round(100.0 * cols / len(read), 1) if read else 0.0,
        'trim': [t0, t1], 'top': top, 'bottom': bottom, 'score': sum(s['score'] for s in segments),
        'read_start': out_segments[0]['read_start'], 'read_end': out_segments[-1]['read_end'],
        'segments': out_segments,
    }


def coverage(n: int, reads: List[Dict[str, Any]]) -> List[List[int]]:
    """Merged [start, end) intervals of the reference covered by mapped reads."""
    spans = []
    for r in reads:
        if not r.get('mapped'):
            continue
        # A read's own segments (plural when a deletion splits it) are the
        # reference it actually covers; older stored alignments have none,
        # so fall back to its overall span.
        for seg in r.get('segments') or [{'ref_start': r['ref_start'], 'ref_end': r['ref_end']}]:
            s, e = seg['ref_start'], seg['ref_end']
            spans += [[s, e]] if e > s else [[s, n], [0, e]]
    spans.sort()
    merged = []
    for s, e in spans:
        if merged and s <= merged[-1][1]:
            merged[-1][1] = max(merged[-1][1], e)
        else:
            merged.append([s, e])
    return merged
