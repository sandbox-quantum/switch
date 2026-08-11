#!/usr/bin/env python3
"""Claude Code hook script for Switch mediation and event reporting.

Reads the hook event payload from stdin, manages session state, and calls the
Switch Agent Bridge HTTP API for pre/post tool mediation and event reporting.

Credentials come from the environment when a host injects one (Switch Console
does), and otherwise from the same local agent store the Switch runtime reads,
`<project>/.switch/agents/*.json`. Both sources matter: a session started by
hand has only the store, and a hook that read the environment alone reported
itself unconfigured and skipped every mediation check in silence.
  SWITCH_API_ENDPOINT  — Switch server URL
  SWITCH_API_TOKEN     — Agent API key
  SWITCH_AGENT_ID      — Which stored agent to use, when the store holds several
  CLAUDE_PLUGIN_DATA   — Persistent plugin data directory (auto-injected)
"""

from __future__ import annotations

import json
import os
import sys
import time
import urllib.request
import uuid


def _looks_unresolved(value: str) -> bool:
    """A host may spawn this before expanding its settings env block, leaving
    `${VAR}` literals. Those are not values — and taken as values they become a
    URL nothing can be fetched from, failing every call in silence."""
    return value.startswith("${") and value.endswith("}")


def _env_value(name: str) -> str:
    raw = os.environ.get(name, "")
    return "" if _looks_unresolved(raw) else raw.strip()


API_ENDPOINT = _env_value("SWITCH_API_ENDPOINT").rstrip("/")
API_TOKEN = _env_value("SWITCH_API_TOKEN")
ENV_AGENT_ID = _env_value("SWITCH_AGENT_ID")
PLUGIN_DATA = os.environ.get("CLAUDE_PLUGIN_DATA", "")

# Every SWITCH_* variable this reads, and where the runtime reads it from, are
# the same — so where they disagree the session is mediated as one agent and
# acts as another. The two are kept deliberately in step; see
# `resolveIdentity()` in the runtime's `bin.ts`.
#
# The store is per working directory, and the runtime reads it from the
# process's. `CLAUDE_PROJECT_DIR` names the same directory explicitly, but only
# cwd is guaranteed to be what the runtime used, so cwd is tried first and the
# other only stands in when it holds nothing.
_STORE_DIRS = [
    os.path.join(d, ".switch", "agents")
    for d in dict.fromkeys(
        p for p in (os.getcwd(), os.environ.get("CLAUDE_PROJECT_DIR", "")) if p
    )
]
AGENTS_DIR = _STORE_DIRS[0] if _STORE_DIRS else ".switch/agents"

_STORE_CACHE: list[dict] | None = None


def _read_agent_store() -> list[dict]:
    """Every usable agent provisioned in this working directory.

    Mirrors the runtime's reader: the `{"env": {...}}` shape Switch Console
    writes, plus the flat field names that are the obvious thing to write by
    hand. An entry missing any of the three is not usable and is skipped —
    the caller's job is to pick between agents, not to repair them.

    Cached: this runs per hook event, several times, and the process is too
    short-lived for the directory to change underneath it.
    """
    global _STORE_CACHE
    if _STORE_CACHE is not None:
        return _STORE_CACHE

    agents: list[dict] = []
    for directory in _STORE_DIRS:
        try:
            filenames = sorted(f for f in os.listdir(directory) if f.endswith(".json"))
        except OSError:
            continue

        for filename in filenames:
            try:
                with open(os.path.join(directory, filename)) as f:
                    data = json.load(f)
            except (OSError, ValueError):
                continue
            if not isinstance(data, dict):
                continue
            env = data.get("env")
            env = env if isinstance(env, dict) else {}
            agent = {
                "agent_id": str(
                    data.get("agent_id") or env.get("SWITCH_AGENT_ID") or ""
                ).strip(),
                "endpoint": str(
                    data.get("endpoint") or env.get("SWITCH_API_ENDPOINT") or ""
                )
                .strip()
                .rstrip("/"),
                "token": str(
                    data.get("token") or env.get("SWITCH_API_TOKEN") or ""
                ).strip(),
            }
            if agent["agent_id"] and agent["endpoint"] and agent["token"]:
                agents.append(agent)
        if agents:
            break

    _STORE_CACHE = agents
    return agents


_CREDENTIALS_CACHE: dict[str, tuple[str, str]] = {}


def _credentials(agent_id: str = "") -> tuple[str, str]:
    """`(endpoint, token)` to act as `agent_id`, or `("", "")` if unresolvable.

    `agent_id` is the agent the session actually bound, recorded when it joined
    a room. It is what makes the lookup exact when a directory provisions
    several agents — without it the only safe answer there is to give up,
    since mediating as the wrong agent is worse than not mediating.
    """
    if agent_id in _CREDENTIALS_CACHE:
        return _CREDENTIALS_CACHE[agent_id]

    resolved = _resolve_credentials(agent_id)
    _CREDENTIALS_CACHE[agent_id] = resolved
    return resolved


def _resolve_credentials(agent_id: str) -> tuple[str, str]:
    # A complete environment wins: it is what Switch Console injects per session,
    # and it is chosen for that session deliberately. "Complete" must mean the
    # same three values the runtime requires — the two resolve the same directory
    # and the same environment, and a session whose tool calls are mediated as a
    # different agent than it acts as is worse than one that is not mediated.
    #
    # And it wins only for the agent it names. `agent_id` is who the session
    # actually bound; if the environment names someone else, using its token
    # would authenticate agent B's credential against agent A's URL, which is
    # the one outcome this function exists to prevent.
    if API_ENDPOINT and API_TOKEN and ENV_AGENT_ID:
        if not agent_id or agent_id == ENV_AGENT_ID:
            return API_ENDPOINT, API_TOKEN

    candidates = _read_agent_store()
    wanted = agent_id or ENV_AGENT_ID
    if wanted:
        candidates = [a for a in candidates if a["agent_id"] == wanted]
    # Narrow by endpoint before counting, so an explicit endpoint can break a
    # tie — the same order the runtime resolves in.
    if API_ENDPOINT:
        candidates = [a for a in candidates if a["endpoint"] == API_ENDPOINT]

    if len(candidates) == 1:
        return candidates[0]["endpoint"], candidates[0]["token"]
    return "", ""


def _configured() -> bool:
    """Whether this directory has any Switch identity for the hook to use."""
    return bool(API_ENDPOINT and API_TOKEN) or bool(_read_agent_store())


def _has_credentials(agent_id: str) -> bool:
    """Whether this agent can be mediated for — saying so when it cannot.

    Reaching here means the session is in a room, so it resolved an identity
    somehow and this hook could not follow it. Mediation is then not happening,
    and the one thing worse than that is it not happening quietly.
    """
    if _credentials(agent_id)[1]:
        return True

    # Which of these it is decides the fix, so name it rather than reporting
    # every case as "missing credentials" and sending the reader after a token
    # that may be sitting right there.
    claiming = [a for a in _read_agent_store() if a["agent_id"] == agent_id]
    if len(claiming) > 1:
        why = f"{len(claiming)} entries in {AGENTS_DIR} claim agent {agent_id}, so which token is current is unknowable — leave exactly one"
    elif claiming:
        why = f"agent {agent_id} is in {AGENTS_DIR} but belongs to {claiming[0]['endpoint']}, while this session expects {API_ENDPOINT}"
    else:
        why = f"no entry for agent {agent_id} in {AGENTS_DIR}, and no complete SWITCH_* environment — run the connector's `configure` skill in this directory"

    print(
        f"[switch_hook] {why}. Tool mediation and event reporting are NOT running "
        "for this session.",
        file=sys.stderr,
    )
    return False


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


def _api_call(method: str, path: str, body: dict, agent_id: str = "") -> dict:
    endpoint, token = _credentials(agent_id)
    if not endpoint or not token:
        raise RuntimeError(f"no Switch credentials for agent {agent_id or '(unknown)'}")

    url = f"{endpoint}{path}"
    data = json.dumps(body).encode()
    req = urllib.request.Request(
        url,
        data=data,
        method=method,
        headers={
            "Authorization": f"Bearer {token}",
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
    if not _has_credentials(state["agent_id"]):
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
            "POST",
            f"/agents/{state['agent_id']}/mediation/pre-tool-call",
            body,
            state["agent_id"],
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
    if not _has_credentials(state["agent_id"]):
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
            agent_id,
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
            agent_id,
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
        print(
            f"[switch_hook] store={AGENTS_DIR!r} agents={len(_read_agent_store())}",
            file=sys.stderr,
        )

    # "Not configured" is an expected state for a freshly-installed plugin
    # — the user hasn't run `/configure` yet, or is in the middle of doing
    # so. Don't spam every tool call with a hook error during setup; just
    # exit cleanly and let the tool proceed. Once an identity exists, in the
    # environment or the store, real failures (network, auth, mediation
    # denials) will still surface.
    if not PLUGIN_DATA or not _configured():
        if debug:
            missing = [
                name
                for name, value in (
                    ("a Switch identity (environment or agent store)", _configured()),
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
