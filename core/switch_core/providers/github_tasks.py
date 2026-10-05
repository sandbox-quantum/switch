import asyncio
import logging
from collections.abc import Coroutine
from typing import Any

logger = logging.getLogger(__name__)


async def finish_shielded[T](operation: Coroutine[Any, Any, T]) -> T:
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
                "GitHub operation failed after caller cancellation",
                exc_info=task.exception(),
            )
        raise
