"""A server-side connector runs in the one process that holds it.

Against real PostgreSQL, two "processes" on one database, each with its own
signal bus, process lease, ownership and connector lifecycle, wired as `main`
wires them. The connector's server here (`_Server`) records which copies of
the connector are connected to it, so a test can say the connector, and so
each of its agents' poll loops, runs in one process at a time.
"""

from __future__ import annotations

import asyncio
import uuid
from collections.abc import AsyncIterator, Callable
from dataclasses import dataclass
from types import SimpleNamespace
from typing import Any, ClassVar

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.pool import NullPool

from switch_core.bridges.agent.protocol.types import (
    CommandPayload,
    IntegrationProfile,
    MessagePayload,
)
from switch_core.bridges.agent.server_connectors.base import (
    ConnectorReporter,
    DiscoveredAgent,
    ServerSideConnector,
    ServerSideConnectorConfig,
)
from switch_core.bridges.agent.server_connectors.lifecycle import (
    ServerSideConnectorLifecycleService,
)
from switch_core.bridges.agent.server_connectors.signals import ConnectorSignals
from switch_core.db.models import ApiKey, ServerConnector, User
from switch_core.db.stores.api_key_store import ApiKeyStore
from switch_core.db.stores.ownership_lease_store import OwnershipLeaseStore
from switch_core.db.stores.server_connector_store import ServerConnectorStore
from switch_core.db.stores.switch_core_process_store import SwitchCoreProcessStore
from switch_core.keys import Keyring
from switch_core.outbound import OutboundPolicy
from switch_core.ownership import Ownership
from switch_core.process_lease import ProcessLease
from switch_core.signals import SignalBus
from tests.ownership import process_lease_on
from tests.switch_core.test_room_wide_mention_wakes_no_agent import _make_agent

TIMEOUT = 10.0
KIND = "fake-server"
KEYRING = Keyring.parse("test:" + "x" * 40, legacy_secret=None)


class _Server:
    """The agent server every copy of the connector talks to."""

    def __init__(self) -> None:
        self.connected: list[_Connector] = []


class _Config(ServerSideConnectorConfig):
    pass


class _Connector(ServerSideConnector):
    server: ClassVar[_Server]

    def __init__(self, *, config: _Config, outbound_policy: OutboundPolicy) -> None:
        self.config = config

    async def start(self) -> None:
        self.server.connected.append(self)

    async def stop(self) -> None:
        self.server.connected.remove(self)

    async def discover_agents(self) -> list[DiscoveredAgent]:
        return [
            DiscoveredAgent(
                name="helper",
                description="",
                integration_profile=IntegrationProfile(
                    connection_model="always_on",
                    message_exchange=True,
                    pre_invocation_mediation=[],
                    post_invocation_mediation=[],
                    event_reporting=[],
                ),
            )
        ]

    async def handle_message(
        self,
        agent_name: str,
        room_id: str,
        message: MessagePayload,
        reporter: ConnectorReporter,
    ) -> str | None:
        return None

    async def handle_command(
        self, agent_name: str, room_id: str, command: CommandPayload
    ) -> None:
        return None


class _Protocol:
    """`AgentCore` as far as a connector reaches it: its agents register,
    then long-poll for events that never come."""

    def __init__(self) -> None:
        self.deleted: list[str] = []

    async def register_agent_with_token(self, **_: Any) -> Any:
        return SimpleNamespace(agent_id=f"agent-{uuid.uuid4().hex[:8]}")

    async def poll_events(self, agent_id: str, timeout: int) -> list[Any]:
        await asyncio.sleep(3600)
        return []

    async def delete_agent(self, *, agent_id: str) -> None:
        self.deleted.append(agent_id)


@dataclass
class _Process:
    lease: ProcessLease
    ownership: Ownership
    bus: SignalBus
    connectors: ServerSideConnectorLifecycleService
    protocol: _Protocol
    lease_task: asyncio.Task[None]
    stopped: bool = False

    async def stop(self) -> None:
        """Shut down as `main` does: owned work first, then the rest."""
        if self.stopped:
            return
        self.stopped = True
        await self.ownership.stop()
        await self.lease.stop()
        await self.connectors.stop_all()
        self.lease_task.cancel()
        await asyncio.gather(self.lease_task, return_exceptions=True)
        await self.bus.stop()


async def _process(
    postgres_url: str, session_factory: async_sessionmaker[AsyncSession]
) -> _Process:
    lease = process_lease_on(session_factory)
    await lease.renew()
    bus = SignalBus(
        session_factory,
        lambda: create_async_engine(postgres_url, poolclass=NullPool),
        process_id=lease.process_id,
    )
    ownership = Ownership(
        lease=lease,
        session_factory=session_factory,
        bus=bus,
        store=OwnershipLeaseStore(),
        processes=SwitchCoreProcessStore(),
    )
    protocol = _Protocol()
    connectors = ServerSideConnectorLifecycleService(
        connector_store=ServerConnectorStore(),
        api_key_store=ApiKeyStore(),
        protocol=protocol,  # type: ignore[arg-type]
        session_factory=session_factory,
        keyring=KEYRING,
        outbound_policy=OutboundPolicy.parse(""),
        ownership=ownership,
    )
    connectors.register_connector_type(KIND, _Connector, _Config)
    ConnectorSignals(lifecycle=connectors, bus=bus)
    await bus.start()
    await asyncio.wait_for(bus.connected.wait(), TIMEOUT)
    return _Process(
        lease=lease,
        ownership=ownership,
        bus=bus,
        connectors=connectors,
        protocol=protocol,
        lease_task=asyncio.create_task(lease.run()),
    )


@pytest.fixture
def server() -> _Server:
    server = _Server()
    _Connector.server = server
    return server


@dataclass
class _Stored:
    connector_id: str
    user_id: str


@pytest.fixture
async def stored(session_factory: async_sessionmaker[AsyncSession]) -> _Stored:
    """A connector registered before the processes start, with its
    registration key, and one agent it registered before."""
    async with session_factory() as session:
        user = User(name="owner", email="owner@test", role="user", password_hash="x")
        session.add(user)
        await session.flush()
        key = ApiKey(
            user_id=user.id,
            key_hash=f"hash-{uuid.uuid4().hex}",
            encrypted_key=KEYRING.encrypt("registration-token"),
            label="server-connector:test",
            type="registration",
        )
        session.add(key)
        await session.flush()
        connector = ServerConnector(
            type=KIND,
            display_name="Fake",
            connection_config={},
            api_key_id=key.id,
            status="active",
        )
        session.add(connector)
        await session.flush()
        agent = await _make_agent(session, f"helper-{uuid.uuid4().hex[:6]}")
        agent.metadata_ = {"server_connector_id": connector.id}
        await session.commit()
        return _Stored(connector_id=connector.id, user_id=user.id)


@pytest.fixture
async def two(
    postgres_url: str,
    session_factory: async_sessionmaker[AsyncSession],
    server: _Server,
    stored: _Stored,
) -> AsyncIterator[tuple[_Process, _Process]]:
    """Two processes booted once the connector is stored, as after a deploy."""
    processes: list[_Process] = []
    try:
        for _ in range(2):
            process = await _process(postgres_url, session_factory)
            processes.append(process)
            # As `main` boots: the first balance, then the connectors wanted.
            await process.ownership.start()
            await process.connectors.start_all()
        # The first balance of each cannot see the other; balance once more
        # now that both leases are there, as the interval would.
        for process in processes:
            await process.ownership.balance()
        yield processes[0], processes[1]
    finally:
        for process in processes:
            await process.stop()


def _holder(
    two: tuple[_Process, _Process], connector_id: str
) -> tuple[_Process, _Process]:
    a, b = two
    holders = [p for p in (a, b) if p.connectors.holds(connector_id)]
    assert len(holders) == 1
    return (a, b) if holders[0] is a else (b, a)


async def _eventually(check: Callable[[], bool]) -> None:
    async with asyncio.timeout(TIMEOUT):
        while not check():
            await asyncio.sleep(0.02)


class TestOneProcessRunsIt:
    async def test_the_connector_runs_in_the_process_that_holds_it(
        self, two: tuple[_Process, _Process], server: _Server, stored: _Stored
    ) -> None:
        holder, other = _holder(two, stored.connector_id)

        # A connector taken over starts in a task of its own.
        await _eventually(lambda: holder.connectors.running_count() == 1)
        assert len(server.connected) == 1
        assert other.connectors.running_count() == 0
        assert other.connectors.expected_count() == 0

    async def test_every_process_names_its_agents(
        self, two: tuple[_Process, _Process], stored: _Stored
    ) -> None:
        for process in two:
            names = await process.connectors.get_agent_names(stored.connector_id)
            assert len(names) == 1 and names[0].startswith("helper-")

    async def test_when_its_process_stops_the_other_runs_it(
        self, two: tuple[_Process, _Process], server: _Server, stored: _Stored
    ) -> None:
        holder, other = _holder(two, stored.connector_id)

        await _eventually(lambda: holder.connectors.running_count() == 1)
        await holder.stop()
        await other.ownership.balance()

        assert other.connectors.holds(stored.connector_id)
        await _eventually(lambda: other.connectors.running_count() == 1)
        assert len(server.connected) == 1


class TestChangesMadeElsewhere:
    async def test_one_registered_through_either_process_runs_once(
        self, two: tuple[_Process, _Process], server: _Server, stored: _Stored
    ) -> None:
        a, _ = two

        added = await a.connectors.register(
            connector_type=KIND,
            display_name="Second",
            connection_config={},
            user_id=stored.user_id,
        )

        await _eventually(lambda: len(server.connected) == 2)
        holders = [p for p in two if p.connectors.holds(added.id)]
        assert len(holders) == 1
        await asyncio.sleep(0.3)
        assert len(server.connected) == 2

    async def test_one_removed_through_the_other_process_stops_and_takes_its_agents(
        self, two: tuple[_Process, _Process], server: _Server, stored: _Stored
    ) -> None:
        holder, other = _holder(two, stored.connector_id)
        await _eventually(lambda: len(server.connected) == 1)

        await other.connectors.remove(stored.connector_id)

        await _eventually(lambda: server.connected == [])
        assert not holder.connectors.holds(stored.connector_id)
        assert len(other.protocol.deleted) == 1


class TestASlowServer:
    async def test_it_holds_up_no_other_work_while_its_connector_starts(
        self,
        two: tuple[_Process, _Process],
        server: _Server,
        stored: _Stored,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """A connector's start dials its server. One that hangs is taken over
        and left starting in its own task: the next balance, and the
        hand-over of anything else, go on meanwhile."""
        holder, other = _holder(two, stored.connector_id)
        await _eventually(lambda: len(server.connected) == 1)
        release = asyncio.Event()

        async def hanging_start(self: _Connector) -> None:
            await release.wait()
            self.server.connected.append(self)

        monkeypatch.setattr(_Connector, "start", hanging_start)
        await holder.stop()
        async with asyncio.timeout(TIMEOUT):
            await other.ownership.balance()
            # Balancing again does not wait on the start either.
            await other.ownership.balance()
        assert other.connectors.holds(stored.connector_id)
        assert other.connectors.running_count() == 0

        release.set()
        await _eventually(lambda: other.connectors.running_count() == 1)
