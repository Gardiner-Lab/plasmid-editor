"""
Plasmid Editor - Flask application entry point.

A companion to the MoClo Library Tool: general-purpose plasmid editing,
annotation, restriction analysis, cloning simulation and sequencing alignment,
for work that is not Golden Gate based or needs manual DNA manipulation.
"""

import os
from datetime import timedelta

from flask import Flask, redirect, render_template, session, url_for

APP_VERSION = '0.1.0'

_DEFAULT_SECRET = 'dev-secret-key-change-in-production'


def create_app() -> Flask:
    app = Flask(__name__)

    app.config['SECRET_KEY'] = os.environ.get('SECRET_KEY', _DEFAULT_SECRET)
    app.config['PERMANENT_SESSION_LIFETIME'] = timedelta(days=14)
    app.config['SESSION_COOKIE_HTTPONLY'] = True
    app.config['SESSION_COOKIE_SAMESITE'] = 'Lax'
    app.config['MAX_CONTENT_LENGTH'] = 64 * 1024 * 1024
    if os.environ.get('FLASK_ENV') == 'production':
        if app.config['SECRET_KEY'] == _DEFAULT_SECRET:
            raise RuntimeError(
                'SECRET_KEY is unset. Set it to a random value before running in production, '
                'e.g. SECRET_KEY=$(openssl rand -hex 32).')
        app.config['SESSION_COOKIE_SECURE'] = (
            os.environ.get('SESSION_COOKIE_SECURE', 'true').lower() not in ('0', 'false', 'no'))

    from app.models import initialize_database
    from app.models.user import ensure_default_admin
    initialize_database(os.environ.get('EDITOR_DATABASE_PATH', '/data/plasmid_editor.db'))
    if not os.environ.get('EDITOR_SKIP_SEED'):
        ensure_default_admin()

    @app.context_processor
    def inject_globals():
        return {'app_version': APP_VERSION,
                'moclo_url': os.environ.get('MOCLO_URL', '')}

    from app.api import auth_bp, library_bp, moclo_bp, sequences_bp, tools_bp
    app.register_blueprint(auth_bp, url_prefix='/api/auth')
    app.register_blueprint(sequences_bp, url_prefix='/api/sequences')
    app.register_blueprint(tools_bp, url_prefix='/api/tools')
    app.register_blueprint(moclo_bp, url_prefix='/api/moclo')
    app.register_blueprint(library_bp, url_prefix='/api/library')

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
        return render_template('login.html')

    @app.route('/logout')
    def logout_page():
        session.clear()
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

    @app.route('/about')
    def about_page():
        return render_template('about.html')

    @app.route('/health')
    def health():
        from app.services import moclo_bridge
        return {'status': 'healthy', 'version': APP_VERSION, 'moclo': moclo_bridge.available()}

    return app


app = create_app()

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=int(os.environ.get('PORT', 5001)), debug=True)
