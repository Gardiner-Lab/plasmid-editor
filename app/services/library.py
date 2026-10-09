"""
Feature libraries: a built-in common-element set, the user-extendable library
in the editor's own database, and import/export of ApE-format library files.
"""

import os
import uuid
from typing import Any, Dict, List, Optional

from app.models.database import get_connection
from dnakit import features

_BUILTIN_PATH = os.path.join(os.path.dirname(os.path.dirname(__file__)), 'data', 'features_common.txt')
_cache: Optional[List[Dict[str, Any]]] = None


def builtin_library() -> List[Dict[str, Any]]:
    global _cache
    if _cache is None:
        try:
            with open(_BUILTIN_PATH, encoding='utf-8') as fh:
                _cache = features.parse_library(fh.read())
        except OSError:
            _cache = []
    return _cache


def stored_library(owner_id: Optional[str] = None) -> List[Dict[str, Any]]:
    sql = 'SELECT id, name, sequence, type, color FROM feature_library'
    args: List[Any] = []
    if owner_id:
        sql += ' WHERE owner_id IS NULL OR owner_id = ?'
        args.append(owner_id)
    sql += ' ORDER BY name'
    with get_connection() as conn:
        return [dict(r) for r in conn.execute(sql, args)]


def default_library(owner_id: Optional[str] = None) -> List[Dict[str, Any]]:
    """The built-in set plus anything the lab has added."""
    combined = {(e['name'], e['sequence']): e for e in builtin_library()}
    for e in stored_library(owner_id):
        combined[(e['name'], e['sequence'])] = e
    return list(combined.values())


def add_entries(entries: List[Dict[str, Any]], owner_id: Optional[str] = None) -> int:
    added = 0
    with get_connection() as conn:
        for e in entries:
            seq = (e.get('sequence') or '').upper()
            name = (e.get('name') or '').strip()
            if not name or len(seq) < 6:
                continue
            cur = conn.execute(
                'INSERT OR IGNORE INTO feature_library (id, name, sequence, type, color, owner_id) '
                'VALUES (?, ?, ?, ?, ?, ?)',
                (str(uuid.uuid4()), name, seq, e.get('type') or 'misc_feature',
                 e.get('color') or features.color_for(e.get('type', '')), owner_id))
            added += cur.rowcount
    return added


def delete_entry(entry_id: str) -> bool:
    with get_connection() as conn:
        return conn.execute('DELETE FROM feature_library WHERE id = ?', (entry_id,)).rowcount > 0
