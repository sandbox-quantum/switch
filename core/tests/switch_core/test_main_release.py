"""A process shutting down hands over the work it owns before its lease goes.

The other processes may take over a process's owned work (a client's
consumer, a bridge's connection, a server-side connector) as soon as its
lease reads as stopped. So the lease is marked stopped only after that work
has stopped here; if it cannot be stopped, the lease is left to lapse on its
own, which gives the work time to end before anyone else starts it.
"""

from __future__ import annotations

import asyncio
from typing import Any

import pytest

from switch_core import main as main_module
from switch_core.main import _release_process


class _Ownership:
    def __init__(self, calls: list[str], *, stop: Any = None) -> None:
        self._calls = calls
        self._stop = stop

    async def stop(self) -> None:
        if self._stop is not None:
            await self._stop()
        self._calls.append("owned work handed over")

    def gone(self) -> None:
        self._calls.append("others told")


class _Connections:
    def __init__(self, calls: list[str]) -> None:
        self._calls = calls

    async def flush(self) -> None:
        self._calls.append("connections recorded")


class _Lease:
    process_id = "test-pod-1"

    def __init__(self, calls: list[str]) -> None:
        self._calls = calls

    async def stop(self) -> None:
        self._calls.append("lease released")


async def test_owned_work_is_handed_over_before_the_lease_is_released() -> None:
    calls: list[str] = []

    await _release_process(
        _Ownership(calls),  # type: ignore[arg-type]
        _Connections(calls),  # type: ignore[arg-type]
        None,
        _Lease(calls),  # type: ignore[arg-type]
    )

    assert calls == [
        "owned work handed over",
        "connections recorded",
        "lease released",
        "others told",
    ]


async def test_a_hand_over_that_fails_leaves_the_lease_to_lapse() -> None:
    calls: list[str] = []

    async def fail() -> None:
        raise RuntimeError("a bridge would not stop")

    await _release_process(
        _Ownership(calls, stop=fail),  # type: ignore[arg-type]
        _Connections(calls),  # type: ignore[arg-type]
        None,
        _Lease(calls),  # type: ignore[arg-type]
    )

    assert "lease released" not in calls


async def test_a_hand_over_that_hangs_leaves_the_lease_to_lapse(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(main_module, "_HAND_OVER_SECONDS", 0.05)
    calls: list[str] = []

    async def hang() -> None:
        await asyncio.Event().wait()

    await _release_process(
        _Ownership(calls, stop=hang),  # type: ignore[arg-type]
        _Connections(calls),  # type: ignore[arg-type]
        None,
        _Lease(calls),  # type: ignore[arg-type]
    )

    assert calls == []
