"""The labs that use these tools, each with its own registration code."""

import uuid
from typing import List, Optional

from app.models.database import get_connection

MAX_NAME_LENGTH = 100


def _clean(name: str) -> str:
    return ' '.join((name or '').split())


class Lab:
    def __init__(self, row):
        self.id = row['id']
        self.name = row['name']
        self.registration_code = row['registration_code']
        self.code_updated_by = row['code_updated_by']
        self.code_updated_at = row['code_updated_at']
        self.created_at = row['created_at']

    def to_dict(self, with_code: bool = False) -> dict:
        data = {'id': self.id, 'name': self.name, 'open': bool(self.registration_code),
                'created_at': self.created_at}
        if with_code:
            data.update(code=self.registration_code, code_updated_by=self.code_updated_by,
                        code_updated_at=self.code_updated_at)
        return data

    @staticmethod
    def all() -> List['Lab']:
        with get_connection() as conn:
            return [Lab(r) for r in conn.execute('SELECT * FROM labs ORDER BY name COLLATE NOCASE')]

    @staticmethod
    def get(lab_id: str) -> Optional['Lab']:
        with get_connection() as conn:
            row = conn.execute('SELECT * FROM labs WHERE id = ?', (lab_id,)).fetchone()
        return Lab(row) if row else None

    @staticmethod
    def by_name(name: str) -> Optional['Lab']:
        with get_connection() as conn:
            row = conn.execute('SELECT * FROM labs WHERE name = ?', (_clean(name),)).fetchone()
        return Lab(row) if row else None

    @staticmethod
    def create(name: str) -> 'Lab':
        name = _clean(name)
        if not name:
            raise ValueError('Give the lab a name')
        if len(name) > MAX_NAME_LENGTH:
            raise ValueError(f'A lab name must be at most {MAX_NAME_LENGTH} characters')
        if Lab.by_name(name):
            raise ValueError(f'There is already a lab called "{name}"')
        lab_id = str(uuid.uuid4())
        with get_connection() as conn:
            conn.execute('INSERT INTO labs (id, name) VALUES (?, ?)', (lab_id, name))
        return Lab.get(lab_id)

    @staticmethod
    def ensure(name: str) -> Optional['Lab']:
        """The lab of that name, created if need be; None for an empty name."""
        name = _clean(name)
        if not name:
            return None
        return Lab.by_name(name) or Lab.create(name)

    def rename(self, name: str) -> None:
        name = _clean(name)
        if not name:
            raise ValueError('Give the lab a name')
        other = Lab.by_name(name)
        if other and other.id != self.id:
            raise ValueError(f'There is already a lab called "{name}"')
        with get_connection() as conn:
            conn.execute('UPDATE labs SET name = ? WHERE id = ?', (name, self.id))
            # Members follow their lab to its new name.
            conn.execute('UPDATE users SET lab_source = ? WHERE lab_source = ? COLLATE NOCASE',
                         (name, self.name))
        self.name = name

    def set_code(self, code: Optional[str], updated_by: str) -> None:
        with get_connection() as conn:
            conn.execute('UPDATE labs SET registration_code = ?, code_updated_by = ?, '
                         'code_updated_at = CURRENT_TIMESTAMP WHERE id = ?',
                         (code, updated_by, self.id))
        self.registration_code = code
        self.code_updated_by = updated_by

    def member_count(self) -> int:
        with get_connection() as conn:
            return conn.execute('SELECT COUNT(*) FROM users WHERE lab_source = ? COLLATE NOCASE',
                                (self.name,)).fetchone()[0]

    def delete(self) -> None:
        """Only a lab nobody belongs to; members are never left without one."""
        if self.member_count():
            raise ValueError(f'"{self.name}" still has members; move them to another lab first')
        with get_connection() as conn:
            conn.execute('DELETE FROM labs WHERE id = ?', (self.id,))
