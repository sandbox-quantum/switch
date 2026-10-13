"""A client that fails on the database at start is retried, not dropped.

On 9 Oct a pilot restart started every client at once, the pool ran dry, and
13 clients timed out waiting for a connection. Each was dropped for good, so
its agent could not post until the next restart.
"""

from __future__ import annotations

import asyncio
from unittest.mock import MagicMock

import pytest
from sqlalchemy.exc import TimeoutError as PoolTimeoutError

from switch_core.clients import client_lifecycle_service as lifecycle
from switch_core.clients.client_lifecycle_service import ClientLifecycleService


class _FlakyClient:
    """Fails its first `failures` starts with `error`, then runs."""

    def __init__(self, failures: int, error: Exception) -> None:
        self.display_name = "flaky"
        self.transport_user_id = "@flaky:test"
        self.starts = 0
        self._failures = failures
        self._error = error
        self.running = asyncio.Event()

    async def start(self) -> None:
        self.starts += 1
        if self.starts <= self._failures:
            raise self._error
        self.running.set()
        await asyncio.Event().wait()

    async def stop(self) -> None:
        return None


def _service() -> ClientLifecycleService:
    return ClientLifecycleService(
        provisioning=MagicMock(),
        client_store=MagicMock(),
        tenant_store=MagicMock(),
        client_factory=MagicMock(),
        session_factory=MagicMock(),
        config=MagicMock(),
        tenants_isolated=True,
    )


@pytest.fixture(autouse=True)
def _no_wait(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(lifecycle, "CLIENT_RETRY_BASE_SECONDS", 0.0)


async def test_a_pool_timeout_at_start_is_retried_until_the_client_runs() -> None:
    service = _service()
    client = _FlakyClient(failures=2, error=PoolTimeoutError("QueuePool limit reached"))
    service._clients["c1"] = client  # type: ignore[assignment]

    service._start_task("c1", client, client)  # type: ignore[arg-type]
    await asyncio.wait_for(client.running.wait(), timeout=2)

    assert client.starts == 3
    assert service.get("c1") is client
    service._cancel_task("c1")


async def test_any_other_error_still_ends_the_client() -> None:
    service = _service()
    client = _FlakyClient(failures=1, error=ValueError("a bug in the client"))
    service._clients["c1"] = client  # type: ignore[assignment]

    service._start_task("c1", client, client)  # type: ignore[arg-type]
    for _ in range(50):
        if service.get("c1") is None:
            break
        await asyncio.sleep(0.01)

    assert client.starts == 1
    assert service.get("c1") is None
