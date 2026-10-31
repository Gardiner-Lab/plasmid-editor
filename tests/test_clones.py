"""
Comparing several reads of one clone. The reads here are made by mutating the reference and
aligning them for real, so the alignment's own output is what is being judged.
"""
import random

from dnakit import align, clones


def _ref(length=2000, seed=5):
    rng = random.Random(seed)
    return ''.join(rng.choice('ACGT') for _ in range(length))


def _read(ref, start, end, changes=(), quality=50):
    """A read off `ref` from start to end, with (offset_in_read, base) changes applied."""
    bases = list(ref[start:end])
    for offset, base in changes:
        bases[offset] = base
    return ''.join(bases), [quality] * (end - start)


def _aligned(ref, name, bases, quality, circular=False):
    return {'name': name, 'alignment': align.map_read(ref, bases, circular, quality, name)}


def test_a_difference_in_every_covering_read_is_confirmed():
    ref = _ref()
    # Both reads cover position 500 and both show the same G->A there.
    want = 'A' if ref[500] != 'A' else 'C'
    a_bases, a_q = _read(ref, 300, 900, [(200, want)])
    b_bases, b_q = _read(ref, 400, 1000, [(100, want)])
    out = clones.compare_reads(len(ref), [_aligned(ref, 'a', a_bases, a_q),
                                          _aligned(ref, 'b', b_bases, b_q)])
    assert out['mapped_reads'] == 2
    assert out['confirmed'] == 1 and out['disputed'] == 0 and out['unverified'] == 0
    d = out['differences'][0]
    assert d['position'] == 500 and d['ref'] == ref[500] and d['read'] == want
    assert d['reads_showing'] == 2 and d['reads_covering'] == 2
    assert d['verdict'] == 'confirmed' and d['real'] is True
    assert out['clean'] is False


def test_a_difference_only_one_of_two_covering_reads_shows_is_disputed_and_set_aside():
    ref = _ref()
    want = 'A' if ref[500] != 'A' else 'C'
    a_bases, a_q = _read(ref, 300, 900, [(200, want)])        # shows it
    b_bases, b_q = _read(ref, 300, 900)                        # covers it, matches the reference
    out = clones.compare_reads(len(ref), [_aligned(ref, 'a', a_bases, a_q),
                                          _aligned(ref, 'b', b_bases, b_q)])
    assert out['disputed'] == 1 and out['confirmed'] == 0
    d = out['differences'][0]
    assert d['reads_showing'] == 1 and d['reads_covering'] == 2
    assert d['against'] == ['b']
    assert d['verdict'] == 'disputed'
    assert d['real'] is False, 'one read against one is not the clone sequence'
    assert out['real_differences'] == 0
    assert out['clean'] is True, 'the only difference was a bad call, so the clone is clean'


def test_a_difference_two_reads_show_and_one_contradicts_stays_real():
    ref = _ref()
    want = 'A' if ref[500] != 'A' else 'C'
    reads = [_aligned(ref, 'a', *_read(ref, 300, 900, [(200, want)])),
             _aligned(ref, 'b', *_read(ref, 400, 1000, [(100, want)])),
             _aligned(ref, 'c', *_read(ref, 300, 900))]
    out = clones.compare_reads(len(ref), reads)
    d = out['differences'][0]
    assert d['reads_showing'] == 2 and d['reads_covering'] == 3 and d['against'] == ['c']
    assert d['verdict'] == 'disputed' and d['real'] is True, 'two reads outweigh one'
    assert out['real_differences'] == 1 and out['clean'] is False


def test_a_difference_only_one_read_reaches_is_unverified_but_still_counts():
    ref = _ref()
    want = 'A' if ref[1500] != 'A' else 'C'
    # Only the second read reaches 1500; the first stops long before it.
    reads = [_aligned(ref, 'near', *_read(ref, 100, 700)),
             _aligned(ref, 'far', *_read(ref, 1200, 1800, [(300, want)]))]
    out = clones.compare_reads(len(ref), reads)
    assert out['unverified'] == 1 and out['confirmed'] == 0 and out['disputed'] == 0
    d = out['differences'][0]
    assert d['position'] == 1500 and d['reads_covering'] == 1
    assert d['verdict'] == 'unverified'
    assert d['real'] is True, 'one read is enough to raise it; missing a real change is worse'
    assert out['real_differences'] == 1 and out['clean'] is False


def test_each_difference_carries_the_quality_of_the_read_bases_behind_it():
    ref = _ref()
    want = 'A' if ref[500] != 'A' else 'C'
    bases, quality = _read(ref, 300, 900, [(200, want)])
    quality[200] = 9                                           # a ragged call
    out = clones.compare_reads(len(ref), [_aligned(ref, 'a', bases, quality)])
    d = out['differences'][0]
    assert d['qualities'] == {'a': 9}, 'the panel needs the score to show why it is doubtful'


def test_reads_that_did_not_align_are_named_and_judge_nothing():
    ref = _ref()
    junk = ''.join('ACGT'[(i * 7) % 4] for i in range(400))    # nothing like the reference
    reads = [_aligned(ref, 'good', *_read(ref, 300, 900)),
             _aligned(ref, 'junk', junk, [50] * len(junk))]
    out = clones.compare_reads(len(ref), reads)
    assert out['reads'] == 2 and out['mapped_reads'] == 1
    assert out['unmapped'] == ['junk']
    assert out['clean'] is True


def test_coverage_counts_each_base_once_across_overlapping_reads():
    ref = _ref()
    reads = [_aligned(ref, 'a', *_read(ref, 0, 600)),
             _aligned(ref, 'b', *_read(ref, 400, 1000))]       # 200 bp of overlap
    out = clones.compare_reads(len(ref), reads)
    assert 960 <= out['covered_bases'] <= 1000, out['covered_bases']
    assert out['covered_percent'] <= 50.0


def test_a_clone_with_no_differences_where_its_reads_reach_is_clean():
    ref = _ref()
    reads = [_aligned(ref, 'a', *_read(ref, 100, 800)),
             _aligned(ref, 'b', *_read(ref, 700, 1400))]
    out = clones.compare_reads(len(ref), reads)
    assert out['differences'] == [] and out['clean'] is True


def test_reads_are_grouped_by_their_clone_and_compared_within_each():
    ref = _ref()
    want = 'A' if ref[500] != 'A' else 'C'
    def read(name, clone, changes=()):
        bases, quality = _read(ref, 300, 900, changes)
        return {'clone_number': clone, **_aligned(ref, name, bases, quality)}
    groups = clones.compare_clones(len(ref), [
        read('c1a', '1'), read('c1b', '1'),                               # clean clone
        read('c2a', '2', [(200, want)]), read('c2b', '2', [(200, want)]),  # real change
        read('c3a', '3', [(200, want)]), read('c3b', '3'),                 # bad call
    ])
    assert [g['clone'] for g in groups] == ['1', '2', '3']
    by_clone = {g['clone']: g for g in groups}
    assert by_clone['1']['clean'] is True and by_clone['1']['differences'] == []
    assert by_clone['2']['confirmed'] == 1 and by_clone['2']['clean'] is False
    assert by_clone['3']['disputed'] == 1 and by_clone['3']['clean'] is True


def test_reads_with_no_clone_number_are_not_treated_as_one_clone():
    ref = _ref()
    want = 'A' if ref[500] != 'A' else 'C'
    reads = [{'id': 'r1', **_aligned(ref, 'loose a', *_read(ref, 300, 900, [(200, want)]))},
             {'id': 'r2', **_aligned(ref, 'loose b', *_read(ref, 300, 900))}]
    groups = clones.compare_clones(len(ref), reads)
    assert len(groups) == 2, 'two reads with no clone named are not evidence about each other'
    assert all(g['clone'] is None and g['named'] is False for g in groups)
    assert groups[0]['differences'] and groups[0]['differences'][0]['verdict'] == 'unverified'


def test_a_read_crossing_the_origin_covers_both_ends_of_a_circular_plasmid():
    ref = _ref(1500, seed=9)
    # A read that runs off the end and back round to the start.
    bases = ref[1300:] + ref[:300]
    quality = [50] * len(bases)
    want = 'A' if ref[100] != 'A' else 'C'
    other = list(bases)
    other[len(ref) - 1300 + 100] = want                 # a change at position 100
    reads = [_aligned(ref, 'wrap a', bases, quality, circular=True),
             _aligned(ref, 'wrap b', ''.join(other), quality, circular=True)]
    out = clones.compare_reads(len(ref), reads)
    d = [x for x in out['differences'] if x['position'] == 100]
    assert d, f"expected a difference at 100, got {[x['position'] for x in out['differences']]}"
    assert d[0]['reads_covering'] == 2, 'both wrapped reads cover position 100'
    assert d[0]['verdict'] == 'disputed' and d[0]['real'] is False


def _revcomp(s):
    return s.translate(str.maketrans('ACGT', 'TGCA'))[::-1]


def test_quality_lands_on_the_right_base_for_a_reverse_strand_read():
    """
    A reverse read is flipped before alignment, so the quality of a difference has to be read
    back from the other end of the file. An off-by-one here would quietly blame the wrong base.
    """
    ref = _ref()
    want = 'A' if ref[500] != 'A' else 'C'
    forward = list(ref[300:900])
    forward[200] = want                       # the difference, at offset 200 of the forward piece
    bases = _revcomp(''.join(forward))        # the read as the sequencer produced it
    # Give every base a high score except the one behind the difference, which in the
    # reverse-complemented file sits at the mirrored offset.
    mirrored = len(bases) - 1 - 200
    quality = [50] * len(bases)
    quality[mirrored] = 7

    out = clones.compare_reads(len(ref), [_aligned(ref, 'rev', bases, quality)])
    d = out['differences'][0]
    assert d['position'] == 500 and d['read'] == want
    assert d['qualities'] == {'rev': 7}, 'the low score belongs to the base behind the difference'


def test_a_forward_and_reverse_read_of_one_clone_confirm_each_other():
    """The everyday case: a plasmid read from both ends, the two reads overlapping."""
    ref = _ref()
    want = 'A' if ref[500] != 'A' else 'C'
    fwd = list(ref[300:900]); fwd[200] = want
    rev = list(ref[400:1000]); rev[100] = want
    reads = [_aligned(ref, 'M13F', ''.join(fwd), [50] * 600),
             _aligned(ref, 'M13R', _revcomp(''.join(rev)), [50] * 600)]
    out = clones.compare_reads(len(ref), reads)
    assert out['mapped_reads'] == 2
    assert [r['alignment']['strand'] for r in reads] == [1, -1], 'one read each way'
    assert out['confirmed'] == 1 and out['disputed'] == 0
    d = out['differences'][0]
    assert d['position'] == 500 and d['reads_showing'] == 2 and d['reads_covering'] == 2
