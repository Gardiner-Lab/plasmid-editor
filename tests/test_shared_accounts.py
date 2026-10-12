"""
Accounts are shared across the lab tools.

The MoClo Library Tool's user table is the directory: one username and password
works everywhere, and administrator status is set in one place. Accounts
registered here are created in the directory, accounts that only existed here
are copied into it, and a local row is kept so this app's own ownership
references still work.
"""

import os
import sqlite3

import bcrypt
import pytest

from dnakit import model


def _moclo_users_db(path, users):
    """A MoClo main database with its real users table."""
    conn = sqlite3.connect(path)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS users (
            id TEXT PRIMARY KEY,
            username TEXT UNIQUE NOT NULL,
            password_hash TEXT NOT NULL,
            is_admin INTEGER NOT NULL DEFAULT 0,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )""")
    for uid, username, password, is_admin in users:
        conn.execute('INSERT OR REPLACE INTO users (id, username, password_hash, is_admin) '
                     'VALUES (?, ?, ?, ?)',
                     (uid, username, bcrypt.hashpw(password.encode(), bcrypt.gensalt()).decode(),
                      1 if is_admin else 0))
    conn.commit()
    conn.close()


@pytest.fixture()
def shared_accounts(tmp_dbs):
    _moclo_users_db(tmp_dbs['moclo'], [
        ('moclo-1', 'alice', 'alicepassword', 1),
        ('moclo-2', 'bob', 'bobpassword', 0),
    ])
    return tmp_dbs


def test_a_moclo_account_signs_in_here(client, shared_accounts):
    r = client.post('/api/auth/login', json={'username': 'alice', 'password': 'alicepassword'})
    assert r.status_code == 200, r.get_json()
    user = r.get_json()['user']
    assert user['username'] == 'alice'
    assert user['is_admin'] is True, 'administrator status comes from the shared directory'

    session = client.get('/api/auth/session').get_json()
    assert session['authenticated'] is True
    assert session['shared_accounts'] is True


def test_the_wrong_password_is_still_refused(client, shared_accounts):
    assert client.post('/api/auth/login',
                       json={'username': 'alice', 'password': 'nope'}).status_code == 401


def test_a_non_admin_stays_a_non_admin(client, shared_accounts):
    r = client.post('/api/auth/login', json={'username': 'bob', 'password': 'bobpassword'})
    assert r.status_code == 200
    assert r.get_json()['user']['is_admin'] is False


def _directory_row(path, username):
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    row = conn.execute('SELECT * FROM users WHERE username = ?', (username,)).fetchone()
    conn.close()
    return dict(row) if row else None


def test_signing_in_leaves_the_directory_alone(client, shared_accounts):
    before = open(shared_accounts['moclo'], 'rb').read()
    client.post('/api/auth/login', json={'username': 'alice', 'password': 'alicepassword'})
    client.post('/api/sequences', json={'document': model.make_document('p', 'ACGT' * 50, True)})
    assert open(shared_accounts['moclo'], 'rb').read() == before,         'signing in with a directory account must not modify the MoClo database'


def test_registering_here_creates_the_account_for_every_tool(client, shared_accounts):
    assert client.get('/api/auth/session').get_json()['registration_open'] is True
    r = client.post('/api/auth/register', json={'username': 'carol', 'password': 'password123',
                                                'lab_source': 'Gardiner Lab'})
    assert r.status_code == 201, r.get_json()
    user = r.get_json()['user']
    assert user['is_admin'] is False
    assert user['lab_source'] == 'Gardiner Lab'

    row = _directory_row(shared_accounts['moclo'], 'carol')
    assert row is not None, 'the account must exist in the MoClo directory'
    assert row['id'] == user['id']
    assert row['is_admin'] == 0
    assert bcrypt.checkpw(b'password123', row['password_hash'].encode())

    client.post('/api/auth/logout')
    assert client.post('/api/auth/login',
                       json={'username': 'carol', 'password': 'password123'}).status_code == 200


def test_a_username_taken_in_the_directory_cannot_be_registered(client, shared_accounts):
    r = client.post('/api/auth/register', json={'username': 'alice', 'password': 'password123'})
    assert r.status_code == 400
    assert 'taken' in r.get_json()['error']
    # Alice's own password is untouched.
    assert client.post('/api/auth/login',
                       json={'username': 'alice', 'password': 'alicepassword'}).status_code == 200


def test_registration_still_validates(client, shared_accounts):
    assert client.post('/api/auth/register',
                       json={'username': 'x', 'password': 'password123'}).status_code == 400
    assert client.post('/api/auth/register',
                       json={'username': 'erin', 'password': 'short'}).status_code == 400
    assert _directory_row(shared_accounts['moclo'], 'erin') is None


def test_the_first_account_in_an_empty_directory_is_the_admin(client, tmp_dbs):
    _moclo_users_db(tmp_dbs['moclo'], [])
    r = client.post('/api/auth/register', json={'username': 'first', 'password': 'password123'})
    assert r.status_code == 201
    assert r.get_json()['user']['is_admin'] is True
    assert _directory_row(tmp_dbs['moclo'], 'first')['is_admin'] == 1


def test_local_accounts_are_copied_into_the_directory(client, tmp_dbs):
    """An account made before accounts were shared starts working everywhere."""
    client.post('/api/auth/register', json={'username': 'erin', 'password': 'erinpassword'})
    erin_id = client.get('/api/auth/session').get_json()['user']['id']
    client.post('/api/auth/logout')
    assert not os.path.exists(tmp_dbs['moclo'])

    _moclo_users_db(tmp_dbs['moclo'], [('moclo-1', 'alice', 'alicepassword', 1)])
    assert client.post('/api/auth/login',
                       json={'username': 'erin', 'password': 'erinpassword'}).status_code == 200

    row = _directory_row(tmp_dbs['moclo'], 'erin')
    assert row is not None
    assert row['id'] == erin_id, 'the same id, so nothing she owns changes hands'
    assert bcrypt.checkpw(b'erinpassword', row['password_hash'].encode())
    assert row['is_admin'] == 1, 'she was the first account here, so she stays an admin'


def test_copying_skips_names_the_directory_already_has(tmp_dbs):
    from app.models.user import User, share_local_accounts
    User.create('alice', 'localpassword')
    User.create('frank', 'frankpassword')
    _moclo_users_db(tmp_dbs['moclo'], [('moclo-1', 'alice', 'alicepassword', 0)])

    assert share_local_accounts() == 1
    assert bcrypt.checkpw(b'alicepassword',
                          _directory_row(tmp_dbs['moclo'], 'alice')['password_hash'].encode())
    assert _directory_row(tmp_dbs['moclo'], 'frank') is not None
    assert share_local_accounts() == 0, 'running it again changes nothing'


def test_an_existing_moclo_instance_brings_its_accounts(tmp_dbs):
    """Starting the editor next to a MoClo instance makes its people users here."""
    from app.main import create_app
    from app.models.user import User
    User.create('henry', 'henrypassword')
    _moclo_users_db(tmp_dbs['moclo'], [
        ('moclo-1', 'alice', 'alicepassword', 1),
        ('moclo-2', 'bob', 'bobpassword', 0),
    ])

    create_app()

    alice = User.get_by_username('alice')
    assert alice is not None and alice.id == 'moclo-1' and alice.is_admin
    assert alice.check_password('alicepassword')
    assert User.get_by_username('bob').is_admin is False
    assert _directory_row(tmp_dbs['moclo'], 'henry') is not None, 'and the other way round'
    assert sorted(u.username for u in User.get_all()) == ['alice', 'bob', 'henry']


def test_importing_twice_adds_nobody_new(tmp_dbs):
    from app.models.user import User, import_directory_accounts
    _moclo_users_db(tmp_dbs['moclo'], [('moclo-2', 'bob', 'bobpassword', 0)])
    assert import_directory_accounts() == 1
    assert import_directory_accounts() == 0
    assert User.count() == 1


def test_an_older_directory_without_admin_flags_still_works(client, tmp_dbs):
    conn = sqlite3.connect(tmp_dbs['moclo'])
    conn.execute('CREATE TABLE users (id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL, '
                 'password_hash TEXT NOT NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)')
    conn.commit()
    conn.close()
    r = client.post('/api/auth/register', json={'username': 'gina', 'password': 'password123'})
    assert r.status_code == 201, r.get_json()
    client.post('/api/auth/logout')
    assert client.post('/api/auth/login',
                       json={'username': 'gina', 'password': 'password123'}).status_code == 200


def test_work_survives_a_password_change_in_moclo(client, shared_accounts):
    """The local row tracks the directory without losing what it owns."""
    client.post('/api/auth/login', json={'username': 'alice', 'password': 'alicepassword'})
    saved = client.post('/api/sequences',
                        json={'document': model.make_document('mine', 'ACGT' * 60, True)})
    assert saved.status_code == 201
    sequence_id = saved.get_json()['sequence']['id']
    client.post('/api/auth/logout')

    # Alice changes her password in the MoClo tool.
    conn = sqlite3.connect(shared_accounts['moclo'])
    conn.execute('UPDATE users SET password_hash = ? WHERE username = ?',
                 (bcrypt.hashpw(b'newpassword', bcrypt.gensalt()).decode(), 'alice'))
    conn.commit()
    conn.close()

    assert client.post('/api/auth/login',
                       json={'username': 'alice', 'password': 'alicepassword'}).status_code == 401
    assert client.post('/api/auth/login',
                       json={'username': 'alice', 'password': 'newpassword'}).status_code == 200
    # Her sequence is still hers.
    assert client.get(f'/api/sequences/{sequence_id}').get_json()['sequence']['name'] == 'mine'


def test_a_local_account_keeps_what_it_owns_when_the_directory_appears(client, tmp_dbs):
    """
    Someone who registered here before accounts were shared must not lose their
    work when a directory account with the same name starts being used.
    """
    client.post('/api/auth/register', json={'username': 'dave', 'password': 'localpassword'})
    saved = client.post('/api/sequences',
                        json={'document': model.make_document('daves', 'ACGT' * 70, True)})
    sequence_id = saved.get_json()['sequence']['id']
    client.post('/api/auth/logout')

    # The shared directory now has a dave, with a different id and password.
    _moclo_users_db(tmp_dbs['moclo'], [('moclo-9', 'dave', 'directorypassword', 0)])

    assert client.post('/api/auth/login',
                       json={'username': 'dave', 'password': 'localpassword'}).status_code == 401, \
        'the directory is authoritative once it knows the username'
    assert client.post('/api/auth/login',
                       json={'username': 'dave', 'password': 'directorypassword'}).status_code == 200
    assert client.get(f'/api/sequences/{sequence_id}').get_json()['sequence']['name'] == 'daves'


def test_local_accounts_still_work_without_a_directory(client, tmp_dbs):
    """With no MoClo database mounted, this app manages its own accounts."""
    r = client.post('/api/auth/register', json={'username': 'solo', 'password': 'password123'})
    assert r.status_code == 201
    assert client.get('/api/auth/session').get_json()['shared_accounts'] is False
    client.post('/api/auth/logout')
    assert client.post('/api/auth/login',
                       json={'username': 'solo', 'password': 'password123'}).status_code == 200


def test_an_unknown_username_is_refused(client, shared_accounts):
    assert client.post('/api/auth/login',
                       json={'username': 'nobody', 'password': 'whatever'}).status_code == 401
