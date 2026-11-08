"""
Who sees a plasmid, inside the lab suite: its owner's chair group (labs that
work together, set by an administrator), read-only beyond the owner's own labs;
and administrators. A lab in no chair group keeps its plasmids to itself, and
nothing is seen by every lab: the old "public" setting is no longer read.
Someone may be in several labs.
"""

import io
import sqlite3

import pytest

from tests.test_shared_accounts import _moclo_users_db

READ = b'>r1\n' + b'ACGT' * 50 + b'\n'
PEOPLE = ('ana', 'ben', 'lead', 'zoe', 'max', 'tom', 'boss')


def _suite(tmp_dbs, monkeypatch, chair_groups: bool):
    """Gardiner Lab (ana, ben, lead; max too), Smith Lab (zoe, max), Jones Lab (tom);
    with chair groups, Gardiner and Smith are in one and Jones in none."""
    monkeypatch.setenv('SUITE_AUTH', 'proxy')
    suite = f"{tmp_dbs['dir']}/suite.db"
    monkeypatch.setenv('SUITE_DATABASE_PATH', suite)
    _moclo_users_db(tmp_dbs['moclo'], [(f'm-{u}', u, f'{u}-password', 1 if u == 'boss' else 0)
                                       for u in PEOPLE])
    conn = sqlite3.connect(suite)
    if chair_groups:
        conn.executescript("""
            CREATE TABLE labs (id TEXT PRIMARY KEY, name TEXT, chair_group_id TEXT);
            INSERT INTO labs VALUES ('g', 'Gardiner Lab', 'c1'), ('s', 'Smith Lab', 'c1'),
                                    ('j', 'Jones Lab', NULL);
        """)
    else:
        conn.executescript("""
            CREATE TABLE labs (id TEXT PRIMARY KEY, name TEXT);
            INSERT INTO labs VALUES ('g', 'Gardiner Lab'), ('s', 'Smith Lab'), ('j', 'Jones Lab');
        """)
    conn.executescript("""
        CREATE TABLE members (username TEXT PRIMARY KEY, lab_id TEXT, role TEXT, joined_at TEXT);
        CREATE TABLE lab_members (username TEXT, lab_id TEXT, role TEXT, lab_admin INTEGER DEFAULT 0,
                                  joined_at TEXT, PRIMARY KEY (username, lab_id));
        INSERT INTO lab_members VALUES ('ana', 'g', 'member', 0, '1'), ('ben', 'g', 'member', 0, '2'),
                                       ('lead', 'g', 'lab_lead', 0, '3'), ('zoe', 's', 'member', 0, '4'),
                                       ('max', 's', 'member', 0, '5'), ('max', 'g', 'member', 0, '6'),
                                       ('tom', 'j', 'member', 0, '7');
    """)
    conn.commit()
    conn.close()
    return tmp_dbs


@pytest.fixture()
def chair(tmp_dbs, monkeypatch):
    return _suite(tmp_dbs, monkeypatch, chair_groups=True)


@pytest.fixture()
def labs(tmp_dbs, monkeypatch):
    return _suite(tmp_dbs, monkeypatch, chair_groups=False)


def who(name):
    return {'X-Suite-User': name}


def _make(client, name='pGard', owner='ana'):
    made = client.post('/api/sequences', headers=who(owner), json={'document': {
        'name': name, 'sequence': 'ACGT' * 100, 'circular': True}})
    assert made.status_code == 201, made.get_json()
    return made.get_json()['sequence']


def test_a_plasmid_is_its_chair_groups(chair, client):
    pid = _make(client)['id']
    status = lambda name: client.get(f'/api/sequences/{pid}', headers=who(name)).status_code
    # Gardiner Lab, and Smith Lab in its chair group; not Jones Lab, in none.
    assert [status(n) for n in PEOPLE] == [200, 200, 200, 200, 200, 403, 200]
    listed = lambda name: {s['name'] for s in client.get('/api/sequences', headers=who(name)).get_json()['sequences']}
    assert 'pGard' in listed('zoe') and 'pGard' not in listed('tom')
    # Only its owner, her lead and administrators change it; the chair group looks.
    change = lambda name: client.get(f'/api/sequences/{pid}', headers=who(name)).get_json()['sequence']['can_change']
    assert (change('ana'), change('lead'), change('boss'), change('ben'), change('zoe')) == \
        (True, True, True, False, False)
    assert client.patch(f'/api/sequences/{pid}', headers=who('zoe'),
                        json={'golden_gate': True, 'sync': False}).status_code == 403


def test_nothing_is_seen_by_every_lab(chair, client):
    # A page from before still sends "public"; it changes nothing.
    made = client.post('/api/sequences', headers=who('ana'), json={'document': {
        'name': 'pOld', 'sequence': 'ACGT' * 100, 'circular': True}, 'public': True}).get_json()['sequence']
    assert 'public' not in made
    assert client.get(f"/api/sequences/{made['id']}", headers=who('tom')).status_code == 403
    assert client.patch(f"/api/sequences/{made['id']}", headers=who('ana'),
                        json={'public': True, 'sync': False}).status_code == 200
    assert client.get(f"/api/sequences/{made['id']}", headers=who('tom')).status_code == 403


def test_a_plasmid_ticked_public_before_drops_back_to_its_chair_group(chair, client, tmp_dbs):
    pid = _make(client, 'pWasPublic')['id']
    from app.models.database import get_connection
    with get_connection() as conn:
        conn.execute('UPDATE sequences SET public = 1 WHERE id = ?', (pid,))
    assert client.get(f'/api/sequences/{pid}', headers=who('zoe')).status_code == 200
    assert client.get(f'/api/sequences/{pid}', headers=who('tom')).status_code == 403


def test_without_chair_groups_a_plasmid_is_its_labs(labs, client):
    pid = _make(client)['id']
    status = lambda name: client.get(f'/api/sequences/{pid}', headers=who(name)).status_code
    # All of Gardiner Lab (Max too, who is in it as well); not Smith Lab's Zoe.
    assert [status(n) for n in PEOPLE] == [200, 200, 200, 403, 200, 403, 200]


def test_sequencing_is_seen_by_the_chair_group_and_added_by_the_owners_labs(chair, client):
    made = _make(client, 'pSeq')
    r = client.post(f"/api/sequences/{made['id']}/reads", headers=who('ana'),
                    data={'file': (io.BytesIO(READ), 'r1.fasta')}, content_type='multipart/form-data')
    assert r.status_code in (200, 201), r.get_json()
    on_page = lambda name: {s['name'] for s in client.get('/api/sequences?sequencing=true',
                                                          headers=who(name)).get_json()['sequences']}
    assert 'pSeq' in on_page('ben') and 'pSeq' in on_page('zoe') and 'pSeq' not in on_page('tom')
    reads = lambda name: client.get(f"/api/sequences/{made['id']}/reads", headers=who(name)).status_code
    assert (reads('ben'), reads('zoe'), reads('tom')) == (200, 200, 403)
    view = lambda name: client.get(f"/api/sequences/{made['id']}/sequencing",
                                   headers=who(name)).get_json()['sequence']['can_add_reads']
    # Ben's lab adds reads; Zoe's, elsewhere in the chair group, only looks.
    assert view('ben') is True and view('zoe') is False
    added = client.post(f"/api/sequences/{made['id']}/reads", headers=who('zoe'),
                        data={'file': (io.BytesIO(READ), 'r2.fasta')}, content_type='multipart/form-data')
    assert added.status_code == 403


def test_feature_entries_of_someone_who_left_reach_their_labs_lead(chair, client):
    """A person's own feature-library entries are theirs, until they are archived: then their lab's leads see them."""
    added = client.post('/api/library', headers=who('ana'),
                        json={'entries': [{'name': 'anaTag', 'sequence': 'GATTACAGATTACA', 'type': 'misc_feature'}]})
    assert added.status_code in (200, 201), added.get_json()
    names = lambda name: {e['name'] for e in client.get('/api/library', headers=who(name)).get_json()['custom']}
    assert 'anaTag' in names('ana') and 'anaTag' not in names('lead')
    conn = sqlite3.connect(f"{chair['dir']}/suite.db")
    conn.execute('CREATE TABLE archived (username TEXT PRIMARY KEY, archived_at TEXT, archived_by TEXT)')
    conn.execute("INSERT INTO archived VALUES ('ana', '2026-11-08', 'lead')")
    conn.commit()
    conn.close()
    assert 'anaTag' in names('lead') and 'anaTag' in names('boss')
    assert 'anaTag' not in names('ben') and 'anaTag' not in names('tom')
