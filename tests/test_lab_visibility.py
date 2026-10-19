"""
Who sees a plasmid, inside the lab suite: always everyone in its owner's labs
(and administrators); every lab once it is public. Someone may be in several
labs.
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


def test_a_plasmid_is_its_labs_and_everyones_once_public(labs, client):
    made = client.post('/api/sequences', headers=who('ana'), json={'document': {
        'name': 'pGard', 'sequence': 'ACGT' * 100, 'circular': True}})
    assert made.status_code == 201 and made.get_json()['sequence']['public'] is False
    pid = made.get_json()['sequence']['id']
    status = lambda name: client.get(f'/api/sequences/{pid}', headers=who(name)).status_code
    # Not public: all of Gardiner Lab (Max too, who is in it as well), not Smith Lab's Zoe.
    assert [status(n) for n in ('ana', 'ben', 'lead', 'zoe', 'max', 'boss')] == [200, 200, 200, 403, 200, 200]
    listed = lambda name: {s['name'] for s in client.get('/api/sequences', headers=who(name)).get_json()['sequences']}
    assert 'pGard' in listed('ben') and 'pGard' not in listed('zoe')
    # Only its owner, her lead and administrators change it, and make it public.
    assert client.get(f'/api/sequences/{pid}', headers=who('ben')).get_json()['sequence']['can_change'] is False
    assert client.get(f'/api/sequences/{pid}', headers=who('lead')).get_json()['sequence']['can_change'] is True
    assert client.patch(f'/api/sequences/{pid}', headers=who('ben'), json={'public': True}).status_code == 403

    # Public: every lab sees it; still only its owner's side changes it.
    assert client.patch(f'/api/sequences/{pid}', headers=who('ana'), json={'public': True, 'sync': False}).status_code == 200
    assert status('zoe') == 200 and 'pGard' in listed('zoe')
    assert client.get(f'/api/sequences/{pid}', headers=who('zoe')).get_json()['sequence']['can_change'] is False
    # Back to its labs only.
    assert client.patch(f'/api/sequences/{pid}', headers=who('ana'), json={'public': False, 'sync': False}).status_code == 200
    assert status('zoe') == 403


def test_the_old_shared_setting_does_not_make_a_plasmid_public(labs, client):
    made = client.post('/api/sequences', headers=who('ana'), json={'document': {
        'name': 'pOld', 'sequence': 'ACGT' * 100, 'circular': True}, 'shared': True}).get_json()['sequence']
    assert made['public'] is False
    assert client.get(f"/api/sequences/{made['id']}", headers=who('zoe')).status_code == 403


def test_sequencing_is_seen_by_whoever_sees_the_plasmid(labs, client):
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
