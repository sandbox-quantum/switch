#!/usr/bin/env bash
# Runs delivery.py in the server's Python environment; arguments pass through.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec uv run --project "$HERE/../../core" python "$HERE/delivery.py" "$@"
