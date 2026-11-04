#!/usr/bin/env bash
# Run remaining Goose real-CLI conformance scenarios with quota spacing.
set -euo pipefail
export PATH="$HOME/.local/node/bin:$HOME/.local/bin:$PATH"
cd "$(dirname "$0")/.."

if [[ -z "${GOOGLE_API_KEY:-}" ]] && [[ ! -f "$HOME/.config/goose/secrets.yaml" ]]; then
  echo "Configure Goose first (GOOGLE_API_KEY or ~/.local/bin/goose-gemini-local-setup.sh)." >&2
  exit 1
fi
if [[ -n "${GOOGLE_API_KEY:-}" ]]; then
  # shellcheck source=/dev/null
  source "$HOME/.local/bin/goose-config-from-env.sh" 2>/dev/null || bash "$HOME/.local/bin/goose-config-from-env.sh"
fi
export GOOSE_DISABLE_KEYRING=1

MODELS=(gemini-3-flash-preview gemini-3.5-flash gemini-flash-lite-latest)
MODEL="${GOOSE_MODEL:-gemini-3-flash-preview}"

scenarios=(interrupt mcp-registered subagent steer-mid-turn)
for s in "${scenarios[@]}"; do
  echo "=== scenario: $s (model=$MODEL) ==="
  if ! pnpm exec vitest run src/goose/goose.integration.test.ts -t "$s"; then
    echo "=== retry $s with event logging hint: check quota vs bug ===" >&2
    exit 1
  fi
  echo "waiting 65s for Gemini rate limit..."
  sleep 65
done

echo "=== full suite ==="
pnpm exec vitest run src/goose/goose.integration.test.ts
