"""Authentication endpoints."""

import os

from flask import Blueprint, jsonify, request

from app.models.user import User
from app.services import auth as auth_service

auth_bp = Blueprint('auth', __name__)


def _registration_open() -> bool:
    return os.environ.get('ALLOW_REGISTRATION', 'true').lower() not in ('0', 'false', 'no')


@auth_bp.route('/register', methods=['POST'])
def register():
    if not _registration_open():
        return jsonify({'error': 'Registration is closed on this server'}), 403
    data = request.get_json(silent=True) or {}
    try:
        user = User.create(data.get('username', ''), data.get('password', ''),
                           data.get('lab_source', '') or os.environ.get('DEFAULT_LAB_SOURCE', ''),
                           is_admin=User.count() == 0)
    except ValueError as exc:
        return jsonify({'error': str(exc)}), 400
    auth_service.login(data.get('username', ''), data.get('password', ''))
    return jsonify({'user': user.to_dict()}), 201


@auth_bp.route('/login', methods=['POST'])
def login():
    data = request.get_json(silent=True) or {}
    user = auth_service.login(data.get('username', ''), data.get('password', ''))
    if user is None:
        return jsonify({'error': 'Invalid username or password'}), 401
    return jsonify({'user': user.to_dict()}), 200


@auth_bp.route('/logout', methods=['POST'])
def logout():
    auth_service.logout()
    return jsonify({'ok': True}), 200


@auth_bp.route('/session', methods=['GET'])
def session_status():
    user = auth_service.current_user()
    return jsonify({'authenticated': user is not None,
                    'user': user.to_dict() if user else None,
                    'registration_open': _registration_open()}), 200


@auth_bp.route('/profile', methods=['PATCH'])
@auth_service.require_auth
def update_profile(user):
    data = request.get_json(silent=True) or {}
    if 'lab_source' in data:
        user.set_lab_source(str(data['lab_source']))
    return jsonify({'user': user.to_dict()}), 200
