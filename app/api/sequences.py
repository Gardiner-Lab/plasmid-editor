"""Sequence library: upload, open, edit, save, export, and MoClo contribution."""

import io
import json
import zipfile

from flask import Blueprint, jsonify, request, send_file

from app.models.sequence import Read, StoredSequence
from app.models.user import User
from app.services import moclo_bridge
from app.services.auth import require_auth
from dnakit import align, clones, goldengate, model, seqio

sequences_bp = Blueprint('sequences', __name__)

MAX_UPLOAD_BYTES = 32 * 1024 * 1024


def _owned_or_404(sequence_id, user, for_write=False):
    doc = StoredSequence.get(sequence_id)
    if doc is None:
        return None, (jsonify({'error': 'Sequence not found'}), 404)
    if for_write and doc['owner_id'] != user.id and not user.oversees(doc['owner_id']):
        return None, (jsonify({'error': 'Only the owner can change this sequence'}), 403)
    if not user.can_see_sequence(doc['owner_id']):
        return None, (jsonify({'error': 'This sequence belongs to a lab outside your chair group'}), 403)
    return doc, None


def _sequencing_viewable_or_404(sequence_id, user):
    """
    Sequencing results (reads and their alignments) are seen by whoever sees
    the plasmid: its owner's chair group. Changing them stays with the owner.
    """
    doc = StoredSequence.get(sequence_id)
    if doc is None:
        return None, (jsonify({'error': 'Sequence not found'}), 404)
    if not user.can_see_sequence(doc['owner_id']):
        return None, (jsonify({'error': 'This sequence belongs to a lab outside your chair group'}), 403)
    return doc, None


def _can_change(doc, user) -> bool:
    # The owner, an administrator, or the lead of the owner's lab.
    return doc['owner_id'] == user.id or user.oversees(doc['owner_id'])


def _can_add_reads(doc, user) -> bool:
    # The owner's own labs add reads (and contribute it to MoClo); the rest of
    # the chair group looks.
    return _can_change(doc, user) or user.same_lab(User.get_by_id(doc['owner_id']))


def _not_your_labs():
    return jsonify({'error': "Only the owner's lab adds to this sequence; the rest of the chair group sees it read-only"}), 403


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
        user,
        search=request.args.get('search', ''),
        golden_gate_only=request.args.get('golden_gate') == 'true',
        mine_only=request.args.get('mine') == 'true',
        # Kept for older pages: a lab's plasmids are always seen within it.
        with_sequenced=request.args.get('sequencing') == 'true')}), 200


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
                                      # Seen by the owner's chair group; a "public" an
                                      # older page still sends is ignored.
                                      created_by=user.username)
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
    doc['can_change'] = _can_change(doc, user)
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

    A change to the content is kept in the sequence's history. With
    `base_revision`, the revision the caller started from, a save over a newer
    one (someone else saved, or corrected it to a read, meanwhile) is refused
    with 409 and `stale`, so it is not lost unseen. `revision`, {kind, note},
    says how the change came about: a save ('saved') or a correction to a
    sequencing read ('corrected').
    """
    existing, err = _owned_or_404(sequence_id, user, for_write=True)
    if err:
        return err
    data = request.get_json(silent=True) or {}
    base = data.get('base_revision')
    if data.get('document') is not None and base is not None and str(base) != str(existing['revision']):
        latest = (StoredSequence.history(sequence_id) or [None])[0]
        return jsonify({
            'error': 'This sequence was changed since you opened it'
                     + (f" ({latest['changed_by']}, {latest['created_at']})"
                        if latest and latest.get('changed_by') else ''),
            'stale': True, 'latest': latest, 'sequence': existing,
        }), 409
    revision = data.get('revision') if isinstance(data.get('revision'), dict) else {}
    kind = revision.get('kind') if revision.get('kind') in ('saved', 'corrected') else 'saved'
    try:
        updated = StoredSequence.update(
            sequence_id,
            doc=data.get('document'),
            golden_gate=data.get('golden_gate'),
            golden_gate_enzyme=data.get('golden_gate_enzyme'),
            shared=data.get('shared'),
            changed_by=user.username, revision_kind=kind,
            revision_note=str(revision.get('note') or '')[:500] or None)
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
                                    moclo_synced_hash=pulled['hash'],
                                    changed_by=user.username, revision_kind='moclo',
                                    revision_note='Replaced with the MoClo version')
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

def _download(content, filename: str, mimetype: str = 'chemical/seq-na-genbank'):
    buf = io.BytesIO(content if isinstance(content, bytes) else content.encode('utf-8'))
    return send_file(buf, mimetype=mimetype, as_attachment=True, download_name=filename)


def _write(doc, fmt: str, name: str):
    """A document as a download in one of the export formats, or None for an unknown one."""
    if fmt in ('genbank', 'gb'):
        return _download(seqio.write_genbank(doc), f'{name}.gb')
    if fmt in ('snapgene', 'dna'):
        return _download(seqio.write_snapgene(doc), f'{name}.dna', 'application/octet-stream')
    if fmt in ('fasta', 'fa'):
        return _download(seqio.write_fasta(doc), f'{name}.fasta', 'text/x-fasta')
    if fmt == 'json':
        return _download(json.dumps(doc, indent=2), f'{name}.json', 'application/json')
    return None


def _safe(name: str) -> str:
    return ''.join(c if c.isalnum() or c in '-_.' else '_' for c in name) or 'sequence'


@sequences_bp.route('/<sequence_id>/export/<fmt>', methods=['GET'])
@require_auth
def export_sequence(user, sequence_id, fmt):
    doc, err = _owned_or_404(sequence_id, user)
    if err:
        return err
    response = _write(doc, fmt, _safe(doc['name']))
    if response is None:
        return jsonify({'error': f'Unsupported format: {fmt}'}), 400
    return response


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
    response = _write(doc, fmt, _safe(doc['name']))
    if response is not None:
        return response
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
    if not _can_add_reads(doc, user):
        return _not_your_labs()
    if not doc['golden_gate']:
        return jsonify({'error': 'Mark this sequence as Golden Gate ready before contributing it'}), 400
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
    _, err = _sequencing_viewable_or_404(sequence_id, user)
    if err:
        return err
    return jsonify({'reads': Read.list_for(sequence_id)}), 200


@sequences_bp.route('/<sequence_id>/clones', methods=['GET'])
@require_auth
def compare_clones(user, sequence_id):
    """
    The reads of each clone, compared against each other. One read cannot tell a real
    mutation from a bad basecall; where several reads of one clone cover the same base they
    can, so each difference is reported with the reads that cover it and the reads that
    show it.
    """
    doc, err = _sequencing_viewable_or_404(sequence_id, user)
    if err:
        return err
    reads = []
    for r in Read.list_for(sequence_id):
        reads.append({'id': r['id'], 'name': r['name'], 'clone_number': r.get('clone_number'),
                      'alignment': r.get('alignment') or {}})
    return jsonify({'clones': clones.compare_clones(len(doc['sequence']), reads)}), 200


@sequences_bp.route('/<sequence_id>/reads', methods=['POST'])
@require_auth
def upload_reads(user, sequence_id):
    """Attach sequencing reads (.ab1 or FASTA) and align them to the sequence."""
    doc, err = _owned_or_404(sequence_id, user)
    if err:
        return err
    if not _can_add_reads(doc, user):
        return _not_your_labs()
    files = request.files.getlist('file')
    if not files:
        return jsonify({'error': 'No file uploaded'}), 400
    clone_number = (request.form.get('clone_number') or '').strip() or None
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
            stored = Read.create(sequence_id, read_name, bases, quality, trace, alignment,
                                 user.username, clone_number=clone_number)
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
    results = _realign(doc)
    return jsonify({'reads': results,
                    'coverage': align.coverage(len(doc['sequence']),
                                               [r['alignment'] for r in results])}), 200


def _align_one(doc, read):
    """Align one read to the plasmid as its owner reads it - the instrument's bases with any hand
    calls laid over them - and store where it landed."""
    alignment = align.map_read(doc['sequence'], Read.called_bases(read), doc['circular'],
                               read['quality'], read['name'])
    Read.set_alignment(read['id'], alignment)
    return alignment


def _realign(doc):
    """
    Align a sequence's reads again, in place. Each read keeps its id, its clone, its verdict and its
    hand-called bases; only the alignment is replaced. (It used to be deleted and remade, which gave
    every read a new id and would have dropped the hand calls with it.)
    """
    results = []
    for r in Read.list_for(doc['id']):
        full = Read.get(r['id'], include_trace=False)
        results.append({'id': full['id'], 'name': full['name'],
                        'clone_number': full.get('clone_number'),
                        'alignment': _align_one(doc, full)})
    return results


@sequences_bp.route('/<sequence_id>/history', methods=['GET'])
@require_auth
def sequence_history(user, sequence_id):
    """Every saved version of the sequence, newest first: when, who and what changed."""
    doc, err = _sequencing_viewable_or_404(sequence_id, user)
    if err:
        return err
    return jsonify({'revisions': StoredSequence.history(sequence_id),
                    'current': doc['revision'],
                    'can_restore': _can_change(doc, user)}), 200


@sequences_bp.route('/<sequence_id>/history/<int:number>', methods=['GET'])
@require_auth
def sequence_revision(user, sequence_id, number):
    """One saved version's content, to look at or download."""
    doc, err = _sequencing_viewable_or_404(sequence_id, user)
    if err:
        return err
    revision = StoredSequence.revision(sequence_id, number)
    if revision is None:
        return jsonify({'error': 'No such version'}), 404
    return jsonify({'document': revision, 'number': number}), 200


@sequences_bp.route('/<sequence_id>/history/<int:number>/restore', methods=['POST'])
@require_auth
def restore_revision(user, sequence_id, number):
    """
    Roll the sequence back to a saved version. The rollback is itself a new
    version, so it can be undone the same way. Reads are aligned again, keeping
    their verdicts, and a sequence linked to MoClo is updated there too.
    """
    doc, err = _owned_or_404(sequence_id, user, for_write=True)
    if err:
        return err
    revision = StoredSequence.revision(sequence_id, number)
    if revision is None:
        return jsonify({'error': 'No such version'}), 404
    if number == doc['revision']:
        return jsonify({'error': 'This is already the current version'}), 400
    updated = StoredSequence.update(sequence_id, doc=revision, changed_by=user.username,
                                    revision_kind='restored',
                                    revision_note=f'Rolled back to version {number}')
    _realign(updated)
    synced = moclo_note = None
    if updated.get('moclo_link'):
        try:
            synced = moclo_bridge.push_to_moclo(updated['moclo_link'], updated,
                                                updated.get('moclo_synced_hash'),
                                                editor_user=user.username)
            updated = StoredSequence.update(sequence_id, moclo_synced_hash=synced['hash'])
        except (moclo_bridge.SyncConflict, moclo_bridge.ContributionError) as exc:
            moclo_note = str(exc)
    return jsonify({'sequence': updated, 'synced_to_moclo': synced,
                    'moclo_note': moclo_note}), 200


@sequences_bp.route('/reads/<read_id>/call', methods=['POST'])
@require_auth
def call_read_base(user, read_id):
    """
    Call one base of a read by hand, from the chromatogram. A basecaller commits to a letter even
    where the peak is obscured; someone reading the trace may judge it better. The instrument's own
    bases are kept untouched - the call is laid over them - and the read is aligned again, so a base
    called back to the reference stops being a difference everywhere it was counted. Send no base
    (or null) to withdraw the call and have the instrument's letter back.
    """
    read = Read.get(read_id, include_trace=False)
    if read is None:
        return jsonify({'error': 'Read not found'}), 404
    doc, err = _owned_or_404(read['sequence_id'], user, for_write=True)
    if err:
        return err
    data = request.get_json(silent=True) or {}
    try:
        position = int(data.get('position'))
    except (TypeError, ValueError):
        return jsonify({'error': 'Give the position in the read as a whole number'}), 400
    try:
        Read.set_call(read_id, position, data.get('base') or None, user.username)
    except ValueError as exc:
        return jsonify({'error': str(exc)}), 400
    updated = Read.get(read_id, include_trace=False)
    alignment = _align_one(doc, updated)
    reads = Read.list_for(doc['id'])
    return jsonify({
        'read': dict(Read.get(read_id, include_trace=False), alignment=alignment),
        'clone_comparison': clones.compare_clones(len(doc['sequence']), [
            {'id': r['id'], 'name': r['name'], 'clone_number': r.get('clone_number'),
             'alignment': r.get('alignment') or {}} for r in reads]),
    }), 200


@sequences_bp.route('/<sequence_id>/reads/clone', methods=['POST'])
@require_auth
def set_reads_clone(user, sequence_id):
    """
    Put reads into a clone: one of them, or several at once. Saying which colony a read came from is
    not a judgement about it, so the verdicts are left alone - correcting a clone number must not
    withdraw someone's "sufficient". An empty clone number takes the reads out of any clone.
    """
    doc, err = _owned_or_404(sequence_id, user, for_write=True)
    if err:
        return err
    data = request.get_json(silent=True) or {}
    ids = data.get('read_ids')
    if not isinstance(ids, list) or not ids:
        return jsonify({'error': 'Name the reads to put into the clone'}), 400
    clone = data.get('clone_number')
    mine = {r['id'] for r in Read.list_for(sequence_id)}
    missing = [i for i in ids if i not in mine]
    if missing:
        return jsonify({'error': 'Those reads are not on this sequence'}), 404
    updated = [Read.set_clone(i, clone) for i in ids]
    return jsonify({'reads': [r for r in updated if r],
                    'clone_comparison': clones.compare_clones(len(doc['sequence']), [
                        {'id': r['id'], 'name': r['name'], 'clone_number': r.get('clone_number'),
                         'alignment': r.get('alignment') or {}} for r in Read.list_for(sequence_id)])}), 200


@sequences_bp.route('/reads/<read_id>/verdict', methods=['POST'])
@require_auth
def set_read_verdict(user, read_id):
    """
    Record whether an alignment is good enough.

    Judging one sufficient confirms the plasmid, so it needs the glycerol stock
    the clone is kept as (`glycerol_stock`): without one the verdict is refused
    and nothing changes. With one, the verdict, the stock and the confirmation
    are recorded together, and MoClo is told the plasmid is sequenced.
    """
    read = Read.get(read_id, include_trace=False)
    if read is None:
        return jsonify({'error': 'Read not found'}), 404
    doc, err = _owned_or_404(read['sequence_id'], user, for_write=True)
    if err:
        return err
    data = request.get_json(silent=True) or {}
    stock = str(data.get('glycerol_stock') or '').strip()
    if data.get('verdict') == 'sufficient' and not stock:
        return jsonify({'error': 'Give the glycerol stock this clone is kept as: a sufficient '
                                 'alignment confirms the plasmid as sequenced'}), 400
    try:
        updated = Read.set_verdict(read_id, data.get('verdict'), user.username,
                                   data.get('note'), data.get('clone_number'))
    except ValueError as exc:
        return jsonify({'error': str(exc)}), 400
    synced = moclo_note = None
    if updated['verdict'] == 'sufficient':
        confirmed = StoredSequence.confirm(read['sequence_id'], user.username, stock,
                                           updated.get('clone_number'))
        if confirmed and confirmed.get('moclo_link'):
            try:
                synced = moclo_bridge.record_verification(confirmed['moclo_link'], confirmed)
            except moclo_bridge.ContributionError as exc:
                moclo_note = str(exc)
    withdrawn = StoredSequence.withdraw_unsupported(read['sequence_id'])
    moclo_note = moclo_bridge.clear_withdrawn(withdrawn) or moclo_note
    return jsonify({
        'read': updated,
        # Kept for older pages: a sufficient verdict now confirms at once.
        'needs_confirmation': False,
        'synced_to_moclo': synced,
        # No read judged sufficient is left, so the plasmid is no longer confirmed.
        'confirmation_withdrawn': bool(withdrawn),
        'moclo_note': moclo_note,
        'sequence': StoredSequence.get(read['sequence_id']),
    }), 200


@sequences_bp.route('/<sequence_id>/confirm', methods=['POST'])
@require_auth
def confirm_sequence(user, sequence_id):
    """
    Mark a plasmid as confirmed and sequenced, with the glycerol stock it is
    kept as. For a sequence linked to MoClo, the status is written into the
    MoClo record's own "sequenced" field as well.
    """
    doc, err = _owned_or_404(sequence_id, user, for_write=True)
    if err:
        return err
    data = request.get_json(silent=True) or {}
    try:
        updated = StoredSequence.confirm(sequence_id, user.username,
                                         data.get('glycerol_stock', ''),
                                         data.get('clone_number'))
    except ValueError as exc:
        return jsonify({'error': str(exc)}), 400
    if updated is None:
        return jsonify({'error': 'Sequence not found'}), 404

    synced = None
    if updated.get('moclo_link'):
        try:
            synced = moclo_bridge.record_verification(updated['moclo_link'], updated)
        except moclo_bridge.ContributionError as exc:
            return jsonify({'sequence': updated, 'moclo_note': str(exc)}), 200
    return jsonify({'sequence': updated, 'synced_to_moclo': synced}), 200


@sequences_bp.route('/<sequence_id>/confirm', methods=['DELETE'])
@require_auth
def unconfirm_sequence(user, sequence_id):
    doc, err = _owned_or_404(sequence_id, user, for_write=True)
    if err:
        return err
    updated = StoredSequence.unconfirm(sequence_id)
    if updated is None:
        return jsonify({'error': 'Sequence not found'}), 404
    # MoClo was told it was sequenced when it was confirmed; take that back.
    moclo_note = (moclo_bridge.clear_withdrawn([doc]) if doc['confirmed'] else None)
    return jsonify({'sequence': updated, 'moclo_note': moclo_note}), 200


@sequences_bp.route('/<sequence_id>/sequencing', methods=['GET'])
@require_auth
def sequencing_history(user, sequence_id):
    """
    Everything known about how this plasmid has been sequenced: every read,
    its clone, its verdict and its discrepancies. Open to every signed-in
    user; the plasmid's bases are included because an alignment shows them.
    """
    doc, err = _sequencing_viewable_or_404(sequence_id, user)
    if err:
        return err
    reads = Read.list_for(sequence_id)
    for r in reads:
        diffs = (r.get('alignment') or {}).get('differences') or []
        r['difference_count'] = len(diffs)
    sequence = {k: doc[k] for k in ('id', 'name', 'sequence', 'circular', 'shared', 'confirmed',
                                    'confirmed_at', 'confirmed_by', 'confirmed_clone',
                                    'glycerol_stock')}
    # The features too, so an alignment shows which of them a read covers.
    sequence.update(features=doc.get('features') or [],
                    feature_count=len(doc.get('features') or []),
                    can_change=_can_change(doc, user),
                    can_add_reads=_can_add_reads(doc, user))
    return jsonify({
        'sequence': sequence,
        'reads': reads,
        'clones': sorted({r['clone_number'] for r in reads if r.get('clone_number')}),
        # Each clone's reads compared against each other, so a difference every covering read
        # shows is told apart from one only a single read claims.
        'clone_comparison': clones.compare_clones(len(doc['sequence']), [
            {'id': r['id'], 'name': r['name'], 'clone_number': r.get('clone_number'),
             'alignment': r.get('alignment') or {}} for r in reads]),
        'summary': {
            'reads': len(reads),
            'mapped': sum(1 for r in reads if (r.get('alignment') or {}).get('mapped')),
            'sufficient': sum(1 for r in reads if r.get('verdict') == 'sufficient'),
            'insufficient': sum(1 for r in reads if r.get('verdict') == 'insufficient'),
            'with_differences': sum(1 for r in reads if r['difference_count']),
        },
    }), 200


@sequences_bp.route('/reads/<read_id>', methods=['GET'])
@require_auth
def get_read(user, read_id):
    read = Read.get(read_id, include_trace=request.args.get('trace') == 'true')
    if read is None:
        return jsonify({'error': 'Read not found'}), 404
    _, err = _sequencing_viewable_or_404(read['sequence_id'], user)
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
    withdrawn = StoredSequence.withdraw_unsupported(read['sequence_id'])
    return jsonify({'ok': True, 'confirmation_withdrawn': bool(withdrawn),
                    'moclo_note': moclo_bridge.clear_withdrawn(withdrawn)}), 200
