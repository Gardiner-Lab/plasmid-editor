"""
Several reads of one clone, compared.

One read cannot tell a real mutation from a bad basecall: Sanger reads are ragged at both
ends and a single wrong base there looks exactly like a point mutation. Two reads covering
the same base can tell them apart. Where every read that covers a position says the same
thing, it is the clone's sequence; where they disagree, at least one of them is wrong.

So each difference is judged by the reads that actually cover it:

  confirmed    every covering read shows it, and at least two do
  disputed     some covering reads show the reference instead - a bad call in one of them
  unverified   only one read covers it, so nothing contradicts it and nothing confirms it

An unverified difference still counts as a real difference to the clone. Missing a genuine
mutation is the worse mistake, so one read is enough to raise it; the coverage is reported
alongside so it is clear what it rests on.
"""
from typing import Any, Dict, List, Optional


def _spans(alignment: Dict[str, Any], n: int) -> List[tuple]:
    """The stretches of the reference a read covers, as plain (start, end) pairs with any
    wrap around the origin already split in two, so a position can be tested by range."""
    out = []
    for s in alignment.get('segments') or []:
        start, end = s.get('ref_start'), s.get('ref_end')
        if start is None or end is None:
            continue
        if end <= start:          # crosses the origin of a circular reference
            out.append((start, n))
            out.append((0, end))
        else:
            out.append((start, end))
    return out


def _covers(alignment: Dict[str, Any], position: int, n: int) -> bool:
    """Whether a read's alignment actually reaches a reference position. Only the stretches
    it covers count: the span between two flanks of a deletion is not coverage."""
    return any(start <= position < end for start, end in _spans(alignment, n))


def _key(d: Dict[str, Any]) -> tuple:
    """What makes two reads' differences the same difference."""
    return (d.get('position'), d.get('type'), (d.get('ref') or '').upper(), (d.get('read') or '').upper())


def _covered_bases(alignments: List[Dict[str, Any]], n: int) -> int:
    """How much of the reference the clone's reads cover between them, counting a base once
    however many reads reach it."""
    spans = sorted(s for a in alignments for s in _spans(a, n))
    total, reach = 0, -1
    for start, end in spans:
        start = max(start, reach)
        if end > start:
            total += end - start
            reach = end
    return total


def compare_reads(reference_length: int, reads: List[Dict[str, Any]]) -> Dict[str, Any]:
    """
    Compare the reads of one clone against each other.

    Each read is {'name', 'alignment'}; only reads whose alignment mapped are compared, since
    one that did not align says nothing about any position. Returns the clone's differences,
    each with the reads that cover it and the reads that show it, and a count of what was
    settled. `reference_length` is the reference's own length, so a circular read that wraps
    the origin is tested correctly.
    """
    n = reference_length
    mapped = [r for r in reads if (r.get('alignment') or {}).get('mapped')]
    unmapped = [r['name'] for r in reads if not (r.get('alignment') or {}).get('mapped')]

    found: Dict[tuple, Dict[str, Any]] = {}
    for r in mapped:
        for d in r['alignment'].get('differences') or []:
            entry = found.setdefault(_key(d), {
                'position': d.get('position'), 'type': d.get('type'),
                'ref': d.get('ref'), 'read': d.get('read'), 'length': d.get('length', 1),
                'showing': [], 'qualities': {},
            })
            entry['showing'].append(r['name'])
            if d.get('quality') is not None:
                entry['qualities'][r['name']] = d['quality']

    differences = []
    for entry in found.values():
        covering = [r['name'] for r in mapped if _covers(r['alignment'], entry['position'], n)]
        # A read showing a difference covers it by definition, even where rounding a span
        # at the very edge of an alignment would say otherwise.
        for name in entry['showing']:
            if name not in covering:
                covering.append(name)
        agreeing = [name for name in covering if name in entry['showing']]
        against = [name for name in covering if name not in entry['showing']]
        if against:
            verdict = 'disputed'
        elif len(covering) > 1:
            verdict = 'confirmed'
        else:
            verdict = 'unverified'
        differences.append({**entry, 'covering': covering, 'against': against,
                            'reads_showing': len(agreeing), 'reads_covering': len(covering),
                            'verdict': verdict,
                            # A disputed call is the clone's sequence only if the reads that
                            # show it outnumber those that do not; said plainly so the panel
                            # can explain why a difference was set aside.
                            'real': verdict != 'disputed' or len(agreeing) > len(against)})
    differences.sort(key=lambda d: (d['position'], d['type']))

    covered = _covered_bases([r['alignment'] for r in mapped], n)
    return {
        'reads': len(reads), 'mapped_reads': len(mapped), 'unmapped': unmapped,
        'covered_bases': covered,
        'covered_percent': round(100.0 * covered / n, 1) if n else 0.0,
        'differences': differences,
        'confirmed': sum(1 for d in differences if d['verdict'] == 'confirmed'),
        'disputed': sum(1 for d in differences if d['verdict'] == 'disputed'),
        'unverified': sum(1 for d in differences if d['verdict'] == 'unverified'),
        'real_differences': sum(1 for d in differences if d['real']),
        # Clean means every base the reads cover matches the reference, with nothing set
        # aside as a bad call: what someone wants to know before keeping the clone.
        'clean': not any(d['real'] for d in differences) and len(mapped) > 0,
    }


def compare_clones(reference_length: int, reads: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """
    Every clone among these reads, compared read against read. Reads carry 'clone_number';
    those without one are each their own group, since nothing says they share a colony.
    """
    groups: Dict[str, List[Dict[str, Any]]] = {}
    for r in reads:
        clone = (r.get('clone_number') or '').strip()
        groups.setdefault(clone or f"\0{r.get('id') or r.get('name')}", []).append(r)
    out = []
    for key, group in groups.items():
        named = not key.startswith('\0')
        out.append({'clone': key if named else None,
                    'named': named,
                    'read_names': [r['name'] for r in group],
                    **compare_reads(reference_length, group)})
    out.sort(key=lambda c: (not c['named'], str(c['clone'] or '').rjust(8)))
    return out
