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


def _judge(user_client, read_id, verdict, glycerol_stock='GS-TEST-1'):
    body = {'verdict': verdict}
    if verdict == 'sufficient':
        body['glycerol_stock'] = glycerol_stock        # required to judge sufficient
    r = user_client.post(f'/api/sequences/reads/{read_id}/verdict', json=body)
    assert r.status_code == 200, r.get_json()
    return r.get_json()


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

    # Without a glycerol stock, a sufficient verdict is refused and nothing changes.
    for missing in ({}, {'glycerol_stock': '   '}):
        bad = user_client.post(f"/api/sequences/reads/{read['id']}/verdict",
                               json={'verdict': 'sufficient', **missing})
        assert bad.status_code == 400 and 'glycerol stock' in bad.get_json()['error']
    history = user_client.get(f'/api/sequences/{sid}/sequencing').get_json()
    assert history['reads'][0]['verdict'] is None
    assert history['sequence']['confirmed'] is False

    # With one, the verdict, the stock and the confirmation are recorded together.
    r = user_client.post(f"/api/sequences/reads/{read['id']}/verdict",
                         json={'verdict': 'sufficient', 'note': 'clean across the insert',
                               'glycerol_stock': ' GS-2026-041 ', 'clone_number': '4'})
    assert r.status_code == 200
    body = r.get_json()
    assert body['read']['verdict'] == 'sufficient'
    assert body['read']['verdict_by'] == 'tester'
    assert body['needs_confirmation'] is False
    confirmed = body['sequence']
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
    read = _add_read(user_client, sid, 'read1', seq[100:600])
    _judge(user_client, read['id'], 'sufficient')
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
    _judge(user_client, read['id'], 'sufficient')

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
    read = _add_read(user_client, sid, 'read1', seq[20:200], clone='6')
    _judge(user_client, read['id'], 'sufficient')
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


def _confirmed(user_client, sid):
    return user_client.get(f'/api/sequences/{sid}').get_json()['sequence']


def test_a_plasmid_cannot_be_confirmed_without_a_sufficient_verdict(user_client, rand_dna):
    seq = rand_dna(900)
    sid = _save(user_client, 'pNoVerdict', seq)
    # No reads at all.
    r = user_client.post(f'/api/sequences/{sid}/confirm', json={'glycerol_stock': 'GS-1'})
    assert r.status_code == 400
    assert 'sufficient' in r.get_json()['error']

    # A read, but not judged, then judged not sufficient.
    read = _add_read(user_client, sid, 'read1', seq[100:600])
    assert user_client.post(f'/api/sequences/{sid}/confirm',
                            json={'glycerol_stock': 'GS-1'}).status_code == 400
    _judge(user_client, read['id'], 'insufficient')
    assert user_client.post(f'/api/sequences/{sid}/confirm',
                            json={'glycerol_stock': 'GS-1'}).status_code == 400
    assert _confirmed(user_client, sid)['confirmed'] is False


def test_changing_the_verdict_withdraws_the_confirmation(user_client, rand_dna):
    seq = rand_dna(900)
    sid = _save(user_client, 'pRethink', seq)
    read = _add_read(user_client, sid, 'read1', seq[100:600], clone='2')
    _judge(user_client, read['id'], 'sufficient')
    user_client.post(f'/api/sequences/{sid}/confirm',
                     json={'glycerol_stock': 'GS-9', 'clone_number': '2'})
    assert _confirmed(user_client, sid)['confirmed'] is True

    body = _judge(user_client, read['id'], 'insufficient')
    assert body['confirmation_withdrawn'] is True
    doc = _confirmed(user_client, sid)
    assert doc['confirmed'] is False
    # What was typed in is kept for when it is confirmed again.
    assert doc['glycerol_stock'] == 'GS-9' and doc['confirmed_clone'] == '2'


def test_clearing_the_verdict_withdraws_the_confirmation(user_client, rand_dna):
    seq = rand_dna(900)
    sid = _save(user_client, 'pClear', seq)
    read = _add_read(user_client, sid, 'read1', seq[100:600])
    _judge(user_client, read['id'], 'sufficient')
    user_client.post(f'/api/sequences/{sid}/confirm', json={'glycerol_stock': 'GS-3'})
    assert _judge(user_client, read['id'], None)['confirmation_withdrawn'] is True
    assert _confirmed(user_client, sid)['confirmed'] is False


def test_deleting_the_sufficient_read_withdraws_the_confirmation(user_client, rand_dna):
    seq = rand_dna(900)
    sid = _save(user_client, 'pDelete', seq)
    read = _add_read(user_client, sid, 'read1', seq[100:600])
    _judge(user_client, read['id'], 'sufficient')
    user_client.post(f'/api/sequences/{sid}/confirm', json={'glycerol_stock': 'GS-4'})
    r = user_client.delete(f"/api/sequences/reads/{read['id']}")
    assert r.get_json()['confirmation_withdrawn'] is True
    assert _confirmed(user_client, sid)['confirmed'] is False


def test_another_sufficient_read_keeps_the_confirmation(user_client, rand_dna):
    seq = rand_dna(900)
    sid = _save(user_client, 'pTwo', seq)
    first = _add_read(user_client, sid, 'read1', seq[100:600])
    second = _add_read(user_client, sid, 'read2', seq[300:800])
    _judge(user_client, first['id'], 'sufficient')
    _judge(user_client, second['id'], 'sufficient')
    user_client.post(f'/api/sequences/{sid}/confirm', json={'glycerol_stock': 'GS-5'})
    assert _judge(user_client, first['id'], 'insufficient')['confirmation_withdrawn'] is False
    assert _confirmed(user_client, sid)['confirmed'] is True


def test_older_unsupported_confirmations_are_cleared_on_start(user_client, rand_dna, tmp_dbs):
    """A confirmation made before the rule, with no sufficient read, no longer counts."""
    sid = _save(user_client, 'pOld', rand_dna(600))
    conn = sqlite3.connect(tmp_dbs['editor'])
    conn.execute("UPDATE sequences SET confirmed_at = CURRENT_TIMESTAMP, confirmed_by = 'x', "
                 "glycerol_stock = 'GS-OLD' WHERE id = ?", (sid,))
    conn.commit()
    conn.close()
    assert _confirmed(user_client, sid)['confirmed'] is True

    from app.main import create_app
    create_app()
    doc = _confirmed(user_client, sid)
    assert doc['confirmed'] is False and doc['glycerol_stock'] == 'GS-OLD'


def _private_with_a_read(user_client, client, rand_dna):
    """tester owns a private plasmid with a judged read; 'other' is signed in on `client`."""
    seq = rand_dna(900)
    r = user_client.post('/api/sequences', json={
        'document': model.make_document('pSecret', seq, True), 'shared': False})
    sid = r.get_json()['sequence']['id']
    read = _add_read(user_client, sid, 'read1', seq[100:600], clone='5')
    _judge(user_client, read['id'], 'sufficient')
    user_client.post('/api/auth/logout')
    client.post('/api/auth/register', json={'username': 'other', 'password': 'password123'})
    return sid, read, seq


def test_anyone_signed_in_can_view_alignments_of_a_private_plasmid(user_client, client, rand_dna):
    sid, read, seq = _private_with_a_read(user_client, client, rand_dna)

    history = client.get(f'/api/sequences/{sid}/sequencing')
    assert history.status_code == 200
    body = history.get_json()
    assert body['sequence']['sequence'] == seq, 'the alignment view needs the reference bases'
    assert body['sequence']['can_change'] is False
    assert body['sequence']['can_add_reads'] is False
    assert body['reads'][0]['alignment']['mapped']
    assert body['reads'][0]['verdict'] == 'sufficient'

    assert client.get(f'/api/sequences/{sid}/reads').status_code == 200
    assert client.get(f"/api/sequences/reads/{read['id']}?trace=true").status_code == 200

    # It is offered in the sequencing picker, but stays out of the plasmid list.
    listed = client.get('/api/sequences?sequencing=true').get_json()['sequences']
    assert [s['id'] for s in listed] == [sid]
    assert client.get('/api/sequences').get_json()['sequences'] == []


def test_viewing_does_not_open_the_plasmid_itself(user_client, client, rand_dna):
    sid, read, _ = _private_with_a_read(user_client, client, rand_dna)
    assert client.get(f'/api/sequences/{sid}').status_code == 403


def test_only_the_owner_changes_sequencing_results(user_client, client, rand_dna):
    sid, read, seq = _private_with_a_read(user_client, client, rand_dna)
    assert client.post(f"/api/sequences/reads/{read['id']}/verdict",
                       json={'verdict': 'insufficient'}).status_code == 403
    assert client.delete(f"/api/sequences/reads/{read['id']}").status_code == 403
    assert client.post(f'/api/sequences/{sid}/confirm',
                       json={'glycerol_stock': 'GS-X'}).status_code == 403
    assert client.post(f'/api/sequences/{sid}/reads/realign', json={}).status_code == 403
    data = {'file': (io.BytesIO(f'>r2\n{seq[200:500]}\n'.encode()), 'r2.fa')}
    assert client.post(f'/api/sequences/{sid}/reads', data=data,
                       content_type='multipart/form-data').status_code == 403


def test_a_private_plasmid_without_reads_stays_private(user_client, client, rand_dna):
    r = user_client.post('/api/sequences', json={
        'document': model.make_document('pNothingYet', rand_dna(600), True), 'shared': False})
    sid = r.get_json()['sequence']['id']
    user_client.post('/api/auth/logout')
    client.post('/api/auth/register', json={'username': 'other', 'password': 'password123'})
    assert client.get(f'/api/sequences/{sid}/sequencing').status_code == 403
    assert client.get('/api/sequences?sequencing=true').get_json()['sequences'] == []


def _linked_confirmed_part(user_client, moclo_parts_db, rand_dna, sequenced=None):
    """A MoClo part imported into the editor, sequenced and confirmed there."""
    seq = 'AATG' + rand_dna(300) + 'GCTT'
    conn = sqlite3.connect(moclo_parts_db['parts'])
    conn.execute('INSERT INTO parts (id, name, part_type, sequence, overhang_5prime, '
                 'overhang_3prime, lab_source, contributor, sequenced) VALUES (?,?,?,?,?,?,?,?,?)',
                 ('p1', 'pPart', 'Coding', seq, 'AATG', 'GCTT', 'Weber', 'alice', sequenced))
    conn.commit()
    conn.close()
    sid = user_client.post('/api/moclo/import',
                           json={'kind': 'part', 'id': 'p1'}).get_json()['sequence']['id']
    read = _add_read(user_client, sid, 'read1', seq[20:200], clone='6')
    _judge(user_client, read['id'], 'sufficient')
    r = user_client.post(f'/api/sequences/{sid}/confirm', json={'glycerol_stock': 'GS-77'})
    assert r.get_json()['synced_to_moclo'], r.get_json()
    return sid, read


def _moclo_part(moclo_parts_db):
    conn = sqlite3.connect(moclo_parts_db['parts'])
    conn.row_factory = sqlite3.Row
    row = dict(conn.execute('SELECT sequenced, comments FROM parts WHERE id = ?', ('p1',)).fetchone())
    conn.close()
    return row


def test_withdrawing_clears_the_status_in_moclo(user_client, moclo_parts_db, rand_dna):
    sid, _ = _linked_confirmed_part(user_client, moclo_parts_db, rand_dna)
    assert _moclo_part(moclo_parts_db)['sequenced'].startswith('Sequence confirmed')

    r = user_client.delete(f'/api/sequences/{sid}/confirm')
    assert r.status_code == 200 and r.get_json()['moclo_note'] is None
    row = _moclo_part(moclo_parts_db)
    assert not row['sequenced'] and not row['comments']


def test_an_automatic_withdrawal_clears_moclo_too(user_client, moclo_parts_db, rand_dna):
    sid, read = _linked_confirmed_part(user_client, moclo_parts_db, rand_dna)
    body = _judge(user_client, read['id'], 'insufficient')
    assert body['confirmation_withdrawn'] is True and body['moclo_note'] is None
    assert not _moclo_part(moclo_parts_db)['sequenced']


def test_moclo_text_written_by_a_person_is_left_alone(user_client, moclo_parts_db, rand_dna):
    sid, _ = _linked_confirmed_part(user_client, moclo_parts_db, rand_dna)
    # Someone edits the field in MoClo after the editor confirmed it.
    conn = sqlite3.connect(moclo_parts_db['parts'])
    conn.execute("UPDATE parts SET sequenced = 'Yes - Sanger, lab notebook p.12' WHERE id = 'p1'")
    conn.commit()
    conn.close()
    user_client.delete(f'/api/sequences/{sid}/confirm')
    assert _moclo_part(moclo_parts_db)['sequenced'] == 'Yes - Sanger, lab notebook p.12'


def test_a_missing_moclo_database_does_not_block_withdrawal(user_client, moclo_parts_db, rand_dna):
    import os
    sid, read = _linked_confirmed_part(user_client, moclo_parts_db, rand_dna)
    os.remove(moclo_parts_db['parts'])
    body = _judge(user_client, read['id'], None)
    assert body['confirmation_withdrawn'] is True
    assert 'MoClo' in body['moclo_note']
    assert _confirmed(user_client, sid)['confirmed'] is False
