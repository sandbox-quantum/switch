"""Handing a running bridge its place on the shared callback listener.

An adapter is built from its connection config and nothing else — it is never
told which bridge it is, which is what stops one bridge addressing another's
callbacks. So the endpoint has to be handed to it, by the one thing that knows
both: the service that started it.

The other half is that the place goes away with the bridge. A press for a
bridge that has been stopped must not be handled by an adapter that is halfway
through shutting down.
"""

from __future__ import annotations

import uuid
from typing import Any

import aiohttp
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.bridges.collaboration.ingress import CallbackEndpoint

from .test_collaboration_ingress import _free_port
from .test_lifecycle_tenant_binding import (
    _make_bridge,
    _make_tenant,
    _service,
    _StubAdapter,
    _StubConfig,
)


class _CallbackAdapter(_StubAdapter):
    """A bridge that asks to be called back, and remembers what it was given."""

    def __init__(self, *, config: Any) -> None:
        super().__init__(config=config)
        self.endpoint: CallbackEndpoint | None = None

    def set_callback_endpoint(self, endpoint: CallbackEndpoint) -> None:
        self.endpoint = endpoint

    async def start(self, *a: Any, **k: Any) -> Any:
        assert self.endpoint is not None
        await self.endpoint.serve(self._take)

    async def _take(self, body: dict[str, Any]) -> dict[str, Any]:
        return {"heard": body}


class _StubCore:
    async def start(self) -> None:
        return None


class _FailingClient:
    """A bridge client whose connection to the room server never comes up."""

    client_id = "bridge-client"

    async def start(self) -> None:
        raise RuntimeError("the room client is down")


async def _start_one(
    session_factory: async_sessionmaker[AsyncSession], port: int
) -> tuple[Any, str, str, _CallbackAdapter]:
    tenant = f"tenant-{uuid.uuid4().hex[:8]}"
    async with session_factory() as session:
        await _make_tenant(session, tenant)
        bridge_id, _ = await _make_bridge(session, tenant_id=tenant)
        await session.commit()

    service = _service(session_factory, callback_port=port)
    built: list[_CallbackAdapter] = []

    class _Recording(_CallbackAdapter):
        def __init__(self, *, config: Any) -> None:
            super().__init__(config=config)
            built.append(self)

    service.register_adapter("mattermost", _Recording, _StubConfig)

    async def _run(bridge_id: str, tenant_id: str, *_: object) -> None:
        return None

    service._run_bridge = _run  # type: ignore[method-assign]

    await service.start(bridge_id)
    # What the bridge's own task would have done, awaited rather than raced:
    # the adapter asks for its place as it starts.
    await built[0].start()
    return service, tenant, bridge_id, built[0]


async def _post(port: int, bridge_id: str) -> int:
    url = f"http://127.0.0.1:{port}/collaboration/mattermost/{bridge_id}/callback"
    async with aiohttp.ClientSession() as session:
        async with session.post(url, json={}) as response:
            return response.status


async def test_a_started_bridge_is_given_its_own_place_and_is_reachable_there(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    port = _free_port()
    service, _tenant, bridge_id, adapter = await _start_one(session_factory, port)

    try:
        assert adapter.endpoint is not None
        assert adapter.endpoint.path == (
            f"/collaboration/mattermost/{bridge_id}/callback"
        )
        assert await _post(port, bridge_id) == 200
    finally:
        await service.stop_all()


async def test_stopping_a_bridge_takes_its_place_with_it(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    """A press posted a minute ago still arrives. It must not be handed to an
    adapter that is no longer running."""
    port = _free_port()
    service, _tenant, bridge_id, _ = await _start_one(session_factory, port)

    try:
        await service.stop(bridge_id)

        assert await _post(port, bridge_id) == 404
    finally:
        await service.stop_all()


async def test_a_bridge_that_crashes_takes_its_place_with_it(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    """A bridge dies in its own task, so nothing calls `stop` for it. Left
    registered, its place on the listener would go on answering presses that
    reach an adapter which is no longer running."""
    port = _free_port()
    service, tenant, bridge_id, _ = await _start_one(session_factory, port)

    try:
        assert await _post(port, bridge_id) == 200

        await type(service)._run_bridge(
            service, bridge_id, tenant, _StubCore(), _FailingClient()
        )

        assert await _post(port, bridge_id) == 404
    finally:
        await service.stop_all()


async def test_shutting_everything_down_closes_the_port(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    port = _free_port()
    service, _tenant, bridge_id, _ = await _start_one(session_factory, port)

    await service.stop_all()

    try:
        await _post(port, bridge_id)
    except aiohttp.ClientConnectorError:
        return
    raise AssertionError("the listener is still bound after a full shutdown")
