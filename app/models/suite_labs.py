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
    username -> {'lab': name or None, 'role': 'lab_lead' or 'member'}. Read
    again only when the suite's database has changed since, so looking people
    up stays cheap.
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
                rows = conn.execute(
                    'SELECT members.username, labs.name, members.role FROM members '
                    'LEFT JOIN labs ON labs.id = members.lab_id').fetchall()
            finally:
                conn.close()
        except sqlite3.Error:
            return _cache[1]
        _cache = (stamp, {u: {'lab': lab, 'role': role} for u, lab, role in rows})
        return _cache[1]


def membership(username: str) -> Optional[dict]:
    """The suite's record for this person, or None outside the suite."""
    if not enabled():
        return None
    return memberships().get(username) or {'lab': None, 'role': 'member'}
