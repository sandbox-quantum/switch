"""Presence for agents run by an agents controller.

A controller-backed agent holds no connection of its own: it is live while its
controller's stream is attached and beating, starts sessions where its
definition says so and it is a member, and every presence reader asks the
controller rather than the connection registry or the heartbeat rows.
"""

from __future__ import annotations

import time
import uuid
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from typing import Any

import pytest_asyncio
from sqlalchemy import insert, update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.bridges.agent.protocol.agent_connections import AgentConnectionRegistry
from switch_core.bridges.agent.protocol.agent_core import AgentCore
from switch_core.bridges.agent.protocol.controller_presence import (
    Binding,
    ControllerTakenOverError,
    StaleGenerationError,
    UnknownControllerConnectionError,
)
from switch_core.bridges.agent.protocol.liveness import HEARTBEAT_TTL_SECONDS
from switch_core.bridges.agent.protocol.presence import (
    agents_present_in,
    rooms_occupied,
)
from switch_core.bridges.agent.protocol.statuses import compute_agent_statuses
from switch_core.bridges.agent.protocol.types import AgentStatus
from switch_core.clients.agent_consumer import _STARTING_SESSION_MESSAGE, AgentConsumer
from switch_core.db.models import (
    TENANT_ZERO_ID,
    Agent,
    ApiKey,
    Client,
    RoleLease,
    Room,
    User,
    room_agents,
)
from switch_core.db.stores.agent_store import AgentStore
from switch_core.db.stores.room_role_store import RoomRoleStore
from switch_core.db.stores.room_store import RoomStore

CONTROLLER = "controller-1"
ROOM = "room-1"
ELSEWHERE = "room-2"


class _NoRows:
    """The heartbeat-row arm. Records every question, answers that nothing is live."""

    def __init__(self) -> None:
        self.asked: list[list[str]] = []

    async def get_live_agent_ids(
        self, _session: Any, agent_ids: list[str], _room_id: str | None
    ) -> set[str]:
        self.asked.append(list(agent_ids))
        return set()


def _bind(
    registry: AgentConnectionRegistry,
    agent_id: str,
    *,
    running: bool = True,
) -> Binding:
    binding = Binding(
        agent_id=agent_id,
        controller_id=CONTROLLER,
        tenant_id=TENANT_ZERO_ID,
        controller_name="machine",
        running=running,
    )
    registry.controllers.bind(binding)
    return binding


def _go_live(
    registry: AgentConnectionRegistry, *agent_rooms: tuple[str, set[str]]
) -> Any:
    presence = registry.controllers
    conn = presence.open(
        controller_id=CONTROLLER,
        tenant_id=TENANT_ZERO_ID,
        resume_cursors={},
        placements={},
    )
    presence.attach_stream(conn)
    for agent_id, rooms in agent_rooms:
        presence.set_rooms(agent_id, rooms)
    return conn


def _lapse(conn: Any) -> None:
    conn.last_beat = time.monotonic() - HEARTBEAT_TTL_SECONDS - 1


def _agent(agent_id: str, connection_model: str) -> SimpleNamespace:
    return SimpleNamespace(
        id=agent_id, integration_profile={"connection_model": connection_model}
    )


@pytest_asyncio.fixture
async def db(
    session_factory: async_sessionmaker[AsyncSession],
) -> AsyncIterator[AsyncSession]:
    async with session_factory() as session:
        yield session


class TestStatuses:
    async def test_each_connection_model_reads_its_controller(
        self, db: AsyncSession
    ) -> None:
        registry = AgentConnectionRegistry()
        _bind(registry, "always")
        _bind(registry, "auto")
        _bind(registry, "addressable")
        _bind(registry, "passive")
        rows = _NoRows()
        agents = [
            _agent("always", "always_on"),
            _agent("auto", "auto_session"),
            _agent("addressable", "session_addressable"),
            _agent("passive", "session_passive"),
        ]

        offline = await compute_agent_statuses(db, agents, ROOM, rows, registry)  # type: ignore[arg-type]
        conn = _go_live(
            registry,
            *((agent.id, {ROOM}) for agent in agents),
        )
        online = await compute_agent_statuses(db, agents, ROOM, rows, registry)  # type: ignore[arg-type]
        elsewhere = await compute_agent_statuses(db, agents, ELSEWHERE, rows, registry)  # type: ignore[arg-type]
        _lapse(conn)
        lapsed = await compute_agent_statuses(db, agents, ROOM, rows, registry)  # type: ignore[arg-type]

        assert offline == {
            "always": AgentStatus.DISCONNECTED,
            "auto": AgentStatus.DISCONNECTED,
            "addressable": AgentStatus.NO_SESSION,
            "passive": AgentStatus.AWAITING_MANUAL_POLL,
        }
        assert online == {
            "always": AgentStatus.LIVE,
            "auto": AgentStatus.DORMANT,
            "addressable": AgentStatus.DORMANT,
            "passive": AgentStatus.AWAITING_MANUAL_POLL,
        }
        # Not a member there, so nothing will start a session for it.
        assert elsewhere["auto"] == AgentStatus.NO_SESSION
        assert elsewhere["always"] == AgentStatus.LIVE
        assert lapsed == offline
        # The heartbeat rows were never asked about a controller-backed agent.
        assert all(asked == [] for asked in rows.asked)

    async def test_a_stream_detached_is_not_live_even_while_beating(
        self, db: AsyncSession
    ) -> None:
        registry = AgentConnectionRegistry()
        _bind(registry, "auto")
        conn = _go_live(registry, ("auto", {ROOM}))
        registry.controllers.detach_stream(conn, conn.stream_token)

        statuses = await compute_agent_statuses(
            db,
            [_agent("auto", "auto_session")],  # type: ignore[list-item]
            ROOM,
            _NoRows(),  # type: ignore[arg-type]
            registry,
        )
        assert statuses == {"auto": AgentStatus.DISCONNECTED}


class TestTheRegistryAsksTheController:
    def test_presence_questions(self) -> None:
        registry = AgentConnectionRegistry()
        binding = _bind(registry, "agent")
        holder = registry.controllers.holder_id(binding)

        assert not registry.is_live("agent")
        assert not registry.relay_session_command(
            "agent", {"origin": {}}, worker_only=False
        )
        assert holder not in registry.live_connection_ids()

        conn = _go_live(registry, ("agent", {ROOM}))

        assert registry.is_live("agent")
        assert registry.can_spawn_for("agent", ROOM)
        assert not registry.can_spawn_for("agent", ELSEWHERE)
        assert registry.live_in_room("agent", ROOM)
        assert registry.live_agent_ids() == {"agent"}
        assert holder in registry.live_connection_ids()
        assert registry.live_connection_count() == 1
        # In no room until its controller places a session there.
        assert rooms_occupied("agent", registry) == set()
        registry.controllers.replace_placements(conn, {"agent": [ROOM]})
        assert rooms_occupied("agent", registry) == {ROOM}
        assert registry.relay_session_command(
            "agent", {"origin": {"roomId": ROOM}}, worker_only=False
        )
        assert conn.session_commands == [("agent", {"origin": {"roomId": ROOM}})]

        _lapse(conn)
        assert not registry.is_live("agent")
        assert registry.live_agent_ids() == set()
        assert holder not in registry.live_connection_ids()
        assert rooms_occupied("agent", registry) == set()

    def test_a_move_renames_the_holder_and_owes_the_old_controller_a_detach(
        self,
    ) -> None:
        registry = AgentConnectionRegistry()
        before = _bind(registry, "agent")
        conn = _go_live(registry, ("agent", {ROOM}))
        moved = Binding(
            agent_id="agent",
            controller_id="controller-2",
            tenant_id=TENANT_ZERO_ID,
            controller_name="machine",
            running=True,
        )
        registry.controllers.bind(moved)

        assert registry.controllers.holder_id(before) != registry.controllers.holder_id(
            moved
        )
        assert conn.detached == {"agent": "unassigned"}
        assert not registry.is_live("agent")

    def test_reopening_fences_the_old_connection(self) -> None:
        registry = AgentConnectionRegistry()
        presence = registry.controllers
        old = presence.open(
            controller_id=CONTROLLER,
            tenant_id=TENANT_ZERO_ID,
            resume_cursors={},
            placements={},
        )
        new = presence.open(
            controller_id=CONTROLLER,
            tenant_id=TENANT_ZERO_ID,
            resume_cursors={},
            placements={},
        )

        assert old.closure is not None and old.closure.code == "taken_over"
        for connection_id, generation, error in (
            (old.id, old.generation, ControllerTakenOverError),
            (new.id, new.generation + 1, StaleGenerationError),
            ("never", 1, UnknownControllerConnectionError),
        ):
            try:
                presence.require(CONTROLLER, connection_id, generation)
            except error:
                continue
            raise AssertionError(f"{connection_id} was not refused with {error}")

    def test_an_unbound_agent_is_the_registrys_as_before(self) -> None:
        registry = AgentConnectionRegistry()
        assert not registry.controllers.is_bound("direct")
        assert not registry.is_live("direct")
        assert registry.live_connection_count() == 0


class TestRoleLeases:
    async def test_a_seat_held_by_a_controller_backed_agent_lives_with_it(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        registry = AgentConnectionRegistry()
        store = RoomRoleStore()
        async with session_factory() as session:
            owner = User(name="lease-owner", email="lease@example.invalid", role="user")
            session.add(owner)
            await session.flush()
            client = Client(
                type="agent", transport_user_id="@lease:test", display_name="lease"
            )
            key = ApiKey(
                type="agent",
                key_hash=uuid.uuid4().hex,
                user_id=owner.id,
                encrypted_key="",
                label="k",
            )
            session.add_all([client, key])
            await session.flush()
            agent = Agent(
                name="lease",
                description="d",
                agent_type="auto_session",
                connector_type="claude_code",
                integration_profile={"connection_model": "auto_session"},
                client_id=client.id,
                api_key_id=key.id,
            )
            room = Room(transport_room_id="!lease:test", name="r", description="d")
            session.add_all([agent, room])
            await session.flush()
            await session.execute(
                insert(room_agents).values(room_id=room.id, agent_id=agent.id)
            )
            role = await store.define_role(
                session, room.id, "reviewer", "review things", exclusive=True
            )
            binding = _bind(registry, agent.id)
            holder = registry.controllers.holder_id(binding)
            conn = _go_live(registry, (agent.id, {room.id}))
            await store.acquire_lease(
                session, role, agent.id, holder, holder, registry.live_connection_ids()
            )
            # Its own renewals have stopped: only its controller keeps it now.
            await session.execute(
                update(RoleLease)
                .where(RoleLease.agent_id == agent.id)
                .values(last_seen_at=datetime.now(UTC) - timedelta(hours=1))
            )
            await session.commit()

            held = await store.get_live_lease(
                session, role.id, registry.live_connection_ids()
            )
            _lapse(conn)
            freed = await store.get_live_lease(
                session, role.id, registry.live_connection_ids()
            )

        assert held is not None and held.agent_id == agent.id
        assert freed is None


@asynccontextmanager
async def _no_session() -> AsyncIterator[object]:
    yield object()


def _client(registry: AgentConnectionRegistry, agent_id: str) -> SimpleNamespace:
    async def _unavailable_reply(*_args: Any, **_kwargs: Any) -> str:
        return "offline"

    async def owner_handle_in(*_args: Any) -> str | None:
        return "owner"

    ns = SimpleNamespace(
        agent=SimpleNamespace(id=agent_id),
        _connections=registry,
        _agent_session_store=_NoRows(),
        _unavailable_reply=_unavailable_reply,
        owner_handle_in=owner_handle_in,
    )
    ns._is_available = AgentConsumer._is_available.__get__(ns)
    ns._reply_when_unavailable_here = (
        AgentConsumer._reply_when_unavailable_here.__get__(ns)
    )
    ns._controller_unavailable_reply = (
        AgentConsumer._controller_unavailable_reply.__get__(ns)
    )
    return ns


class TestTheAgentClientsReplies:
    async def test_starting_a_session_is_promised_only_where_it_will_be(
        self,
    ) -> None:
        registry = AgentConnectionRegistry()
        _bind(registry, "auto")
        conn = _go_live(registry, ("auto", {ROOM}))
        meta = SimpleNamespace(room_id=ROOM, name="Room", bridge_id=None)
        auto = _client(registry, "auto")
        agent = _agent("auto", "auto_session")

        available = await auto._is_available(object(), agent, ROOM)
        promised = await auto._reply_when_unavailable_here(object(), agent, meta, "@u")
        _lapse(conn)
        lapsed = await auto._reply_when_unavailable_here(object(), agent, meta, "@u")

        assert available is False
        assert promised == _STARTING_SESSION_MESSAGE
        assert lapsed.startswith(
            "My machine, **machine**, is offline or reconnecting to Switch"
        )
        assert "Switch Console" not in lapsed
        assert auto._agent_session_store.asked == []

    async def test_a_stopped_agent_is_not_promised_a_session(
        self, db: AsyncSession
    ) -> None:
        registry = AgentConnectionRegistry()
        _bind(registry, "auto", running=False)
        _bind(registry, "always", running=False)
        conn = _go_live(registry, ("auto", {ROOM}), ("always", {ROOM}))
        registry.controllers.replace_placements(conn, {"auto": [ROOM]})
        meta = SimpleNamespace(room_id=ROOM, name="Room", bridge_id=None)
        client = _client(registry, "auto")
        agent = _agent("auto", "auto_session")

        available = await client._is_available(object(), agent, ROOM)
        reply = await client._reply_when_unavailable_here(object(), agent, meta, "u")
        statuses = await compute_agent_statuses(
            db,
            [agent, _agent("always", "always_on")],  # type: ignore[list-item]
            ROOM,
            _NoRows(),  # type: ignore[arg-type]
            registry,
        )

        assert available is False
        assert reply != _STARTING_SESSION_MESSAGE
        assert reply.startswith("@owner — you've stopped me")
        assert "and @u needs me" in reply
        assert statuses == {
            "auto": AgentStatus.DISCONNECTED,
            "always": AgentStatus.DISCONNECTED,
        }
        assert not registry.can_spawn_for("auto", ROOM)
        assert not registry.is_live("auto")
        assert registry.controllers.placed_rooms("auto") == set()
        assert not registry.relay_session_command(
            "auto", {"origin": {"roomId": ROOM}}, worker_only=False
        )

        registry.controllers.bind(
            Binding(
                agent_id="auto",
                controller_id=CONTROLLER,
                tenant_id=TENANT_ZERO_ID,
                controller_name="machine",
                running=True,
            )
        )
        assert registry.can_spawn_for("auto", ROOM)
        assert (
            await client._reply_when_unavailable_here(object(), agent, meta, "u")
            == _STARTING_SESSION_MESSAGE
        )

    async def test_an_offline_or_removed_machine_is_named_not_console(
        self,
    ) -> None:
        registry = AgentConnectionRegistry()
        _bind(registry, "auto")
        meta = SimpleNamespace(room_id=ROOM, name="Room", bridge_id=None)
        client = _client(registry, "auto")
        agent = _agent("auto", "auto_session")

        never_connected = await client._reply_when_unavailable_here(
            object(), agent, meta, "u"
        )
        registry.controllers.revoke_controller(CONTROLLER)
        removed = await client._reply_when_unavailable_here(object(), agent, meta, "u")

        assert never_connected == (
            "My machine, **machine**, is offline or reconnecting to Switch, so "
            "I can't answer right now. If I haven't answered once it's back, "
            "address me again. If it stays offline, my owner (@owner) needs to "
            "check it."
        )
        assert removed.startswith(
            "@owner — my machine, **machine**, has been removed from Switch"
        )
        assert "move me to another machine" in removed

    async def test_an_always_on_agent_is_available_while_its_controller_is(
        self,
    ) -> None:
        registry = AgentConnectionRegistry()
        _bind(registry, "always")
        client = _client(registry, "always")
        agent = _agent("always", "always_on")

        assert not await client._is_available(object(), agent, ROOM)
        conn = _go_live(registry, ("always", {ROOM}))
        assert await client._is_available(object(), agent, ROOM)
        _lapse(conn)
        assert not await client._is_available(object(), agent, ROOM)


class TestPlacements:
    """Where the controller says its sessions work: the agent is LIVE there."""

    def test_the_map_is_replaced_whole_and_kept_to_bound_member_rooms(
        self,
    ) -> None:
        registry = AgentConnectionRegistry()
        presence = registry.controllers
        _bind(registry, "agent")
        _bind(registry, "other")
        conn = _go_live(registry, ("agent", {ROOM, ELSEWHERE}), ("other", {ROOM}))

        presence.replace_placements(
            conn,
            {"agent": [ROOM, "not-a-member"], "other": [ROOM], "stranger": [ROOM]},
        )
        first = (presence.placed_rooms("agent"), presence.placed_rooms("other"))
        presence.replace_placements(conn, {"agent": [ELSEWHERE]})
        second = (presence.placed_rooms("agent"), presence.placed_rooms("other"))

        assert first == ({ROOM}, {ROOM})
        assert "stranger" not in conn.placements
        assert second == ({ELSEWHERE}, set())

    def test_a_room_left_drops_out_and_an_unbound_agent_is_forgotten(self) -> None:
        registry = AgentConnectionRegistry()
        presence = registry.controllers
        _bind(registry, "agent")
        conn = _go_live(registry, ("agent", {ROOM, ELSEWHERE}))
        presence.replace_placements(conn, {"agent": [ROOM, ELSEWHERE]})

        presence.room_left("agent", ELSEWHERE)
        assert presence.placed_rooms("agent") == {ROOM}
        presence.unbind("agent", "unassigned")
        assert presence.placed_rooms("agent") == set()
        assert "agent" not in conn.placements

    def test_lapse_and_detach_clear_it(self) -> None:
        registry = AgentConnectionRegistry()
        presence = registry.controllers
        _bind(registry, "agent")
        conn = _go_live(registry, ("agent", {ROOM}))
        presence.replace_placements(conn, {"agent": [ROOM]})

        _lapse(conn)
        assert presence.placed_rooms("agent") == set()
        assert rooms_occupied("agent", registry) == set()

        conn = _go_live(registry, ("agent", {ROOM}))
        presence.replace_placements(conn, {"agent": [ROOM]})
        assert presence.placed_rooms("agent") == {ROOM}
        presence.detach_stream(conn, conn.stream_token)
        assert conn.placements == {}
        presence.attach_stream(conn)
        assert presence.placed_rooms("agent") == set()

        presence.replace_placements(conn, {"agent": [ROOM]})
        _lapse(conn)
        assert presence.sweep() == [conn]
        assert conn.placements == {}

    def test_an_initial_map_on_open_is_kept(self) -> None:
        registry = AgentConnectionRegistry()
        presence = registry.controllers
        _bind(registry, "agent")
        conn = presence.open(
            controller_id=CONTROLLER,
            tenant_id=TENANT_ZERO_ID,
            resume_cursors={},
            placements={"agent": [ROOM]},
        )
        presence.attach_stream(conn)
        presence.set_rooms("agent", {ROOM})
        assert presence.placed_rooms("agent") == {ROOM}

    async def test_placed_is_live_present_and_occupied(self, db: AsyncSession) -> None:
        registry = AgentConnectionRegistry()
        _bind(registry, "auto")
        _bind(registry, "addressable")
        conn = _go_live(
            registry, ("auto", {ROOM, ELSEWHERE}), ("addressable", {ROOM, ELSEWHERE})
        )
        registry.controllers.replace_placements(
            conn, {"auto": [ROOM], "addressable": [ROOM]}
        )
        agents = [
            _agent("auto", "auto_session"),
            _agent("addressable", "session_addressable"),
        ]

        here = await compute_agent_statuses(db, agents, ROOM, _NoRows(), registry)  # type: ignore[arg-type]
        there = await compute_agent_statuses(db, agents, ELSEWHERE, _NoRows(), registry)  # type: ignore[arg-type]

        assert here == {"auto": AgentStatus.LIVE, "addressable": AgentStatus.LIVE}
        assert there == {
            "auto": AgentStatus.DORMANT,
            "addressable": AgentStatus.DORMANT,
        }
        assert agents_present_in(["auto", "addressable"], ROOM, registry) == {
            "auto",
            "addressable",
        }
        assert agents_present_in(["auto"], ELSEWHERE, registry) == set()
        assert rooms_occupied("auto", registry) == {ROOM}

    async def test_no_starting_promise_where_a_session_already_works(self) -> None:
        registry = AgentConnectionRegistry()
        _bind(registry, "auto")
        conn = _go_live(registry, ("auto", {ROOM, ELSEWHERE}))
        registry.controllers.replace_placements(conn, {"auto": [ROOM]})
        client = _client(registry, "auto")
        agent = _agent("auto", "auto_session")

        placed_here = await client._is_available(object(), agent, ROOM)
        placed_elsewhere = await client._is_available(object(), agent, ELSEWHERE)
        promise_elsewhere = await client._reply_when_unavailable_here(
            object(),
            agent,
            SimpleNamespace(room_id=ELSEWHERE, name="Other", bridge_id=None),
            "@u",
        )

        # Available here, so on_message posts no reply at all.
        assert placed_here is True
        assert placed_elsewhere is False
        assert promise_elsewhere == _STARTING_SESSION_MESSAGE

    async def test_a_role_holder_is_located_by_its_placement(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        registry = AgentConnectionRegistry()
        store = RoomRoleStore()
        async with session_factory() as session:
            owner = User(name="holder", email="holder@example.invalid", role="user")
            session.add(owner)
            await session.flush()
            client = Client(
                type="agent", transport_user_id="@holder:test", display_name="holder"
            )
            key = ApiKey(
                type="agent",
                key_hash=uuid.uuid4().hex,
                user_id=owner.id,
                encrypted_key="",
                label="k",
            )
            session.add_all([client, key])
            await session.flush()
            agent = Agent(
                name="holder",
                description="d",
                agent_type="auto_session",
                connector_type="claude_code",
                integration_profile={"connection_model": "auto_session"},
                client_id=client.id,
                api_key_id=key.id,
            )
            here = Room(transport_room_id="!here:test", name="here", description="d")
            there = Room(transport_room_id="!there:test", name="there", description="d")
            session.add_all([agent, here, there])
            await session.flush()
            for room in (here, there):
                await session.execute(
                    insert(room_agents).values(room_id=room.id, agent_id=agent.id)
                )
            role = await store.define_role(
                session, here.id, "reviewer", "review", exclusive=True
            )
            binding = _bind(registry, agent.id)
            holder = registry.controllers.holder_id(binding)
            conn = _go_live(registry, (agent.id, {here.id, there.id}))
            await store.acquire_lease(
                session, role, agent.id, holder, holder, registry.live_connection_ids()
            )
            await session.commit()

            protocol = object.__new__(AgentCore)
            protocol.connections = registry
            protocol.room_role_store = store
            protocol.agent_store = AgentStore()
            protocol.room_store = RoomStore()

            async def holders() -> list[dict[str, Any]]:
                [entry] = await protocol._build_role_entries(
                    session, here.id, agent.id, [role], truncate=True
                )
                return list(entry["held_by"])

            registry.controllers.replace_placements(conn, {agent.id: [here.id]})
            placed_here = await holders()
            registry.controllers.replace_placements(conn, {agent.id: [there.id]})
            placed_there = await holders()
            registry.controllers.replace_placements(conn, {})
            placed_nowhere = await holders()

        assert placed_here == [
            {"name": "holder", "present_here": True, "session_room": None}
        ]
        assert placed_there == [
            {"name": "holder", "present_here": False, "session_room": "there"}
        ]
        assert placed_nowhere == [
            {"name": "holder", "present_here": False, "session_room": None}
        ]
