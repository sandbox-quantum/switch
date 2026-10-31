"""A client registered or deleted after boot reaches every process.

Two "processes" on one database, each with its own lifecycle service, client
factory and signal bus: a registration or deletion announced by one has to
start or stop the other's copy, which only the signal and the re-read of the
tenant's rows can do.
"""

from __future__ import annotations

import asyncio
import uuid
from collections.abc import AsyncIterator, Callable
from typing import Any
from unittest.mock import MagicMock

import pytest
from sqlalchemy import delete
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.pool import NullPool

from switch_core.chats import MEMBER_CLIENT_TYPE
from switch_core.clients.client_lifecycle_service import ClientLifecycleService
from switch_core.clients.client_signals import CLIENT_CHANGED_SIGNAL, ClientSignals
from switch_core.db.models import TENANT_ZERO_ID, Agent, Client
from switch_core.db.stores.client_store import ClientStore
from switch_core.db.stores.tenant_store import TenantStore
from switch_core.signals import SignalBus
from tests.ownership import NeverOwned
from tests.switch_core.test_room_wide_mention_wakes_no_agent import _make_agent

DELIVERY_TIMEOUT = 10.0


class _Consumer:
    def __init__(self, display_name: str = "agent") -> None:
        self.display_name = display_name
        self.transport_user_id = "@agent:test"
        self.stopped = False

    async def set_display_name(self, display_name: str) -> None:
        self.display_name = display_name

    def preload_agent(self, agent: Agent) -> None:
        return None

    async def connect(self) -> None:
        return None

    async def close(self) -> None:
        self.stopped = True


class _Factory:
    """Each client reads for itself, in every process."""

    def create_actor(self, record: Any) -> _Consumer:
        return _Consumer(record.display_name)

    def create_consumer(self, client_type: str, actor: _Consumer) -> _Consumer:
        return actor

    def has_consumer(self, client_type: str) -> bool:
        return False


def _lifecycle(
    session_factory: async_sessionmaker[AsyncSession],
) -> ClientLifecycleService:
    return ClientLifecycleService(
        provisioning=MagicMock(),
        client_store=ClientStore(),
        tenant_store=TenantStore(),
        client_factory=_Factory(),  # type: ignore[arg-type]
        session_factory=session_factory,
        config=MagicMock(),
        tenants_isolated=True,
        ownership=NeverOwned(),  # type: ignore[arg-type]
        cursor_writer=MagicMock(),
    )


def _bus(
    postgres_url: str, session_factory: async_sessionmaker[AsyncSession]
) -> SignalBus:
    return SignalBus(
        session_factory,
        lambda: create_async_engine(postgres_url, poolclass=NullPool),
        process_id=str(uuid.uuid4()),
    )


async def _eventually(check: Callable[[], bool]) -> None:
    async with asyncio.timeout(DELIVERY_TIMEOUT):
        while not check():
            await asyncio.sleep(0.02)


async def _register(session_factory: async_sessionmaker[AsyncSession]) -> Agent:
    async with session_factory() as session:
        agent = await _make_agent(session, f"late-{uuid.uuid4().hex[:8]}")
        await session.commit()
    return agent


async def _delete(
    session_factory: async_sessionmaker[AsyncSession], agent: Agent
) -> None:
    async with session_factory() as session:
        await session.execute(delete(Agent).where(Agent.id == agent.id))
        await session.execute(delete(Client).where(Client.id == agent.client_id))
        await session.commit()


@pytest.fixture
async def two_processes(
    postgres_url: str, session_factory: async_sessionmaker[AsyncSession]
) -> AsyncIterator[tuple[ClientLifecycleService, ClientLifecycleService]]:
    lifecycles = [_lifecycle(session_factory) for _ in range(2)]
    buses = [_bus(postgres_url, session_factory) for _ in range(2)]
    for lifecycle, bus in zip(lifecycles, buses, strict=True):
        ClientSignals(lifecycle=lifecycle, bus=bus)
        await lifecycle.start_all()
        await bus.start()
    for bus in buses:
        await asyncio.wait_for(bus.connected.wait(), DELIVERY_TIMEOUT)
    yield lifecycles[0], lifecycles[1]
    for lifecycle, bus in zip(lifecycles, buses, strict=True):
        await bus.stop()
        await lifecycle.stop_all()


class TestAcrossProcesses:
    async def test_a_client_registered_in_one_process_starts_in_the_other(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        two_processes: tuple[ClientLifecycleService, ClientLifecycleService],
    ) -> None:
        here, there = two_processes
        agent = await _register(session_factory)
        assert agent.client_id is not None

        here.announce(TENANT_ZERO_ID, [agent.client_id])

        await _eventually(lambda: there.get(agent.client_id) is not None)  # type: ignore[arg-type]
        # The announcing process re-reads too, and starts what it lacks.
        await _eventually(lambda: here.get(agent.client_id) is not None)  # type: ignore[arg-type]

    async def test_an_agent_renamed_in_one_process_is_renamed_in_the_other(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        two_processes: tuple[ClientLifecycleService, ClientLifecycleService],
    ) -> None:
        """Bridges recognise an agent's own messages by the name its copy
        sends under, and a bridge held there keeps per-agent identities, so
        both have to follow a rename served here."""
        here, there = two_processes
        agent = await _register(session_factory)
        client_id = agent.client_id
        assert client_id is not None
        here.announce(TENANT_ZERO_ID, [client_id])
        await _eventually(lambda: there.get(client_id) is not None)
        told: list[tuple[str, frozenset[str] | None]] = []
        there.add_agents_changed_listener(
            lambda tenant_id, client_ids: told.append((tenant_id, client_ids))
        )

        # As `AgentCore.rename_agent` does: rename the client row, announce.
        async with session_factory() as session:
            client = await session.get(Client, client_id)
            assert client is not None
            client.display_name = "renamed-agent"
            await session.commit()
        here.announce(TENANT_ZERO_ID, [client_id])

        await _eventually(
            lambda: (
                getattr(there.get(client_id), "display_name", None) == "renamed-agent"
            )
        )
        await _eventually(lambda: (TENANT_ZERO_ID, frozenset({client_id})) in told)

    async def test_a_client_deleted_in_one_process_stops_in_the_other(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        two_processes: tuple[ClientLifecycleService, ClientLifecycleService],
    ) -> None:
        here, there = two_processes
        agent = await _register(session_factory)
        client_id = agent.client_id
        assert client_id is not None
        here.announce(TENANT_ZERO_ID, [client_id])
        await _eventually(lambda: there.get(client_id) is not None)
        copy = there.get(client_id)

        # As `AgentCore.delete_agent` does: stop here, delete, announce.
        await here.stop(client_id)
        await _delete(session_factory, agent)
        here.announce(TENANT_ZERO_ID, [client_id])

        await _eventually(lambda: there.get(client_id) is None)
        assert isinstance(copy, _Consumer) and copy.stopped

    async def test_a_change_reads_only_the_clients_it_names(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        two_processes: tuple[ClientLifecycleService, ClientLifecycleService],
    ) -> None:
        """With thousands of agents, a change that made every process read
        every client of the tenant kept every process busy for as long as
        agents were being created."""
        here, there = two_processes
        # The read every process makes once its signal connection is up.
        await _eventually(lambda: TENANT_ZERO_ID in there._fingerprints)
        full_reads = _count_full_reads(there)
        agent = await _register(session_factory)
        client_id = agent.client_id
        assert client_id is not None
        told: list[tuple[str, frozenset[str] | None]] = []
        there.add_agents_changed_listener(
            lambda tenant_id, client_ids: told.append((tenant_id, client_ids))
        )

        here.announce(TENANT_ZERO_ID, [client_id])

        await _eventually(lambda: there.get(client_id) is not None)
        await _eventually(lambda: (TENANT_ZERO_ID, frozenset({client_id})) in told)
        assert full_reads == []

    async def test_a_signal_naming_no_clients_reads_the_whole_tenant(
        self,
        postgres_url: str,
        session_factory: async_sessionmaker[AsyncSession],
        two_processes: tuple[ClientLifecycleService, ClientLifecycleService],
    ) -> None:
        """What a process from before signals named their clients sends,
        during a rolling deploy."""
        _here, there = two_processes
        agent = await _register(session_factory)
        older = _bus(postgres_url, session_factory)
        await older.start()
        try:
            older.publish(CLIENT_CHANGED_SIGNAL, tenant_id=TENANT_ZERO_ID)

            await _eventually(lambda: there.get(agent.client_id) is not None)  # type: ignore[arg-type]
        finally:
            await older.stop()


class TestReconcile:
    async def test_the_recheck_starts_a_client_whose_signal_was_missed(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        lifecycle = _lifecycle(session_factory)
        await lifecycle.start_all()
        agent = await _register(session_factory)

        await lifecycle.reconcile_all()

        assert lifecycle.get(agent.client_id) is not None  # type: ignore[arg-type]
        await lifecycle.stop_all()

    async def test_an_agent_client_waits_for_its_agent_row(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """Registration commits the client row before the agent row, and an
        agent actor started between the two would find no agent."""
        lifecycle = _lifecycle(session_factory)
        async with session_factory() as session:
            client = Client(
                transport_user_id="@half-registered:test",
                display_name="half",
                type="agent",
            )
            session.add(client)
            await session.commit()
            client_id = client.id

        await lifecycle.reconcile_tenant(TENANT_ZERO_ID)

        assert lifecycle.get(client_id) is None

    async def test_a_console_member_client_is_not_started(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """A Console member's client has no actor: the chats routes write its
        messages. The re-check started one, and the real factory refuses the
        type, which failed every resync."""
        lifecycle = _lifecycle(session_factory)
        async with session_factory() as session:
            client = Client(
                transport_user_id="@console-member:test",
                display_name="member",
                type=MEMBER_CLIENT_TYPE,
            )
            session.add(client)
            await session.commit()
            client_id = client.id

        await lifecycle.reconcile_tenant(TENANT_ZERO_ID)

        assert lifecycle.get(client_id) is None

    async def test_a_client_stopped_on_purpose_stays_stopped(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """An agent being deleted stops its client before its rows go. A
        re-check in between must not start it again."""
        agent = await _register(session_factory)
        assert agent.client_id is not None
        lifecycle = _lifecycle(session_factory)
        await lifecycle.start_all()
        await lifecycle.stop(agent.client_id)

        await lifecycle.reconcile_tenant(TENANT_ZERO_ID)

        assert lifecycle.get(agent.client_id) is None

    async def test_a_client_registered_during_a_recheck_keeps_running(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """A registration in this process can commit and start its client
        while a re-check awaits its read. The re-check's rows predate that
        client, which must not make it look deleted."""
        lifecycle = _lifecycle(session_factory)
        await lifecycle.start_all()
        store = lifecycle._client_store
        real_get_running = store.get_running
        registered: list[str] = []

        async def read_then_register(session: Any, *args: Any) -> Any:
            records = await real_get_running(session, *args)
            if not registered:
                # As `AgentCore._create_agent` does: commit, then start.
                agent = await _register(session_factory)
                async with session_factory() as other:
                    record = await other.get(Client, agent.client_id)
                assert record is not None
                lifecycle.start_client(record)
                registered.append(record.id)
            return records

        store.get_running = read_then_register  # type: ignore[method-assign]
        try:
            await lifecycle.reconcile_tenant(TENANT_ZERO_ID)
        finally:
            store.get_running = real_get_running  # type: ignore[method-assign]

        assert lifecycle.get(registered[0]) is not None
        await lifecycle.stop_all()

    async def test_a_named_client_stopped_on_purpose_stays_stopped(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """As above, for a re-read of the named clients only."""
        agent = await _register(session_factory)
        assert agent.client_id is not None
        lifecycle = _lifecycle(session_factory)
        await lifecycle.start_all()
        await lifecycle.stop(agent.client_id)

        await lifecycle.reconcile_clients(TENANT_ZERO_ID, [agent.client_id])

        assert lifecycle.get(agent.client_id) is None


class TestRecheck:
    """The periodic re-check, which every process runs every 30 seconds:
    a read of every client of every tenant, until it compared fingerprints
    first."""

    async def test_with_nothing_changed_it_reads_no_client(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        lifecycle = _lifecycle(session_factory)
        await lifecycle.start_all()
        await lifecycle.reconcile_all()
        full_reads = _count_full_reads(lifecycle)

        await lifecycle.recheck_all()

        assert full_reads == []
        await lifecycle.stop_all()

    async def test_it_starts_a_client_whose_signal_was_missed(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        lifecycle = _lifecycle(session_factory)
        await lifecycle.start_all()
        await lifecycle.reconcile_all()
        agent = await _register(session_factory)

        await lifecycle.recheck_all()

        assert lifecycle.get(agent.client_id) is not None  # type: ignore[arg-type]
        await lifecycle.stop_all()

    async def test_an_agent_edited_with_no_signal_is_read_again_by_the_bridges(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """An agent's description edited in another process sends no signal,
        and a bridge here keeps the description with the agent's platform
        handle."""
        agent = await _register(session_factory)
        lifecycle = _lifecycle(session_factory)
        await lifecycle.start_all()
        await lifecycle.reconcile_all()
        told: list[tuple[str, frozenset[str] | None]] = []
        lifecycle.add_agents_changed_listener(
            lambda tenant_id, client_ids: told.append((tenant_id, client_ids))
        )
        async with session_factory() as session:
            row = await session.get(Agent, agent.id)
            assert row is not None
            row.description = "does something else now"
            await session.commit()

        await lifecycle.recheck_all()

        assert told == [(TENANT_ZERO_ID, None)]
        await lifecycle.stop_all()


def _count_full_reads(lifecycle: ClientLifecycleService) -> list[str]:
    """The tenants `lifecycle` reads every client of from now on."""
    reads: list[str] = []
    store = lifecycle._client_store
    real_get_running = store.get_running

    async def counted(session: Any, tenant_id: str, *args: Any) -> Any:
        reads.append(tenant_id)
        return await real_get_running(session, tenant_id, *args)

    store.get_running = counted  # type: ignore[method-assign]
    return reads
