"""
Which MoClo records a person sees, for the editor's MoClo library card.

The same rule as the MoClo Library Tool's own (moclo-library-tool
app/services/library_access.py); keep the two in step. A part, backbone or
assembled plasmid belongs to the labs of whoever added it, and is seen by:

* its chair group (labs in no chair group keep their records to themselves);
* the chair groups its chair group shares its MoClo library with (MoClo's
  `library_shares` table, kept on MoClo's dashboard);
* everyone, when it is a reference record: the built-in toolkit (contributor or
  owner "system") or one marked in MoClo's `library_reference` table;
* administrators.

The suite's teaching demo (suite.db setting 'demo.chair_group') sees its own
records and the kits MoClo ships with (marked by 'system'), nothing more.

Outside the suite (no labs to go by), everyone sees everything, as before.
"""

import sqlite3
from typing import Dict, Optional, Set

from app.models import suite_labs
from app.services import moclo_bridge

SYSTEM = 'system'


def _read_moclo():
    """(user id -> username, {kind: reference ids}, [(from_group, to_group)]) from moclo.db."""
    names: Dict[str, str] = {}
    reference: Dict[str, Set[str]] = {}
    shares = []
    conn = moclo_bridge._connect(moclo_bridge.moclo_db_path())
    if conn is None:
        return names, reference, shares
    try:
        if moclo_bridge._table_exists(conn, 'users'):
            names = {r[0]: r[1] for r in conn.execute('SELECT id, username FROM users')}
        if moclo_bridge._table_exists(conn, 'library_reference'):
            for kind, record_id, by in conn.execute('SELECT kind, record_id, marked_by FROM library_reference'):
                reference.setdefault(kind, set()).add(record_id)
                if by == SYSTEM:      # a kit MoClo ships with, marked by MoClo itself
                    reference.setdefault('kit:' + kind, set()).add(record_id)
        if moclo_bridge._table_exists(conn, 'library_shares'):
            shares = conn.execute('SELECT from_group, to_group FROM library_shares').fetchall()
    except sqlite3.Error:
        pass
    finally:
        conn.close()
    return names, reference, shares


class MocloViewer:
    """What one person sees of MoClo; build one per request."""

    def __init__(self, user):
        self.username = getattr(user, 'username', None)
        people = suite_labs.memberships()
        self.everything = bool(getattr(user, 'is_admin', False)) or not people
        self._labs_of = {name: {lab.casefold() for lab, _ in entry.get('labs', []) if lab}
                         for name, entry in people.items()}
        self._names, self._reference, shares = _read_moclo()
        self.demo = False
        if self.everything:
            self.labs: Set[str] = set()
            return
        group_of = suite_labs.chair_groups()
        own = self._labs_of.get(self.username, set())
        mine = {group_of.get(lab) for lab in own} - {None}
        demo = suite_labs.demo_group()
        # The suite's teaching demo: its own records and the shipped kits only (as in MoClo).
        self.demo = bool(demo and own) and all(group_of.get(lab) == demo for lab in own)
        seen_groups = mine if self.demo else mine | {frm for frm, to in shares if to in mine}
        self.labs = own | {lab for lab, group in group_of.items() if group in seen_groups}

    def sees(self, kind: str, record_id: str, owner: Optional[str]) -> bool:
        """owner: a part's contributor, a backbone's or plasmid's owner_id (older parts: a user id)."""
        if self.everything:
            return True
        username = self._names.get(owner, owner) if owner else None
        marked = self._reference.get(('kit:' + kind) if self.demo else kind, set())
        if username == SYSTEM or record_id in marked:
            return True
        if username and username == self.username:
            return True
        return bool(self.labs & self._labs_of.get(username, set()))
