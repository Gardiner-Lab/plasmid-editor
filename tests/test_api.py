"""Tests for the web API, including the shared MoClo database bridge."""

import json
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


def test_convert_exports_without_saving(user_client, rand_dna):
    """'Save as -> download' must work for a sequence that was never saved."""
    seq = rand_dna(300)
    doc = model.make_document('scratch', seq, True, [model.make_feature('f1', 10, 60, 1, 'CDS')])

    r = user_client.post('/api/sequences/convert', json={'document': doc, 'format': 'genbank'})
    assert r.status_code == 200
    assert b'LOCUS' in r.data and b'f1' in r.data
    assert 'scratch.gb' in r.headers['Content-Disposition']

    r = user_client.post('/api/sequences/convert', json={'document': doc, 'format': 'fasta'})
    assert r.status_code == 200 and r.data.startswith(b'>scratch')

    r = user_client.post('/api/sequences/convert', json={'document': doc, 'format': 'json'})
    assert r.status_code == 200 and json.loads(r.data)['sequence'] == seq

    # Nothing was added to the library.
    assert user_client.get('/api/sequences').get_json()['sequences'] == []


def test_convert_rejects_bad_input(user_client, rand_dna):
    doc = model.make_document('x', rand_dna(100), True)
    assert user_client.post('/api/sequences/convert',
                            json={'document': doc, 'format': 'docx'}).status_code == 400
    assert user_client.post('/api/sequences/convert',
                            json={'document': {'sequence': ''}}).status_code == 400


def test_save_as_creates_a_separate_entry(user_client, rand_dna):
    """A copy must not disturb the original entry."""
    seq = rand_dna(400)
    first = user_client.post('/api/sequences',
                             json={'document': model.make_document('original', seq, True)})
    original_id = first.get_json()['sequence']['id']

    copy = user_client.post('/api/sequences',
                            json={'document': model.make_document('original copy', seq, True)})
    assert copy.status_code == 201
    copy_id = copy.get_json()['sequence']['id']
    assert copy_id != original_id

    names = {s['name'] for s in user_client.get('/api/sequences').get_json()['sequences']}
    assert names == {'original', 'original copy'}
    assert user_client.get(f'/api/sequences/{original_id}').get_json()['sequence']['name'] == 'original'


def test_mounting_under_a_url_prefix(monkeypatch, tmp_dbs):
    """Behind the suite proxy the editor is served at /editor."""
    monkeypatch.setenv('URL_PREFIX', '/editor')
    monkeypatch.setenv('EDITOR_SKIP_SEED', '1')
    from app.main import create_app
    app = create_app()
    app.config.update(TESTING=True, SECRET_KEY='t')
    c = app.test_client()

    assert c.post('/editor/api/auth/register',
                  json={'username': 'pre', 'password': 'password123'}).status_code == 201
    html = c.get('/editor/editor').get_data(as_text=True)
    assert 'data-base="/editor"' in html
    assert '/editor/static/js/api.js' in html
    assert 'href="/editor/library"' in html

    # Registration logs the user in, so the mounted root goes to the editor.
    assert c.get('/editor/').headers.get('Location', '').endswith('/editor/editor')

    # Its session cookie is named and scoped so it cannot clash with the MoClo
    # tool's cookie on the same hostname.
    cookie = c.get('/editor/editor').headers.get('Set-Cookie', '') or ''
    jar = {c_.key: c_ for c_ in c._cookies.values()} if hasattr(c, '_cookies') else {}
    assert 'plasmid_editor_session' in (cookie or ''.join(jar)) or 'plasmid_editor_session' in str(jar)
    assert app.config['SESSION_COOKIE_PATH'] == '/editor'
    assert app.config['SESSION_COOKIE_NAME'] == 'plasmid_editor_session'


def test_golden_gate_flag_persists_on_its_own(user_client, moclo_parts_db, rand_dna):
    """
    Ticking "Golden Gate ready" must reach the server by itself.

    The flag used to live only in the browser until the next full save, so
    contributing a sequence that had just been ticked failed with
    "Mark this plasmid as Golden Gate ready before contributing it".
    """
    insert = rand_dna(400)
    seq = 'GGTCTCA' + 'AATG' + insert + 'GCTT' + 'TGAGACC' + rand_dna(1500)
    sid = user_client.post('/api/sequences', json={
        'document': model.make_document('gNP184', seq, True)}).get_json()['sequence']['id']
    assert user_client.get(f'/api/sequences/{sid}').get_json()['sequence']['golden_gate'] is False

    # What the checkbox now sends on its own, with no document body.
    r = user_client.patch(f'/api/sequences/{sid}', json={'golden_gate': True, 'sync': False})
    assert r.status_code == 200
    assert r.get_json()['sequence']['golden_gate'] is True

    # The sequence is unchanged by the flag alone.
    stored = user_client.get(f'/api/sequences/{sid}').get_json()['sequence']
    assert stored['sequence'] == seq.upper() and stored['name'] == 'gNP184'

    # And contributing now succeeds.
    r = user_client.post(f'/api/sequences/{sid}/contribute', json={'lab_source': 'Gardiner Lab'})
    assert r.status_code == 201, r.get_json()
    assert r.get_json()['contributed']['overhang_5prime'] == 'AATG'


def test_non_standard_fusion_sites_still_contribute(user_client, moclo_parts_db, rand_dna):
    """
    A BbsI module with overhangs outside the canonical MoClo set is a valid
    part; "standard_moclo: false" is a note, not a refusal.
    """
    # The filler must not contain further BbsI sites, or the part is not clean.
    no_bbsi = ('GAATTC', 'GGTCTC', 'GAGACC', 'GAAGAC', 'GTCTTC')
    seq = ('GAAGACAA' + 'ACTA' + rand_dna(600, no_bbsi) + 'TTAC'
           + 'TTGTCTTC' + rand_dna(1200, no_bbsi))
    sid = user_client.post('/api/sequences', json={
        'document': model.make_document('gNP184-like', seq, True),
        'golden_gate': True}).get_json()['sequence']['id']

    analysis = user_client.post('/api/sequences/golden-gate/analyze', json={
        'document': model.make_document('gNP184-like', seq, True)}).get_json()
    assert analysis['ready'] is True
    assert analysis['best']['enzyme'] in ('BbsI', 'BpiI')
    assert analysis['best']['standard_moclo'] is False

    r = user_client.post(f'/api/sequences/{sid}/contribute', json={'lab_source': 'Gardiner Lab'})
    assert r.status_code == 201, r.get_json()
    out = r.get_json()['contributed']
    assert (out['overhang_5prime'], out['overhang_3prime']) == ('ACTA', 'TTAC')


def _app_with(monkeypatch, tmp_dbs, **env):
    for k, v in env.items():
        monkeypatch.setenv(k, v)
    monkeypatch.setenv('EDITOR_SKIP_SEED', '1')
    from app.main import create_app
    application = create_app()
    application.config.update(TESTING=True, SECRET_KEY='t')
    return application


def _logged_in(application):
    c = application.test_client()
    r = c.post('/api/auth/register', json={'username': 'linkuser', 'password': 'password123'})
    assert r.status_code == 201, r.get_json()
    return c


def test_cloning_sends_golden_gate_to_the_moclo_tool(monkeypatch, tmp_dbs):
    """Golden Gate assembly is planned in MoClo, so the editor links out."""
    c = _logged_in(_app_with(monkeypatch, tmp_dbs, MOCLO_BASE_URL='/'))
    html = c.get('/cloning').get_data(as_text=True)

    assert 'href="/assembly"' in html, 'links to the MoClo assembly page'
    assert 'data-method="goldengate"' not in html, 'no in-editor Golden Gate mode'
    # The other three methods stay here.
    for method in ('gibson', 'ligate', 'recombine'):
        assert f'data-method="{method}"' in html
    assert 'MoClo ↗' in c.get('/editor').get_data(as_text=True)


def test_moclo_links_use_an_absolute_base(monkeypatch, tmp_dbs):
    c = _logged_in(_app_with(monkeypatch, tmp_dbs, MOCLO_BASE_URL='https://moclo.example.org/'))
    html = c.get('/cloning').get_data(as_text=True)
    assert 'href="https://moclo.example.org/assembly"' in html
    assert 'href="https://moclo.example.org/parts"' in html


def test_moclo_links_hidden_when_not_configured(monkeypatch, tmp_dbs):
    monkeypatch.delenv('MOCLO_BASE_URL', raising=False)
    monkeypatch.delenv('MOCLO_URL', raising=False)
    c = _logged_in(_app_with(monkeypatch, tmp_dbs))
    html = c.get('/cloning').get_data(as_text=True)
    assert 'href="/assembly"' not in html
    assert 'Set <code>MOCLO_BASE_URL</code>' in html, 'explains why the link is missing'
    assert 'MoClo tool ↗' not in c.get('/editor').get_data(as_text=True)


def test_suite_launch_page_link(monkeypatch, tmp_dbs):
    """Behind the suite, every page links back to the launch page."""
    c = _logged_in(_app_with(monkeypatch, tmp_dbs, SUITE_HOME_URL='/'))
    for page in ('/editor', '/cloning', '/sequencing'):
        assert 'class="tt-home"' in c.get(page).get_data(as_text=True), page
    c.get('/logout')
    assert 'Trellis Tools' in c.get('/login').get_data(as_text=True), 'signed out too'


def test_suite_launch_page_link_hidden_when_standalone(monkeypatch, tmp_dbs):
    monkeypatch.delenv('SUITE_HOME_URL', raising=False)
    c = _logged_in(_app_with(monkeypatch, tmp_dbs))
    assert 'tt-home' not in c.get('/editor').get_data(as_text=True)


def test_editor_has_a_blast_button(monkeypatch, tmp_dbs):
    c = _logged_in(_app_with(monkeypatch, tmp_dbs))
    assert 'id="btnBlast"' in c.get('/editor').get_data(as_text=True)


def test_the_sequencing_view_includes_the_features(user_client, rand_dna):
    """So an alignment can show which features a read covers."""
    seq = rand_dna(900)
    doc = model.make_document('p', seq, True, [model.make_feature('lacZ', 100, 400, 1, 'CDS'),
                                               model.make_feature('ori', 600, 800, -1, 'rep_origin')])
    sid = user_client.post('/api/sequences', json={'document': doc}).get_json()['sequence']['id']
    sequence = user_client.get(f'/api/sequences/{sid}/sequencing').get_json()['sequence']
    assert sequence['feature_count'] == 2
    assert [(f['name'], f['start'], f['end'], f['strand']) for f in sequence['features']] == [
        ('lacZ', 100, 400, 1), ('ori', 600, 800, -1)]


def test_translations_are_kept_apart_from_features(user_client, rand_dna):
    """Saved with the plasmid, returned as they were, and never mixed into the features."""
    seq = rand_dna(600)
    doc = model.make_document('p', seq, True, [model.make_feature('lacZ', 100, 400, 1, 'CDS')])
    doc['translations'] = [
        {'id': 't1', 'name': 'lacZ protein', 'start': 100, 'end': 400, 'strand': 1},
        {'name': 'reverse', 'start': 450, 'end': 30, 'strand': -1},        # through the origin
        {'name': 'nothing', 'start': 10, 'end': 10},                        # empty: dropped
        {'name': 'outside', 'start': 10, 'end': 9000},                      # off the end: dropped
    ]
    saved = user_client.post('/api/sequences', json={'document': doc}).get_json()['sequence']
    got = user_client.get(f"/api/sequences/{saved['id']}").get_json()['sequence']
    assert [(t['name'], t['start'], t['end'], t['strand']) for t in got['translations']] == [
        ('lacZ protein', 100, 400, 1), ('reverse', 450, 30, -1)]
    assert got['translations'][0]['id'] == 't1' and got['translations'][1]['id']
    assert [f['name'] for f in got['features']] == ['lacZ']

    # Updating the plasmid keeps them, or clears them when asked to.
    got['translations'] = got['translations'][:1]
    user_client.put(f"/api/sequences/{saved['id']}", json={'document': got})
    again = user_client.get(f"/api/sequences/{saved['id']}").get_json()['sequence']
    assert [t['name'] for t in again['translations']] == ['lacZ protein']


def test_translations_follow_rotation_and_reverse_complement():
    doc = model.make_document('p', 'A' * 100, True)
    doc['translations'] = [{'id': 't', 'name': 'x', 'start': 10, 'end': 40, 'strand': 1}]
    rotated = model.rotate(doc, 20)
    assert (rotated['translations'][0]['start'], rotated['translations'][0]['end']) == (90, 20)
    flipped = model.reverse_complement_document(doc)
    t = flipped['translations'][0]
    assert (t['start'], t['end'], t['strand']) == (60, 90, -1)
    linear = model.normalize_document({'sequence': 'ACGT' * 10, 'circular': False,
                                       'translations': [{'start': 30, 'end': 3}]})
    assert linear['translations'] == []                  # only a circular plasmid wraps


def test_snapgene_export_and_import(user_client, rand_dna):
    doc = model.make_document('pDna', rand_dna(500), True, [model.make_feature('ori', 10, 200, 1, 'rep_origin')])
    sid = user_client.post('/api/sequences', json={'document': doc}).get_json()['sequence']['id']
    r = user_client.get(f'/api/sequences/{sid}/export/snapgene')
    assert r.status_code == 200 and r.headers['Content-Disposition'].endswith('pDna.dna')
    assert r.data[5:13] == b'SnapGene'
    # Save as -> download, for a document that was never saved
    r2 = user_client.post('/api/sequences/convert', json={'document': doc, 'format': 'snapgene'})
    assert r2.status_code == 200 and r2.data[5:13] == b'SnapGene'
    # And the file opens again, as from the Open button
    parsed = user_client.post('/api/sequences/parse', data={'file': (__import__('io').BytesIO(r.data), 'pDna.dna')},
                              content_type='multipart/form-data').get_json()
    back = parsed['documents'][0]
    assert back['sequence'] == doc['sequence'] and [f['name'] for f in back['features']] == ['ori']


def test_sites_of_enzymes_cutting_at_most_n_times(user_client):
    # EcoRI (GAATTC) three times, BamHI (GGATCC) once, in a linear sequence.
    seq = 'AAAA'.join(['GAATTC', 'GAATTC', 'GGATCC', 'GAATTC']) + 'AAAA'
    doc = {'name': 'cuts', 'sequence': seq, 'circular': False}
    ask = lambda **kw: user_client.post('/api/tools/sites', json={'document': doc, 'enzymes': ['EcoRI', 'BamHI'], **kw})
    assert ask().get_json()['counts'] == {'EcoRI': 3, 'BamHI': 1}
    assert ask(max_cuts=1).get_json()['counts'] == {'BamHI': 1}
    assert ask(unique_only=True).get_json()['counts'] == {'BamHI': 1}
    body = ask(max_cuts=3).get_json()
    assert body['counts'] == {'EcoRI': 3, 'BamHI': 1} and len(body['sites']) == 4
    assert {s['enzyme'] for s in ask(max_cuts=2).get_json()['sites']} == {'BamHI'}
    # Cutting more often is still a cutter, not a non-cutter.
    assert ask(max_cuts=2).get_json()['non_cutters'] == []
    assert ask(max_cuts=0).status_code == 400 and ask(max_cuts='a few').status_code == 400


def test_the_about_and_help_pages_are_there_and_point_at_each_other(client):
    for path, heading in (('/about', 'Plasmid Editor'), ('/help', 'How to use the Plasmid Editor')):
        r = client.get(path)
        assert r.status_code == 200, path
        assert heading in r.get_data(as_text=True)
    assert '/help' in client.get('/about').get_data(as_text=True)
    assert '/about' in client.get('/help').get_data(as_text=True)


def test_every_page_reaches_the_suite_and_its_other_tools():
    """The bar must carry the tool switcher, so every tool reaches every other one."""
    from pathlib import Path
    html = Path('app/templates/base.html').read_text()
    assert 'trellis/modules.js' in html, 'the other tools are not linked from the bar'


def test_a_huge_number_of_sites_is_counted_in_full_but_only_sampled(user_client):
    """
    A large enzyme set cuts a long sequence hundreds of thousands of times. Sending every one is tens of
    megabytes and used to hang the browser, so past max_sites only a sample travels — but the counts, which
    are what the enzyme table shows, still cover every site.
    """
    import random
    rng = random.Random(11)
    doc = {'name': 'long', 'sequence': ''.join(rng.choice('ACGT') for _ in range(20000)), 'circular': True}
    enzymes = ['EcoRI', 'BamHI', 'AluI', 'HaeIII', 'MboI', 'TaqI']

    whole = user_client.post('/api/tools/sites', json={'document': doc, 'enzymes': enzymes, 'max_sites': 0}).get_json()
    assert whole['truncated'] is False
    assert len(whole['sites']) == whole['total_sites'] > 200, 'these enzymes cut a 20 kb sequence often'

    capped = user_client.post('/api/tools/sites', json={'document': doc, 'enzymes': enzymes, 'max_sites': 50}).get_json()
    assert capped['truncated'] is True
    assert capped['total_sites'] == whole['total_sites'], 'the real total is still reported'
    assert capped['counts'] == whole['counts'], 'every enzyme is counted in full'
    assert len(capped['sites']) < len(whole['sites'])
    # Every enzyme that cuts keeps a few example sites, so the table can show where its first cuts are.
    for enzyme, n in capped['counts'].items():
        shown = [s for s in capped['sites'] if s['enzyme'] == enzyme]
        assert shown, f'{enzyme} has no example sites'
        assert len(shown) == min(n, 6)

    # Few enough sites: nothing is held back.
    small = user_client.post('/api/tools/sites', json={'document': doc, 'enzymes': ['EcoRI']}).get_json()
    assert small['truncated'] is False and len(small['sites']) == small['total_sites']


def test_the_enzyme_filter_redraws_the_table_with_the_servers_own_counts():
    """
    Only a sample of the sites travels when an enzyme set cuts very often, so the table cannot count them
    itself — it needs the counts the server sent. The filter redraws the table without asking again, and
    once passed an empty {} it showed every enzyme cutting "6" times.
    """
    from pathlib import Path
    js = Path('app/static/js/editor.js').read_text()
    assert 'this.lastCounts = body.counts || {}' in js, 'the counts the server sent must be kept'
    assert 'renderEnzymeTable(this.lastCounts || {}, this.lastNonCutters || [])' in js, \
        'the filter must redraw with those counts, not with {}'
    assert 'renderEnzymeTable({}, this.lastNonCutters' not in js, 'the old empty-counts redraw is back'


def test_the_reads_of_a_clone_are_compared_against_each_other(user_client, rand_dna):
    """
    Two reads of one clone covering the same base settle between them whether a difference is
    the clone's sequence or a bad call; a third clone's reads are judged on their own.
    """
    import io
    seq = rand_dna(1600)
    r = user_client.post('/api/sequences', json={'document': model.make_document('p', seq, True)})
    sid = r.get_json()['sequence']['id']

    def upload(name, bases, clone):
        res = user_client.post(f'/api/sequences/{sid}/reads',
                               data={'file': (io.BytesIO(f'>{name}\n{bases}\n'.encode()), f'{name}.fa'),
                                     'clone_number': clone},
                               content_type='multipart/form-data')
        assert res.status_code == 201, res.get_json()

    swap = 'A' if seq[600] != 'A' else 'C'
    changed = seq[:600] + swap + seq[601:]

    upload('c1_fwd', seq[300:900], '1')            # clone 1: both reads agree with the reference
    upload('c1_rev', seq[500:1100], '1')
    upload('c2_fwd', changed[300:900], '2')        # clone 2: both reads show the change
    upload('c2_rev', changed[500:1100], '2')
    upload('c3_fwd', changed[300:900], '3')        # clone 3: only one of two shows it
    upload('c3_rev', seq[500:1100], '3')

    body = user_client.get(f'/api/sequences/{sid}/clones').get_json()
    by_clone = {c['clone']: c for c in body['clones']}
    assert sorted(by_clone) == ['1', '2', '3']

    assert by_clone['1']['differences'] == [] and by_clone['1']['clean'] is True

    two = by_clone['2']
    assert two['confirmed'] == 1 and two['clean'] is False
    d = two['differences'][0]
    assert d['position'] == 600 and d['read'] == swap
    assert d['reads_showing'] == 2 and d['reads_covering'] == 2 and d['real'] is True

    three = by_clone['3']
    assert three['disputed'] == 1 and three['confirmed'] == 0
    d = three['differences'][0]
    assert d['reads_showing'] == 1 and d['reads_covering'] == 2
    assert d['real'] is False and three['clean'] is True, 'one read against one is a bad call'

    # Every clone reports how much of the plasmid its reads reached.
    assert all(0 < c['covered_percent'] < 100 for c in body['clones'])


def test_comparing_clones_needs_an_account(client):
    assert client.get('/api/sequences/whatever/clones').status_code == 401


def test_putting_reads_into_a_clone_leaves_their_verdicts_alone(user_client, rand_dna):
    """
    Grouping reads is not a judgement about them. Correcting a clone number must not withdraw a
    verdict someone already gave, which was the only way to set a clone before.
    """
    import io
    seq = rand_dna(1200)
    r = user_client.post('/api/sequences', json={'document': model.make_document('p', seq, True)})
    sid = r.get_json()['sequence']['id']

    def upload(name, bases):
        res = user_client.post(f'/api/sequences/{sid}/reads',
                               data={'file': (io.BytesIO(f'>{name}\n{bases}\n'.encode()), f'{name}.fa')},
                               content_type='multipart/form-data')
        return res.get_json()['reads'][0]['id']

    a = upload('a', seq[200:700])
    b = upload('b', seq[400:900])
    c = upload('c', seq[500:1000])

    # One read is judged sufficient, which confirms the plasmid.
    r = user_client.post(f'/api/sequences/reads/{a}/verdict',
                         json={'verdict': 'sufficient', 'glycerol_stock': 'GL-G-0042'})
    assert r.status_code == 200
    before = next(x for x in user_client.get(f'/api/sequences/{sid}/reads').get_json()['reads'] if x['id'] == a)
    assert before['verdict'] == 'sufficient' and before['verdict_by']

    # Several reads into one clone in a single call.
    r = user_client.post(f'/api/sequences/{sid}/reads/clone',
                         json={'read_ids': [a, b], 'clone_number': '7'})
    assert r.status_code == 200
    reads = {x['id']: x for x in user_client.get(f'/api/sequences/{sid}/reads').get_json()['reads']}
    assert reads[a]['clone_number'] == '7' and reads[b]['clone_number'] == '7'
    assert reads[c]['clone_number'] is None, 'reads not named are left alone'

    # The verdict, and who gave it, survived.
    assert reads[a]['verdict'] == 'sufficient'
    assert reads[a]['verdict_by'] == before['verdict_by']
    assert reads[a]['verdict_at'] == before['verdict_at']
    assert user_client.get(f'/api/sequences/{sid}').get_json()['sequence']['confirmed'] is True

    # The answer carries the comparison, so the panel updates without asking again.
    assert r.get_json()['clone_comparison'][0]['clone'] == '7'

    # An empty clone number takes a read back out of its clone.
    user_client.post(f'/api/sequences/{sid}/reads/clone', json={'read_ids': [b], 'clone_number': ''})
    reads = {x['id']: x for x in user_client.get(f'/api/sequences/{sid}/reads').get_json()['reads']}
    assert reads[b]['clone_number'] is None and reads[a]['clone_number'] == '7'


def test_reads_of_another_sequence_cannot_be_put_into_this_ones_clone(user_client, rand_dna):
    import io
    one = user_client.post('/api/sequences', json={'document': model.make_document('one', rand_dna(900), True)})
    two = user_client.post('/api/sequences', json={'document': model.make_document('two', rand_dna(900), True)})
    sid1, sid2 = one.get_json()['sequence']['id'], two.get_json()['sequence']['id']
    bases = user_client.get(f'/api/sequences/{sid2}').get_json()['sequence']['sequence'][100:500]
    res = user_client.post(f'/api/sequences/{sid2}/reads',
                           data={'file': (io.BytesIO(f'>r\n{bases}\n'.encode()), 'r.fa')},
                           content_type='multipart/form-data')
    other = res.get_json()['reads'][0]['id']
    r = user_client.post(f'/api/sequences/{sid1}/reads/clone', json={'read_ids': [other], 'clone_number': '1'})
    assert r.status_code == 404
    kept = user_client.get(f'/api/sequences/{sid2}/reads').get_json()['reads'][0]
    assert kept['clone_number'] is None, 'nothing was changed'


def _mismatch_read(seq, at, swap_to):
    """A read off `seq` from 300 to 900 with one base changed, as a basecaller might misread it."""
    bases = list(seq[300:900])
    bases[at - 300] = swap_to
    return ''.join(bases)


def test_a_base_called_by_hand_stops_being_a_difference(user_client, rand_dna):
    """
    A basecaller commits to a letter even where the peak is obscured. Someone reading the trace may
    judge it better, and their call must carry through everything the difference was counted in.
    """
    import io
    seq = rand_dna(1600)
    r = user_client.post('/api/sequences', json={'document': model.make_document('p', seq, True)})
    sid = r.get_json()['sequence']['id']
    want = 'A' if seq[600] != 'A' else 'C'
    res = user_client.post(f'/api/sequences/{sid}/reads',
                           data={'file': (io.BytesIO(f'>r1\n{_mismatch_read(seq, 600, want)}\n'.encode()), 'r1.fa'),
                                 'clone_number': '1'},
                           content_type='multipart/form-data')
    read = res.get_json()['reads'][0]
    rid = read['id']
    assert [d['position'] for d in read['alignment']['differences']] == [600]
    read_pos = 600 - 300                                  # where that base sits in the read itself

    # Call it back to what the reference has: the mismatch goes.
    r = user_client.post(f'/api/sequences/reads/{rid}/call',
                         json={'position': read_pos, 'base': seq[600]})
    assert r.status_code == 200, r.get_json()
    body = r.get_json()
    assert body['read']['alignment']['differences'] == []
    assert body['clone_comparison'][0]['clean'] is True

    # The instrument's own letter is kept, with who called it and when.
    call = body['read']['calls'][str(read_pos)]
    assert call['base'] == seq[600] and call['was'] == want
    assert call['by'] and call['at']
    stored = user_client.get(f'/api/sequences/reads/{rid}').get_json()['read']
    assert stored['bases'][read_pos] == want, 'the read as the machine gave it is untouched'

    # Withdrawing the call brings the difference back.
    r = user_client.post(f'/api/sequences/reads/{rid}/call', json={'position': read_pos, 'base': None})
    assert [d['position'] for d in r.get_json()['read']['alignment']['differences']] == [600]
    assert r.get_json()['read']['calls'] == {}


def test_a_hand_call_can_name_a_base_the_basecaller_missed(user_client, rand_dna):
    """Any base may be called, not only one that already differs: a real mutation can be read as the
    reference base just as easily as the other way round."""
    import io
    seq = rand_dna(1600)
    r = user_client.post('/api/sequences', json={'document': model.make_document('p', seq, True)})
    sid = r.get_json()['sequence']['id']
    res = user_client.post(f'/api/sequences/{sid}/reads',
                           data={'file': (io.BytesIO(f'>r1\n{seq[300:900]}\n'.encode()), 'r1.fa')},
                           content_type='multipart/form-data')
    rid = res.get_json()['reads'][0]['id']
    assert res.get_json()['reads'][0]['alignment']['differences'] == []

    want = 'A' if seq[600] != 'A' else 'C'
    r = user_client.post(f'/api/sequences/reads/{rid}/call', json={'position': 300, 'base': want})
    diffs = r.get_json()['read']['alignment']['differences']
    assert [d['position'] for d in diffs] == [600] and diffs[0]['read'] == want


def test_hand_calls_survive_realigning_and_reads_keep_their_ids(user_client, rand_dna):
    """
    Re-align all used to delete and remake every read, which gave them new ids and would now throw
    away the hand calls with them.
    """
    import io
    seq = rand_dna(1600)
    r = user_client.post('/api/sequences', json={'document': model.make_document('p', seq, True)})
    sid = r.get_json()['sequence']['id']
    want = 'A' if seq[600] != 'A' else 'C'
    res = user_client.post(f'/api/sequences/{sid}/reads',
                           data={'file': (io.BytesIO(f'>r1\n{_mismatch_read(seq, 600, want)}\n'.encode()), 'r1.fa'),
                                 'clone_number': '4'},
                           content_type='multipart/form-data')
    rid = res.get_json()['reads'][0]['id']
    user_client.post(f'/api/sequences/reads/{rid}/verdict', json={'verdict': 'insufficient'})
    user_client.post(f'/api/sequences/reads/{rid}/call', json={'position': 300, 'base': seq[600]})

    r = user_client.post(f'/api/sequences/{sid}/reads/realign', json={})
    assert r.status_code == 200
    after = user_client.get(f'/api/sequences/{sid}/reads').get_json()['reads']
    assert len(after) == 1
    assert after[0]['id'] == rid, 'the read kept its id'
    assert after[0]['calls'] != {}, 'the hand call survived'
    assert after[0]['alignment']['differences'] == [], 'and is still applied'
    assert after[0]['clone_number'] == '4' and after[0]['verdict'] == 'insufficient'


def test_a_hand_call_is_checked(user_client, rand_dna):
    import io
    seq = rand_dna(1200)
    sid = user_client.post('/api/sequences',
                           json={'document': model.make_document('p', seq, True)}).get_json()['sequence']['id']
    res = user_client.post(f'/api/sequences/{sid}/reads',
                           data={'file': (io.BytesIO(f'>r1\n{seq[200:700]}\n'.encode()), 'r1.fa')},
                           content_type='multipart/form-data')
    rid = res.get_json()['reads'][0]['id']
    assert user_client.post(f'/api/sequences/reads/{rid}/call',
                            json={'position': 5, 'base': 'X'}).status_code == 400
    assert user_client.post(f'/api/sequences/reads/{rid}/call',
                            json={'position': 99999, 'base': 'A'}).status_code == 400
    assert user_client.post(f'/api/sequences/reads/{rid}/call',
                            json={'base': 'A'}).status_code == 400


def test_every_timestamp_the_editor_shows_goes_through_the_eu_date_helper():
    """
    Dates are written the European way across the suite (31-10-2026). The editor has one helper,
    localTime(), which also turns the server's UTC into local time; three places were slicing the raw
    SQLite stamp instead and so showed 2026-10-31 19:51.
    """
    from pathlib import Path
    for name in ('sequencing.js', 'library.js', 'editor.js', 'admin.js'):
        js = Path('app/static/js') / name
        text = js.read_text()
        for bad in ('.slice(0, 16)', '.slice(0,16)'):
            assert bad not in text, f'{name} renders a raw timestamp with {bad}; use localTime()'
    # The helper itself still writes day-month-year, and keeps its raw fallback.
    helper = Path('app/static/js/api.js').read_text()
    assert 'function localTime(stamp)' in helper
    assert '${pad(d.getDate())}-${pad(d.getMonth() + 1)}-${d.getFullYear()}' in helper


def test_the_editor_asks_lab_stocks_for_every_stock_of_a_plasmid():
    """
    A plasmid is usually kept as more than one glycerol stock - the cloning strain's and the one it
    was moved into - but the editor holds a single number, written when the plasmid was confirmed.
    The list is therefore read from Lab Stocks, which allows many stocks per plasmid, each with its
    host; these guard the two things that were wrong when it was first written.
    """
    from pathlib import Path
    js = Path('app/static/js/sequencing.js').read_text()
    # Lab Stocks answers a listing under the collection's name, not as `records`.
    assert "({ glycerol: stocks = [] } = await Stocks.call('GET', `/glycerol?plasmid=" in js
    # It must run after the panel is on the page, or getElementById finds nothing and it gives up.
    attached = js.index('summary.replaceChildren(...parts);')
    assert js.index('if (seq.confirmed) this.renderGlycerolStocks(seq);') > attached
    # Adding a stock must never rewrite the number the plasmid was confirmed with.
    add = js[js.index('async linkExistingStock'):js.index('renderVerification()')]
    assert '/confirm' not in add, 'linking a stock must not re-confirm the plasmid'
