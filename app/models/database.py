"""
SQLite storage for the Plasmid Editor: users, sequences, sequencing reads.

This database belongs to the editor. The MoClo Library Tool's own databases
are reached through app.services.moclo_bridge and are never modified here,
apart from contributing new parts.
"""

import os
import sqlite3
from contextlib import contextmanager
from typing import Optional

_db_path: Optional[str] = None


def db_path() -> str:
    return _db_path or os.environ.get('EDITOR_DATABASE_PATH', '/data/plasmid_editor.db')


def set_db_path(path: str) -> None:
    global _db_path
    _db_path = path


@contextmanager
def get_connection():
    path = db_path()
    directory = os.path.dirname(path)
    if directory and not os.path.exists(directory):
        os.makedirs(directory, exist_ok=True)
    conn = sqlite3.connect(path, timeout=10)
    conn.row_factory = sqlite3.Row
    conn.execute('PRAGMA foreign_keys = ON')
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    lab_source TEXT,
    is_admin INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- The labs using these tools. Each has its own registration code, which new
-- members give to join that lab; only an administrator sets or changes it.
CREATE TABLE IF NOT EXISTS labs (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE,
    registration_code TEXT,
    code_updated_by TEXT,
    code_updated_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Lab-wide settings an administrator changes from the Admin page.
CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT,
    updated_by TEXT,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS sequences (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    sequence TEXT NOT NULL,
    circular INTEGER NOT NULL DEFAULT 1,
    description TEXT,
    features TEXT,
    -- user-set flag: this plasmid is Golden Gate / MoClo compatible and may be
    -- contributed to the shared MoClo parts library
    golden_gate INTEGER NOT NULL DEFAULT 0,
    golden_gate_enzyme TEXT,
    moclo_part_id TEXT,
    -- Link to a record in the MoClo tool, as "<kind>:<id>" (part, backbone or
    -- plasmid). A linked sequence is written back to MoClo when it is saved.
    moclo_link TEXT,
    -- Content hash of the MoClo record as it was at the last successful sync,
    -- used to detect changes made in MoClo since then.
    moclo_synced_hash TEXT,
    moclo_synced_at TIMESTAMP,
    owner_id TEXT NOT NULL,
    shared INTEGER NOT NULL DEFAULT 1,
    origin TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_sequences_owner ON sequences(owner_id);
CREATE INDEX IF NOT EXISTS idx_sequences_gg ON sequences(golden_gate);

CREATE TABLE IF NOT EXISTS reads (
    id TEXT PRIMARY KEY,
    sequence_id TEXT NOT NULL,
    name TEXT NOT NULL,
    bases TEXT NOT NULL,
    quality TEXT,
    trace TEXT,
    alignment TEXT,
    uploaded_by TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (sequence_id) REFERENCES sequences(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_reads_sequence ON reads(sequence_id);

CREATE TABLE IF NOT EXISTS feature_library (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    sequence TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'misc_feature',
    color TEXT,
    owner_id TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_library_name_seq ON feature_library(name, sequence);

-- Each person's own lists of restriction enzymes to show (app/models/enzyme_list.py).
CREATE TABLE IF NOT EXISTS enzyme_lists (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL,
    name TEXT NOT NULL,
    enzymes TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_enzyme_lists_owner ON enzyme_lists(owner_id);
"""


# Columns added after the first release. Applied to existing databases on
# start-up so an upgrade needs no manual migration step.
_ADDED_COLUMNS = {
    'users': [
        # 'lab_lead' for a lab lead; NULL for everyone else. Administrators are
        # marked by is_admin, which follows the shared account directory.
        ('role', 'TEXT'),
        # The enzyme list last shown in the editor: a built-in set's name, or
        # "list:<id>" for one of the person's own (enzyme_lists).
        ('enzyme_choice', 'TEXT'),
    ],
    'sequences': [
        ('moclo_link', 'TEXT'),
        ('moclo_synced_hash', 'TEXT'),
        ('moclo_synced_at', 'TIMESTAMP'),
        # Sequencing verification: set when a user judges an alignment good
        # enough, which marks the plasmid as confirmed and sequenced.
        ('confirmed_at', 'TIMESTAMP'),
        ('confirmed_by', 'TEXT'),
        ('confirmed_clone', 'TEXT'),
        ('glycerol_stock', 'TEXT'),
        # Translations of stretches of the sequence, kept apart from features:
        # JSON, as features are.
        ('translations', 'TEXT'),
    ],
    'reads': [
        # Which colony/clone this read came from, e.g. "3" or "A7".
        ('clone_number', 'TEXT'),
        # The user's judgement of the alignment: sufficient | insufficient.
        ('verdict', 'TEXT'),
        ('verdict_note', 'TEXT'),
        ('verdict_by', 'TEXT'),
        ('verdict_at', 'TIMESTAMP'),
    ],
}


def initialize_database(path: Optional[str] = None) -> None:
    if path:
        set_db_path(path)
    with get_connection() as conn:
        conn.executescript(SCHEMA)
        for table, columns in _ADDED_COLUMNS.items():
            existing = {r['name'] for r in conn.execute(f'PRAGMA table_info({table})')}
            for name, decl in columns:
                if name not in existing:
                    conn.execute(f'ALTER TABLE {table} ADD COLUMN {name} {decl}')
        conn.execute('CREATE INDEX IF NOT EXISTS idx_sequences_moclo ON sequences(moclo_link)')
