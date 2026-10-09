"""
Sequencing verification: reads stay attached to the plasmid they were aligned
to, carry a clone number and the user's verdict, and a sufficient alignment
confirms the plasmid against a glycerol stock.
"""

import io
import json
import sqlite3

from dnakit import model


def _save(user_client, name, seq, circular=True):
    r = user_client.post('/api/sequences',
                         json={'document': model.make_document(name, seq, circular)})
    assert r.status_code == 201, r.get_json()
    return r.get_json()['sequence']['id']


def _add_read(user_client, sid, name, bases, clone=None):
    data = {'file': (io.BytesIO(f'>{name}\n{bases}\n'.encode()), f'{name}.fa')}
    if clone:
        data['clone_number'] = clone
    r = user_client.post(f'/api/sequences/{sid}/reads', data=data,
                         content_type='multipart/form-data')
    assert r.status_code == 201, r.get_json()
    return r.get_json()['reads'][0]


def test_reads_stay_linked_to_the_plasmid_with_their_clone(user_client, rand_dna):
    seq = rand_dna(1200)
    sid = _save(user_client, 'pTest', seq)
    _add_read(user_client, sid, 'read_c3', seq[200:700], clone='3')
    _add_read(user_client, sid, 'read_c7', seq[600:1100], clone='7')

    history = user_client.get(f'/api/sequences/{sid}/sequencing').get_json()
    assert history['sequence']['name'] == 'pTest'
    assert history['clones'] == ['3', '7']
    assert history['summary']['reads'] == 2 and history['summary']['mapped'] == 2
    assert {r['clone_number'] for r in history['reads']} == {'3', '7'}

    # The listing shows at a glance that this plasmid has been sequenced.
    row = next(s for s in user_client.get('/api/sequences').get_json()['sequences']
               if s['id'] == sid)
    assert row['read_count'] == 2 and row['confirmed'] is False
    assert row['last_sequenced_at']


def test_discrepancies_are_visible_in_the_history(user_client, rand_dna):
    seq = rand_dna(1000)
    sid = _save(user_client, 'pDiff', seq)
    read = list(seq[300:800])
    read[100] = 'A' if read[100] != 'A' else 'C'       # a single mismatch at 400
    _add_read(user_client, sid, 'read1', ''.join(read), clone='1')

    history = user_client.get(f'/api/sequences/{sid}/sequencing').get_json()
    assert history['summary']['with_differences'] == 1
    r = history['reads'][0]
    assert r['difference_count'] == 1
    assert r['alignment']['differences'][0]['position'] == 400


def test_sufficient_verdict_confirms_the_plasmid_with_a_glycerol_stock(user_client, rand_dna):
    seq = rand_dna(900)
    sid = _save(user_client, 'pGood', seq)
    read = _add_read(user_client, sid, 'read1', seq[100:600], clone='4')

    r = user_client.post(f"/api/sequences/reads/{read['id']}/verdict",
                         json={'verdict': 'sufficient', 'note': 'clean across the insert'})
    assert r.status_code == 200
    body = r.get_json()
    assert body['read']['verdict'] == 'sufficient'
    assert body['read']['verdict_by'] == 'tester'
    assert body['needs_confirmation'] is True, 'the caller must now ask for a glycerol stock'
    assert body['sequence']['confirmed'] is False, 'not confirmed until the stock is given'

    # Confirming without a stock number is refused.
    bad = user_client.post(f'/api/sequences/{sid}/confirm', json={'glycerol_stock': '  '})
    assert bad.status_code == 400 and 'glycerol stock' in bad.get_json()['error']

    ok = user_client.post(f'/api/sequences/{sid}/confirm',
                          json={'glycerol_stock': 'GS-2026-041', 'clone_number': '4'})
    assert ok.status_code == 200
    confirmed = ok.get_json()['sequence']
    assert confirmed['confirmed'] is True
    assert confirmed['glycerol_stock'] == 'GS-2026-041'
    assert confirmed['confirmed_clone'] == '4'
    assert confirmed['confirmed_by'] == 'tester' and confirmed['confirmed_at']

    row = next(s for s in user_client.get('/api/sequences').get_json()['sequences']
               if s['id'] == sid)
    assert row['confirmed'] is True and row['glycerol_stock'] == 'GS-2026-041'
    assert row['reads_ok'] == 1 and row['reads_bad'] == 0


def test_insufficient_verdict_does_not_confirm(user_client, rand_dna):
    seq = rand_dna(900)
    sid = _save(user_client, 'pBad', seq)
    read = _add_read(user_client, sid, 'read1', seq[100:600], clone='2')

    r = user_client.post(f"/api/sequences/reads/{read['id']}/verdict",
                         json={'verdict': 'insufficient', 'note': 'poor trace after 300 bp'})
    assert r.status_code == 200
    assert r.get_json()['needs_confirmation'] is False
    assert r.get_json()['sequence']['confirmed'] is False

    history = user_client.get(f'/api/sequences/{sid}/sequencing').get_json()
    assert history['summary']['insufficient'] == 1
    assert history['reads'][0]['verdict_note'] == 'poor trace after 300 bp'


def test_confirmation_can_be_withdrawn(user_client, rand_dna):
    seq = rand_dna(800)
    sid = _save(user_client, 'pUndo', seq)
    user_client.post(f'/api/sequences/{sid}/confirm', json={'glycerol_stock': 'GS-1'})
    assert user_client.get(f'/api/sequences/{sid}').get_json()['sequence']['confirmed'] is True

    r = user_client.delete(f'/api/sequences/{sid}/confirm')
    assert r.status_code == 200 and r.get_json()['sequence']['confirmed'] is False
    assert r.get_json()['sequence']['glycerol_stock'] is None


def test_verdict_and_clone_survive_realignment(user_client, rand_dna):
    """Editing the plasmid re-aligns its reads; the judgement must not be lost."""
    seq = rand_dna(1200)
    sid = _save(user_client, 'pEdit', seq)
    read = _add_read(user_client, sid, 'read1', seq[300:800], clone='9')
    user_client.post(f"/api/sequences/reads/{read['id']}/verdict",
                     json={'verdict': 'sufficient'})

    user_client.put(f'/api/sequences/{sid}',
                    json={'document': model.make_document('pEdit', seq[:700] + seq[800:], True)})
    assert user_client.post(f'/api/sequences/{sid}/reads/realign', json={}).status_code == 200

    history = user_client.get(f'/api/sequences/{sid}/sequencing').get_json()
    assert history['reads'][0]['clone_number'] == '9'
    assert history['reads'][0]['verdict'] == 'sufficient'


def test_verdict_rejects_an_unknown_value(user_client, rand_dna):
    seq = rand_dna(600)
    sid = _save(user_client, 'pX', seq)
    read = _add_read(user_client, sid, 'r', seq[100:400])
    r = user_client.post(f"/api/sequences/reads/{read['id']}/verdict", json={'verdict': 'maybe'})
    assert r.status_code == 400


def test_confirmation_is_recorded_in_moclo(user_client, moclo_parts_db, rand_dna):
    """A confirmed plasmid shows as sequenced in the MoClo tool as well."""
    seq = 'AATG' + rand_dna(300) + 'GCTT'
    conn = sqlite3.connect(moclo_parts_db['parts'])
    conn.execute('INSERT INTO parts (id, name, part_type, sequence, overhang_5prime, '
                 'overhang_3prime, lab_source, contributor) VALUES (?,?,?,?,?,?,?,?)',
                 ('p1', 'pPart', 'Coding', seq, 'AATG', 'GCTT', 'Weber', 'alice'))
    conn.commit()
    conn.close()

    sid = user_client.post('/api/moclo/import',
                           json={'kind': 'part', 'id': 'p1'}).get_json()['sequence']['id']
    _add_read(user_client, sid, 'read1', seq[20:200], clone='6')
    r = user_client.post(f'/api/sequences/{sid}/confirm',
                         json={'glycerol_stock': 'GS-77', 'clone_number': '6'})
    assert r.status_code == 200
    assert r.get_json()['synced_to_moclo']['id'] == 'p1'

    conn = sqlite3.connect(moclo_parts_db['parts'])
    conn.row_factory = sqlite3.Row
    row = conn.execute('SELECT * FROM parts WHERE id = ?', ('p1',)).fetchone()
    conn.close()
    assert 'Sequence confirmed' in row['sequenced']
    assert 'clone 6' in row['sequenced'] and 'GS-77' in row['sequenced']
    # The part's sequence itself is untouched by a verification.
    assert row['sequence'] == seq
