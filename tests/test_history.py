"""
A sequence's history: every change to its content is kept as a revision, with
who made it and how, and any revision can be restored. A save made over a
version the saver never saw is held back rather than lost.
"""

import io

from app.models.database import get_connection
from dnakit import model


def _doc(name, seq, features=()):
    doc = model.make_document(name, seq, True)
    doc['features'] = [dict(f) for f in features]
    return doc


def _save(user_client, doc):
    r = user_client.post('/api/sequences', json={'document': doc})
    assert r.status_code == 201, r.get_json()
    return r.get_json()['sequence']


def _put(user_client, sid, doc, **extra):
    return user_client.put(f'/api/sequences/{sid}', json={'document': doc, **extra})


def _history(user_client, sid):
    r = user_client.get(f'/api/sequences/{sid}/history')
    assert r.status_code == 200, r.get_json()
    return r.get_json()


def test_every_change_is_kept_with_who_made_it(user_client, rand_dna):
    seq = rand_dna(600)
    feature = {'name': 'insert', 'type': 'CDS', 'start': 100, 'end': 300, 'strand': 1}
    created = _save(user_client, _doc('pHist', seq, [feature]))
    assert created['revision'] == 1

    changed = seq[:200] + ('A' if seq[200] != 'A' else 'C') + seq[201:]
    r = _put(user_client, created['id'], _doc('pHist', changed, [feature]),
             base_revision=1, revision={'kind': 'corrected', 'note': 'Corrected 1 difference to read r1'})
    assert r.status_code == 200 and r.get_json()['sequence']['revision'] == 2

    # Saving the same content again keeps no new revision.
    r = _put(user_client, created['id'], _doc('pHist', changed, [feature]), base_revision=2)
    assert r.status_code == 200 and r.get_json()['sequence']['revision'] == 2

    body = _history(user_client, created['id'])
    assert body['current'] == 2 and body['can_restore'] is True
    newest, first = body['revisions']
    assert first['number'] == 1 and first['kind'] == 'created' and first['changed_by'] == 'tester'
    assert newest['number'] == 2 and newest['kind'] == 'corrected'
    assert newest['changed_by'] == 'tester'
    assert newest['note'] == 'Corrected 1 difference to read r1'
    assert newest['summary'] == '1 base changed'
    assert newest['length'] == 600 and newest['feature_count'] == 1


def test_a_save_over_a_version_never_seen_is_held_back(user_client, rand_dna):
    seq = rand_dna(500)
    sid = _save(user_client, _doc('pStale', seq))['id']
    assert _put(user_client, sid, _doc('pStale', seq + 'ACGT'), base_revision=1).status_code == 200

    # Started from version 1, but version 2 was saved meanwhile.
    r = _put(user_client, sid, _doc('pStale', seq + 'TTTT'), base_revision=1)
    assert r.status_code == 409
    body = r.get_json()
    assert body['stale'] is True and body['latest']['number'] == 2
    assert user_client.get(f'/api/sequences/{sid}').get_json()['sequence']['sequence'] == seq + 'ACGT'

    # Without a base revision (an older page), or with the right one, it saves.
    assert _put(user_client, sid, _doc('pStale', seq + 'TTTT'), base_revision=2).status_code == 200


def test_a_version_can_be_restored_and_the_restore_undone(user_client, rand_dna):
    seq = rand_dna(800)
    features = [{'name': 'promoter', 'type': 'promoter', 'start': 50, 'end': 150, 'strand': 1}]
    sid = _save(user_client, _doc('pBack', seq, features))['id']
    data = {'file': (io.BytesIO(f'>r1\n{seq[100:600]}\n'.encode()), 'r1.fa'), 'clone_number': '2'}
    user_client.post(f'/api/sequences/{sid}/reads', data=data, content_type='multipart/form-data')
    read_id = user_client.get(f'/api/sequences/{sid}/reads').get_json()['reads'][0]['id']
    user_client.post(f'/api/sequences/reads/{read_id}/verdict',
                     json={'verdict': 'sufficient', 'glycerol_stock': 'GS-9'})

    # An edit that deletes 20 bases and moves the feature.
    shorter = seq[:10] + seq[30:]
    moved = [dict(features[0], start=30, end=130)]
    assert _put(user_client, sid, _doc('pBack', shorter, moved)).status_code == 200

    r = user_client.post(f'/api/sequences/{sid}/history/1/restore')
    assert r.status_code == 200, r.get_json()
    restored = r.get_json()['sequence']
    assert restored['sequence'] == seq
    assert [(f['start'], f['end']) for f in restored['features']] == [(50, 150)]
    assert restored['revision'] == 3

    history = _history(user_client, sid)['revisions']
    assert history[0]['kind'] == 'restored' and history[0]['note'] == 'Rolled back to version 1'

    # The reads were aligned again to the restored sequence, keeping the verdict.
    reads = user_client.get(f'/api/sequences/{sid}/sequencing').get_json()['reads']
    assert reads[0]['alignment']['differences'] == []
    assert reads[0]['verdict'] == 'sufficient'

    # The rollback is a version too: going back to 2 undoes it.
    assert user_client.post(f'/api/sequences/{sid}/history/2/restore').status_code == 200
    assert user_client.get(f'/api/sequences/{sid}').get_json()['sequence']['sequence'] == shorter

    assert user_client.post(f'/api/sequences/{sid}/history/4/restore').status_code == 400
    assert user_client.post(f'/api/sequences/{sid}/history/99/restore').status_code == 404


def test_a_sequence_saved_before_history_keeps_its_old_version(user_client, rand_dna):
    seq = rand_dna(400)
    sid = _save(user_client, _doc('pOld', seq))['id']
    with get_connection() as conn:            # as if saved before this release
        conn.execute('DELETE FROM sequence_revisions WHERE sequence_id = ?', (sid,))
        conn.execute('UPDATE sequences SET revision = 0 WHERE id = ?', (sid,))

    assert _put(user_client, sid, _doc('pOld', seq + 'GG')).status_code == 200
    newest, baseline = _history(user_client, sid)['revisions']
    assert baseline['kind'] == 'baseline' and baseline['changed_by'] is None
    assert baseline['length'] == 400
    assert newest['changed_by'] == 'tester' and newest['summary'] == '400 → 402 bp'
    assert user_client.post(f'/api/sequences/{sid}/history/1/restore').status_code == 200


def test_only_those_who_may_change_it_can_roll_it_back(user_client, rand_dna):
    seq = rand_dna(400)
    sid = _save(user_client, _doc('pShared', seq))['id']
    _put(user_client, sid, _doc('pShared', seq + 'A'))
    user_client.post('/api/auth/logout')
    user_client.post('/api/auth/register', json={'username': 'other', 'password': 'password123'})

    body = _history(user_client, sid)
    assert body['can_restore'] is False and len(body['revisions']) == 2
    assert user_client.post(f'/api/sequences/{sid}/history/1/restore').status_code == 403
    one = user_client.get(f'/api/sequences/{sid}/history/1').get_json()
    assert one['document']['sequence'] == seq


def test_deleting_a_sequence_deletes_its_history(user_client, rand_dna):
    sid = _save(user_client, _doc('pGone', rand_dna(300)))['id']
    assert user_client.delete(f'/api/sequences/{sid}').status_code == 200
    with get_connection() as conn:
        assert conn.execute('SELECT COUNT(*) FROM sequence_revisions WHERE sequence_id = ?',
                            (sid,)).fetchone()[0] == 0
