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

import hashlib
import json
import os
import sqlite3
import uuid
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple

from dnakit import goldengate
from dnakit.model import make_document, make_feature

PART_TYPES = goldengate.PART_TYPES

# Which MoClo table each link kind maps to, and where its sequence lives.
_LINK_TABLES = {
    'part': ('parts', 'sequence', 'parts'),
    'backbone': ('backbones', 'sequence', 'moclo'),
    'plasmid': ('final_plasmids', 'assembled_sequence', 'moclo'),
}


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


# ---------------------------------------------------------------------------
# Keeping an edited sequence and its MoClo record in step
# ---------------------------------------------------------------------------

class SyncConflict(Exception):
    """The MoClo record changed since the editor last synced with it."""

    def __init__(self, message: str, moclo: Dict[str, Any]):
        super().__init__(message)
        self.moclo = moclo


def parse_link(link: Optional[str]) -> Optional[Tuple[str, str]]:
    """'part:abc123' -> ('part', 'abc123'); None when unlinked or malformed."""
    if not link or ':' not in link:
        return None
    kind, _, record_id = link.partition(':')
    return (kind, record_id) if kind in _LINK_TABLES and record_id else None


def _db_for(kind: str) -> str:
    return parts_db_path() if _LINK_TABLES[kind][2] == 'parts' else moclo_db_path()


def content_hash(name: str, sequence: str, features: Any) -> str:
    """
    Fingerprint of the fields the editor owns, so a change made in MoClo can be
    told apart from one made here. Feature order is normalised, so reordering
    alone is not reported as a change.
    """
    if isinstance(features, str):
        try:
            features = json.loads(features) if features else []
        except ValueError:
            features = []
    normalised = sorted(
        (f.get('label') or f.get('name') or '', f.get('type') or '',
         int(f.get('start', 0)), int(f.get('end', 0)), int(f.get('strand', 1) or 1))
        for f in (features or []) if isinstance(f, dict))
    payload = json.dumps([name or '', (sequence or '').upper(), normalised], separators=(',', ':'))
    return hashlib.sha256(payload.encode()).hexdigest()


def read_record(kind: str, record_id: str) -> Optional[Dict[str, Any]]:
    """The raw MoClo row plus its content hash, or None when it is gone."""
    if kind not in _LINK_TABLES:
        return None
    table, seq_col, _ = _LINK_TABLES[kind]
    conn = _connect(_db_for(kind))
    if conn is None:
        return None
    try:
        if not _table_exists(conn, table):
            return None
        row = conn.execute(f'SELECT * FROM {table} WHERE id = ?', (record_id,)).fetchone()
        if row is None:
            return None
        keys = row.keys()
        features = row['features'] if 'features' in keys else None
        return {
            'kind': kind, 'id': record_id, 'name': row['name'],
            'sequence': row[seq_col], 'features': features,
            'length': len(row[seq_col] or ''),
            'hash': content_hash(row['name'], row[seq_col], features),
            'row': {k: row[k] for k in keys},
        }
    finally:
        conn.close()


def link_status(link: Optional[str], synced_hash: Optional[str],
                doc: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """
    Describe a link for the interface: whether the MoClo record still exists,
    whether it changed since the last sync, and whether the editor copy differs.
    """
    parsed = parse_link(link)
    if not parsed:
        return {'linked': False}
    kind, record_id = parsed
    record = read_record(kind, record_id)
    if record is None:
        return {'linked': True, 'kind': kind, 'id': record_id, 'exists': False,
                'moclo_changed': False, 'local_changed': False}
    local_hash = content_hash(doc['name'], doc['sequence'], doc.get('features')) if doc else None
    return {
        'linked': True, 'kind': kind, 'id': record_id, 'exists': True,
        'name': record['name'], 'length': record['length'],
        'moclo_changed': bool(synced_hash) and record['hash'] != synced_hash,
        'local_changed': bool(local_hash) and local_hash != record['hash'],
        'hash': record['hash'],
    }


def _moclo_features(doc: Dict[str, Any]) -> List[Dict[str, Any]]:
    """Editor features in the shape MoClo stores."""
    return [{'type': f.get('type') or 'misc_feature', 'label': f.get('name') or 'feature',
             'start': int(f['start']), 'end': int(f['end']), 'strand': int(f.get('strand', 1) or 1)}
            for f in (doc.get('features') or [])
            if isinstance(f, dict) and f.get('end', 0) > f.get('start', -1)]


def push_to_moclo(link: str, doc: Dict[str, Any], expected_hash: Optional[str],
                  editor_user: str = '', force: bool = False) -> Dict[str, Any]:
    """
    Write an edited sequence back to the MoClo record it is linked to.

    Raises SyncConflict when the MoClo record changed since `expected_hash` was
    recorded, unless `force` is set. Returns the new sync state.
    """
    parsed = parse_link(link)
    if not parsed:
        raise ContributionError('this sequence is not linked to a MoClo record')
    kind, record_id = parsed
    table, seq_col, _ = _LINK_TABLES[kind]

    path = _db_for(kind)
    if not os.path.exists(path):
        raise ContributionError('the shared MoClo database is not mounted on this server')

    current = read_record(kind, record_id)
    if current is None:
        raise ContributionError(
            f'the linked MoClo {kind} no longer exists; it may have been deleted there')
    if expected_hash and current['hash'] != expected_hash and not force:
        raise SyncConflict(
            f'"{current["name"]}" was also changed in the MoClo tool since this sequence '
            'was last synced', current)

    sequence = (doc['sequence'] or '').upper()
    if kind == 'part':
        if any(b not in 'ATCG' for b in sequence):
            raise ContributionError('a MoClo part must be unambiguous A/T/C/G')
        if len(sequence) < 8:
            raise ContributionError('a MoClo part must be at least 8 bp')

    features = _moclo_features(doc)
    conn = _connect(path, read_only=False)
    try:
        cols = set(_columns(conn, table))
        update: Dict[str, Any] = {'name': doc['name'], seq_col: sequence}
        if 'features' in cols:
            update['features'] = json.dumps(features)
        if 'description' in cols and doc.get('description') is not None:
            update['description'] = doc.get('description') or None

        note = (f'Edited in the Plasmid Editor'
                f'{" by " + editor_user if editor_user else ""} on '
                f'{datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")}.')
        if 'comments' in cols:
            update['comments'] = note
        elif 'metadata' in cols:
            # final_plasmids keeps a JSON metadata blob rather than comments.
            try:
                meta = json.loads(current['row'].get('metadata') or '{}')
            except (TypeError, ValueError):
                meta = {}
            meta['edited_externally'] = note
            update['metadata'] = json.dumps(meta)

        # A part is stored as its insert with both fusion sites, so its
        # overhangs are simply its first and last four bases.
        if kind == 'part':
            if 'overhang_5prime' in cols:
                update['overhang_5prime'] = sequence[:4]
            if 'overhang_3prime' in cols:
                update['overhang_3prime'] = sequence[-4:]
        elif 'size' in cols:
            update['size'] = len(sequence)

        assignments = ', '.join(f'{c} = ?' for c in update)
        conn.execute(f'UPDATE {table} SET {assignments} WHERE id = ?',
                     [*update.values(), record_id])
        conn.commit()
    finally:
        conn.close()

    return {'kind': kind, 'id': record_id,
            'hash': content_hash(doc['name'], sequence, features),
            'name': doc['name'], 'length': len(sequence)}


def record_verification(link: str, doc: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """
    Write a confirmed sequencing result into the MoClo record's own
    "sequenced" field, which is what the MoClo tool shows for that column.

    This touches only that one field (plus a comment), never the sequence, so
    it is independent of the edit sync and needs no conflict check.
    """
    parsed = parse_link(link)
    if not parsed:
        return None
    kind, record_id = parsed
    table, _, _ = _LINK_TABLES[kind]
    path = _db_for(kind)
    if not os.path.exists(path):
        raise ContributionError('the shared MoClo database is not mounted on this server')

    when = (doc.get('confirmed_at') or '')[:10]
    clone = doc.get('confirmed_clone')
    stock = doc.get('glycerol_stock')
    summary = _VERIFICATION_PREFIX
    if when:
        summary += f' {when}'
    if clone:
        summary += f', clone {clone}'
    if stock:
        summary += f', glycerol stock {stock}'

    conn = _connect(path, read_only=False)
    try:
        if not _table_exists(conn, table):
            raise ContributionError(f'the MoClo {table} table does not exist yet')
        cols = set(_columns(conn, table))
        update: Dict[str, Any] = {}
        if 'sequenced' in cols:
            update['sequenced'] = summary
        if 'comments' in cols:
            update['comments'] = summary + (f' (confirmed by {doc.get("confirmed_by")}'
                                            ' in the Plasmid Editor).'
                                            if doc.get('confirmed_by') else '.')
        if not update:
            return None
        assignments = ', '.join(f'{c} = ?' for c in update)
        cur = conn.execute(f'UPDATE {table} SET {assignments} WHERE id = ?',
                           [*update.values(), record_id])
        if cur.rowcount == 0:
            raise ContributionError(f'the linked MoClo {kind} no longer exists')
        conn.commit()
    finally:
        conn.close()
    return {'kind': kind, 'id': record_id, 'sequenced': summary}


_VERIFICATION_PREFIX = 'Sequence confirmed'


def clear_verification(link: str) -> Optional[Dict[str, Any]]:
    """
    Undo record_verification when a confirmation is withdrawn: clear the MoClo
    record's "sequenced" field and the comment, but only where they still hold
    the text the editor wrote, so anything entered in MoClo itself is kept.
    """
    parsed = parse_link(link)
    if not parsed:
        return None
    kind, record_id = parsed
    table, _, _ = _LINK_TABLES[kind]
    path = _db_for(kind)
    if not os.path.exists(path):
        raise ContributionError('the shared MoClo database is not mounted on this server')

    conn = _connect(path, read_only=False)
    try:
        if not _table_exists(conn, table):
            raise ContributionError(f'the MoClo {table} table does not exist yet')
        info = {r['name']: r for r in conn.execute(f'PRAGMA table_info({table})')}
        fields = [c for c in ('sequenced', 'comments') if c in info]
        if not fields:
            return None
        row = conn.execute(f'SELECT {", ".join(fields)} FROM {table} WHERE id = ?',
                           (record_id,)).fetchone()
        if row is None:
            raise ContributionError(f'the linked MoClo {kind} no longer exists')
        update: Dict[str, Any] = {}
        for c in fields:
            if (row[c] or '').startswith(_VERIFICATION_PREFIX):
                update[c] = '' if info[c]['notnull'] else None
        if update:
            assignments = ', '.join(f'{c} = ?' for c in update)
            conn.execute(f'UPDATE {table} SET {assignments} WHERE id = ?',
                         [*update.values(), record_id])
            conn.commit()
    finally:
        conn.close()
    return {'kind': kind, 'id': record_id, 'cleared': sorted(update)}


def clear_withdrawn(withdrawn: List[Dict[str, Any]]) -> Optional[str]:
    """
    Clear the MoClo status of plasmids whose confirmation was withdrawn. The
    withdrawal itself stands either way; a problem reaching MoClo is returned
    as a note for the user rather than raised.
    """
    note = None
    for doc in withdrawn:
        if not doc.get('moclo_link'):
            continue
        try:
            clear_verification(doc['moclo_link'])
        except ContributionError as exc:
            note = f'MoClo still shows it as sequenced: {exc}'
    return note


def pull_from_moclo(link: str) -> Dict[str, Any]:
    """The MoClo record as an editor document, for discarding local changes."""
    parsed = parse_link(link)
    if not parsed:
        raise ContributionError('this sequence is not linked to a MoClo record')
    kind, record_id = parsed
    record = read_record(kind, record_id)
    if record is None:
        raise ContributionError(f'the linked MoClo {kind} no longer exists')
    doc = open_part(record_id) if kind == 'part' else open_plasmid(kind, record_id)
    if doc is None:
        raise ContributionError('could not read the MoClo record')
    return {'document': doc, 'hash': record['hash']}
