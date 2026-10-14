"""The editor's open tabs: kept for one sign-in, gone after signing out."""

import json


def workspace(client):
    return client.get('/api/workspace').get_json()['workspace']


def test_open_tabs_come_back_until_signing_out(client, user_client):
    assert workspace(user_client) is None
    tabs = {'docs': [{'name': 'pA', 'sequence': 'ACGT' * 10, 'circular': True, 'features': [], 'dirty': True},
                     {'id': 'saved-1', 'name': 'pB', 'sequence': 'GGCC', 'features': []}],
            'active': 1}
    assert user_client.put('/api/workspace', json=tabs).status_code == 200
    got = workspace(user_client)
    assert [d['name'] for d in got['docs']] == ['pA', 'pB'] and got['active'] == 1
    assert got['docs'][0]['dirty'] is True             # unsaved edits come back unsaved

    # As the page closes, the browser sends it with a plain POST.
    tabs['active'] = 0
    assert user_client.post('/api/workspace', data=json.dumps(tabs), content_type='text/plain').status_code == 200
    assert workspace(user_client)['active'] == 0

    # Signing out ends them; signing in again starts with nothing open.
    user_client.post('/api/auth/logout')
    user_client.post('/api/auth/login', json={'username': 'tester', 'password': 'password123'})
    assert workspace(user_client) is None


def test_nobody_else_sees_them(app, user_client):
    user_client.put('/api/workspace', json={'docs': [{'name': 'mine', 'sequence': 'ACGT'}], 'active': 0})
    other = app.test_client()
    other.post('/api/auth/register', json={'username': 'other', 'password': 'password123', 'lab_source': 'Gardiner Lab'})
    assert workspace(other) is None


def test_limits(user_client):
    assert user_client.get('/api/workspace').status_code == 200
    assert user_client.put('/api/workspace', json={'docs': 'nope'}).status_code == 400
    assert user_client.put('/api/workspace', json={'docs': [{'name': 'no bases'}]}).status_code == 400
    many = {'docs': [{'name': str(i), 'sequence': 'A'} for i in range(31)], 'active': 0}
    assert user_client.put('/api/workspace', json=many).status_code == 400
    # An active tab past the end is brought back in range.
    user_client.put('/api/workspace', json={'docs': [{'name': 'one', 'sequence': 'A'}], 'active': 9})
    assert workspace(user_client)['active'] == 0


def test_signed_out_is_refused(client):
    assert client.get('/api/workspace').status_code == 401
