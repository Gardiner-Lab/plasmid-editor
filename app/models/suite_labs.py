"""Who is in which lab, and who leads it, when the lab suite keeps that.

Inside the Gardiner Lab suite (SUITE_AUTH=proxy), labs, their registration
codes and memberships belong to the suite's sign-in service, in its own
database (SUITE_DATABASE_PATH). The editor reads them from there instead of
its own users.lab_source and users.role, so a change made on the suite's Labs
page shows here at once. The editor never writes to it.
"""

import os
import sqlite3
import threading
from typing import Dict, Optional, Tuple

_lock = threading.Lock()
_cache: Tuple[Optional[tuple], Dict[str, dict]] = (None, {})


def enabled() -> bool:
    return os.environ.get('SUITE_AUTH', '').strip().lower() == 'proxy'


def _path() -> str:
    return os.environ.get('SUITE_DATABASE_PATH', '/suite/suite.db')


def memberships() -> Dict[str, dict]:
    """
    username -> {'lab': their first lab's name or None, 'role': their role
    there ('lab_lead' or 'member'), 'labs': [(name, role), ...] all their
    labs}. A lab admin counts as a lab lead here. Read again only when the
    suite's database has changed since, so looking people up stays cheap.
    """
    global _cache
    try:
        info = os.stat(_path())
        stamp = (info.st_mtime_ns, info.st_size)
    except OSError:
        return {}
    with _lock:
        if _cache[0] == stamp:
            return _cache[1]
        try:
            conn = sqlite3.connect(f'file:{_path()}?mode=ro', uri=True, timeout=5)
            try:
                tables = {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}
                # Several labs each (lab_members), or, from an older suite, one (members).
                rows = conn.execute(
                    'SELECT m.username, labs.name, m.role FROM '
                    + ('lab_members' if 'lab_members' in tables else 'members')
                    + ' m JOIN labs ON labs.id = m.lab_id ORDER BY m.joined_at, m.rowid').fetchall()
            finally:
                conn.close()
        except sqlite3.Error:
            return _cache[1]
        found: Dict[str, dict] = {}
        for username, lab, role in rows:
            entry = found.setdefault(username, {'lab': lab, 'role': role, 'labs': []})
            entry['labs'].append((lab, role))
        _cache = (stamp, found)
        return _cache[1]


def membership(username: str) -> Optional[dict]:
    """The suite's record for this person, or None outside the suite."""
    if not enabled():
        return None
    return memberships().get(username) or {'lab': None, 'role': 'member', 'labs': []}
