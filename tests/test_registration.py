"""
Labs, their registration codes, and the lab lead role.

Every lab has its own code. Joining means choosing your lab and giving that
lab's code. Only an administrator creates labs, sets codes and changes roles.
A lab lead acts as an administrator for their own lab's members and plasmids,
and can see (not change) their lab's code.
"""

import pytest

ADMIN = {'username': 'boss', 'password': 'password123', 'lab_source': 'Gardiner Lab'}


@pytest.fixture()
def suite(tmp_dbs, monkeypatch):
    """An installation with an administrator, where codes are enforced."""
    monkeypatch.setenv('REQUIRE_REGISTRATION_CODE', 'true')
    monkeypatch.delenv('DEFAULT_LAB_SOURCE', raising=False)
    from app.main import create_app
    app = create_app()
    app.config.update(TESTING=True, SECRET_KEY='t')
    admin = app.test_client()
    r = admin.post('/api/auth/register', json=ADMIN)
    assert r.status_code == 201, r.get_json()
    assert r.get_json()['user']['role'] == 'admin', 'the first account needs no code and is the admin'
    return app, admin


def _labs(admin):
    return {lab['name']: lab for lab in admin.get('/api/admin/overview').get_json()['labs']}


def _lab_with_code(admin, name, code):
    lab = _labs(admin).get(name)
    if lab is None:
        r = admin.post('/api/admin/labs', json={'name': name})
        assert r.status_code == 201, r.get_json()
        lab = r.get_json()['lab']
    r = admin.put(f"/api/admin/labs/{lab['id']}/code", json={'code': code})
    assert r.status_code == 200, r.get_json()
    return r.get_json()['lab']


def _join(app, lab, code, username='newbie'):
    client = app.test_client()
    r = client.post('/api/auth/register', json={'username': username, 'password': 'password123',
                                                'lab_source': lab, 'registration_code': code})
    return r, client


# ---------------------------------------------------------------------------
# Labs and their codes
# ---------------------------------------------------------------------------

def test_the_first_accounts_lab_becomes_a_lab_without_a_code(suite):
    _, admin = suite
    lab = _labs(admin)['Gardiner Lab']
    assert lab['code'] is None and lab['members'] == 1


def test_nobody_joins_a_lab_without_a_code(suite):
    app, _ = suite
    r, _ = _join(app, 'Gardiner Lab', 'anything')
    assert r.status_code == 403
    assert 'not taking new members' in r.get_json()['error']


def test_each_lab_has_its_own_code(suite):
    app, admin = suite
    _lab_with_code(admin, 'Gardiner Lab', 'gardiner-code')
    _lab_with_code(admin, 'Smith Lab', 'smith-code')
    # A code only opens the lab it belongs to.
    assert _join(app, 'Smith Lab', 'gardiner-code', 'eve')[0].status_code == 403
    r, _ = _join(app, 'Smith Lab', '  SMITH-code ', 'alice')   # case and spaces do not count
    assert r.status_code == 201, r.get_json()
    assert r.get_json()['user']['lab_source'] == 'Smith Lab'
    assert r.get_json()['user']['role'] == 'member'


def test_codes_must_be_unique_across_labs(suite):
    _, admin = suite
    _lab_with_code(admin, 'Gardiner Lab', 'shared-code')
    smith = admin.post('/api/admin/labs', json={'name': 'Smith Lab'}).get_json()['lab']
    r = admin.put(f"/api/admin/labs/{smith['id']}/code", json={'code': 'Shared-Code'})
    assert r.status_code == 400
    assert 'Another lab' in r.get_json()['error']


def test_an_unknown_lab_is_refused(suite):
    app, admin = suite
    _lab_with_code(admin, 'Gardiner Lab', 'gardiner-code')
    r, _ = _join(app, 'Made Up Lab', 'gardiner-code')
    assert r.status_code == 400


def test_changing_a_code_retires_the_old_one(suite):
    app, admin = suite
    _lab_with_code(admin, 'Gardiner Lab', 'first-code')
    lab = _lab_with_code(admin, 'Gardiner Lab', 'second-code')
    assert lab['code_updated_by'] == 'boss'
    assert _join(app, 'Gardiner Lab', 'first-code', 'amy')[0].status_code == 403
    assert _join(app, 'Gardiner Lab', 'second-code', 'ann')[0].status_code == 201


def test_the_public_lab_list_never_shows_codes(suite):
    app, admin = suite
    _lab_with_code(admin, 'Gardiner Lab', 'secret-code')
    admin.post('/api/admin/labs', json={'name': 'Closed Lab'})
    labs = app.test_client().get('/api/auth/labs').get_json()['labs']
    assert {l['name']: l['open'] for l in labs} == {'Closed Lab': False, 'Gardiner Lab': True}
    assert 'secret-code' not in str(labs)


def test_renaming_a_lab_moves_its_members(suite):
    app, admin = suite
    lab = _lab_with_code(admin, 'Gardiner Lab', 'gardiner-code')
    _join(app, 'Gardiner Lab', 'gardiner-code', 'alice')
    assert admin.patch(f"/api/admin/labs/{lab['id']}", json={'name': 'Gardiner Group'}).status_code == 200
    users = {u['username']: u for u in admin.get('/api/admin/overview').get_json()['users']}
    assert users['alice']['lab'] == 'Gardiner Group'


def test_a_lab_with_members_cannot_be_removed(suite):
    _, admin = suite
    labs = _labs(admin)
    assert admin.delete(f"/api/admin/labs/{labs['Gardiner Lab']['id']}").status_code == 400
    empty = admin.post('/api/admin/labs', json={'name': 'Empty Lab'}).get_json()['lab']
    assert admin.delete(f"/api/admin/labs/{empty['id']}").status_code == 200


def test_the_installer_code_goes_to_the_default_lab(tmp_dbs, monkeypatch):
    monkeypatch.setenv('REQUIRE_REGISTRATION_CODE', 'true')
    monkeypatch.setenv('DEFAULT_LAB_SOURCE', 'Gardiner Lab')
    monkeypatch.setenv('REGISTRATION_CODE', 'from-the-installer')
    from app.main import create_app
    app = create_app()
    app.config.update(TESTING=True, SECRET_KEY='t')
    app.test_client().post('/api/auth/register', json=ADMIN)
    assert _join(app, 'Gardiner Lab', 'from-the-installer')[0].status_code == 201
    # It only seeds the code: one an administrator sets afterwards wins.
    from app.models.lab import Lab
    from app.services import registration
    registration.set_code(Lab.by_name('Gardiner Lab'), 'changed-later', 'boss')
    registration.prepare_labs()
    assert Lab.by_name('Gardiner Lab').registration_code == 'changed-later'


# ---------------------------------------------------------------------------
# Lab leads
# ---------------------------------------------------------------------------

@pytest.fixture()
def lab_with_lead(suite):
    """Gardiner Lab with a lead (lena) and a member (max); Smith Lab with a member (sam)."""
    app, admin = suite
    _lab_with_code(admin, 'Gardiner Lab', 'gardiner-code')
    _lab_with_code(admin, 'Smith Lab', 'smith-code')
    _, lead = _join(app, 'Gardiner Lab', 'gardiner-code', 'lena')
    _, member = _join(app, 'Gardiner Lab', 'gardiner-code', 'max')
    _, other = _join(app, 'Smith Lab', 'smith-code', 'sam')
    assert admin.put('/api/admin/users/lena/role', json={'role': 'lab_lead'}).status_code == 200
    return app, admin, lead, member, other


def _private_sequence(client, name):
    r = client.post('/api/sequences', json={'shared': False, 'document': {
        'name': name, 'sequence': 'ATGC' * 20, 'circular': True, 'features': []}})
    assert r.status_code == 201, r.get_json()
    return r.get_json()['sequence']['id']


def test_a_lab_lead_sees_their_lab_and_its_code(lab_with_lead):
    _, _, lead, _, _ = lab_with_lead
    view = lead.get('/api/admin/overview').get_json()
    assert view['me']['role'] == 'lab_lead'
    assert view['can_manage_labs'] is False
    assert [l['name'] for l in view['labs']] == ['Gardiner Lab']
    assert view['labs'][0]['code'] == 'gardiner-code', 'to hand out to new members'
    assert {u['username'] for u in view['users']} == {'boss', 'lena', 'max'}
    assert lead.get('/admin').status_code == 200


def test_a_lab_lead_cannot_change_codes_labs_or_roles(lab_with_lead):
    _, admin, lead, _, _ = lab_with_lead
    labs = _labs(admin)
    gardiner = labs['Gardiner Lab']['id']
    for method, path, body in [
        ('put', f'/api/admin/labs/{gardiner}/code', {'code': 'lead-chose-this'}),
        ('put', f'/api/admin/labs/{gardiner}/code', {'code': None}),
        ('post', '/api/admin/labs', {'name': 'Lead Lab'}),
        ('patch', f'/api/admin/labs/{gardiner}', {'name': 'Renamed'}),
        ('delete', f"/api/admin/labs/{labs['Smith Lab']['id']}", None),
        ('get', '/api/admin/codes/suggest', None),
        ('put', '/api/admin/users/max/role', {'role': 'lab_lead'}),
        ('put', '/api/admin/users/lena/role', {'role': 'admin'}),
        ('put', '/api/admin/users/max/lab', {'lab_id': labs['Smith Lab']['id']}),
    ]:
        r = getattr(lead, method)(path, json=body) if body is not None else getattr(lead, method)(path)
        assert r.status_code == 403, f'{method.upper()} {path} answered {r.status_code}'
    assert _labs(admin)['Gardiner Lab']['code'] == 'gardiner-code', 'nothing changed'


def test_a_lab_lead_manages_their_own_labs_plasmids_only(lab_with_lead):
    _, _, lead, member, other = lab_with_lead
    mine = _private_sequence(member, 'max plasmid')
    theirs = _private_sequence(other, 'sam plasmid')
    # The lead may open and change a private plasmid of their lab's member...
    assert lead.get(f'/api/sequences/{mine}').status_code == 200
    assert lead.patch(f'/api/sequences/{mine}', json={'name': 'renamed by lead'}).status_code == 200
    # ...but not another lab's.
    assert lead.get(f'/api/sequences/{theirs}').status_code == 403
    assert lead.patch(f'/api/sequences/{theirs}', json={'name': 'nope'}).status_code == 403


def test_members_get_no_admin_page(lab_with_lead):
    _, _, _, member, _ = lab_with_lead
    assert member.get('/api/admin/overview').status_code == 403
    assert member.get('/admin').status_code == 302


def test_an_admin_can_promote_and_demote(lab_with_lead):
    _, admin, lead, _, _ = lab_with_lead
    assert admin.put('/api/admin/users/lena/role', json={'role': 'member'}).status_code == 200
    assert lead.get('/api/admin/overview').status_code == 403, 'takes effect at once'
    assert admin.put('/api/admin/users/max/role', json={'role': 'admin'}).status_code == 200
    users = {u['username']: u for u in admin.get('/api/admin/overview').get_json()['users']}
    assert users['max']['role'] == 'admin' and users['lena']['role'] == 'member'


def test_the_last_administrator_cannot_be_removed(suite):
    _, admin = suite
    r = admin.put('/api/admin/users/boss/role', json={'role': 'member'})
    assert r.status_code == 400


def test_administrator_status_is_shared_with_moclo(tmp_dbs, monkeypatch):
    """Making someone an administrator here makes them one in every tool."""
    import sqlite3
    from tests.test_shared_accounts import _moclo_users_db
    _moclo_users_db(tmp_dbs['moclo'], [])
    monkeypatch.setenv('REQUIRE_REGISTRATION_CODE', 'true')
    from app.main import create_app
    app = create_app()
    app.config.update(TESTING=True, SECRET_KEY='t')
    admin = app.test_client()
    admin.post('/api/auth/register', json=ADMIN)
    _lab_with_code(admin, 'Gardiner Lab', 'gardiner-code')
    _join(app, 'Gardiner Lab', 'gardiner-code', 'max')
    assert admin.put('/api/admin/users/max/role', json={'role': 'admin'}).status_code == 200
    conn = sqlite3.connect(tmp_dbs['moclo'])
    flags = dict(conn.execute('SELECT username, is_admin FROM users'))
    conn.close()
    assert flags == {'boss': 1, 'max': 1}
    # And a lab lead is this editor's own role: MoClo sees an ordinary account.
    assert admin.put('/api/admin/users/max/role', json={'role': 'lab_lead'}).status_code == 200
    conn = sqlite3.connect(tmp_dbs['moclo'])
    assert conn.execute("SELECT is_admin FROM users WHERE username = 'max'").fetchone()[0] == 0
    conn.close()
