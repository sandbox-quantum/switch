#!/usr/bin/env python3
"""Claude Code hook script for Switch mediation and event reporting.

Reads the hook event payload from stdin, manages session state, and calls the
Switch Agent Bridge HTTP API for pre/post tool mediation and event reporting.

Config is read from environment variables set in the user's
`.claude/settings.local.json` env block (the same values consumed by the MCP
server in `.mcp.json`):
  SWITCH_API_ENDPOINT  — Switch server URL
  SWITCH_API_TOKEN     — Agent API key
  CLAUDE_PLUGIN_DATA   — Persistent plugin data directory (auto-injected)
"""

from __future__ import annotations

import json
import os
import sys
import time
import urllib.request
import uuid

API_ENDPOINT = os.environ.get("SWITCH_API_ENDPOINT", "").rstrip("/")
API_TOKEN = os.environ.get("SWITCH_API_TOKEN", "")
PLUGIN_DATA = os.environ.get("CLAUDE_PLUGIN_DATA", "")


def _state_path(session_id: str) -> str:
    return os.path.join(PLUGIN_DATA, f"session_{session_id}.json")


def _load_state(session_id: str) -> dict | None:
    path = _state_path(session_id)
    if not os.path.exists(path):
        return None
    with open(path) as f:
        result: dict = json.load(f)
        return result


def _save_state(session_id: str, state: dict) -> None:
    os.makedirs(PLUGIN_DATA, exist_ok=True)
    with open(_state_path(session_id), "w") as f:
        json.dump(state, f)


def _api_call(method: str, path: str, body: dict) -> dict:
    url = f"{API_ENDPOINT}{path}"
    data = json.dumps(body).encode()
    req = urllib.request.Request(
        url,
        data=data,
        method=method,
        headers={
            "Authorization": f"Bearer {API_TOKEN}",
            "Content-Type": "application/json",
        },
    )
    with urllib.request.urlopen(req, timeout=10) as resp:
        if resp.status == 202:
            return {}
        result: dict = json.loads(resp.read())
        return result


def _output(obj: dict) -> None:
    json.dump(obj, sys.stdout)


def _parse_response(raw: object) -> dict:
    if isinstance(raw, dict):
        return raw
    if isinstance(raw, str):
        result: dict = json.loads(raw)
        return result
    raise ValueError(f"Unexpected tool_response type: {type(raw)}")


def _channel_port_path() -> str:
    # The Switch agent runtime writes its port to ~/.switch/sessions/<ppid>/port,
    # where ppid is the Claude Code session PID. This hook is also a direct
    # child of that same Claude Code process, so getppid() returns the same
    # value, and both sides resolve to the same path independently.
    #
    # NOTE: if hooks.json ever wraps this in a shell (e.g. `bash -c "python …"`),
    # the shell becomes the parent and getppid() will not match the runtime's
    # ppid. Keep the hook invocation a direct `python <script>` call.
    return os.path.join(
        os.path.expanduser("~"), ".switch", "sessions", str(os.getppid()), "port"
    )


def _notify_channel(path: str, body: dict) -> None:
    """POST to the local channel control endpoint at `path` (best-effort)."""
    port_path = _channel_port_path()
    try:
        with open(port_path) as f:
            port = int(f.read().strip())
    except (FileNotFoundError, ValueError):
        return

    url = f"http://127.0.0.1:{port}{path}"
    data = json.dumps(body).encode()
    req = urllib.request.Request(
        url,
        data=data,
        method="POST",
        headers={"Content-Type": "application/json"},
    )
    try:
        urllib.request.urlopen(req, timeout=2).close()
    except Exception as exc:
        print(f"[switch_hook] failed to notify channel: {exc}", file=sys.stderr)


def _notify_channel_connect(room_id: str) -> None:
    _notify_channel("/connect", {"room_id": room_id})


def handle_assume_role(event: dict) -> None:
    # Acquiring a role starts the fast lease-renewal loop in the channel so the
    # (possibly exclusive) seat stays held while this session is alive.
    response = _parse_response(event.get("tool_response", {}))
    if response.get("role"):
        _notify_channel("/assume-role", {})


def handle_release_role(event: dict) -> None:
    _notify_channel("/release-role", {})


def handle_turn_end(event: dict) -> None:
    # The turn is no longer running. Tell the channel to clear the "thinking"
    # indicator in case the agent stopped without posting a reply (the reply
    # path clears it otherwise). Fires on normal completion (Stop), API-error
    # endings (StopFailure), and idle (Notification/idle_prompt) — the last of
    # which is the closest signal Claude Code exposes for a user interrupt,
    # since there is no dedicated interrupt hook. Best-effort; the channel
    # resolves the room it is connected to.
    _notify_channel("/turn-end", {})


def handle_connect_to_room(event: dict) -> None:
    response = _parse_response(event.get("tool_response", {}))
    room_id = response.get("room_id")
    agent_id = response.get("agent_id")
    if room_id and agent_id:
        _save_state(event["session_id"], {"room_id": room_id, "agent_id": agent_id})
        _notify_channel_connect(room_id)


def handle_pre_tool_use(event: dict) -> None:
    state = _load_state(event["session_id"])
    if state is None:
        return

    request_id = str(uuid.uuid4())
    body = {
        "room_id": state["room_id"],
        "tool_name": event.get("tool_name", ""),
        "arguments": event.get("tool_input", {}),
        "request_id": request_id,
    }

    try:
        resp = _api_call(
            "POST", f"/agents/{state['agent_id']}/mediation/pre-tool-call", body
        )
    except Exception:
        return

    verdict = resp.get("verdict", "proceed")
    if verdict == "blocked":
        _output(
            {
                "hookSpecificOutput": {
                    "hookEventName": "PreToolUse",
                    "permissionDecision": "deny",
                    "permissionDecisionReason": resp.get("reason", "Blocked by Switch"),
                }
            }
        )
    elif verdict == "proceed":
        _output(
            {
                "hookSpecificOutput": {
                    "hookEventName": "PreToolUse",
                    "permissionDecision": "allow",
                }
            }
        )


def handle_post_tool_use(event: dict) -> None:
    state = _load_state(event["session_id"])
    if state is None:
        return

    agent_id = state["agent_id"]
    room_id = state["room_id"]
    tool_name = event.get("tool_name", "")
    tool_input = event.get("tool_input", {})
    tool_output = event.get("tool_response", {})
    duration_ms = event.get("duration_ms")
    request_id = str(uuid.uuid4())

    # Reading context means the agent caught up on room history, so clear the
    # channel's missed-message tally. read_context still flows through the
    # normal reporting/mediation below — this only piggybacks the reset signal.
    if tool_name.endswith("read_context"):
        _notify_channel("/read-context", {})

    try:
        _api_call(
            "POST",
            f"/agents/{agent_id}/events/report",
            {
                "room_id": room_id,
                "events": [
                    {
                        "type": "tool_call",
                        "tool_name": tool_name,
                        "arguments": tool_input,
                        "result": tool_output,
                        "request_id": request_id,
                        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                        "duration_ms": duration_ms,
                    }
                ],
            },
        )
    except Exception:
        pass

    try:
        resp = _api_call(
            "POST",
            f"/agents/{agent_id}/mediation/post-tool-result",
            {
                "room_id": room_id,
                "tool_name": tool_name,
                "result": tool_output,
                "request_id": request_id,
            },
        )
    except Exception:
        return

    verdict = resp.get("verdict", "ok")
    if verdict == "blocked":
        _output(
            {
                "decision": "block",
                "reason": resp.get("reason", "Blocked by Switch post-tool mediation"),
            }
        )
    elif verdict == "redacted":
        _output(
            {
                "updatedToolOutput": resp.get("result", tool_output),
            }
        )


def main() -> None:
    debug = os.environ.get("SWITCH_HOOK_DEBUG", "")
    if debug:
        print(f"[switch_hook] API_ENDPOINT={API_ENDPOINT!r}", file=sys.stderr)
        print(
            f"[switch_hook] API_TOKEN={'set' if API_TOKEN else 'empty'}",
            file=sys.stderr,
        )
        print(f"[switch_hook] PLUGIN_DATA={PLUGIN_DATA!r}", file=sys.stderr)

    # "Not configured" is an expected state for a freshly-installed plugin
    # — the user hasn't run `/configure` yet, or is in the middle of doing
    # so. Don't spam every tool call with a hook error during setup; just
    # exit cleanly and let the tool proceed. Once the env vars are set,
    # real failures (network, auth, mediation denials) will still surface.
    if not API_ENDPOINT or not API_TOKEN or not PLUGIN_DATA:
        if debug:
            missing = [
                name
                for name, value in (
                    ("SWITCH_API_ENDPOINT", API_ENDPOINT),
                    ("SWITCH_API_TOKEN", API_TOKEN),
                    ("CLAUDE_PLUGIN_DATA", PLUGIN_DATA),
                )
                if not value
            ]
            print(
                f"[switch_hook] not configured (missing: {', '.join(missing)}); "
                "skipping. Run `/configure` to register this Claude Code instance.",
                file=sys.stderr,
            )
        sys.exit(0)

    event = json.load(sys.stdin)
    hook_event = event.get("hook_event_name", "")
    tool_name = event.get("tool_name", "")

    if debug:
        print(f"[switch_hook] event={hook_event} tool={tool_name}", file=sys.stderr)

    if hook_event == "PostToolUse" and tool_name.endswith("connect_to_room"):
        handle_connect_to_room(event)
    elif hook_event == "PostToolUse" and tool_name.endswith("assume_role"):
        handle_assume_role(event)
    elif hook_event == "PostToolUse" and tool_name.endswith("release_role"):
        handle_release_role(event)
    elif hook_event in ("Stop", "StopFailure", "Notification"):
        handle_turn_end(event)
    elif hook_event == "PreToolUse":
        handle_pre_tool_use(event)
    elif hook_event == "PostToolUse":
        handle_post_tool_use(event)


if __name__ == "__main__":
    main()
