"""
Shared-database bridge to the MoClo Library Tool.

Both tools run on the same server and mount the same data volume, so the
editor reads and writes the MoClo parts database directly
(PARTS_DATABASE_PATH, default /data/parts.db) and reads its main database
(MOCLO_DATABASE_PATH, default /data/moclo.db) for backbones and assembled
plasmids.

The MoClo tool owns these schemas. This module only ever:
  - reads parts / backbones / plasmids so they can be opened in the editor, and
  - inserts a new row into `parts` when a user marks a plasmid Golden Gate
    ready and contributes it.

It never alters the schema or updates rows the MoClo tool owns, so the editor
can be deployed and updated independently.
"""

import json
import os
import sqlite3
import uuid
from typing import Any, Dict, List, Optional

from dnakit import goldengate
from dnakit.model import make_document, make_feature

PART_TYPES = goldengate.PART_TYPES


def parts_db_path() -> str:
    return os.environ.get('PARTS_DATABASE_PATH', '/data/parts.db')


def moclo_db_path() -> str:
    return os.environ.get('MOCLO_DATABASE_PATH', '/data/moclo.db')


def _connect(path: str, read_only: bool = True) -> Optional[sqlite3.Connection]:
    """Open a MoClo database, or None when this deployment has no shared volume."""
    if not os.path.exists(path):
        return None
    if read_only:
        conn = sqlite3.connect(f'file:{path}?mode=ro', uri=True, timeout=5)
    else:
        conn = sqlite3.connect(path, timeout=10)
        conn.execute('PRAGMA busy_timeout = 10000')
    conn.row_factory = sqlite3.Row
    return conn


def available() -> Dict[str, bool]:
    """Which shared MoClo databases this deployment can see."""
    return {'parts': os.path.exists(parts_db_path()), 'plasmids': os.path.exists(moclo_db_path())}


def _table_exists(conn: sqlite3.Connection, name: str) -> bool:
    row = conn.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (name,)).fetchone()
    return row is not None


def _columns(conn: sqlite3.Connection, table: str) -> List[str]:
    return [r['name'] for r in conn.execute(f'PRAGMA table_info({table})')]


# ---------------------------------------------------------------------------
# Reading
# ---------------------------------------------------------------------------

def list_parts(search: str = '', part_type: str = '', limit: int = 500) -> List[Dict[str, Any]]:
    conn = _connect(parts_db_path())
    if conn is None:
        return []
    try:
        if not _table_exists(conn, 'parts'):
            return []
        sql = ('SELECT id, name, part_type, overhang_5prime, overhang_3prime, length(sequence) AS length, '
               'lab_source, contributor, description, plasmid_id, level, unit FROM parts WHERE 1=1')
        args: List[Any] = []
        if search:
            sql += ' AND (name LIKE ? OR IFNULL(description, "") LIKE ? OR IFNULL(plasmid_id, "") LIKE ?)'
            args += [f'%{search}%'] * 3
        if part_type:
            sql += ' AND part_type = ?'
            args.append(part_type)
        sql += ' ORDER BY name LIMIT ?'
        args.append(limit)
        return [dict(r) for r in conn.execute(sql, args)]
    finally:
        conn.close()


def _features_to_documents(raw: Optional[str], length: int) -> List[Dict[str, Any]]:
    try:
        items = json.loads(raw) if raw else []
    except (TypeError, ValueError):
        return []
    out = []
    for f in items if isinstance(items, list) else []:
        try:
            start, end = int(f.get('start', 0)), int(f.get('end', 0))
        except (TypeError, ValueError):
            continue
        if end <= start or end > length:
            continue
        out.append(make_feature(f.get('label') or f.get('name') or 'feature', start, end,
                                -1 if f.get('strand') == -1 else 1, f.get('type') or 'misc_feature'))
    return out


def open_part(part_id: str) -> Optional[Dict[str, Any]]:
    """A MoClo part as an editor document: the insert plus its two overhangs."""
    conn = _connect(parts_db_path())
    if conn is None:
        return None
    try:
        row = conn.execute('SELECT * FROM parts WHERE id = ?', (part_id,)).fetchone()
        if row is None:
            return None
        keys = row.keys()
        seq = row['sequence']
        doc = make_document(row['name'], seq, False,
                            _features_to_documents(row['features'] if 'features' in keys else None, len(seq)),
                            description=row['description'] or '')
        doc['source'] = {'tool': 'moclo', 'kind': 'part', 'id': row['id'],
                         'part_type': row['part_type'],
                         'overhang_5prime': row['overhang_5prime'],
                         'overhang_3prime': row['overhang_3prime']}
        doc['golden_gate'] = True
        return doc
    finally:
        conn.close()


def list_plasmids() -> List[Dict[str, Any]]:
    """Assembled plasmids and backbones from the MoClo main database."""
    conn = _connect(moclo_db_path())
    if conn is None:
        return []
    out = []
    try:
        for table, kind in (('final_plasmids', 'plasmid'), ('backbones', 'backbone')):
            if not _table_exists(conn, table):
                continue
            cols = _columns(conn, table)
            seq_col = 'assembled_sequence' if 'assembled_sequence' in cols else 'sequence'
            if seq_col not in cols:
                continue
            sql = f'SELECT id, name, length({seq_col}) AS length FROM {table} ORDER BY name'
            for r in conn.execute(sql):
                out.append({'id': r['id'], 'name': r['name'], 'length': r['length'], 'kind': kind})
    finally:
        conn.close()
    return out


def open_plasmid(kind: str, plasmid_id: str) -> Optional[Dict[str, Any]]:
    table = 'final_plasmids' if kind == 'plasmid' else 'backbones'
    conn = _connect(moclo_db_path())
    if conn is None:
        return None
    try:
        if not _table_exists(conn, table):
            return None
        cols = _columns(conn, table)
        seq_col = 'assembled_sequence' if 'assembled_sequence' in cols else 'sequence'
        row = conn.execute(f'SELECT * FROM {table} WHERE id = ?', (plasmid_id,)).fetchone()
        if row is None:
            return None
        seq = row[seq_col]
        keys = row.keys()
        feats = _features_to_documents(row['features'] if 'features' in keys else None, len(seq))
        doc = make_document(row['name'], seq, True, feats,
                            description=(row['description'] if 'description' in keys else '') or '')
        doc['source'] = {'tool': 'moclo', 'kind': kind, 'id': row['id']}
        return doc
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# Writing: contribute a Golden Gate ready plasmid to the MoClo parts library
# ---------------------------------------------------------------------------

class ContributionError(ValueError):
    pass


def contribute_part(doc: Dict[str, Any], contributor: str, lab_source: str,
                    part_type: Optional[str] = None, name: Optional[str] = None,
                    enzyme: Optional[str] = None, description: Optional[str] = None,
                    metadata: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """
    Insert the Golden Gate insert of `doc` into the shared MoClo parts library.

    Raises ContributionError when the plasmid is not Golden Gate ready, the
    shared database is not mounted, or a part with the same name and overhangs
    already exists.
    """
    path = parts_db_path()
    if not os.path.exists(path):
        raise ContributionError('the shared MoClo parts database is not mounted on this server')

    analysis = goldengate.analyze(doc, [enzyme] if enzyme else None)
    best = analysis['best']
    if not best:
        reasons = '; '.join(f"{c['enzyme']}: {c['reason']}" for c in analysis['candidates'] if c.get('reason'))
        raise ContributionError('this plasmid does not release a single clean Golden Gate insert'
                                + (f' ({reasons})' if reasons else ''))

    insert = best['insert']
    # MoClo stores a part with both fusion sites included.
    sequence = insert['part_sequence'].upper()
    if any(b not in 'ATCG' for b in sequence):
        raise ContributionError('the insert contains ambiguous bases; MoClo parts must be unambiguous A/T/C/G')
    if len(sequence) < 8:
        raise ContributionError('the insert is shorter than 8 bp')

    part_name = (name or doc.get('name') or '').strip()
    if not part_name:
        raise ContributionError('a part name is required')
    if not (lab_source or '').strip():
        raise ContributionError('a lab source is required')
    ptype = part_type or goldengate.suggest_part_type(doc, insert['start'], insert['length'])
    if ptype not in PART_TYPES:
        raise ContributionError(f'invalid part type: {ptype}')

    features = goldengate.moclo_features(doc, insert['start'], insert['part_length'])
    meta = dict(metadata or {})
    conn = _connect(path, read_only=False)
    try:
        if not _table_exists(conn, 'parts'):
            raise ContributionError('the shared parts database has no parts table yet; '
                                    'start the MoClo Library Tool once to create it')
        dup = conn.execute(
            'SELECT id FROM parts WHERE name = ? AND overhang_5prime = ? AND overhang_3prime = ?',
            (part_name, insert['overhang_5prime'], insert['overhang_3prime'])).fetchone()
        if dup is not None:
            raise ContributionError(f'a part named "{part_name}" with the same overhangs already exists '
                                    'in the MoClo library')
        cols = set(_columns(conn, 'parts'))
        row = {
            'id': str(uuid.uuid4()),
            'name': part_name,
            'part_type': ptype,
            'sequence': sequence,
            'overhang_5prime': insert['overhang_5prime'],
            'overhang_3prime': insert['overhang_3prime'],
            'lab_source': lab_source.strip(),
            'contributor': contributor,
            'description': (description if description is not None else doc.get('description')) or None,
            'size': len(doc['sequence']),
            'features': json.dumps(features) if features else None,
            'comments': f"Contributed from the Plasmid Editor; insert released by {best['enzyme']}.",
        }
        for key in ('plasmid_id', 'location_80', 'location_96_plate', 'antibiotic', 'level', 'unit',
                    'donor_organism', 'reference', 'host_strain', 'sequenced', 'ori_ecoli', 'ori_agro',
                    'primer_for_seq'):
            if meta.get(key):
                row[key] = str(meta[key])
        row = {k: v for k, v in row.items() if k in cols}
        placeholders = ', '.join('?' for _ in row)
        conn.execute(f'INSERT INTO parts ({", ".join(row)}) VALUES ({placeholders})', list(row.values()))
        conn.commit()
    finally:
        conn.close()

    return {'part_id': row['id'], 'name': part_name, 'part_type': ptype, 'enzyme': best['enzyme'],
            'overhang_5prime': insert['overhang_5prime'], 'overhang_3prime': insert['overhang_3prime'],
            'length': len(sequence), 'features': len(features),
            'standard_moclo': best.get('standard_moclo', False)}
