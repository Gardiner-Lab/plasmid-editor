"""Each person's own lists of restriction enzymes, and which list they last showed."""

import json
import uuid
from typing import Any, Dict, List, Optional

from app.models.database import get_connection
from dnakit import restriction

MAX_NAME_LENGTH = 60
MAX_LISTS = 50


def _clean_name(name: str) -> str:
    name = ' '.join((name or '').split())
    if not name:
        raise ValueError('Give the list a name')
    if len(name) > MAX_NAME_LENGTH:
        raise ValueError(f'A list name must be at most {MAX_NAME_LENGTH} characters')
    return name


def clean_enzymes(names) -> List[str]:
    """Known enzyme names, each once, in alphabetical order; ValueError naming any unknown."""
    if not isinstance(names, list) or not names:
        raise ValueError('Choose at least one enzyme')
    known = restriction.enzyme_names()
    wanted = {str(n).strip() for n in names if str(n).strip()}
    unknown = sorted(n for n in wanted if n not in known)
    if unknown:
        raise ValueError(f'Unknown enzyme{"s" if len(unknown) > 1 else ""}: {", ".join(unknown[:10])}')
    return sorted(wanted, key=str.casefold)


def _row(row) -> Dict[str, Any]:
    return {'id': row['id'], 'name': row['name'], 'enzymes': json.loads(row['enzymes']),
            'updated_at': row['updated_at']}


def for_owner(owner_id: str) -> List[Dict[str, Any]]:
    with get_connection() as conn:
        return [_row(r) for r in conn.execute(
            'SELECT * FROM enzyme_lists WHERE owner_id = ? ORDER BY name COLLATE NOCASE', (owner_id,))]


def get(list_id: str, owner_id: str) -> Optional[Dict[str, Any]]:
    with get_connection() as conn:
        row = conn.execute('SELECT * FROM enzyme_lists WHERE id = ? AND owner_id = ?',
                           (list_id, owner_id)).fetchone()
    return _row(row) if row else None


def _name_taken(owner_id: str, name: str, except_id: Optional[str] = None) -> bool:
    with get_connection() as conn:
        row = conn.execute('SELECT id FROM enzyme_lists WHERE owner_id = ? AND name = ? COLLATE NOCASE',
                           (owner_id, name)).fetchone()
    return bool(row and row['id'] != except_id)


def create(owner_id: str, name: str, enzymes) -> Dict[str, Any]:
    name = _clean_name(name)
    enzymes = clean_enzymes(enzymes)
    if len(for_owner(owner_id)) >= MAX_LISTS:
        raise ValueError(f'You can keep up to {MAX_LISTS} lists; remove one first')
    if _name_taken(owner_id, name):
        raise ValueError(f'You already have a list called "{name}"')
    list_id = str(uuid.uuid4())
    with get_connection() as conn:
        conn.execute('INSERT INTO enzyme_lists (id, owner_id, name, enzymes) VALUES (?, ?, ?, ?)',
                     (list_id, owner_id, name, json.dumps(enzymes)))
    return get(list_id, owner_id)


def update(list_id: str, owner_id: str, name: Optional[str] = None, enzymes=None) -> Optional[Dict[str, Any]]:
    current = get(list_id, owner_id)
    if current is None:
        return None
    name = _clean_name(name) if name is not None else current['name']
    enzymes = clean_enzymes(enzymes) if enzymes is not None else current['enzymes']
    if _name_taken(owner_id, name, except_id=list_id):
        raise ValueError(f'You already have a list called "{name}"')
    with get_connection() as conn:
        conn.execute('UPDATE enzyme_lists SET name = ?, enzymes = ?, updated_at = CURRENT_TIMESTAMP '
                     'WHERE id = ? AND owner_id = ?', (name, json.dumps(enzymes), list_id, owner_id))
    return get(list_id, owner_id)


def delete(list_id: str, owner_id: str) -> bool:
    with get_connection() as conn:
        return conn.execute('DELETE FROM enzyme_lists WHERE id = ? AND owner_id = ?',
                            (list_id, owner_id)).rowcount > 0


# Which list someone last showed: a built-in set's name, or "list:<id>" for one of theirs.

def choice(owner_id: str) -> Optional[str]:
    with get_connection() as conn:
        row = conn.execute('SELECT enzyme_choice FROM users WHERE id = ?', (owner_id,)).fetchone()
    return row['enzyme_choice'] if row else None


def set_choice(owner_id: str, value: str) -> None:
    value = str(value or '')[:120]
    with get_connection() as conn:
        conn.execute('UPDATE users SET enzyme_choice = ? WHERE id = ?', (value or None, owner_id))
