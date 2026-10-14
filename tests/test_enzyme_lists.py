"""Each person's own enzyme lists: saved to their account, kept from everyone else."""


def test_the_catalogue_offers_every_enzyme(user_client):
    body = user_client.get('/api/tools/enzymes?catalog=1').get_json()
    names = {e['name']: e for e in body['catalog']}
    assert len(names) > 500
    assert names['EcoRI']['site'] == 'GAATTC' and names['EcoRI']['commercial']
    assert names['EcoRV']['ends'] == 'blunt'
    assert body['lists'] == [] and 'Default' in body['sets']
    assert 'catalog' not in user_client.get('/api/tools/enzymes').get_json()


def test_making_editing_and_removing_a_list(user_client):
    r = user_client.post('/api/tools/enzyme-lists', json={'name': '  My  cloning ', 'enzymes': ['EcoRI', 'BamHI', 'EcoRI', 'BsaI']})
    assert r.status_code == 201
    made = r.get_json()['list']
    assert made['name'] == 'My cloning' and made['enzymes'] == ['BamHI', 'BsaI', 'EcoRI']
    assert user_client.get('/api/tools/enzymes').get_json()['lists'][0]['id'] == made['id']

    r = user_client.put(f"/api/tools/enzyme-lists/{made['id']}", json={'enzymes': ['NotI', 'XhoI']})
    assert r.get_json()['list']['enzymes'] == ['NotI', 'XhoI'] and r.get_json()['list']['name'] == 'My cloning'
    r = user_client.put(f"/api/tools/enzyme-lists/{made['id']}", json={'name': 'Rare cutters'})
    assert r.get_json()['list']['name'] == 'Rare cutters'

    # The list is what the sites are found with.
    seq = 'A' * 50 + 'GCGGCCGC' + 'A' * 50 + 'CTCGAG' + 'A' * 50
    sites = user_client.post('/api/tools/sites', json={'document': {'sequence': seq}, 'enzymes': ['NotI', 'XhoI']}).get_json()
    assert sites['counts'] == {'NotI': 1, 'XhoI': 1}

    assert user_client.delete(f"/api/tools/enzyme-lists/{made['id']}").status_code == 200
    assert user_client.get('/api/tools/enzymes').get_json()['lists'] == []


def test_bad_lists_are_refused(user_client):
    assert user_client.post('/api/tools/enzyme-lists', json={'name': 'x', 'enzymes': ['EcoRI', 'Nonsense1']}).status_code == 400
    assert user_client.post('/api/tools/enzyme-lists', json={'name': 'x', 'enzymes': []}).status_code == 400
    assert user_client.post('/api/tools/enzyme-lists', json={'name': '   ', 'enzymes': ['EcoRI']}).status_code == 400
    user_client.post('/api/tools/enzyme-lists', json={'name': 'Mine', 'enzymes': ['EcoRI']})
    r = user_client.post('/api/tools/enzyme-lists', json={'name': 'mine', 'enzymes': ['BamHI']})
    assert r.status_code == 400 and 'already' in r.get_json()['error']


def test_lists_and_the_choice_belong_to_their_owner(client, user_client):
    made = user_client.post('/api/tools/enzyme-lists', json={'name': 'Mine', 'enzymes': ['EcoRI']}).get_json()['list']
    assert user_client.put('/api/tools/enzyme-choice', json={'choice': f"list:{made['id']}"}).status_code == 200
    assert user_client.get('/api/tools/enzymes').get_json()['choice'] == f"list:{made['id']}"

    # Someone else sees none of it and can change none of it.
    user_client.post('/api/auth/logout')
    client.post('/api/auth/register', json={'username': 'other', 'password': 'password123', 'lab_source': 'Gardiner Lab'})
    body = client.get('/api/tools/enzymes').get_json()
    assert body['lists'] == [] and body['choice'] is None
    assert client.put(f"/api/tools/enzyme-lists/{made['id']}", json={'name': 'Taken'}).status_code == 404
    assert client.delete(f"/api/tools/enzyme-lists/{made['id']}").status_code == 404


def test_removing_the_list_in_use_goes_back_to_the_default(user_client):
    made = user_client.post('/api/tools/enzyme-lists', json={'name': 'Mine', 'enzymes': ['EcoRI']}).get_json()['list']
    user_client.put('/api/tools/enzyme-choice', json={'choice': f"list:{made['id']}"})
    user_client.delete(f"/api/tools/enzyme-lists/{made['id']}")
    assert user_client.get('/api/tools/enzymes').get_json()['choice'] == 'Default'
