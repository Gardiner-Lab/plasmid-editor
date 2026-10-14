"""Signing in through the Gardiner Lab suite.

With SUITE_AUTH=proxy, the suite's proxy says who is signed in, in an
X-Suite-User header it sets on every request (and strips from what the browser
sends). The editor then has no sign-in of its own: before each request the
session is made to match that header, so everything that reads the session
keeps working. Signing out of the suite signs out here at the next request.
Registration, labs, their codes and roles are the suite's too: the editor's
own pages for them send people to the suite's, and who is in which lab is read
from the suite (app/models/suite_labs.py).

Only enable this behind the suite's proxy. Reachable directly, anyone could set
the header themselves.

    SUITE_AUTH         "proxy" to take the signed-in user from the proxy
    SUITE_LOGIN_URL    the suite's sign-in page        (default /account/login)
    SUITE_LOGOUT_URL   the suite's sign-out address    (default /account/logout)
    SUITE_REGISTER_URL the suite's registration page   (default /account/register)
    SUITE_DASHBOARD_URL the suite's dashboard           (default /account/)
"""

import os
from typing import Optional
from urllib.parse import quote

from flask import request, session

from app.models.user import User, mirror_shared_account, shared_account

HEADER = 'X-Suite-User'


def enabled() -> bool:
    return os.environ.get('SUITE_AUTH', '').strip().lower() == 'proxy'


def login_url(next_path: Optional[str] = None) -> str:
    base = os.environ.get('SUITE_LOGIN_URL', '').strip() or '/account/login'
    return f'{base}?next={quote(next_path, safe="/")}' if next_path else base


def logout_url() -> str:
    return os.environ.get('SUITE_LOGOUT_URL', '').strip() or '/account/logout'


def register_url() -> str:
    return os.environ.get('SUITE_REGISTER_URL', '').strip() or '/account/register'


def dashboard_url(tab: str = '') -> str:
    base = os.environ.get('SUITE_DASHBOARD_URL', '').strip() or '/account/'
    return f'{base}#{tab}' if tab else base


def admin_url() -> str:
    """Labs, codes and roles: a tab of the suite's dashboard."""
    return dashboard_url('labs')


def follow_suite_sign_in() -> None:
    """Make the editor's session match whoever the suite says is signed in."""
    if not enabled():
        return
    username = request.headers.get(HEADER, '').strip()
    if not username:
        if session:
            session.clear()
        return
    account = shared_account(username)
    if (session.get('username') == username and session.get('user_id')
            and (account is None or bool(session.get('is_admin')) == account['is_admin'])):
        return
    # Someone new, or made an administrator (or no longer one) in another tool:
    # bring their local row up to date from the directory, as signing in here
    # used to, so what they own can point at them.
    user = mirror_shared_account(account) if account else User.get_by_username(username)
    session.clear()
    if user is None:
        return
    session['user_id'] = user.id
    session['username'] = user.username
    session['is_admin'] = user.is_admin
    session['role'] = user.role
    session.permanent = True
