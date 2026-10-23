"""
Ladders made for the virtual gel: used by everyone in their maker's chair group
(their own labs among them), changed only by their maker or an administrator.
"""

import sqlite3

import pytest

from app.models import ladder
from tests.test_shared_accounts import _moclo_users_db

DOC = {'name': 'pTest', 'sequence': 'GAATTC' + 'ACGT' * 300 + 'GGATCC' + 'TTGA' * 200, 'circular': True}


@pytest.fixture()
def chair(tmp_dbs, monkeypatch):
    """Gardiner Lab and Smith Lab in one chair group; Jones Lab in none."""
    monkeypatch.setenv('SUITE_AUTH', 'proxy')
    suite = f"{tmp_dbs['dir']}/suite.db"
    monkeypatch.setenv('SUITE_DATABASE_PATH', suite)
    _moclo_users_db(tmp_dbs['moclo'], [(f'm-{u}', u, f'{u}-password', 1 if u == 'boss' else 0)
                                       for u in ('ana', 'ben', 'zoe', 'tom', 'boss')])
    conn = sqlite3.connect(suite)
    conn.executescript("""
        CREATE TABLE labs (id TEXT PRIMARY KEY, name TEXT, chair_group_id TEXT);
        CREATE TABLE members (username TEXT PRIMARY KEY, lab_id TEXT, role TEXT, joined_at TEXT);
        CREATE TABLE lab_members (username TEXT, lab_id TEXT, role TEXT, lab_admin INTEGER DEFAULT 0,
                                  joined_at TEXT, PRIMARY KEY (username, lab_id));
        INSERT INTO labs VALUES ('g', 'Gardiner Lab', 'cg'), ('s', 'Smith Lab', 'cg'), ('j', 'Jones Lab', NULL);
        INSERT INTO lab_members VALUES ('ana', 'g', 'member', 0, '1'), ('ben', 'g', 'member', 0, '2'),
                                       ('zoe', 's', 'member', 0, '3'), ('tom', 'j', 'member', 0, '4');
    """)
    conn.commit()
    conn.close()
    return tmp_dbs


def who(name):
    return {'X-Suite-User': name}


def test_band_sizes_are_read_as_written():
    assert ladder.clean_bands('10000, 8000 6000*\n1.5 kb; 500') == [
        {'size': 10000, 'strong': False}, {'size': 8000, 'strong': False}, {'size': 6000, 'strong': True},
        {'size': 1500, 'strong': False}, {'size': 500, 'strong': False}]
    assert ladder.clean_bands([300, {'size': 1000, 'strong': True}, 300]) == [
        {'size': 1000, 'strong': True}, {'size': 300, 'strong': False}]
    for bad in ('1000', 'abc, 200', '5, 1000', '1000, 200000', '1.25, 500', ''):
        with pytest.raises(ValueError):
            ladder.clean_bands(bad)


def test_a_made_ladder_is_the_chair_groups(chair, client):
    made = client.post('/api/tools/ladders', headers=who('ana'),
                       json={'name': 'GeneRuler mix', 'bands': '10000, 5000, 3000*, 1000, 500', 'description': 'our usual'})
    assert made.status_code == 201, made.get_json()
    lid = made.get_json()['ladder']['id']
    names = lambda name: [l['name'] for l in client.get('/api/tools/ladders', headers=who(name)).get_json()['made']]
    # Ana's lab and Smith Lab (one chair group) use it; Jones Lab does not see it.
    assert [names(n) for n in ('ana', 'ben', 'zoe', 'tom', 'boss')] == [['GeneRuler mix']] * 3 + [[], ['GeneRuler mix']]
    standard = [l['name'] for l in client.get('/api/tools/ladders', headers=who('tom')).get_json()['standard']]
    assert '1 kb ladder' in standard

    # A gel run beside it, by its id: its name and bands, the reference band marked.
    gel = lambda name: client.post('/api/tools/gel', headers=who(name), json={
        'ladder_id': lid, 'lanes': [{'document': DOC, 'enzymes': ['EcoRI', 'BamHI']}]})
    r = gel('zoe')
    assert r.status_code == 200, r.get_json()
    assert r.get_json()['ladder']['label'] == 'GeneRuler mix'
    assert [(b['size'], b['strong']) for b in r.get_json()['ladder']['bands']][:3] == [(10000, False), (5000, False), (3000, True)]
    assert gel('tom').status_code == 400                       # not his chair group's
    # Standard ladders as before, by name.
    plain = client.post('/api/tools/gel', headers=who('tom'), json={
        'ladder': '100 bp ladder', 'lanes': [{'document': DOC, 'enzymes': ['EcoRI']}]})
    assert plain.status_code == 200 and plain.get_json()['ladder']['label'] == '100 bp ladder'

    # Only its maker (or an administrator) changes or removes it.
    listed = client.get('/api/tools/ladders', headers=who('ben')).get_json()['made'][0]
    assert listed['can_change'] is False and listed['created_by'] == 'ana'
    assert client.put(f'/api/tools/ladders/{lid}', headers=who('ben'), json={'name': 'Mine now'}).status_code == 403
    assert client.delete(f'/api/tools/ladders/{lid}', headers=who('zoe')).status_code == 403
    assert client.delete(f'/api/tools/ladders/{lid}', headers=who('tom')).status_code == 404
    changed = client.put(f'/api/tools/ladders/{lid}', headers=who('ana'), json={'bands': '12000, 3000*, 250'})
    assert changed.status_code == 200 and [b['size'] for b in changed.get_json()['ladder']['bands']] == [12000, 3000, 250]
    assert client.put(f'/api/tools/ladders/{lid}', headers=who('boss'), json={'name': 'Renamed'}).status_code == 200
    assert client.delete(f'/api/tools/ladders/{lid}', headers=who('ana')).status_code == 200
    assert names('zoe') == []


def test_a_ladder_needs_a_name_of_its_own_and_real_bands(chair, client):
    post = lambda body: client.post('/api/tools/ladders', headers=who('ana'), json=body)
    assert post({'name': '', 'bands': '1000, 500'}).status_code == 400
    assert post({'name': '1 kb ladder', 'bands': '1000, 500'}).status_code == 400     # a standard one's name
    assert post({'name': 'Odd', 'bands': 'lots'}).status_code == 400
    assert post({'name': 'Fine', 'bands': [1000, 500]}).status_code == 201


def test_without_chair_groups_a_ladder_is_the_makers_labs(tmp_dbs, monkeypatch, client):
    monkeypatch.setenv('SUITE_AUTH', 'proxy')
    suite = f"{tmp_dbs['dir']}/suite.db"
    monkeypatch.setenv('SUITE_DATABASE_PATH', suite)
    _moclo_users_db(tmp_dbs['moclo'], [(f'm-{u}', u, f'{u}-password', 0) for u in ('ana', 'ben', 'zoe')])
    conn = sqlite3.connect(suite)
    conn.executescript("""
        CREATE TABLE labs (id TEXT PRIMARY KEY, name TEXT);
        CREATE TABLE members (username TEXT PRIMARY KEY, lab_id TEXT, role TEXT, joined_at TEXT);
        INSERT INTO labs VALUES ('g', 'Gardiner Lab'), ('s', 'Smith Lab');
        INSERT INTO members VALUES ('ana', 'g', 'member', '1'), ('ben', 'g', 'member', '2'), ('zoe', 's', 'member', '3');
    """)
    conn.commit()
    conn.close()
    assert client.post('/api/tools/ladders', headers=who('ana'), json={'name': 'Ours', 'bands': '2000, 1000'}).status_code == 201
    names = lambda name: [l['name'] for l in client.get('/api/tools/ladders', headers=who(name)).get_json()['made']]
    assert names('ben') == ['Ours'] and names('zoe') == []
