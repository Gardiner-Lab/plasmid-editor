"""Tests for the web API, including the shared MoClo database bridge."""

import sqlite3

from dnakit import model


def _gg_plasmid(rand_dna, insert_len=400):
    """A plasmid whose BsaI sites release one insert with standard MoClo overhangs."""
    insert = rand_dna(insert_len)
    return ('GGTCTCA' + 'AATG' + insert + 'GCTT' + 'TGAGACC' + rand_dna(2000), insert)


def test_health_and_session(client):
    r = client.get('/health')
    assert r.status_code == 200 and r.get_json()['status'] == 'healthy'
    assert client.get('/api/auth/session').get_json()['authenticated'] is False


def test_register_first_user_is_admin_and_login(client):
    r = client.post('/api/auth/register', json={'username': 'first', 'password': 'password123'})
    assert r.status_code == 201 and r.get_json()['user']['is_admin'] is True
    client.post('/api/auth/logout')
    assert client.post('/api/auth/login', json={'username': 'first', 'password': 'wrong'}).status_code == 401
    assert client.post('/api/auth/login', json={'username': 'first', 'password': 'password123'}).status_code == 200


def test_register_rejects_short_password(client):
    r = client.post('/api/auth/register', json={'username': 'bob', 'password': 'short'})
    assert r.status_code == 400 and 'at least' in r.get_json()['error']


def test_api_requires_authentication(client):
    assert client.get('/api/sequences').status_code == 401
    assert client.post('/api/tools/sites', json={}).status_code == 401


def test_upload_parse_genbank(user_client, rand_dna):
    doc = model.make_document('pTest', rand_dna(500), True, [model.make_feature('gfp', 10, 100, 1, 'CDS')])
    from dnakit import seqio
    data = {'file': (__import__('io').BytesIO(seqio.write_genbank(doc).encode()), 'pTest.gb')}
    r = user_client.post('/api/sequences/parse', data=data, content_type='multipart/form-data')
    assert r.status_code == 200
    parsed = r.get_json()['documents'][0]
    assert parsed['circular'] and parsed['features'][0]['name'] == 'gfp'


def test_save_list_update_delete_sequence(user_client, rand_dna):
    seq = rand_dna(300)
    r = user_client.post('/api/sequences', json={'document': model.make_document('p1', seq, True)})
    assert r.status_code == 201
    sid = r.get_json()['sequence']['id']

    listing = user_client.get('/api/sequences').get_json()['sequences']
    assert [s['name'] for s in listing] == ['p1'] and listing[0]['length'] == 300

    r = user_client.patch(f'/api/sequences/{sid}', json={'golden_gate': True})
    assert r.get_json()['sequence']['golden_gate'] is True
    assert user_client.get('/api/sequences?golden_gate=true').get_json()['sequences']

    r = user_client.get(f'/api/sequences/{sid}/export/genbank')
    assert r.status_code == 200 and b'LOCUS' in r.data
    r = user_client.get(f'/api/sequences/{sid}/export/fasta')
    assert r.data.startswith(b'>p1')

    assert user_client.delete(f'/api/sequences/{sid}').status_code == 200
    assert user_client.get(f'/api/sequences/{sid}').status_code == 404


def test_private_sequence_hidden_from_others(user_client, client, rand_dna):
    r = user_client.post('/api/sequences', json={'document': model.make_document('secret', rand_dna(200), True),
                                                 'shared': False})
    sid = r.get_json()['sequence']['id']
    user_client.post('/api/auth/logout')
    client.post('/api/auth/register', json={'username': 'other', 'password': 'password123'})
    assert client.get(f'/api/sequences/{sid}').status_code == 403
    assert client.get('/api/sequences').get_json()['sequences'] == []


def test_restriction_and_digest_endpoints(user_client, rand_dna):
    seq = rand_dna(400) + 'GAATTC' + rand_dna(600)
    doc = model.make_document('p', seq, True)
    r = user_client.post('/api/tools/sites', json={'document': doc, 'enzymes': ['EcoRI', 'BamHI']})
    body = r.get_json()
    assert body['counts'] == {'EcoRI': 1} and body['non_cutters'] == ['BamHI']

    r = user_client.post('/api/tools/digest', json={'document': doc, 'enzymes': ['EcoRI']})
    frags = r.get_json()['fragments']
    assert len(frags) == 1 and frags[0]['length'] == len(seq)

    r = user_client.post('/api/tools/gel', json={'lanes': [{'document': doc, 'enzymes': ['EcoRI']}],
                                                 'ladder': '1 kb ladder'})
    assert r.get_json()['lanes'][0]['bands'][0]['size'] == len(seq)


def test_orf_pcr_and_alignment_endpoints(user_client, rand_dna):
    orf = 'ATG' + 'GCT' * 100 + 'TAA'
    seq = rand_dna(200) + orf + rand_dna(200)
    doc = model.make_document('p', seq, False)
    # Shifted frames of a (GCT)n repeat contain no stop codon, so longer ORFs
    # from upstream ATGs are real; just require the intended one to be found.
    found = user_client.post('/api/tools/orfs', json={'document': doc, 'min_aa': 50}).get_json()['orfs']
    assert any(o['start'] == 200 and o['end'] == 200 + len(orf) and o['strand'] == 1 for o in found)

    r = user_client.post('/api/tools/pcr', json={'document': doc, 'forward': seq[100:122],
                                                 'reverse': model.reverse_complement(seq[500:522])})
    assert r.get_json()['products'][0]['length'] == 422

    r = user_client.post('/api/tools/design-primers', json={'document': doc, 'start': 100, 'end': 500})
    design = r.get_json()
    assert 50 < design['forward']['tm'] < 70 and design['product_length'] == 400

    read = model.reverse_complement(seq[300:600])
    r = user_client.post('/api/tools/align-reads', json={'document': doc, 'reads': [{'name': 'r1', 'sequence': read}]})
    mapped = r.get_json()['reads'][0]
    assert mapped['mapped'] and mapped['strand'] == -1 and mapped['ref_start'] == 300


def test_golden_gate_analyze_endpoint(user_client, rand_dna):
    seq, insert = _gg_plasmid(rand_dna)
    doc = model.make_document('pPart', seq, True, [model.make_feature('cds', 11, 200, 1, 'CDS')])
    r = user_client.post('/api/sequences/golden-gate/analyze', json={'document': doc})
    body = r.get_json()
    assert body['ready'] and body['best']['enzyme'] == 'BsaI'
    assert body['best']['insert']['overhang_5prime'] == 'AATG'
    assert body['best']['insert']['overhang_3prime'] == 'GCTT'
    assert body['best']['standard_moclo'] is True
    assert body['suggested_part_type'] == 'Coding'
    assert insert in body['best']['insert']['sequence']


def test_golden_gate_analyze_reports_why_not_ready(user_client, rand_dna):
    doc = model.make_document('plain', rand_dna(1000), True)
    body = user_client.post('/api/sequences/golden-gate/analyze', json={'document': doc}).get_json()
    assert body['ready'] is False and body['best'] is None


def test_contribute_part_to_shared_moclo_db(user_client, moclo_parts_db, rand_dna):
    seq, insert = _gg_plasmid(rand_dna)
    doc = model.make_document('pGG-GFP', seq, True, [model.make_feature('GFP', 11, 300, 1, 'CDS')])
    r = user_client.post('/api/sequences', json={'document': doc, 'golden_gate': True})
    sid = r.get_json()['sequence']['id']

    r = user_client.post(f'/api/sequences/{sid}/contribute', json={})
    assert r.status_code == 201, r.get_json()
    result = r.get_json()['contributed']
    assert result['part_type'] == 'Coding' and result['enzyme'] == 'BsaI'
    assert (result['overhang_5prime'], result['overhang_3prime']) == ('AATG', 'GCTT')

    conn = sqlite3.connect(moclo_parts_db['parts'])
    conn.row_factory = sqlite3.Row
    row = conn.execute('SELECT * FROM parts').fetchone()
    assert row['name'] == 'pGG-GFP' and row['contributor'] == 'tester'
    assert row['lab_source'] == 'Gardiner Lab' and row['part_type'] == 'Coding'
    # MoClo stores a part with both fusion sites: 5' first, 3' last, so that
    # assemble_parts() can overlap the shared 4 bp scar at each junction.
    assert row['sequence'] == 'AATG' + insert + 'GCTT'
    assert row['overhang_5prime'] == 'AATG' and row['overhang_3prime'] == 'GCTT'
    assert row['size'] == len(seq)
    assert 'GFP' in row['features']
    conn.close()

    # The editor records which MoClo part it became, and refuses a duplicate.
    assert user_client.get(f'/api/sequences/{sid}').get_json()['sequence']['moclo_part_id'] == result['part_id']
    again = user_client.post(f'/api/sequences/{sid}/contribute', json={})
    assert again.status_code == 400 and 'already exists' in again.get_json()['error']


def test_contribute_requires_flag_and_readiness(user_client, moclo_parts_db, rand_dna):
    seq, _ = _gg_plasmid(rand_dna)
    r = user_client.post('/api/sequences', json={'document': model.make_document('p', seq, True)})
    sid = r.get_json()['sequence']['id']
    unflagged = user_client.post(f'/api/sequences/{sid}/contribute', json={})
    assert unflagged.status_code == 400 and 'Golden Gate ready' in unflagged.get_json()['error']

    r = user_client.post('/api/sequences', json={'document': model.make_document('plain', rand_dna(900), True),
                                                 'golden_gate': True})
    sid2 = r.get_json()['sequence']['id']
    bad = user_client.post(f'/api/sequences/{sid2}/contribute', json={})
    assert bad.status_code == 400 and 'clean Golden Gate insert' in bad.get_json()['error']


def test_contribute_without_shared_db_explains(user_client, tmp_dbs, rand_dna):
    seq, _ = _gg_plasmid(rand_dna)
    r = user_client.post('/api/sequences', json={'document': model.make_document('p', seq, True),
                                                 'golden_gate': True})
    sid = r.get_json()['sequence']['id']
    r = user_client.post(f'/api/sequences/{sid}/contribute', json={})
    assert r.status_code == 400 and 'not mounted' in r.get_json()['error']


def test_browse_and_import_moclo_part(user_client, moclo_parts_db, rand_dna):
    insert = 'AATG' + rand_dna(300) + 'GCTT'
    conn = sqlite3.connect(moclo_parts_db['parts'])
    conn.execute('INSERT INTO parts (id, name, part_type, sequence, overhang_5prime, overhang_3prime, '
                 'lab_source, contributor, features) VALUES (?,?,?,?,?,?,?,?,?)',
                 ('part-1', 'pICH-GFP', 'Coding', insert, 'AATG', 'GCTT', 'Weber', 'alice',
                  '[{"type": "CDS", "label": "GFP", "start": 4, "end": 200, "strand": 1}]'))
    conn.commit()
    conn.close()

    listing = user_client.get('/api/moclo/parts').get_json()['parts']
    assert listing[0]['name'] == 'pICH-GFP' and listing[0]['length'] == len(insert)

    doc = user_client.get('/api/moclo/parts/part-1').get_json()['document']
    assert doc['sequence'] == insert and doc['features'][0]['name'] == 'GFP'
    assert doc['source']['tool'] == 'moclo'

    r = user_client.post('/api/moclo/import', json={'kind': 'part', 'id': 'part-1'})
    assert r.status_code == 201
    saved = r.get_json()['sequence']
    assert saved['golden_gate'] is True and saved['origin'] == 'moclo:part:part-1'


def test_moclo_status_reports_availability(user_client, moclo_parts_db):
    body = user_client.get('/api/moclo/status').get_json()
    assert body['available']['parts'] is True and body['available']['plasmids'] is False
    assert 'Coding' in body['part_types']


def test_feature_library_import_export_and_annotate(user_client, rand_dna):
    import io
    lib = 'myTag\tGGTGGTGGTAGCGGTGGT\tCDS\t#123456\t#123456\t0\n'
    r = user_client.post('/api/library/import', data={'file': (io.BytesIO(lib.encode()), 'lib.txt')},
                         content_type='multipart/form-data')
    assert r.status_code == 201 and r.get_json()['added'] == 1

    seq = rand_dna(100) + 'GGTGGTGGTAGCGGTGGT' + rand_dna(100)
    doc = model.make_document('p', seq, False)
    found = user_client.post('/api/tools/annotate', json={'document': doc}).get_json()['features']
    assert any(f['name'] == 'myTag' and f['start'] == 100 for f in found)

    assert b'myTag' in user_client.get('/api/library/export').data
    assert any(e['name'] == 'T7 promoter' for e in user_client.get('/api/library').get_json()['builtin'])


def test_sequencing_reads_stored_and_realigned(user_client, rand_dna):
    import io
    seq = rand_dna(1200)
    r = user_client.post('/api/sequences', json={'document': model.make_document('p', seq, True)})
    sid = r.get_json()['sequence']['id']

    read = seq[400:800]
    fasta = f'>read1\n{read}\n'
    r = user_client.post(f'/api/sequences/{sid}/reads',
                         data={'file': (io.BytesIO(fasta.encode()), 'read1.fa')},
                         content_type='multipart/form-data')
    assert r.status_code == 201
    stored = r.get_json()['reads'][0]
    assert stored['alignment']['mapped'] and stored['alignment']['ref_start'] == 400
    assert not stored['alignment']['differences']

    reads = user_client.get(f'/api/sequences/{sid}/reads').get_json()['reads']
    assert len(reads) == 1 and reads[0]['name'] == 'read1'

    # Edit the reference, then re-align: the read now ends 100 bp earlier.
    edited = model.make_document('p', seq[:700] + seq[800:], True)
    user_client.put(f'/api/sequences/{sid}', json={'document': edited})
    r = user_client.post(f'/api/sequences/{sid}/reads/realign', json={})
    assert r.status_code == 200
    assert r.get_json()['reads'][0]['alignment']['ref_start'] == 400

    rid = user_client.get(f'/api/sequences/{sid}/reads').get_json()['reads'][0]['id']
    assert user_client.delete(f'/api/sequences/reads/{rid}').status_code == 200
    assert user_client.get(f'/api/sequences/{sid}/reads').get_json()['reads'] == []


def test_cloning_endpoints(user_client, rand_dna):
    # Golden Gate through the API
    oh = ['AAAA', 'CCCC', 'GGTT']
    p1 = 'GGTCTCA' + oh[0] + rand_dna(100) + oh[1] + 'TGAGACC'
    p2 = 'GGTCTCA' + oh[1] + rand_dna(150) + oh[2] + 'TGAGACC'
    bb = oh[0] + 'TGAGACC' + rand_dna(300) + 'GGTCTCA' + oh[2] + rand_dna(1200)
    docs = [model.make_document(n, s, True) for n, s in (('p1', p1), ('p2', p2), ('bb', bb))]
    r = user_client.post('/api/tools/golden-gate', json={'documents': docs, 'enzyme': 'BsaI'})
    body = r.get_json()
    assert body['products'], body['log']
    assert len(body['products'][0]['sequence']) == 4 + 100 + 4 + 150 + 4 + 1200

    # Gibson
    full = rand_dna(900)
    frags = [{'name': 'a', 'sequence': full[:330]}, {'name': 'b', 'sequence': full[300:630]},
             {'name': 'c', 'sequence': full[600:] + full[:30]}]
    r = user_client.post('/api/tools/gibson', json={'documents': frags, 'min_overlap': 20})
    assert r.get_json()['product']['sequence'] == full


def test_silent_sites_endpoint(user_client):
    cds = 'ATGGAATTTAAAGGTTCTCCCTAA'
    r = user_client.post('/api/tools/silent-sites',
                         json={'document': model.make_document('c', cds, False),
                               'cds_start': 0, 'cds_end': len(cds), 'enzymes': ['EcoRI']})
    assert r.get_json()['count'] >= 1


def test_contributed_parts_reassemble_under_moclo_rules(user_client, moclo_parts_db, rand_dna):
    """
    MoClo's assemble_parts() joins stored parts by taking the first in full and
    appending each next part minus its leading 4 bp shared overhang. Parts the
    editor contributes must survive that rule, so a promoter and a CDS
    contributed here must ligate back into the sequence Golden Gate would give.
    """
    body1, body2 = rand_dna(300), rand_dna(450)
    p1 = 'GGTCTCA' + 'GGAG' + body1 + 'AATG' + 'TGAGACC' + rand_dna(1500)
    p2 = 'GGTCTCA' + 'AATG' + body2 + 'GCTT' + 'TGAGACC' + rand_dna(1500)

    ids = []
    for name, seq in (('pPro', p1), ('pCDS', p2)):
        r = user_client.post('/api/sequences',
                             json={'document': model.make_document(name, seq, True), 'golden_gate': True})
        sid = r.get_json()['sequence']['id']
        assert user_client.post(f'/api/sequences/{sid}/contribute', json={}).status_code == 201
        ids.append(name)

    conn = sqlite3.connect(moclo_parts_db['parts'])
    conn.row_factory = sqlite3.Row
    rows = {r['name']: r for r in conn.execute('SELECT * FROM parts')}
    conn.close()

    pro, cds = rows['pPro'], rows['pCDS']
    assert pro['overhang_3prime'] == cds['overhang_5prime'] == 'AATG'  # compatible

    assembled = pro['sequence'] + cds['sequence'][4:]        # MoClo's rule
    assert assembled == 'GGAG' + body1 + 'AATG' + body2 + 'GCTT'
    assert assembled.count('AATG') >= 1 and assembled[4:4 + 300] == body1
