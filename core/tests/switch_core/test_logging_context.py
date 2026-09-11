"""switch_core.logging_context: the finalisation edge of `log_context`.

Covers the case `test_logging_config.py` cannot: what happens when the block
is never resumed to completion, but the coroutine holding it is dropped and
later closed by the garbage collector instead.
"""

from __future__ import annotations

import contextvars
from collections.abc import Coroutine, Generator
from typing import Any

from switch_core.logging_context import current_log_context, log_context


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


def test_log_context_survives_being_closed_from_another_context() -> None:
    async def body() -> None:
        with log_context(request_id="req-1"):
            await _Suspend()

    with log_context(request_id="caller"):
        _drive_then_finalise_elsewhere(body())
        assert current_log_context().request_id == "caller", (
            "finalising a dropped coroutine leaked its log context into the "
            "collector's context"
        )
