"""switch_core.bridges.agent.operations.callctx: the finalisation edge of
`call_context`.

Mirrors `test_logging_context.py`'s case for `log_context`, but for the call
context: it restores a call token *and* a log token together, so both must be
skipped consistently when the block is unwound by `GeneratorExit` rather than
resumed.
"""

from __future__ import annotations

import contextvars
from collections.abc import Coroutine, Generator
from typing import Any

from switch_core.bridges.agent.operations.callctx import (
    CallContext,
    call_context,
    current_call_context,
)
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


def test_call_context_survives_being_closed_from_another_context() -> None:
    async def body() -> None:
        with call_context(CallContext(agent_id=AGENT, session_key="c1")):
            await _Suspend()

    assert current_call_context() is None
    _drive_then_finalise_elsewhere(body())
    assert current_call_context() is None, (
        "finalising a dropped coroutine leaked its call context into the "
        "collector's context"
    )
    assert current_log_context().agent_id is None, (
        "finalising a dropped coroutine leaked its log context into the "
        "collector's context"
    )
