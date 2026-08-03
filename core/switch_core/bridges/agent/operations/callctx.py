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

from contextvars import ContextVar
from dataclasses import dataclass


@dataclass(frozen=True)
class CallContext:
    agent_id: str
    session_key: str | None


_current: ContextVar[CallContext | None] = ContextVar(
    "switch_call_context", default=None
)


def set_call_context(context: CallContext):
    """Bind the caller for the duration of one operation. Returns a reset token."""
    return _current.set(context)


def reset_call_context(token) -> None:  # type: ignore[no-untyped-def]
    _current.reset(token)


def current_call_context() -> CallContext | None:
    return _current.get()
