"""
Primers for bisulfite PCR.

Bisulfite turns every unmethylated C into U (read as T); a methylated C stays C. Afterwards the two
strands of the DNA are no longer complementary, so a primer pair amplifies one converted strand,
top or bottom, never both:

* converted top strand (C -> T): the forward primer sits where the top strand has few Cs, and each
  C it does cover is written Y (C or T), whether methylated or not; the reverse primer, the reverse
  complement of a stretch with few Cs, has those Cs as G and writes them R (G or A);
* converted bottom strand (G -> A on the top strand): the other way round, few Gs; the forward
  primer writes them R and the reverse primer Y.

Primers are longer than usual (25-30 nt by default), since converted DNA is mostly three bases and
less complex. Each candidate must have a Tm in range, no stable hairpin or self-dimer and no long
run of one or two bases; pairs must give a product of the right length, Tms close together and no
stable heterodimer. Pairs are then ranked by a score where lower is better (fewer degenerate bases,
Tms near each other and the optimum, product near its optimal length, weak secondary structure,
short repeats, a GC clamp).

The method and its score are from ``design_bisulfite_primers.py`` v1.1 by Colette L. Picard (2016),
rewritten here. Changes from that script, each a fix:

* the maximum product length is applied (the script read it but never used it);
* a reverse primer's hairpin and self-dimer are measured on its own sequence; the script measured
  the forward-strand stretch for its unconverted form;
* the heterodimer of a pair is the stronger of the converted and unconverted forms of the primers,
  as for hairpins; the script passed the degenerate primers, whose Y and R primer3 cannot pair.

Checking each primer against a genome (the script BLASTed against TAIR10) is the Genome
Browser's job: the editor sends it the pairs in score order and keeps those that pass.
"""

import heapq
from bisect import bisect_left, bisect_right
from itertools import groupby
from typing import Any, Dict, List, Optional

import primer3
from Bio.SeqUtils.MeltingTemp import Tm_GC

from .model import reverse_complement

DEFAULTS: Dict[str, Any] = {
    'strand': 'both',          # 'top', 'bottom' or 'both' converted strands
    'min_len': 25, 'max_len': 30,
    'max_degenerate': 2,       # Y or R bases allowed in a primer
    'min_product': 200, 'opt_product': 300, 'max_product': 500,
    'min_tm': 51.0, 'opt_tm': 58.0, 'max_tm': 64.0,
    'max_self_tm': None,       # hairpin, self-dimer and heterodimer Tm ceiling; None = min_tm - 10
    'max_tm_diff': 5.0,
    'max_repeat': 3,           # longest run of one base, or of a 2- or 3-base unit
}
LIMITS = {'region': 10_000, 'pairs': 2000}

_PRIMER_LEN = (10, 60)


def convert(seq: str, strand: str) -> str:
    """The top strand as read after bisulfite: C -> T for the converted top strand, G -> A for the bottom."""
    seq = seq.upper()
    return seq.replace('C', 'T') if strand == 'top' else seq.replace('G', 'A')


def _degenerate(seq: str, base: str) -> str:
    """Each C written Y (C or T), or each G written R (G or A)."""
    return seq.replace('C', 'Y') if base == 'C' else seq.replace('G', 'R')


def _forms(primer: str) -> List[str]:
    """A degenerate primer as fully converted and as unconverted (methylated) DNA."""
    return [primer.replace('Y', 'T').replace('R', 'A'), primer.replace('Y', 'C').replace('R', 'G')]


def longest_repeat(primer: str) -> int:
    """The longest run of one base, or of a 2- or 3-base unit, in either form of the primer."""
    longest = 0
    for s in (primer.replace('R', 'G').replace('Y', 'C'), primer.replace('R', 'A').replace('Y', 'T')):
        for unit in (1, 2, 3):
            for offset in range(min(unit, len(s))):
                words = [s[i:i + unit] for i in range(offset, len(s), unit)]
                longest = max(longest, max(sum(1 for _ in run) for _, run in groupby(words)))
    return longest


def _tm(primer: str) -> float:
    # GC content with Y and R counted as half: the mean of the converted and unconverted forms.
    return round(float(Tm_GC(primer, strict=False, valueset=8)), 1)


def _structure(primer: str, ceiling: float) -> Dict[str, Any]:
    """
    Hairpin and self-dimer Tm, the stronger of either form; ``failed`` names the first over
    ``ceiling`` (the hairpin is cheap to find, the dimer is not, so it is only found if needed).
    """
    forms = _forms(primer)
    hairpin = round(max(primer3.calc_hairpin(f).tm for f in forms), 1)
    if hairpin > ceiling:
        return {'failed': 'hairpin'}
    homodimer = round(max(primer3.calc_homodimer(f).tm for f in forms), 1)
    if homodimer > ceiling:
        return {'failed': 'homodimer'}
    return {'hairpin': hairpin, 'homodimer': homodimer}


def _heterodimer(a: str, b: str) -> float:
    return round(max(primer3.calc_heterodimer(x, y).tm for x, y in zip(_forms(a), _forms(b))), 1)


def _options(raw: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    o = dict(DEFAULTS)
    for key, value in (raw or {}).items():
        if key in DEFAULTS and value not in (None, ''):
            o[key] = value if key == 'strand' else float(value)
    for key in ('min_len', 'max_len', 'max_degenerate', 'min_product', 'opt_product', 'max_product', 'max_repeat'):
        o[key] = int(o[key])
    if o['strand'] not in ('top', 'bottom', 'both'):
        raise ValueError('strand must be top, bottom or both')
    if not _PRIMER_LEN[0] <= o['min_len'] <= o['max_len'] <= _PRIMER_LEN[1]:
        raise ValueError(f'primer lengths must run from {_PRIMER_LEN[0]} to {_PRIMER_LEN[1]} nt, the minimum first')
    if not 0 < o['min_product'] <= o['max_product']:
        raise ValueError('the minimum product length must not exceed the maximum')
    if not o['min_tm'] <= o['max_tm']:
        raise ValueError('the minimum Tm must not exceed the maximum')
    if o['max_degenerate'] < 0:
        raise ValueError('the number of degenerate bases cannot be negative')
    if o['max_self_tm'] is None:
        o['max_self_tm'] = o['min_tm'] - 10
    return o


def _candidates(seq: str, o: Dict[str, Any], strand: str, why: Dict[str, Any]) -> Dict[str, List[Dict[str, Any]]]:
    """
    Primers passing the single-primer cutoffs, for one converted strand: forward and reverse.
    ``why`` is filled with how many were turned down at each cutoff, for saying why none passed.
    """
    avoid = 'C' if strand == 'top' else 'G'          # the base the forward primer's stretch has few of
    other = 'G' if avoid == 'C' else 'C'
    out: Dict[str, List[Dict[str, Any]]] = {'forward': [], 'reverse': []}
    why.update({'stretches': 0, 'degenerate': 0, 'ambiguous': 0, 'least_degenerate': None, 'primers': 0,
                'tm_low': 0, 'tm_high': 0, 'tm_range': None, 'repeat': 0, 'hairpin': 0, 'homodimer': 0})
    tms: List[float] = []
    for length in range(o['min_len'], o['max_len'] + 1):
        for start in range(0, len(seq) - length + 1):
            site = seq[start:start + length]
            why['stretches'] += 1
            if any(c not in 'ACGT' for c in site):
                why['ambiguous'] += 1
                continue
            n = site.count(avoid)
            if why['least_degenerate'] is None or n < why['least_degenerate']:
                why['least_degenerate'] = n
            if n > o['max_degenerate']:
                why['degenerate'] += 1
                continue
            # The forward primer is the converted top strand here; the reverse primer the reverse
            # complement of the same stretch, so its degenerate bases are the complement's.
            for direction, primer in (('forward', _degenerate(site, avoid)),
                                      ('reverse', _degenerate(reverse_complement(site), other))):
                why['primers'] += 1
                tm = _tm(primer)
                tms.append(tm)
                if tm < o['min_tm']:
                    why['tm_low'] += 1
                    continue
                if tm > o['max_tm']:
                    why['tm_high'] += 1
                    continue
                repeat = longest_repeat(primer)
                if repeat > o['max_repeat']:
                    why['repeat'] += 1
                    continue
                s = _structure(primer, o['max_self_tm'])
                if 'failed' in s:
                    why[s['failed']] += 1
                    continue
                out[direction].append({'start': start, 'end': start + length, 'length': length, 'site': site,
                                       'sequence': primer, 'tm': tm, **s, 'repeat': repeat,
                                       'degenerate': primer.count('Y') + primer.count('R')})
    if tms:
        why['tm_range'] = [min(tms), max(tms)]
    why['forward'], why['reverse'] = len(out['forward']), len(out['reverse'])
    return out


def score(pair: Dict[str, Any], o: Dict[str, Any]) -> float:
    """The script's ranking: lower is better."""
    f, r = pair['forward'], pair['reverse']
    clamp = sum(-3 for p in (f, r) if 2 <= p['sequence'][-5:].count('G') + p['sequence'][-5:].count('C') <= 3)
    return round(f['degenerate'] + r['degenerate'] + pair['tm_diff'] + 0.1 * abs(o['opt_product'] - pair['product'])
                 + abs(o['opt_tm'] - f['tm']) + abs(o['opt_tm'] - r['tm'])
                 + 0.1 * sum(max(0.0, v) for v in (f['hairpin'], r['hairpin'], f['homodimer'], r['homodimer'],
                                                  pair['heterodimer']))
                 + f['repeat'] + r['repeat'] + clamp, 2)


def design(sequence: str, options: Optional[Dict[str, Any]] = None, offset: int = 0) -> Dict[str, Any]:
    """
    Bisulfite primer pairs for ``sequence``, best first.

    ``offset`` is where the sequence starts in the document, added to every position returned. Gives
    the options used, how many primers passed, how many pairs passed all but the heterodimer cutoff
    (``possible_pairs``), how many were turned down at each cutoff per strand (``filters``, for saying
    why none passed), and the best ``LIMITS['pairs']`` pairs that pass them all; which of
    them to suggest (the best that do not overlap one already chosen, and that pass a genome check)
    is the caller's choice, as the pairs that pass a check are only known once it has run.
    """
    seq = ''.join(sequence.split()).upper()
    if not seq:
        raise ValueError('there is no sequence to design primers for')
    if len(seq) > LIMITS['region']:
        raise ValueError(f"select at most {LIMITS['region']:,} bp to design bisulfite primers in")
    o = _options(options)
    if len(seq) < o['min_product']:
        raise ValueError(f"the region is shorter than the minimum product ({o['min_product']} bp)")
    strands = ['top', 'bottom'] if o['strand'] == 'both' else [o['strand']]
    # Every pair passing the cheap cutoffs, scored as if it had no heterodimer: that term can only
    # add to a score, so this is the least each pair can score.
    possible: List[Dict[str, Any]] = []
    counted: Dict[str, Dict[str, int]] = {}
    filters: Dict[str, Dict[str, Any]] = {}
    for strand in strands:
        why: Dict[str, Any] = {}
        c = _candidates(seq, o, strand, why)
        counted[strand] = {'forward': len(c['forward']), 'reverse': len(c['reverse'])}
        why.update({'combinations': len(c['forward']) * len(c['reverse']), 'wrong_order': 0, 'too_short': 0,
                    'too_long': 0, 'tm_diff': 0, 'heterodimer': 0, 'pairs': 0})
        filters[strand] = why
        reverse = sorted(c['reverse'], key=lambda p: p['end'])
        ends = [r['end'] for r in reverse]
        for f in c['forward']:
            # The reverse primers giving a product of the right length, found by where they end.
            lo = bisect_left(ends, f['start'] + o['min_product'])
            hi = bisect_right(ends, f['start'] + o['max_product'])
            before = bisect_right(ends, f['end'])          # ending before the forward primer does: no product
            why['wrong_order'] += min(before, lo)
            why['too_short'] += max(0, lo - before)
            why['too_long'] += len(reverse) - hi
            for r in reverse[lo:hi]:
                product = r['end'] - f['start']
                tm_diff = round(abs(f['tm'] - r['tm']), 1)
                if tm_diff > o['max_tm_diff']:
                    why['tm_diff'] += 1
                    continue
                pair = {'strand': strand, 'forward': f, 'reverse': r, 'product': product,
                        'tm_diff': tm_diff, 'heterodimer': 0.0}
                pair['score'] = score(pair, o)
                possible.append(pair)
    possible.sort(key=lambda p: p['score'])
    # A heterodimer takes a millisecond to work out, so only as many as it takes to be sure of the
    # best: once the lowest possible score of the rest is above the worst kept, none can get in.
    keep = LIMITS['pairs']
    best: List[tuple] = []                 # a max-heap of the kept pairs, by score (negated)
    for n, pair in enumerate(possible):
        if len(best) >= keep and pair['score'] > -best[0][0]:
            break
        het = _heterodimer(pair['forward']['sequence'], pair['reverse']['sequence'])
        if het > o['max_self_tm']:
            filters[pair['strand']]['heterodimer'] += 1
            continue
        filters[pair['strand']]['pairs'] += 1
        pair['heterodimer'] = het
        pair['score'] = score(pair, o)
        item = (-pair['score'], -n, pair)
        if len(best) < keep:
            heapq.heappush(best, item)
        elif item > best[0]:
            heapq.heapreplace(best, item)
    ranked = sorted((item[2] for item in best),
                    key=lambda p: (p['score'], p['forward']['start'], p['reverse']['end'],
                                   p['forward']['length'], p['reverse']['length']))
    # Each primer once (a good one is in many pairs), the pairs pointing to them by number.
    primers: List[Dict[str, Any]] = []
    number: Dict[int, int] = {}

    def ref(primer: Dict[str, Any], direction: str, strand: str) -> int:
        if id(primer) not in number:
            number[id(primer)] = len(primers)
            primers.append({**primer, 'id': len(primers), 'direction': direction, 'strand': strand,
                            'start': primer['start'] + offset, 'end': primer['end'] + offset})
        return number[id(primer)]

    pairs = [{'strand': p['strand'], 'forward': ref(p['forward'], 'forward', p['strand']),
              'reverse': ref(p['reverse'], 'reverse', p['strand']), 'product': p['product'],
              'tm_diff': p['tm_diff'], 'heterodimer': p['heterodimer'], 'score': p['score']} for p in ranked]
    # Every pair's dimer was found unless the best were settled first: then the counts are a floor.
    complete = len(possible) == sum(f['heterodimer'] + f['pairs'] for f in filters.values())
    return {'options': o, 'length': len(seq), 'passed': counted, 'possible_pairs': len(possible),
            'filters': filters, 'filters_complete': complete, 'primers': primers, 'pairs': pairs}


def choose(result: Dict[str, Any], suggest: int, passes=lambda primer: True,
           max_overlap: int = 20) -> List[Dict[str, Any]]:
    """
    The pairs to suggest from a :func:`design` result, as the script picks them: in score order,
    skipping a pair whose primers overlap by more than ``max_overlap`` nt a primer of one already
    chosen for the same strand, or either of whose primers ``passes`` (a genome check) turns down.
    The editor's page does the same in tools.js, where the genome check is a call to the Genome Browser.
    """
    primers = result['primers']
    chosen: List[Dict[str, Any]] = []
    taken: Dict[str, List[tuple]] = {'top': [], 'bottom': []}
    overlap = lambda a, b: max(0, min(a[1], b[1]) - max(a[0], b[0]))
    for pair in result['pairs']:
        if len(chosen) >= suggest:
            break
        two = [primers[pair['forward']], primers[pair['reverse']]]
        spans = [(p['start'], p['end']) for p in two]
        if any(overlap(s, t) > max_overlap for s in spans for t in taken[pair['strand']]):
            continue
        if not all(passes(p) for p in two):
            continue
        chosen.append(pair)
        taken[pair['strand']].extend(spans)
    return chosen
