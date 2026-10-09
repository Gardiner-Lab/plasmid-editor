#!/usr/bin/env bash
#
# Back up the Plasmid Editor database from its named volume.
# The shared MoClo databases are the MoClo tool's responsibility and are backed
# up by its own backup script; this only copies the editor's data.
#
#   scripts/backup.sh [destination-directory]

set -euo pipefail

CONTAINER="${CONTAINER:-plasmid-editor}"
DEST="${1:-./backups}"
STAMP="$(date +%Y%m%d-%H%M%S)"

mkdir -p "$DEST"

if ! docker inspect "$CONTAINER" >/dev/null 2>&1; then
  echo "container ${CONTAINER} is not running; nothing to back up" >&2
  exit 0
fi

DB="$(docker exec "$CONTAINER" printenv EDITOR_DATABASE_PATH 2>/dev/null || echo /data/plasmid_editor.db)"
OUT="${DEST}/plasmid_editor-${STAMP}.db"

# .backup gives a consistent copy even while the application is writing.
if docker exec "$CONTAINER" python -c "
import sqlite3, sys
src = sqlite3.connect(sys.argv[1])
dst = sqlite3.connect('/tmp/backup.db')
src.backup(dst)
dst.close(); src.close()
" "$DB" 2>/dev/null; then
  docker cp "${CONTAINER}:/tmp/backup.db" "$OUT"
  docker exec "$CONTAINER" rm -f /tmp/backup.db
else
  docker cp "${CONTAINER}:${DB}" "$OUT"
fi

echo "backed up to ${OUT}"

# Keep the 20 most recent backups.
ls -1t "${DEST}"/plasmid_editor-*.db 2>/dev/null | tail -n +21 | xargs -r rm --
