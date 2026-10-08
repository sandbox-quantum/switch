"""A Discord bridge on the shared connection is attached as it starts.

It used to be attached at boot, if it existed then, and otherwise only when its
guild's first message arrived. Until that message a new install could not reach
Discord at all: searching its members to link an account failed, and so did
anything else that needed the socket. The lifecycle now hands each bridge to
the gateway client as it starts, before anything in it runs, and the client
attaches it if the connection is up.
"""

from __future__ import annotations

import uuid
from typing import Any

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.bridges.collaboration.adapter import PlatformAdapter
from switch_core.bridges.collaboration.discord.adapter import (
    DiscordAdapter,
    DiscordConnectionConfig,
)
from switch_core.bridges.collaboration.discord.connection import DiscordConnection
from switch_core.bridges.collaboration.discord.gateway import DiscordGatewayClient

from .test_lifecycle_tenant_binding import (
    _make_bridge,
    _make_tenant,
    _service,
    _StubAdapter,
    _StubConfig,
)


def _shared_adapter() -> DiscordAdapter:
    return DiscordAdapter(
        config=DiscordConnectionConfig(guild_id="900", event_delivery="shared")
    )


async def _noop_on_connected(_connection: DiscordConnection) -> None: ...


def _gateway() -> DiscordGatewayClient:
    install_service: Any = object()
    return DiscordGatewayClient(
        bot_token="bot-token",
        message_content=False,
        members=False,
        install_service=install_service,
        on_connected=_noop_on_connected,
    )


async def _connect(
    gateway: DiscordGatewayClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    async def _start() -> None: ...

    monkeypatch.setattr(gateway, "start", _start)
    await gateway.start_with_retry()


class TestTheGatewayClient:
    async def test_a_bridge_starting_while_the_connection_is_up_is_attached(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        gateway = _gateway()
        await _connect(gateway, monkeypatch)
        adapter = _shared_adapter()

        gateway.attach_if_live(adapter)

        assert adapter._connection is gateway.connection

    async def test_one_starting_before_the_connection_is_up_is_left_for_later(
        self,
    ) -> None:
        # Attached now it would provision against a client that is not there,
        # and the attach on connect would be a no-op that never redoes it.
        gateway = _gateway()
        adapter = _shared_adapter()

        gateway.attach_if_live(adapter)

        assert adapter._connection is None

    async def test_the_walk_on_connect_sees_the_connection_as_up(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # So a bridge starting during the walk is attached by one or the other.
        seen: list[DiscordConnection | None] = []
        gateway = _gateway()
        adapter = _shared_adapter()

        async def on_connected(_connection: DiscordConnection) -> None:
            gateway.attach_if_live(adapter)
            seen.append(adapter._connection)

        gateway._on_connected = on_connected
        await _connect(gateway, monkeypatch)

        assert seen == [gateway.connection]

    async def test_another_platforms_adapter_is_left_alone(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        gateway = _gateway()
        await _connect(gateway, monkeypatch)
        other = _StubAdapter(config=_StubConfig())

        gateway.attach_if_live(other)  # type: ignore[arg-type]

        assert not hasattr(other, "_connection")


class TestTheLifecycle:
    async def test_a_listener_is_handed_the_adapter_before_the_bridge_runs(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        tenant = f"tenant-{uuid.uuid4().hex[:8]}"
        async with session_factory() as session:
            await _make_tenant(session, tenant)
            bridge_id, _ = await _make_bridge(session, tenant_id=tenant)
            await session.commit()

        service = _service(session_factory)
        service.register_adapter("mattermost", _StubAdapter, _StubConfig)
        events: list[str] = []
        handed: list[PlatformAdapter] = []

        def listener(adapter: PlatformAdapter) -> None:
            events.append("listener")
            handed.append(adapter)

        async def _run(*_: object) -> None:
            events.append("run")

        service._run_bridge = _run  # type: ignore[method-assign]
        service.add_bridge_starting_listener(listener)

        await service.start(bridge_id)

        assert events[0] == "listener"
        assert handed == [service.get_adapter(bridge_id)]
        await service.stop_all()
