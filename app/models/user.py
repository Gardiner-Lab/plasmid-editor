"""Users and password handling."""

import os
import re
import uuid
from typing import Any, Dict, List, Optional

import bcrypt

from app.models.database import get_connection

USERNAME_RE = re.compile(r'^[A-Za-z0-9._-]{3,32}$')
MIN_PASSWORD_LENGTH = 8


class User:
    def __init__(self, id: str, username: str, password_hash: str, lab_source: Optional[str],
                 is_admin: bool = False, created_at: Optional[str] = None):
        self.id = id
        self.username = username
        self.password_hash = password_hash
        self.lab_source = lab_source
        self.is_admin = is_admin
        self.created_at = created_at

    def to_dict(self) -> Dict[str, Any]:
        return {'id': self.id, 'username': self.username, 'lab_source': self.lab_source,
                'is_admin': self.is_admin, 'created_at': self.created_at}

    def check_password(self, password: str) -> bool:
        try:
            return bcrypt.checkpw(password.encode('utf-8'), self.password_hash.encode('utf-8'))
        except (ValueError, TypeError):
            return False

    @staticmethod
    def _row(row) -> 'User':
        return User(row['id'], row['username'], row['password_hash'], row['lab_source'],
                    bool(row['is_admin']), row['created_at'])

    @staticmethod
    def hash_password(password: str) -> str:
        return bcrypt.hashpw(password.encode('utf-8'), bcrypt.gensalt()).decode('utf-8')

    @staticmethod
    def create(username: str, password: str, lab_source: str = '', is_admin: bool = False) -> 'User':
        username = (username or '').strip()
        if not USERNAME_RE.match(username):
            raise ValueError('Username must be 3-32 characters: letters, digits, dot, dash or underscore')
        if len(password or '') < MIN_PASSWORD_LENGTH:
            raise ValueError(f'Password must be at least {MIN_PASSWORD_LENGTH} characters')
        with get_connection() as conn:
            if conn.execute('SELECT 1 FROM users WHERE username = ?', (username,)).fetchone():
                raise ValueError('That username is already taken')
            uid = str(uuid.uuid4())
            conn.execute('INSERT INTO users (id, username, password_hash, lab_source, is_admin) '
                         'VALUES (?, ?, ?, ?, ?)',
                         (uid, username, User.hash_password(password), lab_source.strip() or None,
                          1 if is_admin else 0))
            row = conn.execute('SELECT * FROM users WHERE id = ?', (uid,)).fetchone()
            return User._row(row)

    @staticmethod
    def get_by_username(username: str) -> Optional['User']:
        with get_connection() as conn:
            row = conn.execute('SELECT * FROM users WHERE username = ?', (username,)).fetchone()
            return User._row(row) if row else None

    @staticmethod
    def get_by_id(user_id: str) -> Optional['User']:
        with get_connection() as conn:
            row = conn.execute('SELECT * FROM users WHERE id = ?', (user_id,)).fetchone()
            return User._row(row) if row else None

    @staticmethod
    def get_all() -> List['User']:
        with get_connection() as conn:
            return [User._row(r) for r in conn.execute('SELECT * FROM users ORDER BY username')]

    @staticmethod
    def count() -> int:
        with get_connection() as conn:
            return conn.execute('SELECT COUNT(*) AS n FROM users').fetchone()['n']

    def set_lab_source(self, lab_source: str) -> None:
        with get_connection() as conn:
            conn.execute('UPDATE users SET lab_source = ? WHERE id = ?', (lab_source.strip() or None, self.id))
        self.lab_source = lab_source.strip() or None


def ensure_default_admin() -> Optional[str]:
    """Create the first admin from the environment, if there are no users yet."""
    if User.count() > 0:
        return None
    username = os.environ.get('ADMIN_USERNAME', 'admin')
    password = os.environ.get('ADMIN_PASSWORD')
    if not password:
        return None
    User.create(username, password, os.environ.get('DEFAULT_LAB_SOURCE', ''), is_admin=True)
    return username
