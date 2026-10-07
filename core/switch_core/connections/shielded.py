import asyncio
import logging
from collections.abc import Coroutine
from typing import Any

logger = logging.getLogger(__name__)


async def finish_shielded[T](operation: Coroutine[Any, Any, T]) -> T:
    """Run `operation` to the end even if the caller is cancelled.

    The broker's steps that must not stop half done: taking back a token it
    just issued, storing a sign-in the vendor has already rotated, marking a
    connection as needing reauthorization. A failure seen only after the
    caller has gone is logged, as nobody is left to raise it to.
    """
    task = asyncio.create_task(operation)
    try:
        return await asyncio.shield(task)
    except asyncio.CancelledError:
        while not task.done():
            try:
                await asyncio.shield(task)
            except asyncio.CancelledError:
                continue
            except Exception:
                break
        if not task.cancelled() and task.exception() is not None:
            logger.error(
                "Service operation failed after its caller was cancelled",
                exc_info=task.exception(),
            )
        raise
