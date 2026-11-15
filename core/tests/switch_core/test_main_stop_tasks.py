"""Stopping background work at shutdown: each task has finished before the
next step closes what it uses."""

from __future__ import annotations

import asyncio
import logging

import pytest

from switch_core import main


async def test_every_task_has_stopped_when_it_returns() -> None:
    cleaned_up: list[str] = []

    async def loop(name: str) -> None:
        try:
            await asyncio.sleep(3600)
        finally:
            await asyncio.sleep(0.01)
            cleaned_up.append(name)

    first = asyncio.create_task(loop("first"))
    second = asyncio.create_task(loop("second"))
    await asyncio.sleep(0)

    await main._stop_tasks(first, second)

    assert sorted(cleaned_up) == ["first", "second"]
    assert first.done() and second.done()


async def test_a_task_that_had_failed_is_logged_and_the_rest_still_stop(
    caplog: pytest.LogCaptureFixture,
) -> None:
    async def failed() -> None:
        raise RuntimeError("broken")

    async def waits() -> None:
        await asyncio.sleep(3600)

    broken = asyncio.create_task(failed(), name="broken")
    waiting = asyncio.create_task(waits())
    await asyncio.sleep(0)

    with caplog.at_level(logging.ERROR, logger=main.logger.name):
        await main._stop_tasks(broken, waiting)

    assert waiting.cancelled()
    assert "broken had failed" in caplog.text
