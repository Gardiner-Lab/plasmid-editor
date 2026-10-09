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
"""


def initialize_database(path: Optional[str] = None) -> None:
    if path:
        set_db_path(path)
    with get_connection() as conn:
        conn.executescript(SCHEMA)
