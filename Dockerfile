FROM python:3.12-slim

WORKDIR /app

# Biopython ships wheels for this platform, so no build toolchain is needed.
RUN useradd -m -u 1000 appuser && mkdir -p /data && chown -R appuser:appuser /app /data

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt && \
    pip install --no-cache-dir gunicorn==23.0.0

COPY dnakit/ ./dnakit/
COPY app/ ./app/

USER appuser

EXPOSE 5001

ENV PYTHONUNBUFFERED=1 \
    FLASK_APP=app.main \
    EDITOR_DATABASE_PATH=/data/plasmid_editor.db \
    PARTS_DATABASE_PATH=/data/parts.db \
    MOCLO_DATABASE_PATH=/data/moclo.db \
    PORT=5001

HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:5001/health')" || exit 1

# One worker with threads keeps SQLite writes simple and ordered.
CMD ["gunicorn", "--bind", "0.0.0.0:5001", "--workers", "1", "--threads", "4", \
     "--timeout", "180", "app.main:app"]
