"""How many pool checkouts the hot paths cost.

These are performance assertions, and they are here because the failure they
guard against is not a slow page — it is fleet-wide agent loss. A request that
takes two slots where one would do halves the pool; a request that takes a
second slot *while holding the first* can wait the full pool timeout for it,
and every heartbeat queued behind that misses its TTL and reaps a live
connection. The numbers below are therefore contracts, not observations.
"""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.bridges.agent.protocol.connections import ConnectionRegistry
from switch_core.bridges.agent.protocol.service import ProtocolService
from switch_core.bridges.agent.protocol.types import RoomDescriptor
from switch_core.db.models import Agent, ApiKey, Client, Room, User
from switch_core.db.stores.agent_session_store import AgentSessionStore
from switch_core.db.stores.agent_store import AgentStore
from switch_core.db.stores.room_store import RoomStore


class _CountingSessionFactory:
    """The real factory, counting the sessions opened through it.

    One session is one pool checkout, which is the quantity this whole change
    is about.
    """

    def __init__(self, inner: async_sessionmaker[AsyncSession]) -> None:
        self._inner = inner
        self.opened = 0

    def __call__(self) -> Any:
        self.opened += 1
        return self._inner()


class _NoBridges:
    def get(self, _bridge_id: str) -> None:
        return None


class _OneBridge:
    def __init__(self) -> None:
        self.typing: list[tuple[str, str, bool]] = []

    def get(self, _bridge_id: str) -> Any:
        return SimpleNamespace(handle_outbound_typing=self._record)

    async def _record(self, room_id: str, agent_name: str, is_typing: bool) -> None:
        self.typing.append((room_id, agent_name, is_typing))


def _service(counting: _CountingSessionFactory) -> ProtocolService:
    svc = object.__new__(ProtocolService)
    svc.session_factory = counting  # type: ignore[attr-defined]
    svc.agent_store = AgentStore()  # type: ignore[attr-defined]
    svc.room_store = RoomStore()  # type: ignore[attr-defined]
    svc.collab_lifecycle = _NoBridges()  # type: ignore[attr-defined]
    svc.connections = ConnectionRegistry()
    return svc


async def _seed(
    session_factory: async_sessionmaker[AsyncSession],
    *,
    policy: dict[str, Any] | None = None,
) -> tuple[str, str, str]:
    """One room with one member and one outsider. Returns (room, member, other).

    `policy` is applied to the member, which is the agent the addressing tests
    treat as the target.
    """
    async with session_factory() as session:
        user = User(name="o", email="o@test", role="user", password_hash="x")
        session.add(user)
        await session.flush()
        ids = []
        for name in ("member", "outsider"):
            key = ApiKey(
                user_id=user.id,
                key_hash=f"hash-{name}",
                encrypted_key="enc",
                label=name,
                type="agent",
            )
            client = Client(
                matrix_user_id=f"@{name}:test",
                display_name=name,
                type="agent",
                password="x",
            )
            session.add_all([key, client])
            await session.flush()
            agent = Agent(
                name=name,
                description="d",
                agent_type="session_addressable",
                connector_type="claude_code",
                integration_profile={},
                client_id=client.id,
                api_key_id=key.id,
                owner_id=user.id,
                addressing_policy=policy if name == "member" else None,
            )
            session.add(agent)
            await session.flush()
            ids.append(agent.id)
        room = Room(matrix_room_id="!r:test", name="room", description="d")
        session.add(room)
        await session.flush()
        await RoomStore().add_agents(session, room.id, [ids[0]])
        await session.commit()
        return room.id, ids[0], ids[1]


class TestRequireRoomMember:
    async def test_membership_costs_one_checkout(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        room_id, member_id, _ = await _seed(session_factory)
        counting = _CountingSessionFactory(session_factory)
        svc = _service(counting)

        room = await svc.require_room_member(member_id, room_id)

        assert room.id == room_id
        assert counting.opened == 1, "one question, one slot"

    async def test_a_non_member_is_still_one_checkout(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        room_id, _, outsider_id = await _seed(session_factory)
        counting = _CountingSessionFactory(session_factory)
        svc = _service(counting)

        with pytest.raises(PermissionError):
            await svc.require_room_member(outsider_id, room_id)

        assert counting.opened == 1

    async def test_a_missing_room_still_raises_value_error(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        # "No such room" and "not your room" must stay distinguishable now that
        # the two reads have been folded into one statement.
        _, member_id, _ = await _seed(session_factory)
        svc = _service(_CountingSessionFactory(session_factory))

        with pytest.raises(ValueError, match="Room not found"):
            await svc.require_room_member(member_id, "no-such-room")

    async def test_the_resolved_room_carries_its_bridge(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        room_id, member_id, _ = await _seed(session_factory)
        svc = _service(_CountingSessionFactory(session_factory))

        room = await svc.require_room_member(member_id, room_id)

        assert room.bridge_id is None


class TestCanAddress:
    async def test_a_restricted_target_reads_through_the_callers_session(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        # The nesting this replaces held one slot while blocking on a second,
        # which is how pool pressure turned into a pool timeout.
        _, member_id, outsider_id = await _seed(session_factory)
        async with session_factory() as session:
            await AgentStore().update(
                session,
                member_id,
                addressing_policy={"rules": [{"agents": [outsider_id], "users": []}]},
            )
            await session.commit()

        counting = _CountingSessionFactory(session_factory)
        svc = _service(counting)
        async with session_factory() as session:
            target = await svc.agent_store.get(session, member_id)
            assert target is not None
            counting.opened = 0

            allowed = await svc._can_address(
                session,
                target,
                room_id="room",
                group_id=None,
                sender_agent_id=outsider_id,
            )

        assert allowed is True
        assert counting.opened == 0, "_can_address must not open a session of its own"

    async def test_a_denied_sender_is_also_answered_in_the_callers_session(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        _, member_id, outsider_id = await _seed(session_factory)
        async with session_factory() as session:
            await AgentStore().update(
                session,
                member_id,
                addressing_policy={"rules": [{"agents": ["nobody"], "users": []}]},
            )
            await session.commit()

        counting = _CountingSessionFactory(session_factory)
        svc = _service(counting)
        async with session_factory() as session:
            target = await svc.agent_store.get(session, member_id)
            assert target is not None
            counting.opened = 0

            allowed = await svc._can_address(
                session,
                target,
                room_id="room",
                group_id=None,
                sender_agent_id=outsider_id,
            )

        assert allowed is False
        assert counting.opened == 0

    async def test_an_open_policy_reads_nothing_at_all(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        _, member_id, outsider_id = await _seed(session_factory)
        counting = _CountingSessionFactory(session_factory)
        svc = _service(counting)

        async with session_factory() as session:
            target = await svc.agent_store.get(session, member_id)
            assert target is not None
            counting.opened = 0

            allowed = await svc._can_address(
                session,
                target,
                room_id="room",
                group_id=None,
                sender_agent_id=outsider_id,
            )

        assert allowed is True
        assert counting.opened == 0


class TestTyping:
    async def test_an_internal_room_costs_nothing_beyond_membership(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        # Was three checkouts: membership took two of its own, then a third
        # re-read the agent and the room the caller had already resolved.
        room_id, member_id, _ = await _seed(session_factory)
        counting = _CountingSessionFactory(session_factory)
        svc = _service(counting)

        await svc.set_typing(member_id, room_id, True)

        assert counting.opened == 1

    async def test_a_bridged_room_costs_one_read_for_the_agent_name(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        _, member_id, _ = await _seed(session_factory)
        counting = _CountingSessionFactory(session_factory)
        svc = _service(counting)
        bridge = _OneBridge()
        svc.collab_lifecycle = bridge  # type: ignore[assignment]
        room = RoomDescriptor(
            id="room-1",
            name="room",
            description="d",
            matrix_room_id="!r:test",
            bridge_id="bridge-1",
        )

        await svc._set_typing(member_id, room, True)

        assert bridge.typing == [("room-1", "member", True)]
        assert counting.opened == 1


class TestSendMessage:
    async def test_posting_to_an_internal_room_costs_one_checkout(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        # One to authorize. A bridged room adds exactly one more, to name the
        # agent for the typing indicator — and no more than that, because the
        # room the caller already resolved is passed along instead of re-read.
        room_id, member_id, _ = await _seed(session_factory)
        counting = _CountingSessionFactory(session_factory)
        svc = _service(counting)
        sent: list[tuple[str, str]] = []

        class _Client:
            async def send_message(
                self, matrix_room_id: str, content: str, **_kwargs: Any
            ) -> str:
                sent.append((matrix_room_id, content))
                return "$event"

        svc.client_lifecycle = SimpleNamespace(  # type: ignore[assignment]
            get_by_agent_id=lambda _agent_id: _Client()
        )

        event_id = await svc.send_message(member_id, room_id, "hello")

        assert event_id == "$event"
        assert sent == [("!r:test", "hello")]
        assert counting.opened == 1

    async def test_a_non_member_cannot_post(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        room_id, _, outsider_id = await _seed(session_factory)
        svc = _service(_CountingSessionFactory(session_factory))

        with pytest.raises(PermissionError):
            await svc.send_message(outsider_id, room_id, "hello")


class TestAgentStatuses:
    async def test_a_request_handler_can_reuse_its_own_session(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        # The gateway builds a room's detail inside its request transaction.
        # Resolving statuses used to open a second one from underneath it.
        room_id, member_id, _ = await _seed(session_factory)
        counting = _CountingSessionFactory(session_factory)
        svc = _service(counting)
        svc.agent_session_store = AgentSessionStore()  # type: ignore[attr-defined]

        async with session_factory() as session:
            counting.opened = 0
            statuses = await svc.get_agent_statuses_by_ids_in_session(
                session, room_id, [member_id]
            )

        assert member_id in statuses
        assert counting.opened == 0

    async def test_the_session_less_form_still_takes_exactly_one(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        room_id, member_id, _ = await _seed(session_factory)
        counting = _CountingSessionFactory(session_factory)
        svc = _service(counting)
        svc.agent_session_store = AgentSessionStore()  # type: ignore[attr-defined]

        await svc.get_agent_statuses_by_ids(room_id, [member_id])

        assert counting.opened == 1
