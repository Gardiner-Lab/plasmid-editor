"""
The MoClo library card follows the MoClo Library Tool's own rule: a record is
seen by the chair group of whoever added it, by chair groups that group shares
its library with, and by everyone when it is a reference record (the built-in
toolkit, or one marked in MoClo). Administrators see everything.
"""

import sqlite3

import pytest

from tests.test_shared_accounts import _moclo_users_db

SEQ = 'GATTACA' * 20


@pytest.fixture()
def library(moclo_parts_db, monkeypatch):
    """Plant chair group: Gardiner Lab (ana), Smith Lab (zoe). Microbiology: Jones Lab (tom)."""
    dbs = moclo_parts_db
    monkeypatch.setenv('SUITE_AUTH', 'proxy')
    suite = f"{dbs['dir']}/suite.db"
    monkeypatch.setenv('SUITE_DATABASE_PATH', suite)
    _moclo_users_db(dbs['moclo'], [(f'm-{u}', u, f'{u}-password', 1 if u == 'boss' else 0)
                                   for u in ('ana', 'zoe', 'tom', 'boss', 'system')])
    conn = sqlite3.connect(suite)
    conn.executescript("""
        CREATE TABLE labs (id TEXT PRIMARY KEY, name TEXT, chair_group_id TEXT);
        CREATE TABLE members (username TEXT PRIMARY KEY, lab_id TEXT, role TEXT, joined_at TEXT);
        CREATE TABLE lab_members (username TEXT, lab_id TEXT, role TEXT, lab_admin INTEGER DEFAULT 0,
                                  joined_at TEXT, PRIMARY KEY (username, lab_id));
        INSERT INTO labs VALUES ('g', 'Gardiner Lab', 'plant'), ('s', 'Smith Lab', 'plant'),
                                ('j', 'Jones Lab', 'microbe');
        INSERT INTO lab_members VALUES ('ana', 'g', 'member', 0, '1'), ('zoe', 's', 'member', 0, '2'),
                                       ('tom', 'j', 'member', 0, '3');
    """)
    conn.commit()
    conn.close()
    moclo = sqlite3.connect(dbs['moclo'])
    moclo.executescript("""
        CREATE TABLE library_reference (kind TEXT, record_id TEXT, marked_by TEXT, marked_at TIMESTAMP,
                                        PRIMARY KEY (kind, record_id));
        CREATE TABLE library_shares (from_group TEXT, to_group TEXT, created_by TEXT, created_at TIMESTAMP,
                                     PRIMARY KEY (from_group, to_group));
        CREATE TABLE backbones (id TEXT PRIMARY KEY, name TEXT, owner_id TEXT, sequence TEXT, description TEXT);
        INSERT INTO backbones VALUES ('b-ana', 'pAnaBackbone', 'm-ana', 'ACGT', ''),
                                     ('b-kit', 'pToolkitBackbone', 'm-system', 'ACGT', '');
        INSERT INTO library_reference (kind, record_id) VALUES ('part', 'p-marked');
    """)
    moclo.commit()
    moclo.close()
    parts = sqlite3.connect(dbs['parts'])
    for pid, name, contributor in (('p-ana', 'anaCDS', 'ana'), ('p-ana-old', 'anaOld', 'm-ana'),
                                   ('p-tom', 'tomCDS', 'tom'), ('p-kit', 'toolkitFiller', 'system'),
                                   ('p-marked', 'markedKit', 'tom')):
        parts.execute('INSERT INTO parts (id, name, part_type, sequence, overhang_5prime, overhang_3prime, '
                      'lab_source, contributor) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
                      (pid, name, 'Coding', SEQ, 'AATG', 'GCTT', 'somewhere', contributor))
    parts.commit()
    parts.close()
    return dbs


def who(name):
    return {'X-Suite-User': name}


def _parts(client, name):
    return {p['name'] for p in client.get('/api/moclo/parts', headers=who(name)).get_json()['parts']}


def test_the_moclo_card_is_the_chair_groups(library, client):
    # Ana's (also one recorded by user id), the toolkit's and a marked reference part; not Tom's.
    assert _parts(client, 'zoe') == {'anaCDS', 'anaOld', 'toolkitFiller', 'markedKit'}
    assert _parts(client, 'tom') == {'tomCDS', 'toolkitFiller', 'markedKit'}
    assert _parts(client, 'boss') == {'anaCDS', 'anaOld', 'tomCDS', 'toolkitFiller', 'markedKit'}
    assert client.get('/api/moclo/parts/p-ana', headers=who('tom')).status_code == 403
    assert client.get('/api/moclo/parts/p-ana', headers=who('zoe')).status_code == 200
    assert client.post('/api/moclo/import', headers=who('tom'),
                       json={'kind': 'part', 'id': 'p-ana'}).status_code == 403


def test_backbones_too(library, client):
    names = lambda n: {p['name'] for p in client.get('/api/moclo/plasmids', headers=who(n)).get_json()['plasmids']}
    assert names('zoe') == {'pAnaBackbone', 'pToolkitBackbone'}
    assert names('tom') == {'pToolkitBackbone'}
    assert client.get('/api/moclo/plasmids/backbone/b-ana', headers=who('tom')).status_code == 403


def test_a_shared_library_is_seen_by_the_other_chair_group(library, client):
    conn = sqlite3.connect(library['moclo'])
    conn.execute("INSERT INTO library_shares (from_group, to_group) VALUES ('plant', 'microbe')")
    conn.commit()
    conn.close()
    assert 'anaCDS' in _parts(client, 'tom')
    # One way only.
    assert 'tomCDS' not in _parts(client, 'ana')
