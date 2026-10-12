import os
import random
import tempfile

import pytest

os.environ['EDITOR_SKIP_SEED'] = '1'


@pytest.fixture()
def tmp_dbs(monkeypatch):
    """Isolated editor and MoClo databases for one test."""
    d = tempfile.mkdtemp()
    editor = os.path.join(d, 'editor.db')
    parts = os.path.join(d, 'parts.db')
    moclo = os.path.join(d, 'moclo.db')
    monkeypatch.setenv('EDITOR_DATABASE_PATH', editor)
    monkeypatch.setenv('PARTS_DATABASE_PATH', parts)
    monkeypatch.setenv('MOCLO_DATABASE_PATH', moclo)
    # Most tests register several people; the code itself is tested on its own.
    monkeypatch.setenv('REQUIRE_REGISTRATION_CODE', 'false')
    monkeypatch.setenv('DEFAULT_LAB_SOURCE', 'Test Lab')
    from app.models import database
    database.set_db_path(editor)
    database.initialize_database(editor)
    yield {'dir': d, 'editor': editor, 'parts': parts, 'moclo': moclo}


@pytest.fixture()
def moclo_parts_db(tmp_dbs):
    """A parts database with the MoClo Library Tool's real schema."""
    import sqlite3
    conn = sqlite3.connect(tmp_dbs['parts'])
    conn.executescript("""
        CREATE TABLE parts (
            id TEXT PRIMARY KEY, name TEXT NOT NULL, part_type TEXT NOT NULL,
            sequence TEXT NOT NULL, overhang_5prime TEXT NOT NULL, overhang_3prime TEXT NOT NULL,
            lab_source TEXT NOT NULL, contributor TEXT NOT NULL,
            upload_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP, description TEXT,
            plasmid_id TEXT, location_80 TEXT, location_96_plate TEXT, antibiotic TEXT,
            level TEXT, unit TEXT, donor_organism TEXT, reference TEXT, size INTEGER,
            host_strain TEXT, sequenced TEXT, comments TEXT, ori_ecoli TEXT, ori_agro TEXT,
            primer_for_seq TEXT, features TEXT
        );
    """)
    conn.commit()
    conn.close()
    return tmp_dbs


@pytest.fixture()
def app(tmp_dbs):
    from app.main import create_app
    application = create_app()
    application.config.update(TESTING=True, SECRET_KEY='test-secret')
    return application


@pytest.fixture()
def client(app):
    return app.test_client()


@pytest.fixture()
def user_client(client):
    """A client logged in as a registered user with a lab source."""
    r = client.post('/api/auth/register', json={'username': 'tester', 'password': 'password123',
                                                'lab_source': 'Gardiner Lab'})
    assert r.status_code == 201, r.get_json()
    return client


@pytest.fixture()
def rand_dna():
    rng = random.Random(7)

    def make(n, avoid=('GAATTC', 'GGTCTC', 'GAGACC', 'GGATCC', 'CGTCTC', 'GAGACG')):
        while True:
            s = ''.join(rng.choice('ACGT') for _ in range(n))
            if not any(a in s for a in avoid):
                return s
    return make
