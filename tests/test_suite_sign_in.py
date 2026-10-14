"""
Signing in through the Gardiner Lab suite (SUITE_AUTH=proxy).

The suite's proxy names the signed-in user in X-Suite-User. The editor follows
it: no header, nobody signed in; a header, that user, with a local row taken
from the shared directory. Registration stays here. Off unless set, so a
standalone editor keeps its own sign-in.
"""

import os
import sqlite3

import pytest

from tests.test_shared_accounts import _moclo_users_db


@pytest.fixture()
def suite(tmp_dbs, monkeypatch):
    monkeypatch.setenv('SUITE_AUTH', 'proxy')
    monkeypatch.setenv('SUITE_LOGIN_URL', '/account/login')
    monkeypatch.setenv('SUITE_LOGOUT_URL', '/account/logout')
    _moclo_users_db(tmp_dbs['moclo'], [
        ('moclo-1', 'alice', 'alicepassword', 0),
        ('moclo-2', 'boss', 'bosspassword', 1),
    ])
    return tmp_dbs


def as_user(username):
    return {'X-Suite-User': username}


def test_the_suite_user_is_signed_in(suite, client):
    body = client.get('/api/auth/session', headers=as_user('alice')).get_json()
    assert body['authenticated'] is True
    assert body['user']['username'] == 'alice'
    assert client.get('/editor', headers=as_user('alice')).status_code == 200
    assert client.get('/api/sequences', headers=as_user('alice')).status_code == 200


def test_no_header_means_nobody(suite, client):
    client.get('/editor', headers=as_user('alice'))
    assert client.get('/api/auth/session').get_json()['authenticated'] is False
    assert client.get('/api/sequences').status_code == 401


def test_switching_users_follows_the_suite(suite, client):
    client.get('/editor', headers=as_user('alice'))
    body = client.get('/api/auth/session', headers=as_user('boss')).get_json()
    assert body['user']['username'] == 'boss'
    assert body['user']['role'] == 'admin'


def test_an_unknown_user_is_nobody(suite, client):
    assert client.get('/api/auth/session',
                      headers=as_user('mallory')).get_json()['authenticated'] is False


def test_administrator_status_made_in_another_tool_shows_here(suite, client):
    def role():
        return client.get('/api/auth/session', headers=as_user('alice')).get_json()['user']['role']
    assert role() == 'member'
    conn = sqlite3.connect(suite['moclo'])
    conn.execute("UPDATE users SET is_admin = 1 WHERE username = 'alice'")
    conn.commit()
    conn.close()
    assert role() == 'admin'


def test_sign_in_and_out_go_to_the_suite(suite, client):
    r = client.get('/login')
    assert r.status_code == 302
    assert r.headers['Location'] == '/account/login?next=/editor'
    assert client.get('/login?next=/library').headers['Location'] == '/account/login?next=/library'
    assert client.get('/logout', headers=as_user('alice')).headers['Location'] == '/account/logout'


def test_the_editor_has_no_sign_in_of_its_own(suite, client):
    r = client.post('/api/auth/login', json={'username': 'alice', 'password': 'alicepassword'})
    assert r.status_code == 403
    assert r.get_json()['login_url'] == '/account/login'


def test_registration_is_the_suites(suite, client):
    r = client.get('/login?register')
    assert r.status_code == 302
    assert r.headers['Location'] == '/account/register'
    r = client.post('/api/auth/register', json={'username': 'carol', 'password': 'carolpassword',
                                                'lab_source': 'Test Lab'})
    assert r.status_code == 403
    assert r.get_json()['register_url'] == '/account/register'


def _suite_labs(path, members):
    """The suite's labs database, as its sign-in service keeps it."""
    conn = sqlite3.connect(path)
    conn.executescript("""
        CREATE TABLE labs (id TEXT PRIMARY KEY, name TEXT, registration_code TEXT,
                           code_updated_by TEXT, code_updated_at TEXT, created_at TEXT);
        CREATE TABLE members (username TEXT PRIMARY KEY, lab_id TEXT, role TEXT, joined_at TEXT);
        INSERT INTO labs (id, name) VALUES ('g', 'Gardiner Lab'), ('s', 'Smith Lab');
    """)
    conn.executemany('INSERT INTO members (username, lab_id, role) VALUES (?, ?, ?)', members)
    conn.commit()
    conn.close()


@pytest.fixture()
def suite_labs(suite, monkeypatch):
    path = os.path.join(suite['dir'], 'suite.db')
    monkeypatch.setenv('SUITE_DATABASE_PATH', path)
    _suite_labs(path, [('alice', 'g', 'lab_lead'), ('bob', 's', 'member')])
    _moclo_users_db(suite['moclo'], [('moclo-3', 'bob', 'bobpassword', 0)])
    return path


def test_labs_and_lab_leads_are_the_suites(suite_labs, client):
    alice = client.get('/api/auth/session', headers=as_user('alice')).get_json()['user']
    assert alice['lab_source'] == 'Gardiner Lab'
    assert alice['role'] == 'lab_lead'
    bob = client.get('/api/auth/session', headers=as_user('bob')).get_json()['user']
    assert bob['lab_source'] == 'Smith Lab'
    assert bob['role'] == 'member'


def test_a_change_on_the_suites_labs_page_shows_at_once(suite_labs, client):
    client.get('/editor', headers=as_user('bob'))
    conn = sqlite3.connect(suite_labs)
    conn.execute("UPDATE members SET lab_id = 'g', role = 'lab_lead' WHERE username = 'bob'")
    conn.commit()
    conn.close()
    bob = client.get('/api/auth/session', headers=as_user('bob')).get_json()['user']
    assert (bob['lab_source'], bob['role']) == ('Gardiner Lab', 'lab_lead')


def test_the_navigation_leads_to_the_suites_dashboard(suite_labs, client):
    page = client.get('/editor', headers=as_user('bob')).get_data(as_text=True)
    assert 'href="/account/"' in page


def test_labs_are_managed_on_the_suites_page(suite_labs, client):
    r = client.get('/admin', headers=as_user('alice'))
    assert r.status_code == 302
    assert r.headers['Location'] == '/account/#labs'
    r = client.get('/api/admin/overview', headers=as_user('boss'))
    assert r.status_code == 403
    assert r.get_json()['admin_url'] == '/account/#labs'
    r = client.patch('/api/auth/profile', json={'lab_source': 'Smith Lab'}, headers=as_user('alice'))
    assert r.status_code == 403


def test_standalone_ignores_the_header(tmp_dbs, monkeypatch, client):
    monkeypatch.delenv('SUITE_AUTH', raising=False)
    _moclo_users_db(tmp_dbs['moclo'], [('moclo-1', 'alice', 'alicepassword', 0)])
    assert client.get('/api/auth/session',
                      headers=as_user('alice')).get_json()['authenticated'] is False
    assert client.get('/login').status_code == 200
    assert client.post('/api/auth/login', json={'username': 'alice',
                                                 'password': 'alicepassword'}).status_code == 200
