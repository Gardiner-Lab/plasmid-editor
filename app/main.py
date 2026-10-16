"""
Plasmid Editor - Flask application entry point.

A companion to the MoClo Library Tool: general-purpose plasmid editing,
annotation, restriction analysis, cloning simulation and sequencing alignment,
for work that is not Golden Gate based or needs manual DNA manipulation.
"""

import os
from datetime import timedelta

from flask import Flask, redirect, render_template, request, session, url_for

APP_VERSION = '0.4.0'

_DEFAULT_SECRET = 'dev-secret-key-change-in-production'


class PrefixMiddleware:
    """
    Mount the application under a URL prefix (URL_PREFIX, e.g. /editor).

    The suite's reverse proxy passes the full path through, so the prefix is
    moved from PATH_INFO into SCRIPT_NAME here. Flask's url_for then generates
    prefixed links, and the app still works unprefixed when URL_PREFIX is unset.
    """

    def __init__(self, wsgi_app, prefix: str):
        self.wsgi_app = wsgi_app
        self.prefix = '/' + prefix.strip('/')

    def __call__(self, environ, start_response):
        path = environ.get('PATH_INFO', '')
        if path == self.prefix or path.startswith(self.prefix + '/'):
            environ['SCRIPT_NAME'] = environ.get('SCRIPT_NAME', '') + self.prefix
            environ['PATH_INFO'] = path[len(self.prefix):] or '/'
        return self.wsgi_app(environ, start_response)


def create_app() -> Flask:
    from app.services import suite_auth

    app = Flask(__name__)

    app.config['SECRET_KEY'] = os.environ.get('SECRET_KEY', _DEFAULT_SECRET)
    app.config['PERMANENT_SESSION_LIFETIME'] = timedelta(days=14)
    app.config['SESSION_COOKIE_HTTPONLY'] = True
    app.config['SESSION_COOKIE_SAMESITE'] = 'Lax'
    # Behind the suite proxy this app shares a hostname with the MoClo tool,
    # which also uses Flask's default cookie name at path "/". Giving this app
    # its own name and scoping the cookie to its prefix keeps the two logins
    # from overwriting each other.
    app.config['SESSION_COOKIE_NAME'] = os.environ.get('SESSION_COOKIE_NAME', 'plasmid_editor_session')
    _prefix = os.environ.get('URL_PREFIX', '').strip('/')
    if _prefix:
        app.config['SESSION_COOKIE_PATH'] = f'/{_prefix}'
    app.config['MAX_CONTENT_LENGTH'] = 64 * 1024 * 1024
    if os.environ.get('FLASK_ENV') == 'production':
        if app.config['SECRET_KEY'] == _DEFAULT_SECRET:
            raise RuntimeError(
                'SECRET_KEY is unset. Set it to a random value before running in production, '
                'e.g. SECRET_KEY=$(openssl rand -hex 32).')
        app.config['SESSION_COOKIE_SECURE'] = (
            os.environ.get('SESSION_COOKIE_SECURE', 'true').lower() not in ('0', 'false', 'no'))

    from app.models import initialize_database
    from app.models.sequence import StoredSequence
    from app.models.user import ensure_default_admin, sync_accounts
    from app.services import moclo_bridge
    initialize_database(os.environ.get('EDITOR_DATABASE_PATH', '/data/plasmid_editor.db'))
    # A plasmid counts as sequenced only while a read the user judged
    # sufficient backs it; clear any confirmation made before that rule, here
    # and in MoClo.
    moclo_bridge.clear_withdrawn(StoredSequence.withdraw_unsupported())
    if not os.environ.get('EDITOR_SKIP_SEED'):
        ensure_default_admin()
    # Accounts made here before the lab tools shared them go into the shared
    # directory, and accounts already in that directory (an existing MoClo
    # instance) become users here, so every account works in every tool.
    sync_accounts()
    from app.services.registration import prepare_labs
    prepare_labs()

    @app.context_processor
    def inject_globals():
        # MOCLO_BASE_URL points at the MoClo Library Tool: "/" when it sits at
        # the root of the same host (the suite), or a full URL when it is
        # elsewhere. Unset means there is no MoClo tool to link to, and the
        # links are hidden rather than pointing nowhere.
        raw = (os.environ.get('MOCLO_BASE_URL')
               or os.environ.get('MOCLO_URL', '')).strip()
        base = raw.rstrip('/')
        # SUITE_HOME_URL is the lab suite's launch page ("/" behind the suite's
        # proxy). Unset, as when the editor runs on its own, hides the link.
        suite_home = os.environ.get('SUITE_HOME_URL', '').strip()
        return {
            'app_version': APP_VERSION,
            'suite_home': suite_home,
            # Lab Stocks (glycerol stocks and primers): "/stocks" in the suite;
            # unset, the editor's links and buttons for it are hidden.
            'stocks_url': os.environ.get('STOCKS_URL', '').strip().rstrip('/'),
            # Inside the suite, its dashboard has every account and admin control.
            'suite_dashboard': suite_auth.dashboard_url() if suite_auth.enabled() else '',
            'moclo': {
                'enabled': bool(raw),
                'base': base,
                'library': f'{base}/parts',
                'assembly': f'{base}/assembly',
                'protocol': f'{base}/protocol',
            },
        }

    # Inside the suite (SUITE_AUTH=proxy), the suite's sign-in decides who is
    # signed in here; see app/services/suite_auth.py.
    app.before_request(suite_auth.follow_suite_sign_in)

    from app.api import admin_bp, auth_bp, library_bp, moclo_bp, sequences_bp, tools_bp, workspace_bp
    app.register_blueprint(auth_bp, url_prefix='/api/auth')
    app.register_blueprint(admin_bp, url_prefix='/api/admin')
    app.register_blueprint(sequences_bp, url_prefix='/api/sequences')
    app.register_blueprint(tools_bp, url_prefix='/api/tools')
    app.register_blueprint(moclo_bp, url_prefix='/api/moclo')
    app.register_blueprint(library_bp, url_prefix='/api/library')
    app.register_blueprint(workspace_bp, url_prefix='/api/workspace')

    def _page(template: str):
        if 'user_id' not in session:
            return redirect(url_for('login_page'))
        return render_template(template)

    @app.route('/')
    def index():
        return redirect(url_for('editor_page') if 'user_id' in session else url_for('login_page'))

    @app.route('/login')
    def login_page():
        if 'user_id' in session:
            return redirect(url_for('editor_page'))
        # Inside the suite, people sign in and register on the suite's pages.
        if suite_auth.enabled():
            if 'register' in request.args:
                return redirect(suite_auth.register_url())
            return redirect(suite_auth.login_url(request.args.get('next') or url_for('editor_page')))
        return render_template('login.html')

    @app.route('/logout')
    def logout_page():
        session.clear()
        if suite_auth.enabled():
            # Signing out of the suite signs out of every tool.
            return redirect(suite_auth.logout_url())
        return redirect(url_for('login_page'))

    @app.route('/editor')
    def editor_page():
        return _page('editor.html')

    @app.route('/library')
    def library_page():
        return _page('library.html')

    @app.route('/cloning')
    def cloning_page():
        return _page('cloning.html')

    @app.route('/sequencing')
    def sequencing_page():
        return _page('sequencing.html')

    @app.route('/features')
    def features_page():
        return _page('features.html')

    @app.route('/admin')
    def admin_page():
        from app.services.auth import current_user
        user = current_user()
        if user is None:
            return redirect(url_for('login_page'))
        if not user.can_administer:
            return redirect(url_for('editor_page'))
        # Inside the suite, labs, codes and roles are managed on its own page.
        if suite_auth.enabled():
            return redirect(suite_auth.admin_url())
        return render_template('admin.html')

    @app.route('/about')
    def about_page():
        return render_template('about.html')

    @app.route('/health')
    def health():
        from app.services import moclo_bridge
        return {'status': 'healthy', 'version': APP_VERSION, 'moclo': moclo_bridge.available()}

    prefix = os.environ.get('URL_PREFIX', '').strip('/')
    if prefix:
        app.wsgi_app = PrefixMiddleware(app.wsgi_app, prefix)

    return app


app = create_app()

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=int(os.environ.get('PORT', 5001)), debug=True)
