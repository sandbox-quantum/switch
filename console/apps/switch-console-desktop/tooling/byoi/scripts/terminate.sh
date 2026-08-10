#!/bin/bash
# ──────────────────────────────────────────────────────────────────────────────
# Switch Console BYOI terminate script
#
# Called by Switch Console when a task is terminated. Stops and removes the Docker
# container that was created by provision.sh.
#
# REMOTE_WORKSPACE_ID is set by Switch Console to the `id` returned by provision.sh
# (which is the container name).
# ──────────────────────────────────────────────────────────────────────────────
set -euo pipefail

if [[ -z "${REMOTE_WORKSPACE_ID:-}" ]]; then
  echo "REMOTE_WORKSPACE_ID is not set — nothing to terminate" >&2
  exit 0
fi

echo "Stopping container '$REMOTE_WORKSPACE_ID'..." >&2
docker stop "$REMOTE_WORKSPACE_ID" 2>/dev/null || true

echo "Removing container '$REMOTE_WORKSPACE_ID'..." >&2
docker rm "$REMOTE_WORKSPACE_ID" 2>/dev/null || true
