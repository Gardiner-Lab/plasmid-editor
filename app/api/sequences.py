"""Sequence library: upload, open, edit, save, export, and MoClo contribution."""

import io
import json
import zipfile

from flask import Blueprint, jsonify, request, send_file

from app.models.sequence import Read, StoredSequence
from app.services import moclo_bridge
from app.services.auth import require_auth
from dnakit import align, goldengate, model, seqio

sequences_bp = Blueprint('sequences', __name__)

MAX_UPLOAD_BYTES = 32 * 1024 * 1024


def _owned_or_404(sequence_id, user, for_write=False):
    doc = StoredSequence.get(sequence_id)
    if doc is None:
        return None, (jsonify({'error': 'Sequence not found'}), 404)
    if for_write and doc['owner_id'] != user.id and not user.is_admin:
        return None, (jsonify({'error': 'Only the owner can change this sequence'}), 403)
    if not doc['shared'] and doc['owner_id'] != user.id and not user.is_admin:
        return None, (jsonify({'error': 'This sequence is private'}), 403)
    return doc, None


@sequences_bp.route('/parse', methods=['POST'])
@require_auth
def parse_upload(user):
    """Parse uploaded files without saving, so the editor can open them immediately."""
    files = request.files.getlist('file')
    if not files:
        return jsonify({'error': 'No file uploaded'}), 400
    docs, errors = [], []
    for f in files:
        data = f.read(MAX_UPLOAD_BYTES + 1)
        if len(data) > MAX_UPLOAD_BYTES:
            errors.append({'filename': f.filename, 'error': 'File is larger than 32 MB'})
            continue
        try:
            for doc in seqio.read_sequences(data, f.filename or ''):
                doc['origin'] = f.filename
                docs.append(doc)
        except seqio.SequenceFileError as exc:
            errors.append({'filename': f.filename, 'error': str(exc)})
    if not docs and errors:
        return jsonify({'error': errors[0]['error'], 'errors': errors}), 400
    return jsonify({'documents': docs, 'errors': errors}), 200


@sequences_bp.route('', methods=['GET'])
@require_auth
def list_sequences(user):
    return jsonify({'sequences': StoredSequence.list_visible(
        user.id,
        search=request.args.get('search', ''),
        golden_gate_only=request.args.get('golden_gate') == 'true',
        mine_only=request.args.get('mine') == 'true')}), 200


@sequences_bp.route('', methods=['POST'])
@require_auth
def create_sequence(user):
    data = request.get_json(silent=True) or {}
    doc = data.get('document') or data
    try:
        saved = StoredSequence.create(doc, user.id,
                                      golden_gate=bool(data.get('golden_gate')),
                                      golden_gate_enzyme=data.get('golden_gate_enzyme'),
                                      origin=data.get('origin'),
                                      shared=data.get('shared', True) is not False)
    except ValueError as exc:
        return jsonify({'error': str(exc)}), 400
    return jsonify({'sequence': saved}), 201


@sequences_bp.route('/<sequence_id>', methods=['GET'])
@require_auth
def get_sequence(user, sequence_id):
    doc, err = _owned_or_404(sequence_id, user)
    if err:
        return err
    doc['reads'] = Read.list_for(sequence_id)
    return jsonify({'sequence': doc}), 200


@sequences_bp.route('/<sequence_id>', methods=['PUT', 'PATCH'])
@require_auth
def update_sequence(user, sequence_id):
    """
    Save a sequence. When it is linked to a MoClo record, the change is written
    back to MoClo in the same step so the two stay consistent.

    If the MoClo record was also changed since this sequence last synced, the
    save is refused with 409 and the caller chooses what to do; `force: true`
    then overwrites MoClo with the editor's version.
    """
    existing, err = _owned_or_404(sequence_id, user, for_write=True)
    if err:
        return err
    data = request.get_json(silent=True) or {}
    try:
        updated = StoredSequence.update(
            sequence_id,
            doc=data.get('document'),
            golden_gate=data.get('golden_gate'),
            golden_gate_enzyme=data.get('golden_gate_enzyme'),
            shared=data.get('shared'))
    except ValueError as exc:
        return jsonify({'error': str(exc)}), 400

    link = updated.get('moclo_link')
    if not link or data.get('sync') is False:
        return jsonify({'sequence': updated}), 200

    try:
        result = moclo_bridge.push_to_moclo(
            link, updated, updated.get('moclo_synced_hash'),
            editor_user=user.username, force=bool(data.get('force')))
    except moclo_bridge.SyncConflict as conflict:
        # The local save stands; only the push to MoClo is held back.
        return jsonify({
            'error': str(conflict),
            'conflict': True,
            'sequence': updated,
            'moclo': {k: conflict.moclo[k] for k in ('kind', 'id', 'name', 'length', 'hash')},
        }), 409
    except moclo_bridge.ContributionError as exc:
        return jsonify({'error': str(exc), 'sequence': updated, 'sync_failed': True}), 409

    updated = StoredSequence.update(sequence_id, moclo_synced_hash=result['hash'])
    return jsonify({'sequence': updated, 'synced_to_moclo': result}), 200


@sequences_bp.route('/<sequence_id>/moclo', methods=['GET'])
@require_auth
def moclo_link_status(user, sequence_id):
    """Whether this sequence is linked to MoClo, and whether the two differ."""
    doc, err = _owned_or_404(sequence_id, user)
    if err:
        return err
    return jsonify(moclo_bridge.link_status(
        doc.get('moclo_link'), doc.get('moclo_synced_hash'), doc)), 200


@sequences_bp.route('/<sequence_id>/moclo/pull', methods=['POST'])
@require_auth
def moclo_pull(user, sequence_id):
    """Replace this sequence with the MoClo version, discarding local changes."""
    doc, err = _owned_or_404(sequence_id, user, for_write=True)
    if err:
        return err
    if not doc.get('moclo_link'):
        return jsonify({'error': 'This sequence is not linked to a MoClo record'}), 400
    try:
        pulled = moclo_bridge.pull_from_moclo(doc['moclo_link'])
    except moclo_bridge.ContributionError as exc:
        return jsonify({'error': str(exc)}), 400
    updated = StoredSequence.update(sequence_id, doc=pulled['document'],
                                    moclo_synced_hash=pulled['hash'])
    return jsonify({'sequence': updated}), 200


@sequences_bp.route('/<sequence_id>/moclo/unlink', methods=['POST'])
@require_auth
def moclo_unlink(user, sequence_id):
    """Stop syncing: the sequence stays here, the MoClo record is left as it is."""
    doc, err = _owned_or_404(sequence_id, user, for_write=True)
    if err:
        return err
    if not doc.get('moclo_link'):
        return jsonify({'error': 'This sequence is not linked to a MoClo record'}), 400
    updated = StoredSequence.update(sequence_id, moclo_link='', moclo_synced_hash='')
    return jsonify({'sequence': updated}), 200


@sequences_bp.route('/<sequence_id>', methods=['DELETE'])
@require_auth
def delete_sequence(user, sequence_id):
    _, err = _owned_or_404(sequence_id, user, for_write=True)
    if err:
        return err
    StoredSequence.delete(sequence_id)
    return jsonify({'ok': True}), 200


# ---------------------------------------------------------------------------
# Export
# ---------------------------------------------------------------------------

def _download(text: str, filename: str, mimetype: str = 'chemical/seq-na-genbank'):
    buf = io.BytesIO(text.encode('utf-8'))
    return send_file(buf, mimetype=mimetype, as_attachment=True, download_name=filename)


def _safe(name: str) -> str:
    return ''.join(c if c.isalnum() or c in '-_.' else '_' for c in name) or 'sequence'


@sequences_bp.route('/<sequence_id>/export/<fmt>', methods=['GET'])
@require_auth
def export_sequence(user, sequence_id, fmt):
    doc, err = _owned_or_404(sequence_id, user)
    if err:
        return err
    name = _safe(doc['name'])
    if fmt in ('genbank', 'gb'):
        return _download(seqio.write_genbank(doc), f'{name}.gb')
    if fmt in ('fasta', 'fa'):
        return _download(seqio.write_fasta(doc), f'{name}.fasta', 'text/x-fasta')
    if fmt == 'json':
        return _download(json.dumps(doc, indent=2), f'{name}.json', 'application/json')
    return jsonify({'error': f'Unsupported format: {fmt}'}), 400


@sequences_bp.route('/convert', methods=['POST'])
@require_auth
def convert(user):
    """
    Write an in-editor document out as a file without saving it to the library.

    This is what "Save as -> download" uses, so a sequence that was never saved
    can still be exported.
    """
    data = request.get_json(silent=True) or {}
    try:
        doc = model.normalize_document(data.get('document') or {})
    except ValueError as exc:
        return jsonify({'error': str(exc)}), 400
    if not doc['sequence']:
        return jsonify({'error': 'The sequence is empty'}), 400
    fmt = (data.get('format') or 'genbank').lower()
    name = _safe(doc['name'])
    if fmt in ('genbank', 'gb'):
        return _download(seqio.write_genbank(doc), f'{name}.gb')
    if fmt in ('fasta', 'fa'):
        return _download(seqio.write_fasta(doc), f'{name}.fasta', 'text/x-fasta')
    if fmt == 'json':
        return _download(json.dumps(doc, indent=2), f'{name}.json', 'application/json')
    return jsonify({'error': f'Unsupported format: {fmt}'}), 400


@sequences_bp.route('/export/bundle', methods=['POST'])
@require_auth
def export_bundle(user):
    """Several sequences as one zip of GenBank files."""
    ids = (request.get_json(silent=True) or {}).get('ids') or []
    if not ids:
        return jsonify({'error': 'No sequences selected'}), 400
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, 'w', zipfile.ZIP_DEFLATED) as zf:
        for sid in ids[:200]:
            doc, err = _owned_or_404(sid, user)
            if err:
                continue
            zf.writestr(f'{_safe(doc["name"])}.gb', seqio.write_genbank(doc))
    buf.seek(0)
    return send_file(buf, mimetype='application/zip', as_attachment=True,
                     download_name='sequences.zip')


# ---------------------------------------------------------------------------
# Golden Gate readiness and MoClo contribution
# ---------------------------------------------------------------------------

@sequences_bp.route('/golden-gate/analyze', methods=['POST'])
@require_auth
def analyze_golden_gate(user):
    """Check an in-editor document (unsaved is fine) for a releasable part."""
    data = request.get_json(silent=True) or {}
    try:
        doc = model.normalize_document(data.get('document') or {})
    except ValueError as exc:
        return jsonify({'error': str(exc)}), 400
    enzymes = data.get('enzymes') or None
    result = goldengate.analyze(doc, enzymes)
    if result['best']:
        insert = result['best']['insert']
        result['suggested_part_type'] = goldengate.suggest_part_type(doc, insert['start'], insert['part_length'])
        result['suggested_features'] = goldengate.moclo_features(doc, insert['start'], insert['part_length'])
    result['moclo_available'] = moclo_bridge.available()
    return jsonify(result), 200


@sequences_bp.route('/<sequence_id>/contribute', methods=['POST'])
@require_auth
def contribute_to_moclo(user, sequence_id):
    """Add a Golden Gate ready plasmid to the shared MoClo parts library."""
    doc, err = _owned_or_404(sequence_id, user)
    if err:
        return err
    if not doc['golden_gate']:
        return jsonify({'error': 'Mark this plasmid as Golden Gate ready before contributing it'}), 400
    data = request.get_json(silent=True) or {}
    lab_source = (data.get('lab_source') or user.lab_source or '').strip()
    if not lab_source:
        return jsonify({'error': 'A lab source is required; set one in your profile or in this form'}), 400
    try:
        result = moclo_bridge.contribute_part(
            doc, contributor=user.username, lab_source=lab_source,
            part_type=data.get('part_type'), name=data.get('name'),
            enzyme=data.get('enzyme') or doc.get('golden_gate_enzyme'),
            description=data.get('description'), metadata=data.get('metadata'))
    except moclo_bridge.ContributionError as exc:
        return jsonify({'error': str(exc)}), 400
    # Link the sequence to the part it became, so later edits flow through.
    record = moclo_bridge.read_record('part', result['part_id'])
    StoredSequence.update(sequence_id, moclo_part_id=result['part_id'],
                          golden_gate_enzyme=result['enzyme'],
                          moclo_link=f"part:{result['part_id']}",
                          moclo_synced_hash=record['hash'] if record else None)
    return jsonify({'contributed': result}), 201


# ---------------------------------------------------------------------------
# Sequencing reads
# ---------------------------------------------------------------------------

@sequences_bp.route('/<sequence_id>/reads', methods=['GET'])
@require_auth
def list_reads(user, sequence_id):
    _, err = _owned_or_404(sequence_id, user)
    if err:
        return err
    return jsonify({'reads': Read.list_for(sequence_id)}), 200


@sequences_bp.route('/<sequence_id>/reads', methods=['POST'])
@require_auth
def upload_reads(user, sequence_id):
    """Attach sequencing reads (.ab1 or FASTA) and align them to the sequence."""
    doc, err = _owned_or_404(sequence_id, user)
    if err:
        return err
    files = request.files.getlist('file')
    if not files:
        return jsonify({'error': 'No file uploaded'}), 400
    added, errors = [], []
    for f in files:
        data = f.read(MAX_UPLOAD_BYTES + 1)
        if len(data) > MAX_UPLOAD_BYTES:
            errors.append({'filename': f.filename, 'error': 'File is larger than 32 MB'})
            continue
        name = f.filename or 'read'
        try:
            if name.lower().endswith(('.ab1', '.abi')):
                trace = seqio.read_trace(data)
                reads = [(trace['name'] or name, trace['sequence'], trace['quality'], trace)]
            else:
                reads = [(d['name'], d['sequence'], None, None) for d in seqio.read_sequences(data, name)]
        except seqio.SequenceFileError as exc:
            errors.append({'filename': name, 'error': str(exc)})
            continue
        for read_name, bases, quality, trace in reads:
            alignment = align.map_read(doc['sequence'], bases, doc['circular'], quality, read_name)
            stored = Read.create(sequence_id, read_name, bases, quality, trace, alignment, user.username)
            added.append(dict(stored, alignment=alignment))
    if not added and errors:
        return jsonify({'error': errors[0]['error'], 'errors': errors}), 400
    return jsonify({'reads': added, 'errors': errors}), 201


@sequences_bp.route('/<sequence_id>/reads/realign', methods=['POST'])
@require_auth
def realign_reads(user, sequence_id):
    """Re-align every stored read, after the reference sequence was edited."""
    doc, err = _owned_or_404(sequence_id, user, for_write=True)
    if err:
        return err
    results = []
    for r in Read.list_for(sequence_id):
        full = Read.get(r['id'], include_trace=True)
        alignment = align.map_read(doc['sequence'], full['bases'], doc['circular'],
                                   full['quality'], full['name'])
        Read.delete(r['id'])
        Read.create(sequence_id, full['name'], full['bases'], full['quality'],
                    full.get('trace'), alignment, full['uploaded_by'])
        results.append({'name': full['name'], 'alignment': alignment})
    return jsonify({'reads': results,
                    'coverage': align.coverage(len(doc['sequence']),
                                               [r['alignment'] for r in results])}), 200


@sequences_bp.route('/reads/<read_id>', methods=['GET'])
@require_auth
def get_read(user, read_id):
    read = Read.get(read_id, include_trace=request.args.get('trace') == 'true')
    if read is None:
        return jsonify({'error': 'Read not found'}), 404
    _, err = _owned_or_404(read['sequence_id'], user)
    if err:
        return err
    return jsonify({'read': read}), 200


@sequences_bp.route('/reads/<read_id>', methods=['DELETE'])
@require_auth
def delete_read(user, read_id):
    read = Read.get(read_id, include_trace=False)
    if read is None:
        return jsonify({'error': 'Read not found'}), 404
    _, err = _owned_or_404(read['sequence_id'], user, for_write=True)
    if err:
        return err
    Read.delete(read_id)
    return jsonify({'ok': True}), 200
