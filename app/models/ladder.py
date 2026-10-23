"""
DNA ladders for the virtual gel: the standard ones (dnakit.restriction.LADDERS),
and those people make. A ladder someone makes is used by everyone in their
chair group - the labs that work together, as the suite sets them, their own
labs among them; without chair groups, by their own labs. Only its maker (or
an administrator) changes or removes it.
"""

import json
import re
import uuid
from typing import Any, Dict, List, Optional

from app.models import suite_labs
from app.models.database import get_connection
from app.models.user import User
from dnakit import restriction

MAX_NAME_LENGTH = 60
MAX_DESCRIPTION_LENGTH = 300
MIN_BANDS, MAX_BANDS = 2, 40
MIN_SIZE, MAX_SIZE = 10, 100_000
# Standard ladders are named as they are; a made one by its id, so names never clash.
STANDARD = 'standard:'


def _clean_name(name: str) -> str:
    name = ' '.join((name or '').split())
    if not name:
        raise ValueError('Give the ladder a name')
    if len(name) > MAX_NAME_LENGTH:
        raise ValueError(f'A ladder name must be at most {MAX_NAME_LENGTH} characters')
    if name.casefold() in {n.casefold() for n in restriction.LADDERS}:
        raise ValueError(f'"{name}" is a standard ladder already; give yours another name')
    return name


def clean_bands(bands: Any) -> List[Dict[str, Any]]:
    """
    A ladder's bands, largest first: [{'size': bp, 'strong': bool}]. Given as
    such a list, or as text - sizes separated by commas, spaces or new lines,
    "kb" allowed ("1.5 kb"), and a * after a size for a brighter reference band
    ("3000*").
    """
    found: Dict[int, bool] = {}
    if isinstance(bands, str):
        for token in re.split(r'[,;\s]+(?![kK][bB])', bands.strip()):
            token = token.strip()
            if not token:
                continue
            m = re.fullmatch(r'(\d+(?:\.\d+)?)\s*(kb|bp)?\s*(\*)?', token, re.IGNORECASE)
            if not m:
                raise ValueError(f'"{token}" is not a band size: write sizes in bp (or kb), e.g. 3000 or 1.5 kb')
            size = float(m.group(1)) * (1000 if (m.group(2) or '').lower() == 'kb' else 1)
            if size != int(size):
                raise ValueError(f'{token} is not a whole number of base pairs')
            found[int(size)] = found.get(int(size), False) or bool(m.group(3))
    elif isinstance(bands, list):
        for band in bands:
            size = band.get('size') if isinstance(band, dict) else band
            try:
                size = int(size)
            except (TypeError, ValueError):
                raise ValueError(f'{size!r} is not a band size')
            found[size] = found.get(size, False) or bool(isinstance(band, dict) and band.get('strong'))
    else:
        raise ValueError('Give the band sizes')
    out = sorted(found, reverse=True)
    if not MIN_BANDS <= len(out) <= MAX_BANDS:
        raise ValueError(f'A ladder needs {MIN_BANDS} to {MAX_BANDS} different band sizes')
    for size in out:
        if not MIN_SIZE <= size <= MAX_SIZE:
            raise ValueError(f'{size} bp is outside what a gel shows ({MIN_SIZE}–{MAX_SIZE:,} bp)')
    return [{'size': s, 'strong': found[s]} for s in out]


def _labs_of(owner: Optional[User]) -> set:
    """The labs whose people use a ladder its owner made: those of the owner's chair group(s)."""
    if owner is None:
        return set()
    return suite_labs.chair_group_labs(name for name, _ in owner.labs)


def can_use(user: User, ladder: Dict[str, Any], owner: Optional[User] = None) -> bool:
    if user.is_admin or ladder['owner_id'] == user.id:
        return True
    owner = owner or User.get_by_id(ladder['owner_id'])
    return bool(user.lab_names() & _labs_of(owner))


def can_change(user: User, ladder: Dict[str, Any]) -> bool:
    return user.is_admin or ladder['owner_id'] == user.id


def _row(row, user: Optional[User] = None) -> Dict[str, Any]:
    ladder = {'id': row['id'], 'owner_id': row['owner_id'], 'name': row['name'],
              'bands': json.loads(row['bands']), 'description': row['description'] or '',
              'created_by': row['created_by'], 'created_at': row['created_at'], 'updated_at': row['updated_at']}
    if user is not None:
        ladder['can_change'] = can_change(user, ladder)
    return ladder


def standard() -> List[Dict[str, Any]]:
    """The standard ladders, as made ones are listed."""
    return [{'id': f'{STANDARD}{name}', 'name': name, 'standard': True,
             'bands': [{'size': s, 'strong': False} for s in sizes]} for name, sizes in restriction.LADDERS.items()]


def usable(user: User) -> List[Dict[str, Any]]:
    """The ladders this person may use besides the standard ones: theirs, and their chair group's, by name."""
    with get_connection() as conn:
        rows = conn.execute('SELECT * FROM ladders ORDER BY name COLLATE NOCASE').fetchall()
    owners: Dict[str, Optional[User]] = {}
    found = []
    for row in rows:
        if row['owner_id'] not in owners:
            owners[row['owner_id']] = User.get_by_id(row['owner_id'])
        ladder = _row(row, user)
        if can_use(user, ladder, owners[row['owner_id']]):
            found.append(ladder)
    return found


def get(ladder_id: str) -> Optional[Dict[str, Any]]:
    with get_connection() as conn:
        row = conn.execute('SELECT * FROM ladders WHERE id = ?', (ladder_id,)).fetchone()
    return _row(row) if row else None


def for_gel(user: User, ladder_id: str) -> Dict[str, Any]:
    """The ladder a gel is run beside: {'label', 'bands'}; a standard one by name or 'standard:name'."""
    name = ladder_id[len(STANDARD):] if ladder_id.startswith(STANDARD) else ladder_id
    if name in restriction.LADDERS:
        return {'label': name, 'bands': [{'size': s, 'strong': False} for s in restriction.LADDERS[name]]}
    ladder = get(ladder_id)
    if ladder is None or not can_use(user, ladder):
        raise LookupError(f'Unknown ladder: {name}')
    return {'label': ladder['name'], 'bands': ladder['bands']}


def create(user: User, name: str, bands: Any, description: str = '') -> Dict[str, Any]:
    ladder_id = str(uuid.uuid4())
    with get_connection() as conn:
        conn.execute('INSERT INTO ladders (id, owner_id, name, bands, description, created_by) VALUES (?, ?, ?, ?, ?, ?)',
                     (ladder_id, user.id, _clean_name(name), json.dumps(clean_bands(bands)),
                      ' '.join(str(description or '').split())[:MAX_DESCRIPTION_LENGTH], user.username))
    return _row(_raw(ladder_id), user)


def _raw(ladder_id: str):
    with get_connection() as conn:
        return conn.execute('SELECT * FROM ladders WHERE id = ?', (ladder_id,)).fetchone()


def update(user: User, ladder_id: str, name: Optional[str] = None, bands: Any = None,
           description: Optional[str] = None) -> Dict[str, Any]:
    current = get(ladder_id)
    if current is None or not can_use(user, current):
        raise LookupError('No such ladder')
    if not can_change(user, current):
        raise PermissionError(f'Only {current["created_by"] or "its maker"} (or an administrator) changes this ladder')
    with get_connection() as conn:
        conn.execute('UPDATE ladders SET name = ?, bands = ?, description = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
                     (_clean_name(name) if name is not None else current['name'],
                      json.dumps(clean_bands(bands) if bands is not None else current['bands']),
                      ' '.join(str(description).split())[:MAX_DESCRIPTION_LENGTH] if description is not None
                      else current['description'], ladder_id))
    return _row(_raw(ladder_id), user)


def delete(user: User, ladder_id: str) -> None:
    current = get(ladder_id)
    if current is None or not can_use(user, current):
        raise LookupError('No such ladder')
    if not can_change(user, current):
        raise PermissionError(f'Only {current["created_by"] or "its maker"} (or an administrator) removes this ladder')
    with get_connection() as conn:
        conn.execute('DELETE FROM ladders WHERE id = ?', (ladder_id,))
