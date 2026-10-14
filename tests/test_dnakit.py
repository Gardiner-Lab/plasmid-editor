"""Tests for the dnakit core library."""

import random

import pytest

from dnakit import align, assembly, features, model, primers, restriction, seqio, snapgene, translate

random.seed(1)


def rand_dna(n, avoid=('GAATTC', 'GGTCTC', 'GAGACC', 'GGATCC')):
    while True:
        s = ''.join(random.choice('ACGT') for _ in range(n))
        if not any(a in s for a in avoid):
            return s


# --- model -----------------------------------------------------------------

def test_reverse_complement_iupac():
    assert model.reverse_complement('AACGTRY') == 'RYACGTT'


def test_rotate_keeps_feature_sequence():
    seq = rand_dna(100)
    doc = model.make_document('x', seq, True, [model.make_feature('f', 90, 10)])
    before = model.feature_sequence(doc, doc['features'][0])
    rot = model.rotate(doc, 50)
    assert model.feature_sequence(rot, rot['features'][0]) == before


def test_revcomp_document_feature():
    seq = rand_dna(60)
    doc = model.make_document('x', seq, False, [model.make_feature('f', 10, 20, 1)])
    rc = model.reverse_complement_document(doc)
    assert model.feature_sequence(rc, rc['features'][0]) == seq[10:20]


# --- seqio -----------------------------------------------------------------

def test_genbank_roundtrip_with_wrapping_feature():
    seq = rand_dna(200)
    doc = model.make_document('pTest', seq, True,
                              [model.make_feature('wrap', 190, 15, 1, 'CDS', '#ff0000'),
                               model.make_feature('rev', 30, 60, -1, 'promoter')])
    gb = seqio.write_genbank(doc)
    back = seqio.read_sequences(gb.encode(), 'pTest.gb')[0]
    assert back['sequence'] == seq and back['circular']
    names = {f['name']: f for f in back['features']}
    assert (names['wrap']['start'], names['wrap']['end']) == (190, 15)
    assert names['wrap']['color'] == '#ff0000'
    assert names['rev']['strand'] == -1


def test_translations_go_out_as_cds_and_come_back_as_translations():
    gfp_start = 'ATGGCTAGCAAAGGAGAAGAACTTTTCACTGGAGTTGTCCCAATTCTTGTTGAATTAGATGGTGATG'   # MASKGEELFTGVVPILVELDGD
    seq = 'CC' + gfp_start + 'TAAGG' + model.reverse_complement(gfp_start) + 'C' * 20
    doc = model.make_document('pT', seq, True, [model.make_feature('marker', 0, 10, 1, 'misc_feature')])
    doc['translations'] = [
        {'id': 't1', 'name': 'GFP start', 'start': 2, 'end': 2 + len(gfp_start) + 3, 'strand': 1},
        {'id': 't2', 'name': 'GFP start, reverse', 'start': 2 + len(gfp_start) + 5,
         'end': 2 + 2 * len(gfp_start) + 5, 'strand': -1},
        {'id': 't3', 'name': 'through the origin', 'start': len(seq) - 6, 'end': 6, 'strand': 1},
    ]
    gb = seqio.write_genbank(doc)
    # Other programs see an ordinary CDS with its protein (the stop left out).
    assert '/translation="MASKGEELFTGVVPILVELDGD"' in gb
    assert gb.count('/note="Plasmid Editor translation"') == 3
    assert 'complement(' in gb and 'join(' in gb

    back = seqio.read_sequences(gb.encode(), 'pT.gb')[0]
    assert [f['name'] for f in back['features']] == ['marker']
    assert [(t['name'], t['start'], t['end'], t['strand']) for t in back['translations']] == [
        (t['name'], t['start'], t['end'], t['strand']) for t in doc['translations']]
    assert translate.translate_stretch(seq, **{k: back['translations'][1][k] for k in ('start', 'end', 'strand')})         == 'MASKGEELFTGVVPILVELDGD'


def test_an_ordinary_cds_stays_a_feature():
    doc = model.make_document('p', 'ATGAAATAA' * 4, False, [model.make_feature('orf', 0, 9, 1, 'CDS')])
    back = seqio.read_sequences(seqio.write_genbank(doc).encode(), 'p.gb')[0]
    assert [f['name'] for f in back['features']] == ['orf'] and back['translations'] == []


def test_snapgene_round_trip_keeps_features_colours_and_translations():
    seq = rand_dna(300).lower()[:150] + rand_dna(150)       # case is kept, as SnapGene does
    doc = model.make_document('pSnap', seq, True,
                              [model.make_feature('wrap', 280, 20, 1, 'CDS', '#ff0000'),
                               model.make_feature('rev', 40, 90, -1, 'promoter', '#00aa00'),
                               model.make_feature('plain', 100, 130, 1, 'misc_feature')])
    doc['translations'] = [{'id': 't', 'name': 'peptide', 'start': 150, 'end': 180, 'strand': -1}]
    data = seqio.write_snapgene(doc)
    assert data[:1] == b'	' and data[5:13] == b'SnapGene'
    assert snapgene.is_snapgene(data)

    back = seqio.read_sequences(data, 'pSnap.dna')[0]
    assert back['sequence'] == seq and back['circular'] and back['name'] == 'pSnap'
    got = {f['name']: f for f in back['features']}
    assert (got['wrap']['start'], got['wrap']['end'], got['wrap']['color']) == (280, 20, '#ff0000')
    assert (got['rev']['strand'], got['rev']['color']) == (-1, '#00aa00')
    assert [(t['name'], t['start'], t['end'], t['strand']) for t in back['translations']] == [
        ('peptide', 150, 180, -1)]


def test_snapgene_converts_to_and_from_genbank():
    doc = model.make_document('pConv', rand_dna(120), False,
                              [model.make_feature('orf', 0, 60, 1, 'CDS', '#123456')])
    data = snapgene.from_genbank(seqio.write_genbank(doc))
    gb = snapgene.to_genbank(data, 'pConv file')
    back = seqio.read_sequences(gb.encode(), 'pConv.gb')[0]
    assert back['sequence'] == doc['sequence'] and not back['circular']
    assert [(f['name'], f['start'], f['end'], f['color']) for f in back['features']] == [('orf', 0, 60, '#123456')]


def test_read_fasta_and_raw():
    docs = seqio.read_sequences(b'>a\nACGTACGT\n>b\nGGGG\n', 'x.fa')
    assert [d['name'] for d in docs] == ['a', 'b']
    raw = seqio.read_sequences(b'1 acgt acgt\n11 ggcc', 'clip.txt')[0]
    assert raw['sequence'] == 'acgtacgtggcc'


# --- restriction -----------------------------------------------------------

def test_find_sites_and_cut_positions():
    seq = 'AAAA' + 'GAATTC' + 'TTTT'
    hits = restriction.find_sites(seq, ['EcoRI'])
    assert len(hits) == 1  # palindrome reported once
    assert hits[0]['cut_top'] == 5 and hits[0]['cut_bottom'] == 9


def test_site_across_origin():
    seq = 'ATTC' + rand_dna(50) + 'GA'
    assert restriction.site_counts(seq, ['EcoRI'], circular=True)['EcoRI'] == 1
    assert restriction.site_counts(seq, ['EcoRI'], circular=False)['EcoRI'] == 0


def test_type_iis_reverse_site():
    # GAGACC is BsaI on the bottom strand; it cuts upstream (to the left).
    seq = rand_dna(20) + 'AAAA' + 'T' + 'GAGACC' + rand_dna(20)
    h = restriction.find_sites(seq, ['BsaI'])[0]
    assert h['strand'] == -1
    assert h['cut_top'] == 20 and h['cut_bottom'] == 24
    assert seq[20:24] == 'AAAA'


def test_digest_circular_two_sites_lengths_sum():
    seq = rand_dna(300) + 'GAATTC' + rand_dna(400) + 'GAATTC' + rand_dna(100)
    frags = restriction.digest(seq, ['EcoRI'], circular=True)
    assert len(frags) == 2
    assert sum(f['length'] for f in frags) == len(seq)
    for f in frags:
        assert f['left']['overhang'] == 'AATT' and f['left']['kind'] == "5'"
        assert f['top'].startswith('AATTC')


def test_digest_linear_three_fragments():
    seq = rand_dna(100) + 'GAATTC' + rand_dna(100) + 'GGATCC' + rand_dna(100)
    frags = restriction.digest(seq, ['EcoRI', 'BamHI'])
    assert [f['length'] for f in frags] == [101, 106, 105]


def test_silent_site_preserves_protein():
    cds = 'ATG' + 'GAA' + 'TTT' + 'AAA' + 'GGT' + 'TCT' + 'CCC' + 'TAA'
    res = restriction.silent_sites(cds, 0, len(cds), ['EcoRI'], max_changes=2)
    assert res
    r = res[0]
    mutated = cds[:r['replace_start']] + r['new'] + cds[r['replace_end']:]
    assert 'GAATTC' in mutated
    assert translate.translate(mutated) == translate.translate(cds)


def test_diagnostic_digest_distinguishes():
    a = rand_dna(1000) + 'GAATTC' + rand_dna(2000)
    b = rand_dna(1500) + 'GAATTC' + rand_dna(800) + 'GAATTC' + rand_dna(1200)
    res = restriction.diagnostic_digests([model.make_document('a', a, True), model.make_document('b', b, True)],
                                         ['EcoRI', 'BamHI'], max_enzymes=1, min_bands=1)
    assert res and res[0]['enzymes'] == ['EcoRI']


# --- translate -------------------------------------------------------------

def test_translate_and_orfs():
    orf = 'ATG' + 'GCT' * 80 + 'TAA'
    seq = 'CCC' + orf + 'GGG'
    assert translate.translate(orf, to_stop=True) == 'M' + 'A' * 80
    found = translate.find_orfs(seq, min_aa=50)
    assert found[0]['start'] == 3 and found[0]['end'] == 3 + len(orf) and found[0]['strand'] == 1


def test_orf_reverse_strand():
    orf = 'ATG' + 'GCT' * 80 + 'TAA'
    seq = 'CC' + model.reverse_complement(orf) + 'G'
    o = translate.find_orfs(seq, min_aa=50)[0]
    assert o['strand'] == -1 and (o['start'], o['end']) == (2, 2 + len(orf))


# --- primers ---------------------------------------------------------------

def test_tm_reasonable():
    t = primers.tm('AGCGGATAACAATTTCACACAGGA')
    assert 55 < t < 70


def test_pcr_with_tails():
    tpl = rand_dna(500)
    fwd = 'GGGGGG' + tpl[100:120]
    rev = 'CCCCCC' + model.reverse_complement(tpl[300:320])
    prods = primers.pcr(tpl, fwd, rev)
    assert len(prods) == 1
    assert prods[0]['sequence'] == 'GGGGGG' + tpl[100:320] + 'GGGGGG'


def test_pcr_across_origin():
    tpl = rand_dna(400)
    fwd = tpl[350:370]
    rev = model.reverse_complement(tpl[30:50])
    p = primers.pcr(tpl, fwd, rev, circular=True)[0]
    assert p['sequence'] == tpl[350:] + tpl[:50]


def test_design_primers_amplify_region():
    tpl = rand_dna(600)
    d = primers.design_primers(tpl, 100, 400, forward_tail='GAATTC')
    prods = primers.pcr(tpl, d['forward']['full'], d['reverse']['full'])
    assert prods[0]['sequence'] == 'GAATTC' + tpl[100:400]


# --- assembly --------------------------------------------------------------

def test_restriction_ligation_insert_both_orientations():
    vec = rand_dna(800) + 'GAATTC' + rand_dna(200)
    ins = rand_dna(50) + 'GAATTC' + rand_dna(300) + 'GAATTC' + rand_dna(50)
    vdoc = model.make_document('vec', vec, True)
    idoc = model.make_document('ins', ins, False)
    ifr = [i for i, f in enumerate(assembly.fragments_from(idoc, ['EcoRI'])) if f['left'] and f['right']][0]
    prods = assembly.restriction_ligation(vdoc, ['EcoRI'], 0, idoc, ['EcoRI'], ifr)
    assert len(prods) == 2
    assert all(len(p['sequence']) == len(vec) + 306 for p in prods)


def test_golden_gate_three_parts():
    bsai_f, bsai_r = 'GGTCTCA', 'TGAGACC'
    oh = ['AAAA', 'CCCC', 'GGTT']
    p1 = rand_dna(30) + bsai_f + oh[0] + rand_dna(100) + oh[1] + bsai_r + rand_dna(30)
    p2 = rand_dna(30) + bsai_f + oh[1] + rand_dna(150) + oh[2] + bsai_r + rand_dna(30)
    # The backbone keeps the first and last overhangs of the insert chain.
    bb = oh[0] + bsai_r + rand_dna(400) + bsai_f + oh[2] + rand_dna(1500)
    docs = [model.make_document('p1', p1, True), model.make_document('p2', p2, True),
            model.make_document('bb', bb, True)]
    res = assembly.golden_gate(docs, 'BsaI')
    assert res['products'], res['log']
    prod = res['products'][0]['sequence']
    assert len(prod) == 4 + 100 + 4 + 150 + 4 + 1500
    assert restriction.site_counts(prod, ['BsaI'], True)['BsaI'] == 0


def test_gibson_three_fragments_circular():
    full = rand_dna(900)
    a, b, c = full[:330], full[300:630], full[600:] + full[:30]
    res = assembly.overlap_assembly([{'name': 'a', 'sequence': a}, {'name': 'b', 'sequence': model.reverse_complement(b)},
                                     {'name': 'c', 'sequence': c}], circular=True, min_overlap=20)
    assert res['product']['sequence'] == full
    # b was supplied reverse-complemented, so its junction reports the flip.
    assert res['junctions'][0]['overlap'] == 30 and res['junctions'][0]['flipped'] is True
    assert [j['overlap'] for j in res['junctions']] == [30, 30, 30]


def test_recombination_double_crossover():
    lox1, lox2 = 'ATAACTTCGTATAGCATACATTATACGAAGTTAT', 'ATAACTTCGTATAGTATACCTTATACGAAGTTAT'
    gene = rand_dna(300)
    donor = model.make_document('donor', rand_dna(200) + lox1 + gene + lox2 + rand_dna(200), True)
    acc_bb = rand_dna(800)
    acceptor = model.make_document('acc', lox1 + rand_dna(150) + lox2 + acc_bb, True)
    res = assembly.recombine(donor, acceptor, min_core=20)
    assert res
    prod = res[0]['document']['sequence']
    # The product is circular, so compare against a doubled copy: an exact
    # core match may sit one base off and rotate the origin harmlessly.
    assert gene in prod + prod and acc_bb in prod + prod
    assert len(prod) == len(lox1) + len(gene) + len(lox2) + len(acc_bb)
    # The acceptor's original 150 bp cassette between the cores is gone.
    assert acceptor['sequence'][34:184] not in prod + prod


# --- features --------------------------------------------------------------

def test_ape_library_parse_and_annotate():
    lib = features.parse_library('lacO\tAATTGTGAGCGGATAACAATT\tprotein_bind\t#ff00ff\t#00ff00\t0\n#comment\n')
    assert lib[0]['name'] == 'lacO' and lib[0]['reverse_color'] == '#00ff00'
    seq = rand_dna(50) + model.reverse_complement('AATTGTGAGCGGATAACAATT') + rand_dna(50)
    doc = model.make_document('x', seq, False)
    new = features.auto_annotate(doc, lib)
    assert len(new) == 1 or len(new) == 2  # lacO is near-palindromic
    assert features.write_library(lib).startswith('lacO\tAATTGTGAGCGGATAACAATT')


def test_find_degenerate_and_protein():
    seq = 'AAAGAATTCAAA'
    assert features.find_pattern(seq, 'GANTTC')[0]['start'] == 3
    prot_seq = 'CC' + 'ATGTGGCATCAC' + 'GG'
    hits = features.find_protein(prot_seq, 'MWHH')
    assert hits[0]['start'] == 2 and hits[0]['strand'] == 1


# --- align -----------------------------------------------------------------

def test_map_read_finds_mismatch_on_reverse_strand():
    ref = rand_dna(800)
    read = list(ref[200:600])
    read[100] = 'A' if read[100] != 'A' else 'C'
    read = model.reverse_complement(''.join(read))
    r = align.map_read(ref, read)
    assert r['mapped'] and r['strand'] == -1
    assert (r['ref_start'], r['ref_end']) == (200, 600)
    assert [d['position'] for d in r['differences']] == [300]


def test_map_read_across_origin():
    ref = rand_dna(600)
    read = ref[500:] + ref[:150]
    r = align.map_read(ref, read, circular=True)
    assert r['mapped'] and r['ref_start'] == 500 and r['ref_end'] == 150 and not r['differences']
    assert align.coverage(600, [r]) == [[0, 150], [500, 600]]


def test_pairwise_identity():
    a = rand_dna(300)
    res = align.pairwise(a, model.reverse_complement(a[50:250]))
    assert res['reverse_complemented'] and res['identity'] == 100.0
