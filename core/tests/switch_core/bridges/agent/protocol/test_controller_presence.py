"""Presence for agents run by an agents controller.

A controller-backed agent holds no connection of its own: it is live while its
controller's stream is attached and beating, and every presence reader asks the
controller rather than the connection registry or the heartbeat rows. Switch
knows only whether it is connected and which rooms it is a member of, never
where its sessions are, so it never promises a session for it.
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
from switch_core.clients.agent_consumer import (
    _STARTING_SESSION_MESSAGE,
    AgentConsumer,
    _GateOutcome,
)
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
from switch_core.transport import InboundMessage, RoomRef

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

    async def live_agent_ids_by_room(
        self, _session: Any, agent_ids: list[str], _room_ids: list[str]
    ) -> dict[str, set[str]]:
        self.asked.append(list(agent_ids))
        return {}


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
            "addressable": AgentStatus.DISCONNECTED,
            "passive": AgentStatus.AWAITING_MANUAL_POLL,
        }
        assert online == {
            "always": AgentStatus.LIVE,
            "auto": AgentStatus.LIVE,
            "addressable": AgentStatus.LIVE,
            "passive": AgentStatus.AWAITING_MANUAL_POLL,
        }
        # Connected is connected: no DORMANT or NO_SESSION for any room.
        assert elsewhere == online
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
        # Switch promises no session for it, wherever it is a member.
        assert not registry.can_spawn_for("agent", ROOM)
        assert not registry.can_spawn_for("agent", ELSEWHERE)
        assert registry.live_in_room("agent", ROOM)
        assert not registry.live_in_room("agent", ELSEWHERE)
        assert registry.live_agent_ids() == {"agent"}
        assert holder in registry.live_connection_ids()
        assert registry.live_connection_count() == 1
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
        )
        new = presence.open(
            controller_id=CONTROLLER,
            tenant_id=TENANT_ZERO_ID,
            resume_cursors={},
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
    async def test_a_connected_agent_is_available_and_no_reply_is_owed(
        self,
    ) -> None:
        registry = AgentConnectionRegistry()
        _bind(registry, "auto")
        conn = _go_live(registry, ("auto", {ROOM}))
        meta = SimpleNamespace(room_id=ROOM, name="Room", bridge_id=None)
        auto = _client(registry, "auto")
        agent = _agent("auto", "auto_session")

        available = await auto._is_available(object(), agent, ROOM)
        reply = await auto._reply_when_unavailable_here(object(), agent, meta, "@u")
        _lapse(conn)
        lapsed = await auto._reply_when_unavailable_here(object(), agent, meta, "@u")

        assert available is True
        assert reply is None
        assert lapsed is not None
        assert lapsed.startswith(
            "My machine, **machine**, is offline or reconnecting to Switch"
        )
        assert "Switch Console" not in lapsed
        assert auto._agent_session_store.asked == []

    async def test_every_session_model_is_available_wherever_it_is_connected(
        self,
    ) -> None:
        registry = AgentConnectionRegistry()
        models = {
            "always": "always_on",
            "auto": "auto_session",
            "addressable": "session_addressable",
        }
        for agent_id in models:
            _bind(registry, agent_id)
        _go_live(registry, *((agent_id, {ROOM}) for agent_id in models))

        for agent_id, model in models.items():
            client = _client(registry, agent_id)
            agent = _agent(agent_id, model)
            assert await client._is_available(object(), agent, ROOM), agent_id
            assert await client._is_available(object(), agent, ELSEWHERE), agent_id

    async def test_a_passive_agent_is_never_promised_a_session(self) -> None:
        registry = AgentConnectionRegistry()
        _bind(registry, "passive")
        _go_live(registry, ("passive", {ROOM}))
        client = _client(registry, "passive")
        agent = _agent("passive", "session_passive")
        meta = SimpleNamespace(room_id=ROOM, name="Room", bridge_id=None)

        assert not await client._is_available(object(), agent, ROOM)
        assert (
            await client._reply_when_unavailable_here(object(), agent, meta, "u")
            is None
        )

    async def test_a_stopped_agent_is_told_as_stopped(self, db: AsyncSession) -> None:
        registry = AgentConnectionRegistry()
        _bind(registry, "auto", running=False)
        _bind(registry, "always", running=False)
        _go_live(registry, ("auto", {ROOM}), ("always", {ROOM}))
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
        assert reply is not None
        assert reply.startswith("@owner — you've stopped me")
        assert "and @u needs me" in reply
        assert statuses == {
            "auto": AgentStatus.DISCONNECTED,
            "always": AgentStatus.DISCONNECTED,
        }
        assert not registry.is_live("auto")
        assert rooms_occupied("auto", registry) == set()
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
        assert await client._is_available(object(), agent, ROOM)
        assert not registry.can_spawn_for("auto", ROOM)
        assert (
            await client._reply_when_unavailable_here(object(), agent, meta, "u")
            is None
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


class _Sent:
    def __init__(self) -> None:
        self.bodies: list[str] = []

    async def __call__(self, _room_id: str, body: str, **_kwargs: object) -> str:
        self.bodies.append(body)
        return "$sent"


def _addressing_client(
    registry: AgentConnectionRegistry, agent_id: str, connection_model: str
) -> tuple[SimpleNamespace, _Sent, list[str]]:
    """An agent client for `on_message`, addressed in ROOM, its availability
    and replies the real ones over `registry`."""
    meta = SimpleNamespace(
        room_id=ROOM, name="Room", bridge_id=None, channel_type="channel_private"
    )
    sent = _Sent()
    enqueued: list[str] = []

    async def _resolve_room_meta(_transport_room_id: str) -> SimpleNamespace:
        return meta

    async def _addressed(*_args: Any) -> bool:
        return True

    async def _fresh_agent(_session: object) -> SimpleNamespace:
        return ns.agent

    async def _gate_addressed(*_args: Any) -> _GateOutcome:
        return _GateOutcome(addressed=True, refusal=None)

    async def _not_hosted(_agent: object, _event: object) -> None:
        return None

    ns = _client(registry, agent_id)
    ns.agent = SimpleNamespace(
        id=agent_id,
        name="reviewer",
        integration_profile={"connection_model": connection_model},
    )
    ns.session_factory = _no_session
    ns._resolve_room_meta = _resolve_room_meta
    ns._addressed_without_lookup = lambda _event, _meta: True
    ns._compute_addressed = _addressed
    ns._fresh_agent = _fresh_agent
    ns._gate_addressed = _gate_addressed
    ns._note_hosted_addressed = _not_hosted
    ns._triggered_by_auto_reply = AgentConsumer._triggered_by_auto_reply
    ns.actor = SimpleNamespace(send_message=sent)
    ns._event_buffer = SimpleNamespace(
        enqueue=lambda _agent_id, _room_id, event: enqueued.append(
            event.payload.message_id
        )
    )
    ns._sender_handle = AgentConsumer._sender_handle.__get__(ns)
    ns._post_auto_reply = AgentConsumer._post_auto_reply.__get__(ns)
    return ns, sent, enqueued


def _addressing(message_id: str) -> InboundMessage:
    return InboundMessage(
        room_id="!room:test",
        event_id=message_id,
        sender="@someone:test",
        timestamp=0,
        content={"sender_name": "someone"},
        body="@reviewer can you look at this",
        sender_name="someone",
        thread_root_id=None,
    )


class TestAddressingAControllerBackedAgent:
    """What the room sees when someone addresses an agent its controller runs."""

    async def test_a_connected_agent_gets_the_message_and_switch_says_nothing(
        self,
    ) -> None:
        for model in ("auto_session", "session_addressable", "always_on"):
            registry = AgentConnectionRegistry()
            _bind(registry, "agent")
            _go_live(registry, ("agent", {ROOM}))
            client, sent, enqueued = _addressing_client(registry, "agent", model)

            await AgentConsumer.on_message(
                client,  # type: ignore[arg-type]
                RoomRef(room_id="!room:test"),
                _addressing("$asked"),
            )

            assert enqueued == ["$asked"], model
            assert sent.bodies == [], model

    async def test_a_disconnected_agent_gets_the_not_connected_reply(self) -> None:
        cases = {
            "offline": "My machine, **machine**, is offline or reconnecting",
            "stopped": "@owner — you've stopped me",
            "removed": "@owner — my machine, **machine**, has been removed",
        }
        for case, expected in cases.items():
            registry = AgentConnectionRegistry()
            _bind(registry, "agent", running=case != "stopped")
            if case == "stopped":
                _go_live(registry, ("agent", {ROOM}))
            if case == "removed":
                registry.controllers.revoke_controller(CONTROLLER)
            client, sent, enqueued = _addressing_client(
                registry, "agent", "auto_session"
            )

            await AgentConsumer.on_message(
                client,  # type: ignore[arg-type]
                RoomRef(room_id="!room:test"),
                _addressing("$asked"),
            )

            assert len(sent.bodies) == 1, case
            assert expected in sent.bodies[0], (case, sent.bodies[0])
            assert _STARTING_SESSION_MESSAGE not in sent.bodies[0]
            assert enqueued == ["$asked"], case


class TestMembership:
    """While connected, a controller-backed agent is in every room it belongs to."""

    def test_present_and_occupied_follow_membership_while_live(self) -> None:
        registry = AgentConnectionRegistry()
        presence = registry.controllers
        _bind(registry, "agent")
        _bind(registry, "other")
        _go_live(registry, ("agent", {ROOM, ELSEWHERE}), ("other", {ROOM}))

        assert agents_present_in(["agent", "other"], ROOM, registry) == {
            "agent",
            "other",
        }
        assert agents_present_in(["agent", "other"], ELSEWHERE, registry) == {"agent"}
        assert rooms_occupied("agent", registry) == {ROOM, ELSEWHERE}
        assert rooms_occupied("other", registry) == {ROOM}

        presence.room_left("agent", ELSEWHERE)
        assert rooms_occupied("agent", registry) == {ROOM}
        presence.room_joined("other", ELSEWHERE)
        assert agents_present_in(["other"], ELSEWHERE, registry) == {"other"}
        presence.unbind("agent", "unassigned")
        assert presence.rooms("agent") == set()
        assert presence.live_rooms("agent") == set()

    def test_lapse_detach_and_revoke_take_it_out_of_every_room(self) -> None:
        registry = AgentConnectionRegistry()
        presence = registry.controllers
        _bind(registry, "agent")
        conn = _go_live(registry, ("agent", {ROOM}))

        _lapse(conn)
        assert rooms_occupied("agent", registry) == set()
        assert agents_present_in(["agent"], ROOM, registry) == set()

        conn = _go_live(registry, ("agent", {ROOM}))
        assert rooms_occupied("agent", registry) == {ROOM}
        presence.detach_stream(conn, conn.stream_token)
        assert rooms_occupied("agent", registry) == set()
        presence.attach_stream(conn)
        assert rooms_occupied("agent", registry) == {ROOM}

        presence.revoke_controller(CONTROLLER)
        assert rooms_occupied("agent", registry) == set()
        # Still a member: membership is not presence.
        assert presence.rooms("agent") == {ROOM}

    async def test_a_role_holder_is_here_only_while_connected_and_a_member(
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
            _go_live(registry, (agent.id, {here.id, there.id}))
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

            member_here = await holders()
            registry.controllers.room_left(agent.id, here.id)
            left_here = await holders()

        assert member_here == [
            {"name": "holder", "present_here": True, "session_room": None}
        ]
        # Not a member here any more, and where else it works is not known.
        assert left_here == [
            {"name": "holder", "present_here": False, "session_room": None}
        ]
