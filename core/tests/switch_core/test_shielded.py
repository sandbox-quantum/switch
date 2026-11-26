"""Tests for finish_shielded: runs to completion despite cancellation.

The anyio.CancelScope(shield=True) approach prevents busy-loops when uvicorn
(using anyio) re-delivers cancellations, which the old asyncio.shield loop did
not handle. These tests verify basic functionality; the busy-loop fix is
specific to the anyio/uvicorn runtime environment.
"""

from __future__ import annotations

import asyncio
import time

import anyio
import pytest

from switch_core.shielded import finish_shielded


async def test_finish_shielded_returns_result_when_not_cancelled() -> None:
    async def operation() -> int:
        return 42

    result = await finish_shielded(operation())
    assert result == 42


async def test_finish_shielded_propagates_exceptions() -> None:
    async def failing_operation() -> None:
        raise ValueError("test error")

    with pytest.raises(ValueError, match="test error"):
        await finish_shielded(failing_operation())


async def test_finish_shielded_completes_despite_anyio_cancellation() -> None:
    started = asyncio.Event()
    release = asyncio.Event()
    completed: list[str] = []

    async def operation() -> int:
        started.set()
        await release.wait()
        await asyncio.sleep(0.05)
        completed.append("finished")
        return 7

    async def caller() -> None:
        await finish_shielded(operation())

    start_time = time.monotonic()
    async with anyio.create_task_group() as group:
        group.start_soon(caller)
        await started.wait()
        group.cancel_scope.cancel()
        with anyio.CancelScope(shield=True):
            await anyio.sleep(0.01)
            assert completed == [], "operation should not finish while still waiting"
            release.set()
    elapsed = time.monotonic() - start_time

    assert completed == ["finished"], "operation must finish before group exits"
    assert elapsed >= 0.04, (
        f"group exit must wait for operation (elapsed: {elapsed:.3f}s)"
    )
