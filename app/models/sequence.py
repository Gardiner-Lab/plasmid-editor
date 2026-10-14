"""Stored sequences (plasmids and linear fragments) and their sequencing reads."""

import json
import uuid
from typing import Any, Dict, List, Optional

from app.models.database import get_connection
from dnakit.model import normalize_document

MAX_SEQUENCE_LENGTH = 2_000_000


def withdraw_unsupported_confirmations(conn, sequence_id: Optional[str] = None) -> List[Dict[str, Any]]:
    """
    Clear confirmations that no read judged sufficient supports any more.
    Returns the withdrawn plasmids' ids and MoClo links, so the caller can
    clear the matching status in MoClo.
    """
    where = ("confirmed_at IS NOT NULL AND NOT EXISTS ("
             "SELECT 1 FROM reads r WHERE r.sequence_id = sequences.id AND r.verdict = 'sufficient')")
    args: List[Any] = []
    if sequence_id is not None:
        where += ' AND id = ?'
        args.append(sequence_id)
    withdrawn = [{'id': r['id'], 'moclo_link': r['moclo_link']}
                 for r in conn.execute(f'SELECT id, moclo_link FROM sequences WHERE {where}', args)]
    if withdrawn:
        conn.execute(f'UPDATE sequences SET confirmed_at = NULL, confirmed_by = NULL WHERE {where}',
                     args)
    return withdrawn


class StoredSequence:
    @staticmethod
    def _to_document(row) -> Dict[str, Any]:
        try:
            features = json.loads(row['features']) if row['features'] else []
        except (TypeError, ValueError):
            features = []
        try:
            translations = json.loads(row['translations'] or '[]') if 'translations' in row.keys() else []
        except (TypeError, ValueError):
            translations = []
        return {
            'id': row['id'], 'name': row['name'], 'sequence': row['sequence'],
            'circular': bool(row['circular']), 'description': row['description'] or '',
            'features': features,
            'translations': translations,
            'golden_gate': bool(row['golden_gate']),
            'golden_gate_enzyme': row['golden_gate_enzyme'],
            'moclo_part_id': row['moclo_part_id'],
            'moclo_link': row['moclo_link'] if 'moclo_link' in row.keys() else None,
            'moclo_synced_hash': row['moclo_synced_hash'] if 'moclo_synced_hash' in row.keys() else None,
            'moclo_synced_at': row['moclo_synced_at'] if 'moclo_synced_at' in row.keys() else None,
            'confirmed_at': row['confirmed_at'] if 'confirmed_at' in row.keys() else None,
            'confirmed_by': row['confirmed_by'] if 'confirmed_by' in row.keys() else None,
            'confirmed_clone': row['confirmed_clone'] if 'confirmed_clone' in row.keys() else None,
            'glycerol_stock': row['glycerol_stock'] if 'glycerol_stock' in row.keys() else None,
            'confirmed': bool(row['confirmed_at'] if 'confirmed_at' in row.keys() else None),
            'owner_id': row['owner_id'], 'shared': bool(row['shared']),
            'origin': row['origin'],
            'created_at': row['created_at'], 'updated_at': row['updated_at'],
        }

    @staticmethod
    def create(doc: Dict[str, Any], owner_id: str, golden_gate: bool = False,
               golden_gate_enzyme: Optional[str] = None, origin: Optional[str] = None,
               shared: bool = True, moclo_link: Optional[str] = None,
               moclo_synced_hash: Optional[str] = None) -> Dict[str, Any]:
        doc = normalize_document(doc)
        if not doc['sequence']:
            raise ValueError('Sequence is empty')
        if len(doc['sequence']) > MAX_SEQUENCE_LENGTH:
            raise ValueError(f'Sequence is longer than {MAX_SEQUENCE_LENGTH:,} bp')
        sid = str(uuid.uuid4())
        with get_connection() as conn:
            conn.execute(
                'INSERT INTO sequences (id, name, sequence, circular, description, features, '
                'translations, golden_gate, golden_gate_enzyme, owner_id, shared, origin, moclo_link, '
                'moclo_synced_hash, moclo_synced_at) '
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, "
                "CASE WHEN ? IS NULL THEN NULL ELSE CURRENT_TIMESTAMP END)",
                (sid, doc['name'], doc['sequence'], 1 if doc['circular'] else 0, doc['description'],
                 json.dumps(doc['features']), json.dumps(doc['translations']),
                 1 if golden_gate else 0, golden_gate_enzyme,
                 owner_id, 1 if shared else 0, origin, moclo_link, moclo_synced_hash,
                 moclo_synced_hash))
            row = conn.execute('SELECT * FROM sequences WHERE id = ?', (sid,)).fetchone()
            return StoredSequence._to_document(row)

    @staticmethod
    def get(sequence_id: str) -> Optional[Dict[str, Any]]:
        with get_connection() as conn:
            row = conn.execute('SELECT * FROM sequences WHERE id = ?', (sequence_id,)).fetchone()
            return StoredSequence._to_document(row) if row else None

    @staticmethod
    def list_visible(user_id: str, search: str = '', golden_gate_only: bool = False,
                     mine_only: bool = False,
                     with_sequenced: bool = False) -> List[Dict[str, Any]]:
        sql = ('SELECT id, name, length(sequence) AS length, circular, description, golden_gate, '
               'golden_gate_enzyme, moclo_part_id, moclo_link, owner_id, shared, origin, '
               'created_at, updated_at, confirmed_at, confirmed_by, confirmed_clone, '
               'glycerol_stock, '
               '(SELECT COUNT(*) FROM reads WHERE reads.sequence_id = sequences.id) AS read_count, '
               "(SELECT COUNT(*) FROM reads WHERE reads.sequence_id = sequences.id "
               " AND reads.verdict = 'sufficient') AS reads_ok, "
               "(SELECT COUNT(*) FROM reads WHERE reads.sequence_id = sequences.id "
               " AND reads.verdict = 'insufficient') AS reads_bad, "
               '(SELECT MAX(created_at) FROM reads WHERE reads.sequence_id = sequences.id) '
               '  AS last_sequenced_at '
               'FROM sequences WHERE (shared = 1 OR owner_id = ?'
               + (' OR EXISTS (SELECT 1 FROM reads WHERE reads.sequence_id = sequences.id)'
                  if with_sequenced else '')
               + ')')
        args: List[Any] = [user_id]
        if mine_only:
            sql += ' AND owner_id = ?'
            args.append(user_id)
        if search:
            sql += ' AND (name LIKE ? OR IFNULL(description, "") LIKE ?)'
            args += [f'%{search}%'] * 2
        if golden_gate_only:
            sql += ' AND golden_gate = 1'
        sql += ' ORDER BY updated_at DESC, name'
        with get_connection() as conn:
            return [dict(r, circular=bool(r['circular']), golden_gate=bool(r['golden_gate']),
                         shared=bool(r['shared']), confirmed=bool(r['confirmed_at']))
                    for r in conn.execute(sql, args)]

    @staticmethod
    def update(sequence_id: str, doc: Optional[Dict[str, Any]] = None,
               golden_gate: Optional[bool] = None, golden_gate_enzyme: Optional[str] = None,
               shared: Optional[bool] = None, moclo_part_id: Optional[str] = None,
               moclo_link: Optional[str] = None,
               moclo_synced_hash: Optional[str] = None) -> Optional[Dict[str, Any]]:
        sets, args = [], []
        if doc is not None:
            doc = normalize_document(doc)
            if not doc['sequence']:
                raise ValueError('Sequence is empty')
            if len(doc['sequence']) > MAX_SEQUENCE_LENGTH:
                raise ValueError(f'Sequence is longer than {MAX_SEQUENCE_LENGTH:,} bp')
            sets += ['name = ?', 'sequence = ?', 'circular = ?', 'description = ?', 'features = ?',
                     'translations = ?']
            args += [doc['name'], doc['sequence'], 1 if doc['circular'] else 0, doc['description'],
                     json.dumps(doc['features']), json.dumps(doc['translations'])]
        if golden_gate is not None:
            sets.append('golden_gate = ?')
            args.append(1 if golden_gate else 0)
        if golden_gate_enzyme is not None:
            sets.append('golden_gate_enzyme = ?')
            args.append(golden_gate_enzyme or None)
        if shared is not None:
            sets.append('shared = ?')
            args.append(1 if shared else 0)
        if moclo_part_id is not None:
            sets.append('moclo_part_id = ?')
            args.append(moclo_part_id or None)
        if moclo_link is not None:
            sets.append('moclo_link = ?')
            args.append(moclo_link or None)
        if moclo_synced_hash is not None:
            sets += ['moclo_synced_hash = ?', 'moclo_synced_at = CURRENT_TIMESTAMP']
            args.append(moclo_synced_hash or None)
        if not sets:
            return StoredSequence.get(sequence_id)
        sets.append('updated_at = CURRENT_TIMESTAMP')
        args.append(sequence_id)
        with get_connection() as conn:
            cur = conn.execute(f'UPDATE sequences SET {", ".join(sets)} WHERE id = ?', args)
            if cur.rowcount == 0:
                return None
            row = conn.execute('SELECT * FROM sequences WHERE id = ?', (sequence_id,)).fetchone()
            return StoredSequence._to_document(row)

    @staticmethod
    def confirm(sequence_id: str, username: str, glycerol_stock: str,
                clone_number: Optional[str] = None) -> Optional[Dict[str, Any]]:
        """
        Mark a plasmid as sequence-confirmed, recording the glycerol stock.

        Only a plasmid with at least one read the user has judged sufficient
        can be confirmed: the user's verdict is what the confirmation rests on.
        """
        if not (glycerol_stock or '').strip():
            raise ValueError('A glycerol stock number is required to confirm a plasmid')
        with get_connection() as conn:
            if not conn.execute(
                    "SELECT 1 FROM reads WHERE sequence_id = ? AND verdict = 'sufficient' LIMIT 1",
                    (sequence_id,)).fetchone():
                if not conn.execute('SELECT 1 FROM sequences WHERE id = ?', (sequence_id,)).fetchone():
                    return None
                raise ValueError('Judge a sequencing read sufficient before confirming this plasmid')
            cur = conn.execute(
                'UPDATE sequences SET confirmed_at = CURRENT_TIMESTAMP, confirmed_by = ?, '
                'confirmed_clone = ?, glycerol_stock = ? WHERE id = ?',
                (username, (clone_number or '').strip() or None,
                 glycerol_stock.strip(), sequence_id))
            if cur.rowcount == 0:
                return None
        return StoredSequence.get(sequence_id)

    @staticmethod
    def withdraw_unsupported(sequence_id: Optional[str] = None) -> List[Dict[str, Any]]:
        """
        Withdraw the confirmation of a plasmid that no longer has a read judged
        sufficient (a verdict was changed or cleared, or the read deleted).
        The glycerol stock and clone are kept, so confirming again later does
        not mean typing them in again. Without an id, every plasmid is
        checked. Returns the plasmids withdrawn, with their MoClo links.
        """
        with get_connection() as conn:
            return withdraw_unsupported_confirmations(conn, sequence_id)

    @staticmethod
    def unconfirm(sequence_id: str) -> Optional[Dict[str, Any]]:
        """Withdraw confirmation, e.g. after a later read shows a problem."""
        with get_connection() as conn:
            cur = conn.execute(
                'UPDATE sequences SET confirmed_at = NULL, confirmed_by = NULL, '
                'confirmed_clone = NULL, glycerol_stock = NULL WHERE id = ?', (sequence_id,))
            if cur.rowcount == 0:
                return None
        return StoredSequence.get(sequence_id)

    @staticmethod
    def delete(sequence_id: str) -> bool:
        with get_connection() as conn:
            return conn.execute('DELETE FROM sequences WHERE id = ?', (sequence_id,)).rowcount > 0


class Read:
    """A sequencing read attached to a stored sequence."""

    @staticmethod
    def create(sequence_id: str, name: str, bases: str, quality: Optional[List[int]] = None,
               trace: Optional[Dict[str, Any]] = None, alignment: Optional[Dict[str, Any]] = None,
               uploaded_by: Optional[str] = None, clone_number: Optional[str] = None,
               verdict: Optional[str] = None, verdict_note: Optional[str] = None,
               verdict_by: Optional[str] = None) -> Dict[str, Any]:
        rid = str(uuid.uuid4())
        with get_connection() as conn:
            conn.execute(
                'INSERT INTO reads (id, sequence_id, name, bases, quality, trace, alignment, '
                'uploaded_by, clone_number, verdict, verdict_note, verdict_by, verdict_at) '
                'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '
                'CASE WHEN ? IS NULL THEN NULL ELSE CURRENT_TIMESTAMP END)',
                (rid, sequence_id, name, bases.upper(),
                 json.dumps(quality) if quality else None,
                 json.dumps(trace) if trace else None,
                 json.dumps(alignment) if alignment else None, uploaded_by,
                 (clone_number or '').strip() or None, verdict, verdict_note,
                 verdict_by, verdict))
        return {'id': rid, 'name': name, 'length': len(bases), 'clone_number': clone_number}

    @staticmethod
    def set_verdict(read_id: str, verdict: Optional[str], username: str,
                    note: Optional[str] = None,
                    clone_number: Optional[str] = None) -> Optional[Dict[str, Any]]:
        """Record whether the user considers this alignment good enough."""
        if verdict not in (None, 'sufficient', 'insufficient'):
            raise ValueError("verdict must be 'sufficient', 'insufficient' or null")
        sets = ['verdict = ?', 'verdict_note = ?', 'verdict_by = ?',
                'verdict_at = CASE WHEN ? IS NULL THEN NULL ELSE CURRENT_TIMESTAMP END']
        args: List[Any] = [verdict, (note or '').strip() or None,
                           username if verdict else None, verdict]
        if clone_number is not None:
            sets.append('clone_number = ?')
            args.append(clone_number.strip() or None)
        args.append(read_id)
        with get_connection() as conn:
            cur = conn.execute(f'UPDATE reads SET {", ".join(sets)} WHERE id = ?', args)
            if cur.rowcount == 0:
                return None
        return Read.get(read_id, include_trace=False)

    @staticmethod
    def _row(row, include_trace: bool = False) -> Dict[str, Any]:
        def load(key):
            try:
                return json.loads(row[key]) if row[key] else None
            except (TypeError, ValueError):
                return None
        keys = row.keys()
        out = {'id': row['id'], 'sequence_id': row['sequence_id'], 'name': row['name'],
               'bases': row['bases'], 'length': len(row['bases']), 'quality': load('quality'),
               'alignment': load('alignment'), 'created_at': row['created_at'],
               'uploaded_by': row['uploaded_by'],
               'clone_number': row['clone_number'] if 'clone_number' in keys else None,
               'verdict': row['verdict'] if 'verdict' in keys else None,
               'verdict_note': row['verdict_note'] if 'verdict_note' in keys else None,
               'verdict_by': row['verdict_by'] if 'verdict_by' in keys else None,
               'verdict_at': row['verdict_at'] if 'verdict_at' in keys else None}
        if include_trace:
            out['trace'] = load('trace')
        else:
            out['has_trace'] = bool(row['trace'])
        return out

    @staticmethod
    def list_for(sequence_id: str) -> List[Dict[str, Any]]:
        with get_connection() as conn:
            rows = conn.execute('SELECT * FROM reads WHERE sequence_id = ? ORDER BY created_at',
                                (sequence_id,)).fetchall()
            return [Read._row(r) for r in rows]

    @staticmethod
    def get(read_id: str, include_trace: bool = True) -> Optional[Dict[str, Any]]:
        with get_connection() as conn:
            row = conn.execute('SELECT * FROM reads WHERE id = ?', (read_id,)).fetchone()
            return Read._row(row, include_trace) if row else None

    @staticmethod
    def delete(read_id: str) -> bool:
        with get_connection() as conn:
            return conn.execute('DELETE FROM reads WHERE id = ?', (read_id,)).rowcount > 0
