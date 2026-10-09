"""Browse the shared MoClo Library Tool databases and open their entries in the editor."""

from flask import Blueprint, jsonify, request

from app.models.sequence import StoredSequence
from app.services import moclo_bridge
from app.services.auth import require_auth

moclo_bp = Blueprint('moclo', __name__)


@moclo_bp.route('/status', methods=['GET'])
@require_auth
def status(user):
    return jsonify({'available': moclo_bridge.available(),
                    'parts_db': moclo_bridge.parts_db_path(),
                    'plasmids_db': moclo_bridge.moclo_db_path(),
                    'part_types': moclo_bridge.PART_TYPES}), 200


@moclo_bp.route('/parts', methods=['GET'])
@require_auth
def parts(user):
    return jsonify({'parts': moclo_bridge.list_parts(
        search=request.args.get('search', ''),
        part_type=request.args.get('part_type', ''))}), 200


@moclo_bp.route('/parts/<part_id>', methods=['GET'])
@require_auth
def part(user, part_id):
    doc = moclo_bridge.open_part(part_id)
    if doc is None:
        return jsonify({'error': 'Part not found in the MoClo library'}), 404
    return jsonify({'document': doc}), 200


@moclo_bp.route('/plasmids', methods=['GET'])
@require_auth
def plasmids(user):
    return jsonify({'plasmids': moclo_bridge.list_plasmids()}), 200


@moclo_bp.route('/plasmids/<kind>/<plasmid_id>', methods=['GET'])
@require_auth
def plasmid(user, kind, plasmid_id):
    if kind not in ('plasmid', 'backbone'):
        return jsonify({'error': 'Unknown kind'}), 400
    doc = moclo_bridge.open_plasmid(kind, plasmid_id)
    if doc is None:
        return jsonify({'error': 'Not found in the MoClo database'}), 404
    return jsonify({'document': doc}), 200


@moclo_bp.route('/import', methods=['POST'])
@require_auth
def import_into_editor(user):
    """Copy a MoClo part or plasmid into the editor's own library for editing."""
    data = request.get_json(silent=True) or {}
    kind, item_id = data.get('kind'), data.get('id')
    if kind == 'part':
        doc = moclo_bridge.open_part(item_id)
    elif kind in ('plasmid', 'backbone'):
        doc = moclo_bridge.open_plasmid(kind, item_id)
    else:
        return jsonify({'error': 'kind must be part, plasmid or backbone'}), 400
    if doc is None:
        return jsonify({'error': 'Not found in the MoClo databases'}), 404
    try:
        saved = StoredSequence.create(doc, user.id,
                                      golden_gate=bool(doc.get('golden_gate')),
                                      origin=f'moclo:{kind}:{item_id}')
    except ValueError as exc:
        return jsonify({'error': str(exc)}), 400
    return jsonify({'sequence': saved}), 201
