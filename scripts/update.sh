#!/usr/bin/env bash
#
# Safe, self-rolling-back update for the Plasmid Editor container.
# Mirrors scripts/update.sh in the MoClo Library Tool so both tools are
# operated the same way.
#
#   scripts/update.sh              pull the published image and switch to it
#   scripts/update.sh --check      only report whether a newer version exists
#   scripts/update.sh --build      build the image locally instead of pulling
#   scripts/update.sh --yes        do not prompt for confirmation
#
# On health-check failure the previous image is restored automatically. The
# editor's database lives in a named volume and is backed up first; the shared
# MoClo databases are never touched by this script.

set -euo pipefail

COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.prod.yml}"
SERVICE="${SERVICE:-web}"
CONTAINER="${CONTAINER:-plasmid-editor}"
IMAGE="${IMAGE:-ghcr.io/gardiner-lab/plasmid-editor:latest}"
HEALTH_URL="${HEALTH_URL:-http://localhost:5001/health}"
HEALTH_RETRIES="${HEALTH_RETRIES:-30}"
REPO="Gardiner-Lab/plasmid-editor"

cd "$(dirname "$0")/.."

MODE_CHECK=0 MODE_BUILD=0 ASSUME_YES=0
for arg in "$@"; do
  case "$arg" in
    --check) MODE_CHECK=1 ;;
    --build) MODE_BUILD=1 ;;
    --yes|-y) ASSUME_YES=1 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

log()  { printf '\033[1m>>> %s\033[0m\n' "$*"; }
fail() { printf '\033[31m!!! %s\033[0m\n' "$*" >&2; exit 1; }

command -v docker >/dev/null || fail "docker is not installed"
DC=(docker compose); docker compose version >/dev/null 2>&1 || DC=(docker-compose)

running_image()  { docker inspect --format '{{.Config.Image}}' "$CONTAINER" 2>/dev/null || true; }
running_digest() { docker inspect --format '{{index .RepoDigests 0}}' "$(running_image)" 2>/dev/null || true; }

current_version() {
  docker run --rm --entrypoint python "$(running_image 2>/dev/null || echo "$IMAGE")" \
    -c "from app.main import APP_VERSION; print(APP_VERSION)" 2>/dev/null || echo "unknown"
}
latest_tag() {
  curl -fsSL -H 'Accept: application/vnd.github+json' \
    "https://api.github.com/repos/${REPO}/tags?per_page=100" 2>/dev/null \
    | grep -oE '"name": *"v?[0-9]+\.[0-9]+\.[0-9]+"' \
    | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' \
    | sort -t. -k1,1n -k2,2n -k3,3n | tail -1
}

CUR="$(current_version)"
LATEST="$(latest_tag || true)"
log "current: ${CUR}    latest published: ${LATEST:-unknown}"
if [[ -n "$LATEST" && "$CUR" != "unknown" ]]; then
  if [[ "$CUR" == "$LATEST" ]]; then
    log "already up to date"
    [[ "$MODE_CHECK" == 1 ]] && exit 0
  elif [[ "$(printf '%s\n%s\n' "$CUR" "$LATEST" | sort -t. -k1,1n -k2,2n -k3,3n | tail -1)" == "$CUR" ]]; then
    log "you are ahead of the latest tag (dev build)"
  else
    log "update available: ${CUR} -> ${LATEST}"
  fi
fi
[[ "$MODE_CHECK" == 1 ]] && exit 0

if [[ "$ASSUME_YES" != 1 ]]; then
  read -r -p "Proceed with the update? [y/N] " ans
  [[ "$ans" == [yY]* ]] || { log "aborted"; exit 0; }
fi

# ---- backup -----------------------------------------------------------------
if [[ -x ./scripts/backup.sh ]]; then
  log "backing up the editor database"
  ./scripts/backup.sh
fi

PREV_IMAGE="$(running_digest)"
[[ -n "$PREV_IMAGE" ]] && log "rollback point: ${PREV_IMAGE}"

# ---- fetch new image --------------------------------------------------------
if [[ "$MODE_BUILD" == 1 ]]; then
  log "building image locally"
  docker build -t "$IMAGE" .
else
  log "pulling ${IMAGE}"
  "${DC[@]}" -f "$COMPOSE_FILE" pull "$SERVICE"
fi

# ---- switch + health gate ---------------------------------------------------
log "restarting service"
"${DC[@]}" -f "$COMPOSE_FILE" up -d "$SERVICE"

log "waiting for health at ${HEALTH_URL}"
ok=0
for _ in $(seq 1 "$HEALTH_RETRIES"); do
  if curl -fsS "$HEALTH_URL" 2>/dev/null | grep -q '"status": *"healthy"'; then ok=1; break; fi
  sleep 2
done

if [[ "$ok" == 1 ]]; then
  log "healthy — update complete (now $(current_version))"
  exit 0
fi

# ---- rollback ---------------------------------------------------------------
printf '\033[31m!!! health check failed — rolling back\033[0m\n' >&2
if [[ -n "$PREV_IMAGE" ]]; then
  docker tag "$PREV_IMAGE" "$IMAGE"
  "${DC[@]}" -f "$COMPOSE_FILE" up -d "$SERVICE"
  fail "rolled back to the previous image"
fi
fail "no rollback point was recorded; inspect 'docker logs ${CONTAINER}'"
