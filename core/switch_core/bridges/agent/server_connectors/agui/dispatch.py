"""Executing a tool call the agent asked Switch to make.

Dispatch goes through `call_operation`, the same entry point the HTTP door
uses, so an AG-UI agent and an HTTP agent run identical code for the same
operation and cannot drift apart.

Two rules about failure, and they are not the same rule.

**A refused or failed tool is reported to the agent, not raised.** A model that
sends malformed arguments or calls something that errors should be told so it
can correct itself; killing the whole room turn instead would be a worse
outcome for everyone. The failure travels back as a `ToolResultMessage` with
its `error` field set — the field exists precisely so a failed call is
distinguishable from one that returned nothing, and is also logged.

**A tool outside the allowlist is refused before dispatch.** An agent can name
any tool it likes, including one it was never offered, so the allowlist is
enforced here as well as at projection. Without this check an agent could reach
`connect_to_room` — and evict a live session of itself elsewhere — simply by
guessing the name.
"""

from __future__ import annotations

import json
import logging
from typing import Any

from switch_core.bridges.agent.api.operations import (
    BadArgumentsError,
    UnknownOperationError,
    call_operation,
)
from switch_core.bridges.agent.server_connectors.agui.assembly import ToolCallOutput
from switch_core.bridges.agent.server_connectors.agui.request import ToolResultMessage
from switch_core.bridges.agent.server_connectors.agui.tools import is_exposed

logger = logging.getLogger(__name__)

MAX_RESULT_CHARS = 100_000
"""A tool result is re-sent on every subsequent iteration, so an unbounded one
is paid for repeatedly. Truncation is disclosed in the content."""


async def execute_tool_call(
    call: ToolCallOutput,
    *,
    agent_id: str,
    session_key: str,
) -> ToolResultMessage:
    """Run one tool call and shape the outcome as a message for the next run."""
    if not is_exposed(call.name):
        logger.warning(
            "AG-UI agent %s called %r, which is not exposed to it", agent_id, call.name
        )
        return _failure(
            call,
            f"{call.name!r} is not available to this agent. "
            "Only room-scoped operations are.",
        )

    try:
        arguments = _decode_arguments(call.arguments)
    except ValueError as exc:
        return _failure(call, str(exc))

    try:
        result = await call_operation(
            operation=call.name,
            arguments=arguments,
            agent_id=agent_id,
            connection_id=session_key,
        )
    except (
        UnknownOperationError,
        BadArgumentsError,
        ValueError,
        PermissionError,
    ) as exc:
        logger.warning(
            "AG-UI tool %s failed for agent %s: %s", call.name, agent_id, exc
        )
        return _failure(call, f"{type(exc).__name__}: {exc}")
    except Exception as exc:
        logger.exception("AG-UI tool %s raised for agent %s", call.name, agent_id)
        return _failure(call, f"{type(exc).__name__}: {exc}")

    return ToolResultMessage(
        id=f"toolresult-{call.tool_call_id}",
        content=_encode_result(result),
        tool_call_id=call.tool_call_id,
    )


def _decode_arguments(raw: str) -> dict[str, Any]:
    text = raw.strip()
    if not text:
        return {}
    try:
        decoded = json.loads(text)
    except json.JSONDecodeError as exc:
        raise ValueError(f"arguments are not valid JSON: {exc}") from exc
    if not isinstance(decoded, dict):
        raise ValueError(
            f"arguments must be a JSON object, got {type(decoded).__name__}"
        )
    return decoded


def _encode_result(result: Any) -> str:
    try:
        text = json.dumps(result, default=str)
    except (TypeError, ValueError):
        text = str(result)
    if len(text) > MAX_RESULT_CHARS:
        return (
            text[:MAX_RESULT_CHARS] + f"\n… truncated at {MAX_RESULT_CHARS} characters"
        )
    return text


def _failure(call: ToolCallOutput, detail: str) -> ToolResultMessage:
    return ToolResultMessage(
        id=f"toolresult-{call.tool_call_id}",
        content=detail,
        tool_call_id=call.tool_call_id,
        error=detail,
    )
