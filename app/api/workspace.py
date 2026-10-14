"""
The sequences someone has open in the editor, kept until they sign out.

The editor saves its open tabs here as they change (unsaved edits included)
and reopens them when it next loads, so reloading the page, visiting another
tool and coming back, or closing the browser tab loses nothing. They belong to
one sign-in, and the next sign-in starts with nothing open. Inside the suite
the key is the suite's id for the sign-in (X-Suite-Session, from the proxy),
so signing out anywhere ends them however soon someone signs back in; on its
own, the editor keeps a token in its session, which signing out clears.
Another browser signed in as the same person has its own.
"""

import json
import uuid

from flask import Blueprint, jsonify, request, session

from app.models.database import get_connection
from app.services.auth import require_auth

workspace_bp = Blueprint('workspace', __name__)

# What one sign-in may keep open: generous, but a bound.
MAX_BYTES = 20 * 1024 * 1024
MAX_DOCUMENTS = 30
# Workspaces of sign-ins that ended without signing out (a closed browser) go
# after this long.
KEEP_DAYS = 30


def _token() -> str:
    """This sign-in's workspace: the suite's id for it, or one kept in the session."""
    from app.services import suite_auth
    if suite_auth.enabled():
        suite_session = request.headers.get('X-Suite-Session', '').strip()
        if suite_session:
            return f'suite:{suite_session}'
    if not session.get('workspace'):
        session['workspace'] = uuid.uuid4().hex
    return session['workspace']


@workspace_bp.route('', methods=['GET'])
@require_auth
def get_workspace(user):
    with get_connection() as conn:
        row = conn.execute('SELECT state FROM workspaces WHERE user_id = ? AND token = ?',
                           (user.id, _token())).fetchone()
    return jsonify({'workspace': json.loads(row['state']) if row else None}), 200


@workspace_bp.route('', methods=['PUT', 'POST'])      # POST: sendBeacon, as the page closes
@require_auth
def save_workspace(user):
    raw = request.get_data(cache=False)
    if len(raw) > MAX_BYTES:
        return jsonify({'error': 'Too much open to remember; close some sequences'}), 413
    try:
        data = json.loads(raw or b'{}')
    except ValueError:
        return jsonify({'error': 'Send the workspace as JSON'}), 400
    docs = data.get('docs')
    if not isinstance(docs, list) or len(docs) > MAX_DOCUMENTS:
        return jsonify({'error': f'Send at most {MAX_DOCUMENTS} open sequences'}), 400
    if not all(isinstance(d, dict) and isinstance(d.get('sequence'), str) for d in docs):
        return jsonify({'error': 'Each open sequence needs its bases'}), 400
    active = data.get('active') if isinstance(data.get('active'), int) else 0
    state = json.dumps({'docs': docs, 'active': max(0, min(active, len(docs) - 1))})
    with get_connection() as conn:
        conn.execute('INSERT INTO workspaces (user_id, token, state, updated_at) '
                     'VALUES (?, ?, ?, CURRENT_TIMESTAMP) '
                     'ON CONFLICT(user_id, token) DO UPDATE SET state = excluded.state, '
                     'updated_at = CURRENT_TIMESTAMP', (user.id, _token(), state))
        conn.execute("DELETE FROM workspaces WHERE updated_at < datetime('now', ?)", (f'-{KEEP_DAYS} days',))
    return jsonify({'ok': True}), 200
