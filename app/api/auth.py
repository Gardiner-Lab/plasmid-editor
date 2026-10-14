"""Authentication endpoints."""

import os

from flask import Blueprint, jsonify, request

from app.models.user import register as register_account, shared_directory_available
from app.services import auth as auth_service
from app.services import registration, suite_auth

auth_bp = Blueprint('auth', __name__)


def _registration_open() -> bool:
    return os.environ.get('ALLOW_REGISTRATION', 'true').lower() not in ('0', 'false', 'no')


@auth_bp.route('/register', methods=['POST'])
def register():
    if suite_auth.enabled():
        return jsonify({'error': 'Accounts are created on the lab tools registration page',
                        'register_url': suite_auth.register_url()}), 403
    if not _registration_open():
        return jsonify({'error': 'Registration is closed on this server'}), 403
    data = request.get_json(silent=True) or {}
    # The lab chosen, and that lab's own registration code.
    lab, refused, status = registration.check(
        str(data.get('lab_source') or registration.default_lab_name()),
        str(data.get('registration_code') or ''))
    if refused:
        return jsonify({'error': refused}), status
    # With a shared account directory, the account is created there and works
    # in every lab tool.
    try:
        user = register_account(data.get('username', ''), data.get('password', ''), lab)
    except ValueError as exc:
        return jsonify({'error': str(exc)}), 400
    auth_service.login(data.get('username', ''), data.get('password', ''))
    return jsonify({'user': user.to_dict()}), 201


@auth_bp.route('/login', methods=['POST'])
def login():
    if suite_auth.enabled():
        return jsonify({'error': 'Sign in on the lab tools sign-in page',
                        'login_url': suite_auth.login_url()}), 403
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
    shared = shared_directory_available()
    return jsonify({'authenticated': user is not None,
                    'user': user.to_dict() if user else None,
                    'shared_accounts': shared,
                    'registration_open': _registration_open(),
                    'registration_code_required': registration.code_required()
                    and registration.anyone_registered(),
                    'default_lab': registration.default_lab_name()}), 200


@auth_bp.route('/labs', methods=['GET'])
def labs():
    """The labs someone can join, for the registration form; never their codes."""
    from app.models.lab import Lab
    return jsonify({'labs': [{'name': lab.name, 'open': bool(lab.registration_code)}
                             for lab in Lab.all()]}), 200


@auth_bp.route('/profile', methods=['PATCH'])
@auth_service.require_auth
def update_profile(user):
    data = request.get_json(silent=True) or {}
    if 'lab_source' in data and suite_auth.enabled():
        return jsonify({'error': 'Your lab is set on the lab tools dashboard',
                        'admin_url': suite_auth.admin_url()}), 403
    if 'lab_source' in data:
        user.set_lab_source(str(data['lab_source']))
    return jsonify({'user': user.to_dict()}), 200
