"""Users and password handling."""

import logging
import os
import re
import sqlite3
import uuid
from typing import Any, Dict, List, Optional

import bcrypt

from app.models import suite_labs
from app.models.database import get_connection

logger = logging.getLogger(__name__)

USERNAME_RE = re.compile(r'^[A-Za-z0-9._-]{3,32}$')
MIN_PASSWORD_LENGTH = 8


# Roles, from most to least privileged:
#   admin     everything, including the labs, their registration codes and roles
#   lab_lead  an administrator for their own lab's members and plasmids, and can
#             see (not change) their lab's registration code
#   member    their own work, and what the people in their labs share
#
# Inside the lab suite someone may be in several labs, with a role in each
# (labs); a lead oversees the members of the labs they lead.
ROLES = ('admin', 'lab_lead', 'member')


class User:
    def __init__(self, id: str, username: str, password_hash: str, lab_source: Optional[str],
                 is_admin: bool = False, created_at: Optional[str] = None,
                 lab_role: Optional[str] = None, labs: Optional[List[tuple]] = None):
        self.id = id
        self.username = username
        self.password_hash = password_hash
        self.lab_source = lab_source
        self.is_admin = is_admin
        self.created_at = created_at
        self.lab_role = lab_role
        # Every lab they are in, with their role there: (name, 'lab_lead' or 'member').
        self.labs = labs if labs is not None else ([(lab_source, lab_role or 'member')] if lab_source else [])

    @property
    def role(self) -> str:
        if self.is_admin:
            return 'admin'
        return 'lab_lead' if any(role == 'lab_lead' for _, role in self.labs) or self.lab_role == 'lab_lead' \
            else 'member'

    @property
    def is_lab_lead(self) -> bool:
        return self.role == 'lab_lead'

    @property
    def can_administer(self) -> bool:
        """Admins and lab leads: who may open the Admin page."""
        return self.role in ('admin', 'lab_lead')

    def lab_names(self, led_only: bool = False) -> set:
        return {name.casefold() for name, role in self.labs if name and (not led_only or role == 'lab_lead')}

    def same_lab(self, other: Optional['User']) -> bool:
        """In a lab together: any of one's labs is one of the other's."""
        return bool(other is not None and self.lab_names() & other.lab_names())

    def oversees(self, owner_id: str) -> bool:
        """May act for this owner: an admin for anyone, a lab lead for the members of the labs they lead."""
        if self.is_admin:
            return True
        led = self.lab_names(led_only=True)
        if not led:
            return False
        other = User.get_by_id(owner_id)
        return bool(other is not None and led & other.lab_names())

    def can_see_sequence(self, owner_id: str, shared: bool, owners: Optional[Dict[str, 'User']] = None) -> bool:
        """
        A plasmid: its owner's; an admin's; a lead's of the owner's labs; and,
        when it is shared, anyone's in a lab with the owner. Outside the lab
        suite there are no labs to keep it to, so shared is everyone's.
        """
        if owner_id == self.id or self.is_admin:
            return True
        other = (owners or {}).get(owner_id) if owners is not None else User.get_by_id(owner_id)
        if other is None:
            return False
        mine = self.lab_names()
        if self.lab_names(led_only=True) & other.lab_names():
            return True
        if not shared:
            return False
        return bool(mine & other.lab_names()) if suite_labs.enabled() else True

    def to_dict(self) -> Dict[str, Any]:
        return {'id': self.id, 'username': self.username, 'lab_source': self.lab_source,
                'is_admin': self.is_admin, 'role': self.role, 'created_at': self.created_at}

    def check_password(self, password: str) -> bool:
        try:
            return bcrypt.checkpw(password.encode('utf-8'), self.password_hash.encode('utf-8'))
        except (ValueError, TypeError):
            return False

    @staticmethod
    def _row(row) -> 'User':
        keys = row.keys()
        lab_source, lab_role = row['lab_source'], row['role'] if 'role' in keys else None
        # Inside the lab suite, its record of labs and lab leads is the one that counts.
        suite = suite_labs.membership(row['username'])
        labs = None
        if suite is not None:
            lab_source, lab_role, labs = suite['lab'], suite['role'], suite.get('labs')
        return User(row['id'], row['username'], row['password_hash'], lab_source,
                    bool(row['is_admin']), row['created_at'], lab_role, labs)

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

    def set_role(self, role: str) -> None:
        """
        admin, lab_lead or member. Administrator status lives in the shared
        directory, so it changes in every tool; lab lead is this editor's own.
        """
        if role not in ROLES:
            raise ValueError(f'Unknown role {role!r}')
        make_admin = role == 'admin'
        if self.is_admin and not make_admin:
            with get_connection() as conn:
                admins = conn.execute('SELECT COUNT(*) FROM users WHERE is_admin').fetchone()[0]
            if admins <= 1:
                raise ValueError('This is the only administrator; make someone else one first')
        if make_admin != self.is_admin:
            set_directory_admin(self.username, make_admin)
        with get_connection() as conn:
            conn.execute('UPDATE users SET is_admin = ?, role = ? WHERE id = ?',
                         (1 if make_admin else 0, 'lab_lead' if role == 'lab_lead' else None,
                          self.id))
        self.is_admin = make_admin
        self.lab_role = 'lab_lead' if role == 'lab_lead' else None

    def set_lab_source(self, lab_source: str) -> None:
        with get_connection() as conn:
            conn.execute('UPDATE users SET lab_source = ? WHERE id = ?', (lab_source.strip() or None, self.id))
        self.lab_source = lab_source.strip() or None


# ---------------------------------------------------------------------------
# Shared accounts
# ---------------------------------------------------------------------------
#
# The MoClo Library Tool's user table is the suite's account directory: one
# username and password works in every tool, and administrator status is set in
# one place. An account registered here is created in that directory, and
# accounts that only existed here are copied into it, so every account works
# everywhere. A local row is kept as well so this app's own ownership
# references still work.

def shared_directory_path() -> str:
    return os.environ.get('MOCLO_DATABASE_PATH', '/data/moclo.db')


def _directory(write: bool = False) -> Optional[sqlite3.Connection]:
    """Open the shared directory, or None when there is no readable users table."""
    path = shared_directory_path()
    if not os.path.exists(path):
        return None
    try:
        if write:
            conn = sqlite3.connect(path, timeout=10)
            conn.execute('PRAGMA busy_timeout = 10000')
        else:
            conn = sqlite3.connect(f'file:{path}?mode=ro', uri=True, timeout=5)
        conn.row_factory = sqlite3.Row
        conn.execute('SELECT 1 FROM users LIMIT 1')
        return conn
    except sqlite3.Error:
        return None


def _shared_account(username: str) -> Optional[dict]:
    """Look a username up in the shared directory, if there is one."""
    if not username:
        return None
    conn = _directory()
    if conn is None:
        return None
    try:
        row = conn.execute('SELECT * FROM users WHERE username = ?', (username.strip(),)).fetchone()
    except sqlite3.Error:
        return None
    finally:
        conn.close()
    if row is None:
        return None
    account = dict(row)
    # Older MoClo releases have no is_admin column.
    account['is_admin'] = bool(account.get('is_admin'))
    return account


def shared_directory_available() -> bool:
    """True when the shared account directory can be read."""
    conn = _directory()
    if conn is None:
        return False
    conn.close()
    return True


def _insert_into_directory(conn: sqlite3.Connection, user_id: str, username: str,
                           password_hash: str, is_admin: bool) -> bool:
    """Add one account to the directory; False if the username is already there."""
    if conn.execute('SELECT 1 FROM users WHERE username = ?', (username,)).fetchone():
        return False
    if conn.execute('SELECT 1 FROM users WHERE id = ?', (user_id,)).fetchone():
        user_id = str(uuid.uuid4())
    values = {'id': user_id, 'username': username, 'password_hash': password_hash,
              'is_admin': 1 if is_admin else 0}
    # Only write columns the directory has, so an older MoClo schema still works.
    existing = {r['name'] for r in conn.execute('PRAGMA table_info(users)')}
    columns = [c for c in values if c in existing]
    conn.execute(f'INSERT INTO users ({", ".join(columns)}) '
                 f'VALUES ({", ".join("?" for _ in columns)})',
                 [values[c] for c in columns])
    return True


def set_directory_admin(username: str, is_admin: bool) -> None:
    """Change administrator status in the shared directory, where it is authoritative."""
    conn = _directory(write=True)
    if conn is None:
        return
    try:
        columns = {r['name'] for r in conn.execute('PRAGMA table_info(users)')}
        if 'is_admin' in columns:
            with conn:
                conn.execute('UPDATE users SET is_admin = ? WHERE username = ?',
                             (1 if is_admin else 0, username))
    except sqlite3.Error as exc:
        raise ValueError('The shared account directory could not be updated; try again') from exc
    finally:
        conn.close()


def _mirror(account: dict) -> 'User':
    """
    Keep a local row for a shared account, so sequences can still point at an
    owner. Matching is by username: an existing local account keeps its own id,
    and with it everything it already owns.
    """
    with get_connection() as conn:
        row = conn.execute('SELECT * FROM users WHERE username = ?', (account['username'],)).fetchone()
        if row is None:
            uid = account['id']
            if conn.execute('SELECT 1 FROM users WHERE id = ?', (uid,)).fetchone():
                uid = str(uuid.uuid4())
            conn.execute(
                'INSERT INTO users (id, username, password_hash, lab_source, is_admin) '
                'VALUES (?, ?, ?, ?, ?)',
                (uid, account['username'], account['password_hash'], None,
                 1 if account['is_admin'] else 0))
        else:
            # Track the directory, so a password or admin change there takes
            # effect here too.
            conn.execute('UPDATE users SET password_hash = ?, is_admin = ? WHERE id = ?',
                         (account['password_hash'], 1 if account['is_admin'] else 0, row['id']))
        row = conn.execute('SELECT * FROM users WHERE username = ?', (account['username'],)).fetchone()
        return User._row(row)


# For the suite's sign-in (app/services/suite_auth.py), which identifies people
# by username and needs their local row without a password to check.
shared_account = _shared_account
mirror_shared_account = _mirror


def register(username: str, password: str, lab_source: str = '') -> 'User':
    """
    Create an account. With a shared directory it is created there, so it works
    in every tool; without one it is a local account, as before.
    """
    conn = _directory(write=True)
    if conn is None:
        return User.create(username, password, lab_source, is_admin=User.count() == 0)

    try:
        username = (username or '').strip()
        if not USERNAME_RE.match(username):
            raise ValueError('Username must be 3-32 characters: letters, digits, dot, dash or underscore')
        if len(password or '') < MIN_PASSWORD_LENGTH:
            raise ValueError(f'Password must be at least {MIN_PASSWORD_LENGTH} characters')
        # A local name the directory does not know yet still belongs to someone.
        if User.get_by_username(username) is not None:
            raise ValueError('That username is already taken')
        with conn:
            first = conn.execute('SELECT COUNT(*) FROM users').fetchone()[0] == 0
            if not _insert_into_directory(conn, str(uuid.uuid4()), username,
                                          User.hash_password(password), first):
                raise ValueError('That username is already taken')
    except sqlite3.Error as exc:
        raise ValueError('The shared account directory could not be updated; try again') from exc
    finally:
        conn.close()

    user = _mirror(_shared_account(username))
    if lab_source.strip():
        user.set_lab_source(lab_source)
    return user


def share_local_accounts() -> int:
    """
    Copy accounts that exist only here into the shared directory, keeping their
    id, password and administrator status. A username the directory already
    has is left alone: the directory is authoritative for it. Returns how many
    accounts were copied.
    """
    conn = _directory(write=True)
    if conn is None:
        return 0
    copied = 0
    try:
        with conn:
            for user in User.get_all():
                if _insert_into_directory(conn, user.id, user.username, user.password_hash,
                                          user.is_admin):
                    copied += 1
    except sqlite3.Error:
        return 0
    finally:
        conn.close()
    return copied


def import_directory_accounts() -> int:
    """
    Give every account in the shared directory a local row, so people who
    signed up in the MoClo tool are users here before they first sign in.
    Returns how many accounts were new here.
    """
    conn = _directory()
    if conn is None:
        return 0
    try:
        accounts = [dict(r) for r in conn.execute('SELECT * FROM users')]
    except sqlite3.Error:
        return 0
    finally:
        conn.close()
    added = 0
    for account in accounts:
        account['is_admin'] = bool(account.get('is_admin'))
        if User.get_by_username(account['username']) is None:
            added += 1
        _mirror(account)
    return added


# The MoClo tool creates "admin" with this published password whenever there is
# no account of that name. With accounts shared, it would open every tool here,
# the backup console included.
MOCLO_DEFAULT_ADMIN = ('admin', 'admin123')


def retire_default_admin_password() -> Optional[str]:
    """
    Replace MoClo's default admin password with ADMIN_PASSWORD, if it is still
    in use. Returns 'replaced', 'exposed' (still default, nothing to replace it
    with), or None when the default is not in use.
    """
    username, default = MOCLO_DEFAULT_ADMIN
    conn = _directory(write=True)
    if conn is None:
        return None
    try:
        row = conn.execute('SELECT password_hash FROM users WHERE username = ?',
                           (username,)).fetchone()
        if row is None or not bcrypt.checkpw(default.encode(), row['password_hash'].encode()):
            return None
        new = os.environ.get('ADMIN_PASSWORD', '')
        if not new or new == default or os.environ.get('ADMIN_USERNAME', 'admin') != username:
            logger.warning("The shared account 'admin' still has MoClo's published default "
                           "password 'admin123', which signs in to every tool. Change it, or "
                           "set ADMIN_PASSWORD and restart to have it replaced.")
            return 'exposed'
        conn.execute('UPDATE users SET password_hash = ? WHERE username = ?',
                     (User.hash_password(new), username))
        conn.commit()
        logger.warning("Replaced MoClo's default password for 'admin' with ADMIN_PASSWORD.")
        return 'replaced'
    except (sqlite3.Error, ValueError) as exc:
        logger.warning('Could not check the default admin password: %s', exc)
        return None
    finally:
        conn.close()


def sync_accounts() -> None:
    """Make the editor's accounts and the shared directory hold the same people."""
    retire_default_admin_password()
    share_local_accounts()
    import_directory_accounts()


def authenticate(username: str, password: str) -> Optional['User']:
    """
    Check a username and password against the shared directory first, then
    against accounts that only exist here.

    When a username exists in the shared directory, that directory is
    authoritative: a stale local password cannot be used to sign in.
    """
    username = (username or '').strip()
    account = _shared_account(username)
    if account is not None:
        try:
            ok = bcrypt.checkpw((password or '').encode('utf-8'),
                                account['password_hash'].encode('utf-8'))
        except (ValueError, TypeError):
            ok = False
        return _mirror(account) if ok else None

    user = User.get_by_username(username)
    if user is not None and user.check_password(password or ''):
        # The directory may have appeared since this account was made; share
        # it now so it works in the other tools too.
        share_local_accounts()
        return user
    return None


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
