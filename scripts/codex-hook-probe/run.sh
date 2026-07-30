#!/usr/bin/env bash
#
# Answer the two questions PR #79 could not settle from the Codex binary alone:
#
#   1. Does Codex deliver a hook's event payload on stdin, with no positional
#      operands?  Commit "post the real hook payload from the generated command"
#      drops a `${1:-$(cat)}` fallback on the strength of `$SHELL -lc` and a
#      `stdin_error` outcome found in the binary. If `$#` is 0 and stdin carries
#      the JSON, that reasoning holds.
#
#   2. What shape does `tool_response` take for an MCP tool call? Claude Code
#      unwraps the MCP result; if Codex forwards the `CallToolResult` envelope
#      instead, the payload sits under `structuredContent` / `content[0].text`.
#      The enricher handles either, but the answer belongs in the PR.
#
# Runs against an isolated CODEX_HOME so your real ~/.codex is untouched. It
# does spend one Codex turn on your account. Nothing is written outside the
# probe directory.
#
# Usage:  scripts/codex-hook-probe/run.sh [--keep]

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PROBE_DIR="$(mktemp -d "${TMPDIR:-/tmp}/codex-hook-probe.XXXXXX")"
CODEX_HOME="$PROBE_DIR/home"
DUMPS="$PROBE_DIR/dumps"
KEEP="${1:-}"

# Anything short of a clean run keeps the directory: a probe you cannot inspect
# after it fails is worse than no probe.
KEEP_ON_EXIT=1
cleanup() {
  # The auth copy goes regardless of why we are exiting — a kept probe
  # directory is for reading hook dumps, not for leaving credentials in /tmp.
  rm -f "$CODEX_HOME/auth.json"
  if [ "$KEEP" = "--keep" ] || [ "$KEEP_ON_EXIT" = "1" ]; then
    echo
    echo "Probe directory: $PROBE_DIR   (auth copy removed)"
    echo "  codex output:  $PROBE_DIR/codex.log"
    echo "  hook dumps:    $DUMPS"
    echo "  remove with:   rm -rf $PROBE_DIR"
  else
    rm -rf "$PROBE_DIR"
  fi
}
trap cleanup EXIT INT TERM

mkdir -p "$CODEX_HOME" "$DUMPS"

# Codex resolves credentials from CODEX_HOME, so the isolated home needs a copy.
# mktemp -d gives 0700; the copy is narrowed to 0600 and removed on every exit
# path by the trap above, including when the probe directory itself is kept.
if [ ! -r "$HOME/.codex/auth.json" ]; then
  echo "error: no ~/.codex/auth.json — run 'codex login' first." >&2
  exit 1
fi
( umask 077 && cp "$HOME/.codex/auth.json" "$CODEX_HOME/auth.json" )
chmod 600 "$CODEX_HOME/auth.json"

# The hook commands record what Codex actually handed them: the operand count,
# the first operand, and stdin. Deliberately NOT the commands switchdash
# generates — this measures the delivery mechanism, not our shell.
#
# Built with json.dumps rather than a heredoc: the commands contain quotes, and
# Codex responds to malformed hooks.json with a warning buried in the transcript
# and then runs no hooks at all, which reads exactly like "hooks don't fire".
python3 - "$CODEX_HOME/hooks.json" "$DUMPS" <<'PY'
import json, sys

out_path, dumps = sys.argv[1], sys.argv[2]


def probe(event: str) -> str:
    meta, stdin = f"{dumps}/{event}.meta", f"{dumps}/{event}.stdin"
    return (
        f'printf "argc=%s\\narg1=%s\\n" "$#" "${{1:-<unset>}}" > {meta}; '
        f"cat > {stdin}"
    )


config = {
    "hooks": {
        "SessionStart": [{"hooks": [{"type": "command", "command": probe("session-start")}]}],
        "PostToolUse": [
            {
                "matcher": "mcp__.*__connect_to_room",
                "hooks": [{"type": "command", "command": probe("post-tool-use")}],
            }
        ],
    }
}

with open(out_path, "w") as fh:
    json.dump(config, fh, indent=2)
PY

python3 -c "import json,sys; json.load(open(sys.argv[1]))" "$CODEX_HOME/hooks.json" \
  || { echo "error: generated hooks.json is not valid JSON" >&2; exit 1; }

cat > "$CODEX_HOME/config.toml" <<EOF
[mcp_servers.switch]
command = "uv"
args = ["run", "--project", "$REPO_ROOT/core", "python", "$REPO_ROOT/scripts/codex-hook-probe/mcp_probe.py"]
EOF

echo "Probe home: $CODEX_HOME"
echo "Running a Codex turn that calls connect_to_room…"
echo

# `--dangerously-bypass-hook-trust` is required: Codex persists a `trusted_hash`
# per hook and silently skips any it has not been told to trust, so without it
# the probe reports "HOOK DID NOT FIRE" for reasons that have nothing to do with
# what it is measuring. switchdash passes the same flag (see
# `buildCodexAutoApproveFlag`).
CODEX_HOME="$CODEX_HOME" codex exec \
  --dangerously-bypass-approvals-and-sandbox \
  --dangerously-bypass-hook-trust \
  --skip-git-repo-check \
  -C "$PROBE_DIR" \
  'Call the connect_to_room tool on the switch MCP server with room_id "r1". Then stop and say DONE. Do not do anything else.' \
  >"$PROBE_DIR/codex.log" 2>&1 || {
    echo "codex exec failed; tail of its output:" >&2
    tail -30 "$PROBE_DIR/codex.log" >&2
    exit 1
  }

if grep -q 'failed to parse hooks config' "$PROBE_DIR/codex.log"; then
  echo "error: Codex rejected the hooks config, so no hook ran:" >&2
  grep 'failed to parse hooks config' "$PROBE_DIR/codex.log" | sed 's/^/  /' >&2
  exit 1
fi

if ! grep -qi 'connect_to_room' "$PROBE_DIR/codex.log"; then
  echo "warning: the transcript never mentions connect_to_room — the model may" >&2
  echo "         not have called the tool, so PostToolUse would not fire." >&2
fi

echo "Codex version under test: $(codex --version 2>/dev/null || echo unknown)"

echo "──────────────────────────────────────────────────────────────────────"
echo "Q1  Payload delivery — expect argc=0 and non-empty stdin"
echo "──────────────────────────────────────────────────────────────────────"
fired=0
for event in session-start post-tool-use; do
  echo
  echo "[$event]"
  if [ -r "$DUMPS/$event.meta" ]; then
    fired=1
    sed 's/^/  /' "$DUMPS/$event.meta"
    bytes=$(wc -c <"$DUMPS/$event.stdin" | tr -d ' ')
    echo "  stdin_bytes=$bytes"
  else
    echo "  HOOK DID NOT FIRE"
  fi
done

if [ "$fired" = "0" ]; then
  echo
  echo "Neither hook fired. Last 25 lines of the Codex transcript:"
  tail -25 "$PROBE_DIR/codex.log" | sed 's/^/  /'
fi

if [ -s "$DUMPS/session-start.stdin" ]; then
  echo
  echo "  session-start body keys:"
  python3 -c "
import json, sys
body = json.load(open(sys.argv[1]))
print('   ', sorted(body))
for key in ('session_id', 'resource_id', 'resourceId', 'sessionId'):
    if key in body:
        print(f'    parseCodexHookEvent reads {key!r} -> {body[key]!r}')
" "$DUMPS/session-start.stdin" || true
fi

echo
echo "──────────────────────────────────────────────────────────────────────"
echo "Q2  tool_response shape — payload direct, or CallToolResult envelope?"
echo "──────────────────────────────────────────────────────────────────────"
if [ -s "$DUMPS/post-tool-use.stdin" ]; then
  python3 - "$DUMPS/post-tool-use.stdin" <<'PY'
import json, sys

body = json.load(open(sys.argv[1]))
tr = body.get("tool_response")
print(f"  tool_name      : {body.get('tool_name')}")
print(f"  tool_response  : {type(tr).__name__}")
if isinstance(tr, dict):
    print(f"  top-level keys : {sorted(tr)}")
    if "room_id" in tr:
        print("  VERDICT        : UNWRAPPED — payload is at the top level (Claude-like)")
    elif "structuredContent" in tr or "content" in tr:
        print("  VERDICT        : ENVELOPE — CallToolResult forwarded intact")
    else:
        print("  VERDICT        : UNKNOWN — neither payload nor envelope")
else:
    print(f"  VERDICT        : non-dict ({tr!r:.120})")
print()
print("  raw tool_response:")
print(json.dumps(tr, indent=2)[:1500])
PY
else
  echo "  no PostToolUse payload captured — see $PROBE_DIR/codex.log"
fi

# Only a run that answered both questions is clean enough to discard.
if [ -s "$DUMPS/session-start.stdin" ] && [ -s "$DUMPS/post-tool-use.stdin" ]; then
  KEEP_ON_EXIT=0
fi
