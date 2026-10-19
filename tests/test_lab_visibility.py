"""
Who sees a plasmid, inside the lab suite: private by default (its owner, the
leads of the owner's labs, administrators); shared, everyone in a lab with the
owner, and nobody in other labs. Someone may be in several labs.
"""

import io
import sqlite3

import pytest

from tests.test_shared_accounts import _moclo_users_db

READ = b'>r1\n' + b'ACGT' * 50 + b'\n'


@pytest.fixture()
def labs(tmp_dbs, monkeypatch):
    monkeypatch.setenv('SUITE_AUTH', 'proxy')
    suite = f"{tmp_dbs['dir']}/suite.db"
    monkeypatch.setenv('SUITE_DATABASE_PATH', suite)
    _moclo_users_db(tmp_dbs['moclo'], [(f'm-{u}', u, f'{u}-password', 1 if u == 'boss' else 0)
                                       for u in ('ana', 'ben', 'lead', 'zoe', 'max', 'boss')])
    conn = sqlite3.connect(suite)
    conn.executescript("""
        CREATE TABLE labs (id TEXT PRIMARY KEY, name TEXT);
        CREATE TABLE members (username TEXT PRIMARY KEY, lab_id TEXT, role TEXT, joined_at TEXT);
        CREATE TABLE lab_members (username TEXT, lab_id TEXT, role TEXT, lab_admin INTEGER DEFAULT 0,
                                  joined_at TEXT, PRIMARY KEY (username, lab_id));
        INSERT INTO labs VALUES ('g', 'Gardiner Lab'), ('s', 'Smith Lab');
        INSERT INTO lab_members VALUES ('ana', 'g', 'member', 0, '1'), ('ben', 'g', 'member', 0, '2'),
                                       ('lead', 'g', 'lab_lead', 0, '3'), ('zoe', 's', 'member', 0, '4'),
                                       ('max', 's', 'member', 0, '5'), ('max', 'g', 'member', 0, '6');
    """)
    conn.commit()
    conn.close()
    return tmp_dbs


def who(name):
    return {'X-Suite-User': name}


def test_plasmids_are_private_until_shared_and_then_only_within_the_owners_labs(labs, client):
    made = client.post('/api/sequences', headers=who('ana'), json={'document': {
        'name': 'pPrivate', 'sequence': 'ACGT' * 100, 'circular': True}})
    assert made.status_code == 201 and made.get_json()['sequence']['shared'] is False
    pid = made.get_json()['sequence']['id']
    status = lambda name: client.get(f'/api/sequences/{pid}', headers=who(name)).status_code
    # Private: its owner, her lab's lead, administrators.
    assert [status(n) for n in ('ana', 'ben', 'lead', 'zoe', 'max', 'boss')] == [200, 403, 200, 403, 403, 200]
    assert client.get(f'/api/sequences/{pid}', headers=who('lead')).get_json()['sequence']['can_change'] is True

    # Shared with her labs: everyone in Gardiner Lab, Max too (he is in it as well), not Smith Lab's Zoe.
    assert client.patch(f'/api/sequences/{pid}', headers=who('ana'), json={'shared': True, 'sync': False}).status_code == 200
    assert [status(n) for n in ('ana', 'ben', 'lead', 'zoe', 'max', 'boss')] == [200, 200, 200, 403, 200, 200]
    assert client.get(f'/api/sequences/{pid}', headers=who('ben')).get_json()['sequence']['can_change'] is False
    assert client.patch(f'/api/sequences/{pid}', headers=who('ben'), json={'shared': False}).status_code == 403

    listed = lambda name: {s['name'] for s in client.get('/api/sequences', headers=who(name)).get_json()['sequences']}
    assert 'pPrivate' in listed('ben') and 'pPrivate' in listed('max') and 'pPrivate' not in listed('zoe')


def test_a_lead_sees_their_members_private_plasmids_in_the_list(labs, client):
    client.post('/api/sequences', headers=who('ben'), json={'document': {
        'name': 'pBens', 'sequence': 'ACGT' * 100, 'circular': True}})
    listed = lambda name: {s['name'] for s in client.get('/api/sequences', headers=who(name)).get_json()['sequences']}
    assert 'pBens' in listed('lead') and 'pBens' in listed('boss')
    assert 'pBens' not in listed('ana') and 'pBens' not in listed('zoe')


def test_sequencing_of_a_private_plasmid_is_open_to_its_labs_only(labs, client):
    made = client.post('/api/sequences', headers=who('ana'), json={'document': {
        'name': 'pSeq', 'sequence': 'ACGT' * 100, 'circular': True}}).get_json()['sequence']
    r = client.post(f"/api/sequences/{made['id']}/reads", headers=who('ana'),
                    data={'file': (io.BytesIO(READ), 'r1.fasta')}, content_type='multipart/form-data')
    assert r.status_code in (200, 201), r.get_json()
    on_page = lambda name: {s['name'] for s in client.get('/api/sequences?sequencing=true',
                                                          headers=who(name)).get_json()['sequences']}
    assert 'pSeq' in on_page('ben') and 'pSeq' in on_page('max') and 'pSeq' not in on_page('zoe')
    reads = lambda name: client.get(f"/api/sequences/{made['id']}/reads", headers=who(name)).status_code
    assert reads('ben') == 200 and reads('zoe') == 403
