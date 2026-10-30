"""A connector app saved or removed in one process is put to work in every one.

Two "processes" on one database, each with its own `ConnectorApps`, broker,
gateway state and signal bus: a save announced by one has to reach the
other's broker, which only the signal and the re-read of the row can do. A
process that missed the signal finds the change on its re-check.
"""

from __future__ import annotations

import asyncio
import uuid
from collections.abc import AsyncIterator, Awaitable, Callable
from dataclasses import dataclass

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.pool import NullPool
from starlette.datastructures import State

from switch_core.connections.app_credentials import ConnectorApps
from switch_core.connections.app_signals import (
    CONNECTOR_APP_CHANGED_SIGNAL,
    ConnectorAppSignals,
)
from switch_core.connections.broker import ServiceBroker
from switch_core.signals import SignalBus
from tests.switch_core.connections.test_app_credentials import _apps, _broker, _save

DELIVERY_TIMEOUT = 10.0
GOOGLE = "google-workspace"


@dataclass
class _Process:
    apps: ConnectorApps
    broker: ServiceBroker
    state: State
    bus: SignalBus
    signals: ConnectorAppSignals


def _bus(
    postgres_url: str, session_factory: async_sessionmaker[AsyncSession]
) -> SignalBus:
    return SignalBus(
        session_factory,
        lambda: create_async_engine(postgres_url, poolclass=NullPool),
        process_id=str(uuid.uuid4()),
    )


async def _process(
    postgres_url: str, session_factory: async_sessionmaker[AsyncSession]
) -> _Process:
    apps = _apps(session_factory)
    await apps.load()
    broker = _broker(session_factory)
    state = State()
    bus = _bus(postgres_url, session_factory)
    signals = ConnectorAppSignals(
        apps=apps, organization_apps=None, broker=broker, state=state, bus=bus
    )
    return _Process(apps, broker, state, bus, signals)


async def _not(answer: Awaitable[bool]) -> bool:
    return not await answer


async def _eventually(check: Callable[[], Awaitable[bool]]) -> None:
    async with asyncio.timeout(DELIVERY_TIMEOUT):
        while not await check():
            await asyncio.sleep(0.02)


@pytest.fixture
async def two_processes(
    postgres_url: str, session_factory: async_sessionmaker[AsyncSession]
) -> AsyncIterator[tuple[_Process, _Process]]:
    processes = [await _process(postgres_url, session_factory) for _ in range(2)]
    for process in processes:
        await process.bus.start()
    for process in processes:
        await asyncio.wait_for(process.bus.connected.wait(), DELIVERY_TIMEOUT)
    yield processes[0], processes[1]
    for process in processes:
        await process.bus.stop()


class TestAcrossProcesses:
    async def test_a_client_saved_in_one_process_is_in_use_in_the_other(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        two_processes: tuple[_Process, _Process],
    ) -> None:
        here, there = two_processes
        assert await there.broker.connectable(GOOGLE) is False

        # As the save route does: commit, apply here, announce.
        await _save(
            session_factory,
            GOOGLE,
            client_id="saved-client-id",
            secrets={"client_secret": "example-secret-1111"},
        )
        await here.apps.apply(GOOGLE, broker=here.broker, state=here.state)
        here.apps.announce(GOOGLE)

        await _eventually(lambda: there.broker.connectable(GOOGLE))
        assert there.apps.effective(GOOGLE).values.client_id == "saved-client-id"  # type: ignore[union-attr]

    async def test_a_client_removed_in_one_process_goes_from_the_other(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        two_processes: tuple[_Process, _Process],
    ) -> None:
        here, there = two_processes
        await _save(
            session_factory,
            GOOGLE,
            client_id="saved-client-id",
            secrets={"client_secret": "example-secret-1111"},
        )
        for process in (here, there):
            await process.apps.apply(GOOGLE, broker=process.broker, state=process.state)
        assert await there.broker.connectable(GOOGLE) is True

        async with session_factory() as session:
            await here.apps.store.remove(session, GOOGLE)
            await session.commit()
        await here.apps.apply(GOOGLE, broker=here.broker, state=here.state)
        here.apps.announce(GOOGLE)

        await _eventually(lambda: _not(there.broker.connectable(GOOGLE)))


class TestRecheck:
    async def test_a_missed_signal_is_made_up_by_the_recheck(
        self,
        postgres_url: str,
        session_factory: async_sessionmaker[AsyncSession],
    ) -> None:
        process = await _process(postgres_url, session_factory)
        assert await process.apps.changed_since_resolved() == []

        # Saved by another process whose signal never arrived.
        await _save(
            session_factory,
            GOOGLE,
            client_id="saved-client-id",
            secrets={"client_secret": "example-secret-1111"},
        )
        assert await process.apps.changed_since_resolved() == [GOOGLE]

        await process.bus.start()
        try:
            await process.signals.recheck()
            await _eventually(lambda: process.broker.connectable(GOOGLE))
        finally:
            await process.bus.stop()
        assert await process.apps.changed_since_resolved() == []

    async def test_a_signal_for_a_service_this_build_has_no_app_for_is_ignored(
        self,
        postgres_url: str,
        session_factory: async_sessionmaker[AsyncSession],
    ) -> None:
        process = await _process(postgres_url, session_factory)

        process.signals._on_changed(
            {"kind": CONNECTOR_APP_CHANGED_SIGNAL, "service": "not-a-service"}
        )

        assert process.signals._owed.pending == 0
