"""CallContextMiddleware's call-context restore.

Same finalisation edge as `test_callctx.py`, exercised through the actual
front door: an MCP tool call that suspends and is then dropped and finalised
by the garbage collector, rather than resumed, must not raise trying to reset
a token from the wrong context.
"""

from __future__ import annotations

import contextvars
from collections.abc import Coroutine, Generator
from typing import Any

from fastmcp.server.middleware import MiddlewareContext

from switch_core.bridges.agent.mcp import server as mcp_server
from switch_core.bridges.agent.operations.callctx import current_call_context
from switch_core.logging_context import current_log_context

AGENT = "agent-1"


class _Suspend:
    """An await that suspends once, so a coroutine can be left mid-scope with
    no event loop in sight."""

    def __await__(self) -> Generator[None, None, None]:
        yield


def _drive_then_finalise_elsewhere(coro: Coroutine[Any, Any, None]) -> None:
    """Enter the scope inside its own context, then close from this one —
    what the garbage collector does to a coroutine dropped while suspended."""
    contextvars.copy_context().run(coro.send, None)
    coro.close()


class _FakeRequest:
    def __init__(self, agent_id: str) -> None:
        self.scope = {"agent_id": agent_id}


def test_the_call_context_survives_being_closed_from_another_context(
    monkeypatch: Any,
) -> None:
    monkeypatch.setattr(mcp_server, "get_http_request", lambda: _FakeRequest(AGENT))

    middleware = mcp_server.CallContextMiddleware()
    context: MiddlewareContext = MiddlewareContext(message=None, fastmcp_context=None)

    async def call_next(_context: MiddlewareContext) -> None:
        await _Suspend()

    async def body() -> None:
        await middleware.on_call_tool(context, call_next)

    assert current_call_context() is None
    _drive_then_finalise_elsewhere(body())
    assert current_call_context() is None, (
        "finalising a dropped tool call leaked its call context into the "
        "collector's context"
    )
    assert current_log_context().agent_id is None, (
        "finalising a dropped tool call leaked its log context into the "
        "collector's context"
    )
