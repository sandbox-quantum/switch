"""A bridge that crashes while running is started again after a backoff (#1510).

A bridge whose platform is not accepting connections yet — Mattermost still
coming up behind a Docker restart — crashed once and stayed down, so no message
reached any agent until someone turned the bridge off and on. It is now started
again after a pause that doubles with each crash in a row. A failure another
attempt cannot fix (refused credentials, a bad config) still waits for an edit,
and a bridge stopped while it waits is not started behind the operator's back.

No database: `_start_bridge` is stood in for by one that runs the real
`_run_bridge` over a core whose `start` fails as many times as a test says.
"""

from __future__ import annotations

import asyncio
from unittest.mock import MagicMock

import pytest

from switch_core.bridges.collaboration import lifecycle_service as lifecycle_module
from switch_core.bridges.collaboration.lifecycle_service import (
    CollaborationBridgeLifecycleService,
)
from switch_core.bridges.collaboration.models import BridgeCredentialError
from tests.switch_core.bridges.collaboration.test_lifecycle_tenant_binding import (
    _service,
)

BRIDGE = "bridge-1"


class _FlakyCore:
    """Fails to come up `failures` times with `error`, then runs until stopped."""

    active = False

    def __init__(self, attempts: list[int], failures: int, error: Exception) -> None:
        self._attempts = attempts
        self._failures = failures
        self._error = error

    async def start(self) -> None:
        self._attempts.append(len(self._attempts) + 1)
        if len(self._attempts) <= self._failures:
            raise self._error

    async def stop(self) -> None:
        return None


def _flaky_service(
    *, failures: int, error: Exception | None = None
) -> tuple[CollaborationBridgeLifecycleService, list[int]]:
    service = _service(MagicMock())
    attempts: list[int] = []

    async def start_bridge(bridge_id: str) -> None:
        core = _FlakyCore(
            attempts, failures, error or ConnectionError("connection refused")
        )
        service._started_rows[bridge_id] = "row"
        service._started.add(bridge_id)
        service._bridges[bridge_id] = core  # type: ignore[assignment]
        service._tasks[bridge_id] = asyncio.create_task(
            service._run_bridge(bridge_id, "tenant", core, None)  # type: ignore[arg-type]
        )

    service._start_bridge = start_bridge  # type: ignore[method-assign]
    service._owned.want(BRIDGE)
    return service, attempts


async def _until(condition: object, timeout: float = 2.0) -> None:
    async def wait() -> None:
        while not condition():  # type: ignore[operator]
            await asyncio.sleep(0.005)

    await asyncio.wait_for(wait(), timeout)


@pytest.fixture(autouse=True)
def _short_backoff(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(lifecycle_module, "CRASH_RETRY_INITIAL_SECONDS", 0.01)
    monkeypatch.setattr(lifecycle_module, "STOP_GRACE_SECONDS", 0.01)


async def test_a_bridge_whose_platform_is_not_up_yet_is_started_again() -> None:
    service, attempts = _flaky_service(failures=2)
    try:
        await service.start(BRIDGE)
        await _until(lambda: service.is_connected(BRIDGE))
        assert attempts == [1, 2, 3]
        assert BRIDGE in service._bridges
        assert BRIDGE not in service._crash_retries
    finally:
        await service.stop_all()


async def test_refused_credentials_wait_for_an_edit() -> None:
    service, attempts = _flaky_service(
        failures=99, error=BridgeCredentialError("token revoked")
    )
    try:
        await service.start(BRIDGE)
        await _until(lambda: BRIDGE not in service._bridges)
        await asyncio.sleep(0.1)
        assert attempts == [1]
        assert BRIDGE not in service._crash_retries
    finally:
        await service.stop_all()


async def test_a_bridge_stopped_while_it_waits_is_not_started_again(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(lifecycle_module, "CRASH_RETRY_INITIAL_SECONDS", 0.2)
    service, attempts = _flaky_service(failures=1)
    try:
        await service.start(BRIDGE)
        await _until(lambda: BRIDGE in service._crash_retries)
        retry = service._crash_retries[BRIDGE]

        await service.stop(BRIDGE)
        await asyncio.sleep(0.3)

        assert retry.cancelled()
        assert attempts == [1]
        assert BRIDGE not in service._bridges
    finally:
        await service.stop_all()


async def test_a_bridge_edited_while_it_waits_is_left_to_the_edit(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The retry is of the row that crashed; a newer one is the re-check's."""
    monkeypatch.setattr(lifecycle_module, "CRASH_RETRY_INITIAL_SECONDS", 0.05)
    service, attempts = _flaky_service(failures=1)
    try:
        await service.start(BRIDGE)
        await _until(lambda: BRIDGE in service._crash_retries)
        service._started_rows[BRIDGE] = "edited row"
        retry = service._crash_retries[BRIDGE]
        await asyncio.wait({retry}, timeout=1.0)
        assert attempts == [1]
    finally:
        await service.stop_all()


async def test_shutdown_cancels_a_waiting_retry(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(lifecycle_module, "CRASH_RETRY_INITIAL_SECONDS", 10.0)
    service, _ = _flaky_service(failures=1)
    await service.start(BRIDGE)
    await _until(lambda: BRIDGE in service._crash_retries)
    retry = service._crash_retries[BRIDGE]

    await service.stop_all()

    assert retry.cancelled()
    assert service._crash_retries == {}


async def test_the_backoff_doubles_up_to_its_cap(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(lifecycle_module, "CRASH_RETRY_INITIAL_SECONDS", 2.0)
    monkeypatch.setattr(lifecycle_module, "CRASH_RETRY_MAX_SECONDS", 60.0)
    service = _service(MagicMock())
    delays: list[float] = []

    async def retry(bridge_id: str, started_from: str | None, delay: float) -> None:
        delays.append(delay)

    service._retry_after_crash = retry  # type: ignore[method-assign]
    for _ in range(7):
        service._schedule_crash_retry(BRIDGE)
        await asyncio.sleep(0)

    assert delays == [2.0, 4.0, 8.0, 16.0, 32.0, 60.0, 60.0]

    # A deliberate stop or start begins the next streak afresh.
    service._cancel_crash_retry(BRIDGE)
    service._schedule_crash_retry(BRIDGE)
    await asyncio.sleep(0)
    assert delays[-1] == 2.0
