"""
Administration: labs, their registration codes, and who has which role.

Administrators manage everything here. Lab leads see their own lab, its
members and its registration code (so they can hand it out), but only an
administrator can create labs, set or change codes, or change roles.
"""

from flask import Blueprint, jsonify, request

from app.models.lab import Lab
from app.models.user import ROLES, User
from app.services import registration
from app.services.auth import require_admin, require_lab_admin

admin_bp = Blueprint('admin', __name__)


@admin_bp.before_request
def managed_by_the_suite():
    """Inside the lab suite, labs, codes and roles are managed on its own page."""
    from app.services import suite_auth
    if suite_auth.enabled():
        return jsonify({'error': 'Labs, codes and roles are managed on the lab tools '
                                 'dashboard', 'admin_url': suite_auth.admin_url()}), 403


def _user_row(u: User) -> dict:
    return {'username': u.username, 'lab': u.lab_source, 'role': u.role,
            'created_at': u.created_at}


def _lab_row(lab: Lab, with_code: bool) -> dict:
    return dict(lab.to_dict(with_code=with_code), members=lab.member_count())


@admin_bp.route('/overview', methods=['GET'])
@require_lab_admin
def overview(user):
    """What this person may see: everything for an admin, their own lab for a lead."""
    if user.is_admin:
        labs = Lab.all()
        users = User.get_all()
    else:
        own = Lab.by_name(user.lab_source or '')
        labs = [own] if own else []
        users = [u for u in User.get_all() if user.same_lab(u)]
    return jsonify({
        'me': {'username': user.username, 'role': user.role, 'lab': user.lab_source},
        'can_manage_labs': user.is_admin,
        'codes_required': registration.code_required(),
        'min_code_length': registration.MIN_CODE_LENGTH,
        'labs': [_lab_row(lab, with_code=True) for lab in labs],
        'users': [_user_row(u) for u in users],
        'roles': list(ROLES),
    })


def _lab_or_404(lab_id):
    lab = Lab.get(lab_id)
    if lab is None:
        return None, (jsonify({'error': 'No such lab'}), 404)
    return lab, None


@admin_bp.route('/labs', methods=['POST'])
@require_admin
def create_lab(user):
    data = request.get_json(silent=True) or {}
    try:
        lab = Lab.create(data.get('name', ''))
        if data.get('code'):
            registration.set_code(lab, data['code'], user.username)
    except ValueError as exc:
        return jsonify({'error': str(exc)}), 400
    return jsonify({'lab': _lab_row(Lab.get(lab.id), with_code=True)}), 201


@admin_bp.route('/labs/<lab_id>', methods=['PATCH'])
@require_admin
def rename_lab(user, lab_id):
    lab, error = _lab_or_404(lab_id)
    if error:
        return error
    try:
        lab.rename((request.get_json(silent=True) or {}).get('name', ''))
    except ValueError as exc:
        return jsonify({'error': str(exc)}), 400
    return jsonify({'lab': _lab_row(Lab.get(lab.id), with_code=True)})


@admin_bp.route('/labs/<lab_id>', methods=['DELETE'])
@require_admin
def delete_lab(user, lab_id):
    lab, error = _lab_or_404(lab_id)
    if error:
        return error
    try:
        lab.delete()
    except ValueError as exc:
        return jsonify({'error': str(exc)}), 400
    return jsonify({'ok': True})


@admin_bp.route('/labs/<lab_id>/code', methods=['PUT'])
@require_admin
def set_lab_code(user, lab_id):
    """Set or change a lab's code; an empty one closes that lab to new members."""
    lab, error = _lab_or_404(lab_id)
    if error:
        return error
    try:
        registration.set_code(lab, (request.get_json(silent=True) or {}).get('code'),
                              user.username)
    except ValueError as exc:
        return jsonify({'error': str(exc)}), 400
    return jsonify({'lab': _lab_row(Lab.get(lab.id), with_code=True)})


@admin_bp.route('/codes/suggest', methods=['GET'])
@require_admin
def suggest_code(user):
    """A fresh, unused code that is easy to read out; nothing is saved."""
    return jsonify({'code': registration.generate_code()})


def _target_or_404(username):
    target = User.get_by_username(username)
    if target is None:
        return None, (jsonify({'error': 'No such account'}), 404)
    return target, None


@admin_bp.route('/users/<username>/role', methods=['PUT'])
@require_admin
def set_role(user, username):
    target, error = _target_or_404(username)
    if error:
        return error
    role = (request.get_json(silent=True) or {}).get('role')
    if target.id == user.id and role != 'admin':
        return jsonify({'error': 'You cannot remove your own administrator role'}), 400
    if role == 'lab_lead' and not target.lab_source:
        return jsonify({'error': f'{target.username} has no lab yet; give them one first'}), 400
    try:
        target.set_role(role)
    except ValueError as exc:
        return jsonify({'error': str(exc)}), 400
    return jsonify({'user': _user_row(target)})


@admin_bp.route('/users/<username>/lab', methods=['PUT'])
@require_admin
def set_user_lab(user, username):
    target, error = _target_or_404(username)
    if error:
        return error
    lab = Lab.get((request.get_json(silent=True) or {}).get('lab_id') or '')
    if lab is None:
        return jsonify({'error': 'Choose one of the labs'}), 400
    target.set_lab_source(lab.name)
    return jsonify({'user': _user_row(target)})
