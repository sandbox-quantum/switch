"""The call context shared by both agent-facing front doors (CHOO-1857/490).

An operation needs two things about its caller: which agent is making it, and
which session or connection it belongs to. Over MCP both come from the FastMCP
transport; over HTTP they come from the bearer token and the `connection_id` on
the request. Everything above this indirection is written once and served by
both doors, which is what keeps them from drifting apart.

`session_key` is deliberately vague about what it identifies: an MCP transport
session today, a connection id over HTTP. Both are "the thing that owns the
room binding", and operations only ever compare them for equality.
"""

from __future__ import annotations

from contextvars import ContextVar, Token
from dataclasses import dataclass

from switch_core.logging_context import (
    LogContext,
    bind_log_context,
    unbind_log_context,
)


@dataclass(frozen=True)
class CallContext:
    agent_id: str
    session_key: str | None


@dataclass(frozen=True)
class _CallContextToken:
    """Undoes both the call context and the log context it also bound."""

    call: Token[CallContext | None]
    log: Token[LogContext]


_current: ContextVar[CallContext | None] = ContextVar(
    "switch_call_context", default=None
)


def set_call_context(context: CallContext) -> _CallContextToken:
    """Bind the caller for the duration of one operation. Returns a reset token.

    The calling agent is bound for logging at the same time — this is the one
    place both front doors already name their caller, so it is the cheapest
    place to make every line an operation emits attributable.
    """
    return _CallContextToken(
        call=_current.set(context),
        log=bind_log_context(agent_id=context.agent_id),
    )


def reset_call_context(token: _CallContextToken) -> None:
    unbind_log_context(token.log)
    _current.reset(token.call)


def current_call_context() -> CallContext | None:
    return _current.get()
