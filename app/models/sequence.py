"""Stored sequences (plasmids and linear fragments) and their sequencing reads."""

import json
import uuid
from typing import Any, Dict, List, Optional

from app.models.database import get_connection
from dnakit.model import normalize_document

MAX_SEQUENCE_LENGTH = 2_000_000


class StoredSequence:
    @staticmethod
    def _to_document(row) -> Dict[str, Any]:
        try:
            features = json.loads(row['features']) if row['features'] else []
        except (TypeError, ValueError):
            features = []
        return {
            'id': row['id'], 'name': row['name'], 'sequence': row['sequence'],
            'circular': bool(row['circular']), 'description': row['description'] or '',
            'features': features,
            'golden_gate': bool(row['golden_gate']),
            'golden_gate_enzyme': row['golden_gate_enzyme'],
            'moclo_part_id': row['moclo_part_id'],
            'owner_id': row['owner_id'], 'shared': bool(row['shared']),
            'origin': row['origin'],
            'created_at': row['created_at'], 'updated_at': row['updated_at'],
        }

    @staticmethod
    def create(doc: Dict[str, Any], owner_id: str, golden_gate: bool = False,
               golden_gate_enzyme: Optional[str] = None, origin: Optional[str] = None,
               shared: bool = True) -> Dict[str, Any]:
        doc = normalize_document(doc)
        if not doc['sequence']:
            raise ValueError('Sequence is empty')
        if len(doc['sequence']) > MAX_SEQUENCE_LENGTH:
            raise ValueError(f'Sequence is longer than {MAX_SEQUENCE_LENGTH:,} bp')
        sid = str(uuid.uuid4())
        with get_connection() as conn:
            conn.execute(
                'INSERT INTO sequences (id, name, sequence, circular, description, features, '
                'golden_gate, golden_gate_enzyme, owner_id, shared, origin) '
                'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
                (sid, doc['name'], doc['sequence'], 1 if doc['circular'] else 0, doc['description'],
                 json.dumps(doc['features']), 1 if golden_gate else 0, golden_gate_enzyme,
                 owner_id, 1 if shared else 0, origin))
            row = conn.execute('SELECT * FROM sequences WHERE id = ?', (sid,)).fetchone()
            return StoredSequence._to_document(row)

    @staticmethod
    def get(sequence_id: str) -> Optional[Dict[str, Any]]:
        with get_connection() as conn:
            row = conn.execute('SELECT * FROM sequences WHERE id = ?', (sequence_id,)).fetchone()
            return StoredSequence._to_document(row) if row else None

    @staticmethod
    def list_visible(user_id: str, search: str = '', golden_gate_only: bool = False,
                     mine_only: bool = False) -> List[Dict[str, Any]]:
        sql = ('SELECT id, name, length(sequence) AS length, circular, description, golden_gate, '
               'golden_gate_enzyme, moclo_part_id, owner_id, shared, origin, created_at, updated_at, '
               '(SELECT COUNT(*) FROM reads WHERE reads.sequence_id = sequences.id) AS read_count '
               'FROM sequences WHERE (shared = 1 OR owner_id = ?)')
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
                         shared=bool(r['shared'])) for r in conn.execute(sql, args)]

    @staticmethod
    def update(sequence_id: str, doc: Optional[Dict[str, Any]] = None,
               golden_gate: Optional[bool] = None, golden_gate_enzyme: Optional[str] = None,
               shared: Optional[bool] = None, moclo_part_id: Optional[str] = None) -> Optional[Dict[str, Any]]:
        sets, args = [], []
        if doc is not None:
            doc = normalize_document(doc)
            if not doc['sequence']:
                raise ValueError('Sequence is empty')
            if len(doc['sequence']) > MAX_SEQUENCE_LENGTH:
                raise ValueError(f'Sequence is longer than {MAX_SEQUENCE_LENGTH:,} bp')
            sets += ['name = ?', 'sequence = ?', 'circular = ?', 'description = ?', 'features = ?']
            args += [doc['name'], doc['sequence'], 1 if doc['circular'] else 0, doc['description'],
                     json.dumps(doc['features'])]
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
    def delete(sequence_id: str) -> bool:
        with get_connection() as conn:
            return conn.execute('DELETE FROM sequences WHERE id = ?', (sequence_id,)).rowcount > 0


class Read:
    """A sequencing read attached to a stored sequence."""

    @staticmethod
    def create(sequence_id: str, name: str, bases: str, quality: Optional[List[int]] = None,
               trace: Optional[Dict[str, Any]] = None, alignment: Optional[Dict[str, Any]] = None,
               uploaded_by: Optional[str] = None) -> Dict[str, Any]:
        rid = str(uuid.uuid4())
        with get_connection() as conn:
            conn.execute('INSERT INTO reads (id, sequence_id, name, bases, quality, trace, alignment, '
                         'uploaded_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
                         (rid, sequence_id, name, bases.upper(),
                          json.dumps(quality) if quality else None,
                          json.dumps(trace) if trace else None,
                          json.dumps(alignment) if alignment else None, uploaded_by))
        return {'id': rid, 'name': name, 'length': len(bases)}

    @staticmethod
    def _row(row, include_trace: bool = False) -> Dict[str, Any]:
        def load(key):
            try:
                return json.loads(row[key]) if row[key] else None
            except (TypeError, ValueError):
                return None
        out = {'id': row['id'], 'sequence_id': row['sequence_id'], 'name': row['name'],
               'bases': row['bases'], 'length': len(row['bases']), 'quality': load('quality'),
               'alignment': load('alignment'), 'created_at': row['created_at'],
               'uploaded_by': row['uploaded_by']}
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
