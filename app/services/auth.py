"""Session handling and route protection.

Sessions live in the signed Flask cookie, so the app stays stateless across
gunicorn workers and container restarts.
"""

from functools import wraps
from typing import Any, Callable, Optional

from flask import jsonify, session

from app.models.user import User, authenticate


def login(username: str, password: str) -> Optional[User]:
    # Credentials are checked against the suite's shared account directory
    # first, so one account works across the tools.
    user = authenticate(username, password)
    if user is None:
        return None
    session.clear()
    session['user_id'] = user.id
    session['username'] = user.username
    session['is_admin'] = user.is_admin
    session.permanent = True
    return user


def logout() -> None:
    session.clear()


def current_user() -> Optional[User]:
    user_id = session.get('user_id')
    if not user_id:
        return None
    user = User.get_by_id(user_id)
    if user is None:
        session.clear()
    return user


def require_auth(f: Callable) -> Callable:
    """Pass the authenticated user as the first argument, or return 401."""
    @wraps(f)
    def wrapper(*args: Any, **kwargs: Any) -> Any:
        user = current_user()
        if user is None:
            return jsonify({'error': 'Authentication required'}), 401
        return f(user, *args, **kwargs)
    return wrapper


def require_admin(f: Callable) -> Callable:
    @wraps(f)
    def wrapper(*args: Any, **kwargs: Any) -> Any:
        user = current_user()
        if user is None:
            return jsonify({'error': 'Authentication required'}), 401
        if not user.is_admin:
            return jsonify({'error': 'Administrator access required'}), 403
        return f(user, *args, **kwargs)
    return wrapper
