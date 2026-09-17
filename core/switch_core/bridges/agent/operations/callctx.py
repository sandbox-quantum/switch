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

from collections.abc import Iterator
from contextlib import contextmanager
from contextvars import ContextVar, Token
from dataclasses import dataclass

from switch_core.logging_context import (
    LogContext,
    bind_log_context,
    restore_unless_finalising,
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


@contextmanager
def call_context(context: CallContext) -> Iterator[None]:
    """Bind `context` for the block and restore both tokens on the way out.

    The one caller-facing way to use `set_call_context`/`reset_call_context`:
    a front door binds the caller for an operation call that it does not
    control the internals of, so the call may suspend and never resume — the
    caller's coroutine dropped and finalised by the garbage collector rather
    than completed. `restore_unless_finalising` skips the reset pair in that
    case instead of raising trying to reset a token from the wrong context.
    """
    token = set_call_context(context)
    with restore_unless_finalising(lambda: reset_call_context(token)):
        yield
