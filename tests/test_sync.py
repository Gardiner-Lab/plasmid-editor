"""
Consistency between the editor and the MoClo Library Tool.

A sequence imported from (or contributed to) MoClo is *linked*, not copied:
saving it here writes the change back there, unless the MoClo record was also
changed in the meantime, which is reported as a conflict instead.
"""

import json
import sqlite3

from dnakit import model


def _insert_moclo_part(db_path, seq, part_id='p1', name='pPart', features=None):
    conn = sqlite3.connect(db_path)
    conn.execute('INSERT INTO parts (id, name, part_type, sequence, overhang_5prime, '
                 'overhang_3prime, lab_source, contributor, features) VALUES (?,?,?,?,?,?,?,?,?)',
                 (part_id, name, 'Coding', seq, seq[:4], seq[-4:], 'Weber', 'alice',
                  json.dumps(features) if features else None))
    conn.commit()
    conn.close()


def _read_moclo_part(db_path, part_id='p1'):
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    row = conn.execute('SELECT * FROM parts WHERE id = ?', (part_id,)).fetchone()
    conn.close()
    return dict(row) if row else None


def _import_part(user_client, part_id='p1'):
    r = user_client.post('/api/moclo/import', json={'kind': 'part', 'id': part_id})
    assert r.status_code == 201, r.get_json()
    return r.get_json()['sequence']


def test_importing_a_moclo_part_links_it(user_client, moclo_parts_db, rand_dna):
    _insert_moclo_part(moclo_parts_db['parts'], 'AATG' + rand_dna(200) + 'GCTT')
    saved = _import_part(user_client)
    assert saved['moclo_link'] == 'part:p1'
    assert saved['moclo_synced_hash']

    status = user_client.get(f"/api/sequences/{saved['id']}/moclo").get_json()
    assert status['linked'] is True and status['kind'] == 'part' and status['exists'] is True
    assert status['moclo_changed'] is False and status['local_changed'] is False


def test_editing_a_linked_sequence_updates_moclo(user_client, moclo_parts_db, rand_dna):
    """The headline behaviour: a change made here is a change there."""
    seq = 'AATG' + rand_dna(200) + 'GCTT'
    _insert_moclo_part(moclo_parts_db['parts'], seq,
                       features=[{'type': 'CDS', 'label': 'old', 'start': 4, 'end': 100, 'strand': 1}])
    sid = _import_part(user_client)['id']

    edited = 'AATG' + rand_dna(300) + 'GCTT'
    r = user_client.put(f'/api/sequences/{sid}', json={'document': {
        'name': 'pPart renamed', 'sequence': edited, 'circular': False,
        'description': 'changed in the editor',
        'features': [{'id': 'f1', 'name': 'newCDS', 'type': 'CDS',
                      'start': 4, 'end': 150, 'strand': 1}]}})
    assert r.status_code == 200, r.get_json()
    assert r.get_json()['synced_to_moclo']['id'] == 'p1'

    row = _read_moclo_part(moclo_parts_db['parts'])
    assert row['sequence'] == edited, 'the MoClo part carries the edited sequence'
    assert row['name'] == 'pPart renamed'
    assert row['overhang_5prime'] == 'AATG' and row['overhang_3prime'] == 'GCTT'
    assert 'newCDS' in row['features'] and 'old' not in row['features']
    assert 'Plasmid Editor' in (row['comments'] or ''), 'the change is attributed in MoClo'

    status = user_client.get(f'/api/sequences/{sid}/moclo').get_json()
    assert status['moclo_changed'] is False and status['local_changed'] is False


def test_overhangs_follow_an_edited_part(user_client, moclo_parts_db, rand_dna):
    _insert_moclo_part(moclo_parts_db['parts'], 'AATG' + rand_dna(150) + 'GCTT')
    sid = _import_part(user_client)['id']
    edited = 'GGAG' + rand_dna(150) + 'CGCT'     # re-fused onto different sites
    user_client.put(f'/api/sequences/{sid}', json={'document': {
        'name': 'pPart', 'sequence': edited, 'circular': False, 'features': []}})
    row = _read_moclo_part(moclo_parts_db['parts'])
    assert (row['overhang_5prime'], row['overhang_3prime']) == ('GGAG', 'CGCT')


def test_concurrent_change_in_moclo_is_a_conflict(user_client, moclo_parts_db, rand_dna):
    """A change made in MoClo must never be silently overwritten."""
    _insert_moclo_part(moclo_parts_db['parts'], 'AATG' + rand_dna(200) + 'GCTT')
    sid = _import_part(user_client)['id']

    other = 'AATG' + rand_dna(260) + 'GCTT'
    conn = sqlite3.connect(moclo_parts_db['parts'])
    conn.execute('UPDATE parts SET sequence = ?, name = ? WHERE id = ?',
                 (other, 'pPart (MoClo)', 'p1'))
    conn.commit()
    conn.close()

    mine = 'AATG' + rand_dna(210) + 'GCTT'
    body = {'document': {'name': 'pPart (editor)', 'sequence': mine,
                         'circular': False, 'features': []}}
    r = user_client.put(f'/api/sequences/{sid}', json=body)
    assert r.status_code == 409
    payload = r.get_json()
    assert payload['conflict'] is True and 'also changed in the MoClo tool' in payload['error']
    assert _read_moclo_part(moclo_parts_db['parts'])['sequence'] == other, 'MoClo left untouched'
    # The local save still happened, so no work is lost.
    assert user_client.get(f'/api/sequences/{sid}').get_json()['sequence']['sequence'] == mine
    assert user_client.get(f'/api/sequences/{sid}/moclo').get_json()['moclo_changed'] is True

    r = user_client.put(f'/api/sequences/{sid}', json={**body, 'force': True})
    assert r.status_code == 200
    assert _read_moclo_part(moclo_parts_db['parts'])['sequence'] == mine


def test_pull_discards_local_changes(user_client, moclo_parts_db, rand_dna):
    seq = 'AATG' + rand_dna(200) + 'GCTT'
    _insert_moclo_part(moclo_parts_db['parts'], seq)
    sid = _import_part(user_client)['id']
    user_client.put(f'/api/sequences/{sid}', json={'document': {
        'name': 'local edit', 'sequence': 'AATG' + rand_dna(50) + 'GCTT',
        'circular': False, 'features': []}, 'sync': False})

    r = user_client.post(f'/api/sequences/{sid}/moclo/pull', json={})
    assert r.status_code == 200
    assert r.get_json()['sequence']['sequence'] == seq
    assert user_client.get(f'/api/sequences/{sid}/moclo').get_json()['local_changed'] is False


def test_unlink_stops_syncing(user_client, moclo_parts_db, rand_dna):
    seq = 'AATG' + rand_dna(200) + 'GCTT'
    _insert_moclo_part(moclo_parts_db['parts'], seq)
    sid = _import_part(user_client)['id']

    assert user_client.post(f'/api/sequences/{sid}/moclo/unlink', json={}).status_code == 200
    assert user_client.get(f'/api/sequences/{sid}/moclo').get_json() == {'linked': False}

    user_client.put(f'/api/sequences/{sid}', json={'document': {
        'name': 'now independent', 'sequence': 'AATG' + rand_dna(90) + 'GCTT',
        'circular': False, 'features': []}})
    assert _read_moclo_part(moclo_parts_db['parts'])['sequence'] == seq, 'MoClo left alone'


def test_unlinked_sequences_never_touch_moclo(user_client, moclo_parts_db, rand_dna):
    seq = 'AATG' + rand_dna(200) + 'GCTT'
    _insert_moclo_part(moclo_parts_db['parts'], seq)
    r = user_client.post('/api/sequences',
                         json={'document': model.make_document('unrelated', rand_dna(500), True)})
    sid = r.get_json()['sequence']['id']
    user_client.put(f'/api/sequences/{sid}',
                    json={'document': model.make_document('unrelated v2', rand_dna(400), True)})
    assert _read_moclo_part(moclo_parts_db['parts'])['sequence'] == seq


def test_sync_reports_a_deleted_moclo_record(user_client, moclo_parts_db, rand_dna):
    _insert_moclo_part(moclo_parts_db['parts'], 'AATG' + rand_dna(200) + 'GCTT')
    sid = _import_part(user_client)['id']
    conn = sqlite3.connect(moclo_parts_db['parts'])
    conn.execute('DELETE FROM parts WHERE id = ?', ('p1',))
    conn.commit()
    conn.close()

    assert user_client.get(f'/api/sequences/{sid}/moclo').get_json()['exists'] is False
    r = user_client.put(f'/api/sequences/{sid}', json={'document': {
        'name': 'x', 'sequence': 'AATG' + rand_dna(80) + 'GCTT',
        'circular': False, 'features': []}})
    assert r.status_code == 409 and 'no longer exists' in r.get_json()['error']


def test_contributing_links_for_future_edits(user_client, moclo_parts_db, rand_dna):
    insert = rand_dna(400)
    seq = 'GGTCTCA' + 'AATG' + insert + 'GCTT' + 'TGAGACC' + rand_dna(2000)
    r = user_client.post('/api/sequences', json={
        'document': model.make_document('pNew', seq, True), 'golden_gate': True})
    sid = r.get_json()['sequence']['id']
    contributed = user_client.post(f'/api/sequences/{sid}/contribute', json={})
    assert contributed.status_code == 201, contributed.get_json()
    part_id = contributed.get_json()['contributed']['part_id']

    status = user_client.get(f'/api/sequences/{sid}/moclo').get_json()
    assert status['linked'] is True and status['id'] == part_id

    # A later edit of the source plasmid reaches the part it became.
    edited = 'GGTCTCA' + 'AATG' + rand_dna(500) + 'GCTT' + 'TGAGACC' + rand_dna(2000)
    r = user_client.put(f'/api/sequences/{sid}', json={'document': {
        'name': 'pNew', 'sequence': edited, 'circular': True, 'features': []}})
    assert r.status_code == 200, r.get_json()
    row = _read_moclo_part(moclo_parts_db['parts'], part_id)
    assert row['sequence'] == edited.upper()


def test_content_hash_ignores_feature_order(moclo_parts_db):
    from app.services import moclo_bridge
    a = [{'label': 'x', 'type': 'CDS', 'start': 1, 'end': 9, 'strand': 1},
         {'label': 'y', 'type': 'promoter', 'start': 20, 'end': 30, 'strand': -1}]
    assert (moclo_bridge.content_hash('n', 'ACGT', a)
            == moclo_bridge.content_hash('n', 'ACGT', list(reversed(a))))
    assert (moclo_bridge.content_hash('n', 'ACGT', a)
            != moclo_bridge.content_hash('n', 'ACGA', a))
