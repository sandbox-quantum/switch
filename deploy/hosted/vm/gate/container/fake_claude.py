#!/usr/bin/python3
"""A stand-in for the `claude` CLI, so the gate needs no provider login.

It speaks just enough of the CLI's stream-json protocol for the Claude Agent
SDK: it answers every control request with success, announces the session,
and answers each user message with one assistant message and a `result`.

A message containing GATE_HOLD keeps its turn open, so the session reports
itself busy, until the process gets SIGUSR1 (or an interrupt). The gate uses
that to hold an agent busy while a provider login changes.
"""

import json
import os
import signal
import sys
import threading
import uuid

VERSION = "2.1.260 (Claude Code)"


def argument(name: str) -> str | None:
    args = sys.argv[1:]
    for index, value in enumerate(args):
        if value == name and index + 1 < len(args):
            return args[index + 1]
        if value.startswith(name + "="):
            return value.split("=", 1)[1]
    return None


if "--version" in sys.argv[1:] or "-v" in sys.argv[1:]:
    print(VERSION)
    sys.exit(0)
if sys.argv[1:3] == ["auth", "status"]:
    print(
        json.dumps(
            {
                "loggedIn": bool(os.environ.get("ANTHROPIC_API_KEY")),
                "authMethod": "api_key",
            }
        )
    )
    sys.exit(0)

session_id = argument("--session-id") or argument("--resume") or str(uuid.uuid4())
write_lock = threading.Lock()
release = threading.Event()
announced = False


def emit(message: dict) -> None:
    with write_lock:
        sys.stdout.write(json.dumps(message) + "\n")
        sys.stdout.flush()


def announce() -> None:
    global announced
    if announced:
        return
    announced = True
    emit(
        {
            "type": "system",
            "subtype": "init",
            "session_id": session_id,
            "uuid": str(uuid.uuid4()),
            "cwd": os.getcwd(),
            "tools": [],
            "mcp_servers": [],
            "model": "gate-fake",
            "permissionMode": "default",
            "slash_commands": [],
            "apiKeySource": "ANTHROPIC_API_KEY"
            if os.environ.get("ANTHROPIC_API_KEY")
            else "none",
            "claude_code_version": VERSION.split()[0],
            "output_style": "default",
            "agents": [],
            "skills": [],
            "plugins": [],
        }
    )


def text_of(message: dict) -> str:
    content = message.get("message", {}).get("content", "")
    if isinstance(content, str):
        return content
    return " ".join(part.get("text", "") for part in content if isinstance(part, dict))


def answer(message: dict) -> None:
    text = text_of(message)
    if "GATE_HOLD" in text:
        print(
            "fake claude: holding the turn until SIGUSR1", file=sys.stderr, flush=True
        )
        release.wait()
        release.clear()
    reply = "gate ok"
    emit(
        {
            "type": "assistant",
            "message": {
                "id": "msg_" + uuid.uuid4().hex,
                "type": "message",
                "role": "assistant",
                "model": "gate-fake",
                "content": [{"type": "text", "text": reply}],
                "stop_reason": "end_turn",
                "stop_sequence": None,
                "usage": {"input_tokens": 1, "output_tokens": 1},
            },
            "parent_tool_use_id": None,
            "session_id": session_id,
            "uuid": str(uuid.uuid4()),
        }
    )
    emit(
        {
            "type": "result",
            "subtype": "success",
            "is_error": False,
            "duration_ms": 1,
            "duration_api_ms": 1,
            "num_turns": 1,
            "result": reply,
            "stop_reason": "end_turn",
            "session_id": session_id,
            "total_cost_usd": 0,
            "usage": {
                "input_tokens": 1,
                "output_tokens": 1,
                "cache_creation_input_tokens": 0,
                "cache_read_input_tokens": 0,
            },
            "modelUsage": {},
            "permission_denials": [],
            "uuid": str(uuid.uuid4()),
            "user_message_uuids": [message["uuid"]] if message.get("uuid") else [],
        }
    )


def control(message: dict) -> None:
    request = message.get("request", {})
    response: dict = {}
    if request.get("subtype") == "initialize":
        response = {
            "commands": [],
            "agents": [],
            "output_style": "default",
            "available_output_styles": ["default"],
            "models": [],
            "account": {},
        }
    if request.get("subtype") == "interrupt":
        release.set()
    emit(
        {
            "type": "control_response",
            "response": {
                "subtype": "success",
                "request_id": message.get("request_id"),
                "response": response,
            },
        }
    )


signal.signal(signal.SIGUSR1, lambda *_: release.set())
turns: list[threading.Thread] = []
for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    try:
        message = json.loads(line)
    except json.JSONDecodeError:
        continue
    kind = message.get("type")
    if kind == "control_request":
        control(message)
    elif kind == "user":
        announce()
        turn = threading.Thread(target=answer, args=(message,), daemon=True)
        turn.start()
        turns.append(turn)
sys.exit(0)
