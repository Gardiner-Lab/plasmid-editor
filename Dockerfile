FROM python:3.12-slim

WORKDIR /app

RUN useradd -m -u 1000 appuser && mkdir -p /data && chown -R appuser:appuser /app /data

# Biopython ships wheels for both platforms the release builds; primer3-py has none for
# arm64, so it is compiled there, with make as well as the compiler (its build also makes
# primer3's own programs). The toolchain is installed for this step only and removed.
COPY requirements.txt .
RUN apt-get update && apt-get install -y --no-install-recommends build-essential && \
    pip install --no-cache-dir -r requirements.txt && \
    pip install --no-cache-dir gunicorn==23.0.0 && \
    apt-get purge -y build-essential && apt-get autoremove -y && rm -rf /var/lib/apt/lists/*

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

# How many worker processes serve the editor. Several, because this is the one tool that does real
# arithmetic in a request - scanning a plasmid against every REBASE enzyme, aligning a read - and
# Python runs one of those at a time per process, so with a single worker one person's enzyme scan
# leaves everyone else waiting behind it. Measured on a 60 kb plasmid against all 1,088 enzymes with
# 20 people on at once: ordinary pages went from 3.9 s to 0.5 s at the 95th percentile, and the whole
# suite from 9 to 28 requests a second. Several processes share the database safely because every
# connection waits out a lock for 10 seconds rather than failing (sqlite3.connect(timeout=10)), and
# writes still take their turn. Gunicorn reads WEB_CONCURRENCY itself; set EDITOR_WORKERS in the
# suite's .env to change it (1 restores the old behaviour).
ENV WEB_CONCURRENCY=4
CMD ["gunicorn", "--bind", "0.0.0.0:5001", "--threads", "4", \
     "--timeout", "180", "app.main:app"]
