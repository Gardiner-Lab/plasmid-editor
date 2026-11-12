"""Primers for bisulfite PCR (dnakit/bisulfite.py)."""
import random

import pytest

from dnakit import bisulfite
from dnakit.model import reverse_complement


def _plant_like(n=1500, seed=7):
    """A made-up AT-rich stretch, as plant intergenic DNA is (about 34% GC)."""
    rng = random.Random(seed)
    return ''.join(rng.choices('ACGT', weights=[33, 17, 17, 33], k=n))


@pytest.fixture(scope='module')
def designed():
    return bisulfite.design(_plant_like(), offset=1000)


def _expand(primer):
    """Every concrete sequence a degenerate primer stands for (Y = C/T, R = G/A)."""
    out = ['']
    for base in primer:
        out = [s + b for s in out for b in {'Y': 'CT', 'R': 'GA'}.get(base, base)]
    return out


def test_conversion_and_repeats():
    assert bisulfite.convert('ACGTCG', 'top') == 'ATGTTG'
    assert bisulfite.convert('ACGTCG', 'bottom') == 'ACATCA'
    assert bisulfite.longest_repeat('GATTTTC') == 4
    assert bisulfite.longest_repeat('GATATATC') == 3          # AT three times
    assert bisulfite.longest_repeat('GAAGAAGAAC') == 3        # AAG three times
    assert bisulfite.longest_repeat('TTYTT') == 5             # Y read as T: a run of five


def test_every_pair_binds_its_converted_strand(designed):
    seq = _plant_like()
    primers = designed['primers']
    assert designed['pairs'], 'an AT-rich stretch has bisulfite primers'
    for pair in designed['pairs']:
        f, r = primers[pair['forward']], primers[pair['reverse']]
        assert f['strand'] == r['strand'] == pair['strand']
        # Positions are in the document: the offset is added, once.
        fs, re_ = f['start'] - 1000, r['end'] - 1000
        assert seq[fs:f['end'] - 1000] == f['site'] and seq[r['start'] - 1000:re_] == r['site']
        assert pair['product'] == re_ - fs and 200 <= pair['product'] <= 500
        # The converted forward strand, whether a C was methylated or not, is among what each primer
        # stands for; the reverse primer anneals to the reverse complement of the converted strand.
        conv_unmeth = bisulfite.convert(seq, pair['strand'])
        assert conv_unmeth[fs:f['end'] - 1000] in _expand(f['sequence'])
        assert reverse_complement(conv_unmeth[r['start'] - 1000:re_]) in _expand(r['sequence'])
        assert seq[fs:f['end'] - 1000] in _expand(f['sequence'])      # fully methylated
        degenerate = 'Y' if pair['strand'] == 'top' else 'R'
        assert set(f['sequence']) <= set('ACGT' + degenerate)
        assert set(r['sequence']) <= set('ACGT' + ('R' if degenerate == 'Y' else 'Y'))
        for p in (f, r):
            assert 25 <= p['length'] <= 30 and p['degenerate'] <= 2 and p['repeat'] <= 3
            assert 51 <= p['tm'] <= 64 and p['hairpin'] <= 41 and p['homodimer'] <= 41
        assert pair['tm_diff'] <= 5 and pair['heterodimer'] <= 41
    scores = [p['score'] for p in designed['pairs']]
    assert scores == sorted(scores)


def test_choosing_skips_overlaps_and_what_a_check_turns_down(designed):
    primers = designed['primers']
    chosen = bisulfite.choose(designed, 5)
    assert 1 < len(chosen) <= 5 and chosen[0] is designed['pairs'][0]
    spans = {}
    for pair in chosen:
        for side in ('forward', 'reverse'):
            p = primers[pair[side]]
            for other in spans.get(pair['strand'], []):
                assert min(p['end'], other[1]) - max(p['start'], other[0]) <= 20
        spans.setdefault(pair['strand'], []).extend(
            (primers[pair[s]]['start'], primers[pair[s]]['end']) for s in ('forward', 'reverse'))
    # A genome check that turns down the best pair's forward primer: that pair is not suggested.
    bad = designed['pairs'][0]['forward']
    again = bisulfite.choose(designed, 5, passes=lambda p: p['id'] != bad)
    assert all(pair['forward'] != bad for pair in again)


def test_one_strand_and_the_options_used():
    top = bisulfite.design(_plant_like(), {'strand': 'top', 'max_degenerate': 1, 'max_product': 400})
    assert {p['strand'] for p in top['pairs']} == {'top'} and set(top['passed']) == {'top'}
    assert all(top['primers'][p['forward']]['degenerate'] <= 1 and p['product'] <= 400 for p in top['pairs'])
    assert top['options']['max_self_tm'] == 41          # the minimum Tm less 10, unless given


@pytest.mark.parametrize('options, message', [
    ({'strand': 'sideways'}, 'strand'),
    ({'min_len': 30, 'max_len': 25}, 'primer lengths'),
    ({'min_product': 600, 'max_product': 500}, 'product length'),
    ({'min_tm': 70}, 'Tm'),
])
def test_options_are_checked(options, message):
    with pytest.raises(ValueError, match=message):
        bisulfite.design(_plant_like(), options)


def test_region_limits():
    with pytest.raises(ValueError, match='shorter than the minimum product'):
        bisulfite.design('ACGT' * 20)
    with pytest.raises(ValueError, match='at most'):
        bisulfite.design('A' * (bisulfite.LIMITS['region'] + 1))


def test_the_endpoint_designs_in_a_region_or_the_whole_sequence(user_client):
    seq = 'GGGGCCCCGG' * 10 + _plant_like() + 'GGGGCCCCGG' * 10
    doc = {'name': 'promoter', 'sequence': seq, 'circular': False}
    r = user_client.post('/api/tools/bisulfite-primers', json={
        'document': doc, 'start': 100, 'end': 1600, 'options': {'strand': 'top', 'max_self_tm': ''}})
    assert r.status_code == 200, r.get_json()
    body = r.get_json()
    assert body['pairs'] and set(body['passed']) == {'top'} and body['options']['max_self_tm'] == 41
    assert all(100 <= p['start'] and p['end'] <= 1600 for p in body['primers'])
    assert seq[body['primers'][0]['start']:body['primers'][0]['end']] == body['primers'][0]['site']
    whole = user_client.post('/api/tools/bisulfite-primers', json={'document': doc})
    assert whole.status_code == 200 and whole.get_json()['length'] == len(seq)
    bad = user_client.post('/api/tools/bisulfite-primers', json={'document': doc, 'start': 1600, 'end': 100})
    assert bad.status_code == 400 and 'region' in bad.get_json()['error']
