"""Discord's one shared Gateway connection opens in one process, and every
shared-delivery bridge is held there.

Against real PostgreSQL, two "processes" on one database, each wired as
`test_bridge_ownership.py` wires one, with the shared Gateway client `main`
builds when a Discord app is configured. Discord here (`_Discord`) knows
which connections hold a socket, which Discord delivers every event to, and
which are logged in for the API alone, which it delivers nothing to. The
gateway hands each event to the bridge in its own process, so a bridge held
anywhere but beside the socket would never hear one.
"""

from __future__ import annotations

import asyncio
import uuid
from collections.abc import AsyncIterator, Awaitable, Callable
from dataclasses import dataclass
from datetime import timedelta
from typing import Any
from unittest.mock import AsyncMock, MagicMock

import pytest
from sqlalchemy import func, update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.bridges.collaboration.discord import gateway as gateway_module
from switch_core.bridges.collaboration.discord.adapter import (
    DiscordAdapter,
    DiscordConnectionConfig,
)
from switch_core.bridges.collaboration.discord.connection import DiscordConnection
from switch_core.bridges.collaboration.discord.gateway import DiscordGatewayClient
from switch_core.db.models import Client, CollaborationBridge, SwitchCoreProcess
from switch_core.process_lease import LEASE_TTL
from tests.switch_core.bridges.collaboration.test_bridge_ownership import (
    _Process,
)
from tests.switch_core.bridges.collaboration.test_bridge_ownership import (
    _process as _bridge_process,
)

TIMEOUT = 10.0
# Enough bridges that, placed each on its own, some would land on the process
# without the socket: all six landing beside it is a chance of 1 in 64.
BRIDGES = 6


class _Discord:
    """Discord, as far as the bot's connections reach it."""

    def __init__(self) -> None:
        self.sockets: list[_Connection] = []
        self.logged_in: list[_Connection] = []
        # The most sockets the bot ever held open at once.
        self.most_sockets = 0


class _Connection:
    """A `DiscordConnection` that reaches `_Discord` instead of Discord."""

    def __init__(self, discord: _Discord) -> None:
        self.discord = discord
        self.bot_user_id = 1
        self.client = MagicMock()

    def set_guild_message_handler(self, handler: Any) -> None:
        pass

    def set_interaction_handler(self, handler: Any) -> None:
        pass

    def set_channel_update_handler(self, handler: Any) -> None:
        pass

    def set_guild_lifecycle_handlers(self, **handlers: Any) -> None:
        pass

    async def connect(self, *, commands: Any) -> None:
        self.discord.sockets.append(self)
        self.discord.most_sockets = max(
            self.discord.most_sockets, len(self.discord.sockets)
        )

    async def login(self) -> None:
        self.discord.logged_in.append(self)

    async def close(self) -> None:
        if self in self.discord.sockets:
            self.discord.sockets.remove(self)
        if self in self.discord.logged_in:
            self.discord.logged_in.remove(self)


@dataclass
class _WithGateway:
    process: _Process
    gateway: DiscordGatewayClient
    connection: _Connection
    # How many times the gateway has tried to attach the bridges.
    attach_attempts: Callable[[], int]

    async def boot(self) -> None:
        """Start as `main` does, the gateway wanted before the first balance
        and logged in for the API alone after it where not held."""
        await self.process.clients.start_all()
        await self.process.bridges.start_all()
        self.gateway.own(self.process.ownership)
        await self.process.ownership.start()
        await self.process.bridges.start_quiet_copies()
        self.gateway.start_quietly()

    async def stop(self) -> None:
        """Shut down as `main` does: the owned work, socket included, first,
        then the quiet copies, then the API log-in."""
        await self.process.stop()
        await self.gateway.stop()

    def has_socket(self) -> bool:
        return self.connection in self.connection.discord.sockets

    def holds_every(self, bridge_ids: list[str]) -> bool:
        return all(self.process.bridges.holds(b) for b in bridge_ids)

    def attached_every(self, bridge_ids: list[str]) -> bool:
        return all(
            getattr(self.process.bridges.get_adapter(b), "_connection", None)
            is self.connection
            for b in bridge_ids
        )


async def _with_gateway(
    postgres_url: str,
    session_factory: async_sessionmaker[AsyncSession],
    discord: _Discord,
    *,
    attach_failures: int = 0,
) -> _WithGateway:
    """`attach_failures` is how many times attaching the bridges fails before
    it succeeds."""
    process = await _bridge_process(postgres_url, session_factory)
    process.bridges.register_adapter("discord", DiscordAdapter, DiscordConnectionConfig)
    bridges = process.bridges
    attempts = 0

    async def attach(connection: DiscordConnection) -> None:
        nonlocal attempts
        attempts += 1
        if attempts <= attach_failures:
            raise RuntimeError("attaching the bridges failed")
        for adapter in bridges.iter_adapters():
            if isinstance(adapter, DiscordAdapter):
                adapter.attach_shared_connection(connection)

    gateway = DiscordGatewayClient(
        bot_token="bot-token",
        message_content=False,
        members=False,
        install_service=AsyncMock(),
        on_connected=attach,
    )
    connection = _Connection(discord)
    gateway._connection = connection  # type: ignore[assignment]
    bridges.add_bridge_starting_listener(gateway.attach_if_live)
    return _WithGateway(
        process=process,
        gateway=gateway,
        connection=connection,
        attach_attempts=lambda: attempts,
    )


@pytest.fixture
async def shared_bridges(
    session_factory: async_sessionmaker[AsyncSession],
) -> list[str]:
    """Discord servers installed through the deployment's shared app."""
    ids: list[str] = []
    async with session_factory() as session:
        for n in range(BRIDGES):
            client = Client(
                transport_user_id=f"@switch-bridge-{uuid.uuid4().hex[:8]}:test",
                display_name="bridge",
                type="bridge",
            )
            session.add(client)
            await session.flush()
            row = CollaborationBridge(
                type="discord",
                display_name=f"Server {n}",
                connection_config={
                    "guild_id": str(1000 + n),
                    "event_delivery": "shared",
                },
                client_id=client.id,
                status="active",
                channel_creation_enabled=False,
                preconfigured=False,
            )
            session.add(row)
            await session.flush()
            ids.append(row.id)
        await session.commit()
    return ids


@pytest.fixture
async def two(
    postgres_url: str,
    session_factory: async_sessionmaker[AsyncSession],
    shared_bridges: list[str],
) -> AsyncIterator[tuple[_WithGateway, _WithGateway]]:
    discord = _Discord()
    started: list[_WithGateway] = []
    try:
        for _ in range(2):
            process = await _with_gateway(postgres_url, session_factory, discord)
            started.append(process)
            await process.boot()
        # The first balance of each cannot see the other; balance once more
        # now that both leases are there, as the interval would.
        for process in started:
            await process.process.ownership.balance()
        for process in started:
            await process.process.settled()
        yield started[0], started[1]
    finally:
        for process in started:
            await process.stop()


async def _eventually(check: Callable[[], bool | Awaitable[bool]]) -> None:
    async with asyncio.timeout(TIMEOUT):
        while True:
            answer = check()
            if answer if isinstance(answer, bool) else await answer:
                return
            await asyncio.sleep(0.02)


def _with_socket(
    two: tuple[_WithGateway, _WithGateway],
) -> tuple[_WithGateway, _WithGateway]:
    a, b = two
    owners = [p for p in (a, b) if p.has_socket()]
    assert len(owners) == 1
    return (a, b) if owners[0] is a else (b, a)


class TestOneSocket:
    async def test_one_process_opens_the_socket_and_holds_every_shared_bridge(
        self,
        two: tuple[_WithGateway, _WithGateway],
        shared_bridges: list[str],
    ) -> None:
        a, b = two
        await _eventually(lambda: a.has_socket() or b.has_socket())
        owner, other = _with_socket(two)

        await _eventually(
            lambda: other.connection in other.connection.discord.logged_in
        )
        assert owner.holds_every(shared_bridges)
        assert not any(other.process.bridges.holds(b) for b in shared_bridges)
        assert owner.connection.discord.most_sockets == 1

    async def test_every_copy_of_a_bridge_is_attached_to_its_own_process_connection(
        self,
        two: tuple[_WithGateway, _WithGateway],
        shared_bridges: list[str],
    ) -> None:
        """The quiet copies serve requests over the API log-in."""
        for process in two:
            for bridge_id in shared_bridges:
                await _eventually(
                    lambda p=process, b=bridge_id: (
                        getattr(p.process.bridges.get_adapter(b), "_connection", None)
                        is p.connection
                    )
                )


class TestBringingUp:
    async def test_attaching_the_bridges_is_retried_when_it_fails(
        self,
        postgres_url: str,
        session_factory: async_sessionmaker[AsyncSession],
        shared_bridges: list[str],
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """A process that takes the socket and fails to attach its bridges
        tries the bring-up again, rather than holding the socket with no
        bridge attached, which would leave Discord silent until the socket
        next moved."""
        monkeypatch.setattr(gateway_module, "_INITIAL_RETRY_DELAY", 0.05)
        discord = _Discord()
        process = await _with_gateway(
            postgres_url, session_factory, discord, attach_failures=1
        )
        try:
            await process.boot()

            await _eventually(lambda: process.attached_every(shared_bridges))
            assert process.attach_attempts() == 2
            assert process.holds_every(shared_bridges)
            assert discord.sockets == [process.connection]
        finally:
            await process.stop()


class TestHandingOver:
    async def test_a_process_stopping_hands_the_socket_and_its_bridges_over(
        self,
        two: tuple[_WithGateway, _WithGateway],
        shared_bridges: list[str],
    ) -> None:
        a, b = two
        await _eventually(lambda: a.has_socket() or b.has_socket())
        owner, other = _with_socket(two)

        await owner.stop()
        await other.process.ownership.balance()

        await _eventually(other.has_socket)
        assert other.holds_every(shared_bridges)
        assert other.connection.discord.sockets == [other.connection]
        assert other.connection.discord.most_sockets == 1

    async def test_a_socket_whose_bring_up_keeps_failing_is_closed_as_it_is_handed_over(
        self,
        postgres_url: str,
        session_factory: async_sessionmaker[AsyncSession],
        shared_bridges: list[str],
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """Attaching the bridges keeps failing once the socket is up, so the
        bring-up is still being retried when the socket is handed over. The
        hand-over stops it, and the next holder opens a socket of its own, so
        this one has to be closed by then."""
        monkeypatch.setattr(gateway_module, "_INITIAL_RETRY_DELAY", 0.05)
        discord = _Discord()
        started: list[_WithGateway] = []
        try:
            failing = await _with_gateway(
                postgres_url, session_factory, discord, attach_failures=1_000
            )
            started.append(failing)
            # Alone, so it takes the socket.
            await failing.boot()
            await _eventually(lambda: failing.attach_attempts() >= 2)
            other = await _with_gateway(postgres_url, session_factory, discord)
            started.append(other)
            await other.boot()

            # Not the gateway's own `stop`, which `main` calls only after the
            # drain: only the hand-over can have closed the socket by now.
            await failing.process.stop()
            await other.process.ownership.balance()

            await _eventually(other.has_socket)
            assert other.holds_every(shared_bridges)
            assert discord.sockets == [other.connection]
            assert discord.most_sockets == 1
        finally:
            for process in started:
                await process.stop()

    async def test_a_process_that_died_is_taken_over_once_its_lease_lapses(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        two: tuple[_WithGateway, _WithGateway],
        shared_bridges: list[str],
    ) -> None:
        a, b = two
        await _eventually(lambda: a.has_socket() or b.has_socket())
        owner, other = _with_socket(two)

        # It dies without a word: no more renewals, and Discord drops the
        # socket of a bot that stopped answering.
        for task in owner.process.tasks:
            task.cancel()
        await owner.connection.close()
        await other.process.ownership.balance()
        assert not other.has_socket()

        async with session_factory() as session:
            await session.execute(
                update(SwitchCoreProcess)
                .where(SwitchCoreProcess.id == owner.process.lease.process_id)
                .values(beat_at=func.now() - LEASE_TTL - timedelta(seconds=1))
            )
            await session.commit()
        await other.process.ownership.balance()

        await _eventually(other.has_socket)
        assert other.holds_every(shared_bridges)
