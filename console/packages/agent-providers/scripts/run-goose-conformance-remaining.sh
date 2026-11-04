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

# Run each scenario alone; never run the full file back-to-back (Gemini free tier).
scenarios=(
  simple-turn
  file-write-full-access
  approval-required
  approval-declined
  interrupt
  steer-mid-turn
  resume
  subagent
  mcp-registered
)
for s in "${scenarios[@]}"; do
  echo "=== scenario: $s (model=$MODEL) ==="
  if ! pnpm exec vitest run src/goose/goose.integration.test.ts -t "$s"; then
    echo "=== $s failed (quota vs provider bug — check /tmp/goose-spaced-$s.log) ===" >&2
    exit 1
  fi
  echo "waiting 65s for Gemini rate limit..."
  sleep 65
done

echo "=== user-input: skipped in goose.integration.test.ts (ACP form elicitation) ==="
echo "=== all runnable scenarios passed ==="
