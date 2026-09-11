"""One client row, one running task (CHOO-2623).

Starting a client that is already running used to overwrite the registry entry
and drop the running task on the floor. The task stayed alive — subscribed to
its rooms, holding the invite slot for its user — until the garbage collector
reached it, at which point it ran its own teardown and took the *live* client's
invite registration with it. The live client then heard no invitation for any
room it was added to afterwards, with nothing in the log to say why.
"""

from __future__ import annotations

import asyncio
from unittest.mock import MagicMock

from switch_core.clients.client_lifecycle_service import ClientLifecycleService
from switch_core.db.stores.client_store import ClientStore
from switch_core.db.stores.tenant_store import TenantStore


class _BlockingClient:
    """A client whose task never finishes on its own, like a receive loop."""

    def __init__(self) -> None:
        self.display_name = "blocking"
        self.matrix_user_id = "@blocking:test"
        self.stopped = False

    async def start(self) -> None:
        await asyncio.Event().wait()

    async def stop(self) -> None:
        self.stopped = True


def _service() -> ClientLifecycleService:
    return ClientLifecycleService(
        matrix_admin=MagicMock(),
        client_store=ClientStore(),
        tenant_store=TenantStore(),
        client_factory=MagicMock(),
        session_factory=MagicMock(),
        config=MagicMock(),
    )


async def test_starting_a_client_twice_cancels_the_first_task() -> None:
    service = _service()
    service._start_task("client-1", _BlockingClient())  # type: ignore[arg-type]
    await asyncio.sleep(0)
    first = service._tasks["client-1"]

    service._start_task("client-1", _BlockingClient())  # type: ignore[arg-type]
    second = service._tasks["client-1"]
    await asyncio.gather(first, return_exceptions=True)

    assert first.cancelled(), "the superseded task was dropped, not stopped"
    assert second is not first
    assert not second.done()

    second.cancel()
    await asyncio.gather(second, return_exceptions=True)


async def test_stop_all_waits_for_the_tasks_it_cancelled() -> None:
    """Cancelling without awaiting leaves the unwinding to the loop, or to the
    collector if the loop never runs the task again."""
    service = _service()
    client = _BlockingClient()
    service._clients["client-1"] = client  # type: ignore[assignment]
    service._client_types["client-1"] = "agent"
    service._client_tenants["client-1"] = "tenant-1"
    service._start_task("client-1", client)  # type: ignore[arg-type]
    await asyncio.sleep(0)
    task = service._tasks["client-1"]

    await service.stop_all()

    assert task.done(), "stop_all returned while a client task was still running"
    assert client.stopped
    assert service._tasks == {}
