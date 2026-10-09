"""The lab's feature library: list, add, import and export ApE-format libraries."""

import io

from flask import Blueprint, jsonify, request, send_file

from app.services import library as library_service
from app.services.auth import require_auth
from dnakit import features, model

library_bp = Blueprint('library', __name__)
MAX_LIBRARY_BYTES = 8 * 1024 * 1024


@library_bp.route('', methods=['GET'])
@require_auth
def list_entries(user):
    return jsonify({'builtin': library_service.builtin_library(),
                    'custom': library_service.stored_library(user.id)}), 200


@library_bp.route('', methods=['POST'])
@require_auth
def add_entries(user):
    data = request.get_json(silent=True) or {}
    entries = data.get('entries')
    if entries is None and data.get('document') and data.get('feature_id'):
        doc = model.normalize_document(data['document'])
        match = next((f for f in doc['features'] if f['id'] == data['feature_id']), None)
        if match is None:
            return jsonify({'error': 'Feature not found in the document'}), 404
        entries = [features.library_entry_from_feature(doc, match)]
    if not entries:
        return jsonify({'error': 'No feature entries given'}), 400
    added = library_service.add_entries(entries, user.id)
    return jsonify({'added': added}), 201


@library_bp.route('/import', methods=['POST'])
@require_auth
def import_library(user):
    f = request.files.get('file')
    if f is None:
        return jsonify({'error': 'No file uploaded'}), 400
    data = f.read(MAX_LIBRARY_BYTES + 1)
    if len(data) > MAX_LIBRARY_BYTES:
        return jsonify({'error': 'Library file is larger than 8 MB'}), 400
    try:
        text = data.decode('utf-8')
    except UnicodeDecodeError:
        text = data.decode('latin-1')
    entries = features.parse_library(text)
    if not entries:
        return jsonify({'error': 'No usable entries found; expected a tab-separated ApE feature library'}), 400
    return jsonify({'added': library_service.add_entries(entries, user.id),
                    'parsed': len(entries)}), 201


@library_bp.route('/export', methods=['GET'])
@require_auth
def export_library(user):
    entries = library_service.default_library(user.id)
    buf = io.BytesIO(features.write_library(entries).encode('utf-8'))
    return send_file(buf, mimetype='text/tab-separated-values', as_attachment=True,
                     download_name='feature_library.txt')


@library_bp.route('/<entry_id>', methods=['DELETE'])
@require_auth
def delete_entry(user, entry_id):
    if not library_service.delete_entry(entry_id):
        return jsonify({'error': 'Entry not found'}), 404
    return jsonify({'ok': True}), 200
